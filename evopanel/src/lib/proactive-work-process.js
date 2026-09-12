/**
 * 智能体员工「工作过程」：Run 元数据、步骤分组、事件构建、搜索与导出。
 */
import { normalizeTime, extractPathFromToolInput, extractPathFromToolOutput } from './chat-normalize.js'
import { expandRowsToTrailTurns } from './subtask-modal-rows.js'
import { capitalizeToolName, resolveToolKey } from './tool-display.js'
import { resolveTaskOutputItems } from './task-summary.js'

/** @typedef {'step' | 'model' | 'tool' | 'file' | 'error' | 'status'} WorkProcessEventKind */

/**
 * @typedef {object} WorkProcessEvent
 * @property {string} id
 * @property {WorkProcessEventKind} kind
 * @property {string} timeLabel
 * @property {number | null} ts
 * @property {string} action
 * @property {string} [toolTitle]
 * @property {string} title
 * @property {string} status
 * @property {'completed' | 'running' | 'failed' | 'other'} statusKey
 * @property {number | null} durationMs
 * @property {boolean} isError
 * @property {string} input
 * @property {string} output
 * @property {string} errorText
 * @property {string} summary
 * @property {string} primaryAction
 * @property {string} filePath
 * @property {string} command
 * @property {string} searchBlob
 * @property {boolean} isSystemPrompt
 * @property {object | null} errorInsight
 */

export const WORK_PROCESS_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'error', label: '异常' },
  { key: 'step', label: '步骤' },
  { key: 'model', label: '模型' },
  { key: 'tool', label: '工具' },
  { key: 'file', label: '文件' },
]

export const WORK_PROCESS_STATUS_FILTERS = [
  { key: 'all', label: '全部状态' },
  { key: 'completed', label: '完成' },
  { key: 'running', label: '进行中' },
  { key: 'failed', label: '失败' },
]

export const WORK_PROCESS_KIND_ICON = {
  step: '▸',
  model: '◈',
  tool: '⚙',
  file: '📄',
  error: '⚠',
  status: '●',
}

export function encodeWorkProcessRunId(agentCode, roundId = '') {
  const code = String(agentCode || '').trim()
  const rid = String(roundId || '').trim()
  return encodeURIComponent(`${code}::${rid}`)
}

export function decodeWorkProcessRunId(runId) {
  let raw = String(runId || '').trim()
  try {
    raw = decodeURIComponent(raw)
  } catch {
    /* keep raw */
  }
  const idx = raw.indexOf('::')
  if (idx < 0) return { agentCode: raw, roundId: '' }
  return { agentCode: raw.slice(0, idx).trim(), roundId: raw.slice(idx + 2).trim() }
}

export function buildWorkProcessRunPath(agentCode, roundId = '', taskId = '') {
  const base = `/runs/${encodeWorkProcessRunId(agentCode, roundId)}`
  const tid = String(taskId || '').trim()
  return tid ? `${base}?task=${encodeURIComponent(tid)}` : base
}

export function isFileToolName(name) {
  return /read_file|write_file|str_replace|read_files|write_to_file|replace_in_file|delete_file|read_context|glob|grep|list_dir|filesystem|^read$|^write$|^replace$|^delete$/i.test(
    String(name || ''),
  )
}

export function isShellToolName(name) {
  return /bash|shell|terminal|execute_command|run_command|powershell|cmd/i.test(String(name || ''))
}

export function fmtWorkProcessDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  const totalSec = Math.max(0, Math.round(Number(ms) / 1000))
  if (totalSec < 1) return `${Math.round(Number(ms))}毫秒`
  if (totalSec < 60) return `${totalSec}秒`
  const days = Math.floor(totalSec / 86400)
  const hours = Math.floor((totalSec % 86400) / 3600)
  const minutes = Math.floor((totalSec % 3600) / 60)
  const seconds = totalSec % 60
  const parts = []
  if (days) parts.push(`${days}天`)
  if (hours) parts.push(`${hours}时`)
  if (minutes) parts.push(`${minutes}分`)
  // ≥1 小时不再带秒，避免「1天4小时34分49秒」撑爆摘要格
  if (!days && !hours && (seconds || !parts.length)) parts.push(`${seconds}秒`)
  return parts.join('')
}

/** 兼容旧格式如 1714m52s / 118m24s → 人类可读 */
export function fmtWorkProcessDurationLoose(value) {
  if (value == null || value === '') return '—'
  if (typeof value === 'number' && Number.isFinite(value)) return fmtWorkProcessDuration(value)
  const s = String(value).trim()
  if (!s || s === '—') return '—'
  const m = /^(\d+)m(\d+)s$/i.exec(s)
  if (m) return fmtWorkProcessDuration((Number(m[1]) * 60 + Number(m[2])) * 1000)
  const onlyM = /^(\d+)m$/i.exec(s)
  if (onlyM) return fmtWorkProcessDuration(Number(onlyM[1]) * 60 * 1000)
  const onlyS = /^(\d+(?:\.\d+)?)s$/i.exec(s)
  if (onlyS) return fmtWorkProcessDuration(Number(onlyS[1]) * 1000)
  const ms = /^(\d+)ms$/i.exec(s)
  if (ms) return fmtWorkProcessDuration(Number(ms[1]))
  return s
}

/**
 * Run / Task 状态拆分
 * @returns {{ runStatus: string, taskStatus: string, composite: string }}
 */
export function resolveRunTaskStatusLabels({ busy = false, taskStatus = '', hasEvents = false } = {}) {
  const raw = String(taskStatus || '').trim().toLowerCase().replace(/-/g, '_')
  let runStatus = '尚未开始'
  let taskLabel = '—'

  if (busy || /run|execut|progress|busy|working|verifying|reflecting/.test(raw)) {
    runStatus = '执行中'
  } else if (/fail|error|timed_out/.test(raw)) {
    runStatus = '执行失败'
  } else if (/cancel/.test(raw)) {
    runStatus = '已取消'
  } else if (
    hasEvents ||
    /complete|done|success|archived|reviewed|req_confirm|waiting_user|awaiting_close|waiting_confirmation/.test(
      raw,
    )
  ) {
    runStatus = '已完成'
  }

  if (
    raw === 'reviewed' ||
    raw === 'req_confirm' ||
    raw === 'waiting_user' ||
    raw === 'awaiting_close' ||
    raw === 'waiting_confirmation'
  ) {
    taskLabel = '待确认'
  } else if (/complete|done|success|archived/.test(raw)) {
    taskLabel = '已完成'
  } else if (/fail|error|timed_out/.test(raw)) {
    taskLabel = '异常'
  } else if (/cancel/.test(raw)) {
    taskLabel = '已取消'
  } else if (busy || /run|execut/.test(raw)) {
    taskLabel = '进行中'
  } else if (raw) {
    taskLabel = '处理中'
  }

  let composite = '尚未开始'
  if (runStatus === '执行中') composite = '执行中'
  else if (runStatus === '执行失败') composite = '执行失败'
  else if (runStatus === '已取消') composite = '已取消'
  else if (runStatus === '已完成' && taskLabel === '待确认') composite = '执行已完成 · 等待任务确认'
  else if (runStatus === '已完成') composite = '执行已完成'

  return { runStatus, taskStatus: taskLabel, composite }
}

/**
 * Run 组合状态文案（执行轨迹视角，不等于 Task 最终态）
 * @param {{ busy?: boolean, taskStatus?: string, hasEvents?: boolean }} opts
 */
export function formatRunCompositeStatus(opts = {}) {
  return resolveRunTaskStatusLabels(opts).composite
}

/** 展示用 runId：无效时标明历史记录，不用横线 */
export function formatRunIdDisplay(runId) {
  const s = String(runId || '').trim()
  if (!s || s === '—' || s === '-') return '历史运行记录'
  return s
}

export function fmtWorkProcessDateTime(ts) {
  if (ts == null || !Number.isFinite(Number(ts))) {
    const s = String(ts || '').trim()
    if (!s) return '—'
    const n = Date.parse(s)
    if (!Number.isFinite(n)) return s
    return fmtWorkProcessDateTime(n)
  }
  try {
    return new Date(Number(ts)).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
  } catch {
    return '—'
  }
}

function formatTrailClock(ts) {
  if (ts == null || !Number.isFinite(ts)) return '—'
  try {
    const d = new Date(ts)
    if (Number.isNaN(d.getTime())) return '—'
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  } catch {
    return '—'
  }
}

function tryParseJson(text) {
  const s = String(text || '').trim()
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/** 工具入参/出参可能是对象；避免 String(obj) → [object Object] */
function coerceToolText(value, max = 8000) {
  if (value == null || value === '') return ''
  if (typeof value === 'string') return value.slice(0, max)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).slice(0, max)
  try {
    return JSON.stringify(value, null, 2).slice(0, max)
  } catch {
    try {
      return String(value).slice(0, max)
    } catch {
      return ''
    }
  }
}

function coerceToolObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value === 'string') return tryParseJson(value)
  return null
}

function toolStatus(tool) {
  const st = String(tool?.status || tool?.state || '').toLowerCase()
  const errText = coerceToolText(tool?.error || tool?.output || tool?.result || '', 400)
  if (st === 'error' || st === 'failed' || /超时|失败|error|timeout|failed/i.test(errText.slice(0, 200))) {
    return { label: '失败', error: true, key: /** @type {const} */ ('failed') }
  }
  if (
    st === 'running' ||
    st === 'pending' ||
    st === 'in_progress' ||
    st === 'executing'
  ) {
    return { label: '进行中', error: false, key: /** @type {const} */ ('running') }
  }
  if (st === 'completed' || st === 'success' || st === 'done' || st === 'ok') {
    return { label: '完成', error: false, key: /** @type {const} */ ('completed') }
  }
  return { label: '完成', error: false, key: /** @type {const} */ ('completed') }
}

function extractCommand(name, input, parsed) {
  if (parsed && typeof parsed === 'object') {
    const c = parsed.command ?? parsed.cmd ?? parsed.script
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  if (isShellToolName(name)) {
    const s = String(input || '').trim()
    if (s && !s.startsWith('{')) return s.slice(0, 500)
  }
  return ''
}

const TASKS_ACTION_ZH = {
  get_status: '获取任务状态',
  update_progress: '更新任务进度',
  update_task: '更新任务',
  create_task: '创建任务',
  create_subtask: '创建子任务',
  create_subtasks: '批量创建子任务',
  list_subtasks: '列出子任务',
  complete_subtask: '完成子任务',
  assign_subtask: '分配子任务',
  start_execution: '开始执行',
  set_task_planned: '标记计划就绪',
  monitor_execution: '监控执行',
  monitor_execution_step: '监控执行进度',
}

/**
 * 内部工具名 → 自然语言标题；原始名保留在 action / 展开详情。
 */
export function resolveToolNaturalTitle(name, input = '', parsed = null) {
  const raw = String(name || '').trim() || '工具'
  const key = resolveToolKey({ name: raw })
  const obj = parsed && typeof parsed === 'object' ? parsed : tryParseJson(input)
  const action = String(obj?.action || obj?.op || obj?.method || obj?.name || '').trim().toLowerCase()

  if (key === 'tasks' || raw.toLowerCase() === 'tasks') {
    if (action && TASKS_ACTION_ZH[action]) return TASKS_ACTION_ZH[action]
    if (action === 'get' || action === 'get_task') return '获取任务'
    if (action) return `任务 · ${action}`
    return '任务工具'
  }
  if (key === 'bash' || key === 'execute_command' || key === 'terminal') {
    const cmd = extractCommand(raw, input, obj)
    return cmd ? `执行命令` : capitalizeToolName(raw)
  }
  try {
    return capitalizeToolName(raw) || raw
  } catch {
    return raw
  }
}

function errorFingerprint(ev) {
  const raw = String(ev.errorText || ev.output || ev.summary || '').trim()
  const normalized = raw
    .replace(/\b[0-9a-f]{8,}\b/gi, '#id')
    .replace(/\d{2,}/g, '#n')
    .replace(/\s+/g, ' ')
    .slice(0, 180)
    .toLowerCase()
  const type =
    /timeout|超时/i.test(raw)
      ? 'timeout'
      : /permission|denied|权限/i.test(raw)
        ? 'permission'
        : /not found|enoent|不存在/i.test(raw)
          ? 'not_found'
          : /budget|步数|token/i.test(raw)
            ? 'budget'
            : ev.action || ev.kind || 'error'
  return `${type}::${normalized || ev.action || 'unknown'}`
}

export function errorTypeLabel(type) {
  const map = {
    timeout: '超时',
    permission: '权限',
    not_found: '资源不存在',
    budget: '预算/步数',
  }
  return map[type] || type || '异常'
}

/**
 * 相同异常按类型 + 指纹聚合。
 * @param {WorkProcessEvent[]} events
 */
export function aggregateWorkProcessErrors(events) {
  /** @type {Map<string, any>} */
  const map = new Map()
  for (const ev of events || []) {
    if (!(ev.isError || ev.kind === 'error')) continue
    const fp = errorFingerprint(ev)
    const type = fp.split('::')[0]
    const cur = map.get(fp)
    if (!cur) {
      map.set(fp, {
        id: `errgrp-${map.size + 1}`,
        fingerprint: fp,
        type,
        typeLabel: errorTypeLabel(type),
        summary:
          truncate(ev.title, 72) ||
          truncate(ev.summary || ev.errorText || ev.action, 72) ||
          '异常',
        count: 1,
        firstTs: ev.ts,
        lastTs: ev.ts,
        firstTimeLabel: ev.timeLabel,
        lastTimeLabel: ev.timeLabel,
        actions: new Set([ev.action].filter(Boolean)),
        events: [ev],
      })
      continue
    }
    cur.count += 1
    cur.events.push(ev)
    if (ev.action) cur.actions.add(ev.action)
    if (ev.ts != null && (cur.firstTs == null || ev.ts < cur.firstTs)) {
      cur.firstTs = ev.ts
      cur.firstTimeLabel = ev.timeLabel
    }
    if (ev.ts != null && (cur.lastTs == null || ev.ts > cur.lastTs)) {
      cur.lastTs = ev.ts
      cur.lastTimeLabel = ev.timeLabel
    }
  }
  return [...map.values()]
    .map((g) => ({
      ...g,
      actions: [...g.actions],
      scope: g.actions.length ? `影响：${[...g.actions].slice(0, 3).join('、')}` : `影响：${g.count} 处事件`,
    }))
    .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
}

function extractFilePath(name, input, output, parsed) {
  return (
    extractPathFromToolInput(input, parsed) ||
    extractPathFromToolOutput(name, output) ||
    ''
  )
}

function truncate(text, n = 120) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/** 系统派发 / 超长任务 brief，默认不进搜索全文、不默认展开 */
export function isSystemPromptLike(text) {
  const s = String(text || '')
  if (s.length > 1800) return true
  const head = s.slice(0, 400)
  if (/^本轮值班开始\s*·/.test(head.trim())) return false
  return /^#\s*值班|##\s*本岗看板\s*Task|系统提示|system prompt|woken_by=|task_id=|工作指令|你是一名|续跑：|tasks\(action=/i.test(
    head,
  )
}

/** 人话值班节拍（可见开场），非内部 brief */
export function isDutyBeatText(text) {
  return /^本轮值班开始\s*·/.test(String(text || '').trim())
}

const WORK_PROCESS_WRAP_UP_RE =
  /本轮值班结束|本轮结束|巡检后收工|直接结束|已提交等待确认|等待你确认/

export function isWorkProcessWrapUpText(text) {
  return WORK_PROCESS_WRAP_UP_RE.test(String(text || ''))
}

function isSkippableLiveAnchor(ev) {
  if (!ev) return true
  if (ev.isSystemPrompt) return true
  if (ev.action === '用户输入' || ev.action === '值班节拍') return true
  return false
}

/**
 * 任务仍在跑时：把尚未落盘终态的最后一条工具/回复标成进行中。
 * @param {WorkProcessEvent[]} events
 * @param {{ live?: boolean }} [opts]
 */
export function annotateLiveWorkProcessEvents(events, opts = {}) {
  const list = Array.isArray(events) ? events : []
  const live = Boolean(opts.live)
  if (!live || !list.length) return list
  let idx = -1
  for (let i = list.length - 1; i >= 0; i--) {
    if (!isSkippableLiveAnchor(list[i])) {
      idx = i
      break
    }
  }
  if (idx < 0) return list
  const ev = list[idx]
  if (ev.isError || ev.statusKey === 'failed' || ev.statusKey === 'running') return list
  const blob = `${ev.summary || ''} ${ev.output || ''} ${ev.title || ''}`
  if (isWorkProcessWrapUpText(blob)) return list
  const noOutput = !String(ev.output || '').trim()
  const noDur = ev.durationMs == null || !Number.isFinite(Number(ev.durationMs))
  const canMarkTool = (ev.kind === 'tool' || ev.kind === 'file') && noOutput && noDur
  const canMarkModel = ev.kind === 'model'
  if (!canMarkTool && !canMarkModel) return list
  return list.map((e, i) => (i === idx ? { ...e, statusKey: 'running', status: '进行中' } : e))
}

/** @param {WorkProcessEvent[]} events */
export function pickLatestWorkProcessLive(events) {
  const list = Array.isArray(events) ? events : []
  if (!list.length) return null
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.statusKey === 'running') return list[i]
  }
  for (let i = list.length - 1; i >= 0; i--) {
    if (!isSkippableLiveAnchor(list[i])) return list[i]
  }
  return list[list.length - 1]
}

function clipLiveLine(text, n = 140) {
  const t = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (t.length <= n) return t
  return `${t.slice(0, n)}…`
}

/**
 * @param {WorkProcessEvent | null | undefined} ev
 * @param {{ live?: boolean }} [opts]
 */
export function formatWorkProcessLiveLine(ev, opts = {}) {
  const live = Boolean(opts.live)
  if (!ev) return live ? '正在执行…' : ''
  const running = ev.statusKey === 'running'
  const hint = clipLiveLine(ev.summary || ev.output || ev.title || ev.action || '')
  const name = clipLiveLine(ev.toolTitle || ev.title || ev.action || '工具', 80)
  if (ev.kind === 'tool' || ev.kind === 'file') {
    const tail = hint && hint !== name ? ` · ${hint}` : ''
    return running ? `正在调用：${name}${tail}` : `最新：${name}${tail}`
  }
  if (ev.kind === 'model') {
    const thinking = ev.action === '模型思考'
    const body = hint || (thinking ? '模型思考' : '模型回复')
    if (thinking) return running ? `正在思考：${body}` : `最新思考：${body}`
    return running ? `正在回复：${body}` : `最新回复：${body}`
  }
  if (ev.kind === 'error' || ev.isError) return `异常：${hint || ev.title || '执行失败'}`
  if (running) return `进行中：${hint || ev.title || ev.action || ''}`
  return hint || ev.title || ev.action || ''
}

/**
 * @param {WorkProcessEvent | null | undefined} ev
 * @param {{ live?: boolean }} [opts]
 */
export function formatWorkProcessLiveBanner(ev, opts = {}) {
  const live = Boolean(opts.live)
  const line = formatWorkProcessLiveLine(ev, opts)
  if (live && ev && ev.statusKey !== 'running' && line && !/^正在/.test(line)) {
    return `正在推进 · ${line}`
  }
  return line
}

/**
 * 默认隐藏内部指令事件；「显示内部指令」时保留。
 * @param {WorkProcessEvent[]} events
 * @param {{ showInternals?: boolean }} [opts]
 */
export function filterWorkProcessInternalEvents(events, opts = {}) {
  const list = Array.isArray(events) ? events : []
  if (opts.showInternals) return list
  return list.filter((e) => !e?.isSystemPrompt)
}

function makeSearchBlob(parts) {
  return parts.filter(Boolean).join('\n').toLowerCase()
}

/**
 * 默认搜索范围：标题、摘要、工具名、路径、错误、输出摘要；不含完整系统提示/隐藏参数。
 * @param {Partial<WorkProcessEvent>} ev
 */
function buildSearchBlob(ev) {
  const parts = [ev.title, ev.summary, ev.action, ev.toolTitle, ev.filePath, ev.command, ev.primaryAction, ev.status]
  if (ev.errorText) parts.push(truncate(ev.errorText, 400))
  if (!ev.isSystemPrompt && ev.output) parts.push(truncate(ev.output, 400))
  if (!ev.isSystemPrompt && ev.input && !/^\{/.test(String(ev.input).trim())) {
    parts.push(truncate(ev.input, 200))
  }
  // 工具参数只索引关键字段，不索引整段 JSON
  if (ev.kind === 'tool' || ev.kind === 'file') {
    parts.push(ev.filePath, ev.command, ev.action)
  }
  return makeSearchBlob(parts)
}

/**
 * @param {Partial<WorkProcessEvent> & { kind: WorkProcessEventKind, action: string }} ev
 */
export function buildEventNaturalSummary(ev) {
  if (ev.isError || ev.kind === 'error') {
    const reason = truncate(ev.errorText || ev.output || ev.action, 120)
    return reason || '执行过程中出现异常'
  }
  if (ev.kind === 'model') {
    const lines = String(ev.output || '')
      .split(/\n/)
      .map((l) =>
        l
          .replace(/^#+\s*/, '')
          .replace(/[*_`]/g, '')
          .replace(/^\|.*\|$/, '')
          .trim(),
      )
      .filter((l) => l && !/^[-:|]+$/.test(l))
    const what = truncate(lines[0] || '', 80)
    if (what) return what
    return ev.action === '模型思考' ? '模型进行了思考' : '模型生成了回复'
  }
  if (ev.kind === 'file' || isFileToolName(ev.action)) {
    const path = ev.filePath || '未知路径'
    if (/write|replace|edit|delete/i.test(ev.action)) return `写入或修改了 ${path}`
    return `读取了 ${path}`
  }
  if (ev.kind === 'tool' || isShellToolName(ev.action)) {
    if (ev.command) return `执行了命令 ${truncate(ev.command, 100)}`
    return `调用了工具 ${ev.action}`
  }
  if (ev.action === '值班节拍' || isDutyBeatText(ev.input)) {
    const lines = String(ev.input || '')
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    return lines.slice(1).join(' ') || lines[0] || '本轮值班开始'
  }
  if (ev.action === '用户输入') {
    if (ev.isSystemPrompt) return '收到值班/派发任务说明'
    return truncate(ev.input, 120) || '收到用户输入'
  }
  return truncate(ev.output || ev.input, 120) || ev.action || '步骤'
}

export function buildEventTitle(ev) {
  if (ev.isError || ev.kind === 'error') {
    const toolTitle = ev.toolTitle || ''
    return toolTitle ? `异常 · ${toolTitle}` : `异常 · ${ev.action || '执行失败'}`
  }
  if (ev.kind === 'model') {
    if (ev.action === '模型思考') return '模型思考'
    return '模型回复'
  }
  if (ev.kind === 'file') {
    const path = ev.filePath ? ` · ${truncate(ev.filePath, 48)}` : ''
    if (/write|replace|edit|delete/i.test(ev.action)) return `写入文件${path}`
    return `读取文件${path}`
  }
  if (ev.kind === 'tool') {
    const natural = ev.toolTitle || resolveToolNaturalTitle(ev.action, ev.input)
    // 标题即工具说明，不再叠「调用了工具 xxx」摘要
    if (natural && natural !== ev.action) return natural
    return `工具 · ${ev.action || '未知'}`
  }
  if (ev.action === '值班节拍' || isDutyBeatText(ev.input)) {
    const first = String(ev.input || '')
      .split(/\n/)
      .map((l) => l.trim())
      .find(Boolean)
    return first || '本轮值班开始'
  }
  if (ev.action === '用户输入') return ev.isSystemPrompt ? '接收任务' : '用户输入'
  return ev.action || '步骤'
}

export function buildEventPrimaryAction(ev) {
  if (ev.filePath) return ev.filePath
  if (ev.command) return truncate(ev.command, 80)
  if (ev.kind === 'model') return '生成回复'
  if (ev.action === '用户输入') return ev.isSystemPrompt ? '派发任务' : '提交输入'
  if (ev.action === '值班节拍') return '值班开场'
  if (ev.isError) return '处理异常'
  return ev.action || '—'
}

/**
 * @param {WorkProcessEvent} ev
 * @param {{ stepName?: string, affectsFinal?: boolean }} ctx
 */
export function buildErrorInsight(ev, ctx = {}) {
  const what = truncate(ev.errorText || ev.output || ev.summary, 100) || '未知错误'
  const stepName = ctx.stepName || '当前步骤'
  const affectsFinal = ctx.affectsFinal !== false
  let recommend = '查看错误详情并决定是否重试'
  if (/超时|timeout/i.test(what)) recommend = '检查耗时步骤，缩小范围后重试'
  else if (/permission|denied|无权|权限/i.test(what)) recommend = '检查文件/命令权限后重试'
  else if (/not found|不存在|ENOENT/i.test(what)) recommend = '确认路径是否存在，或改用正确文件'
  else if (/budget|步数|token/i.test(what)) recommend = '缩小任务范围或提高预算后重试'
  return {
    what: `发生了什么：${what}`,
    step: `影响步骤：${stepName}`,
    impact: affectsFinal ? '是否影响最终结果：可能影响本轮结果' : '是否影响最终结果：局部问题，后续步骤已继续',
    recommend: `推荐操作：${recommend}`,
  }
}

/**
 * expandRowsToTrailTurns 会把正文只放在 segments 里、text 置空（避免子任务弹窗重复渲染）。
 * 工作过程事件需从 segments / reasoningPreview 回填。
 */
function extractTurnText(row) {
  const direct = String(row?.text || '').trim()
  if (direct) return direct
  const segs = Array.isArray(row?.segments) ? row.segments : []
  const parts = []
  for (const seg of segs) {
    const kind = String(seg?.kind || '').trim()
    if (kind !== 'text' && kind !== 'reasoning') continue
    const t = String(seg?.text || '').trim()
    if (t) parts.push(t)
  }
  if (parts.length) return parts.join('\n\n')
  return String(row?.reasoningPreview || '').trim()
}

function turnHasReasoning(row) {
  if (String(row?.reasoningPreview || '').trim()) return true
  const segs = Array.isArray(row?.segments) ? row.segments : []
  return segs.some((seg) => String(seg?.kind || '').trim() === 'reasoning' && String(seg?.text || '').trim())
}

/**
 * @param {any[]} rows
 * @returns {WorkProcessEvent[]}
 */
export function buildWorkProcessEvents(rows) {
  const turns = expandRowsToTrailTurns(rows || [])
  /** @type {WorkProcessEvent[]} */
  const events = []

  for (const turn of turns) {
    const row = turn.row || {}
    const ts = normalizeTime(turn.timestamp ?? row.timestamp) ?? null
    const tools = Array.isArray(row.tools) ? row.tools : []
    const text = extractTurnText(row)
    const role = String(row.role || '').trim()
    const isReasoning = turnHasReasoning(row) && !String(row?.text || '').trim()

    if (tools.length) {
      for (const tool of tools) {
        const name = String(tool?.name || tool?.tool || '工具').trim()
        const rawInput = tool.args ?? tool.input ?? tool.arguments ?? ''
        const input = coerceToolText(rawInput)
        const output = coerceToolText(tool.output ?? tool.result ?? '')
        const st = toolStatus(tool)
        const errorText = coerceToolText(tool.error || (st.error ? output : '') || '', 4000)
        const parsed = coerceToolObject(rawInput) || tryParseJson(input)
        const file = isFileToolName(name)
        const start = normalizeTime(tool.time || tool.messageTimestamp) ?? ts
        const explicitDur =
          tool.duration_ms != null
            ? Number(tool.duration_ms)
            : tool.duration != null
              ? Number(tool.duration)
              : null
        const dur = explicitDur != null && Number.isFinite(explicitDur) && explicitDur >= 0 ? explicitDur : null
        const filePath = extractFilePath(name, input, output, parsed) || ''
        const command = extractCommand(name, input, parsed)
        const toolTitle = resolveToolNaturalTitle(name, input, parsed)
        /** @type {WorkProcessEventKind} */
        const kind = st.error ? 'error' : file ? 'file' : 'tool'
        /** @type {WorkProcessEvent} */
        const base = {
          id: `tool-${tool.id || tool.tool_call_id || events.length}`,
          kind,
          timeLabel: formatTrailClock(start),
          ts: start,
          action: name,
          toolTitle,
          title: '',
          status: st.label,
          statusKey: st.key,
          durationMs: dur,
          isError: st.error,
          input,
          output,
          errorText,
          filePath,
          command,
          summary: '',
          primaryAction: '',
          searchBlob: '',
          isSystemPrompt: false,
          errorInsight: null,
        }
        base.title = buildEventTitle(base)
        base.summary = buildEventNaturalSummary(base)
        base.primaryAction = buildEventPrimaryAction(base)
        base.searchBlob = buildSearchBlob(base)
        if (base.isError) base.errorInsight = buildErrorInsight(base)
        events.push(base)
      }
      // Same turn may also carry assistant body (duty wrap-up after tools).
      if (!text) continue
    }

    if (!text) continue
    const dur = null
    const beatLike = role === 'user' && isDutyBeatText(text)
    const systemLike = role === 'user' && !beatLike && isSystemPromptLike(text)
    // 模型叙事里常出现「失败/异常」字样（工作汇报、巡检），不标为异常事件；
    // 真实工具失败已由 tools[].error 单独成事件。
    const textLooksError =
      role !== 'user' &&
      role !== 'assistant' &&
      /(?:^|\n)\s*(?:错误|失败|异常|Error|Exception|Traceback)/i.test(text.slice(0, 400))

    /** @type {WorkProcessEventKind} */
    let kind = 'step'
    if (textLooksError) kind = 'error'
    else if (role === 'assistant') kind = 'model'
    else if (role === 'user') kind = 'step'

    const action =
      role === 'user'
        ? beatLike
          ? '值班节拍'
          : '用户输入'
        : role === 'assistant'
          ? isReasoning
            ? '模型思考'
            : '模型回复'
          : '步骤'
    const streamingText = role === 'assistant' && !tools.length && Boolean(row?.isStreaming || row?.streaming)
    /** @type {WorkProcessEvent} */
    const base = {
      id: `step-${turn.id || events.length}`,
      kind,
      timeLabel: formatTrailClock(ts),
      ts,
      action,
      title: '',
      status: textLooksError ? '异常' : streamingText ? '进行中' : '完成',
      statusKey: textLooksError ? 'failed' : streamingText ? 'running' : 'completed',
      durationMs: dur,
      isError: textLooksError,
      input: role === 'user' ? text : '',
      output: role !== 'user' ? text : '',
      errorText: textLooksError ? text : '',
      filePath: '',
      command: '',
      summary: '',
      primaryAction: '',
      searchBlob: '',
      isSystemPrompt: systemLike,
      errorInsight: null,
    }
    base.title = buildEventTitle(base)
    base.summary = buildEventNaturalSummary(base)
    base.primaryAction = buildEventPrimaryAction(base)
    base.searchBlob = buildSearchBlob(base)
    if (base.isError) base.errorInsight = buildErrorInsight(base)
    events.push(base)
  }
  return events
}

/**
 * 按业务阶段分组：模型/工具/文件作为阶段内子事件。
 * 阶段名示例：接收并分析任务 → 查找相关资料 → 生成推广素材 → 保存交付文件 → 提交等待确认
 * @param {WorkProcessEvent[]} events
 */
export function groupEventsIntoSteps(events) {
  const PHASE_ORDER = [
    '接收并分析任务',
    '查找相关资料',
    '生成推广素材',
    '保存交付文件',
    '提交等待确认',
    '异常处理',
  ]

  const phaseRank = (name) => {
    const i = PHASE_ORDER.indexOf(name)
    return i < 0 ? 0 : i
  }

  const inferPhase = (ev) => {
    if (ev.isError || ev.kind === 'error') return '异常处理'
    if (ev.action === '用户输入' || ev.action === '值班节拍' || ev.isSystemPrompt) return '接收并分析任务'
    if (ev.kind === 'model' && !ev.isSystemPrompt) {
      // 末段模型回复偏交付总结；前段偏分析
      return '生成推广素材'
    }
    if (
      (ev.kind === 'file' && /read|glob|grep|list|search/i.test(ev.action)) ||
      /web_search|search_content|search_code|find_file|^read$|read_file|rg|grep/i.test(ev.action)
    ) {
      return '查找相关资料'
    }
    if (ev.kind === 'file' && /write|replace|edit|delete/i.test(ev.action)) {
      return '保存交付文件'
    }
    if (
      /tasks|update_progress|complete_subtask|goal_report|outcome|submit|set_task/i.test(ev.action) ||
      /提交|等待确认|更新任务|完成子任务/.test(String(ev.toolTitle || ''))
    ) {
      return '提交等待确认'
    }
    if (ev.kind === 'tool' || ev.kind === 'file') return '查找相关资料'
    if (ev.kind === 'model') return '接收并分析任务'
    return '接收并分析任务'
  }

  /** @type {{ id: string, index: number, name: string, phase: string, status: string, statusKey: string, eventCount: number, errorCount: number, durationMs: number | null, events: WorkProcessEvent[], hasRunning: boolean, hasError: boolean }[]} */
  const steps = []
  let current = null
  let index = 0
  let maxRank = -1

  const openStep = (phase) => {
    index += 1
    current = {
      id: `phase-${index}`,
      index,
      phase,
      name: phase,
      status: '完成',
      statusKey: 'completed',
      eventCount: 0,
      errorCount: 0,
      durationMs: null,
      events: [],
      hasRunning: false,
      hasError: false,
    }
    steps.push(current)
    if (phase !== '异常处理') maxRank = Math.max(maxRank, phaseRank(phase))
  }

  for (const ev of events || []) {
    let phase = inferPhase(ev)
    // 首轮模型跟在用户输入后，并入「接收并分析任务」
    if (
      phase === '生成推广素材' &&
      current?.phase === '接收并分析任务' &&
      current.events.length <= 3 &&
      ev.kind === 'model'
    ) {
      phase = '接收并分析任务'
    }
    // 不允许业务阶段回退（异常除外）
    if (phase !== '异常处理' && phaseRank(phase) < maxRank) {
      phase = PHASE_ORDER[maxRank] || phase
    }
    const shouldOpen =
      !current ||
      current.phase !== phase ||
      (phase === '异常处理' && current.phase === '异常处理' && current.events.length >= 8)
    if (shouldOpen) openStep(phase)
    current.events.push(ev)
  }

  // 若末段只有模型且前面已有产出，重命名为提交等待确认
  if (steps.length >= 2) {
    const last = steps[steps.length - 1]
    const prevHasSave = steps.some((s) => s.phase === '保存交付文件')
    if (
      last.phase === '生成推广素材' &&
      prevHasSave &&
      last.events.every((e) => e.kind === 'model' || e.kind === 'step')
    ) {
      last.phase = '提交等待确认'
      last.name = '提交等待确认'
    }
  }

  for (const step of steps) {
    step.eventCount = step.events.length
    step.errorCount = step.events.filter((e) => e.isError || e.kind === 'error').length
    step.hasError = step.errorCount > 0
    step.hasRunning = step.events.some((e) => e.statusKey === 'running')
    const times = step.events.map((e) => e.ts).filter((t) => t != null)
    step.durationMs = times.length >= 2 ? Math.max(...times) - Math.min(...times) : step.events[0]?.durationMs ?? null
    if (step.hasRunning) {
      step.status = '进行中'
      step.statusKey = 'running'
    } else if (step.hasError) {
      step.status = '异常'
      step.statusKey = 'failed'
    } else {
      step.status = '完成'
      step.statusKey = 'completed'
    }
    for (const ev of step.events) {
      if (ev.isError || ev.kind === 'error') {
        ev.errorInsight = buildErrorInsight(ev, {
          stepName: step.name,
          affectsFinal: step.hasError && steps[steps.length - 1]?.id === step.id,
        })
      }
    }
  }
  return steps
}

export function summarizeWorkProcess(events, rows, roundTokens = null, deliverableCount = null) {
  const list = events || []
  const times = list.map((e) => e.ts).filter((t) => t != null)
  const durationMs = times.length >= 2 ? Math.max(...times) - Math.min(...times) : null
  const toolCalls = list.filter((e) => e.kind === 'tool' || e.kind === 'file' || (e.kind === 'error' && (e.command || e.filePath))).length
  const fileReads = list.filter((e) => e.kind === 'file' || isFileToolName(e.action)).length
  const errorList = list.filter((e) => e.isError || e.kind === 'error')
  const errors = errorList.length
  const errorGroups = aggregateWorkProcessErrors(errorList)
  const errorGroupCount = errorGroups.length
  const errorsLabel =
    errors > 0 ? `${errorGroupCount || 1}类异常 · 发生${errors}次` : '0类异常'
  const modelCalls = list.filter((e) => e.kind === 'model').length
  const outputEvents = list.filter(
    (e) =>
      (e.kind === 'file' && /write|replace|edit|delete/i.test(e.action)) ||
      /outcome|report|交付|complete_subtask|goal_report/i.test(String(e.action || '')),
  ).length
  const hasDeliverables = deliverableCount != null && Number.isFinite(Number(deliverableCount))
  const outputs = hasDeliverables ? Number(deliverableCount) : outputEvents
  const outputsLabel = hasDeliverables ? '交付物' : '产出事件'

  let tokens = /** @type {number | null} */ (null)
  if (roundTokens != null && Number.isFinite(Number(roundTokens)) && Number(roundTokens) > 0) {
    tokens = Math.round(Number(roundTokens))
  } else {
    let sum = 0
    let found = false
    for (const row of rows || []) {
      const u = row?.usage || row?.token_usage || row?.usage_metadata || null
      const n =
        Number(u?.total_tokens ?? u?.totalTokens ?? row?.total_tokens ?? row?.tokens) ||
        (Number(u?.input_tokens || u?.prompt_tokens || 0) +
          Number(u?.output_tokens || u?.completion_tokens || 0))
      if (Number.isFinite(n) && n > 0) {
        sum += n
        found = true
      }
    }
    if (found) tokens = Math.round(sum)
  }

  return {
    durationMs,
    toolCalls,
    fileReads,
    errors,
    errorGroupCount,
    errorsLabel,
    modelCalls,
    outputs,
    outputsLabel,
    tokens,
    /** @deprecated 摘要栏已改 Token；保留字段避免旧调用报错 */
    cost: '—',
  }
}

/** 摘要栏 Token 短显示：1234 / 12.3k / 1.2M */
export function fmtWorkProcessTokens(n) {
  if (n == null || !Number.isFinite(Number(n)) || Number(n) <= 0) return '—'
  const v = Math.round(Number(n))
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}k`
  return v.toLocaleString()
}

/**
 * @param {WorkProcessEvent[]} events
 * @param {{ kind?: string, statusKey?: string, query?: string, timeFrom?: number | null, timeTo?: number | null }} opts
 */
export function filterWorkProcessEvents(events, opts = {}) {
  const kind = String(opts.kind || 'all')
  const statusKey = String(opts.statusKey || 'all')
  const query = String(opts.query || '').trim().toLowerCase()
  const timeFrom = opts.timeFrom != null && Number.isFinite(opts.timeFrom) ? opts.timeFrom : null
  const timeTo = opts.timeTo != null && Number.isFinite(opts.timeTo) ? opts.timeTo : null

  return (events || []).filter((e) => {
    if (kind === 'error') {
      if (!(e.isError || e.kind === 'error')) return false
    } else if (kind === 'tool') {
      if (!(e.kind === 'tool' || (e.kind === 'error' && e.command))) return false
    } else if (kind !== 'all' && e.kind !== kind) {
      return false
    }
    if (statusKey !== 'all' && e.statusKey !== statusKey) return false
    if (timeFrom != null && (e.ts == null || e.ts < timeFrom)) return false
    if (timeTo != null && (e.ts == null || e.ts > timeTo)) return false
    if (query && !String(e.searchBlob || '').includes(query)) return false
    return true
  })
}

/** @param {string} text @param {string} query */
export function highlightWorkProcessText(text, query) {
  const src = String(text ?? '')
  const q = String(query || '').trim()
  if (!q || !src) return [{ text: src, hit: false }]
  const lower = src.toLowerCase()
  const needle = q.toLowerCase()
  /** @type {{ text: string, hit: boolean }[]} */
  const parts = []
  let i = 0
  while (i < src.length) {
    const at = lower.indexOf(needle, i)
    if (at < 0) {
      parts.push({ text: src.slice(i), hit: false })
      break
    }
    if (at > i) parts.push({ text: src.slice(i, at), hit: false })
    parts.push({ text: src.slice(at, at + needle.length), hit: true })
    i = at + needle.length
  }
  return parts.length ? parts : [{ text: src, hit: false }]
}

export function collectWorkProcessMatchIds(events, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return []
  return (events || []).filter((e) => String(e.searchBlob || '').includes(q)).map((e) => e.id)
}

const TRIGGER_LABEL = {
  dispatch: '人工派发',
  round: '值班巡检',
  patrol: '定时巡检',
  heartbeat: '心跳触发',
  resume: '续跑',
  chat: '会话触发',
  manual: '手动',
}

export function inferTriggerType(roundId, task) {
  const rid = String(roundId || task?.round_id || task?.source_ref || '').trim()
  const src = String(task?.source || '').trim().toLowerCase()
  const m = /^(dispatch|round|patrol|heartbeat|resume):/i.exec(rid)
  if (m) return TRIGGER_LABEL[m[1].toLowerCase()] || m[1]
  if (src.includes('dispatch')) return TRIGGER_LABEL.dispatch
  if (src.includes('patrol') || src.includes('cron')) return TRIGGER_LABEL.patrol
  if (src.includes('chat')) return TRIGGER_LABEL.chat
  if (rid) return '值班轮次'
  return TRIGGER_LABEL.manual
}

/**
 * 从工作看板 Tasks + 消息时间戳组装 Run 视图模型，并列出同任务的多次运行。
 */
export function buildWorkProcessRunRecord({
  agentCode,
  roleName,
  roundId,
  preferredTaskId,
  tasks,
  events,
  busy,
  sessionKey,
}) {
  const code = String(agentCode || '').trim()
  const rid = String(roundId || '').trim()
  const list = Array.isArray(tasks) ? tasks : []

  const roundOf = (t) => String(t?.round_id || t?.source_ref || '').trim()
  const idOf = (t) => String(t?.task_id || t?.id || '').trim()

  let primary =
    (preferredTaskId && list.find((t) => idOf(t) === String(preferredTaskId).trim())) ||
    list.find((t) => roundOf(t) === rid) ||
    null

  const parentId = primary ? String(primary.parent_task_id || '').trim() : ''
  const familyKey = primary
    ? parentId || idOf(primary)
    : ''

  /** 同任务族（自身 / 同 parent / 同名）下带 round 的运行 */
  const related = []
  const seenRound = new Set()
  for (const t of list) {
    const r = roundOf(t)
    if (!r || seenRound.has(r)) continue
    const tid = idOf(t)
    const sameFamily =
      primary &&
      (tid === idOf(primary) ||
        (parentId && (tid === parentId || String(t.parent_task_id || '') === parentId)) ||
        (!parentId && String(t.name || '') === String(primary.name || '') && String(t.name || '')))
    if (primary ? sameFamily : r === rid) {
      seenRound.add(r)
      related.push(t)
    }
  }
  if (rid && !seenRound.has(rid)) {
    related.unshift(
      primary || {
        task_id: preferredTaskId || '',
        name: roleName ? `${roleName} · 本轮工作` : '本轮工作',
        round_id: rid,
        status: busy ? 'running' : 'completed',
      },
    )
  }

  related.sort((a, b) => {
    const ta = Date.parse(String(a.created_at || a.updated_at || '')) || 0
    const tb = Date.parse(String(b.created_at || b.updated_at || '')) || 0
    return ta - tb
  })

  const attempts = related.map((t, i) => {
    const r = roundOf(t) || rid
    return {
      attempt: i + 1,
      runId: r,
      taskId: idOf(t),
      taskName: String(t.name || t.title || '').trim(),
      status: String(t.status || '').trim(),
      createdAt: t.created_at || t.updated_at || '',
      isCurrent: r === rid,
    }
  })
  const currentAttempt = attempts.find((a) => a.isCurrent) || attempts[attempts.length - 1] || null

  if (!primary && currentAttempt?.taskId) {
    primary = list.find((t) => idOf(t) === currentAttempt.taskId) || primary
  }

  const evTimes = (events || []).map((e) => e.ts).filter((t) => t != null)
  const startedAt =
    evTimes.length ? Math.min(...evTimes) : Date.parse(String(primary?.created_at || '')) || null
  const completedAt = busy
    ? null
    : evTimes.length
      ? Math.max(...evTimes)
      : Date.parse(String(primary?.updated_at || '')) || null
  const duration =
    startedAt != null && completedAt != null
      ? Math.max(0, completedAt - startedAt)
      : startedAt != null && busy
        ? Math.max(0, Date.now() - startedAt)
        : null

  const statusLabels = resolveRunTaskStatusLabels({
    busy,
    taskStatus: primary?.status || (events?.length ? 'completed' : ''),
    hasEvents: Boolean(events?.length),
  })

  const taskName =
    String(primary?.name || primary?.title || currentAttempt?.taskName || '').trim() ||
    (roleName ? `${roleName}的工作过程` : '工作过程')

  let deliverables = null
  if (primary) {
    try {
      deliverables = resolveTaskOutputItems(primary).length
    } catch {
      deliverables = Array.isArray(primary?.outputs)
        ? primary.outputs.length
        : Array.isArray(primary?.result_outputs)
          ? primary.result_outputs.length
          : null
    }
  }

  const hasValidRunId = Boolean(rid)

  return {
    id: rid || `${code}-run`,
    taskId: idOf(primary) || preferredTaskId || '',
    taskName,
    runId: hasValidRunId ? rid : '',
    runIdDisplay: formatRunIdDisplay(rid),
    hasValidRunId,
    attempt: currentAttempt?.attempt || 1,
    attemptTotal: Math.max(1, attempts.length),
    attempts,
    triggerType: inferTriggerType(rid, primary),
    executorId: code,
    executorName: roleName || code,
    status: statusLabels.composite,
    runStatus: statusLabels.runStatus,
    taskStatusLabel: statusLabels.taskStatus,
    taskStatus: String(primary?.status || '').trim(),
    startedAt,
    completedAt,
    duration,
    deliverableCount: deliverables,
    sourceEmployee: roleName || code,
    sourceSession: sessionKey || (code ? `proactive:${code}` : ''),
    events: events || [],
  }
}

export function exportWorkProcessAsMarkdown(events, meta = {}) {
  const title = meta.title || meta.taskName || '工作过程'
  const lines = [`# ${title}`, '']
  if (meta.taskId) lines.push(`- taskId：${meta.taskId}`)
  if (meta.runId) lines.push(`- runId：${meta.runId}`)
  if (meta.summaryAgent) lines.push(`- 执行者：${meta.summaryAgent}`)
  if (meta.statusLabel) lines.push(`- 状态：${meta.statusLabel}`)
  lines.push('')
  for (const e of events || []) {
    lines.push(`## [${e.timeLabel}] ${e.title || e.action} · ${e.status} · ${fmtWorkProcessDuration(e.durationMs)}`)
    lines.push('')
    lines.push(e.summary || '')
    if (e.filePath) lines.push(`- 文件：\`${e.filePath}\``)
    if (e.command) lines.push(`- 命令：\`${e.command}\``)
    if (e.input) lines.push('', '### 输入', '```', e.input, '```')
    if (e.output) lines.push('', '### 输出', '```', e.output, '```')
    if (e.errorText) lines.push('', '### 错误', '```', e.errorText, '```')
    lines.push('')
  }
  return lines.join('\n')
}

export function exportWorkProcessAsJson(events, meta = {}) {
  return JSON.stringify(
    {
      title: meta.title || meta.taskName || '工作过程',
      taskId: meta.taskId || '',
      runId: meta.runId || '',
      agent: meta.summaryAgent || '',
      status: meta.statusLabel || '',
      exportedAt: new Date().toISOString(),
      events: (events || []).map((e) => ({
        id: e.id,
        kind: e.kind,
        time: e.timeLabel,
        ts: e.ts,
        title: e.title,
        action: e.action,
        status: e.status,
        durationMs: e.durationMs,
        summary: e.summary,
        filePath: e.filePath || undefined,
        command: e.command || undefined,
        input: e.input || undefined,
        output: e.output || undefined,
        error: e.errorText || undefined,
      })),
    },
    null,
    2,
  )
}

export function downloadWorkProcessText(text, filename, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function copyWorkProcessPlain(events) {
  return (events || [])
    .map((e) => {
      const parts = [`[${e.timeLabel}] ${e.title || e.action} · ${e.summary} · ${e.status} · ${fmtWorkProcessDuration(e.durationMs)}`]
      if (e.input) parts.push(`输入:\n${e.input}`)
      if (e.output) parts.push(`输出:\n${e.output}`)
      if (e.errorText) parts.push(`错误:\n${e.errorText}`)
      return parts.join('\n')
    })
    .join('\n\n')
}
