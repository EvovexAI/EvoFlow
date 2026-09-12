/**
 * Plan 工具检测 + 底部确认条判定（单一真相源）。
 * 调试：见 plan-trace.js，控制台过滤 `[plan]`
 */

import { findLastSuccessfulPlanToolCallId } from './collab-sidebar-from-tools.js'
import {
  extractPlanLikeFromPartialJsonString,
  getToolInputObjectFromRow,
} from './chat-normalize.js'
import {
  pickRicherStructuredPlanInput,
  structuredPlanInputFromToolInput,
  structuredPlanInputFromToolOutput,
  toolRowIsPlanTool,
} from './plan-from-task.js'
import {
  isActiveExecTaskStatus,
  isPlanExecDockEligible as isPlanExecDockEligibleFromTaskStatus,
  isTaskExecutionAuthorized,
  isTerminalTaskStatus,
} from './plan-task-status.js'

export { isPlanExecDockEligibleFromTaskStatus as isPlanExecDockEligible }

function parseToolJsonObject(v) {
  if (v == null) return null
  if (typeof v === 'object') return v
  if (typeof v === 'string') {
    const t = v.trim()
    if (!t) return null
    try {
      const p = JSON.parse(t)
      return typeof p === 'object' && p !== null ? p : null
    } catch {
      return null
    }
  }
  return null
}

/** 解析 ToolMessage / output_text（含 `[ToolResult summary — plan]` 前缀或截断 JSON） */
function parseJsonBlobFromToolResult(raw) {
  if (raw == null) return null
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw
  let s = String(raw).trim()
  if (!s) return null
  if (s.startsWith('{')) return parseToolJsonObject(s)
  const idx = s.indexOf('{')
  if (idx < 0) return null
  s = s.slice(idx)
  const cutMarkers = ['\n…', '\n...', '\u2026', '… (', '... (']
  for (const m of cutMarkers) {
    const p = s.indexOf(m)
    if (p > 0) s = s.slice(0, p).trimEnd()
  }
  if (!s.endsWith('}')) {
    const lastBrace = s.lastIndexOf('}')
    if (lastBrace > 0) s = s.slice(0, lastBrace + 1)
  }
  return parseToolJsonObject(s)
}

/** @param {unknown} row */
export function parseToolRowOutput(row) {
  if (!row || typeof row !== 'object') return null
  const t = /** @type {Record<string, unknown>} */ (row)
  return parseJsonBlobFromToolResult(
    t.output ??
      t.output_text ??
      t.result ??
      t.content ??
      t.tool_result ??
      t.toolResult ??
      t.raw_output,
  )
}

function extractTaskIdFromPlanOutput(output) {
  const o = output && typeof output === 'object' ? output : null
  if (!o) return ''
  let tid = String(o.boundTaskId || o.bound_task_id || o.taskId || o.task_id || '').trim()
  if (tid) return tid
  const sync = o.subtasksSync && typeof o.subtasksSync === 'object' ? o.subtasksSync : null
  const parent = sync && sync.parentTaskId != null ? String(sync.parentTaskId).trim() : ''
  if (parent) return parent
  const created = Array.isArray(o.created) ? o.created : []
  for (const item of created) {
    if (!item || typeof item !== 'object') continue
    const p = String(item.parentTaskId || item.parent_task_id || '').trim()
    if (p) return p
  }
  return ''
}

/**
 * 从单行工具解析 plan hit（含 success:false 但带 plan 正文、args 入参）。
 * @param {unknown} tool
 */
function planInputFromStreamingArguments(t) {
  const fn = t.function && typeof t.function === 'object' ? t.function : null
  const fa = fn && fn.arguments != null ? String(fn.arguments) : ''
  if (!fa.trim()) return null
  const parsed = parseToolJsonObject(fa)
  return structuredPlanInputFromToolInput(parsed)
}

/** @param {Record<string, unknown>} t */
function planInputFromRowArgs(t) {
  const fromRow = structuredPlanInputFromToolInput(getToolInputObjectFromRow(t))
  if (fromRow) return fromRow
  const fromFn = planInputFromStreamingArguments(t)
  if (fromFn) return fromFn
  const fn = t.function && typeof t.function === 'object' ? t.function : null
  const fa = fn && fn.arguments != null ? String(fn.arguments) : ''
  const rowArgs = typeof t.arguments === 'string' ? String(t.arguments) : ''
  const argText = (fa.trim().length >= rowArgs.trim().length ? fa : rowArgs) || fa || rowArgs
  if (!argText.trim()) return null
  const loose = extractPlanLikeFromPartialJsonString(argText)
  if (!loose) return null
  return {
    goal: loose.goal,
    flowchartMermaid: '',
    steps: loose.steps,
    validation: [],
    openQuestions: '无',
  }
}

export function planHitFromToolRow(tool) {
  const t = tool && typeof tool === 'object' ? /** @type {Record<string, unknown>} */ (tool) : {}
  if (!toolRowIsPlanTool(t)) return null
  const input = getToolInputObjectFromRow(t)
  const output = parseToolRowOutput(t)
  const planInputFromInput = structuredPlanInputFromToolInput(input) || planInputFromRowArgs(t)

  if (!output || typeof output !== 'object') {
    if (!planInputFromInput) return null
    return {
      planInput: planInputFromInput,
      boundPlanReady: false,
      boundPlanPersisted: false,
    }
  }

  if (output.success === false) {
    const planInput = pickRicherStructuredPlanInput(
      structuredPlanInputFromToolOutput(output),
      planInputFromInput,
    )
    if (!planInput) return null
    return {
      planInput,
      boundPlanReady: false,
      boundPlanPersisted: false,
      planOutput: output,
    }
  }

  const taskId = extractTaskIdFromPlanOutput(output)
  const planFromOutput = structuredPlanInputFromToolOutput(output)
  const planInput = pickRicherStructuredPlanInput(planFromOutput, planInputFromInput)
  const explicitBound =
    output.boundPlanReady === true || output.bound_plan_ready === true
  const boundPlanReady = !!(explicitBound || taskId || (planFromOutput && planInput))
  const boundPlanPersisted =
    explicitBound || !!(taskId && planFromOutput) || output.boundPlanPersisted === true
  if (!taskId && !planInput && !boundPlanReady) return null
  const newPlanCycle =
    output.newPlanCycle === true ||
    output.new_plan_cycle === true ||
    output.newCycle === true
  const previousTaskId =
    typeof output.previousTaskId === 'string'
      ? output.previousTaskId.trim()
      : typeof output.previous_task_id === 'string'
        ? output.previous_task_id.trim()
        : ''
  return {
    ...(taskId ? { taskId } : {}),
    ...(planInput ? { planInput } : {}),
    planOutput: output,
    boundPlanReady,
    boundPlanPersisted,
    ...(newPlanCycle ? { newPlanCycle: true, ...(previousTaskId ? { previousTaskId } : {}) } : {}),
    ...(typeof output.taskStatus === 'string' ? { status: output.taskStatus } : {}),
  }
}

function planInputRichness(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 0
  const steps = Array.isArray(input.steps) ? input.steps.length : 0
  const goal = typeof input.goal === 'string' ? input.goal.trim().length : 0
  return steps * 10 + goal
}

/** @param {ReturnType<typeof planHitFromToolRow>} hit */
function scorePlanHit(hit) {
  if (!hit) return -1
  let s = planInputRichness(hit.planInput)
  if (hit.boundPlanReady) s += 10000
  if (hit.taskId) s += 5000
  if (hit.boundPlanPersisted) s += 1000
  return s
}

/** Pick richest plan hit across rows (avoid last name-only row wiping a good hit). */
export function extractBestPlanHitFromTools(tools) {
  const list = Array.isArray(tools) ? tools : []
  /** @type {ReturnType<typeof planHitFromToolRow>} */
  let best = null
  let bestScore = -1
  for (const tool of list) {
    const rowHit = planHitFromToolRow(tool)
    if (!rowHit) continue
    const sc = scorePlanHit(rowHit)
    if (sc > bestScore) {
      bestScore = sc
      best = rowHit
    }
  }
  return best
}

/** Merge multiple plan tool rows (stream id / anon id / fin name-only) into one richest row. */
function coalescePlanToolRows(tools) {
  const list = Array.isArray(tools) ? [...tools] : []
  const planIdx = []
  for (let i = 0; i < list.length; i++) {
    if (toolRowIsPlanTool(list[i])) planIdx.push(i)
  }
  if (planIdx.length <= 1) return list
  let merged = list[planIdx[0]]
  for (let j = 1; j < planIdx.length; j++) {
    merged = mergeToolRowPair(merged, list[planIdx[j]])
  }
  const out = list.filter((_, i) => !planIdx.includes(i))
  out.push(merged)
  return out
}

function mergeToolRowPair(prev, next) {
  const out = { ...prev, ...next }
  const prevIn = getToolInputObjectFromRow(prev)
  const nextIn = getToolInputObjectFromRow(next)
  const prevRich = planInputRichness(prevIn)
  const nextRich = planInputRichness(nextIn)
  if (prevRich > nextRich && prevIn) {
    if (prev.input != null) out.input = prev.input
    else if (prev.args != null) out.args = prev.args
    const prevFn = prev.function && typeof prev.function === 'object' ? prev.function : null
    const nextFn = next.function && typeof next.function === 'object' ? next.function : null
    const pa = prevFn && prevFn.arguments != null ? String(prevFn.arguments).trim() : ''
    const na = nextFn && nextFn.arguments != null ? String(nextFn.arguments).trim() : ''
    if (pa && pa.length > na.length) {
      out.function = { ...(nextFn || {}), ...prevFn }
    }
  } else if (!nextIn && prevIn) {
    if (prev.input != null) out.input = prev.input
    else if (prev.args != null) out.args = prev.args
    const prevFn = prev.function && typeof prev.function === 'object' ? prev.function : null
    const nextFn = next.function && typeof next.function === 'object' ? next.function : null
    const pa = prevFn && prevFn.arguments != null ? String(prevFn.arguments).trim() : ''
    const na = nextFn && nextFn.arguments != null ? String(nextFn.arguments).trim() : ''
    if (pa && (!na || pa.length > na.length)) {
      out.function = { ...(nextFn || {}), ...prevFn }
    }
  }
  const prevOut = parseToolRowOutput(prev)
  const nextOut = parseToolRowOutput(next)
  if (!nextOut && prevOut) {
    if (prev.output != null) out.output = prev.output
    else if (prev.output_text != null) out.output = prev.output_text
  }
  for (const key of [
    'platform_ui',
    'platform_ok',
    'platform_action',
    'platform_item',
    'platform_agent',
    'platform_role',
    'platform_settings',
    'platform_client_effect',
  ]) {
    if (prev[key] != null && out[key] == null) out[key] = prev[key]
  }
  return out
}

/** @param {unknown} row */
export function summarizePlanToolRow(row) {
  const t = row && typeof row === 'object' ? /** @type {Record<string, unknown>} */ (row) : {}
  const input = getToolInputObjectFromRow(t)
  const output = parseToolRowOutput(t)
  const fn =
    t.function && typeof t.function === 'object'
      ? String(t.function.name || '').trim()
      : ''
  return {
    id: String(t.id || t.tool_call_id || '').slice(-12),
    name: String(t.name || t.tool_name || '').trim() || '?',
    fn,
    isPlan: toolRowIsPlanTool(t),
    hasInput: !!(input && Object.keys(input).length),
    inputGoal: input && typeof input.goal === 'string' ? input.goal.slice(0, 40) : '',
    inputSteps: Array.isArray(input?.steps) ? input.steps.length : 0,
    hasOutput: output != null,
    success: output && typeof output === 'object' ? output.success : undefined,
    boundReady:
      output && typeof output === 'object' ? output.boundPlanReady ?? output.bound_plan_ready : undefined,
    missReason:
      toolRowIsPlanTool(t) && !planHitFromToolRow(t)
        ? !output && !input
          ? 'plan_name_only'
          : output && typeof output === 'object' && output.success === false
            ? 'bind_failed_no_plan_body'
            : 'unparsed_payload'
        : '',
  }
}

/**
 * 流式进行中：只用 stream buffer；落库后：stream(final) + 最后一轮 assistant 工具。
 * @param {unknown[]} streamTools
 * @param {unknown[]} lastRowTools
 * @param {boolean} streamActive
 */
export function mergePlanToolsForDetection(streamTools, lastRowTools, streamActive) {
  const stream = Array.isArray(streamTools) ? streamTools : []
  const rowTools = Array.isArray(lastRowTools) ? lastRowTools : []
  if (streamActive && stream.length > 0) {
    return mergeToolsForPlanDetection(stream, rowTools)
  }
  return mergeToolsForPlanDetection(stream, rowTools)
}

/**
 * 按 tool_call_id 合并（流式 + 落库行），后者覆盖前者。
 * @param {unknown[]} sources
 */
export function mergeToolsForPlanDetection(...sources) {
  const map = new Map()
  /** @type {unknown[]} */
  const noId = []
  let anon = 0
  for (const list of sources) {
    if (!Array.isArray(list)) continue
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue
      const t = /** @type {Record<string, unknown>} */ (raw)
      let id = String(t.id || t.tool_call_id || '').trim()
      if (!id) {
        if (toolRowIsPlanTool(t)) {
          id = `__plan_anon_${anon++}`
        } else {
          noId.push(t)
          continue
        }
      }
      const prev = map.get(id)
      map.set(id, prev ? mergeToolRowPair(prev, t) : { ...t })
    }
  }
  return coalescePlanToolRows([...map.values(), ...noId])
}

/**
 * When final merge only has a name-only plan row, re-inject stream-cached plan input so analyze/hit recover.
 * @param {unknown[]} tools
 * @param {{ planInput?: Record<string, unknown> } | null | undefined} cachedHit
 */
/**
 * 从任意工具列表吸收最完整的 plan 入参（跨 stream/final 累积，防 emptyStream 丢数据）。
 * @param {Record<string, unknown> | null | undefined} current
 * @param {unknown[]} tools
 */
export function absorbPlanInputFromTools(current, tools) {
  /** @type {Record<string, unknown> | null} */
  let best = current && typeof current === 'object' ? current : null
  const hit = extractBestPlanHitFromTools(tools)
  if (hit?.planInput) {
    best = pickRicherStructuredPlanInput(hit.planInput, best)
  }
  const list = Array.isArray(tools) ? tools : []
  for (const raw of list) {
    if (!toolRowIsPlanTool(raw)) continue
    const rowHit = planHitFromToolRow(raw)
    if (rowHit?.planInput) {
      best = pickRicherStructuredPlanInput(rowHit.planInput, best)
    }
  }
  return best
}

export function enrichToolsWithCachedPlanInput(tools, cachedHit) {
  const planInput =
    cachedHit?.planInput && typeof cachedHit.planInput === 'object'
      ? cachedHit.planInput
      : cachedHit && typeof cachedHit === 'object' && cachedHit.goal
        ? cachedHit
        : null
  if (!planInput || typeof planInput !== 'object') return Array.isArray(tools) ? tools : []
  const list = Array.isArray(tools) ? [...tools] : []
  let touched = false
  const out = list.map((row) => {
    if (!toolRowIsPlanTool(row)) return row
    const rowHit = planHitFromToolRow(row)
    if (rowHit?.planInput) return row
    touched = true
    const t = row && typeof row === 'object' ? /** @type {Record<string, unknown>} */ ({ ...row }) : {}
    return {
      ...t,
      name: String(t.name || t.tool_name || 'plan').trim() || 'plan',
      input: planInput,
    }
  })
  if (!touched) {
    out.push({
      id: '__plan_cached_final__',
      name: 'plan',
      input: planInput,
    })
  }
  return out
}

/**
 * @param {unknown[]} tools
 * @returns {{
 *   tools: unknown[]
 *   planRows: unknown[]
 *   summaries: ReturnType<typeof summarizePlanToolRow>[]
 *   hit: ReturnType<typeof extractLastPlanToolSuccess>
 *   hitKind: 'none' | 'output' | 'input_only' | 'bind_failed'
 * }}
 */
export function analyzePlanTools(tools) {
  const list = Array.isArray(tools) ? tools : []
  const planRows = list.filter((r) => toolRowIsPlanTool(r))
  const summaries = list.map((r) => summarizePlanToolRow(r))
  const hit = extractBestPlanHitFromTools(list)
  let hitKind = /** @type {'none' | 'output' | 'input_only' | 'bind_failed'} */ ('none')
  if (hit) {
    const out = hit.planOutput
    if (out && typeof out === 'object' && out.success === false) {
      hitKind = 'bind_failed'
    } else {
      hitKind = hit.boundPlanReady ? 'output' : 'input_only'
    }
  }
  const streamingPlanComplete = planRows.some((row) => !!planHitFromToolRow(row))
  return { tools: list, planRows, summaries, hit, hitKind, streamingPlanComplete }
}

/** 会话历史已越过「开始执行」门槛（用户确认或 start_execution 工具成功）。 */
export function historyPastPlanExecutionGate(rows) {
  if (!Array.isArray(rows)) return false
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (row?.role === 'user') {
      const t = String(row.text || row.content || '').trim()
      if (/^开始执行$|^按计划执行$/.test(t) || (/开始执行/.test(t) && t.length <= 24)) return true
    }
    const tools = row?.tools
    if (!Array.isArray(tools)) continue
    for (const tool of tools) {
      if (!tool || typeof tool !== 'object') continue
      const out = parseToolJsonObject(/** @type {Record<string, unknown>} */ (tool).output)
      const act = out && typeof out === 'object' ? String(out.action || '').trim() : ''
      if (act === 'start_execution' && out && out.success !== false) return true
    }
  }
  return false
}

/**
 * @param {string} status
 */
export function isTerminalTaskStatusForPlanDock(status) {
  return isTerminalTaskStatus(status)
}

/**
 * @param {{
 *   planHit: ReturnType<typeof extractLastPlanToolSuccess>
 *   collabPhase?: string | null
 *   collabTask?: { executionAuthorized?: boolean; lifecycleStage?: string; boundPlanPreview?: string; boundPlanReady?: boolean; status?: string } | null
 *   planInputFallback?: Record<string, unknown> | null
 *   boundTaskId?: string | null
 *   subtaskCount?: number
 *   suppressKey?: string
 *   isSuppressed?: boolean
 *   streamingPlanComplete?: boolean
 *   planRowCount?: number
 *   streamPlanLatched?: boolean
 *   latchedPlanInput?: Record<string, unknown> | null
 * }} input
 */
export function evaluatePlanExecDock(input) {
  const task = input.collabTask
  const status = String(task?.status || '')
    .trim()
    .toLowerCase()
  const planHit = input.planHit
  const fallbackObj =
    input.planInputFallback && typeof input.planInputFallback === 'object'
      ? input.planInputFallback
      : null
  const hasPlanInputFallback = !!fallbackObj && Object.keys(fallbackObj).length > 0
  const planInputFromFallback =
    fallbackObj && typeof fallbackObj.goal === 'string' && String(fallbackObj.goal).trim()
      ? fallbackObj
      : null
  const latchedObj =
    input.latchedPlanInput && typeof input.latchedPlanInput === 'object'
      ? input.latchedPlanInput
      : null
  const planInputFromLatch =
    latchedObj && typeof latchedObj.goal === 'string' && String(latchedObj.goal).trim()
      ? latchedObj
      : null
  const planPreview = String(task?.boundPlanPreview || '').trim()
  const planRowCount = input.planRowCount ?? 0
  const streamLatched = !!input.streamPlanLatched

  const hasPlanPayload =
    !!planHit?.boundPlanReady ||
    !!planHit?.planInput ||
    !!planInputFromFallback ||
    !!planPreview ||
    hasPlanInputFallback ||
    !!input.streamingPlanComplete ||
    !!planInputFromLatch ||
    (planRowCount > 0 && (hasPlanInputFallback || !!planHit?.planInput || !!planInputFromFallback)) ||
    (streamLatched && planRowCount > 0)

  if (!hasPlanPayload) return { show: false, reason: 'no_plan_payload' }
  if (isTaskExecutionAuthorized(task)) return { show: false, reason: 'already_authorized' }
  if (isActiveExecTaskStatus(status)) return { show: false, reason: 'executing_status' }
  if (isTerminalTaskStatus(status)) return { show: false, reason: 'terminal_status' }
  if (input.isSuppressed) return { show: false, reason: 'suppressed' }
  const phaseLc = String(input.collabPhase || '')
    .trim()
    .toLowerCase()
  if (
    isPlanExecDockEligibleFromTaskStatus({
      collabTask: task,
      hasPlanBody: hasPlanPayload,
    })
  ) {
    return { show: true, reason: streamLatched ? 'stream_latch' : 'ok' }
  }
  if (
    phaseLc === 'plan_ready' &&
    hasPlanPayload &&
    (!status || status === 'planning') &&
    !isTaskExecutionAuthorized(task) &&
    !isActiveExecTaskStatus(status) &&
    !isTerminalTaskStatus(status)
  ) {
    return { show: true, reason: 'plan_ready_phase' }
  }
  return { show: false, reason: 'status_not_planned' }
}

/** @param {unknown[][]} toolArrays */
export function findPlanToolCallIdFromArrays(toolArrays) {
  return findLastSuccessfulPlanToolCallId(toolArrays)
}
