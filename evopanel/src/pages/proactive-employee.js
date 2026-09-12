/**
 * 智能体员工 · 工作日志页 + 事项详情 + 岗位工作项详情
 * 路由：
 *   #/proactive/:code
 *   #/proactive/:code/item/:itemId   （遗留 initiative / 轮次小结）
 *   #/proactive/:code/work/:taskId   （岗位工作项 Task）
 */
import { api, getGatewayBaseUrl } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { showConfirm } from '../components/modal.js'
import { navigate, getCurrentRoute } from '../router.js'
import { renderMarkdown } from '../lib/markdown.js'
import { mountProactiveLiveProcess } from '../components/proactive-live-process.js'
import { mountAgentAvatar } from '../lib/mount-agent-ui.js'
import { showEditRoleModal, loadKnowledgeVaults } from '../lib/proactive-role-edit.js'
import {
  roleScheduleExpr,
  roleScheduleSummary,
  cronToPlainZh,
  formatPreviewRunLabel,
  formatPreviewRelative,
} from '../lib/schedule-panel.js'
import {
  tasksFromListResponse,
  normalizeWorkBoardTasks,
} from '../lib/proactive-role-tasks.js'
import { formatTaskStatusZh, normalizeTaskStatusKey, toTaskStatusGroup } from '../lib/task-status-label.js'
import { formatTaskSourceZh } from '../lib/task-source.js'
import { formatRaisedByLabel } from '../lib/task-raised-by.js'
import {
  taskSummaryText,
  parseTaskResultSections,
  resolveTaskOutputItems,
  taskInputRefsOf,
  renderTaskOutputCardsHtml,
  renderTaskInputRefsCardsHtml,
} from '../lib/task-summary.js'
import {
  taskHandlersOf,
  renderHandlersEditorHtml,
  renderHandlersReadonlyHtml,
  collectHandlersFromEditor,
  bindHandlersEditor,
} from '../lib/task-handlers.js'
import { bindTaskOutputCardActions } from '../lib/task-output-preview.js'
import {
  feishuBindingOf,
  startFeishuEmployeeScan,
  unbindFeishuEmployee,
} from '../lib/feishu-employee-bind.js'
import { diagnoseRole, renderRoleDiagnosisHtml } from '../lib/proactive-role-diagnosis.js'

/** Map board Task status → work-log card status. */
function taskStatusToWorklog(status) {
  const s = normalizeTaskStatusKey(status)
  // reviewed = legacy 交工态，按已完成展示
  if (s === 'reviewed') return 'completed'
  if (s === 'completed' || s === 'done' || s === 'success') return 'completed'
  if (s === 'failed' || s === 'error' || s === 'timed_out') return 'failed'
  if (s === 'cancelled' || s === 'canceled') return 'cancelled'
  if (s === 'rejected') return 'rejected'
  if (s === 'executing' || s === 'in_progress' || s === 'running' || s === 'active') return 'executing'
  if (s === 'paused') return 'paused'
  if (s === 'req_confirm' || s === 'waiting_user') return 'pending_approval'
  return 'proposed'
}

/** Strip task ids (legacy Task_… or short YYMMDDHHMM_xxxx) for human-readable diary lines. */
function stripTaskIds(text) {
  return String(text || '')
    .replace(/Task_[A-Za-z0-9_]+/gi, '')
    .replace(/\b\d{10}_[0-9a-f]{4}\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[（(]\s*[）)]/g, '')
    .replace(/^\s*[、，,;；|]+\s*/g, '')
    .replace(/\s*[、，,;；|]+\s*$/g, '')
    .trim()
}

/**
 * Diary title: no raw Task id, no「任务:」前缀, no「请重试 reviewed」包装腔。
 */
function humanizeWorkTitle(name, description = '') {
  let t = String(name || '').trim()
  t = t.replace(/^任务\s*[:：]\s*/u, '')
  const raw = t
  const isWrapper =
    /请处理以下任务|均为\s*reviewed|请重试执行|执行超时|递归超限/i.test(t) ||
    /^Task_/i.test(t) ||
    /^\d{10}_[0-9a-f]{4}$/i.test(t)
  if (isWrapper) {
    const fromDesc = stripTaskIds(description || '')
      .replace(/^任务\s*[:：]\s*/u, '')
      .replace(/^请处理以下任务\s*[:：]?\s*/u, '')
      .replace(/\d+\s*[)）．.]\s*/g, '')
      .replace(/均为\s*reviewed[^。；;]*/gi, '')
      .replace(/请重试执行[^。；;]*/gi, '')
      .replace(/为\s*pending[^。；;]*/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
    if (fromDesc.length >= 4) t = fromDesc
  }
  t = stripTaskIds(t)
  t = t
    .replace(/\d+\s*[)）．.]\s*/g, '')
    .replace(/\s*和\s*和\s*/g, '、')
    .replace(/^[、，,\s]+|[、，,\s]+$/g, '')
    .trim()
  if (!t || t.length < 2) {
    t = stripTaskIds(description || raw).replace(/^任务\s*[:：]\s*/u, '').trim()
  }
  if (!t) t = '岗位工作'
  return previewLine(t, 64)
}

/** What they actually did / need — prefer outcome, never dump Task ids. */
function humanizeWorkDesc(init) {
  const outcome = cleanWorkText(init?.outcome || init?.execution_result || '')
  if (
    outcome &&
    outcome.length > 6 &&
    !/等待超时|Execution timed out|执行失败：等待/i.test(outcome) &&
    !/^系统清理/.test(outcome)
  ) {
    return previewLine(stripTaskIds(outcome), 110)
  }
  let d = stripTaskIds(String(init?.description || '').trim())
  d = d.replace(/^任务\s*[:：]\s*/u, '')
  const title = String(init?._display_title || init?.title || '').trim()
  if (title && textLooksSimilar(d, title)) return ''
  if (/请处理以下任务|均为\s*reviewed|请重试/i.test(d)) {
    d = d
      .replace(/^请处理以下任务\s*[:：]?\s*/u, '')
      .replace(/\d+\s*[)）．.]\s*/g, '')
      .replace(/均为\s*reviewed[^。；;]*/gi, '')
      .replace(/请重试执行[^。；;]*/gi, '')
      .trim()
  }
  return d ? previewLine(d, 110) : ''
}

/**
 * 「工作记录」SSOT = 本岗 Task。按 round_id / source_ref / 更新日期分组。
 * 不再把 initiative journals 并进列表。
 * 已关闭（cancelled）默认不进日记，避免清理脏单刷屏。
 */
function tasksAsWorklogItems(tasks) {
  const out = []
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!t || typeof t !== 'object') continue
    if (t.is_subtask || t.subtask_id) continue
    const tid = String(t.task_id || t.id || '').trim()
    if (!tid) continue
    const status = taskStatusToWorklog(t.status)
    if (status === 'cancelled') continue
    const roundId =
      String(t.round_id || '').trim() || String(t.source_ref || '').trim() || null
    const created = String(t.created_at || t.updated_at || '').trim()
    const updated = String(t.updated_at || created).trim()
    let result = null
    if (status === 'completed') result = 'success'
    else if (status === 'failed') result = 'failure'
    // reviewed：已交工、尚未上级确认 — 不算成功/失败
    const rawName = String(t.name || t.title || tid).trim() || tid
    const rawDesc = String(t.description || '').trim()
    const displayTitle = humanizeWorkTitle(rawName, rawDesc)
    out.push({
      id: tid,
      title: displayTitle,
      _raw_title: rawName,
      _display_title: displayTitle,
      description: rawDesc,
      rationale: String(t.rationale || '').trim(),
      action_type: String(t.action_type || 'analysis').trim() || 'analysis',
      risk_level: String(t.risk_level || 'low').trim() || 'low',
      source: String(t.source || '').trim(),
      action_plan: { kind: 'task_board' },
      status,
      result,
      round_id: roundId,
      goal: String(t.goal || '').trim(),
      outcome: String(t.summary || t.result || t.outcome || '').trim(),
      execution_result: String(t.summary || t.result || '').trim(),
      created_at: created,
      updated_at: updated,
      progress: Number(t.progress) || 0,
      _is_task: true,
    })
  }
  return out
}

function esc(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fmtClock(d) {
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Modal title — per-message clocks live on the left of each turn. */
function trailTitle(_at, { busy = false } = {}) {
  return busy ? '工作过程 · 工作中' : '工作过程'
}

function latestRoundFromInitiatives(initiatives) {
  const rounds = groupByRound(Array.isArray(initiatives) ? initiatives : [])
  return rounds[0] || null
}

/** Upcoming duty times via shared automation schedule preview API. */
async function loadRoleSchedulePreview(role, count = 3) {
  const schedule = roleScheduleExpr(role)
  if (!schedule) return { schedule: '', summary: '', next_runs: [] }
  try {
    const res = await api.automationSchedulePreview({ schedule, count })
    if (res?.ok) {
      return {
        schedule: String(res.cron || res.schedule || schedule),
        summary: String(res.summary || '').trim(),
        next_runs: Array.isArray(res.next_runs) ? res.next_runs.filter(Boolean) : [],
      }
    }
  } catch {
    /* ignore — panel still shows last/next from role */
  }
  return { schedule, summary: '', next_runs: [] }
}

function renderScheduleNextRunsTable(preview, { title = '即将自动上班', hideSummary = false } = {}) {
  const runs = Array.isArray(preview?.next_runs) ? preview.next_runs.filter(Boolean) : []
  const summaryRaw = String(preview?.summary || '').trim()
  const summary = !hideSummary && summaryRaw ? cronToPlainZh(summaryRaw) : ''
  if (!runs.length) {
    // 频率已在上方展示时，空预览不再重复文案，避免「暂无预览」误导
    if (hideSummary) return ''
    return `<div class="pro-sched-preview">
      <div class="pro-sched-preview-head">
        <span class="pro-sched-preview-title">${esc(title)}</span>
        ${summary ? `<span class="pro-sched-preview-sum">${esc(summary)}</span>` : ''}
      </div>
      <p class="pro-item-muted">暂无即将执行的时间点</p>
    </div>`
  }
  const now = new Date()
  const rows = runs
    .map((iso, i) => {
      const abs = formatPreviewRunLabel(iso)
      const rel = formatPreviewRelative(iso, now)
      return `<tr>
        <td class="pro-sched-preview-idx">${i + 1}</td>
        <td class="pro-sched-preview-time">${esc(abs)}</td>
        <td class="pro-sched-preview-rel">${esc(rel)}</td>
      </tr>`
    })
    .join('')
  return `<div class="pro-sched-preview">
    <div class="pro-sched-preview-head">
      <span class="pro-sched-preview-title">${esc(title)}</span>
      ${summary ? `<span class="pro-sched-preview-sum">${esc(summary)}</span>` : ''}
    </div>
    <table class="pro-sched-preview-table">
      <thead>
        <tr><th>#</th><th>时间</th><th>相对</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`
}

/** Relative label for past or future ISO times (下次自动上班 is future). */
function fmtTime(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return String(iso)
    const now = new Date()
    const diffSec = Math.round((d.getTime() - now.getTime()) / 1000)
    if (diffSec > 45) {
      if (diffSec < 3600) return Math.max(1, Math.floor(diffSec / 60)) + ' 分钟后'
      if (diffSec < 86400) return Math.floor(diffSec / 3600) + ' 小时后'
      if (diffSec < 86400 * 7) return Math.floor(diffSec / 86400) + ' 天后'
      return fmtClock(d)
    }
    const ago = -diffSec
    if (ago < 60) return '刚刚'
    if (ago < 3600) return Math.floor(ago / 60) + ' 分钟前'
    if (ago < 86400) return Math.floor(ago / 3600) + ' 小时前'
    return fmtClock(d)
  } catch {
    return String(iso)
  }
}

const STATUS_BADGE = {
  proposed: { label: '待处理', cls: 'pro-badge--info' },
  pending_approval: { label: '待审批', cls: 'pro-badge--warn' },
  approved: { label: '已批准', cls: 'pro-badge--ok' },
  rejected: { label: '已拒绝', cls: 'pro-badge--err' },
  cancelled: { label: '已关闭', cls: 'pro-badge--muted' },
  executing: { label: '执行中', cls: 'pro-badge--run' },
  paused: { label: '已暂停', cls: 'pro-badge--muted' },
  // legacy reviewed → 已完成
  reviewed: { label: '已完成', cls: 'pro-badge--ok' },
  completed: { label: '已完成', cls: 'pro-badge--ok' },
  failed: { label: '失败', cls: 'pro-badge--err' },
  timeout_rejected: { label: '审批超时', cls: 'pro-badge--err' },
  skipped: { label: '已跳过', cls: 'pro-badge--muted' },
}

/** Journal-specific labels — avoid calling empty/incomplete wrap 「成功」. */
function journalStatusBadge(init) {
  const phase = journalPhase(init)
  if (isIncompleteJournal(init)) return { label: '未完成', cls: 'pro-badge--warn' }
  if (phase === 'check_in' && init.status === 'executing') {
    return { label: '进行中', cls: 'pro-badge--run' }
  }
  if (init.status === 'completed') return { label: '已记录', cls: 'pro-badge--ok' }
  if (init.status === 'failed') return { label: '失败', cls: 'pro-badge--err' }
  return STATUS_BADGE[init.status] || { label: init.status || '—', cls: 'pro-badge--muted' }
}

function isIncompleteJournal(init) {
  if (!isRoundLog(init)) return false
  const plan = init?.action_plan
  if (plan && typeof plan === 'object' && plan.incomplete === true) return true
  const desc = String(init?.description || '')
  if (desc.includes('【交班汇报·未完成】') || desc.includes('【工作汇报·未完成】')) return true
  const goal = String(init?.goal || init?.title || '')
  if (/自动交班·未完成|本轮汇报未写完|中断·未完成/.test(goal)) return true
  return init?.status === 'failed' && journalPhase(init) === 'wrap_up'
}

function journalReflection(init) {
  if (!isRoundLog(init)) return ''
  const plan = init?.action_plan
  if (plan && typeof plan === 'object') {
    const r = String(plan.reflection || '').trim()
    if (r) return r
  }
  return ''
}

const RESULT_BADGE = {
  success: { label: '执行成功', cls: 'pro-badge--ok' },
  failure: { label: '执行失败', cls: 'pro-badge--err' },
}

const RISK_BADGE = {
  low: { label: '低风险', cls: 'pro-risk--low' },
  medium: { label: '中风险', cls: 'pro-risk--med' },
  high: { label: '高风险', cls: 'pro-risk--high' },
  critical: { label: '极高', cls: 'pro-risk--crit' },
}

const ACTION_TYPE_LABEL = {
  code_change: '代码变更',
  analysis: '分析',
  report: '报告',
  task_delegation: '任务委派',
  alert: '告警',
  optimization: '优化',
}

const AUTONOMY_LABEL = {
  full_auto: '全自动',
  approval_for_risky: '平衡型',
  approval_for_all: '谨慎型',
}

const AUTONOMY_HINT = {
  full_auto:
    '本岗结案并指定下游后：仅「极高风险」须你审核才派发；低/中/高风险自动派下游。是否挂审由你在此配置，不由员工自行决定。',
  approval_for_risky:
    '本岗结案并指定下游后：中风险及以上须你审核才派发；低风险自动派下游。是否挂审由你在此配置，不由员工自行决定。',
  approval_for_all:
    '本岗结案并指定下游后：一律须你审核才派发。是否挂审由你在此配置，不由员工自行决定。',
}

const ROLE_STATUS_LABEL = {
  active: '在岗',
  paused: '已停',
  archived: '已停',
  draft: '已停',
}

const _PLAN_META_KEYS = new Set(['source', 'kind', 'backfill'])
const _NOISE_RATIONALE_RE = /^(backfill|proactive_submit_work|系统补录|round_log)/i
const _DISPATCH_RATIONALE_ZH = {
  employee_page: '用户从员工页派发',
  chat_mention: '用户在主聊天 @ 派发',
  manual: '手动派发',
  role: '同事跨岗派发',
  xiaomi: '小V催办派发',
  event: '事件触发派发',
}

/** Rewrite legacy second-person dispatch copy still stored on older tasks. */
const _LEGACY_DISPATCH_RATIONALE = {
  '你从员工页派发': '用户从员工页派发',
  '你在主聊天 @ 派发': '用户在主聊天 @ 派发',
}

const JOURNAL_PHASE_LABEL = {
  check_in: '开工记录',
  progress: '中途记录',
  wrap_up: '本轮工作汇报',
}

function journalPhase(init) {
  const plan = init?.action_plan
  if (!plan || typeof plan !== 'object') return ''
  if (String(plan.kind || '') !== 'round_log') return ''
  const p = String(plan.phase || '').trim().toLowerCase()
  if (p === 'check_in' || p === 'checkin') return 'check_in'
  if (p === 'progress') return 'progress'
  if (p === 'wrap_up' || p === 'wrapup') return 'wrap_up'
  // Infer from status/content if phase missing
  if (init?.status === 'executing') return 'check_in'
  if (String(init?.description || '').includes('【开工汇报】') && init?.status !== 'completed') return 'check_in'
  if (String(init?.description || '').includes('【中途汇报】')) return 'progress'
  return 'wrap_up'
}

function isRoundLog(init) {
  const plan = init?.action_plan
  if (plan && typeof plan === 'object' && String(plan.kind || '') === 'round_log') return true
  // Completed report with no actionable steps → treat as work journal entry
  if (init?.action_type === 'report' && init?.status === 'completed') {
    const steps = plan?.steps
    return !Array.isArray(steps) || steps.length === 0
  }
  return false
}

function parseProgressTrail(raw) {
  const s = cleanWorkText(raw)
  if (!s) return []
  // Split appended stamps: [iso] 进度：...
  const parts = s.split(/\n(?=\[)/).map((p) => p.trim()).filter(Boolean)
  const entries = []
  for (const p of parts) {
    const m = p.match(/^\[([^\]]+)\]\s*(?:进度：)?([\s\S]*)$/)
    if (!m) {
      if (parts.length === 1) return []
      continue
    }
    entries.push({ at: m[1], note: m[2].replace(/^结果：/gm, '').trim() })
  }
  return entries
}

function formatProgressTrail(raw) {
  const s = humanizeExecutionFailure(raw)
  if (!s) return ''
  const entries = parseProgressTrail(raw)
  if (!entries.length) return `<pre class="pro-detail-code">${esc(s)}</pre>`
  return (
    `<ul class="pro-progress-trail">` +
    entries
      .map(
        (e) =>
          `<li><span class="pro-progress-time">${esc(fmtTime(e.at))}</span><div class="pro-progress-note">${esc(humanizeExecutionFailure(e.note) || e.note)}</div></li>`,
      )
      .join('') +
    `</ul>`
  )
}

/** Turn opaque LangGraph / bridge strings into something a human can act on. */
function humanizeExecutionFailure(raw) {
  const s = cleanWorkText(raw)
  if (!s) return ''
  const low = s.toLowerCase()
  if (low.includes('recursion limit') || low.includes('graphrecursionerror') || low.includes('步数用尽')) {
    if (s.includes('执行失败')) return s
    return (
      '执行失败：本轮工具步数用尽，任务中断。请打开「工作过程」看停在哪一步；可缩小范围后重试。\n' +
      `技术细节：${s}`
    )
  }
  if (
    /langgraph run error:\s*$/i.test(s) ||
    /^execution failed:\s*langgraph run error:\s*$/i.test(s)
  ) {
    return '执行失败：引擎中断，但未返回具体原因。常见于步数用尽；请打开「工作过程」查看最后几步，或稍后重试。'
  }
  if (/^execution failed:\s*/i.test(s)) {
    const rest = s.replace(/^execution failed:\s*/i, '').trim()
    return rest ? `执行失败：${rest}` : '执行失败：原因未知。请打开「工作过程」查看。'
  }
  if (/^execution error:\s*/i.test(s)) {
    return `执行失败：${s.replace(/^execution error:\s*/i, '').trim()}`
  }
  if (/^execution timed out/i.test(s)) {
    return '执行失败：等待超时。请打开「工作过程」或稍后重试。'
  }
  return s
}

function latestProgressPreview(raw) {
  const entries = parseProgressTrail(raw)
  if (!entries.length) return ''
  const last = entries[entries.length - 1]
  const note = String(last.note || '').replace(/\s+/g, ' ').trim()
  if (!note) return ''
  return note.length > 96 ? note.slice(0, 96) + '…' : note
}

function cleanWorkText(raw) {
  let s = String(raw || '').trim()
  if (!s) return ''
  s = s.replace(/\n*\s*（系统补录：[^）]*）\s*$/u, '').trim()
  s = s.replace(/\n*\s*\(系统补录：[^)]*\)\s*$/u, '').trim()
  return s
}

function textLooksSimilar(a, b) {
  const x = cleanWorkText(a).replace(/\s+/g, '').slice(0, 240)
  const y = cleanWorkText(b).replace(/\s+/g, '').slice(0, 240)
  if (!x || !y) return false
  return x === y || x.includes(y) || y.includes(x)
}

function actionablePlan(plan) {
  if (!plan || typeof plan !== 'object') return null
  const steps = Array.isArray(plan.steps) ? plan.steps.map((s) => String(s || '').trim()).filter(Boolean) : []
  const files = Array.isArray(plan.target_files)
    ? plan.target_files.map((s) => String(s || '').trim()).filter(Boolean)
    : []
  const commands = Array.isArray(plan.commands)
    ? plan.commands.map((s) => String(s || '').trim()).filter(Boolean)
    : []
  const extras = Object.entries(plan).filter(([k, v]) => {
    if (_PLAN_META_KEYS.has(k) || k === 'steps' || k === 'target_files' || k === 'commands') return false
    if (v == null || v === '') return false
    if (typeof v === 'object') return Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0
    return true
  })
  if (!steps.length && !files.length && !commands.length && !extras.length) return null
  return { steps, files, commands, extras }
}

function looksLikeInternalDispatchNote(raw) {
  const t = String(raw || '').trim()
  if (!t) return true
  const low = t.toLowerCase()
  if (low.startsWith('organic handoff')) return true
  if (low.startsWith('dispatch:')) return true
  if (low.includes('woken_by=') || low.includes('task_id=')) return true
  // ASCII-only short tags from scripts / wake plumbing
  if (!/[\u4e00-\u9fff]/.test(t) && t.length < 220 && /^[a-z0-9 _.:;|\-/(),[\]@#]+$/i.test(t)) {
    return true
  }
  return false
}

function humanRationale(raw, roster = []) {
  const s = String(raw || '').trim()
  if (!s || _NOISE_RATIONALE_RE.test(s)) return ''
  if (_LEGACY_DISPATCH_RATIONALE[s]) return _LEGACY_DISPATCH_RATIONALE[s]
  if (s === '同事跨岗叫醒') return '同事跨岗派发'
  if (s === '小V催办叫醒') return '小V催办派发'
  // Legacy stored line: 同事跨岗叫醒 · 由「product-manager」叫醒
  const wake = /^(同事跨岗叫醒|小V催办叫醒|同事跨岗派发|小V催办派发)\s*[·•]\s*由[「"']([^」"']+)[」"']叫醒$/u.exec(
    s,
  )
  if (wake) {
    const base = wake[1].includes('小V') ? '小V催办派发' : '同事跨岗派发'
    const who = formatRaisedByLabel(wake[2], roster) || wake[2]
    if (!who || who === '用户') return base
    return `${base} · ${who}`
  }
  const m = /^dispatch:([a-z0-9_:-]+)$/i.exec(s)
  if (m) {
    const key = m[1].toLowerCase()
    if (_DISPATCH_RATIONALE_ZH[key]) return _DISPATCH_RATIONALE_ZH[key]
    if (key.startsWith('event')) return _DISPATCH_RATIONALE_ZH.event
    return '用户派发'
  }
  return s
}

function previewLine(raw, max = 120) {
  const s = cleanWorkText(raw)
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\n+/g, ' ')
    .trim()
  if (!s) return ''
  return s.length > max ? s.slice(0, max) + '…' : s
}

function mdBlock(text) {
  const body = cleanWorkText(text)
  if (!body) return '<p class="pro-item-empty">无</p>'
  try {
    return `<div class="pro-item-md markdown-body">${renderMarkdown(body)}</div>`
  } catch {
    return `<p>${esc(body)}</p>`
  }
}

function parseRoute() {
  const raw = String(getCurrentRoute() || '')
  const [pathPart, queryPart = ''] = raw.split('?')
  const path = pathPart.replace(/\/+$/, '')
  const params = new URLSearchParams(queryPart)
  const work = path.match(/^\/proactive\/([^/]+)\/work\/([^/]+)$/)
  if (work) {
    return {
      kind: 'work',
      code: decodeURIComponent(work[1]),
      taskId: decodeURIComponent(work[2]),
      from: String(params.get('from') || '').trim(),
      autoPatrol: false,
      autoLive: false,
      dispatchGoal: '',
    }
  }
  const item = path.match(/^\/proactive\/([^/]+)\/item\/([^/]+)$/)
  if (item) {
    return {
      kind: 'item',
      code: decodeURIComponent(item[1]),
      itemId: decodeURIComponent(item[2]),
      autoPatrol: false,
      autoLive: false,
      dispatchGoal: '',
    }
  }
  const emp = path.match(/^\/proactive\/([^/]+)$/)
  if (emp && emp[1] !== 'approvals' && emp[1] !== 'board') {
    return {
      kind: 'employee',
      code: decodeURIComponent(emp[1]),
      autoPatrol: params.get('patrol') === '1',
      autoLive: params.get('live') === '1',
      dispatchGoal: String(params.get('goal') || '').trim(),
    }
  }
  return { kind: 'unknown', autoPatrol: false, autoLive: false, dispatchGoal: '' }
}

function clearEmployeeQueryKeys(...keys) {
  const raw = String(getCurrentRoute() || '')
  if (!raw.includes('?')) return
  const [pathPart, queryPart = ''] = raw.split('?')
  const params = new URLSearchParams(queryPart)
  let changed = false
  for (const k of keys) {
    if (params.has(k)) {
      params.delete(k)
      changed = true
    }
  }
  if (!changed) return
  const next = params.toString() ? `${pathPart}?${params}` : pathPart
  const hash = next.startsWith('/') ? `#${next}` : `#/${next}`
  history.replaceState(null, '', hash)
}

function clearAutoPatrolQuery() {
  clearEmployeeQueryKeys('patrol')
}

function clearAutoLiveQuery() {
  clearEmployeeQueryKeys('live', 'goal')
}

function pathBasename(p) {
  const s = String(p || '').replace(/\\/g, '/').trim()
  if (!s) return ''
  const parts = s.split('/').filter(Boolean)
  return parts[parts.length - 1] || s
}

const PATROL_STEPS = [
  '核对岗位职责与管辖范围…',
  '翻看近期工作日志与关注点…',
  '在工作区巡查变更与风险…',
  '整理发现并写回看板进度…',
]

function workspaceOf(role) {
  return String(role?.config?.workspace_path || role?.workspace_path || '').trim()
}

function renderPatrolRunning(role) {
  const ws = workspaceOf(role)
  const mode = String(role?.config?.think_mode || 'agent_loop')
  const modeLabel = mode === 'prompt_only' ? '轻量工作' : '深度工作'
  return `
    <section class="pro-patrol-panel pro-patrol-panel--running" aria-live="polite">
      <div class="pro-patrol-pulse" aria-hidden="true"></div>
      <div class="pro-patrol-copy">
        <p class="pro-patrol-kicker">正在上班</p>
        <h2 class="pro-patrol-title">${esc(role.role_name || role.agent_code)}</h2>
        <p class="pro-patrol-meta">
          <span>${esc(modeLabel)}</span>
          ${ws ? `<span title="${esc(ws)}">${esc(pathBasename(ws))}</span>` : '<span>默认工作空间</span>'}
        </p>
        <p class="pro-patrol-step" data-patrol-step>${esc(PATROL_STEPS[0])}</p>
      </div>
      <div class="pro-patrol-watch-actions">
        <button type="button" class="btn btn-sm btn-outline" data-act="open-live">工作过程</button>
      </div>
    </section>`
}

function renderDispatchWatching(role, { goal = '', conflict = false } = {}) {
  const ws = workspaceOf(role)
  return `
    <section class="pro-patrol-panel ${conflict ? 'pro-patrol-panel--warn' : 'pro-patrol-panel--running'}" aria-live="polite">
      <div class="pro-patrol-pulse" aria-hidden="true"></div>
      <div class="pro-patrol-copy">
        <p class="pro-patrol-kicker">${conflict ? '当前有任务在执行' : '派发任务进行中'}</p>
        <h2 class="pro-patrol-title">${esc(role.role_name || role.agent_code)}</h2>
        ${goal ? `<p class="pro-patrol-summary"><em>目标</em> ${esc(previewLine(goal, 180))}</p>` : ''}
        <p class="pro-patrol-meta">
          <span>${conflict ? '请等待本轮结束后再派发' : '已打开工作过程，可实时查看进度'}</span>
          ${ws ? `<span title="${esc(ws)}">${esc(pathBasename(ws))}</span>` : ''}
        </p>
        <p class="pro-patrol-step" data-patrol-step>${conflict ? '正在同步当前执行状态…' : '员工已接单，正在处理…'}</p>
      </div>
      <div class="pro-patrol-watch-actions">
        <button type="button" class="btn btn-sm btn-outline" data-act="open-live">工作过程</button>
      </div>
    </section>`
}

/** @param {HTMLElement} page */
function destroyEmployeeLiveMount(page) {
  if (page._busyWatchTimer) {
    window.clearInterval(page._busyWatchTimer)
    page._busyWatchTimer = null
  }
  if (page._dispatchWatchTimer) {
    window.clearInterval(page._dispatchWatchTimer)
    page._dispatchWatchTimer = null
  }
  if (page._liveProcess) {
    try {
      page._liveProcess.close()
    } catch {
      /* ignore */
    }
  }
}

/**
 * Open the shared SubtaskExecutionDrawer-style center transcript modal.
 * @param {HTMLElement} page
 * @param {object} role
 * @param {{ busy?: boolean, title?: string, roundId?: string, at?: string }} [opts]
 */
function ensureEmployeeLiveProcess(page, role, opts = {}) {
  if (!page._liveProcess) {
    page._liveProcess = mountProactiveLiveProcess(page)
  }
  const busy = opts.busy === true
  const roundId = String(opts.roundId || '').trim()
  const title =
    opts.title ||
    trailTitle(opts.at || roundId, { busy })
  page._liveTrailDismissed = false
  page._liveProcess.open({
    agentCode: role.agent_code,
    roleName: role.role_name || role.agent_code,
    busy,
    title,
    roundId: roundId || undefined,
    onClosed: () => {
      page._liveTrailDismissed = true
      if (page._busyWatchTimer) {
        window.clearInterval(page._busyWatchTimer)
        page._busyWatchTimer = null
      }
    },
  })
  if (page._busyWatchTimer) {
    window.clearInterval(page._busyWatchTimer)
    page._busyWatchTimer = null
  }
  page._busyWatchTimer = window.setInterval(async () => {
    if (!page._liveProcess?.isOpen?.()) {
      window.clearInterval(page._busyWatchTimer)
      page._busyWatchTimer = null
      return
    }
    try {
      const st = await api.proactiveRoleBusy(role.agent_code)
      const busyNow = !!st?.busy
      const liveRid = String(st?.current_round_id || '').trim()
      const openRid = String(page._liveProcess?.currentRoundId?.() || '').trim()
      // While working, follow the live duty round — Task/work-log round_id can lag.
      if (busyNow && liveRid && liveRid !== openRid && page._liveProcess?.update) {
        page._liveProcess.update({
          busy: true,
          roundId: liveRid,
          title: trailTitle(st?.started_at || liveRid, { busy: true }),
        })
      } else {
        page._liveProcess?.setBusy(busyNow)
      }
    } catch {
      /* ignore */
    }
  }, 3000)
  return page._liveProcess
}

/** Rotate tip text while the drawer polls the session itself. */
function startPatrolStepTips(slot) {
  const stepEl = slot?.querySelector('[data-patrol-step]')
  if (!stepEl) return () => {}
  let stepIdx = 0
  const tipTimer = window.setInterval(() => {
    if (!stepEl.isConnected) return
    stepIdx = (stepIdx + 1) % PATROL_STEPS.length
    stepEl.textContent = PATROL_STEPS[stepIdx]
  }, 3200)
  return () => window.clearInterval(tipTimer)
}

function patrolHeadline(report) {
  const sc = report?.scorecard || enrichScorecardFromReport(report)
  if (sc.verdict === 'incomplete') {
    return sc.actionable
      ? `本轮未完整收尾（系统已补记），另有 ${sc.actionable} 个工作项`
      : '本轮未完整收尾（系统已补记）'
  }
  if (sc.verdict === 'empty') return '本轮未写回记录'
  if (sc.verdict === 'in_progress') return '本轮仍在进行中'
  const pending = Number(sc.pending_approval || 0)
  const failed = Number(sc.failed || 0)
  const actionable = Number(sc.actionable || 0)
  if (pending) return `本轮结束：${actionable} 个工作项，其中 ${pending} 个待你审批`
  if (failed) return `本轮结束：${actionable} 个工作项，其中 ${failed} 个执行失败`
  if (actionable === 0) return '本轮结束，看板暂无新待办'
  return `本轮结束，共 ${actionable} 个工作项（见工作项看板）`
}

function enrichScorecardFromReport(report) {
  if (report?.scorecard && report.scorecard.verdict) return report.scorecard
  const c = report?.counts || {}
  const items = Array.isArray(report?.items) ? report.items : []
  const journals = items.filter((i) => i.is_journal)
  const wrap = journals.find((j) => String(j.action_plan?.phase || '') === 'wrap_up') || journals[0]
  const incomplete =
    Boolean(wrap?.action_plan?.incomplete) ||
    (wrap && wrap.status === 'failed' && String(wrap.action_plan?.phase || '') === 'wrap_up') ||
    /未完成/.test(String(wrap?.title || wrap?.goal || ''))
  const actionable = Math.max(0, Number(c.total || items.length) - Number(c.journal || journals.length))
  let verdict = 'partial'
  let verdict_label = '有记录'
  if (incomplete) {
    verdict = 'incomplete'
    verdict_label = '未完整收尾'
  } else if (wrap && wrap.status === 'completed') {
    verdict = 'completed'
    verdict_label = '已结束'
  } else if (wrap && wrap.status === 'executing') {
    verdict = 'in_progress'
    verdict_label = '进行中'
  } else if (!items.length) {
    verdict = 'empty'
    verdict_label = '无记录'
  }
  return {
    verdict,
    verdict_label,
    incomplete: Boolean(incomplete),
    goal: report?.goal || wrap?.goal || '',
    outcome: report?.outcome || wrap?.outcome || '',
    reflection: report?.reflection || wrap?.action_plan?.reflection || '',
    actionable,
    pending_approval: Number(c.pending_approval || 0),
    failed: Number(c.failed || 0),
    completed: Number(c.completed || 0),
  }
}

function renderPatrolDone(report) {
  const sc = enrichScorecardFromReport(report)
  const c = report?.counts || {}
  const ws = String(report?.workspace_path || '').trim()
  const items = Array.isArray(report?.items) ? report.items : []
  const actionable = items.filter((i) => !i.is_journal)
  const list =
    actionable.length > 0
      ? `<ul class="pro-patrol-items">${actionable
          .slice(0, 6)
          .map((i) => {
            const badge = STATUS_BADGE[i.status] || { label: i.status || '', cls: 'pro-badge--muted' }
            return `<li>
            <button type="button" class="pro-patrol-item-link" data-open-item="${esc(i.id)}" data-code="${esc(report.agent_code)}">
              <span class="pro-patrol-item-title">${esc(i.title || '未命名')}</span>
              <span class="pro-badge ${badge.cls}">${esc(badge.label)}</span>
            </button>
          </li>`
          })
          .join('')}${
          actionable.length > 6
            ? `<li class="pro-patrol-more">还有 ${actionable.length - 6} 项，见下方上班记录</li>`
            : ''
        }</ul>`
      : `<p class="pro-patrol-empty-hint">${
          sc.incomplete
            ? '本轮未完整收尾；待办请看「工作项看板」，细节见「工作过程」。'
            : '待办请看「工作项看板」；过程细节见「工作过程」。'
        }</p>`

  const panelCls =
    sc.verdict === 'incomplete' || sc.verdict === 'empty'
      ? 'pro-patrol-panel--warn'
      : 'pro-patrol-panel--done'
  const kicker =
    sc.verdict === 'incomplete' || sc.verdict === 'empty' ? '未完整收尾' : '本轮结束'

  return `
    <section class="pro-patrol-panel ${panelCls}" aria-live="polite">
      <div class="pro-patrol-copy">
        <p class="pro-patrol-kicker">${esc(kicker)}</p>
        <h2 class="pro-patrol-title">${esc(patrolHeadline(report))}</h2>
        ${renderRoundSummaryLine(sc)}
        <p class="pro-patrol-meta">
          <span>上次上班 ${esc(fmtTime(report?.last_heartbeat_at))}</span>
          <span>下次自动上班 ${esc(fmtTime(report?.next_heartbeat_at))}</span>
          ${ws ? `<span title="${esc(ws)}">${esc(pathBasename(ws))}</span>` : ''}
          ${c.pending_approval ? `<span class="pro-patrol-warn">${c.pending_approval} 待审批</span>` : ''}
        </p>
        ${list}
      </div>
    </section>`
}

function renderPatrolFailed(err) {
  return `
    <section class="pro-patrol-panel pro-patrol-panel--failed" aria-live="assertive">
      <div class="pro-patrol-copy">
        <p class="pro-patrol-kicker">本轮失败</p>
        <h2 class="pro-patrol-title">本轮未能正常结束</h2>
        <p class="pro-patrol-summary">${esc(String(err?.message || err || '未知错误'))}</p>
      </div>
    </section>`
}

function stopPageWatch(page) {
  if (typeof page._stopLiveWatch === 'function') {
    try {
      page._stopLiveWatch()
    } catch {
      /* ignore */
    }
    page._stopLiveWatch = null
  }
  if (page._dispatchWatchTimer) {
    window.clearInterval(page._dispatchWatchTimer)
    page._dispatchWatchTimer = null
  }
  destroyEmployeeLiveMount(page)
  page.dataset.watching = '0'
}

async function onWatchLiveClick(page, role) {
  if (page._liveProcess?.isOpen?.()) {
    toast('过程窗口已打开', 'info')
    return
  }

  let busy = page.dataset.patrolling === '1'
  let roundId = ''
  let at = ''
  try {
    const st = await api.proactiveRoleBusy(role.agent_code)
    busy = busy || !!st?.busy
    // Prefer live duty stamp while working — work-log Task round_id is often older.
    if (busy) {
      roundId = String(st?.current_round_id || '').trim()
      at = String(st?.started_at || roundId || '').trim()
    }
  } catch {
    /* ignore */
  }
  if (!roundId) {
    const latest = latestRoundFromInitiatives(page._initiatives || [])
    roundId = String(latest?.round_id || '').trim()
    at = String(latest?.at || roundId || '').trim()
  }
  ensureEmployeeLiveProcess(page, role, {
    busy,
    roundId: roundId || undefined,
    at: at || roundId,
    title: trailTitle(at || roundId, { busy }),
  })
  toast(busy ? '已打开工作过程（工作中）' : '已打开工作过程', busy ? 'success' : 'info')
}

let _currentPage = null

export async function render() {
  const route = parseRoute()
  let page
  if (route.kind === 'work') {
    page = await renderWorkItemPage(route.code, route.taskId, { from: route.from })
  } else if (route.kind === 'item') {
    page = await renderItemPage(route.code, route.itemId)
  } else if (route.kind === 'employee') {
    page = await renderEmployeePage(route.code, {
      autoPatrol: route.autoPatrol,
      autoLive: route.autoLive,
      dispatchGoal: route.dispatchGoal,
    })
  } else {
    navigate('/proactive')
    page = document.createElement('div')
    page.className = 'page'
    page.textContent = '跳转中…'
  }
  _currentPage = page
  return page
}

// ── Employee work log page ────────────────────────────────

async function renderEmployeePage(code, { autoPatrol = false, autoLive = false, dispatchGoal = '' } = {}) {
  const page = document.createElement('div')
  page.className = 'page proactive-page pro-employee-page'
  page.innerHTML = `
    <div class="pro-page-nav">
      <button type="button" class="btn btn-ghost btn-sm" data-act="back">← 返回员工名册</button>
    </div>
    <div class="pro-loading">加载中…</div>
  `
  page.querySelector('[data-act="back"]')?.addEventListener('click', () => navigate('/proactive'))

  try {
    const [roleRes, boardRes, busyRes, capability, memRes, costRes, perfRes, dashRes, apprRes, journalRes, knowledgeVaults] =
      await Promise.all([
        api.proactiveGetRole(code),
        api.proactiveRoleWorkBoard(code, 100).catch(() => null),
        api.proactiveRoleBusy(code).catch(() => ({ busy: false })),
        loadAgentCapability(code),
        api.proactiveGetMemory(code).catch(() => null),
        api.proactiveRoleCost(code, 7).catch(() => null),
        api.proactiveRolePerformance(code, 7).catch(() => null),
        api.proactiveDashboard().catch(() => null),
        api.proactiveListApprovals('pending').catch(() => ({ approvals: [] })),
        api
          .proactiveListInitiatives({ role_agent_code: code, limit: 40 })
          .catch(() => ({ initiatives: [] })),
        loadKnowledgeVaults().catch(() => []),
      ])
    const role = roleRes
    const schedulePreview = await loadRoleSchedulePreview(role).catch(() => ({
      schedule: '',
      summary: '',
      next_runs: [],
    }))
    let tasks = []
    let initiatives = []
    if (boardRes && (boardRes.rounds || boardRes.tasks || boardRes.initiatives)) {
      tasks = normalizeWorkBoardTasks(boardRes.tasks || [], role.role_name)
      initiatives = tasksAsWorklogItems(tasks)
    } else {
      // Fallback for older gateways
      const tasksRes = await api.listAllTasks().catch(() => null)
      tasks = tasksFromListResponse(tasksRes)
      initiatives = tasksAsWorklogItems(tasks)
    }
    const busy = !!busyRes?.busy
    const memory = memRes || null
    const cost = costRes?.ok === false ? null : costRes
    const performance = perfRes?.ok === false ? null : perfRes
    const dashRow = (dashRes?.roles || []).find(
      (r) => String(r.agent_code) === String(code),
    ) || null
    const approvals = Array.isArray(apprRes?.approvals)
      ? apprRes.approvals
      : Array.isArray(apprRes)
        ? apprRes
        : []
    const pendingN = approvals.filter(
      (a) =>
        a &&
        a.status === 'pending' &&
        String(a.role_agent_code) === String(code),
    ).length
    const journals = Array.isArray(journalRes?.initiatives) ? journalRes.initiatives : []
    page.innerHTML = renderEmployeeShell(role, initiatives, {
      busy,
      agent: capability.agent,
      capabilityChips: capability.chips,
      memory,
      cost,
      performance,
      dash: dashRow,
      pendingApprovalCount: pendingN,
      journals,
      knowledgeVaults: Array.isArray(knowledgeVaults) ? knowledgeVaults : [],
      schedulePreview,
    })
    const avatarHost = page.querySelector('[data-avatar-agent]')
    if (avatarHost) {
      const agent = capability.agent || { agent_code: code }
      void getGatewayBaseUrl()
        .then((baseUrl) => {
          mountAgentAvatar(avatarHost, {
            agent,
            agentCode: code,
            size: 64,
            baseUrl: baseUrl || '',
          })
        })
        .catch(() => {
          mountAgentAvatar(avatarHost, { agent, agentCode: code, size: 64 })
        })
    }
    page._dutyProfileCtx = {
      busy,
      agent: capability.agent,
      capabilityChips: capability.chips,
      memory,
      cost,
      performance,
      schedulePreview,
    }
    bindEmployeePage(page, role, initiatives)
    // 将操作栏搬进 Tauri 标题栏（与窗口控制按钮同一行）
    mountEmployeeNavToChrome(page)
    if (autoPatrol) {
      clearAutoPatrolQuery()
      void runPatrol(page, role)
    } else if (autoLive) {
      clearAutoLiveQuery()
      void watchDispatchedRound(page, role, {
        goal: dispatchGoal,
        conflict: busy && !dispatchGoal,
        initialBusy: busy,
        initialRoundId: String(busyRes?.current_round_id || '').trim(),
      })
    }
  } catch (e) {
    page.innerHTML = `
      <div class="pro-page-nav">
        <button type="button" class="btn btn-ghost btn-sm" data-act="back">← 返回员工名册</button>
      </div>
      <div class="pro-error">加载失败: ${esc(String(e?.message || e))}</div>
    `
    page.querySelector('[data-act="back"]')?.addEventListener('click', () => navigate('/proactive'))
  }
  return page
}

function workStats(initiatives) {
  const list = (Array.isArray(initiatives) ? initiatives : []).filter((i) => !isRoundLog(i))
  const okN = list.filter((i) => i.result === 'success' || i.status === 'completed').length
  const failN = list.filter((i) => i.result === 'failure' || i.status === 'failed').length
  const pendingN = list.filter((i) => i.status === 'pending_approval').length
  // Calculate incomplete rounds: group all initiatives (including round logs) by round_id,
  // then count how many rounds have at least one round log that is incomplete or in-progress
  const all = Array.isArray(initiatives) ? initiatives : []
  const roundGroups = new Map()
  for (const init of all) {
    const rid = String(init.round_id || '').trim()
    if (!rid) continue
    if (!roundGroups.has(rid)) roundGroups.set(rid, [])
    roundGroups.get(rid).push(init)
  }
  let incompleteRounds = 0
  for (const [, items] of roundGroups) {
    const roundLogs = items.filter((i) => isRoundLog(i))
    const actionable = items.filter((i) => !isRoundLog(i))
    // Round is incomplete if:
    // 1. Any round log is marked as incomplete (isIncompleteJournal)
    // 2. Any round log is in a non-terminal state (executing, in_progress, etc.)
    // 3. No round log exists but there are actionable items in non-terminal states
    const roundLogIncomplete = roundLogs.some(
      (rl) => isIncompleteJournal(rl) || (rl.status !== 'completed' && rl.status !== 'failed' && rl.status !== 'cancelled'),
    )
    const noRoundLogWithActionableItems =
      roundLogs.length === 0 && actionable.some((i) => {
        const s = String(i.status || '')
        return s !== 'completed' && s !== 'failed' && s !== 'cancelled' && s !== 'success'
      })
    if (roundLogIncomplete || noRoundLogWithActionableItems) {
      incompleteRounds++
    }
  }
  return {
    total: list.length,
    okN,
    failN,
    pendingN,
    incompleteRounds,
  }
}

function heroDesc(role, initiatives) {
  const stats = workStats(initiatives)
  const parts = [String(role.agent_code), `共 ${stats.total} 项工作`]
  if (stats.pendingN) parts.push(`${stats.pendingN} 待审批`)
  if (stats.okN) parts.push(`${stats.okN} 完成`)
  if (stats.failN) parts.push(`${stats.failN} 失败`)
  const ws = workspaceOf(role)
  if (ws) parts.push(pathBasename(ws))
  if (role.last_heartbeat_at) parts.push(`上次上班 ${fmtTime(role.last_heartbeat_at)}`)
  return parts.join(' · ')
}

/** Detail badge — only 3: 工作中 / 在岗 / 已停 */
function roleStatusBadge(role, busy = false) {
  if (busy) return { label: '工作中', cls: 'pro-badge--run', tip: '正在执行本轮任务' }
  const st = String(role?.status || '')
  const suspended = !!(role?.auto_patrol_suspended || role?.config?.auto_patrol_suspended)
  const stopped =
    st === 'paused' ||
    st === 'archived' ||
    st === 'draft' ||
    (st === 'active' && suspended)

  if (stopped) {
    let tip = '不会自动巡检'
    if (st === 'draft') tip = '草稿未确认，确认后才会排班'
    else if (st === 'paused') tip = '请假中，不会自动巡检'
    else if (st === 'archived') tip = '已归档，不会自动巡检'
    else if (suspended) tip = '该员工自动巡检已关；点「上班」可恢复'
    return { label: '已停', cls: 'pro-badge--muted', tip }
  }

  if (st === 'active') {
    const tipNext = role?.next_heartbeat_at
      ? `下次自动巡检 ${fmtTime(role.next_heartbeat_at)}`
      : '按计划自动巡检'
    return { label: '在岗', cls: 'pro-badge--ok', tip: tipNext }
  }
  return { label: '已停', cls: 'pro-badge--muted', tip: st || '—' }
}

function fmtPeriodDay(iso) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return `${d.getMonth() + 1}/${d.getDate()}`
  } catch {
    return ''
  }
}

/** 与「智能体详情」同款：工具 / MCP / 技能概览芯片 */
async function loadAgentCapability(code) {
  const id = String(code || '').trim()
  if (!id) return { agent: null, chips: [] }
  let agent
  try {
    agent = await api.getAgent(id)
  } catch {
    return { agent: null, chips: [] }
  }

  const chips = []
  const isFrontDesk =
    String(id).toLowerCase() === 'xiaomi' ||
    !!agent?.system_front_desk ||
    String(agent?.agent_name || '').trim() === '小V'
  try {
    if (isFrontDesk) {
      chips.push({
        label: '前台工具',
        tip: '名册 / 看板 / 员工下钻 / 任务汇报 / 派发 / 催办 / 知识检索',
      })
      chips.push({ label: '0 MCP', tip: 'MCP 服务' })
      chips.push({ label: '无技能', tip: '技能模块' })
      return { agent, chips }
    }

    const meta = await api.getToolsMetadata()
    const catalog = (meta?.tools || []).filter((t) => {
      const tier = String(t.tier || 'optional')
      return tier === 'workspace' || tier === 'optional'
    })
    const total = catalog.length
    const allowed = new Set(catalog.map((t) => String(t.value || t.name || '').trim()).filter(Boolean))
    let selected
    if (!Array.isArray(agent.tools)) {
      selected = total
    } else {
      selected = agent.tools.filter((v) => allowed.has(String(v))).length
    }
    if (total) {
      chips.push({
        label: `工具 ${selected}`,
        tip: '内置工具：员工能用的内置能力，比如读文件、跑命令、搜索代码等。',
      })
    } else if (Array.isArray(agent.tools)) {
      chips.push({ label: `工具 ${agent.tools.length}`, tip: '内置工具：员工能用的内置能力。' })
    }

    const mcpN = Array.isArray(agent.mcp_servers)
      ? agent.mcp_servers.length
      : (meta?.mcp_servers || []).filter((s) => s.enabled !== false).length
    chips.push({
      label: `${mcpN} MCP`,
      tip: 'MCP 服务：通过 Model Context Protocol 连接的外部工具，比如数据库、第三方 API 等。\n简单说：让员工能调用外部系统。',
    })

    const skillsN = Array.isArray(agent.skills) ? agent.skills.length : 0
    chips.push({
      label: skillsN > 0 ? `${skillsN} 技能` : '无技能',
      tip: '技能模块：预制的专业工作流，比如「生成图片」「联网研究」「飞书操作」等。\n简单说：给员工加特殊技能。',
    })
  } catch {
    if (isFrontDesk) {
      chips.push({
        label: '前台工具',
        tip: '名册 / 看板 / 员工下钻 / 任务汇报 / 派发 / 催办 / 知识检索',
      })
    } else if (Array.isArray(agent.tools)) {
      chips.push({ label: `工具 ${agent.tools.length}`, tip: '内置工具' })
    }
    if (Array.isArray(agent.mcp_servers)) chips.push({ label: `${agent.mcp_servers.length} MCP`, tip: 'MCP 服务' })
    if (Array.isArray(agent.skills)) {
      chips.push({
        label: agent.skills.length > 0 ? `${agent.skills.length} 技能` : '无技能',
        tip: '技能模块',
      })
    }
  }
  return { agent, chips }
}

function renderRoleProfile(
  role,
  initiatives,
  { busy = false, agent = null, capabilityChips = [], memory = null, cost = null, performance = null, schedulePreview = null } = {},
) {
  const code = role.agent_code
  const cfg = role.config || {}
  const dept = role.department || cfg.department || ''
  const badge = roleStatusBadge(role, busy)
  const stats = workStats(initiatives)
  const autonomy = AUTONOMY_LABEL[cfg.autonomy_level] || cfg.autonomy_level || '—'
  const autonomyHint =
    AUTONOMY_HINT[cfg.autonomy_level] || AUTONOMY_HINT.approval_for_risky
  const resp = Array.isArray(cfg.responsibilities) ? cfg.responsibilities.filter(Boolean) : []
  // 岗位页展示岗位职责，不用智能体 description（那是「智能体」页人设摘要）
  const heroDutyHtml = resp.length
    ? `<ul class="pro-resp-list pro-resp-list--hero">${resp
        .slice(0, 4)
        .map((t) => `<li>${esc(t)}</li>`)
        .join('')}${
        resp.length > 4 ? `<li class="pro-resp-list-more">另有 ${resp.length - 4} 项…</li>` : ''
      }</ul>`
    : `<p class="pro-duty-sheet-desc pro-duty-sheet-desc--muted">暂未配置岗位职责</p>`

  // Hero 能力标签 + 工作量；频率只在「自动上班时间」折叠里出现一次
  const sheetStats = [
    ...capabilityChips.map((c) => ({
      label: c.label,
      tip: c.tip || '',
    })),
    {
      label: `${stats.total} 个工作项`,
      tip: '本岗工作项总数：这个员工处理过的所有任务数。',
    },
  ]

  const field = (label, valueHtml, span = false) =>
    `<div class="detail-field"${span ? ' style="grid-column:1/-1"' : ''}>
      <label class="detail-label">${esc(label)}</label>
      <div class="detail-value">${valueHtml}</div>
    </div>`

  const costLine =
    cost && Number(cost.today_cost_usd) > 0
      ? `今日 $${Number(cost.today_cost_usd) < 0.01 ? Number(cost.today_cost_usd).toFixed(4) : Number(cost.today_cost_usd).toFixed(2)}`
      : ''
  const budget = Number(cost?.daily_budget_usd || 0)
  let budgetLine = ''
  if (budget > 0) {
    const rem = Number(cost?.budget_remaining_usd)
    const over = Number.isFinite(rem) && rem <= 0
    budgetLine = over
      ? '预算已耗尽'
      : `预算余 $${rem < 0.01 ? rem.toFixed(4) : rem.toFixed(2)}（日限 $${budget.toFixed(2)}）`
  }

  const memStrategies = Array.isArray(memory?.strategies) ? memory.strategies.filter(Boolean).slice(-5).reverse() : []
  const memObs = Array.isArray(memory?.observations) ? memory.observations.filter(Boolean).slice(-4).reverse() : []
  const hasMemory = !!(memStrategies.length || memObs.length || memory?.last_think_summary)
  const memBlock = hasMemory
    ? `<div class="pro-memory-snap">
          ${
            memory?.last_think_summary
              ? `<p class="pro-memory-summary"><em>上次小结</em>${esc(previewLine(memory.last_think_summary, 160))}</p>`
              : ''
          }
          ${
            memStrategies.length
              ? `<ul class="pro-memory-list">${memStrategies
                  .map((s) => `<li>${esc(previewLine(s, 140))}</li>`)
                  .join('')}</ul>`
              : ''
          }
          ${
            memObs.length && !memStrategies.length
              ? `<ul class="pro-memory-list">${memObs
                  .map((s) => `<li>${esc(previewLine(s, 140))}</li>`)
                  .join('')}</ul>`
              : ''
          }
          <p class="pro-kpi-hint">完成 ${Number(memory?.completed_initiatives || 0)} 个工作项 · 失败 ${Number(memory?.failed_initiatives || 0)} 个${
            memory?.last_think_at ? ` · ${fmtTime(memory.last_think_at)}` : ''
          }</p>
        </div>`
    : '<span class="pro-item-muted">暂无值班记忆（驳回原因与本轮工作汇报会沉淀到这里）</span>'

  const scheduleLabel = roleScheduleSummary(role)
  const schedulePreviewHtml = renderScheduleNextRunsTable(
    schedulePreview || { summary: '', next_runs: [] },
    { title: '即将自动上班', hideSummary: true },
  )

  // 职责已在 hero；岗位概要只放审批 / 花费 / 概况 / 记忆，避免再抄一遍频率与职责
  const overviewBody = `<div class="detail-grid pro-duty-sheet-grid">
          ${field('岗位名称', esc(role.role_name || '—'))}
          ${field('智能体标识', `<code>${esc(code)}</code>`)}
          ${field(
            '转交审批策略',
            `<span title="${esc(autonomyHint)}">${esc(autonomy)}</span>`,
          )}
          ${costLine ? field('今日花费', esc(costLine)) : ''}
          ${budgetLine ? field('预算', esc(budgetLine)) : ''}
          ${field(
            '工作概况',
            `共 ${stats.total} 个工作项 · ${stats.pendingN} 个待批 · ${stats.okN} 个已完成 · ${stats.failN} 个失败${
              stats.incompleteRounds ? ` · ${stats.incompleteRounds} 轮未完成` : ''
            }`,
            true,
          )}
          ${field('值班记忆', memBlock, true)}
        </div>`

  const foldMeta = autonomy
  const nextDutyMeta = [
    scheduleLabel || '',
    role.next_heartbeat_at ? `下次 ${fmtTime(role.next_heartbeat_at)}` : '',
  ]
    .filter(Boolean)
    .join(' · ')

  return `
    <section class="pro-duty-sheet" aria-label="岗位信息">
      <div class="pro-duty-sheet-hero">
        <div class="pro-duty-sheet-avatar" data-avatar-agent="${esc(code)}" aria-hidden="true"></div>
        <div class="pro-duty-sheet-text">
          <p class="pro-duty-sheet-kicker">${
            !!role.system_front_desk || String(code || '') === 'xiaomi'
              ? '系统前台'
              : '智能体员工'
          }</p>
          <h1 class="pro-duty-sheet-title">${esc(role.role_name || agent?.agent_name || code)}</h1>
          <p class="pro-duty-sheet-code">
            <code>${esc(code)}</code>
            <span class="pro-duty-sheet-sep">·</span>
            <span class="pro-badge ${badge.cls}" data-role-status>${esc(badge.label)}</span>
            ${
              !!role.system_front_desk || String(code || '') === 'xiaomi'
                ? '<span class="pro-duty-sheet-sep">·</span><span class="pro-badge pro-badge--muted" title="安装自带，催办全局待办">系统前台</span>'
                : ''
            }
            ${dept ? `<span class="pro-duty-sheet-sep">·</span><span>${esc(dept)}</span>` : ''}
          </p>
          ${heroDutyHtml}
          <div class="pro-duty-sheet-stats">
            ${sheetStats
              .map(
                (s) =>
                  `<span class="pro-duty-sheet-stat pro-chip-tip" data-tip="${esc(s.tip || '')}">${esc(s.label)}</span>`,
              )
              .join('')}
          </div>
        </div>
      </div>

      <div class="pro-duty-sheet-body" data-role="overview-folds">
        <details class="pro-duty-fold" data-fold="schedule" open>
          <summary class="pro-duty-fold-sum">
            <span class="pro-duty-fold-title">自动上班时间</span>
            <span class="pro-duty-fold-meta">${esc(nextDutyMeta || '未设周期')}</span>
            <span class="pro-duty-fold-chev" aria-hidden="true"></span>
          </summary>
          <div class="pro-duty-fold-body">
            <div class="detail-grid pro-duty-sheet-grid">
              ${field('上次上班', esc(fmtTime(role.last_heartbeat_at)))}
              ${field('下次自动上班', esc(fmtTime(role.next_heartbeat_at)))}
            </div>
            ${schedulePreviewHtml}
          </div>
        </details>
        <details class="pro-duty-fold" data-fold="overview">
          <summary class="pro-duty-fold-sum">
            <span class="pro-duty-fold-title">岗位概要</span>
            <span class="pro-duty-fold-meta">${esc(foldMeta)}</span>
            <span class="pro-duty-fold-chev" aria-hidden="true"></span>
          </summary>
          <div class="pro-duty-fold-body">${overviewBody}</div>
        </details>
      </div>
      <p class="page-desc" data-hero-desc hidden>${esc(heroDesc(role, initiatives))}</p>
    </section>
  `
}

function renderEmployeeConfigPanels(role, {
  agent = null,
  capabilityChips = [],
  knowledgeVaults = [],
  schedulePreview = null,
} = {}) {
  const cfg = role.config || {}
  const code = role.agent_code
  const autonomy = AUTONOMY_LABEL[cfg.autonomy_level] || cfg.autonomy_level || '—'
  const autonomyHint = AUTONOMY_HINT[cfg.autonomy_level] || AUTONOMY_HINT.approval_for_risky
  const thinkLabel = cfg.think_mode === 'prompt_only' ? '轻量工作' : '深度工作'
  const modelName = String(cfg.model_name || '').trim()
  const ws = workspaceOf(role)
  const domain = Array.isArray(cfg.domain_scope) ? cfg.domain_scope.filter(Boolean) : []
  const scheduleLabel = roleScheduleSummary(role)
  const field = (label, valueHtml, span = false) =>
    `<div class="detail-field"${span ? ' style="grid-column:1/-1"' : ''}>
      <label class="detail-label">${esc(label)}</label>
      <div class="detail-value">${valueHtml}</div>
    </div>`

  const vaultIds = Array.isArray(cfg.knowledge_vault_ids)
    ? cfg.knowledge_vault_ids.map((x) => String(x || '').trim()).filter(Boolean)
    : []
  const vaultById = new Map(
    (Array.isArray(knowledgeVaults) ? knowledgeVaults : []).map((v) => [
      String(v.id || '').trim(),
      String(v.name || v.id || '').trim(),
    ]),
  )
  const knowledgeHtml = vaultIds.length
    ? `<div class="pro-role-tags">${vaultIds
        .map((id) => {
          const name = vaultById.get(id) || id
          const tip = vaultById.get(id) ? id : ''
          return `<span class="pro-tag" title="${esc(tip || name)}">${esc(name)}</span>`
        })
        .join('')}</div>`
    : '<span class="pro-item-muted">未关联</span>'

  const capabilityBody = `<div class="detail-grid pro-duty-sheet-grid">
    ${field('工作模型', esc(modelName || '跟随智能体默认'))}
    ${field('工作方式', esc(thinkLabel))}
    ${
      capabilityChips.length
        ? field(
            '能力标签',
            `<div class="pro-role-tags">${capabilityChips
              .map((c) => `<span class="pro-tag" title="${esc(c.tip || '')}">${esc(c.label)}</span>`)
              .join('')}</div>`,
            true,
          )
        : field('能力标签', '<span class="pro-item-muted">暂无</span>')
    }
    ${field(
      '管辖工作空间',
      ws ? `<span title="${esc(ws)}">${esc(pathBasename(ws))}</span>` : '<span class="pro-patrol-warn">未绑定</span>',
    )}
    ${
      domain.length
        ? field(
            '关注子路径',
            `<div class="pro-role-tags">${domain.map((t) => `<span class="pro-tag">${esc(t)}</span>`).join('')}</div>`,
            true,
          )
        : ''
    }
    ${field('知识库', knowledgeHtml, true)}
    ${agent?.agent_name ? field('绑定智能体', esc(agent.agent_name)) : field('绑定智能体', `<code>${esc(code)}</code>`)}
  </div>`

  const runtimeBody = `<div class="detail-grid pro-duty-sheet-grid">
    ${field('转交审批策略', `<span title="${esc(autonomyHint)}">${esc(autonomy)}</span>`)}
    ${field('自动上班', esc(scheduleLabel))}
    ${field('上次上班', esc(fmtTime(role.last_heartbeat_at)))}
    ${field('下次自动上班', esc(fmtTime(role.next_heartbeat_at)))}
    ${field(
      '审批通道',
      esc(
        (cfg.approval_channels || [])
          .map((c) => ({ desktop: '桌面通知', feishu: '飞书' }[c] || c))
          .join(' / ') || '—',
      ),
    )}
    ${field(
      '飞书绑定',
      (() => {
        const b = feishuBindingOf(role)
        if (b.bound) {
          return `<span title="${esc(b.app_id)}">已绑定${b.app_id ? ` · <code>${esc(b.app_id)}</code>` : ''}</span>`
        }
        return '<span class="pro-patrol-warn">未绑定</span>'
      })(),
    )}
    ${field(
      '每日预算',
      Number(cfg.daily_budget_usd) > 0
        ? `$${Number(cfg.daily_budget_usd).toFixed(2)}`
        : '<span class="pro-item-muted">不限</span>',
    )}
    ${field(
      '单次预算',
      Number(cfg.per_run_budget_usd) > 0
        ? `$${Number(cfg.per_run_budget_usd).toFixed(2)}`
        : '<span class="pro-item-muted">不限</span>',
    )}
    ${field(
      '超额策略',
      esc(
        ({
          skip_patrol: '超额后跳过上班并通知',
          pause_role: '超额后暂停岗位',
          notify_only: '超额后仅通知仍可上班',
        })[String(cfg.budget_exceed_policy || 'skip_patrol')] || String(cfg.budget_exceed_policy || 'skip_patrol'),
      ),
    )}
  </div>`

  return `
    <div class="pro-config-panels">
      <details class="pro-config-fold" open>
        <summary class="pro-config-fold__sum">
          <div>
            <h3>基础设置</h3>
            <p>模型、工作空间、知识库 — 新人先把这些配好就行</p>
          </div>
          <span class="pro-duty-fold-chev" aria-hidden="true"></span>
        </summary>
        <div class="pro-config-fold__body">
          ${capabilityBody}
        </div>
      </details>

      <details class="pro-config-fold">
        <summary class="pro-config-fold__sum">
          <div>
            <h3>运行设置</h3>
            <p>上班频率、排班、审批通道 — 想让它自动干活再配</p>
          </div>
          <span class="pro-duty-fold-chev" aria-hidden="true"></span>
        </summary>
        <div class="pro-config-fold__body">
          <div class="detail-grid pro-duty-sheet-grid">
            ${field('转交审批策略', `<span class="pro-chip-tip" data-tip="${esc(autonomyHint)}">${esc(autonomy)}</span>`)}
            ${field('自动上班', esc(scheduleLabel))}
            ${field('上次上班', esc(fmtTime(role.last_heartbeat_at)))}
            ${field('下次自动上班', esc(fmtTime(role.next_heartbeat_at)))}
            ${field(
              '审批通道',
              esc(
                (cfg.approval_channels || [])
                  .map((c) => ({ desktop: '桌面通知', feishu: '飞书' }[c] || c))
                  .join(' / ') || '—',
              ),
            )}
            ${field(
              '飞书绑定',
              (() => {
                const b = feishuBindingOf(role)
                if (b.bound) {
                  return `<span title="${esc(b.app_id)}">已绑定${b.app_id ? ` · <code>${esc(b.app_id)}</code>` : ''}</span>`
                }
                return '<span class="pro-patrol-warn">未绑定</span>'
              })(),
            )}
          </div>
          ${renderScheduleNextRunsTable(
            schedulePreview || { summary: '', next_runs: [] },
            { title: '即将自动上班', hideSummary: true },
          )}
        </div>
      </details>

      <details class="pro-config-fold">
        <summary class="pro-config-fold__sum">
          <div>
            <h3>预算与风控</h3>
            <p>每日预算、单次预算、超额策略 — 怕烧钱就来这里</p>
          </div>
          <span class="pro-duty-fold-chev" aria-hidden="true"></span>
        </summary>
        <div class="pro-config-fold__body">
          <div class="detail-grid pro-duty-sheet-grid">
            ${field(
              '每日预算',
              Number(cfg.daily_budget_usd) > 0
                ? `$${Number(cfg.daily_budget_usd).toFixed(2)}`
                : '<span class="pro-item-muted">不限</span>',
            )}
            ${field(
              '单次预算',
              Number(cfg.per_run_budget_usd) > 0
                ? `$${Number(cfg.per_run_budget_usd).toFixed(2)}`
                : '<span class="pro-item-muted">不限</span>',
            )}
            ${field(
              '超额策略',
              esc(
                ({
                  skip_patrol: '超额后跳过上班并通知',
                  pause_role: '超额后暂停岗位',
                  notify_only: '超额后仅通知仍可上班',
                })[String(cfg.budget_exceed_policy || 'skip_patrol')] || String(cfg.budget_exceed_policy || 'skip_patrol'),
              ),
            )}
          </div>
        </div>
      </details>
    </div>`
}

function renderEmployeeMetricsPanels({ memory = null, cost = null, performance = null, role = null } = {}) {
  const periodLabel = (() => {
    const a = fmtPeriodDay(performance?.period_start)
    const b = fmtPeriodDay(performance?.period_end)
    if (a && b) return `${a} – ${b}`
    return `近 ${Number(performance?.days || 7)} 日`
  })()
  const perfBlock = performance
    ? `<div class="pro-perf-snap pro-perf-snap--weekly">
        <div class="pro-perf-period">${esc(role?.role_name || role?.agent_code || '')} · 周报（${esc(periodLabel)}）</div>
        <ul class="pro-perf-tree">
          <li>值班轮次 ${Number(performance.patrol_rounds || 0)} 轮</li>
          <li>产出工作项 ${Number(performance.initiatives?.total || 0)} 个（完成 ${Number(performance.initiatives?.completed || 0)} / 失败 ${Number(performance.initiatives?.failed || 0)}）</li>
          <li>审批通过 ${Number(performance.approvals?.approved || 0)} / 共 ${Number(performance.approvals?.total || 0)} 次（通过率 ${Number(performance.approvals?.approval_rate || 0)}%）</li>
          <li>成本 $${Number(performance.cost_usd || 0).toFixed(4)} · ${Number(performance.tokens || 0).toLocaleString()} tokens</li>
          ${
            Number(performance.consecutive_noop || 0) >= 3
              ? `<li class="pro-perf-warn">连续空转 ${Number(performance.consecutive_noop)} 轮</li>`
              : ''
          }
        </ul>
        ${performance.suggestion ? `<p class="pro-kpi-hint">建议：${esc(performance.suggestion)}</p>` : ''}
      </div>`
    : '<span class="pro-item-muted">暂无履职周报</span>'

  const costDays = Array.isArray(cost?.days) ? [...cost.days].reverse() : []
  const maxDayCost = Math.max(0.000001, ...costDays.map((d) => Number(d.cost_usd) || 0))
  const avgCost =
    costDays.length > 0
      ? costDays.reduce((s, d) => s + (Number(d.cost_usd) || 0), 0) / costDays.length
      : 0
  const hasCost =
    !!(cost && (Number(cost.total_cost_usd) > 0 || costDays.length || Number(cost.today_cost_usd) > 0))
  const costBlock = hasCost
    ? `<div class="pro-cost-snap">
          <div class="pro-cost-snap-meta">
            <span>7 日合计 $${Number(cost.total_cost_usd || 0).toFixed(4)}</span>
            <span>日均 $${avgCost.toFixed(4)}</span>
            <span>${Number(cost.total_tokens || 0).toLocaleString()} tokens</span>
            ${
              Number(cost.daily_budget_usd) > 0
                ? `<span>日预算 $${Number(cost.daily_budget_usd).toFixed(2)}</span>`
                : ''
            }
          </div>
          ${
            costDays.length
              ? `<div class="pro-cost-bars" aria-hidden="true">${costDays
                  .map((d) => {
                    const v = Number(d.cost_usd) || 0
                    const h = Math.max(8, Math.round((v / maxDayCost) * 40))
                    return `<span class="pro-cost-bar" title="${esc(d.date)} · $${v.toFixed(4)}" style="height:${h}px"></span>`
                  })
                  .join('')}</div>`
              : '<p class="pro-kpi-hint">近 7 日暂无成本采样</p>'
          }
        </div>`
    : '<span class="pro-item-muted">暂无成本数据（上班跑过后会累计）</span>'

  const memStrategies = Array.isArray(memory?.strategies) ? memory.strategies.filter(Boolean).slice(-5).reverse() : []
  const memObs = Array.isArray(memory?.observations) ? memory.observations.filter(Boolean).slice(-4).reverse() : []
  const hasMemory = !!(memStrategies.length || memObs.length || memory?.last_think_summary)
  const memBlock = hasMemory
    ? `<div class="pro-memory-snap">
          ${
            memory?.last_think_summary
              ? `<p class="pro-memory-summary"><em>上次小结</em>${esc(previewLine(memory.last_think_summary, 160))}</p>`
              : ''
          }
          ${
            memStrategies.length
              ? `<ul class="pro-memory-list">${memStrategies
                  .map((s) => `<li>${esc(previewLine(s, 140))}</li>`)
                  .join('')}</ul>`
              : ''
          }
          ${
            memObs.length && !memStrategies.length
              ? `<ul class="pro-memory-list">${memObs
                  .map((s) => `<li>${esc(previewLine(s, 140))}</li>`)
                  .join('')}</ul>`
              : ''
          }
          <p class="pro-kpi-hint">完成 ${Number(memory?.completed_initiatives || 0)} 个工作项 · 失败 ${Number(memory?.failed_initiatives || 0)} 个${
            memory?.last_think_at ? ` · ${fmtTime(memory.last_think_at)}` : ''
          }</p>
        </div>`
    : '<span class="pro-item-muted">暂无值班记忆</span>'

  return `
    <div class="pro-config-panels">
      <details class="pro-config-fold" open>
        <summary class="pro-config-fold__sum">
          <div>
            <h3>履职周报</h3>
            <p>看看这个员工最近干得怎么样</p>
          </div>
          <span class="pro-duty-fold-chev" aria-hidden="true"></span>
        </summary>
        <div class="pro-config-fold__body">${perfBlock}</div>
      </details>

      <details class="pro-config-fold">
        <summary class="pro-config-fold__sum">
          <div>
            <h3>成本（近 7 日）</h3>
            <p>token 消耗和费用趋势</p>
          </div>
          <span class="pro-duty-fold-chev" aria-hidden="true"></span>
        </summary>
        <div class="pro-config-fold__body">${costBlock}</div>
      </details>

      <details class="pro-config-fold">
        <summary class="pro-config-fold__sum">
          <div>
            <h3>值班记忆</h3>
            <p>员工自己总结的经验和观察</p>
          </div>
          <span class="pro-duty-fold-chev" aria-hidden="true"></span>
        </summary>
        <div class="pro-config-fold__body">${memBlock}</div>
      </details>
    </div>`
}

function readDutyFoldOpen(slot) {
  const folds = slot?.querySelectorAll('details.pro-duty-fold')
  if (!folds?.length) return null
  return new Set(
    [...folds].filter((el) => el.open && el.dataset.fold).map((el) => el.dataset.fold),
  )
}

function applyDutyFoldOpen(slot, openSet) {
  if (!slot || !openSet) return
  slot.querySelectorAll('details.pro-duty-fold').forEach((el) => {
    const id = el.dataset.fold
    if (!id) return
    el.open = openSet.has(id)
  })
}

function patchRoleProfile(page, role, initiatives, opts = {}) {
  const slot = page.querySelector('[data-role-profile]')
  if (!slot) return
  const prev = page._dutyProfileCtx || {}
  const next = {
    busy: opts.busy ?? false,
    agent: opts.agent ?? prev.agent ?? null,
    capabilityChips: opts.capabilityChips ?? prev.capabilityChips ?? [],
    memory: opts.memory ?? prev.memory ?? null,
    cost: opts.cost ?? prev.cost ?? null,
    performance: opts.performance ?? prev.performance ?? null,
    schedulePreview: opts.schedulePreview ?? prev.schedulePreview ?? null,
  }
  page._dutyProfileCtx = next
  const foldOpen = readDutyFoldOpen(slot)
  slot.innerHTML = renderRoleProfile(role, initiatives, next)
  applyDutyFoldOpen(slot, foldOpen)
}

/** 新手引导卡：员工还没跑过任何工作时显示 */
function renderOnboardingCard(role) {
  const code = role.agent_code
  const name = role.role_name || code
  const noWs = !role.config?.workspace_path
  const steps = [
    {
      num: '1',
      title: '绑定工作空间',
      desc: noWs ? '还没绑定，先告诉它在哪干活' : '已绑定 ✓',
      act: noWs ? 'edit' : null,
      done: !noWs,
    },
    {
      num: '2',
      title: '设置岗位职责',
      desc: '告诉它该管什么、不该管什么',
      act: 'edit',
      done: Array.isArray(role.config?.responsibilities) && role.config.responsibilities.length > 0,
    },
    {
      num: '3',
      title: '派发第一个任务',
      desc: '给它派个活，看看它怎么干活的',
      act: 'dispatch',
      done: false,
    },
  ]
  return `
    <div class="pro-onboard-card" data-onboard-card>
      <div class="pro-onboard-ico">👋</div>
      <h3 class="pro-onboard-title">欢迎使用「${esc(name)}」</h3>
      <p class="pro-onboard-desc">智能体员工可以帮你自动巡检代码、处理任务、写文档、做分析。完成下面 3 步，让它跑起来：</p>
      <ol class="pro-onboard-steps">
        ${steps
          .map(
            (s) => `
          <li class="pro-onboard-step" data-onboard-step="${s.act || ''}">
            <span class="pro-onboard-step-num">${s.num}</span>
            <p class="pro-onboard-step-title">${esc(s.title)}</p>
            <p class="pro-onboard-step-desc">${esc(s.desc)}</p>
          </li>`,
          )
          .join('')}
      </ol>
      <div class="pro-onboard-actions">
        <button type="button" class="btn btn-sm pro-dispatch-btn" data-act="dispatch-first">🚀 派发第一个任务</button>
        <button type="button" class="btn btn-sm btn-outline" data-act="edit">编辑岗位设置</button>
      </div>
    </div>`
}

/** 派发任务弹窗（员工页版，简化版） */
function showDispatchModalEmployee(role) {
  return new Promise((resolve) => {
    const name = role.role_name || role.agent_code
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay hire-overlay'
    overlay.innerHTML = `
      <div class="hire-sheet" role="dialog" aria-labelledby="emp-dispatch-title">
        <header class="hire-sheet-head">
          <div>
            <p class="hire-sheet-kicker">派发任务</p>
            <h2 id="emp-dispatch-title" class="hire-sheet-title">派发给「${esc(name)}」</h2>
          </div>
          <button type="button" class="hire-sheet-close" data-act="close" aria-label="关闭">&times;</button>
        </header>

        <div class="hire-agent-card">
          <div class="hire-agent-avatar" data-avatar-agent="${esc(role.agent_code)}" aria-hidden="true"></div>
          <div class="hire-agent-meta">
            <div class="hire-agent-name">${esc(name)}</div>
            <div class="hire-agent-code">${esc(role.agent_code)}</div>
          </div>
          <span class="hire-agent-pill">员工会立即开始处理</span>
        </div>

        <div class="hire-sheet-body">
          <p class="hire-chip-hint">描述你想让它做什么，越具体效果越好。员工会围绕目标自主工作并记录结果。</p>

          <div class="hire-field">
            <span>常用模板 <em style="color:var(--text-tertiary);font-weight:400">（点一下填入）</em></span>
            <div class="hire-template-row" data-role="dispatch-templates">
              <button type="button" class="hire-template-chip" data-goal="检查当前项目的代码质量，找出潜在 bug 和可优化的地方，输出一份问题清单和修复建议" data-desc="重点关注：错误处理、性能问题、代码重复。输出 Markdown 格式的报告。">🔍 代码巡检</button>
              <button type="button" class="hire-template-chip" data-goal="分析最近 7 天各岗位的成本消耗数据，输出成本排行和优化建议" data-desc="数据从成本统计接口获取，输出表格 + 建议，Markdown 格式。">📊 成本分析</button>
              <button type="button" class="hire-template-chip" data-goal="给这个岗位写一份标准的周报模板，包含核心指标、工作回顾、问题与改进、下周计划" data-desc="模板要实用，不要太空洞。每个模块给 2-3 个填写示例。">📝 周报模板</button>
              <button type="button" class="hire-template-chip" data-goal="整理当前工作区的项目结构，输出一份项目架构说明文档" data-desc="包括目录结构、核心模块、技术栈、启动方式。输出到 docs/ 目录。">🗂️ 项目文档</button>
              <button type="button" class="hire-template-chip" data-goal="检查项目中所有 TODO 和 FIXME 注释，整理成待办清单并评估优先级" data-desc="按文件分组，标注行号，按紧急程度排序。">✅ TODO 整理</button>
              <button type="button" class="hire-template-chip" data-goal="阅读最近 3 条工作日志，总结这个员工的工作风格和需要改进的地方" data-desc="从工作记录中分析：强项、弱项、常见失误、改进建议。">🧠 员工复盘</button>
            </div>
          </div>

          <label class="hire-field">
            <span>任务目标 <em style="color:var(--error)">*</em></span>
            <textarea
              class="hire-input hire-textarea"
              data-name="goal"
              rows="4"
              placeholder="例如：检查 src/pages 下所有页面的 console 报错并修复
或：分析最近 7 天的成本数据，找出花费最高的 3 个岗位
或：给 product-manager 岗位写一份周报模板"
            ></textarea>
          </label>
          <label class="hire-field">
            <span>补充说明（可选）</span>
            <textarea
              class="hire-input hire-textarea"
              data-name="description"
              rows="2"
              placeholder="额外上下文、约束条件、或你期望的产出格式"
            ></textarea>
          </label>
          <div class="hire-field">
            <span>优先级</span>
            <div class="hire-chip-row" data-name="priority" role="radiogroup">
              <button type="button" class="hire-chip" data-value="low">低</button>
              <button type="button" class="hire-chip is-on" data-value="normal">普通</button>
              <button type="button" class="hire-chip" data-value="high">高</button>
              <button type="button" class="hire-chip" data-value="urgent">紧急</button>
            </div>
          </div>
        </div>

        <footer class="hire-sheet-foot">
          <button type="button" class="btn btn-secondary btn-sm" data-act="close">取消</button>
          <button type="button" class="btn btn-sm hire-confirm pro-dispatch-btn" data-act="confirm">立即派发</button>
        </footer>
      </div>
    `
    document.body.appendChild(overlay)

    // Mount avatar
    const avatarHost = overlay.querySelector('[data-avatar-agent]')
    if (avatarHost) {
      void import('../lib/mount-agent-ui.js').then((m) => {
        m.mountAgentAvatar(avatarHost, {
          agent: { agent_code: role.agent_code, agent_name: name },
          agentCode: role.agent_code,
          size: 40,
        })
      }).catch(() => {})
    }

    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      try { overlay.remove() } catch { /* ignore */ }
      resolve(value)
    }

    let priority = 'normal'

    // 模板快捷填入
    overlay.querySelectorAll('[data-role="dispatch-templates"] .hire-template-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const goal = chip.dataset.goal || ''
        const desc = chip.dataset.desc || ''
        const goalEl = overlay.querySelector('[data-name="goal"]')
        const descEl = overlay.querySelector('[data-name="description"]')
        if (goalEl) goalEl.value = goal
        if (descEl) descEl.value = desc
        // 高亮选中
        overlay.querySelectorAll('[data-role="dispatch-templates"] .hire-template-chip').forEach((c) => {
          c.classList.remove('is-on')
        })
        chip.classList.add('is-on')
        goalEl?.focus()
      })
    })

    overlay.querySelectorAll('[data-name="priority"] .hire-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        overlay.querySelectorAll('[data-name="priority"] .hire-chip').forEach((c) => c.classList.remove('is-on'))
        chip.classList.add('is-on')
        priority = chip.dataset.value || 'normal'
      })
    })

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(null)
    })
    overlay.querySelectorAll('[data-act="close"]').forEach((el) => {
      el.addEventListener('click', () => finish(null))
    })
    overlay.querySelector('[data-act="confirm"]')?.addEventListener('click', () => {
      const goal = String(overlay.querySelector('[data-name="goal"]')?.value || '').trim()
      const description = String(overlay.querySelector('[data-name="description"]')?.value || '').trim()
      if (!goal) {
        toast('请填写任务目标', 'warning')
        overlay.querySelector('[data-name="goal"]')?.focus()
        return
      }
      finish({ goal, description, priority })
    })
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        finish(null)
      }
    })
    overlay.querySelector('[data-name="goal"]')?.focus()
  })
}

function renderEmployeeShell(
  role,
  initiatives,
  {
    highlightRoundId = '',
    busy = false,
    agent = null,
    capabilityChips = [],
    memory = null,
    cost = null,
    performance = null,
    dash = null,
    pendingApprovalCount = 0,
    journals = [],
    knowledgeVaults = [],
    schedulePreview = null,
  } = {},
) {
  const code = role.agent_code
  const isSystemFrontDesk = !!role.system_front_desk || String(code || '') === 'xiaomi'
  const noWorkspace = !role.config?.workspace_path && !isSystemFrontDesk
  const diags = diagnoseRole({
    agentCode: code,
    dash,
    pendingApprovalCount,
    initiatives,
    noWorkspace,
    isDraft: role.status === 'draft',
    isPaused: role.status === 'paused',
  })
  const diagHtml = renderRoleDiagnosisHtml(diags, { esc, code, compact: false })
  const feishuBound = feishuBindingOf(role).bound
  const primaryWorkLabel = busy
    ? '停止工作'
    : role.status === 'paused'
      ? '恢复并立即上班'
      : '立即上班'
  const primaryWorkAct = busy ? 'stop-work' : 'heartbeat'
  const moreItems = []
  if (role.status === 'active' || role.status === 'paused' || busy) {
    moreItems.push(
      `<button type="button" class="pro-role-more-item" role="menuitem" data-act="${primaryWorkAct}" data-testid="pro-primary-work">${esc(primaryWorkLabel)}</button>`,
    )
  }
  moreItems.push(
    `<button type="button" class="pro-role-more-item" role="menuitem" data-act="edit">编辑岗位</button>`,
    feishuBound
      ? `<button type="button" class="pro-role-more-item" role="menuitem" data-act="feishu-unbind">解绑飞书</button>`
      : `<button type="button" class="pro-role-more-item" role="menuitem" data-act="feishu-bind">绑定飞书</button>`,
    `<button type="button" class="pro-role-more-item" role="menuitem" data-act="refresh">刷新</button>`,
    `<button type="button" class="pro-role-more-item" role="menuitem" data-act="open-kanban">本岗进度看板</button>`,
    `<button type="button" class="pro-role-more-item" role="menuitem" data-act="open-tasks">本岗全部任务</button>`,
  )
  if (!isSystemFrontDesk) {
    if (role.status !== 'archived') {
      moreItems.push(`<button type="button" class="pro-role-more-item" role="menuitem" data-act="archive">归档</button>`)
    }
    moreItems.push(
      `<div class="pro-role-more-sep"></div>`,
      `<button type="button" class="pro-role-more-item pro-role-more-item--danger" role="menuitem" data-act="delete">删除岗位</button>`,
    )
  }
  const tabs = [
    { key: 'rounds', label: '上班记录' },
    { key: 'growth', label: '成长' },
    { key: 'metrics', label: '运行数据' },
    { key: 'config', label: '配置' },
  ]
  return `
    <div class="pro-page-nav">
      <button type="button" class="btn btn-ghost btn-sm" data-act="back">← 返回员工名册</button>
      <div class="pro-page-nav-actions">
        ${
          (role.status === 'active' || role.status === 'paused' || busy) && !isSystemFrontDesk
            ? `<button type="button" class="btn btn-sm pro-dispatch-btn" data-act="dispatch" title="给这位员工派发任务">📨 派发任务</button>
        <button type="button" class="btn btn-sm btn-outline" data-act="open-chat" title="在主聊天「员工对话」里打开该员工会话">💬 跟他聊</button>`
            : ''
        }
        <button type="button" class="btn btn-sm btn-ghost" data-act="watch-live" title="查看本岗会话工作过程">工作过程</button>
        <div class="pro-role-more" data-role="employee-more">
          <button type="button" class="btn btn-sm btn-ghost pro-role-more-btn" data-act="more-toggle" aria-haspopup="menu" aria-expanded="false" title="更多">⋯</button>
          <div class="pro-role-more-menu" role="menu" hidden>
            ${moreItems.join('')}
          </div>
        </div>
      </div>
    </div>

    <div data-role-profile>
      ${renderRoleProfile(role, initiatives, { busy, agent, capabilityChips, memory, cost, performance, schedulePreview })}
    </div>

    <div class="pro-employee-alerts" data-role="employee-alerts">
      ${diagHtml ? `<div class="pro-employee-diag">${diagHtml}</div>` : ''}
      <div id="pro-patrol-slot"></div>
      ${
        initiatives.length === 0 && !isSystemFrontDesk
          ? `<div style="margin-top:12px">${renderOnboardingCard(role)}</div>`
          : ''
      }
    </div>

    <nav class="pro-employee-tabs" role="tablist" aria-label="员工详情分区" data-role="employee-tabs">
      ${tabs
        .map(
          (t, i) => `
        <button type="button" class="pro-employee-tab${i === 0 ? ' is-active' : ''}" role="tab" data-act="employee-tab" data-tab="${t.key}" aria-selected="${i === 0 ? 'true' : 'false'}">${t.label}</button>`,
        )
        .join('')}
    </nav>

    <div class="pro-employee-tabpanels">
      <div class="pro-employee-panel is-active" data-panel="rounds">
        <div class="pro-employee-body" id="pro-employee-body" data-work-host="rounds">
          ${renderEmployeeWorkBody(code, initiatives, {
            highlightRoundId,
            selectedDay: WORKLOG_RECENT2,
            view: 'diary',
            listStatus: 'all',
          })}
        </div>
      </div>
      <div class="pro-employee-panel" data-panel="growth" hidden>
        <div class="pro-employee-growth" data-role="growth-host">
          <div class="pro-muted" style="padding:16px">加载成长记录…</div>
        </div>
      </div>
      <div class="pro-employee-panel" data-panel="metrics" hidden>
        ${renderEmployeeMetricsPanels({ memory, cost, performance, role })}
      </div>
      <div class="pro-employee-panel" data-panel="config" hidden>
        ${renderEmployeeConfigPanels(role, { agent, capabilityChips, knowledgeVaults, schedulePreview })}
      </div>
    </div>
  `
}

function groupByRound(initiatives) {
  const groups = new Map()
  for (const init of initiatives) {
    const rid = String(init.round_id || '').trim()
    const day = dayKeyFromAt(init.updated_at || init.created_at)
    // Task-only: no round_id → cluster by calendar day (not one group per task).
    const key = rid || (day && day !== 'unknown' ? `day:${day}` : `item:${init.id}`)
    if (!groups.has(key)) {
      groups.set(key, {
        round_id: rid || null,
        goal: '',
        outcome: '',
        at: init.updated_at || init.created_at,
        items: [],
      })
    }
    const g = groups.get(key)
    g.items.push(init)
    const ts = init.updated_at || init.created_at
    if (ts && (!g.at || ts > g.at)) g.at = ts
  }
  return [...groups.values()]
    .map((g) => enrichRound(g))
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
}

/** Local calendar day key YYYY-MM-DD from ISO / round timestamp. */
function dayKeyFromAt(at) {
  try {
    if (!at) return 'unknown'
    let d = new Date(at)
    if (Number.isNaN(d.getTime())) {
      const m = String(at).match(/^(?:round|dispatch):(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/i)
      if (m) d = new Date(m[1])
    }
    if (Number.isNaN(d.getTime())) return 'unknown'
    const y = d.getFullYear()
    const mo = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${mo}-${day}`
  } catch {
    return 'unknown'
  }
}

function localDayKey(date = new Date()) {
  const y = date.getFullYear()
  const mo = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${y}-${mo}-${day}`
}

function dayLabelFromKey(key) {
  if (!key || key === 'unknown') return '日期未知'
  const today = localDayKey()
  const yest = new Date()
  yest.setDate(yest.getDate() - 1)
  const yesterday = localDayKey(yest)
  if (key === today) return '今天'
  if (key === yesterday) return '昨天'
  try {
    const [y, m, d] = key.split('-').map(Number)
    const dt = new Date(y, m - 1, d)
    const week = ['日', '一', '二', '三', '四', '五', '六'][dt.getDay()]
    const thisYear = new Date().getFullYear()
    const prefix = y === thisYear ? `${m}月${d}日` : `${y}年${m}月${d}日`
    return `${prefix} 周${week}`
  } catch {
    return key
  }
}

function fmtRoundClock(at) {
  try {
    if (!at) return ''
    let d = new Date(at)
    if (Number.isNaN(d.getTime())) {
      const m = String(at).match(/^round:(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/i)
      if (m) d = new Date(m[1])
    }
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

/** Group duty rounds under calendar days (newest day first). */
function groupRoundsByDay(rounds) {
  const map = new Map()
  for (const round of rounds) {
    const key = dayKeyFromAt(round.at)
    if (!map.has(key)) map.set(key, { day_key: key, rounds: [] })
    map.get(key).rounds.push(round)
  }
  return [...map.values()]
    .map((day) => {
      const roundsInDay = [...day.rounds].sort((a, b) =>
        String(b.at || '').localeCompare(String(a.at || '')),
      )
      const actionableN = roundsInDay.reduce((n, r) => n + Number(r.actionableN || 0), 0)
      return {
        day_key: day.day_key,
        label: dayLabelFromKey(day.day_key),
        rounds: roundsInDay,
        roundN: roundsInDay.length,
        actionableN,
      }
    })
    .sort((a, b) => String(b.day_key || '').localeCompare(String(a.day_key || '')))
}

function enrichRound(round) {
  const items = Array.isArray(round.items) ? round.items : []
  const journals = items.filter((i) => isRoundLog(i))
  const actionable = items.filter((i) => !isRoundLog(i))
  const wrap =
    journals.find((j) => journalPhase(j) === 'wrap_up') ||
    journals.find((j) => journalPhase(j) === 'progress') ||
    journals[0] ||
    null
  const incomplete = wrap ? isIncompleteJournal(wrap) : false
  const phase = wrap ? journalPhase(wrap) : ''
  const goal = String((wrap && wrap.goal) || '').trim()
  const outcome = String((wrap && wrap.outcome) || '').trim()
  const reflection = wrap ? journalReflection(wrap) : ''

  const pending = actionable.filter((i) => i.status === 'pending_approval').length
  const completed = actionable.filter(
    (i) => i.status === 'completed' || i.result === 'success',
  ).length
  const failed = actionable.filter(
    (i) => i.status === 'failed' || i.result === 'failure',
  ).length
  const executing = actionable.filter((i) => i.status === 'executing').length

  let verdict = 'partial'
  let verdict_label = '有记录'
  let verdict_cls = 'pro-scorecard--partial'
  if (!items.length) {
    verdict = 'empty'
    verdict_label = '无记录'
    verdict_cls = 'pro-scorecard--empty'
  } else if (incomplete) {
    verdict = 'incomplete'
    verdict_label = '未完整收尾'
    verdict_cls = 'pro-scorecard--incomplete'
  } else if (phase === 'wrap_up' && wrap?.status === 'completed') {
    verdict = 'completed'
    verdict_label = '已结束'
    verdict_cls = 'pro-scorecard--ok'
  } else if (phase === 'check_in' && wrap?.status === 'executing') {
    verdict = 'in_progress'
    verdict_label = '进行中'
    verdict_cls = 'pro-scorecard--run'
  } else if (!wrap) {
    // Task-only work log: derive from board Tasks in this round.
    if (executing || pending) {
      verdict = 'in_progress'
      verdict_label = '进行中'
      verdict_cls = 'pro-scorecard--run'
    } else if (failed && !completed) {
      verdict = 'incomplete'
      verdict_label = '有失败'
      verdict_cls = 'pro-scorecard--incomplete'
    } else if (completed && failed === 0 && pending === 0 && executing === 0) {
      verdict = 'completed'
      verdict_label = '已完成'
      verdict_cls = 'pro-scorecard--ok'
    } else {
      verdict = 'partial'
      verdict_label = `${actionable.length} 项工作`
      verdict_cls = 'pro-scorecard--partial'
    }
  }

  return {
    ...round,
    journal: wrap,
    phase,
    incomplete,
    goal,
    outcome,
    reflection,
    actionable,
    actionableN: actionable.length,
    pendingN: pending,
    completedN: completed,
    failedN: failed,
    verdict,
    verdict_label,
    verdict_cls,
  }
}

/** One-line round narrative (outcome preferred, else goal). */
function renderRoundSummaryLine(sc, { maxLen = 220 } = {}) {
  if (!sc) return ''
  const summary = String(sc.outcome || sc.goal || '').trim()
  if (!summary) return ''
  return `<p class="pro-scorecard-summary">${esc(previewLine(summary, maxLen))}</p>`
}

function renderRoundScorecard(round) {
  if (!round?.round_id && !(round?.items || []).length) return ''
  const summary = renderRoundSummaryLine(round)
  // Hide empty noise: completed/partial with no narrative.
  if (
    !summary &&
    round.verdict !== 'incomplete' &&
    round.verdict !== 'empty' &&
    round.verdict !== 'in_progress'
  ) {
    return ''
  }
  const hint =
    round.verdict === 'incomplete'
      ? '本轮未完整收尾；进度以「工作项看板」为准'
      : ''
  const badgeCls =
    round.verdict === 'completed'
      ? 'pro-badge--ok'
      : round.verdict === 'incomplete' || round.verdict === 'empty'
        ? 'pro-badge--warn'
        : round.verdict === 'in_progress'
          ? 'pro-badge--run'
          : 'pro-badge--muted'
  return `
    <div class="pro-round-summary ${esc(round.verdict_cls || '')}">
      <div class="pro-round-summary-head">
        <span class="pro-round-summary-kicker">本轮工作汇报</span>
        <span class="pro-badge ${badgeCls}">${esc(round.verdict_label || '—')}</span>
      </div>
      ${summary}
      ${hint ? `<p class="pro-scorecard-hint">${esc(hint)}</p>` : ''}
    </div>`
}

function renderRoundSection(code, round, { dayRoundIdx, dayRoundTotal, highlightRoundId = '' } = {}) {
  const hi = String(highlightRoundId || '').trim()
  const isNew = Boolean(hi && String(round.round_id || '') === hi)
  const clock = fmtRoundClock(round.at)
  const nth = Number(dayRoundTotal || 0) - Number(dayRoundIdx || 0)
  const label = round.round_id
    ? `${clock ? `${clock} · ` : ''}本日第 ${nth} 次上班`
    : `${clock ? `${clock} · ` : ''}零散工作项`
  const taskItems = (round.actionable || round.items.filter((i) => !isRoundLog(i))).filter(
    (i) => i._is_task || !i._migrated_to_task,
  )
  return `
    <section class="pro-worklog-round${isNew ? ' pro-worklog-round--new' : ''}${round.verdict === 'incomplete' ? ' pro-worklog-round--incomplete' : ''}" ${isNew ? 'data-patrol-round="1"' : ''}>
      <header class="pro-worklog-round-head">
        <div>
          <h3 class="pro-worklog-round-title">${esc(label)}${isNew ? ' <span class="pro-worklog-new-tag">本轮</span>' : ''}</h3>
          <p class="pro-worklog-round-time">${fmtTime(round.at)}</p>
        </div>
        <div class="pro-worklog-round-actions">
          ${
            round.round_id
              ? `<button type="button" class="btn btn-sm btn-ghost" data-act="open-round-trail" data-round-id="${esc(round.round_id)}" data-round-at="${esc(round.at || '')}" title="查看本轮工作过程">工作过程</button>`
              : ''
          }
          <span class="pro-meta-chip">${taskItems.length ? `${taskItems.length} 项工作` : '值班轮次'}</span>
          ${
            taskItems.length
              ? `<button type="button" class="btn btn-sm btn-ghost" data-act="open-kanban" title="按状态查看本岗工作项">本岗进度</button>`
              : ''
          }
        </div>
      </header>
      ${renderRoundScorecard(round)}
      <div class="pro-item-list">
        ${
          taskItems.map((init) => renderItemCard(code, init, { highlight: isNew })).join('') ||
          `<p class="pro-worklog-empty-items">过程细节见「工作过程」</p>`
        }
      </div>
    </section>`
}

function availableDayKeys(initiatives) {
  const rounds = groupByRound(Array.isArray(initiatives) ? initiatives : [])
  return groupRoundsByDay(rounds)
    .map((d) => d.day_key)
    .filter((k) => k && k !== 'unknown')
}

function localDayKeyOffset(daysAgo = 0) {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() - Number(daysAgo || 0))
  return localDayKey(d)
}

/** 工作日记默认只看今天+昨天；更早用「本岗全部任务」进任务中心 */
const WORKLOG_RECENT2 = '__recent2__'

function recent2DayKeys() {
  return [localDayKeyOffset(0), localDayKeyOffset(1)]
}

function isWorklogRecent2(selectedDay) {
  const sel = String(selectedDay || '').trim()
  return !sel || sel === WORKLOG_RECENT2
}

function renderWorklogDayBar(initiatives, selectedDay = WORKLOG_RECENT2) {
  const days = availableDayKeys(initiatives)
  const today = localDayKeyOffset(0)
  const yesterday = localDayKeyOffset(1)
  const selRaw = String(selectedDay || '').trim()
  const recent2 = isWorklogRecent2(selRaw)
  const sel = recent2 ? WORKLOG_RECENT2 : selRaw
  const min = days.length ? days[days.length - 1] : ''
  const max = days.length ? days[0] : today
  const dateVal = sel && /^\d{4}-\d{2}-\d{2}$/.test(sel) ? sel : ''
  const chips = [
    { key: WORKLOG_RECENT2, label: '近2天' },
    { key: today, label: '今天' },
    { key: yesterday, label: '昨天' },
  ]
  return `
    <div class="pro-worklog-daybar" data-role="worklog-daybar">
      <div class="pro-worklog-daybar-left">
        <span class="pro-worklog-daybar-label">上班日期</span>
        <div class="pro-worklog-daychips" role="tablist" aria-label="快捷日期">
          ${chips
            .map(
              (c) => `
            <button type="button" class="pro-worklog-daychip${sel === c.key ? ' is-active' : ''}" data-act="worklog-day" data-day="${esc(c.key)}" role="tab" aria-selected="${sel === c.key ? 'true' : 'false'}">${esc(c.label)}</button>`,
            )
            .join('')}
        </div>
        <button type="button" class="btn btn-ghost btn-sm pro-worklog-all-link" data-act="open-tasks" title="更早记录请在任务中心筛选本岗">更早 → 任务中心</button>
      </div>
      <label class="pro-worklog-datepicker">
        <span>其它日期</span>
        <input type="date" data-act="worklog-date" value="${esc(dateVal)}"${min ? ` min="${esc(min)}"` : ''}${max ? ` max="${esc(max)}"` : ''} />
      </label>
    </div>`
}

function renderWorklogViewToggle(view = 'diary') {
  const v = view === 'list' ? 'list' : 'diary'
  return `
    <div class="pro-worklog-viewtabs" role="tablist" aria-label="工作记录视图">
      <button type="button" class="pro-worklog-viewtab${v === 'diary' ? ' is-active' : ''}" data-act="worklog-view" data-view="diary" role="tab" aria-selected="${v === 'diary' ? 'true' : 'false'}">时间线</button>
      <button type="button" class="pro-worklog-viewtab${v === 'list' ? ' is-active' : ''}" data-act="worklog-view" data-view="list" role="tab" aria-selected="${v === 'list' ? 'true' : 'false'}">任务列表</button>
    </div>`
}

function renderWorklogListStatusBar(listStatus = 'all') {
  const chips = [
    { key: 'all', label: '全部' },
    { key: 'active', label: '进行中' },
    { key: 'waiting', label: '待确认' },
    { key: 'done', label: '已完成' },
    { key: 'fail', label: '失败' },
  ]
  const sel = String(listStatus || 'all')
  return `
    <div class="pro-worklog-listbar" data-role="worklog-listbar">
      <div class="pro-worklog-daychips" role="tablist" aria-label="列表状态">
        ${chips
          .map(
            (c) => `
          <button type="button" class="pro-worklog-daychip${sel === c.key ? ' is-active' : ''}" data-act="worklog-list-status" data-status="${esc(c.key)}" role="tab" aria-selected="${sel === c.key ? 'true' : 'false'}">${esc(c.label)}</button>`,
          )
          .join('')}
      </div>
      <button type="button" class="btn btn-ghost btn-sm pro-worklog-all-link" data-act="open-tasks" title="更多历史与搜索请到任务中心">任务中心翻页 →</button>
    </div>`
}

function worklogListStatusMatch(init, listStatus) {
  const sel = String(listStatus || 'all')
  if (sel === 'all') return true
  const g = toTaskStatusGroup(init?.status)
  const key = normalizeTaskStatusKey(init?.status)
  if (sel === 'active') return g === 'executing' || g === 'planning' || key === 'pending' || key === 'idle'
  if (sel === 'waiting') {
    return key === 'req_confirm' || key === 'waiting_user' || key === 'reviewed' || g === 'paused'
  }
  if (sel === 'done') return g === 'completed'
  if (sel === 'fail') return g === 'failed'
  return true
}

function renderWorklogListTable(code, initiatives, listStatus = 'all') {
  const list = (Array.isArray(initiatives) ? initiatives : []).filter((i) =>
    worklogListStatusMatch(i, listStatus),
  )
  if (!list.length) {
    return `<div class="pro-empty">
      <p class="pro-empty-title">没有匹配的工作项</p>
      <p class="pro-empty-desc">换个状态筛选，或到任务中心查看更早记录（本页列表来自工作板最近条目）。</p>
    </div>`
  }
  const rows = [...list]
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    .map((init) => {
      const st = formatTaskStatusZh(init.status) || String(init.status || '—')
      const title = esc(init._display_title || init.title || init.id)
      const when = esc(fmtTime(init.updated_at || init.created_at))
      const src = esc(formatTaskSourceZh(init.source) || '')
      return `
        <button type="button" class="pro-worklog-listrow" data-open-work="${esc(init.id)}" data-code="${esc(code)}">
          <span class="pro-worklog-listrow-title">${title}</span>
          <span class="pro-worklog-listrow-meta">
            <span class="pro-meta-chip">${esc(st)}</span>
            ${src ? `<span class="pro-meta-chip">${src}</span>` : ''}
            <span class="pro-worklog-listrow-time">${when}</span>
          </span>
        </button>`
    })
    .join('')
  return `<div class="pro-worklog-listtable" data-role="worklog-listtable">${rows}</div>`
}

function renderEmployeeWorkBody(
  code,
  initiatives,
  {
    highlightRoundId = '',
    selectedDay = WORKLOG_RECENT2,
    view = 'diary',
    listStatus = 'all',
  } = {},
) {
  const list = Array.isArray(initiatives) ? initiatives : []
  const day = isWorklogRecent2(selectedDay) ? WORKLOG_RECENT2 : String(selectedDay || '').trim()
  const mode = view === 'list' ? 'list' : 'diary'
  const head = `
    <div class="pro-worklog-toolbar">
      ${renderWorklogViewToggle(mode)}
      ${
        mode === 'list'
          ? renderWorklogListStatusBar(listStatus)
          : renderWorklogDayBar(list, day)
      }
    </div>`
  if (mode === 'list') {
    return (
      head +
      `<div class="pro-worklog-list" data-role="worklog-list">${renderWorklogListTable(
        code,
        list,
        listStatus,
      )}</div>`
    )
  }
  return (
    head +
    `<div class="pro-worklog-list" data-role="worklog-list">${renderWorkRounds(code, list, {
      highlightRoundId,
      selectedDay: day,
    })}</div>`
  )
}

function renderWorkRounds(code, initiatives, opts = {}) {
  const highlightRoundId = typeof opts === 'string' ? opts : opts.highlightRoundId || ''
  const selectedDayRaw = typeof opts === 'string' ? '' : String(opts.selectedDay || '').trim()
  const recent2 = isWorklogRecent2(selectedDayRaw)
  const selectedDay = recent2 ? WORKLOG_RECENT2 : selectedDayRaw

  if (!initiatives.length) {
    return `<div class="pro-empty">
      <p class="pro-empty-title">还没有本岗工作项</p>
      <p class="pro-empty-desc">点右上角「现在开始工作」或派发任务后，这里默认展示近 2 天上班记录。更早记录用「本岗全部任务」在任务中心筛选。</p>
    </div>`
  }

  const rounds = groupByRound(initiatives)
  let days = groupRoundsByDay(rounds)
  if (recent2) {
    const allow = new Set(recent2DayKeys())
    days = days.filter((d) => allow.has(d.day_key))
    if (!days.length) {
      return `<div class="pro-empty">
        <p class="pro-empty-title">近 2 天暂无上班记录</p>
        <p class="pro-empty-desc">可换「今天 / 昨天 / 其它日期」，或点「本岗全部任务」在任务中心查看历史</p>
      </div>`
    }
  } else if (selectedDay) {
    days = days.filter((d) => d.day_key === selectedDay)
    if (!days.length) {
      return `<div class="pro-empty">
        <p class="pro-empty-title">${esc(dayLabelFromKey(selectedDay))}暂无上班记录</p>
        <p class="pro-empty-desc">换一天看看，或点「近2天」；更早请用「本岗全部任务」</p>
      </div>`
    }
  }
  return (
    '<div class="pro-worklog-rounds">' +
    days
      .map((day) => {
        const metaBits = [`${day.roundN} 次上班`]
        if (day.actionableN) metaBits.push(`${day.actionableN} 个工作项`)
        return `
        <section class="pro-worklog-day" data-day="${esc(day.day_key)}">
          <header class="pro-worklog-day-head">
            <h2 class="pro-worklog-day-title">${esc(day.label)}</h2>
            <span class="pro-worklog-day-meta">${esc(metaBits.join(' · '))}</span>
          </header>
          <div class="pro-worklog-day-rounds">
            ${day.rounds
              .map((round, idx) =>
                renderRoundSection(code, round, {
                  dayRoundIdx: idx,
                  dayRoundTotal: day.rounds.length,
                  highlightRoundId,
                }),
              )
              .join('')}
          </div>
        </section>`
      })
      .join('') +
    '</div>'
  )
}

function paintEmployeeWorkBody(page, role, initiatives, { highlightRoundId = '' } = {}) {
  const selectedDay = isWorklogRecent2(page._worklogDay)
    ? WORKLOG_RECENT2
    : String(page._worklogDay || WORKLOG_RECENT2).trim()
  page._worklogDay = selectedDay
  if (page._worklogView !== 'list') page._worklogView = 'diary'
  if (!page._worklogListStatus) page._worklogListStatus = 'all'

  const roundsHost = page.querySelector('[data-work-host="rounds"]') || page.querySelector('#pro-employee-body')
  if (!roundsHost) return
  roundsHost.innerHTML = renderEmployeeWorkBody(role.agent_code, initiatives, {
    highlightRoundId,
    selectedDay,
    view: page._worklogView === 'list' ? 'list' : 'diary',
    listStatus: page._worklogListStatus,
  })
  bindOpenItems(roundsHost)
  bindRoundTrails(page, role)
  bindWorklogDayBar(page, role)
  bindWorklogViewControls(page, role)
}

function setEmployeeTab(page, role, tabKey) {
  let key = String(tabKey || 'rounds')
  // 旧 Tab 名兼容
  if (key === 'overview' || key === 'tasks') key = 'rounds'
  if (!['rounds', 'growth', 'metrics', 'config'].includes(key)) key = 'rounds'
  page._employeeTab = key
  page.querySelectorAll('[data-act="employee-tab"]').forEach((btn) => {
    const on = btn.getAttribute('data-tab') === key
    btn.classList.toggle('is-active', on)
    btn.setAttribute('aria-selected', on ? 'true' : 'false')
  })
  page.querySelectorAll('[data-panel]').forEach((panel) => {
    const on = panel.getAttribute('data-panel') === key
    panel.classList.toggle('is-active', on)
    panel.hidden = !on
  })
  if (key === 'rounds') {
    paintEmployeeWorkBody(page, role, page._initiatives || [])
  }
  if (key === 'growth') {
    void loadEmployeeGrowthPanel(page, role)
  }
}

function renderGrowthPanelHtml(data) {
  const identity = String(data?.identity_md || '').trim()
  const lessons = String(data?.lessons || '').trim()
  const changelog = Array.isArray(data?.changelog) ? data.changelog : []
  // person_memory kept on API for back-compat; UI uses timeline / semantic_self views
  const proposals = Array.isArray(data?.proposals) ? data.proposals : []
  const drafts = proposals.filter((p) => String(p.status || '') === 'draft')
  const relations = Array.isArray(data?.relations) ? data.relations : []
  const opens = Array.isArray(data?.open_commitments) ? data.open_commitments : []
  const openCount = Number(data?.open_commitment_count || opens.length || 0)
  const craft = Array.isArray(data?.craft) ? data.craft : []
  const craftGrad = Number(data?.craft_graduated_count || 0)
  const craftProp = Number(data?.craft_proposed_count || 0)
  const aff = data?.affect && typeof data.affect === 'object' ? data.affect : {}
  const poi = Number(data?.poignancy)
  const poiShow = Number.isFinite(poi) ? poi.toFixed(2) : '0.00'
  const refTheme = String(data?.last_reflection_theme || '').trim()
  const refAt = String(data?.last_reflection_at || '')
    .slice(0, 19)
    .replace('T', ' ')
  const wrap = data?.latest_wrap_up && typeof data.latest_wrap_up === 'object' ? data.latest_wrap_up : null
  const wrapJournal = String(wrap?.journal || '').trim()
  const wrapMood = String(wrap?.mood || '').trim()
  const wrapArc = String(wrap?.arc_label || '').trim()
  const wrapState = String(wrap?.state_summary || '').trim()
  const wrapUnresolved = Array.isArray(wrap?.unresolved) ? wrap.unresolved.filter(Boolean) : []
  const wrapInsights = Array.isArray(wrap?.insights) ? wrap.insights : []
  const wrapAt = String(wrap?.created_at || '')
    .slice(0, 19)
    .replace('T', ' ')
  const wrapPoi = wrap?.poignancy != null && Number.isFinite(Number(wrap.poignancy))
    ? String(wrap.poignancy)
    : ''
  const timeline = Array.isArray(data?.timeline) ? data.timeline : []
  const semanticSelf = Array.isArray(data?.semantic_self) ? data.semantic_self : []
  const overviewData = data?.overview && typeof data.overview === 'object' ? data.overview : {}
  const journalCount = Number(overviewData.journal_count || timeline.length || 0)
  const semanticCount = Number(overviewData.semantic_count || semanticSelf.length || 0)

  const memorySourceLabel = (src) => {
    const s = String(src || '').toLowerCase()
    if (s.includes('state_summary')) return '站立摘要'
    if (s.includes('insight')) return '洞察'
    if (s.includes('llm')) return '模型复盘'
    if (s.startsWith('duty') || s === 'wrap_up') return '收工'
    if (s.includes('reflection')) return '反思'
    return String(src || '记忆').slice(0, 16)
  }

  const axis = (k, label) => {
    const v = Number(aff[k])
    const show = Number.isFinite(v) ? v.toFixed(2) : '—'
    return `<span class="pro-growth-chip">${esc(label)} <b>${esc(show)}</b></span>`
  }

  const section = (title, body, extraHead = '') => `
    <section class="pro-growth-section">
      <div class="pro-growth-section-head">
        <h3>${esc(title)}</h3>
        ${extraHead}
      </div>
      <div class="pro-growth-section-body">${body}</div>
    </section>`

  const empty = (text) => `<p class="pro-growth-empty">${esc(text)}</p>`

  const listHtml = (rows, mapFn) =>
    rows.length
      ? `<ul class="pro-growth-log">${rows.map(mapFn).join('')}</ul>`
      : ''

  // —— 概览 ——
  const overview = `
    <div class="pro-growth-overview">
      <div class="pro-growth-overview-main">
        ${wrapJournal ? `<span class="pro-growth-pill is-on">最近模型复盘</span>` : `<span class="pro-growth-pill">尚无复盘</span>`}
        ${wrapMood ? `<span class="pro-growth-pill is-on">${esc(wrapMood)}</span>` : ''}
        ${wrapArc ? `<span class="pro-growth-pill">${esc(wrapArc)}</span>` : ''}
        <span class="pro-growth-pill">反思积压 ${esc(poiShow)}/1</span>
        <span class="pro-growth-pill">承诺 ${esc(String(openCount))}</span>
        <span class="pro-growth-pill">专长 ${esc(String(craftGrad || craft.length))}</span>
        <span class="pro-growth-pill">日记 ${esc(String(journalCount))}</span>
        ${drafts.length ? `<span class="pro-growth-pill is-warn">待批 ${esc(String(drafts.length))}</span>` : ''}
      </div>
    </div>
    <div class="pro-growth-affect-row" title="职场情绪态（收工模型可微调）">
      ${axis('curiosity', '好奇')}
      ${axis('confidence', '把握')}
      ${axis('pressure', '压力')}
      ${axis('connection', '连结')}
      ${axis('frustration', '受挫')}
      ${axis('energy', '精力')}
    </div>`

  // —— 最近 LLM 收工（主区块） ——
  let wrapBody
  if (wrapJournal || wrapState) {
    const metaLine = [
      wrapAt ? `时间 ${wrapAt}` : '',
      wrapPoi ? `重要度 ${wrapPoi}/10` : '',
      wrap?.source ? `来源 ${memorySourceLabel(wrap.source)}` : '',
      wrap?.round_id ? `轮次 ${String(wrap.round_id).slice(0, 36)}` : '',
    ]
      .filter(Boolean)
      .join(' · ')
    wrapBody =
      (metaLine ? `<p class="pro-growth-inline pro-muted">${esc(metaLine)}</p>` : '') +
      (wrapJournal
        ? `<div class="pro-growth-block"><div class="pro-growth-label">心智日记</div><pre class="pro-growth-pre pro-growth-pre-lg">${esc(wrapJournal)}</pre></div>`
        : '') +
      (wrapState
        ? `<div class="pro-growth-block"><div class="pro-growth-label">明日站立摘要（core）</div><pre class="pro-growth-pre">${esc(wrapState)}</pre></div>`
        : '') +
      (wrapInsights.length
        ? `<div class="pro-growth-block"><div class="pro-growth-label">洞察</div>${listHtml(
            wrapInsights,
            (row) => `<li>${esc(String(row.text || '').slice(0, 320))}</li>`,
          )}</div>`
        : '') +
      (wrapUnresolved.length
        ? `<div class="pro-growth-block"><div class="pro-growth-label">未闭合</div><ul class="pro-growth-log">${wrapUnresolved
            .map((u) => `<li>${esc(String(u).slice(0, 160))}</li>`)
            .join('')}</ul></div>`
        : '')
  } else {
    wrapBody = empty('还没有模型收工复盘。跑完有实质工作的值班后，会在这里出现第一人称日记与站立摘要。')
  }

  // —— 反思积压（有内容才展示） ——
  const metaBits = []
  if (refTheme || Number(poi) > 0) {
    metaBits.push(
      `<div class="pro-growth-block"><div class="pro-growth-label">重要度反思</div>` +
        `<p class="pro-growth-inline">积压 ${esc(poiShow)}/1.00` +
        (refTheme ? ` · 主题「${esc(refTheme)}」` : '') +
        (refAt ? ` · ${esc(refAt)}` : '') +
        `</p></div>`,
    )
  }
  const metaBody = metaBits.length ? metaBits.join('') : ''

  // —— 身份 + Lessons 合并 ——
  const idBody = identity
    ? `<pre class="pro-growth-pre">${esc(identity)}</pre>`
    : empty('尚未拆出 L0。在 SOUL 写 Identity 段后会自动提取。')
  const lessonsBody = lessons
    ? `<pre class="pro-growth-pre">${esc(lessons)}</pre>`
    : empty('值班收工由模型写入可执行教训。')
  const personaBody = `
    <div class="pro-growth-split">
      <div><div class="pro-growth-label">身份本性 L0</div>${idBody}</div>
      <div><div class="pro-growth-label">Lessons</div>${lessonsBody}</div>
    </div>`

  // —— 本事 / 时间线 / 语义（§13.1） ——
  const craftBody = craft.length
    ? listHtml(craft, (row) => {
        const title = esc(String(row.title || row.kind || 'craft'))
        const st = esc(String(row.status || ''))
        const kind = esc(String(row.kind || ''))
        const hits = esc(String(row.hit_count ?? 0))
        const skill = esc(String(row.skill_name || ''))
        const content = esc(String(row.content || '').slice(0, 280))
        const at = esc(String(row.created_at || '').slice(0, 19).replace('T', ' '))
        const src = esc(memorySourceLabel(row.source))
        const skillBit = skill ? ` · <code>${skill}</code>` : ''
        return `<li><div class="pro-growth-log-meta"><strong>${title}</strong> · ${kind}/${st} · ${src} · hits ${hits}${skillBit} · ${at}</div><div>${content}</div></li>`
      }) +
      `<p class="pro-muted pro-growth-foot">已巩固 ${esc(String(craftGrad))} · 草案 ${esc(String(craftProp))}</p>`
    : ''

  const groupByDay = (rows) => {
    /** @type {Map<string, any[]>} */
    const map = new Map()
    for (const row of rows) {
      const day = String(row.created_at || row.updated_at || '').slice(0, 10) || '未知日期'
      if (!map.has(day)) map.set(day, [])
      map.get(day).push(row)
    }
    return [...map.entries()].sort((a, b) => String(b[0]).localeCompare(String(a[0])))
  }

  const timelineBody = timeline.length
    ? groupByDay(timeline)
        .map(([day, rows]) => {
          const items = listHtml(rows, (row) => {
            const at = esc(String(row.created_at || '').slice(0, 19).replace('T', ' '))
            const layer = esc(String(row.layer || 'journal'))
            const src = esc(memorySourceLabel(row.source))
            const pin = row.pin ? '★ ' : ''
            const content = esc(String(row.content || '').slice(0, 400))
            return `<li><div class="pro-growth-log-meta">${pin}<strong>${layer}</strong> · ${src} · ${at}</div><div>${content}</div></li>`
          })
          return `<div class="pro-growth-day"><div class="pro-growth-label">${esc(day)}</div>${items}</div>`
        })
        .join('') + `<p class="pro-muted pro-growth-foot">情景/日记 ${esc(String(journalCount))} 条 · 只读</p>`
    : empty('还没有情景日记。值班收工或任务完成后会出现在时间线。')

  const semanticBody = semanticSelf.length
    ? listHtml(semanticSelf, (row) => {
        const at = esc(String(row.created_at || '').slice(0, 19).replace('T', ' '))
        const content = esc(String(row.content || '').slice(0, 400))
        const src = esc(memorySourceLabel(row.source))
        return `<li><div class="pro-growth-log-meta"><strong>semantic</strong> · ${src} · ${at}</div><div>${content}</div></li>`
      }) + `<p class="pro-muted pro-growth-foot">共 ${esc(String(semanticCount))} 条</p>`
    : empty('暂无自我语义记忆。')

  const memoryCraftSection = `
    <div class="pro-growth-view-tabs" role="tablist" data-role="growth-view-tabs">
      <button type="button" class="pro-growth-view-tab is-active" data-growth-view="timeline">时间线</button>
      <button type="button" class="pro-growth-view-tab" data-growth-view="craft">专长</button>
      <button type="button" class="pro-growth-view-tab" data-growth-view="semantic">语义</button>
      <button type="button" class="pro-growth-view-tab" data-growth-view="identity">身份</button>
    </div>
    <div class="pro-growth-view-panel" data-growth-panel="timeline">${section('时间线（person 情景）', timelineBody)}</div>
    <div class="pro-growth-view-panel" data-growth-panel="craft" hidden>${section('专长', craftBody || empty('暂无专长卡（收工后积累）'))}</div>
    <div class="pro-growth-view-panel" data-growth-panel="semantic" hidden>${section('自我语义', semanticBody)}</div>
    <div class="pro-growth-view-panel" data-growth-panel="identity" hidden>${section('人格（只读）', personaBody)}</div>
    <p class="pro-muted pro-growth-foot">用户偏好请到「记忆」页查看；本页仅员工自传命名空间。</p>
  `

  // —— 协作 ——
  const opensBody = opens.length
    ? listHtml(opens, (row) => {
        const fr = esc(String(row.from_agent || ''))
        const kind = esc(String(row.kind || 'handoff'))
        const child = esc(String(row.child_task_id || '').slice(0, 24))
        const at = esc(String(row.created_at || '').slice(0, 19).replace('T', ' '))
        const note = esc(String(row.note || '').slice(0, 160))
        return `<li><div class="pro-growth-log-meta"><strong>欠 ${fr}</strong> · ${kind}${child ? ` · ${child}` : ''} · ${at}</div><div class="pro-muted">${note}</div></li>`
      })
    : ''
  const relBody = relations.length
    ? listHtml(relations, (row) => {
        const peer = esc(String(row.peer_code || ''))
        const bond = Number(row.bond)
        const bondShow = Number.isFinite(bond) ? bond.toFixed(2) : '—'
        const ev = esc(String(row.last_event || '').slice(0, 40))
        const at = esc(String(row.updated_at || '').slice(0, 19).replace('T', ' '))
        return `<li><div class="pro-growth-log-meta"><strong>${peer}</strong> · bond ${esc(bondShow)} · ${at}</div><div class="pro-muted">${ev}</div></li>`
      })
    : ''
  const collabSection =
    opensBody || relBody
      ? section(
          '协作',
          `${opensBody ? `<div class="pro-growth-block"><div class="pro-growth-label">开放承诺</div>${opensBody}</div>` : empty('无开放承诺')}` +
            `${relBody ? `<div class="pro-growth-block"><div class="pro-growth-label">关系边</div>${relBody}</div>` : empty('暂无关系边')}`,
        )
      : ''

  // —— 提案 / changelog ——
  const proposalsBody = proposals.length
    ? listHtml(proposals, (row) => {
        const id = esc(String(row.id || ''))
        const st = esc(String(row.status || ''))
        const title = esc(String(row.title || ''))
        const rationale = esc(String(row.rationale || '').slice(0, 280))
        const at = esc(String(row.created_at || '').slice(0, 19).replace('T', ' '))
        const actions =
          st === 'draft'
            ? `<div class="pro-growth-actions">
                <button type="button" class="btn btn-sm btn-outline" data-act="proposal-approve" data-proposal-id="${id}">批准</button>
                <button type="button" class="btn btn-sm btn-ghost" data-act="proposal-reject" data-proposal-id="${id}">拒绝</button>
              </div>`
            : `<div class="pro-muted">已${st === 'approved' ? '批准' : '拒绝'}</div>`
        return `<li><div class="pro-growth-log-meta"><strong>${title || id}</strong> · ${st} · ${at}</div><div>${rationale}</div>${actions}</li>`
      })
    : ''
  const logBody = changelog.length
    ? listHtml(changelog, (row) => {
        const at = esc(String(row.created_at || '').slice(0, 19).replace('T', ' '))
        const field = esc(String(row.field || ''))
        const reason = esc(String(row.reason || ''))
        const neu = esc(String(row.new_value || '').slice(0, 240))
        const src = esc(memorySourceLabel(row.source))
        return `<li><div class="pro-growth-log-meta"><strong>${field}</strong> · ${src} · ${at}</div><div class="pro-muted">${reason}</div><div>${neu}</div></li>`
      })
    : ''

  const auditSections =
    (proposalsBody ? section('进化提案', proposalsBody) : '') +
    (logBody ? section('成长变更', logBody) : '')

  return `
    <div class="pro-growth-layout">
      <style>
        .pro-growth-layout{display:flex;flex-direction:column;gap:14px;padding:4px 0 28px}
        .pro-growth-overview{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
        .pro-growth-overview-main{display:flex;flex-wrap:wrap;gap:6px}
        .pro-growth-pill{font-size:12px;padding:4px 8px;border:1px solid color-mix(in srgb, currentColor 18%, transparent);border-radius:6px;opacity:.75}
        .pro-growth-pill.is-on{opacity:1;border-color:color-mix(in srgb, currentColor 35%, transparent)}
        .pro-growth-pill.is-warn{opacity:1}
        .pro-growth-affect-row{display:flex;flex-wrap:wrap;gap:8px;font-size:12px;opacity:.65}
        .pro-growth-chip{padding:2px 0}
        .pro-growth-chip b{font-weight:600}
        .pro-growth-section{padding:12px 0;border-top:1px solid color-mix(in srgb, currentColor 12%, transparent)}
        .pro-growth-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
        .pro-growth-section-head h3{margin:0;font-size:14px;font-weight:600}
        .pro-growth-label{font-size:12px;opacity:.65;margin:0 0 6px}
        .pro-growth-block + .pro-growth-block{margin-top:12px}
        .pro-growth-empty{margin:0;font-size:13px;opacity:.55}
        .pro-growth-inline{margin:0 0 8px;font-size:13px}
        .pro-growth-split{display:grid;grid-template-columns:1fr 1fr;gap:14px}
        @media (max-width:800px){.pro-growth-split{grid-template-columns:1fr}}
        .pro-growth-foot{margin:8px 0 0}
        .pro-growth-actions{margin-top:8px;display:flex;gap:8px}
        .pro-growth-pre{margin:0;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.5;max-height:220px;overflow:auto}
        .pro-growth-pre-lg{max-height:320px;font-size:13px;line-height:1.55}
        .pro-growth-log{margin:0;padding-left:1.1em;font-size:13px;line-height:1.45}
        .pro-growth-log li{margin:0 0 10px}
        .pro-growth-log-meta{font-size:12px;opacity:.7;margin-bottom:2px}
        .pro-growth-featured{padding:12px 14px;border:1px solid color-mix(in srgb, currentColor 16%, transparent);border-radius:8px;background:color-mix(in srgb, currentColor 4%, transparent)}
        .pro-growth-view-tabs{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 8px}
        .pro-growth-view-tab{font-size:12px;padding:4px 10px;border:1px solid color-mix(in srgb, currentColor 18%, transparent);border-radius:6px;background:transparent;cursor:pointer;opacity:.7}
        .pro-growth-view-tab.is-active{opacity:1;border-color:color-mix(in srgb, currentColor 40%, transparent)}
        .pro-growth-day{margin:0 0 12px}
        .pro-growth-day .pro-growth-label{font-weight:600;opacity:.85}
      </style>
      ${overview}
      <section class="pro-growth-featured">
        <div class="pro-growth-section-head"><h3>最近收工复盘</h3></div>
        <div class="pro-growth-section-body">${wrapBody}</div>
      </section>
      ${metaBody ? section('反思积压', metaBody) : ''}
      ${memoryCraftSection}
      ${collabSection}
      ${auditSections}
    </div>
  `
}

async function loadEmployeeGrowthPanel(page, role) {
  const host = page.querySelector('[data-role="growth-host"]')
  if (!host) return
  const code = String(role?.agent_code || '')
  host.innerHTML = `<div class="pro-muted" style="padding:16px">加载成长记录…</div>`
  try {
    const data = await api.proactiveRoleGrowth(code, 40)
    host.innerHTML = renderGrowthPanelHtml(data || {})
    const tabs = host.querySelector('[data-role="growth-view-tabs"]')
    if (tabs && tabs.dataset.bound !== '1') {
      tabs.dataset.bound = '1'
      tabs.addEventListener('click', (ev) => {
        const btn = ev.target instanceof Element ? ev.target.closest('[data-growth-view]') : null
        if (!btn) return
        const view = btn.getAttribute('data-growth-view') || 'timeline'
        host.querySelectorAll('[data-growth-view]').forEach((b) => b.classList.toggle('is-active', b === btn))
        host.querySelectorAll('[data-growth-panel]').forEach((p) => {
          p.hidden = p.getAttribute('data-growth-panel') !== view
        })
      })
    }
    if (host.dataset.growthBound !== '1') {
      host.dataset.growthBound = '1'
      host.addEventListener('click', async (e) => {
        const t = e.target
        if (!(t instanceof Element)) return
        const approveBtn = t.closest('[data-act="proposal-approve"]')
        if (approveBtn && host.contains(approveBtn)) {
          const pid = approveBtn.getAttribute('data-proposal-id') || ''
          try {
            await api.proactiveRoleProposalApprove(code, pid)
            toast('已批准提案', 'success')
            await loadEmployeeGrowthPanel(page, role)
          } catch (err) {
            toast(`批准失败：${String(err?.message || err)}`, 'error')
          }
          return
        }
        const rejectBtn = t.closest('[data-act="proposal-reject"]')
        if (rejectBtn && host.contains(rejectBtn)) {
          const pid = rejectBtn.getAttribute('data-proposal-id') || ''
          try {
            await api.proactiveRoleProposalReject(code, pid)
            toast('已拒绝提案', 'success')
            await loadEmployeeGrowthPanel(page, role)
          } catch (err) {
            toast(`拒绝失败：${String(err?.message || err)}`, 'error')
          }
        }
      })
    }
  } catch (err) {
    host.innerHTML = `<div class="pro-muted" style="padding:16px;color:var(--danger,#c44)">加载失败：${esc(String(err?.message || err))}</div>`
  }
}

function bindWorklogViewControls(page, role) {
  const hosts = [
    page.querySelector('#pro-employee-body'),
    page.querySelector('[data-work-host="rounds"]'),
  ].filter(Boolean)
  const uniq = [...new Set(hosts)]
  for (const host of uniq) {
    if (host.dataset.viewBound === '1') continue
    host.dataset.viewBound = '1'
    host.addEventListener('click', (e) => {
      const t = e.target
      if (!(t instanceof Element)) return
      const viewBtn = t.closest('[data-act="worklog-view"]')
      if (viewBtn && host.contains(viewBtn)) {
        page._worklogView = viewBtn.getAttribute('data-view') === 'list' ? 'list' : 'diary'
        paintEmployeeWorkBody(page, role, page._initiatives || [])
        return
      }
      const stBtn = t.closest('[data-act="worklog-list-status"]')
      if (stBtn && host.contains(stBtn)) {
        page._worklogListStatus = stBtn.getAttribute('data-status') || 'all'
        paintEmployeeWorkBody(page, role, page._initiatives || [])
      }
    })
  }
}

function bindWorklogDayBar(page, role) {
  const bar = page.querySelector('[data-role="worklog-daybar"]')
  if (!bar || bar.dataset.bound === '1') return
  bar.dataset.bound = '1'

  const applyDay = (day) => {
    const next = String(day || '').trim()
    page._worklogDay = next || WORKLOG_RECENT2
    paintEmployeeWorkBody(page, role, page._initiatives || [])
  }

  bar.addEventListener('click', (e) => {
    const t = e.target
    if (!(t instanceof Element)) return
    const chip = t.closest('[data-act="worklog-day"]')
    if (!chip) return
    applyDay(chip.getAttribute('data-day') || '')
  })

  const dateInput = bar.querySelector('[data-act="worklog-date"]')
  dateInput?.addEventListener('change', () => {
    const v = String(dateInput.value || '').trim()
    applyDay(v)
  })
}

function renderItemCard(code, init, { highlight = false, legacy = false } = {}) {
  const isTask = Boolean(init._is_task) || String(init?.action_plan?.kind || '') === 'task_board'
  const roundLog = !isTask && isRoundLog(init)
  const badge = isTask
    ? STATUS_BADGE[init.status] || {
        label: formatTaskStatusZh(init.status) || init.status || '—',
        cls: 'pro-badge--muted',
      }
    : roundLog
      ? journalStatusBadge(init)
      : STATUS_BADGE[init.status] || { label: init.status, cls: 'pro-badge--muted' }
  const result = initiativeResult(init)
  const risk = RISK_BADGE[init.risk_level] || { label: init.risk_level || '—', cls: 'pro-risk--low' }
  const phase = roundLog ? journalPhase(init) : ''
  const phaseLabel = phase ? JOURNAL_PHASE_LABEL[phase] || phase : ''
  const typeLabel = isTask
    ? formatTaskSourceZh(init.source) || ACTION_TYPE_LABEL[init.action_type] || '岗位工作项'
    : roundLog
      ? phaseLabel || '工作记录'
      : ACTION_TYPE_LABEL[init.action_type] || init.action_type || ''
  const trailPreview = !roundLog && !isTask ? latestProgressPreview(init.execution_result) : ''
  const trailCount = !roundLog && !isTask ? parseProgressTrail(init.execution_result).length : 0
  const title = isTask
    ? String(init._display_title || humanizeWorkTitle(init.title || init._raw_title, init.description) || '').trim()
    : String(init.title || '').trim()
  const desc = isTask
    ? humanizeWorkDesc({ ...init, _display_title: title })
    : trailPreview || previewLine(init.description || init.outcome || init.execution_result || '')
  const titlePrefix = legacy && !roundLog && !isTask ? '遗留事项 · ' : ''
  const openAttr = isTask
    ? `data-open-work="${esc(init.id)}"`
    : `data-open-item="${esc(init.id)}"`
  const moreLabel = isTask ? '打开工作项 →' : '查看详情 →'
  const prog =
    isTask && Number(init.progress) > 0
      ? `<span class="pro-meta-chip" title="进度">${esc(String(init.progress))}%</span>`
      : ''
  return `
    <button type="button" class="pro-item-card${result === 'failure' || isIncompleteJournal(init) ? ' pro-item-card--fail' : ''}${roundLog ? ' pro-item-card--journal' : ''}${highlight ? ' pro-item-card--new' : ''}" ${openAttr} data-code="${esc(code)}">
      <div class="pro-item-card-top">
        <span class="pro-item-card-title">${esc(titlePrefix + title)}</span>
        <span class="pro-badge ${badge.cls}">${esc(badge.label)}</span>
      </div>
      ${desc ? `<p class="pro-item-card-desc">${esc(desc)}</p>` : ''}
      <div class="pro-item-card-meta">
        ${typeLabel ? `<span class="pro-meta-chip">${esc(typeLabel)}</span>` : ''}
        ${prog}
        ${trailCount ? `<span class="pro-meta-chip pro-meta-chip--progress">${trailCount} 次进度</span>` : ''}
        ${roundLog ? '' : `<span class="pro-risk ${risk.cls}">${risk.label}</span>`}
        <span>${fmtTime(init.updated_at || init.created_at)}</span>
        <span class="pro-item-card-more">${moreLabel}</span>
      </div>
    </button>`
}

function initiativeResult(init) {
  if (init.result === 'success' || init.result === 'failure') return init.result
  if (init.status === 'completed') return 'success'
  if (init.status === 'failed') return 'failure'
  return null
}

function bindOpenItems(root) {
  root.querySelectorAll('[data-open-work]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.openWork
      const code = el.dataset.code
      navigate(`/proactive/${encodeURIComponent(code)}/work/${encodeURIComponent(id)}`)
    })
  })
  root.querySelectorAll('[data-open-item]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.openItem
      const code = el.dataset.code
      navigate(`/proactive/${encodeURIComponent(code)}/item/${encodeURIComponent(id)}`)
    })
  })
}

function bindRoundTrails(page, role) {
  page.querySelectorAll('[data-act="open-round-trail"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const roundId = String(btn.dataset.roundId || '').trim()
      const at = String(btn.dataset.roundAt || '').trim()
      if (!roundId) return
      ensureEmployeeLiveProcess(page, role, {
        busy: false,
        roundId,
        at: at || roundId,
        title: trailTitle(at || roundId, { busy: false }),
      })
      toast('已打开本轮工作过程', 'info')
    })
  })
}

function isBusyPatrolError(err) {
  const msg = String(err?.message || err?.detail || err || '')
  const status = Number(err?.status || err?.statusCode || 0)
  return status === 409 || /already running|正在巡检|正在工作|busy|执行任务/i.test(msg)
}

async function refreshEmployeeWorkLog(page, role, highlightRoundId = '') {
  const boardRes = await api.proactiveRoleWorkBoard(role.agent_code, 100).catch(() => null)
  let tasks
  let initiatives
  if (boardRes && (boardRes.rounds || boardRes.tasks || boardRes.initiatives)) {
    tasks = normalizeWorkBoardTasks(boardRes.tasks || [], role.role_name)
    initiatives = tasksAsWorklogItems(tasks)
  } else {
    const tasksRes = await api.listAllTasks().catch(() => null)
    tasks = tasksFromListResponse(tasksRes)
    initiatives = tasksAsWorklogItems(tasks)
  }
  page._tasks = tasks
  page._initiatives = initiatives
  paintEmployeeWorkBody(page, role, initiatives, { highlightRoundId: highlightRoundId || '' })
  let busy = false
  try {
    const st = await api.proactiveRoleBusy(role.agent_code)
    busy = !!st?.busy
  } catch {
    // keep busy = false on error
  }
  patchRoleProfile(page, role, initiatives, { busy })
  return { initiatives, tasks, busy }
}

/**
 * After chat/roster dispatch: open live trail and poll until the duty round ends.
 * Does NOT start a new heartbeat (unlike ?patrol=1).
 */
async function watchDispatchedRound(page, role, opts = {}) {
  const goal = String(opts.goal || '').trim()
  const conflict = !!opts.conflict
  const slot = page.querySelector('#pro-patrol-slot')
  if (slot) {
    slot.innerHTML = renderDispatchWatching(role, { goal, conflict })
    slot.querySelector('[data-act="open-live"]')?.addEventListener('click', () => {
      page._liveTrailDismissed = false
      void onWatchLiveClick(page, role)
    })
    slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  const statusEl = page.querySelector('[data-role-status]')
  if (statusEl) {
    statusEl.className = 'pro-badge pro-badge--run'
    statusEl.textContent = '工作中'
  }

  /** Open once (or after user explicitly re-opens). Never force-reopen after dismiss. */
  const openTrail = async (busyFlag, roundId) => {
    const rid = String(roundId || '').trim()
    const latest = latestRoundFromInitiatives(page._initiatives || [])
    const useRound = rid || String(latest?.round_id || '').trim()
    page._liveTrailDismissed = false
    ensureEmployeeLiveProcess(page, role, {
      busy: !!busyFlag,
      roundId: useRound || undefined,
      at: latest?.at || useRound,
      title: trailTitle(latest?.at || useRound, { busy: !!busyFlag }),
    })
  }

  /** Poll tick: refresh open drawer only — do not yank it back open if user closed it. */
  const syncOpenTrail = (busyFlag, roundId) => {
    if (!page._liveProcess?.isOpen?.()) return
    const rid = String(roundId || '').trim()
    const latest = latestRoundFromInitiatives(page._initiatives || [])
    const useRound = rid || String(latest?.round_id || '').trim()
    if (page._liveProcess?.update) {
      page._liveProcess.update({
        busy: !!busyFlag,
        roundId: useRound || undefined,
        title: trailTitle(latest?.at || useRound, { busy: !!busyFlag }),
      })
    } else {
      page._liveProcess?.setBusy?.(!!busyFlag)
    }
  }

  let sawBusy = !!opts.initialBusy
  let lastRoundId = String(opts.initialRoundId || '').trim()
  await openTrail(sawBusy, lastRoundId)

  const tipStop = startPatrolStepTips(slot)
  const startedAt = Date.now()
  const maxMs = 12 * 60 * 1000

  const tick = async () => {
    if (!page.isConnected) {
      tipStop()
      return true
    }
    try {
      const busyRes = await api.proactiveRoleBusy(role.agent_code).catch(() => ({ busy: false }))
      const busy = !!busyRes?.busy
      const roundId = String(busyRes?.current_round_id || '').trim()
      if (roundId) lastRoundId = roundId
      if (busy) sawBusy = true

      const { initiatives } = await refreshEmployeeWorkLog(page, role, lastRoundId)
      if (!lastRoundId) {
        const latest = latestRoundFromInitiatives(initiatives)
        lastRoundId = String(latest?.round_id || '').trim()
      }
      syncOpenTrail(busy, lastRoundId)

      const stepEl = slot?.querySelector('[data-patrol-step]')
      if (stepEl) {
        stepEl.textContent = busy
          ? '正在处理派发任务…'
          : sawBusy
            ? '本轮已结束，正在整理小结…'
            : '等待员工开始工作…'
      }

      // Done: was busy (or reserved) and now idle, or timed out with a new round.
      if (sawBusy && !busy) {
        tipStop()
        destroyEmployeeLiveMount(page)
        if (slot) {
          const rounds = groupByRound(initiatives || [])
          const round = rounds.find((r) => String(r.round_id || '') === lastRoundId) || rounds[0]
          const fakeReport = {
            agent_code: role.agent_code,
            goal: round?.goal || goal,
            outcome: round?.outcome || '',
            reflection: round?.reflection || '',
            scorecard: round
              ? {
                  verdict: round.verdict,
                  verdict_label: round.verdict_label,
                  incomplete: round.incomplete,
                  goal: round.goal,
                  outcome: round.outcome,
                  reflection: round.reflection,
                  actionable: round.actionableN,
                  pending_approval: round.pendingN,
                  failed: round.failedN,
                  completed: round.completedN,
                }
              : null,
            counts: {
              total: (round?.items || []).length,
              journal: (round?.items || []).filter((i) => isRoundLog(i)).length,
              pending_approval: round?.pendingN || 0,
              completed: round?.completedN || 0,
              failed: round?.failedN || 0,
            },
            items: (round?.items || []).map((i) => ({
              id: i.id,
              title: i.title,
              status: i.status,
              is_journal: isRoundLog(i),
              action_plan: i.action_plan,
            })),
            last_heartbeat_at: role.last_heartbeat_at,
            next_heartbeat_at: role.next_heartbeat_at,
            workspace_path: workspaceOf(role),
          }
          slot.innerHTML = renderPatrolDone(fakeReport)
          bindOpenItems(slot)
        }
        if (statusEl) {
          const badge = roleStatusBadge(role, false)
          statusEl.className = `pro-badge ${badge.cls}`
          statusEl.textContent = badge.label
          if (badge.tip) statusEl.title = badge.tip
          else statusEl.removeAttribute('title')
        }
        toast(
          conflict ? '当前任务已结束，可查看本轮工作汇报与看板' : '派发任务已处理完毕',
          'success',
        )
        const roundEl = page.querySelector('[data-patrol-round]')
        roundEl?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        return true
      }

      if (Date.now() - startedAt > maxMs) {
        tipStop()
        toast('仍在执行中，可继续在工作过程查看', 'info')
        return true
      }
    } catch (e) {
      console.warn('[proactive] watchDispatchedRound tick failed', e)
    }
    return false
  }

  page._dispatchWatchTimer = window.setInterval(() => {
    void tick().then((done) => {
      if (done && page._dispatchWatchTimer) {
        window.clearInterval(page._dispatchWatchTimer)
        page._dispatchWatchTimer = null
      }
    })
  }, 2500)
  void tick()
}

async function runPatrol(page, role, { focus = '' } = {}) {
  if (page.dataset.patrolling === '1') {
    toast('本页已有一轮工作在进行', 'info')
    return
  }

  try {
    const busyRes = await api.proactiveRoleBusy(role.agent_code)
    if (busyRes?.busy) {
      toast('该员工已有一轮工作在进行，请稍候再点', 'warning')
      return
    }
  } catch {
    /* backend may be old; heartbeat 409 is the hard stop */
  }

  stopPageWatch(page)
  page.dataset.patrolling = '1'
  const btn = page.querySelector('[data-act="heartbeat"]')
  const slot = page.querySelector('#pro-patrol-slot')
  if (btn) {
    btn.disabled = true
    btn.textContent = '工作中…'
  }

  const openBusyTrail = async () => {
    let roundId = ''
    let at = ''
    try {
      const st = await api.proactiveRoleBusy(role.agent_code)
      roundId = String(st?.current_round_id || '').trim()
      at = String(st?.started_at || roundId || '').trim()
    } catch {
      /* ignore */
    }
    ensureEmployeeLiveProcess(page, role, {
      busy: true,
      roundId: roundId || undefined,
      at: at || roundId,
      title: trailTitle(at || roundId, { busy: true }),
    })
  }

  if (slot) {
    slot.innerHTML = renderPatrolRunning(role)
    slot.querySelector('[data-act="open-live"]')?.addEventListener('click', () => {
      void openBusyTrail()
    })
  }
  const statusEl = page.querySelector('[data-role-status]')
  if (statusEl) {
    statusEl.className = 'pro-badge pro-badge--run'
    statusEl.textContent = '工作中'
  }
  slot?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })

  const tipStop = startPatrolStepTips(slot)
  // Defer slightly so prepare_proactive_chat_session can stamp current_round_id.
  window.setTimeout(() => void openBusyTrail(), 400)

  const focusNote = String(focus || '').trim()
  try {
    const report = await api.proactiveHeartbeat(
      role.agent_code,
      focusNote ? { focus: focusNote } : {},
    )
    tipStop()
    destroyEmployeeLiveMount(page)
    if (slot) {
      slot.innerHTML = renderPatrolDone(report)
      bindOpenItems(slot)
    }
    toast(
      patrolHeadline(report),
      report?.scorecard?.incomplete || report?.scorecard?.verdict === 'empty' ? 'warning' : 'success',
    )

    role.last_heartbeat_at = report.last_heartbeat_at || role.last_heartbeat_at
    role.next_heartbeat_at = report.next_heartbeat_at || role.next_heartbeat_at

    const boardRes = await api.proactiveRoleWorkBoard(role.agent_code, 100).catch(() => null)
    let tasks = []
    let initiatives = []
    if (boardRes && (boardRes.rounds || boardRes.tasks || boardRes.initiatives)) {
      tasks = normalizeWorkBoardTasks(boardRes.tasks || [], role.role_name)
      initiatives = tasksAsWorklogItems(tasks)
    } else {
      const tasksRes = await api.listAllTasks().catch(() => null)
      tasks = tasksFromListResponse(tasksRes)
      initiatives = tasksAsWorklogItems(tasks)
    }
    page._tasks = tasks
    page._initiatives = initiatives
    // After patrol, jump to the round's calendar day so the new duty is visible
    const roundDay = dayKeyFromAt(report.round_id || report.last_heartbeat_at || '')
    if (roundDay && roundDay !== 'unknown') page._worklogDay = roundDay
    paintEmployeeWorkBody(page, role, initiatives, { highlightRoundId: report.round_id || '' })
    patchRoleProfile(page, role, initiatives, { busy: false })

    const roundEl = page.querySelector('[data-patrol-round]')
    roundEl?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  } catch (err) {
    tipStop()
    if (isBusyPatrolError(err)) {
      // 心跳 409 说明员工确实已开始工作（竞态窗口内 auto-patrol 启动了），
      // 此时不是错误，而是切换到「工作中」状态。
      toast('员工已开始工作，正在打开工作视图', 'info')
      if (slot) {
        slot.innerHTML = renderPatrolRunning(role)
        slot.querySelector('[data-act="open-live"]')?.addEventListener('click', () => {
          void openBusyTrail()
        })
      }
      window.setTimeout(() => void openBusyTrail(), 200)
      // 阻止 finally 重置 UI 状态（保持 patrolling=1 和按钮「工作中」）
      page.dataset._patrolKeepBusy = '1'
    } else {
      destroyEmployeeLiveMount(page)
      if (slot) slot.innerHTML = renderPatrolFailed(err)
      toast('本轮失败: ' + (err?.message || err), 'error')
    }
  } finally {
    if (page.dataset._patrolKeepBusy === '1') {
      delete page.dataset._patrolKeepBusy
    } else {
      page.dataset.patrolling = '0'
      if (btn) {
        btn.disabled = false
        btn.textContent = '现在开始工作'
      }
    }
  }
}

/** 「现在开始工作」弹窗：事项可选，不填也能开工。 */
function showStartWorkModal(role) {
  return new Promise((resolve) => {
    const name = role.role_name || role.agent_code
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay hire-overlay'
    overlay.innerHTML = `
      <div class="hire-sheet" role="dialog" aria-labelledby="start-work-title">
        <header class="hire-sheet-head">
          <div>
            <p class="hire-sheet-kicker">现在开始工作</p>
            <h2 id="start-work-title" class="hire-sheet-title">让「${esc(name)}」开始本轮工作</h2>
          </div>
          <button type="button" class="hire-sheet-close" data-act="close" aria-label="关闭">&times;</button>
        </header>

        <div class="hire-sheet-body">
          <p class="hire-chip-hint">可填写本轮要优先处理的事项；不填则按岗位职责常规上班。</p>
          <label class="hire-field">
            <span>本轮事项（可选）</span>
            <textarea
              class="hire-input hire-textarea"
              data-name="focus"
              rows="4"
              placeholder="例如：继续拆那条抖音视频并补全金句；或：检查昨天未完成的未完成事项"
            ></textarea>
          </label>
        </div>

        <footer class="hire-sheet-foot">
          <button type="button" class="btn btn-secondary btn-sm" data-act="close">取消</button>
          <button type="button" class="btn btn-sm hire-confirm" data-act="confirm">现在开始工作</button>
        </footer>
      </div>
    `
    document.body.appendChild(overlay)

    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      try {
        overlay.remove()
      } catch {
        /* ignore */
      }
      resolve(value)
    }

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(null)
    })
    overlay.querySelectorAll('[data-act="close"]').forEach((el) => {
      el.addEventListener('click', () => finish(null))
    })
    overlay.querySelector('[data-act="confirm"]')?.addEventListener('click', () => {
      const focus = String(overlay.querySelector('[data-name="focus"]')?.value || '').trim()
      finish({ focus })
    })
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        finish(null)
      }
    })
    overlay.querySelector('[data-name="focus"]')?.focus()
  })
}

/**
 * 员工详情页操作栏「融入」Tauri 标题栏：
 * 用 CSS fixed 定位到标题栏那一行的视觉位置，与窗口控制按钮同一行。
 * DOM 仍保留在 page 内，保证 page.querySelector / 事件绑定等逻辑正常工作。
 * 离开页面时自动清理 class。
 */
function mountEmployeeNavToChrome(page) {
  if (typeof document === 'undefined') return
  const chrome = document.getElementById('tauri-main-chrome')
  if (!chrome) return // 非 Tauri 无边框环境，跳过

  const nav = page.querySelector('.pro-page-nav')
  if (!nav) return

  // 标记：标题栏进入「员工页模式」（用于调整拖拽区等）
  chrome.classList.add('tauri-main-chrome--employee-nav')
  // 标记：页面操作栏已提升到标题栏行
  page.classList.add('pro-employee-page--nav-in-chrome')

  // 路由离开时清理：用 MutationObserver 监听 page 被移出文档
  const observer = new MutationObserver(() => {
    if (!document.body.contains(page)) {
      unmountEmployeeNavFromChrome(page)
      observer.disconnect()
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  page._navChromeObserver = observer
}

function unmountEmployeeNavFromChrome(page) {
  const chrome = document.getElementById('tauri-main-chrome')
  if (chrome) {
    chrome.classList.remove('tauri-main-chrome--employee-nav')
  }
  page.classList.remove('pro-employee-page--nav-in-chrome')
}

function bindEmployeePage(page, role, initiatives) {
  page._initiatives = Array.isArray(initiatives) ? initiatives : []
  if (page._worklogDay == null || page._worklogDay === '') page._worklogDay = WORKLOG_RECENT2
  if (page._worklogView !== 'list') page._worklogView = 'diary'
  if (!page._worklogListStatus) page._worklogListStatus = 'all'
  if (!page._employeeTab || page._employeeTab === 'overview' || page._employeeTab === 'tasks') {
    page._employeeTab = 'rounds'
  }
  page.querySelector('[data-act="back"]')?.addEventListener('click', () => navigate('/proactive'))

  const moreRoot = page.querySelector('[data-role="employee-more"]')
  const moreBtn = moreRoot?.querySelector('[data-act="more-toggle"]')
  const moreMenu = moreRoot?.querySelector('.pro-role-more-menu')
  const closeMore = () => {
    if (!moreMenu || !moreBtn) return
    moreMenu.hidden = true
    moreBtn.setAttribute('aria-expanded', 'false')
    moreRoot?.classList.remove('is-open')
  }
  moreBtn?.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (!moreMenu) return
    const open = moreMenu.hidden
    moreMenu.hidden = !open
    moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false')
    moreRoot?.classList.toggle('is-open', open)
  })
  const onDocClick = (e) => {
    if (!moreRoot || !(e.target instanceof Element)) return
    if (!moreRoot.contains(e.target)) closeMore()
  }
  document.addEventListener('click', onDocClick, { capture: true })
  page._employeeMoreDocClose = () => document.removeEventListener('click', onDocClick, { capture: true })

  page.querySelectorAll('[data-act="employee-tab"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setEmployeeTab(page, role, btn.getAttribute('data-tab') || 'rounds')
    })
  })
  setEmployeeTab(page, role, page._employeeTab)

  page.querySelector('[data-act="stop-work"]')?.addEventListener('click', async () => {
    const name = role.role_name || role.agent_code
    if (!api.proactiveStopRole) {
      toast('当前环境不支持「停止工作」操作', 'error')
      return
    }
    const ok = await showConfirm(
      `停止「${name}」当前工作？\n\n将取消进行中的上班轮次，并暂停到点自动值班（需手动点「上班」恢复）。`,
    )
    if (!ok) return
    try {
      const stop = api.proactiveStopRole
      await stop(role.agent_code)
      toast('已停止当前工作', 'success')
      // 局部更新：停止 watch、刷新数据、更新 busy 状态，避免全量重渲染丢失折叠面板/滚动位置
      stopPageWatch(page)
      await refreshEmployeeWorkLog(page, role)
      patchRoleProfile(page, role, page._initiatives || [], { busy: false })
      const btn = page.querySelector('[data-act="stop-work"]')
      if (btn) {
        btn.dataset.act = 'heartbeat'
        btn.textContent = '立即上班'
      }
      const statusEl = page.querySelector('[data-role-status]')
      if (statusEl) {
        statusEl.className = 'pro-badge pro-badge--ok'
        statusEl.textContent = '在岗'
      }
    } catch (e) {
      toast(`停止失败: ${e?.message || e}`, 'error')
    }
  })

  page.querySelectorAll('[data-diag-act]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const act = btn.dataset.diagAct
      if (act === 'approvals') {
        navigate('/proactive?tab=approvals')
        return
      }
      if (act === 'patrol') {
        page.querySelector('[data-act="heartbeat"]')?.click()
        return
      }
      if (act === 'live') {
        void onWatchLiveClick(page, role)
        return
      }
      if (act === 'worklog') {
        page._worklogView = 'diary'
        setEmployeeTab(page, role, 'rounds')
        page.querySelector('#pro-employee-body')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        return
      }
      if (act === 'edit') {
        page.querySelector('[data-act="edit"]')?.click()
        return
      }
      if (act === 'tasks') {
        page._worklogView = 'list'
        setEmployeeTab(page, role, 'rounds')
        page.querySelector('#pro-employee-body')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    })
  })

  const openRoleTasks = () => {
    const code = String(role.agent_code || '').trim()
    const roleName = String(role.role_name || '').trim()
    const agent = roleName
      ? `role:${roleName}`
      : code
        ? `agent:${code}`
        : ''
    const qs = new URLSearchParams()
    qs.set('source', 'role')
    if (agent) qs.set('agent', agent)
    navigate(`/tasks?${qs.toString()}`)
  }

  page.addEventListener('click', (e) => {
    const t = e.target
    if (!(t instanceof Element)) return
    const tasksBtn = t.closest('[data-act="open-tasks"]')
    if (tasksBtn && page.contains(tasksBtn)) {
      e.preventDefault()
      e.stopPropagation()
      openRoleTasks()
      return
    }
    const btn = t.closest('[data-act="open-kanban"]')
    if (!btn || !page.contains(btn)) return
    e.preventDefault()
    e.stopPropagation()
    const code = String(role.agent_code || '').trim()
    if (!code) return
    navigate(`/proactive/board?role=${encodeURIComponent(code)}`)
  })
  page.querySelector('[data-act="refresh"]')?.addEventListener('click', async () => {
    stopPageWatch(page)
    toast('刷新中…', 'info')
    const keepDay = String(page._worklogDay || WORKLOG_RECENT2)
    const keepView = page._worklogView === 'list' ? 'list' : 'diary'
    const keepListStatus = String(page._worklogListStatus || 'all')
    const keepTab = String(page._employeeTab || 'rounds')
    const next = await renderEmployeePage(role.agent_code)
    if (next) {
      next._worklogDay = keepDay || WORKLOG_RECENT2
      next._worklogView = keepView
      next._worklogListStatus = keepListStatus
      next._employeeTab = keepTab === 'metrics' || keepTab === 'config' ? keepTab : 'rounds'
      page.replaceWith(next)
      setEmployeeTab(next, role, next._employeeTab)
    }
  })
  page.querySelector('[data-act="edit"]')?.addEventListener('click', () => {
    void showEditRoleModal(role, {
      onSaved: async (updated) => {
        const newCode = String(updated?.agent_code || role.agent_code || '').trim()
        if (newCode && newCode !== role.agent_code) {
          navigate(`/proactive/${encodeURIComponent(newCode)}`)
          return
        }
        const keepDay = String(page._worklogDay || WORKLOG_RECENT2)
        const keepView = page._worklogView === 'list' ? 'list' : 'diary'
        const keepListStatus = String(page._worklogListStatus || 'all')
        const keepTab = String(page._employeeTab || 'rounds')
        const next = await renderEmployeePage(role.agent_code)
        if (next) {
          next._worklogDay = keepDay || WORKLOG_RECENT2
          next._worklogView = keepView
          next._worklogListStatus = keepListStatus
          next._employeeTab = keepTab === 'metrics' || keepTab === 'config' ? keepTab : 'rounds'
          page.replaceWith(next)
          setEmployeeTab(next, role, next._employeeTab)
        }
      },
    })
  })
  page.querySelector('[data-act="feishu-bind"]')?.addEventListener('click', () => {
    void startFeishuEmployeeScan(role.agent_code, {
      roleName: role.role_name || role.agent_code,
      onBound: async () => {
        const keepDay = String(page._worklogDay || WORKLOG_RECENT2)
        const next = await renderEmployeePage(role.agent_code)
        if (next) {
          next._worklogDay = keepDay || WORKLOG_RECENT2
          paintEmployeeWorkBody(next, role, next._initiatives || [], {})
          page.replaceWith(next)
        }
      },
    })
  })
  page.querySelector('[data-act="feishu-unbind"]')?.addEventListener('click', async () => {
    const ok = await showConfirm(
      `确定解除「${role.role_name || role.agent_code}」的飞书机器人绑定？\n\n解绑后飞书侧将无法再对话到此员工。`,
    )
    if (!ok) return
    await unbindFeishuEmployee(role.agent_code, {
      onUnbound: async () => {
        const keepDay = String(page._worklogDay || WORKLOG_RECENT2)
        const next = await renderEmployeePage(role.agent_code)
        if (next) {
          next._worklogDay = keepDay || WORKLOG_RECENT2
          paintEmployeeWorkBody(next, role, next._initiatives || [], {})
          page.replaceWith(next)
        }
      },
    })
  })
  page.querySelector('[data-act="archive"]')?.addEventListener('click', async () => {
    const name = role.role_name || role.agent_code
    const ok = await showConfirm(
      `将「${name}」归档？\n\n名册不再显示，历史工作项保留；需要彻底移除可再删除。`,
    )
    if (!ok) return
    try {
      await api.proactiveArchiveRole(role.agent_code)
      toast(`已归档 ${name}`, 'info')
      navigate('/proactive')
    } catch (err) {
      toast(`归档失败: ${err?.message || err}`, 'error')
    }
  })
  page.querySelector('[data-act="delete"]')?.addEventListener('click', async () => {
    const name = role.role_name || role.agent_code
    const ok = await showConfirm(
      `确定删除岗位「${name}」？\n\n会移除岗位雇佣，不删除底层智能体。`,
    )
    if (!ok) return
    try {
      await api.proactiveDeleteRole(role.agent_code)
      toast(`已删除岗位 ${name}`, 'info')
      navigate('/proactive')
    } catch (err) {
      toast(`删除失败: ${err?.message || err}`, 'error')
    }
  })
  page.querySelector('[data-act="dispatch"]')?.addEventListener('click', () => {
    closeMore()
    void (async () => {
      const result = await showDispatchModalEmployee(role)
      if (!result) return
      stopPageWatch(page)
      try {
        const res = await api.proactiveDispatchTask(role.agent_code, {
          goal: result.goal,
          description: result.description || '',
          priority: result.priority || 'normal',
          source: 'employee_page',
        })
        toast('任务已派发', 'success')
        const roundId = String(res?.round_id || '').trim()
        navigate(
          `/proactive/${encodeURIComponent(role.agent_code)}?live=1&goal=${encodeURIComponent(result.goal)}`,
        )
        if (roundId) void roundId
      } catch (e) {
        toast(`派发失败: ${e?.message || e}`, 'error')
      }
    })()
  })
  page.querySelector('[data-act="dispatch-first"]')?.addEventListener('click', () => {
    page.querySelector('[data-act="dispatch"]')?.click()
  })
  page.querySelector('[data-onboard-step="edit"]')?.addEventListener('click', () => {
    page.querySelector('[data-act="edit"]')?.click()
  })
  page.querySelector('[data-act="heartbeat"]')?.addEventListener('click', () => {
    closeMore()
    stopPageWatch(page)
    void (async () => {
      if (role.status === 'paused') {
        try {
          await api.proactiveResumeRole(role.agent_code)
          role.status = 'active'
          toast('已恢复自动上班', 'success')
        } catch (e) {
          toast(`恢复失败: ${e?.message || e}`, 'error')
          return
        }
      }
      const choice = await showStartWorkModal(role)
      if (!choice) return
      void runPatrol(page, role, { focus: choice.focus || '' })
    })()
  })
  page.querySelector('[data-act="watch-live"]')?.addEventListener('click', () => {
    void onWatchLiveClick(page, role)
  })
  page.querySelector('[data-act="open-chat"]')?.addEventListener('click', () => {
    const code = String(role?.agent_code || '').trim()
    if (!code) return
    const stamp = new Date().toISOString().replace(/[:/\\]/g, '-')
    const sk = `proactive:${code}:chat:${stamp}`
    try {
      sessionStorage.setItem('evopanel_pending_shell_session', sk)
      sessionStorage.removeItem('evopanel_pending_shell_processed')
    } catch {
      /* ignore */
    }
    try {
      window.dispatchEvent(
        new CustomEvent('evopanel:shell-select-session', { detail: { sessionKey: sk } }),
      )
    } catch {
      /* ignore */
    }
    window.location.hash = '#/chat'
  })
  ;['edit', 'feishu-bind', 'feishu-unbind', 'refresh', 'archive', 'delete', 'dispatch', 'heartbeat', 'stop-work'].forEach((act) => {
    page.querySelectorAll(`[data-act="${act}"]`).forEach((el) => {
      el.addEventListener('click', () => closeMore(), true)
    })
  })
  bindOpenItems(page)
  bindRoundTrails(page, role)
  bindWorklogDayBar(page, role)
  bindWorklogViewControls(page, role)
}

// ── Role work-item (Task) detail page ─────────────────────

function workItemStatusBadge(status) {
  const key = normalizeTaskStatusKey(status)
  const label = formatTaskStatusZh(status) || String(status || '—')
  if (key === 'req_confirm' || key === 'waiting_user') return { label, cls: 'pro-badge--warn' }
  if (key === 'executing' || key === 'planning' || key === 'running') return { label, cls: 'pro-badge--run' }
  if (key === 'completed' || key === 'done' || key === 'success' || key === 'reviewed') return { label, cls: 'pro-badge--ok' }
  if (key === 'failed' || key === 'error') return { label, cls: 'pro-badge--err' }
  if (key === 'cancelled' || key === 'canceled' || key === 'paused') return { label, cls: 'pro-badge--muted' }
  if (key === 'pending' || key === 'idle') return { label, cls: 'pro-badge--info' }
  return { label, cls: 'pro-badge--muted' }
}

function pickPendingApprovalForTask(approvals, taskId) {
  const tid = String(taskId || '').trim()
  if (!tid) return null
  const list = Array.isArray(approvals) ? approvals : []
  return (
    list.find(
      (a) =>
        String(a?.task_id || '').trim() === tid &&
        String(a?.status || '').trim().toLowerCase() === 'pending',
    ) || null
  )
}

function resolveWorkItemBack(code, from = '') {
  if (from === 'tasks') {
    return { label: '← 返回任务中心', href: '/tasks' }
  }
  return {
    label: `← 返回员工`,
    href: `/proactive/${encodeURIComponent(code)}`,
  }
}

function workItemFromParam() {
  // 审批/打回后局部重渲染时仍保留来源，避免返回跑偏
  try {
    const route = parseRoute()
    if (route.kind === 'work' && route.from) return route.from
  } catch {}
  return ''
}

async function renderWorkItemPage(code, taskId, opts = {}) {
  const from = String(opts.from || workItemFromParam() || '').trim()
  const back = resolveWorkItemBack(code, from)
  const page = document.createElement('div')
  page.className = 'page proactive-page pro-item-page pro-work-item-page task-detail-page'
  page.dataset.from = from
  page.innerHTML = `
    <div class="pro-page-nav">
      <button type="button" class="btn btn-ghost btn-sm" data-act="back">${esc(back.label)}</button>
    </div>
    <div class="pro-loading">加载岗位工作项…</div>
  `
  page.querySelector('[data-act="back"]')?.addEventListener('click', () => navigate(back.href))

  try {
    const [roleRes, taskRaw, approvalsRes, rolesRes] = await Promise.all([
      api.proactiveGetRole(code).catch(() => ({ agent_code: code, role_name: code })),
      api.getTask(taskId),
      api.proactiveListApprovals('pending').catch(() => ({ approvals: [] })),
      api.proactiveListRoles().catch(() => ({ roles: [] })),
    ])
    const role = roleRes?.agent_code ? roleRes : { agent_code: code, role_name: code, ...roleRes }
    const roster = Array.isArray(rolesRes?.roles) ? rolesRes.roles : []
    const tid = String(taskRaw?.id || taskRaw?.task_id || taskId).trim()
    if (!tid) throw new Error('工作项不存在或已删除')
    const parentId = String(taskRaw?.parent_task_id || '').trim()
    let task = { ...taskRaw, id: tid, task_id: tid }
    if (parentId && !task.parent) {
      const parentTask = await api.getTask(parentId).catch(() => null)
      if (parentTask) {
        task = {
          ...task,
          parent: {
            task_id: String(parentTask.id || parentTask.task_id || parentId),
            name: parentTask.name,
            status: parentTask.status,
            assigned_role: parentTask.assigned_role,
            raised_by: parentTask.raised_by,
          },
        }
      }
    }
    const pendingApproval = pickPendingApprovalForTask(
      approvalsRes?.approvals || approvalsRes || [],
      tid,
    )
    page.innerHTML = renderWorkItemDetail(role, task, { pendingApproval, roster, from })
    bindWorkItemDetail(page, role, task, { from, roster })
  } catch (e) {
    page.innerHTML = `
      <div class="pro-page-nav">
        <button type="button" class="btn btn-ghost btn-sm" data-act="back">${esc(back.label)}</button>
      </div>
      <div class="pro-error">加载失败: ${esc(String(e?.message || e))}</div>
    `
    page.querySelector('[data-act="back"]')?.addEventListener('click', () => navigate(back.href))
  }
  return page
}

function renderWorkItemOutcomeCards(task, statusGroup) {
  const result = taskSummaryText(task)
  const error = String(task.error || task.error_text || '').trim()
  const sections = parseTaskResultSections(statusGroup === 'failed' ? error || result : result)
  const outputs = resolveTaskOutputItems(task)
  const inputRefs = taskInputRefsOf(task)
  const cards = []

  if (statusGroup === 'completed') {
    const headline =
      sections.conclusion ||
      '工作项已完成。'
    const bits = []
    if (outputs.length) bits.push(`共 ${outputs.length} 项产出`)
    if (inputRefs.length) bits.push(`${inputRefs.length} 项上游参考`)
    if (sections.findings.length) bits.push(`${sections.findings.length} 项发现`)
    cards.push(`
      <section class="td-card td-card--result">
        <h2 class="td-card-title">完成结果</h2>
        <p class="td-card-lead">${esc(headline)}</p>
        ${bits.length ? `<p class="td-card-sub">${esc(bits.join(' · '))}</p>` : ''}
        ${
          outputs[0] && /^https?:\/\//i.test(outputs[0].value)
            ? `<div class="td-card-actions"><a class="btn btn-sm btn-primary" href="${esc(outputs[0].value)}" target="_blank" rel="noopener noreferrer">查看产出</a></div>`
            : ''
        }
      </section>`)
  } else if (statusGroup === 'failed') {
    cards.push(`
      <section class="td-card td-card--fail">
        <h2 class="td-card-title">失败原因</h2>
        <p class="td-card-lead">${esc(
          error ||
            sections.conclusion ||
            result ||
            '执行失败：原因未知。请打开「工作过程」查看最后几步。',
        )}</p>
      </section>`)
  } else if (result && !textLooksSimilar(result, String(task.description || ''))) {
    cards.push(`
      <section class="td-card">
        <h2 class="td-card-title">当前进展</h2>
        <p class="td-card-lead">${esc(sections.conclusion || result.slice(0, 280))}</p>
      </section>`)
  }

  if (inputRefs.length) {
    cards.push(`
      <section class="td-card td-card--input-refs">
        <h2 class="td-card-title">上游参考产物</h2>
        <p class="td-card-sub">来自上游交工指定，请先阅读；不是本岗交付物。</p>
        ${renderTaskInputRefsCardsHtml(task, esc, { enablePreview: true })}
      </section>`)
  }

  if (outputs.length) {
    cards.push(`
      <section class="td-card">
        <h2 class="td-card-title">本岗交付物</h2>
        ${renderTaskOutputCardsHtml(task, esc, { enablePreview: true })}
      </section>`)
  }

  if (sections.findings.length) {
    cards.push(`
      <section class="td-card">
        <h2 class="td-card-title">关键发现</h2>
        <ul class="td-findings">${sections.findings
          .slice(0, 12)
          .map((f) => `<li>${esc(f)}</li>`)
          .join('')}</ul>
      </section>`)
  }

  if (sections.nextSteps.length) {
    cards.push(`
      <section class="td-card">
        <h2 class="td-card-title">建议下一步</h2>
        <ol class="td-next-steps">${sections.nextSteps
          .slice(0, 10)
          .map((s) => `<li>${esc(s)}</li>`)
          .join('')}</ol>
      </section>`)
  }

  if (
    !sections.findings.length &&
    !sections.nextSteps.length &&
    !outputs.length &&
    !inputRefs.length &&
    result &&
    (statusGroup === 'completed' || statusGroup === 'reviewed' || statusGroup === 'executing') &&
    result.length > 400 &&
    result !== sections.conclusion
  ) {
    cards.push(`
      <details class="td-card td-card--fold">
        <summary>查看完整总结</summary>
        <pre class="td-raw-summary">${esc(result)}</pre>
      </details>`)
  }

  return cards.join('')
}

function renderWorkItemDetail(role, task, { pendingApproval = null, roster = [], from = '' } = {}) {
  const code = role.agent_code || task.assigned_to || ''
  const tid = String(task.id || task.task_id || '').trim()
  const title = String(task.name || task.title || tid || '未命名工作项').trim()
  const riskKey = String(task.risk_level || '').trim().toLowerCase()
  const risk = RISK_BADGE[riskKey] || null
  const typeLabel = ACTION_TYPE_LABEL[task.action_type] || String(task.action_type || '').trim()
  const sourceZh = formatTaskSourceZh(task.source_zh || task.source)
  const raisedRaw = String(task.raised_by || '').trim()
  const raisedZh = raisedRaw ? formatRaisedByLabel(raisedRaw, roster) : ''
  const descClean = cleanWorkText(task.description)
  const goalClean = cleanWorkText(task.goal)
  const rationale = humanRationale(task.rationale, roster)
  const body =
    rationale ||
    (looksLikeInternalDispatchNote(descClean) ? '' : descClean) ||
    goalClean ||
    descClean ||
    ''
  const showExtraDesc =
    Boolean(rationale) &&
    Boolean(descClean) &&
    !textLooksSimilar(descClean, rationale) &&
    !looksLikeInternalDispatchNote(descClean)
  const plan = actionablePlan(task.action_plan)
  const expected = String(task.expected_outcome || '').trim()
  const statusKey = normalizeTaskStatusKey(task.status)
  const statusGroup = toTaskStatusGroup(task.status)
  const handlers = taskHandlersOf(task)
  // Handoff gate (post-complete): never reuse legacy「开工前」文案。
  const handoffPendingFlag =
    Boolean(task.handlers_pending_approval) ||
    ((statusGroup === 'completed' || statusGroup === 'reviewed') && Boolean(pendingApproval)) ||
    statusKey === 'waiting_user' ||
    statusKey === 'req_confirm'
  // 已取消/失败：只展示信息，不再出现可执行审核
  const handoffReviewLocked = statusGroup === 'cancelled' || statusGroup === 'failed'
  const isHandoffApprove = handoffPendingFlag && !handoffReviewLocked
  const showHandoffReadonly = handoffPendingFlag && handoffReviewLocked
  const isLegacyStartApprove =
    Boolean(pendingApproval) &&
    !handoffPendingFlag &&
    !handoffReviewLocked &&
    statusGroup !== 'completed' &&
    statusGroup !== 'reviewed'
  const needsApprove = isHandoffApprove || isLegacyStartApprove
  const needsReview = false
  const parentId = String(task.parent_task_id || task.parent?.task_id || '').trim()
  const parentIdShort = parentId ? parentId.slice(-8) : ''
  const parentName = String(task.parent?.name || '').trim()
  const parentRole = String(task.parent?.assigned_role || '').trim()
  const childIds = Array.isArray(task.child_task_ids) ? task.child_task_ids.filter(Boolean) : []
  const displayTitle =
    looksLikeInternalDispatchNote(title) && goalClean
      ? goalClean.split('\n')[0].trim().slice(0, 80) || title
      : title
  const progressPct = Math.max(0, Math.min(100, Number(task.progress) || 0))
  const showProgress =
    statusGroup === 'executing' || statusGroup === 'paused' || statusGroup === 'planning'
  const subtasks = Array.isArray(task.subtasks) ? task.subtasks : []
  const subDone = subtasks.filter((s) => {
    const st = String(s?.status || '').toLowerCase()
    return st === 'completed' || st === 'done' || st === 'reviewed'
  }).length
  const back = resolveWorkItemBack(code, from)
  const roleLabel = role.role_name || task.assigned_role || code
  const when = fmtTime(task.updated_at || task.completed_at || task.created_at)
  const statusZh = formatTaskStatusZh(task.status) || workItemStatusBadge(task.status).label
  const statusBits = [statusZh, roleLabel, when].filter(Boolean)
  if (isHandoffApprove) statusBits[0] = '待你拍板 · 转交审核'
  else if (showHandoffReadonly) statusBits[0] = statusGroup === 'cancelled' ? '已取消 · 转交已关闭' : '已失败 · 转交已关闭'
  else if (needsApprove) statusBits[0] = '待你拍板'
  else if (needsReview) statusBits[0] = '待你验收 · 交工确认'
  const outcomeHtml = renderWorkItemOutcomeCards(task, statusGroup)
  const showOutcome = Boolean(outcomeHtml) || ['reviewed', 'completed', 'failed', 'executing', 'paused', 'cancelled'].includes(statusGroup)

  const approvePanelHtml = isHandoffApprove
    ? `<section class="task-decision-panel" aria-label="转交审核">
        <div class="task-decision-copy">
          <strong>转交任务汇报</strong>
          <p>上一步已完成。同意后下一岗开始；驳回则不派下游。</p>
        </div>
        ${
          handlers.length
            ? renderHandlersReadonlyHtml(handlers, esc, { open: true, roles: roster })
            : '<p class="task-decision-missing-handlers">未指定下一岗处理人</p>'
        }
        <div class="task-decision-actions">
          <button type="button" class="btn btn-primary" data-act="approve" data-approve-kind="handoff">同意派发</button>
          <button type="button" class="btn btn-danger-outline" data-act="reject">驳回</button>
        </div>
        <div class="pro-reject-panel" data-reject-panel hidden>
          <label class="pro-reject-label">驳回原因（必填）</label>
          <textarea class="pro-reject-input" rows="2" placeholder="简单说明原因，员工下一轮会看到"></textarea>
          <div class="pro-reject-actions">
            <button type="button" class="btn btn-sm btn-danger" data-act="reject-confirm">确认驳回</button>
            <button type="button" class="btn btn-sm btn-ghost" data-act="reject-cancel">取消</button>
          </div>
        </div>
      </section>`
    : showHandoffReadonly
      ? `<section class="task-decision-panel task-decision-panel--locked" aria-label="转交审核（已关闭）">
          <div class="task-decision-copy">
            <strong>转交审核</strong>
            <p>任务已${statusGroup === 'cancelled' ? '取消' : '失败'}，无法继续审核。</p>
          </div>
          ${
            handlers.length
              ? renderHandlersReadonlyHtml(handlers, esc, { open: true, roles: roster })
              : ''
          }
        </section>`
    : isLegacyStartApprove
      ? `<section class="task-decision-panel" aria-label="事项审批">
          <div class="task-decision-copy">
            <strong>事项审批</strong>
            <p>需要你确认后才会继续</p>
          </div>
          <div class="task-decision-actions">
            <button type="button" class="btn btn-primary" data-act="approve">同意</button>
            <button type="button" class="btn btn-danger" data-act="reject">驳回</button>
          </div>
          <div class="pro-reject-panel" data-reject-panel hidden>
            <label class="pro-reject-label">驳回原因（必填）</label>
            <textarea class="pro-reject-input" rows="2" placeholder="简单说明原因，员工下一轮会看到"></textarea>
            <div class="pro-reject-actions">
              <button type="button" class="btn btn-sm btn-danger" data-act="reject-confirm">确认驳回</button>
              <button type="button" class="btn btn-sm btn-ghost" data-act="reject-cancel">取消</button>
            </div>
          </div>
        </section>`
      : ''

  const planHtml = plan
    ? `
      <div class="td-aside-block">
        <div class="td-aside-k">行动计划</div>
        ${
          plan.steps.length
            ? `<ol class="pro-item-steps">${plan.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`
            : ''
        }
        ${
          plan.files.length
            ? `<p class="pro-item-plan-label">相关文件</p><ul class="pro-item-files">${plan.files
                .map((f) => `<li><code>${esc(f)}</code></li>`)
                .join('')}</ul>`
            : ''
        }
        ${
          plan.commands.length
            ? `<p class="pro-item-plan-label">命令</p><ul class="pro-item-files">${plan.commands
                .map((c) => `<li><code>${esc(c)}</code></li>`)
                .join('')}</ul>`
            : ''
        }
      </div>`
    : ''

  return `
    <div class="td-shell">
      <header class="td-topbar">
        <button type="button" class="btn btn-ghost btn-sm" data-act="back">${esc(back.label)}</button>
        <div class="td-topbar-actions">
          <button type="button" class="btn btn-sm btn-secondary" data-act="open-trail" title="打开本轮工作过程">工作过程</button>
          ${
            (statusGroup === 'executing' || statusGroup === 'paused' || statusGroup === 'failed' || statusGroup === 'planning')
            && String(task.round_id || task.source_ref || '').trim()
              ? `<button type="button" class="btn btn-sm btn-primary" data-act="continue-round" title="沿用同一轮工作过程继续处理未结任务">继续本轮</button>`
              : ''
          }
          <div class="td-more" data-wi-more>
            <button type="button" class="btn btn-secondary btn-sm td-more-btn" data-act="more-toggle" aria-haspopup="menu" aria-expanded="false">⋯ 更多</button>
            <div class="td-more-panel" data-more-panel role="menu" hidden>
              <button type="button" class="td-more-item" role="menuitem" data-act="open-task-detail">任务中心详情</button>
              <button type="button" class="td-more-item td-more-item--danger" role="menuitem" data-act="review-delete">删除任务</button>
            </div>
          </div>
        </div>
      </header>

      <div class="td-title-block">
        <h1 class="td-title">${esc(displayTitle)}</h1>
        <p class="td-status-line" data-group="${esc(statusGroup)}">${esc(statusBits.join(' · '))}</p>
      </div>

      ${
        showProgress
          ? `<div class="td-progress" aria-label="任务进度 ${progressPct}%">
              <div class="td-progress-head">
                <span class="td-progress-label">${statusGroup === 'paused' ? '已暂停' : '进行中'}</span>
                <span class="td-progress-value">${progressPct}%</span>
              </div>
              <div class="td-progress-bar"><div class="td-progress-fill${statusGroup !== 'paused' && progressPct < 100 ? ' is-buffering' : ''}" style="width:${progressPct}%"></div></div>
              ${
                subtasks.length
                  ? `<div class="td-progress-sub">子任务 ${subDone}/${subtasks.length} 完成</div>`
                  : ''
              }
            </div>`
          : ''
      }

      <div class="td-layout">
        <main class="td-main">
          ${approvePanelHtml}

          ${
            needsReview
              ? `<section class="task-decision-panel task-decision-panel--review" aria-label="交工待验收">
                  <div class="task-decision-copy">
                    <strong>交工待验收</strong>
                    <p>确认通过后，下方处理人将收到对应任务；也可打回重做。删除请用右上角「更多」。</p>
                  </div>
                  ${renderHandlersEditorHtml({
                    handlers,
                    roles: roster.filter((r) => String(r.status || '').toLowerCase() !== 'archived'),
                    esc,
                    fromAgentCode: code,
                  })}
                  <div class="task-decision-actions">
                    <button type="button" class="btn btn-primary" data-act="review-complete">确认完成</button>
                    <button type="button" class="btn btn-secondary" data-act="review-rework">打回重做</button>
                    <button type="button" class="btn btn-warning" data-act="review-fail">标记失败</button>
                    <button type="button" class="btn btn-ghost" data-act="review-cancel">取消任务</button>
                  </div>
                  <div class="pro-reject-panel" data-review-note-panel hidden>
                    <label class="pro-reject-label">说明（打回 / 失败建议填写；取消可选）</label>
                    <textarea class="pro-reject-input" data-review-note rows="2" placeholder="写清原因，便于留痕"></textarea>
                    <div class="pro-reject-actions">
                      <button type="button" class="btn btn-sm btn-primary" data-act="review-note-confirm">确认提交</button>
                      <button type="button" class="btn btn-sm btn-ghost" data-act="review-note-cancel">返回</button>
                    </div>
                  </div>
                </section>`
              : ''
          }

          ${
            !needsReview && !isHandoffApprove && handlers.length
              ? renderHandlersReadonlyHtml(handlers, esc, { roles: roster })
              : ''
          }

          ${
            showOutcome
              ? `<section class="td-result" aria-label="工作结果">${
                  outcomeHtml ||
                  `<section class="td-card"><h2 class="td-card-title">结果</h2><p class="td-card-lead pro-item-muted">暂无总结与产出</p></section>`
                }</section>`
              : ''
          }

          <section class="td-card">
            <h2 class="td-card-title">简要说明</h2>
            ${mdBlock(body || '（暂无说明）')}
            ${
              showExtraDesc
                ? `<div class="td-aside-block" style="margin-top:14px"><div class="td-aside-k">原始需求</div>${mdBlock(descClean)}</div>`
                : ''
            }
            ${
              expected && !textLooksSimilar(expected, body)
                ? `<div class="td-aside-block" style="margin-top:14px"><div class="td-aside-k">预期结果</div><p>${esc(expected)}</p></div>`
                : ''
            }
          </section>

          ${
            subtasks.length
              ? `<section class="task-obs-panel" aria-label="子任务进度">
                  <header class="task-obs-panel-header">
                    <h2 class="task-obs-panel-title">子任务进度</h2>
                    <span class="task-obs-panel-count">${subDone}/${subtasks.length}</span>
                  </header>
                  <ul class="pro-item-subtasks">
                    ${subtasks
                      .map((s) => {
                        const st = String(s?.status || '').trim()
                        const pct = Math.max(0, Math.min(100, Number(s?.progress) || 0))
                        const nm = String(s?.name || s?.id || '子任务').trim()
                        return `<li>
                          <span class="pro-item-subtask-name">${esc(nm)}</span>
                          <span class="pro-badge ${workItemStatusBadge(st).cls}">${esc(workItemStatusBadge(st).label)}</span>
                          <span class="pro-item-muted">${pct > 0 ? `${pct}%` : '—'}</span>
                        </li>`
                      })
                      .join('')}
                  </ul>
                </section>`
              : ''
          }
        </main>

        <aside class="td-aside">
          <section class="td-aside-card">
            <h2 class="td-aside-title">工作项信息</h2>
            <dl class="td-aside-dl">
              <div class="td-aside-row"><dt>状态</dt><dd>${esc(statusZh)}</dd></div>
              <div class="td-aside-row"><dt>负责人</dt><dd>${esc(roleLabel)}</dd></div>
              ${typeLabel ? `<div class="td-aside-row"><dt>类型</dt><dd>${esc(typeLabel)}</dd></div>` : ''}
              ${sourceZh ? `<div class="td-aside-row"><dt>来源</dt><dd>${esc(sourceZh)}</dd></div>` : ''}
              ${raisedZh ? `<div class="td-aside-row"><dt>提出/叫醒</dt><dd>${esc(raisedZh)}</dd></div>` : ''}
              ${
                (() => {
                  const woken = String(task.woken_by || '').trim()
                  if (!woken) return ''
                  if (woken.toLowerCase() === raisedRaw.toLowerCase()) return ''
                  const wokenZh = formatRaisedByLabel(woken, roster)
                  return wokenZh
                    ? `<div class="td-aside-row"><dt>叫醒</dt><dd>${esc(wokenZh)}</dd></div>`
                    : ''
                })()
              }
              ${risk ? `<div class="td-aside-row"><dt>风险</dt><dd>${esc(risk.label)}</dd></div>` : ''}
              <div class="td-aside-row"><dt>更新</dt><dd>${esc(when)}</dd></div>
              <div class="td-aside-row"><dt>编号</dt><dd><code class="pro-item-mono">${esc(tid.slice(-12) || tid)}</code></dd></div>
            </dl>
            ${planHtml}
          </section>

          ${
            parentId || childIds.length
              ? `<section class="td-aside-card td-aside-card--meta">
                  <h2 class="td-aside-title">关联任务</h2>
                  ${
                    parentId
                      ? `<div class="td-aside-block">
                          <div class="td-aside-k">上游</div>
                          <button type="button" class="btn btn-sm btn-outline" data-act="open-parent" data-parent-id="${esc(parentId)}">${esc(parentName || parentId)}</button>
                          <p class="pro-item-muted" style="margin-top:6px"><code class="pro-item-mono">${esc(parentIdShort)}</code>${parentRole ? ` · ${esc(parentRole)}` : ''}</p>
                        </div>`
                      : ''
                  }
                  ${
                    childIds.length
                      ? `<div class="td-aside-block">
                          <div class="td-aside-k">下游（${childIds.length}）</div>
                          <div class="td-aside-links">${childIds
                            .map((cid) => {
                              const short = String(cid).slice(-8)
                              return `<button type="button" class="td-aside-link" data-act="open-child" data-child-id="${esc(cid)}">下游 · ${esc(short)} ›</button>`
                            })
                            .join('')}</div>
                        </div>`
                      : ''
                  }
                </section>`
              : ''
          }
        </aside>
      </div>
    </div>
  `
}

function bindWorkItemDetail(page, role, task, opts = {}) {
  const code = role.agent_code || task.assigned_to || ''
  const tid = String(task.id || task.task_id || '').trim()
  const from = String(opts.from || page?.dataset?.from || workItemFromParam() || '').trim()
  const back = resolveWorkItemBack(code, from)
  page.dataset.from = from

  page.querySelector('[data-act="back"]')?.addEventListener('click', () => navigate(back.href))

  const moreBtn = page.querySelector('[data-act="more-toggle"]')
  const morePanel = page.querySelector('[data-more-panel]')
  const closeMore = () => {
    if (morePanel) morePanel.hidden = true
    moreBtn?.setAttribute('aria-expanded', 'false')
  }
  moreBtn?.addEventListener('click', (e) => {
    e.stopPropagation()
    const open = morePanel?.hasAttribute('hidden')
    if (open) {
      morePanel.removeAttribute('hidden')
      moreBtn.setAttribute('aria-expanded', 'true')
    } else {
      closeMore()
    }
  })
  page.addEventListener('click', (e) => {
    if (!e.target.closest?.('[data-wi-more]')) closeMore()
  })

  page.querySelector('[data-act="open-task-detail"]')?.addEventListener('click', () => {
    closeMore()
    if (!tid) return
    window.location.hash = `#/task/${encodeURIComponent(tid)}`
  })

  bindTaskOutputCardActions(page, {
    workspaceRoot: () => workspaceOf(role),
    agentCode: () => String(role?.agent_code || code || '').trim(),
  })
  page.dataset.workspaceRoot = workspaceOf(role)
  page.dataset.agentCode = String(role?.agent_code || code || '').trim()

  const openLinkedWork = async (linkedId) => {
    const id = String(linkedId || '').trim()
    if (!id) return
    // Cross-role handoff: open under the assignee's work page when possible.
    try {
      const linked = await api.getTask(id)
      const assignee = String(linked?.assigned_to || '').trim()
      if (assignee) {
        const q = from ? `?from=${encodeURIComponent(from)}` : '?from=tasks'
        navigate(`/proactive/${encodeURIComponent(assignee)}/work/${encodeURIComponent(id)}${q}`)
        return
      }
    } catch {
      /* fall through */
    }
    navigate(`/task/${encodeURIComponent(id)}`)
  }
  page.querySelector('[data-act="open-parent"]')?.addEventListener('click', (e) => {
    openLinkedWork(e.currentTarget?.getAttribute?.('data-parent-id'))
  })
  page.querySelectorAll('[data-act="open-child"]').forEach((btn) => {
    btn.addEventListener('click', () => openLinkedWork(btn.getAttribute('data-child-id')))
  })

  page.querySelector('[data-act="approve"]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget
    btn.disabled = true
    try {
      await api.proactiveApprove(tid, 'approved', 'user', '')
      const kind = String(btn.dataset.approveKind || '')
      toast(kind === 'handoff' ? '已同意派发' : '已同意', 'success')
      const next = await renderWorkItemPage(code, tid, { from })
      page.replaceWith(next)
    } catch (err) {
      toast('审批失败: ' + err, 'error')
      btn.disabled = false
    }
  })
  page.querySelector('[data-act="reject"]')?.addEventListener('click', () => {
    const panel = page.querySelector('[data-reject-panel]')
    if (panel) panel.hidden = false
    panel?.querySelector('.pro-reject-input')?.focus()
  })
  page.querySelector('[data-act="reject-cancel"]')?.addEventListener('click', () => {
    const panel = page.querySelector('[data-reject-panel]')
    if (panel) {
      panel.hidden = true
      const ta = panel.querySelector('.pro-reject-input')
      if (ta) ta.value = ''
    }
  })
  page.querySelector('[data-act="reject-confirm"]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget
    const panel = page.querySelector('[data-reject-panel]')
    const reason = String(panel?.querySelector('.pro-reject-input')?.value || '').trim()
    if (!reason) {
      toast('请填写驳回原因', 'warning')
      panel?.querySelector('.pro-reject-input')?.focus()
      return
    }
    btn.disabled = true
    try {
      await api.proactiveApprove(tid, 'rejected', 'user', reason, reason)
      toast('已驳回', 'info')
      const next = await renderWorkItemPage(code, tid, { from })
      page.replaceWith(next)
    } catch (err) {
      toast('操作失败: ' + err, 'error')
      btn.disabled = false
    }
  })

  let pendingReviewAct = null
  const reviewNotePanel = () => page.querySelector('[data-review-note-panel]')
  const reviewNoteInput = () => page.querySelector('[data-review-note]')
  const handlersEditor = page.querySelector('[data-handlers-editor]')
  if (handlersEditor) {
    bindHandlersEditor(handlersEditor, {
      roles: Array.isArray(opts.roster) ? opts.roster : [],
      esc,
      fromAgentCode: code,
    })
  }
  const applyReviewState = async (status, comment = '') => {
    try {
      const extras = {}
      if (status === 'completed' && handlersEditor) {
        extras.handlers = collectHandlersFromEditor(handlersEditor)
      }
      await api.setTaskState(tid, status, comment, '', extras)
      const labels = {
        completed: '已确认完成',
        executing: '已打回重做',
        failed: '已标记失败',
        cancelled: '已取消任务',
      }
      const dispatched = extras.handlers?.length
      toast(
        status === 'completed' && dispatched
          ? `已确认完成，已派给 ${dispatched} 位处理人`
          : labels[status] || '状态已更新',
        status === 'failed' || status === 'cancelled' ? 'warning' : 'success',
      )
      if (status === 'cancelled' && from === 'tasks') {
        navigate('/tasks')
        return
      }
      const next = await renderWorkItemPage(code, tid, { from })
      page.replaceWith(next)
    } catch (err) {
      toast('操作失败: ' + err, 'error')
    }
  }
  page.querySelector('[data-act="review-complete"]')?.addEventListener('click', async () => {
    const handlers = handlersEditor ? collectHandlersFromEditor(handlersEditor) : []
    const yes = await showConfirm(
      handlers.length
        ? `确认验收通过？将派给 ${handlers.length} 位处理人开始跟进。`
        : '确认该工作项已验收通过并标记为「已完成」？（未指定处理人，仅结案）',
    )
    if (!yes) return
    await applyReviewState('completed')
  })
  page.querySelector('[data-act="review-rework"]')?.addEventListener('click', () => {
    pendingReviewAct = 'rework'
    const panel = reviewNotePanel()
    if (panel) panel.hidden = false
    reviewNoteInput()?.focus()
  })
  page.querySelector('[data-act="review-fail"]')?.addEventListener('click', () => {
    pendingReviewAct = 'fail'
    const panel = reviewNotePanel()
    if (panel) panel.hidden = false
    reviewNoteInput()?.focus()
  })
  page.querySelector('[data-act="review-cancel"]')?.addEventListener('click', () => {
    pendingReviewAct = 'cancel'
    const panel = reviewNotePanel()
    if (panel) panel.hidden = false
    reviewNoteInput()?.focus()
  })
  page.querySelector('[data-act="review-delete"]')?.addEventListener('click', async () => {
    closeMore()
    const yes = await showConfirm('确定删除此任务及其子任务？删除后不可恢复。')
    if (!yes) return
    try {
      await api.deleteTask(tid)
      toast('任务已删除', 'success')
      navigate(from === 'tasks' ? '/tasks' : `/proactive/${encodeURIComponent(code)}`)
    } catch (err) {
      toast('删除失败: ' + err, 'error')
    }
  })
  page.querySelector('[data-act="review-note-cancel"]')?.addEventListener('click', () => {
    pendingReviewAct = null
    const panel = reviewNotePanel()
    if (panel) panel.hidden = true
    const ta = reviewNoteInput()
    if (ta) ta.value = ''
  })
  page.querySelector('[data-act="review-note-confirm"]')?.addEventListener('click', async () => {
    const comment = String(reviewNoteInput()?.value || '').trim()
    if ((pendingReviewAct === 'rework' || pendingReviewAct === 'fail') && !comment) {
      toast('请填写说明', 'warning')
      reviewNoteInput()?.focus()
      return
    }
    const status =
      pendingReviewAct === 'fail' ? 'failed'
        : pendingReviewAct === 'cancel' ? 'cancelled'
          : 'executing'
    await applyReviewState(status, comment)
    pendingReviewAct = null
  })

  page.querySelectorAll('[data-act="open-trail"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (page._liveProcess?.isOpen?.()) {
        toast('过程窗口已打开', 'info')
        return
      }
      const roundId = String(task.round_id || task.source_ref || '').trim()
      const at = String(task.created_at || task.updated_at || roundId || '').trim()
      ensureEmployeeLiveProcess(page, role, {
        busy: false,
        roundId: roundId || undefined,
        at: at || roundId,
        title: trailTitle(at || roundId, { busy: false }),
      })
      toast(roundId ? '已打开本轮工作过程' : '已打开工作过程', 'info')
    })
  })

  page.querySelectorAll('[data-act="continue-round"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const roundId = String(task.round_id || task.source_ref || '').trim()
      const taskId = String(task.id || task.task_id || '').trim()
      if (!roundId || !taskId) {
        toast('缺少 round_id 或任务 id，无法续跑', 'warning')
        return
      }
      const title = String(task.name || task.title || taskId).trim()
      const goal = `继续完成未结任务：${title.slice(0, 80)}`
      const description = [
        `续跑同一轮工作过程 ${roundId}。`,
        '请先查看本轮已有工具结果与进度，补做卡住的步骤后用 tasks state=completed 结案。',
        '禁止无视轨迹从零重做已完成步骤。',
      ].join('\n')
      btn.disabled = true
      const prev = btn.textContent
      btn.textContent = '续跑中…'
      try {
        const res = await api.proactiveDispatchTask(code, {
          goal,
          description,
          priority: 'high',
          source: 'employee_page',
          related_task_id: taskId,
          round_id: roundId,
          resume_round: true,
        })
        const rid = String(res?.round_id || roundId).trim()
        toast('已沿用本轮轨迹继续派发', 'success')
        navigate(
          `/proactive/${encodeURIComponent(code)}?live=1&goal=${encodeURIComponent(goal)}`,
        )
        if (rid) {
          // Keep URL goal param; live page picks up busy round.
          void rid
        }
      } catch (e) {
        toast(String(e?.message || e || '续跑失败'), 'error')
        btn.disabled = false
        btn.textContent = prev || '继续本轮'
      }
    })
  })
}

// ── Initiative detail page ────────────────────────────────

async function renderItemPage(code, itemId) {
  const page = document.createElement('div')
  page.className = 'page proactive-page pro-item-page'
  page.innerHTML = `
    <div class="pro-page-nav">
      <button type="button" class="btn btn-ghost btn-sm" data-act="back">← 返回员工</button>
    </div>
    <div class="pro-loading">加载事项…</div>
  `
  page.querySelector('[data-act="back"]')?.addEventListener('click', () =>
    navigate(`/proactive/${encodeURIComponent(code)}`),
  )

  try {
    const [roleRes, initiative, rolesRes] = await Promise.all([
      api.proactiveGetRole(code).catch(() => ({ agent_code: code, role_name: code })),
      api.proactiveGetInitiative(itemId),
      api.proactiveListRoles().catch(() => ({ roles: [] })),
    ])
    const role = roleRes?.agent_code ? roleRes : { agent_code: code, role_name: code, ...roleRes }
    if (!initiative?.id) throw new Error('事项不存在或已删除')
    const roster = rolesRes?.roles || rolesRes || []
    page.innerHTML = renderItemDetail(role, initiative, roster)
    bindItemDetail(page, role, initiative)
  } catch (e) {
    page.innerHTML = `
      <div class="pro-page-nav">
        <button type="button" class="btn btn-ghost btn-sm" data-act="back">← 返回员工</button>
      </div>
      <div class="pro-error">加载失败: ${esc(String(e?.message || e))}</div>
    `
    page.querySelector('[data-act="back"]')?.addEventListener('click', () =>
      navigate(`/proactive/${encodeURIComponent(code)}`),
    )
  }
  return page
}

function approvalDecisionStatus(initOrApproval) {
  const appr = initOrApproval?.approval || initOrApproval
  const st = String(appr?.status || '').trim().toLowerCase()
  if (st === 'approved') return 'approved'
  if (st === 'rejected') return 'rejected'
  if (st === 'timeout') return 'timeout'
  return ''
}

/** Show approve bar only when still waiting — trust Approval row over stale initiative status. */
function needsHumanApprove(init) {
  if (String(init?.status || '') !== 'pending_approval') return false
  return !approvalDecisionStatus(init)
}

function renderItemDetail(role, init, roster = []) {
  const roundLog = isRoundLog(init)
  const decided = approvalDecisionStatus(init)
  const effectiveStatus =
    decided === 'approved' && init.status === 'pending_approval'
      ? 'approved'
      : decided === 'rejected' && init.status === 'pending_approval'
        ? 'rejected'
        : decided === 'timeout' && init.status === 'pending_approval'
          ? 'timeout_rejected'
          : init.status
  const badge = roundLog
    ? journalStatusBadge(init)
    : STATUS_BADGE[effectiveStatus] || { label: effectiveStatus, cls: 'pro-badge--muted' }
  const result = initiativeResult(init)
  const resultBadge = result ? RESULT_BADGE[result] : null
  const risk = RISK_BADGE[init.risk_level] || { label: init.risk_level || '—', cls: 'pro-risk--low' }
  const phase = roundLog ? journalPhase(init) : ''
  const phaseLabel = phase ? JOURNAL_PHASE_LABEL[phase] || phase : ''
  const typeLabel = roundLog
    ? phaseLabel || '工作记录'
    : ACTION_TYPE_LABEL[init.action_type] || init.action_type || '事项'
  const code = role.agent_code || init.role_agent_code

  const descClean = cleanWorkText(init.description)
  const goalClean = cleanWorkText(init.goal)
  const rationale = humanRationale(init.rationale, roster)
  // Prefer employee note (rationale) as the human-readable summary when present.
  const body =
    rationale ||
    (looksLikeInternalDispatchNote(descClean) ? '' : descClean) ||
    goalClean ||
    cleanWorkText(init.outcome) ||
    cleanWorkText(init.execution_result) ||
    descClean ||
    ''
  const showExtraDesc =
    Boolean(rationale) &&
    Boolean(descClean) &&
    !textLooksSimilar(descClean, rationale) &&
    !looksLikeInternalDispatchNote(descClean)
  const plan = roundLog ? null : actionablePlan(init.action_plan)
  const expected = String(init.expected_outcome || '').trim()
  const progressRaw = String(init.execution_result || '').trim()
  const showApprove = needsHumanApprove(init)

  const showGoal =
    String(init.goal || '').trim() &&
    !textLooksSimilar(init.goal, body) &&
    !textLooksSimilar(init.goal, init.title)
  const showOutcomeCtx =
    String(init.outcome || '').trim() &&
    !textLooksSimilar(init.outcome, body)
  const showExec =
    !roundLog &&
    progressRaw &&
    !textLooksSimilar(progressRaw, body) &&
    !textLooksSimilar(progressRaw, init.outcome)
  const showProgressTrail =
    Boolean(progressRaw) && (roundLog ? !textLooksSimilar(progressRaw, body) : showExec)
  const roundId = String(init.round_id || '').trim()
  const displayTitle = String(init.title || '')
    .replace(/^派发:\s*/i, '')
    .trim() || init.title

  return `
    <div class="pro-page-nav">
      <button type="button" class="btn btn-ghost btn-sm" data-act="back">← 返回 ${esc(role.role_name || code)}</button>
    </div>

    <header class="pro-item-hero">
      <div class="pro-item-hero-badges">
        <span class="pro-badge ${badge.cls}">${esc(badge.label)}</span>
        ${phaseLabel ? `<span class="pro-meta-chip pro-meta-chip--phase">${esc(phaseLabel)}</span>` : ''}
        ${!roundLog && resultBadge && resultBadge.label !== badge.label ? `<span class="pro-badge ${resultBadge.cls}">${esc(resultBadge.label)}</span>` : ''}
        ${roundLog ? '' : `<span class="pro-risk ${risk.cls}">${esc(risk.label)}</span>`}
        <span class="pro-meta-chip">${esc(typeLabel)}</span>
      </div>
      <h1 class="page-title">${esc(displayTitle)}</h1>
      <p class="page-desc">${esc(role.role_name || code)} · ${fmtTime(init.updated_at || init.created_at)}</p>
    </header>

    ${
      showApprove
        ? `<div class="pro-item-approve-bar">
            <p>需要你确认后，员工才会继续做</p>
            <div class="pro-item-approve-btns">
              <button type="button" class="btn btn-sm btn-primary" data-act="approve">同意</button>
              <button type="button" class="btn btn-sm btn-danger" data-act="reject">驳回</button>
            </div>
            <div class="pro-reject-panel" data-reject-panel hidden>
              <label class="pro-reject-label">驳回原因（必填）</label>
              <textarea class="pro-reject-input" rows="2" placeholder="简单说明原因，员工下一轮会看到"></textarea>
              <div class="pro-reject-actions">
                <button type="button" class="btn btn-sm btn-danger" data-act="reject-confirm">确认驳回</button>
                <button type="button" class="btn btn-sm btn-ghost" data-act="reject-cancel">取消</button>
              </div>
            </div>
          </div>`
        : ''
    }

    <div class="pro-item-sections">
      <section class="pro-item-section pro-item-section--body">
        <h3>${roundLog ? phaseLabel || '本轮记录' : '简要说明'}</h3>
        ${mdBlock(body || '（暂无说明）')}
      </section>

      ${
        showExtraDesc
          ? `<section class="pro-item-section">
              <h3>原始需求</h3>
              ${mdBlock(descClean)}
            </section>`
          : ''
      }

      ${
        showGoal
          ? `<section class="pro-item-section">
              <h3>本轮目标</h3>
              <p>${esc(init.goal)}</p>
            </section>`
          : ''
      }

      ${
        showOutcomeCtx
          ? `<section class="pro-item-section">
              <h3>本轮结果</h3>
              <p>${esc(init.outcome)}</p>
            </section>`
          : ''
      }

      ${
        plan
          ? `<section class="pro-item-section">
              <h3>行动计划</h3>
              ${
                plan.steps.length
                  ? `<ol class="pro-item-steps">${plan.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`
                  : ''
              }
              ${
                plan.files.length
                  ? `<p class="pro-item-plan-label">相关文件</p><ul class="pro-item-files">${plan.files.map((f) => `<li><code>${esc(f)}</code></li>`).join('')}</ul>`
                  : ''
              }
              ${
                plan.commands.length
                  ? `<p class="pro-item-plan-label">命令</p><ul class="pro-item-files">${plan.commands.map((c) => `<li><code>${esc(c)}</code></li>`).join('')}</ul>`
                  : ''
              }
              ${
                plan.extras.length
                  ? plan.extras
                      .map(([k, v]) => {
                        const val = typeof v === 'string' ? v : JSON.stringify(v, null, 2)
                        return `<p class="pro-item-plan-label">${esc(k)}</p><pre class="pro-detail-code">${esc(val)}</pre>`
                      })
                      .join('')
                  : ''
              }
            </section>`
          : ''
      }

      ${
        expected && !textLooksSimilar(expected, body)
          ? `<section class="pro-item-section">
              <h3>预期结果</h3>
              <p>${esc(expected)}</p>
            </section>`
          : ''
      }

      ${
        showProgressTrail
          ? `<section class="pro-item-section${result === 'failure' ? ' pro-item-section--fail' : result === 'success' ? ' pro-item-section--ok' : ''}">
              <h3>进度${result === 'success' ? ' · 成功' : result === 'failure' ? ' · 失败' : ''}</h3>
              ${formatProgressTrail(progressRaw)}
            </section>`
          : ''
      }

      ${
        init.approval_id || init.approval
          ? `<section class="pro-item-section">
              <h3>审批</h3>
              <p>${
                decided === 'approved'
                  ? `已同意 · ${esc(init.approved_by || init.approval?.decided_by || '—')} · ${fmtTime(init.approved_at || init.approval?.decided_at)}`
                  : decided === 'rejected'
                    ? `已驳回 · ${esc(init.approval?.decided_by || '—')} · ${fmtTime(init.approval?.decided_at)}`
                    : decided === 'timeout'
                      ? '审批超时，系统已自动拒绝'
                      : showApprove
                        ? '等待你确认'
                        : `审批人：${esc(init.approved_by || init.approval?.decided_by || '—')} · ${fmtTime(init.approved_at || init.approval?.decided_at)}`
              }</p>
              ${
                init.approval?.rejection_reason
                  ? `<p class="pro-item-reject-reason"><em>驳回原因</em>${esc(init.approval.rejection_reason)}</p>`
                  : ''
              }
            </section>`
          : ''
      }

      ${
        roundId
          ? `<section class="pro-item-section">
              <div class="pro-item-section-head">
                <h3>工作过程</h3>
                <button type="button" class="btn btn-sm btn-outline" data-act="open-trail" title="打开本轮工作过程">查看过程</button>
              </div>
            </section>`
          : ''
      }
    </div>
  `
}

function bindItemDetail(page, role, init) {
  const code = role.agent_code || init.role_agent_code
  page.querySelector('[data-act="back"]')?.addEventListener('click', () =>
    navigate(`/proactive/${encodeURIComponent(code)}`),
  )

  page.querySelector('[data-act="approve"]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget
    btn.disabled = true
    try {
      await api.proactiveApprove(init.id, 'approved', 'user', '')
      toast('已同意，开始执行', 'success')
      const next = await renderItemPage(code, init.id)
      page.replaceWith(next)
    } catch (err) {
      toast('审批失败: ' + err, 'error')
      btn.disabled = false
    }
  })
  page.querySelector('[data-act="reject"]')?.addEventListener('click', () => {
    const panel = page.querySelector('[data-reject-panel]')
    if (panel) panel.hidden = false
    panel?.querySelector('.pro-reject-input')?.focus()
  })
  page.querySelector('[data-act="reject-cancel"]')?.addEventListener('click', () => {
    const panel = page.querySelector('[data-reject-panel]')
    if (panel) {
      panel.hidden = true
      const ta = panel.querySelector('.pro-reject-input')
      if (ta) ta.value = ''
    }
  })
  page.querySelector('[data-act="reject-confirm"]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget
    const panel = page.querySelector('[data-reject-panel]')
    const reason = String(panel?.querySelector('.pro-reject-input')?.value || '').trim()
    if (!reason) {
      toast('请填写驳回原因', 'warning')
      panel?.querySelector('.pro-reject-input')?.focus()
      return
    }
    btn.disabled = true
    try {
      await api.proactiveApprove(init.id, 'rejected', 'user', reason, reason)
      toast('已驳回', 'info')
      const next = await renderItemPage(code, init.id)
      page.replaceWith(next)
    } catch (err) {
      toast('操作失败: ' + err, 'error')
      btn.disabled = false
    }
  })

  page.querySelector('[data-act="open-trail"]')?.addEventListener('click', () => {
    if (page._liveProcess?.isOpen?.()) {
      toast('过程窗口已打开', 'info')
      return
    }
    const roundId = String(init.round_id || '').trim()
    const at = String(init.created_at || init.updated_at || roundId || '').trim()
    ensureEmployeeLiveProcess(page, role, {
      busy: false,
      roundId: roundId || undefined,
      at: at || roundId,
      title: trailTitle(at || roundId, { busy: false }),
    })
    toast(roundId ? '已打开本轮工作过程' : '已打开工作过程', 'info')
  })
}

export function cleanup() {
  if (_currentPage) {
    try {
      _currentPage._employeeMoreDocClose?.()
    } catch {
      /* ignore */
    }
    stopPageWatch(_currentPage)
    destroyEmployeeLiveMount(_currentPage)
    _currentPage = null
  }
}
