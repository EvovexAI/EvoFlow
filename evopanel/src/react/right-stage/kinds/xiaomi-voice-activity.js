/**
 * 小V 语音舞台右上角「活动轨」：用户 / 小V / 工具 / 脉冲 统一条目。
 * 数据来自 assistant-store messages（含 tools[]），不依赖 V4 ToolCallBlock。
 */

import { formatToolDisplayTitle } from '../../../lib/tool-display.js'

/** 历史对话轮数上限（一对 user+assistant 算一轮相关行） */
export const ACTIVITY_RECENT_TURNS = 6
/** 本轮工具行最多展示条数，超出折叠 */
export const ACTIVITY_MAX_TOOLS = 8

/**
 * @typedef {{
 *   id?: string,
 *   toolCallId?: string,
 *   name?: string,
 *   status?: string,
 *   input?: unknown,
 *   output?: unknown,
 *   argsText?: string,
 * }} XiaomiLiveTool
 */

/**
 * @typedef {{
 *   key: string,
 *   kind: 'user' | 'assistant' | 'tool' | 'pulse' | 'tool_more',
 *   roleLabel: string,
 *   text: string,
 *   toolStatus?: 'running' | 'ok' | 'error',
 * }} ActivityItem
 */

/**
 * @param {XiaomiLiveTool} tool
 * @returns {'running' | 'ok' | 'error'}
 */
export function normalizeToolStatus(tool) {
  const s = String(tool?.status || '').trim().toLowerCase()
  if (s === 'error' || s === 'failed') return 'error'
  if (s === 'ok' || s === 'done' || s === 'success' || s === 'completed') return 'ok'
  return 'running'
}

/**
 * @param {XiaomiLiveTool} tool
 */
export function toolActivityText(tool) {
  try {
    const title = formatToolDisplayTitle(tool)
    if (title) return title
  } catch {
    /* ignore */
  }
  return String(tool?.name || 'tool').trim() || 'tool'
}

/**
 * @param {Array<{ role?: string, text?: string, tools?: XiaomiLiveTool[] }>} msgs
 * @param {{
 *   liveUser?: string,
 *   liveAssistant?: string,
 *   streaming?: boolean,
 *   stageState?: string,
 * }} [opts]
 * @returns {ActivityItem[]}
 *
 * 时间序：旧 → 新；最新永远在数组末尾（贴底滚动）。
 * liveUser / liveAssistant 覆盖本轮实时句（听写 / 流式），不从轨里抠掉。
 */
export function buildActivityItems(msgs, opts = {}) {
  const liveU = String(opts.liveUser || '').trim()
  const liveA = String(opts.liveAssistant || '').trim()
  const streaming = !!opts.streaming
  const stageState = String(opts.stageState || '')

  /** @type {Array<{ role: 'user'|'assistant', text: string, tools?: XiaomiLiveTool[] }>} */
  const chat = []
  const list = Array.isArray(msgs) ? msgs : []
  for (let i = list.length - 1; i >= 0 && chat.length < ACTIVITY_RECENT_TURNS * 2 + 6; i--) {
    const m = list[i]
    const role = m?.role === 'user' || m?.role === 'assistant' ? m.role : null
    const text = String(m?.text || '').trim()
    const tools = Array.isArray(m?.tools) ? m.tools : []
    if (!role) continue
    if (!text && !(role === 'assistant' && tools.length)) continue
    if (
      chat.length &&
      chat[chat.length - 1].role === role &&
      chat[chat.length - 1].text === text &&
      !tools.length
    ) {
      continue
    }
    chat.push({ role, text, ...(tools.length ? { tools } : {}) })
  }
  chat.reverse()

  // 本轮实时句：覆盖末尾同角色或追加，保证「最新在最下」且流式跟随
  if (liveU) {
    const last = chat[chat.length - 1]
    if (last?.role === 'user') last.text = liveU
    else chat.push({ role: 'user', text: liveU })
  }
  if (liveA) {
    const last = chat[chat.length - 1]
    if (last?.role === 'assistant') last.text = liveA
    else chat.push({ role: 'assistant', text: liveA })
  }

  const trimmed = chat.slice(-ACTIVITY_RECENT_TURNS * 2)

  // 当前助手轮的 tools：取 msgs 里最后一条带 tools 的 assistant（含正流式的）
  /** @type {XiaomiLiveTool[]} */
  let liveTools = []
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (m?.role === 'assistant' && Array.isArray(m.tools) && m.tools.length) {
      liveTools = m.tools
      break
    }
    if (m?.role === 'user') break
  }

  /** @type {ActivityItem[]} */
  const items = []
  let seq = 0
  const push = (item) => {
    items.push({ ...item, key: item.key || `${item.kind}-${seq++}` })
  }

  for (const line of trimmed) {
    if (line.role === 'user' && line.text) {
      push({
        key: `user-${seq}`,
        kind: 'user',
        roleLabel: '你',
        text: line.text,
      })
    } else if (line.role === 'assistant') {
      if (line.text) {
        push({
          key: `asst-${seq}`,
          kind: 'assistant',
          roleLabel: '小V',
          text: line.text,
        })
      }
    }
  }

  // 本轮工具：挂在最新助手句之后（轨末尾 = 最新）
  if (liveTools.length) {
    const shown = liveTools.slice(-ACTIVITY_MAX_TOOLS)
    const hidden = liveTools.length - shown.length
    if (hidden > 0) {
      push({
        key: `tool-more-${hidden}`,
        kind: 'tool_more',
        roleLabel: '工具',
        text: `还有 ${hidden} 个更早的工具调用`,
      })
    }
    for (const t of shown) {
      const id = String(t.toolCallId || t.id || '').trim() || `t-${seq}`
      const st = normalizeToolStatus(t)
      push({
        key: `tool-${id}`,
        kind: 'tool',
        roleLabel: '工具',
        text: toolActivityText(t),
        toolStatus: st,
      })
    }
  }

  const hasRunning = liveTools.some((t) => normalizeToolStatus(t) === 'running')
  const needPulse =
    (streaming || stageState === 'think' || stageState === 'parse') &&
    !liveA &&
    !hasRunning &&
    !liveTools.length

  if (needPulse) {
    push({
      key: 'pulse-think',
      kind: 'pulse',
      roleLabel: '小V',
      text: stageState === 'parse' ? '识别中…' : '思考中…',
    })
  }

  return items
}
