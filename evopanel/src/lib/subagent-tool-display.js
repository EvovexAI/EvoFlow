/**
 * 子智能体工具展示：历史回放从 tool.output 恢复正文（流式 subagentTasks 未落库时）。
 */
import { getToolInputObject } from './chat-normalize.js'
import { isSubagentDelegationToolName, resolveEffectiveToolName } from './tool-display.js'

const SUCCESS_RE = /^Task\s+Succeeded\.?\s*Result:\s*/i
const FAILED_RE = /^Task\s+failed\.?\s*Error:\s*/i
const TIMED_RE = /^Task\s+(?:polling\s+)?timed\s+out\.?\s*(?:Error:\s*)?/i
const CANCEL_RE = /^Task\s+cancelled\.?\s*/i

/**
 * 从 subagent / task 工具返回字符串提取可展示正文。
 * @param {unknown} output
 * @returns {string}
 */
export function extractSubagentDisplayTextFromToolOutput(output) {
  if (output == null || output === '') return ''
  if (typeof output === 'object' && !Array.isArray(output)) {
    const o = output
    const r = o.result ?? o.output ?? o.content ?? o.text
    if (typeof r === 'string' && r.trim()) return r.trim()
    const err = o.error
    if (typeof err === 'string' && err.trim()) return err.trim()
    try {
      return JSON.stringify(o, null, 2).slice(0, 12000)
    } catch {
      return ''
    }
  }
  let raw = typeof output === 'string' ? output.trim() : String(output).trim()
  if (!raw) return ''
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      return extractSubagentDisplayTextFromToolOutput(JSON.parse(raw))
    } catch {
      /* 非 JSON，按纯文本 */
    }
  }
  if (SUCCESS_RE.test(raw)) return raw.replace(SUCCESS_RE, '').trim()
  if (FAILED_RE.test(raw)) return raw.replace(FAILED_RE, '').trim()
  if (TIMED_RE.test(raw)) return raw.replace(TIMED_RE, '').trim()
  if (CANCEL_RE.test(raw)) return raw.replace(CANCEL_RE, '').trim()
  return raw
}

/**
 * @param {unknown} tool
 * @returns {string}
 */
export function extractSubagentDisplayTextFromTool(tool) {
  if (!tool || typeof tool !== 'object' || !isSubagentDelegationToolName(tool)) return ''
  const t = tool
  const fromOutput = extractSubagentDisplayTextFromToolOutput(t.output ?? t.content)
  if (fromOutput) return fromOutput
  return ''
}

/**
 * 从消息 tools 列表重建 subagentTasks（key = tool_call_id，与流式 task_id 一致）。
 * @param {unknown[] | undefined} tools
 * @returns {Record<string, object>}
 */
export function buildSubagentTasksFromTools(tools) {
  /** @type {Record<string, object>} */
  const map = {}
  if (!Array.isArray(tools)) return map
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object' || !isSubagentDelegationToolName(tool)) continue
    const t = tool
    const taskId = String(t.id || t.tool_call_id || '').trim()
    if (!taskId) continue
    let liveOutput = extractSubagentDisplayTextFromTool(t)
    const inputObj = getToolInputObject(t.input)
    const st = String(t.status || '').toLowerCase()
    const phase =
      st === 'error' || st === 'failed'
        ? 'failed'
        : st === 'cancelled' || st === 'canceled'
          ? 'cancelled'
          : st === 'running' || st === 'in_progress'
            ? 'running'
            : 'completed'
    // 取消/失败但无错误详情时保留占位文本，避免任务卡片在历史回放时丢失
    if (!liveOutput) {
      if (phase === 'cancelled') liveOutput = '任务已取消'
      else if (phase === 'failed') liveOutput = '任务执行失败'
      else continue
    }
    map[taskId] = {
      taskId,
      phase,
      description:
        inputObj && typeof inputObj.description === 'string' ? inputObj.description : undefined,
      subagentType:
        inputObj && typeof inputObj.subagent_type === 'string' ? inputObj.subagent_type : undefined,
      liveOutput,
    }
  }
  return map
}

/**
 * @param {Record<string, object> | undefined} a
 * @param {Record<string, object> | undefined} b
 */
export function mergeSubagentTasksMaps(a, b) {
  if (!a && !b) return undefined
  const merged = { ...(a || {}), ...(b || {}) }
  return Object.keys(merged).length ? merged : undefined
}
