/**
 * 智能体员工 · 岗位工作项看板
 * 只按 assigned_role（岗位显示名）归并；不含仅 assigned_to=agent_code 的历史协作任务。
 */
import { normalizeTaskStatusKey, formatTaskStatusZh, toTaskStatusGroup } from './task-status-label.js'
import { formatTaskSourceZh } from './task-source.js'
import { buildRaisedByRoleLookup, formatRaisedByLabel } from './task-raised-by.js'

export const ROLE_TASK_LIST_PREVIEW = 5

function esc(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function previewLine(text, max = 72) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function emptyTaskStat() {
  return { total: 0, executing: 0, completed: 0, failed: 0, paused: 0, planning: 0, pending: 0 }
}

function bumpTaskStat(stat, status) {
  stat.total++
  const s = normalizeTaskStatusKey(status)
  if (s === 'executing' || s === 'in_progress' || s === 'running' || s === 'active' || s === 'verifying' || s === 'reflecting' || s === 'waiting_dispatch') stat.executing++
  else if (s === 'reviewed' || s === 'completed' || s === 'done' || s === 'success') stat.completed++
  else if (s === 'failed' || s === 'error' || s === 'timed_out') stat.failed++
  else if (s === 'paused') stat.paused++
  else if (s === 'planning' || s === 'planned' || s === 'plan_ready' || s === 'awaiting_exec') stat.planning++
  else if (s === 'pending' || s === 'idle' || s === 'req_confirm') stat.pending++
}

function taskGroupSortRank(status) {
  const g = toTaskStatusGroup(status)
  const order = {
    executing: 0,
    planning: 1,
    pending: 2,
    paused: 3,
    failed: 4,
    completed: 5,
    cancelled: 6,
  }
  return order[g] ?? 8
}

function taskProgressValue(row, status) {
  const s = normalizeTaskStatusKey(status)
  if (s === 'completed' || s === 'done' || s === 'success' || s === 'reviewed') return 100
  const n = Number(row?.progress)
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0
}

function taskStatusToneClass(status) {
  const g = toTaskStatusGroup(status)
  if (g === 'executing' || g === 'planning') return 'pro-role-task-item-status--active'
  if (g === 'completed') return 'pro-role-task-item-status--done'
  if (g === 'failed') return 'pro-role-task-item-status--fail'
  if (g === 'paused') return 'pro-role-task-item-status--paused'
  return ''
}

/** @param {unknown} row */
function assignedRoleKey(row) {
  return String(row?.assigned_role || '').trim().toLowerCase()
}

/**
 * 按岗位名（assigned_role）归并。未打岗位戳的历史任务不计入。
 * 同一 source_ref（旧 initiative_id / round 关联）只保留一条，避免双写回流重复。
 * @param {Array<Record<string, unknown>>} roles
 * @param {Array<Record<string, unknown>>} tasks
 */
export function buildRoleTaskBoards(roles, tasks) {
  /** @type {Map<string, { stat: ReturnType<typeof emptyTaskStat>, items: Array<Record<string, unknown>> }>} */
  const byRoleName = new Map()
  /** @type {Set<string>} */
  const seenSourceRef = new Set()
  const raisedLookup = buildRaisedByRoleLookup(roles)

  const ensure = (rnKey) => {
    if (!byRoleName.has(rnKey)) byRoleName.set(rnKey, { stat: emptyTaskStat(), items: [] })
    return byRoleName.get(rnKey)
  }

  const pushItem = (row, meta) => {
    const rnKey = assignedRoleKey(row)
    if (!rnKey) return
    const srcRef = String(row?.source_ref || '').trim()
    if (srcRef) {
      const dedupeKey = `${rnKey}::${srcRef}`
      if (seenSourceRef.has(dedupeKey)) return
      seenSourceRef.add(dedupeKey)
    }
    const bucket = ensure(rnKey)
    bumpTaskStat(bucket.stat, row.status)
    const raisedBy = String(row.raised_by || '').trim()
    bucket.items.push({
      mainTaskId: meta.mainTaskId,
      subtaskId: meta.subtaskId || '',
      name: String(row.name || row.title || '未命名任务').trim() || '未命名任务',
      description: String(row.description || '').trim(),
      summary: String(row.summary || row.result || row.outcome || '').trim(),
      status: row.status,
      progress: taskProgressValue(row, row.status),
      isSubtask: !!meta.subtaskId,
      assignedRole: String(row.assigned_role || '').trim(),
      raisedBy,
      raisedByLabel: formatRaisedByLabel(raisedBy, raisedLookup),
      parentTaskId: String(row.parent_task_id || '').trim(),
      sourceRef: srcRef,
      source: String(row.source || '').trim(),
      sourceZh: formatTaskSourceZh(row.source_zh || row.source),
      updatedAt: String(row.updated_at || row.completed_at || row.created_at || ''),
      createdAt: String(row.created_at || row.createdAt || ''),
      risk: String(row.risk_level || row.risk || row.priority || '').trim().toLowerCase(),
    })
  }

  for (const t of tasks || []) {
    const mainId = String(t.id || '').trim()
    if (!mainId) continue
    pushItem(t, { mainTaskId: mainId, subtaskId: '' })
    for (const st of Array.isArray(t.subtasks) ? t.subtasks : []) {
      pushItem(st, {
        mainTaskId: mainId,
        subtaskId: String(st.id || '').trim(),
      })
    }
  }

  for (const bucket of byRoleName.values()) {
    bucket.items.sort((a, b) => {
      const ra = taskGroupSortRank(a.status) - taskGroupSortRank(b.status)
      if (ra !== 0) return ra
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
    })
  }

  // Only keep role_name keys that exist on the roster (optional index for lookup)
  /** @type {Map<string, string>} role_name(lower) → canonical role_name */
  const roleNameCanon = new Map()
  for (const r of roles || []) {
    const rn = String(r.role_name || '').trim()
    if (!rn) continue
    roleNameCanon.set(rn.toLowerCase(), rn)
  }

  return { byRoleName, roleNameCanon }
}

export function boardForRole(role, boards) {
  const rnKey = String(role?.role_name || '').trim().toLowerCase()
  if (!rnKey) return null
  return boards.byRoleName.get(rnKey) || null
}

function renderRoleTaskItemHtml(item, extraClass = '', agentCode = '') {
  const statusZh = formatTaskStatusZh(item.status)
  const tone = taskStatusToneClass(item.status)
  const title = previewLine(item.name, 64)
  const group = toTaskStatusGroup(item.status)
  const handoff = String(item.summary || '').trim()
  const showHandoff = Boolean(handoff) && (group === 'reviewed' || group === 'completed' || group === 'failed')
  const desc = showHandoff
    ? previewLine(handoff, 96)
    : (item.description ? previewLine(item.description, 96) : '')
  const sourceZh = item.sourceZh || formatTaskSourceZh(item.source)
  const raiserLabel = String(item.raisedByLabel || formatRaisedByLabel(item.raisedBy) || '').trim()
  const raiserZh = raiserLabel ? `来源 · ${raiserLabel}` : ''
  const hasParent = Boolean(String(item.parentTaskId || '').trim())
  const codeAttr = agentCode ? ` data-agent-code="${esc(agentCode)}"` : ''
  return `
            <button type="button" class="pro-role-task-item${extraClass}" data-action="open-task" data-task-id="${esc(item.mainTaskId)}"${
              item.subtaskId ? ` data-subtask-id="${esc(item.subtaskId)}"` : ''
            }${codeAttr} title="查看岗位工作项">
              <div class="pro-role-task-item-top">
                <span class="pro-role-task-item-status ${tone}">${esc(statusZh)}</span>
                ${hasParent ? `<span class="pro-role-task-item-parent">有上游</span>` : ''}
                ${raiserZh ? `<span class="pro-role-task-item-raiser">${esc(raiserZh)}</span>` : ''}
                ${sourceZh ? `<span class="pro-role-task-item-source">${esc(sourceZh)}</span>` : ''}
              </div>
              <div class="pro-role-task-item-name">${esc(title)}</div>
              ${desc ? `<div class="pro-role-task-item-desc">${esc(desc)}</div>` : ''}
            </button>`
}

/**
 * @param {{ stat?: object, items?: Array<Record<string, unknown>> } | null | undefined} board
 * @param {{ agentCode?: string, previewLimit?: number, emptyHtml?: string, className?: string }} [opts]
 */
export function renderRoleTaskBoardHtml(board, opts = {}) {
  const {
    agentCode = '',
    previewLimit = ROLE_TASK_LIST_PREVIEW,
    emptyHtml = '',
    className = '',
  } = opts
  const stat = board?.stat
  const items = Array.isArray(board?.items) ? board.items : []
  if (!stat || stat.total === 0 || !items.length) return emptyHtml
  const progress = stat.completed > 0 ? Math.round((stat.completed / stat.total) * 100) : 0
  const activeCount = stat.executing + stat.planning + stat.pending
  const hasMore = items.length > previewLimit
  const extraClass = className ? ` ${className}` : ''
  const codeAttr = agentCode ? ` data-agent-code="${esc(agentCode)}"` : ''
  return `
        <div class="pro-role-task-stats${extraClass}" data-action="task-board"${codeAttr}>
          <div class="pro-role-task-stats-head">
            <span class="pro-role-task-stats-title">岗位工作项</span>
            <span class="pro-role-task-stats-total">共 ${stat.total} 项</span>
          </div>
          <div class="pro-role-task-stats-rows">
            ${activeCount > 0 ? `<span class="pro-role-task-pill pro-role-task-pill--active">● 进行中 ${activeCount}</span>` : ''}
            ${stat.completed > 0 ? `<span class="pro-role-task-pill pro-role-task-pill--done">● 已完成 ${stat.completed}</span>` : ''}
            ${stat.failed > 0 ? `<span class="pro-role-task-pill pro-role-task-pill--fail">● 失败 ${stat.failed}</span>` : ''}
            ${stat.paused > 0 ? `<span class="pro-role-task-pill">● 暂停 ${stat.paused}</span>` : ''}
          </div>
          <div class="pro-role-task-bar"><div class="pro-role-task-bar-fill" style="width:${progress}%"></div></div>
          <div class="pro-role-task-pct">完成 ${progress}%</div>
          <div class="pro-role-task-list${hasMore ? ' is-collapsed' : ''}">
            ${items.map((it, idx) => {
              const hidden = hasMore && idx >= previewLimit ? ' is-extra' : ''
              return renderRoleTaskItemHtml(it, hidden, agentCode)
            }).join('')}
          </div>
          ${
            hasMore
              ? `<button type="button" class="pro-role-task-more" data-action="expand-role-tasks" data-code="${esc(agentCode)}">展开其余 ${items.length - previewLimit} 项</button>`
              : ''
          }
        </div>`
}

/** 绑定看板内「打开岗位工作项 / 展开列表」；返回卸载函数。 */
export function bindRoleTaskBoardEvents(root) {
  if (!root) return () => {}
  const onClick = (e) => {
    const t = e.target
    if (!(t instanceof Element)) return
    const btn = t.closest('[data-action]')
    if (!btn || !root.contains(btn)) return
    const action = btn.getAttribute('data-action')
    if (action === 'open-task') {
      e.preventDefault()
      e.stopPropagation()
      const taskId = String(btn.getAttribute('data-task-id') || '').trim()
      if (!taskId) return
      const agentCode = String(
        btn.getAttribute('data-agent-code') ||
          btn.closest('[data-agent-code]')?.getAttribute('data-agent-code') ||
          '',
      ).trim()
      if (agentCode) {
        window.location.hash = `#/proactive/${encodeURIComponent(agentCode)}/work/${encodeURIComponent(taskId)}`
      } else {
        window.location.hash = `#/task/${encodeURIComponent(taskId)}`
      }
      return
    }
    if (action === 'expand-role-tasks') {
      e.preventDefault()
      e.stopPropagation()
      const board = btn.closest('.pro-role-task-stats')
      const list = board?.querySelector('.pro-role-task-list')
      if (list) list.classList.remove('is-collapsed')
      btn.remove()
    }
  }
  root.addEventListener('click', onClick)
  return () => root.removeEventListener('click', onClick)
}

/**
 * 从 listAllTasks / work-board 响应中取出任务数组。
 * @param {unknown} tasksRes
 */
export function tasksFromListResponse(tasksRes) {
  if (Array.isArray(tasksRes)) return tasksRes
  if (Array.isArray(tasksRes?.tasks)) return tasksRes.tasks
  if (Array.isArray(tasksRes?.data?.tasks)) return tasksRes.data.tasks
  return []
}

/**
 * 将 work-board 扁平任务行规范成 buildRoleTaskBoards 可用的主任务形状。
 * @param {Array<Record<string, unknown>>} rows
 * @param {string} [roleName]
 */
export function normalizeWorkBoardTasks(rows, roleName = '') {
  const list = Array.isArray(rows) ? rows : []
  const rn = String(roleName || '').trim()
  /** @type {Map<string, Record<string, unknown>>} */
  const byMain = new Map()
  for (const row of list) {
    const mainId = String(row.task_id || row.id || '').trim()
    if (!mainId) continue
    const isSub = !!(row.subtask_id || row.is_subtask)
    if (!isSub) {
      const prev = byMain.get(mainId) || {
        id: mainId,
        name: row.name,
        description: row.description,
        status: row.status,
        assigned_to: row.assigned_to,
        assigned_role: row.assigned_role || rn,
        source: row.source,
        source_ref: row.source_ref,
        progress: row.progress,
        created_at: row.created_at,
        updated_at: row.updated_at,
        result: row.result,
        summary: row.summary,
        outcome: row.outcome,
        risk_level: row.risk_level ?? row.risk ?? '',
        subtasks: [],
      }
      byMain.set(mainId, {
        ...prev,
        id: mainId,
        name: row.name ?? prev.name,
        description: row.description ?? prev.description,
        status: row.status ?? prev.status,
        assigned_role: row.assigned_role || prev.assigned_role || rn,
        source: row.source ?? prev.source,
        source_ref: row.source_ref ?? prev.source_ref,
        progress: row.progress ?? prev.progress,
        updated_at: row.updated_at ?? prev.updated_at,
        result: row.result ?? prev.result,
        summary: row.summary ?? prev.summary,
        outcome: row.outcome ?? prev.outcome,
        risk_level: row.risk_level ?? row.risk ?? prev.risk_level,
        subtasks: Array.isArray(prev.subtasks) ? prev.subtasks : [],
      })
    } else {
      const prev = byMain.get(mainId) || {
        id: mainId,
        name: '',
        status: 'pending',
        assigned_role: row.assigned_role || rn,
        risk_level: row.risk_level ?? row.risk ?? '',
        subtasks: [],
      }
      const subs = Array.isArray(prev.subtasks) ? [...prev.subtasks] : []
      subs.push({
        id: String(row.subtask_id || row.id || ''),
        name: row.name,
        description: row.description,
        status: row.status,
        assigned_to: row.assigned_to,
        assigned_role: row.assigned_role || rn,
        source: row.source,
        source_ref: row.source_ref,
        progress: row.progress,
        created_at: row.created_at,
        updated_at: row.updated_at,
      })
      byMain.set(mainId, { ...prev, subtasks: subs })
    }
  }
  return [...byMain.values()]
}

/**
 * 将 buildRoleTaskBoards 结果扁平成看板卡片（带 agent_code）。
 * @param {ReturnType<typeof buildRoleTaskBoards>} boards
 * @param {Array<Record<string, unknown>>} roles
 * @returns {Array<Record<string, unknown>>}
 */
export function flattenRoleTaskCards(boards, roles) {
  /** @type {Map<string, { agentCode: string, roleName: string }>} */
  const byRoleName = new Map()
  for (const r of roles || []) {
    const rn = String(r.role_name || '').trim()
    const code = String(r.agent_code || '').trim()
    if (!rn || !code) continue
    byRoleName.set(rn.toLowerCase(), { agentCode: code, roleName: rn })
  }

  /** @type {Array<Record<string, unknown>>} */
  const out = []
  const map = boards?.byRoleName
  if (!(map instanceof Map)) return out

  for (const [rnKey, bucket] of map.entries()) {
    const meta = byRoleName.get(rnKey)
    if (!meta) continue
    for (const item of bucket?.items || []) {
      out.push({
        ...item,
        agentCode: meta.agentCode,
        roleName: meta.roleName || item.assignedRole || '',
        statusGroup: toTaskStatusGroup(item.status),
      })
    }
  }

  out.sort((a, b) => {
    const ra = taskGroupSortRank(a.status) - taskGroupSortRank(b.status)
    if (ra !== 0) return ra
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
  })
  return out
}
