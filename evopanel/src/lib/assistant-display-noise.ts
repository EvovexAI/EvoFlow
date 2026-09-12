/** Hide redundant assistant narration when tool cards already convey the action. */

const MAX_PREAMBLE_CHARS = 120

/** Looks like a user-facing answer about tool output, not a pre-call narration. */
const RESULT_ANSWER_HINT =
  /(?:结果|找到|返回了?|位于|在\s*[`'"]?[\w./-]+|已完成|已创建|创建了?|成功了?|失败了?|共\s*\d+|个文件|条记录|入口|如下|总结|分析|目录)/

/** Short intent before invoking a tool (CN / EN). */
const PREAMBLE_ACTION =
  /(?:调|搜|查|读|执行|调用|使用|跑|运行|试试|直接|马上|先|来|去|看看|查一下|搜一下|search|call|invoke|run|read|grep|look)/i

const OPENING_ACK = /^(?:好[，,。.!]?|OK[,.!?]?|嗯[，,]?|行[，,]?|let me|i(?:'ll| will))/i

/** Short narration before activating scenario / running tools (no tool name in text). */
const TOOL_RUN_INTENT =
  /(?:场景|工具|冒烟|测试|执行|开始工作|确认当前|工作区)/

/**
 * 普通会话顶栏「执行说明」（3～5 句目标/步骤/验收）。
 * 与 Plan 协作的 ``plan`` 工具落库无关；可与同轮 tool_calls 一起下发，但须是可读的计划段而非短预告。
 */
const STREAM_EXECUTION_PLAN_HINT =
  /(?:目标|步骤|验收|方案|打算|首先|然后|接着|最后|第一|第二|第[一二三四五]|验收标准|完成条件)/

export function isStreamExecutionPlanOutline(text: string): boolean {
  const t = String(text || '').trim()
  if (t.length < 36 || t.length > 900) return false
  if (OPENING_ACK.test(t) && t.length < 72 && PREAMBLE_ACTION.test(t) && !STREAM_EXECUTION_PLAN_HINT.test(t)) {
    return false
  }
  const lines = t.split('\n').filter((line) => line.trim())
  if (lines.length >= 2 && t.length >= 40) return true
  if (STREAM_EXECUTION_PLAN_HINT.test(t) && t.length >= 36) return true
  return false
}

function collectToolNames(tools: unknown[] | null | undefined): string[] {
  if (!tools?.length) return []
  const names = new Set<string>()
  for (const raw of tools) {
    const o = raw as Record<string, unknown>
    const name = String(o.name ?? o.tool_name ?? o.toolName ?? '').trim()
    if (name) names.add(name)
  }
  return Array.from(names)
}

function mentionsToolName(text: string, toolNames: string[]): boolean {
  if (!toolNames.length) return false
  const normalized = text.replace(/[`'"「」]/g, '').toLowerCase()
  return toolNames.some((name) => normalized.includes(name.toLowerCase()))
}

/**
 * Short assistant line that only narrates an upcoming tool call.
 * Keep substantive answers even when they mention a tool name.
 */
export function isToolCallPreambleAssistantNoise(
  text: string,
  tools?: unknown[] | null,
): boolean {
  const t = String(text || '').trim()
  if (!t || !tools?.length) return false
  if (isStreamExecutionPlanOutline(t)) return false
  if (t.length > MAX_PREAMBLE_CHARS) return false
  if (t.split('\n').filter((line) => line.trim()).length > 2) return false
  if (RESULT_ANSWER_HINT.test(t)) return false

  const toolNames = collectToolNames(tools)
  const citesTool = mentionsToolName(t, toolNames)

  if (citesTool && PREAMBLE_ACTION.test(t)) return true
  if (citesTool && t.length <= 48 && OPENING_ACK.test(t)) return true
  if (citesTool && t.length <= 32) return true

  if (t.length <= MAX_PREAMBLE_CHARS && OPENING_ACK.test(t) && PREAMBLE_ACTION.test(t)) return true
  if (t.length <= MAX_PREAMBLE_CHARS && OPENING_ACK.test(t) && TOOL_RUN_INTENT.test(t)) return true

  return false
}

/** Same-generation tool_call 旁白：有工具上下文时短 ack 一律丢弃 */
export function isToolCallGenerationPreamble(text: string, tools?: unknown[] | null): boolean {
  if (isToolCallPreambleAssistantNoise(text, tools)) return true
  const t = String(text || '').trim()
  if (!t || !tools?.length) return false
  if (isStreamExecutionPlanOutline(t)) return false
  if (t.length > MAX_PREAMBLE_CHARS) return false
  if (RESULT_ANSWER_HINT.test(t)) return false
  return OPENING_ACK.test(t) && PREAMBLE_ACTION.test(t)
}
