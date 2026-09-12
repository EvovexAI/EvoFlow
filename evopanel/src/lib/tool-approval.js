/** Tool execution approval — structured chat payloads and tool output parsing. */

import { resolveEffectiveToolName } from './tool-display.js'

export const TOOL_APPROVAL_MARKER = '__evf_tool_approval_v1__:'
export const TOOL_APPROVAL_REPLAY_MARKER = '__evf_tool_approval_replay_v1__:'

export const TOOL_APPROVAL_POLICY_PROMPT = 'prompt'
export const TOOL_APPROVAL_POLICY_SESSION = 'session'
export const TOOL_APPROVAL_POLICY_GRANT_ALL = 'grant_all'

/** Risk levels — must stay in sync with backend tool_approval_config.TOOL_RISK_LEVELS */
export const RISK_AUTO = 'auto'
export const RISK_SESSION = 'session'
export const RISK_CONFIRM = 'confirm'

/**
 * Tool → risk level mapping (auto / session / confirm).
 * Must stay in sync with backend ``TOOL_RISK_LEVELS``.
 * - auto:    read-only tools — always auto-allowed
 * - session: file modifications — session-level grant (approve once, auto-run until session ends)
 * - confirm: irreversible / external — per-call confirmation
 */
export const TOOL_RISK_LEVELS = {
  // Auto — read-only, no side effects
  read: RISK_AUTO,
  search_code_index: RISK_AUTO,
  find: RISK_AUTO,
  rg: RISK_AUTO,
  tool_search: RISK_AUTO,
  view_image: RISK_AUTO,
  todo: RISK_AUTO,
  mind_map: RISK_AUTO,
  web_search: RISK_AUTO,
  fetch_url: RISK_AUTO,
  ask_clarification: RISK_AUTO,
  scenario: RISK_AUTO,
  propose_goal: RISK_AUTO,
  propose_hosted_agent: RISK_AUTO, // legacy alias
  read_lints: RISK_AUTO,
  subagent: RISK_AUTO,
  // Session — file modifications (reversible)
  write: RISK_SESSION,
  replace: RISK_SESSION,
  // Confirm — irreversible / external side effects
  delete: RISK_CONFIRM,
  terminal: RISK_CONFIRM,
  process: RISK_CONFIRM,
  process_start: RISK_CONFIRM,
  process_kill: RISK_CONFIRM,
}

/** Must stay in sync with backend ``tool_approval_config.tool_requires_approval``. */
export const TOOLS_REQUIRING_APPROVAL = new Set(
  Object.entries(TOOL_RISK_LEVELS)
    .filter(([, level]) => level !== RISK_AUTO)
    .map(([name]) => name),
)

export const TOOL_APPROVAL_OP_ZH = {
  terminal: '终端',
  delete_file: '删除文件',
  delete: '删除文件',
  process: '启动进程',
  process_start: '启动进程',
  write: '写入文件',
  replace: '替换文件',
  worker: '并行任务',
}

/** Worker sub-task action → risk level (sync with backend _WORKER_ACTION_RISK). */
const WORKER_ACTION_RISK = {
  search: RISK_AUTO,
  locate: RISK_AUTO,
  write: RISK_SESSION,
  replace: RISK_SESSION,
  edit: RISK_SESSION,
  delete: RISK_CONFIRM,
}

/** Determine worker risk from its tasks — the highest risk among all sub-tasks. */
function _workerRiskLevel(args) {
  const tasks = args?.tasks
  if (!Array.isArray(tasks)) return RISK_AUTO
  let worst = RISK_AUTO
  for (const t of tasks) {
    if (!t || typeof t !== 'object') continue
    const action = String(t.action || '').trim().toLowerCase()
    const level = WORKER_ACTION_RISK[action] || RISK_AUTO
    if (level === RISK_CONFIRM) return RISK_CONFIRM
    if (level === RISK_SESSION) worst = RISK_SESSION
  }
  return worst
}

/** Get risk level for a tool — sync with backend tool_risk_level(). */
export function toolRiskLevel(toolOrName, args) {
  const name =
    typeof toolOrName === 'string' ? toolOrName : resolveEffectiveToolName(toolOrName)
  const key = String(name || '').trim().toLowerCase()
  if (key === 'process') {
    const a = args || (typeof toolOrName === 'object' ? toolArgsFromRow(toolOrName) : {})
    const action = String(processToolArgs(a).action || 'start').trim().toLowerCase()
    if (action !== 'start') return RISK_AUTO
  }
  if (key === 'worker') {
    const a = args || (typeof toolOrName === 'object' ? toolArgsFromRow(toolOrName) : {})
    return _workerRiskLevel(a)
  }
  return TOOL_RISK_LEVELS[key] || RISK_AUTO
}

/** Risk badge label for UI display. */
export const RISK_LABELS = {
  [RISK_AUTO]: { text: '安全', className: 'risk-auto' },
  [RISK_SESSION]: { text: '会话级', className: 'risk-session' },
  [RISK_CONFIRM]: { text: '需确认', className: 'risk-confirm' },
}

export function riskBadge(riskLevel) {
  return RISK_LABELS[riskLevel] || RISK_LABELS[RISK_AUTO]
}

/** 风险等级对应的授权行为提示文案（卡片内展示） */
export const RISK_HINTS = {
  [RISK_SESSION]:
    '批准后仅执行本次写入/替换；同一路径重复操作可能不再询问。删除、终端等危险操作每次仍须单独确认。',
  [RISK_CONFIRM]: '此操作不可逆或涉及外部副作用，每次执行均需单独确认',
}

export function riskHint(riskLevel) {
  return RISK_HINTS[riskLevel] || ''
}

/** 授权条第一行：操作类型 + 路径/命令（单行省略） */
/** 行内授权按钮提交给 API 的附加上下文 */
export function toolApprovalHintFromMeta(approval, tool) {
  const a = approval && typeof approval === 'object' ? approval : {}
  const toolName = String(a.tool_name || resolveEffectiveToolName(tool) || '').trim()
  const summary = String(a.summary || '').trim()
  let args = {}
  if (tool?.args && typeof tool.args === 'object' && !Array.isArray(tool.args)) {
    args = tool.args
  } else {
    const raw = tool?.input
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) args = raw
  }
  return { tool_name: toolName, summary, args: /** @type {Record<string, unknown>} */ ({ ...args }) }
}

export function formatToolApprovalPrimaryLine(toolName, summary) {
  const key = String(toolName || '')
    .trim()
    .toLowerCase()
  const op = TOOL_APPROVAL_OP_ZH[key] || key || '工具'
  const detail = String(summary || '').trim().replace(/\s+/g, ' ') || '—'
  return `${op} · ${detail}`
}

function processToolArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {}
  return args
}

export function toolRequiresApproval(toolOrName, args) {
  const name =
    typeof toolOrName === 'string' ? toolOrName : resolveEffectiveToolName(toolOrName)
  const key = String(name || '').trim().toLowerCase()
  if (key === 'process') {
    const a = args || (typeof toolOrName === 'object' ? toolArgsFromRow(toolOrName) : {})
    const action = String(processToolArgs(a).action || 'start').trim().toLowerCase()
    if (action !== 'start') return false
  }
  if (key === 'worker') {
    const a = args || (typeof toolOrName === 'object' ? toolArgsFromRow(toolOrName) : {})
    return _workerRiskLevel(a) !== RISK_AUTO
  }
  return toolRiskLevel(key, args) !== RISK_AUTO
}

function resolveToolRowId(tool) {
  const id = tool?.id ?? tool?.tool_call_id
  return id != null ? String(id).trim() : ''
}

/** Read tool result blob from AG-UI / legacy row shapes. */
export function toolResultBlob(tool) {
  if (!tool || typeof tool !== 'object') return null
  const t = /** @type {Record<string, unknown>} */ (tool)
  if (typeof t.output === 'string') return t.output
  if (t.output != null) return t.output
  if (typeof t.content === 'string') return t.content
  if (t.content != null) return t.content
  if (typeof t.result === 'string') return t.result
  return t.result ?? null
}

export function parseToolApprovalFromTool(tool) {
  if (!tool) return null
  const parsed = parseToolApprovalFromOutput(toolResultBlob(tool))
  if (parsed) return parsed
  const st = String(tool.status || '').toLowerCase()
  const meta = parseEvoflowToolEnvelope(toolResultBlob(tool))
  const pending =
    st === 'pending_approval' || String(meta?.status || '').toLowerCase() === 'pending_approval'
  if (!pending) return null
  const toolCallId = resolveToolRowId(tool)
  const toolName = String(resolveEffectiveToolName(tool) || '').trim()
  const args = toolArgsFromRow(tool)
  const path = String(args?.path || args?.file_path || args?.target_file || '').trim()
  return {
    tool_call_id: toolCallId,
    tool_name: toolName,
    summary: path || toolName,
    args,
    risk: toolRiskLevel(toolName, args),
  }
}

function pendingApprovalMatchesRow(tool, rowId) {
  const approval = parseToolApprovalFromOutput(toolResultBlob(tool))
  const approvalId =
    approval?.tool_call_id != null ? String(approval.tool_call_id).trim() : ''
  const approvalName =
    approval?.tool_name != null ? String(approval.tool_name).trim().toLowerCase() : ''
  const rowName = String(resolveEffectiveToolName(tool) || '').trim().toLowerCase()
  if (!approvalId) return true
  if (rowId && approvalId === rowId) return true
  if (approvalName && rowName && approvalName === rowName) return true
  return false
}

/**
 * @param {'approve'|'deny'|'grant_all'|'approve_latest'} action
 * @param {string} [toolCallId]
 */
export function buildToolApprovalPayload(action, toolCallId) {
  const payload = { action: String(action || '').trim() }
  if (toolCallId) payload.tool_call_id = String(toolCallId).trim()
  return payload
}

/** Internal user payloads — never show as chat bubbles (dock/API handles UX). */
export function isHiddenToolApprovalUserMessage(text) {
  const s = String(text || '').trim()
  if (!s) return false
  const lower = s.toLowerCase()
  if (lower.startsWith(TOOL_APPROVAL_MARKER.toLowerCase())) return true
  if (lower.startsWith(TOOL_APPROVAL_REPLAY_MARKER.toLowerCase())) return true
  if (s.startsWith('用户工具授权操作：')) return true
  return false
}

/** Message body sent to the agent (matches backend ``parse_user_approval_message``). */
export function buildToolApprovalMessage(action, toolCallId) {
  return `${TOOL_APPROVAL_MARKER} ${JSON.stringify(buildToolApprovalPayload(action, toolCallId))}`
}

/** Internal replay payload — triggers ToolApprovalReplayMiddleware after approve. */
export function buildToolApprovalReplayMessage(toolCallIds) {
  const ids = (Array.isArray(toolCallIds) ? toolCallIds : [toolCallIds])
    .map((x) => String(x || '').trim())
    .filter(Boolean)
  return `${TOOL_APPROVAL_REPLAY_MARKER} ${JSON.stringify({ tool_call_ids: ids })}`
}

export function parseEvoflowToolEnvelope(output) {
  if (output == null) return null
  let obj = output
  if (typeof output === 'string') {
    const t = output.trim()
    if (!t || t[0] !== '{') return null
    try {
      obj = JSON.parse(t)
    } catch {
      return null
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const meta = obj._evoflow_tool
  return meta && typeof meta === 'object' && meta.status != null ? meta : null
}

export function parseToolApprovalFromOutput(output) {
  if (output == null) return null
  let obj = output
  if (typeof output === 'string') {
    const t = output.trim()
    if (!t || t[0] !== '{') return null
    try {
      obj = JSON.parse(t)
    } catch {
      return null
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const approval = obj.approval
  return approval && typeof approval === 'object' ? approval : null
}

export function isToolPendingApproval(tool) {
  if (!tool) return false
  const rowId = resolveToolRowId(tool)
  // Envelope-first: backend may mark tools as pending_approval even when the
  // frontend's static TOOL_RISK_LEVELS doesn't include them (e.g. worker with
  // dynamic risk). Check explicit status before falling back to risk table.
  const st = String(tool.status || '').toLowerCase()
  if (
    st === 'approved_waiting' ||
    st === 'awaiting_other_approval' ||
    st === 'approved' ||
    st === 'denied' ||
    st === 'ok' ||
    st === 'error' ||
    st === 'blocked'
  ) {
    return false
  }
  if (st === 'pending_approval') return pendingApprovalMatchesRow(tool, rowId)
  const meta = parseEvoflowToolEnvelope(toolResultBlob(tool))
  const metaSt = String(meta?.status || '').toLowerCase()
  if (
    metaSt === 'approved_waiting' ||
    metaSt === 'awaiting_other_approval' ||
    metaSt === 'approved' ||
    metaSt === 'denied' ||
    metaSt === 'ok' ||
    metaSt === 'error' ||
    metaSt === 'blocked'
  ) {
    return false
  }
  if (metaSt === 'pending_approval') return pendingApprovalMatchesRow(tool, rowId)
  // Fallback: static risk level check (for tools without explicit envelope)
  if (!toolRequiresApproval(tool)) return false
  return false
}

/**
 * Optimistic UI: leave pending_approval after API approve/deny when live SSE
 * cannot push ``tool_approval_decision`` (middle layer already closed).
 */
export function patchToolsApprovalStatus(tools, toolCallIds, status) {
  const want = new Set(
    (Array.isArray(toolCallIds) ? toolCallIds : [toolCallIds])
      .map((x) => String(x || '').trim())
      .filter(Boolean),
  )
  if (!want.size || !Array.isArray(tools)) return 0
  const st = String(status || 'approved').trim().toLowerCase() || 'approved'
  let n = 0
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue
    const id = resolveToolRowId(tool)
    if (!id || !want.has(id)) continue
    tool.status = st
    const blob = toolResultBlob(tool)
    if (typeof blob === 'string' && blob.trim().startsWith('{')) {
      try {
        const obj = JSON.parse(blob)
        if (obj && typeof obj === 'object') {
          if (!obj._evoflow_tool || typeof obj._evoflow_tool !== 'object') {
            obj._evoflow_tool = {}
          }
          obj._evoflow_tool.status = st
          if (st === 'approved' || st === 'ok') {
            obj.message =
              obj.message && !String(obj.message).includes('[pending_approval]')
                ? obj.message
                : '已批准，正在执行…'
          }
          const text = JSON.stringify(obj)
          if ('output' in tool) tool.output = text
          if ('content' in tool) tool.content = text
          if ('result' in tool) tool.result = text
        }
      } catch {
        /* keep status-only patch */
      }
    }
    n += 1
  }
  return n
}

/** Check if a tool was blocked by the denylist (non-overridable safety layer). */
export function isToolBlocked(tool) {
  if (!tool) return false
  const st = String(tool.status || '').toLowerCase()
  if (st === 'blocked') return true
  const meta = parseEvoflowToolEnvelope(tool.output)
  return String(meta?.status || '').toLowerCase() === 'blocked'
}

/** Extract the human-readable blocked reason from a tool's output envelope. */
export function toolBlockedMessage(tool) {
  if (!tool) return ''
  let obj = tool.output
  if (typeof obj === 'string') {
    const t = obj.trim()
    if (t && t[0] === '{') {
      try { obj = JSON.parse(t) } catch { return String(tool.output || '') }
    }
  }
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    return String(obj.message || obj._evoflow_tool?.message || '')
  }
  return String(tool.output || '')
}

export function rowHasPendingApprovalTools(tools) {
  if (!Array.isArray(tools)) return false
  return tools.some((t) => isToolPendingApproval(t))
}

function toolArgsFromRow(tool) {
  if (tool?.args && typeof tool.args === 'object' && !Array.isArray(tool.args)) {
    return tool.args
  }
  const raw = tool?.input
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    const t = raw.trim()
    if (t && t[0] === '{') {
      try {
        const o = JSON.parse(t)
        if (o && typeof o === 'object' && !Array.isArray(o)) return o
      } catch {
        /* ignore */
      }
    }
  }
  return {}
}

function pendingEntryFromTool(tool) {
  const id = resolveToolRowId(tool)
  if (!id) return null
  const approval = parseToolApprovalFromTool(tool)
  const toolName = String(resolveEffectiveToolName(tool) || approval?.tool_name || '').trim()
  const args = toolArgsFromRow(tool)
  let summary = String(approval?.summary || '').trim()
  if (!summary || summary.startsWith('{')) {
    const path = String(args?.path || args?.file_path || args?.target_file || '').trim()
    if (path) summary = path
  }
  return {
    tool_call_id: id,
    tool_name: toolName,
    summary,
    args,
    risk: String(approval?.risk || toolRiskLevel(toolName, args) || 'confirm'),
  }
}

/**
 * Merge collab poll with in-flight stream / last assistant row (fallback when pending
 * was not persisted, e.g. missing thread_id before backend fix).
 *
 * Returns items marked with `stale: true` — the list is used only for detecting
 * whether the dock should be shown; actual display data comes from the server API
 * via mergePendingApprovalLists.
 */
export function collectPendingApprovalsForDock({
  streamTools,
  rows,
  isSending,
  excludeToolCallIds,
}) {
  const host = resolveToolApprovalHost({ rows, streamTools, isSending })
  if (!host || host.kind === 'none') return []
  const exclude =
    excludeToolCallIds instanceof Set
      ? excludeToolCallIds
      : new Set(
          Array.isArray(excludeToolCallIds)
            ? excludeToolCallIds.map((x) => String(x || '').trim()).filter(Boolean)
            : [],
        )
  const tools =
    host.kind === 'stream'
      ? streamTools
      : Array.isArray(rows) && host.kind === 'row'
        ? rows[host.index]?.tools
        : []
  const seen = new Set()
  const out = []
  for (const t of tools || []) {
    if (!isToolPendingApproval(t)) continue
    const entry = pendingEntryFromTool(t)
    if (!entry || seen.has(entry.tool_call_id)) continue
    if (exclude.has(entry.tool_call_id)) continue
    seen.add(entry.tool_call_id)
    out.push({ ...entry, stale: true })
  }
  return out
}

export function mergePendingApprovalLists(serverList, streamList, { excludeToolCallIds } = {}) {
  const exclude =
    excludeToolCallIds instanceof Set
      ? excludeToolCallIds
      : new Set(
          Array.isArray(excludeToolCallIds)
            ? excludeToolCallIds.map((x) => String(x || '').trim()).filter(Boolean)
            : [],
        )
  const seen = new Set()
  const out = []
  for (const p of serverList || []) {
    const id = String(p?.tool_call_id || '').trim()
    if (!id || seen.has(id) || exclude.has(id)) continue
    seen.add(id)
    out.push(p)
  }
  for (const p of streamList || []) {
    const id = String(p?.tool_call_id || '').trim()
    if (!id || seen.has(id) || exclude.has(id)) continue
    seen.add(id)
    out.push(p)
  }
  return out
}

/** User message that records approve / deny / grant_all (structured or slash commands). */
export function isUserToolApprovalMessage(text) {
  if (isHiddenToolApprovalUserMessage(text)) return true
  if (formatUserToolApprovalBubbleText(text)) return true
  const s = String(text || '').trim()
  if (!s) return false
  if (/^\/approve\b/i.test(s) || /^\/deny\b/i.test(s)) return true
  if (s === '批准' || s === '全部授权' || s === '全部允许' || s === 'grant all') return true
  return false
}

function pendingApprovalResolvedAfterRow(rows, pendingRowIndex) {
  if (!Array.isArray(rows) || pendingRowIndex < 0) return false
  for (let j = pendingRowIndex + 1; j < rows.length; j++) {
    const row = rows[j]
    if (row?.role === 'user' && isUserToolApprovalMessage(row.text)) return true
  }
  return false
}

function findLastPendingAssistantRowIndex(rows) {
  if (!Array.isArray(rows)) return -1
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (row?.role !== 'assistant') continue
    if (rowHasPendingApprovalTools(row.tools)) return i
  }
  return -1
}

/**
 * Which chat row may show interactive approve/deny controls.
 * Older history turns keep pending JSON in tool output but must not repeat the action bar.
 */
export function resolveToolApprovalHost({ rows, streamTools, isSending }) {
  const list = Array.isArray(rows) ? rows : []
  const last = list[list.length - 1]
  const lastIsUser = last?.role === 'user'
  const streamPending = rowHasPendingApprovalTools(streamTools)

  if (lastIsUser) {
    if (isUserToolApprovalMessage(last.text)) {
      return { kind: 'none' }
    }
    if (isSending || streamPending) {
      return { kind: 'stream' }
    }
  }

  const idx = findLastPendingAssistantRowIndex(list)
  if (idx >= 0 && !pendingApprovalResolvedAfterRow(list, idx)) {
    return { kind: 'row', index: idx }
  }

  // Same SSE paused at approval: pending may live only in the live stream buffer.
  if (streamPending) {
    return { kind: 'stream' }
  }

  return { kind: 'none' }
}

export function toolApprovalInteractiveForItem(host, item, opts = {}) {
  if (!host || host.kind === 'none') return false
  if (host.kind === 'stream') {
    if (item?.kind === 'stream') return true
    const continuedIdx = opts.continuedStreamRowIndex
    if (
      typeof continuedIdx === 'number' &&
      continuedIdx >= 0 &&
      item?.kind === 'row' &&
      item.i === continuedIdx
    ) {
      return true
    }
    return false
  }
  if (host.kind === 'row' && item?.kind === 'row' && item.i === host.index) return true
  return false
}

/** Readable user bubble for structured approval commands. */
export function formatUserToolApprovalBubbleText(raw) {
  if (isHiddenToolApprovalUserMessage(raw)) return null
  const s = String(raw || '').trim()
  if (!s.toLowerCase().startsWith(TOOL_APPROVAL_MARKER.toLowerCase())) return null
  try {
    const body = s.slice(TOOL_APPROVAL_MARKER.length).trim()
    const data = JSON.parse(body)
    const action = String(data?.action || '').toLowerCase()
    if (action === 'grant_all') return '已开启本会话全部工具授权'
    if (action === 'approve' || action === 'approve_latest') return '已批准工具执行'
    if (action === 'deny') return '已拒绝工具执行'
    return '已提交工具授权操作'
  } catch {
    return '已提交工具授权操作'
  }
}
