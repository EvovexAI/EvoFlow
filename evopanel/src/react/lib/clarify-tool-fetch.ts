import { fetchPendingClarification, fetchToolResultFull } from '../../lib/tool-result-fetch.js'
import {
  clarificationPreviewFromTool,
  isClarificationPreviewRenderable,
  resolveClarificationPreview,
} from './clarify-chat-display.js'

export type ClarificationPanelHit = { toolCallId?: string; preview?: string }

const FETCH_RETRY_MS = [0, 200, 500, 1000, 2000, 3500]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function clarificationFromToolApiData(data: Record<string, unknown>): ClarificationPanelHit | null {
  const toolCallId =
    String(data.toolCallId || data.tool_call_id || '').trim() || undefined
  const args =
    data.args && typeof data.args === 'object' && !Array.isArray(data.args)
      ? (data.args as Record<string, unknown>)
      : {}
  const content = typeof data.content === 'string' ? data.content : ''
  const preview = resolveClarificationPreview({
    preview: content,
    tools: [
      {
        name: 'ask_clarification',
        input: args,
        output: content,
        content,
        id: toolCallId,
        tool_call_id: toolCallId,
      },
    ],
  })
  if (!preview || !isClarificationPreviewRenderable(preview)) return null
  return { toolCallId, preview }
}

export async function fetchClarificationForToolCall(
  sessionKey: string,
  toolCallId: string,
  localTool?: unknown,
  opts?: { retries?: number },
): Promise<ClarificationPanelHit | null> {
  const tcid = String(toolCallId || '').trim()
  const sk = String(sessionKey || '').trim()
  if (!sk || !tcid) return null

  if (localTool) {
    const local = clarificationPreviewFromTool(localTool)
    if (local?.preview && isClarificationPreviewRenderable(local.preview)) return local
  }

  const delays = FETCH_RETRY_MS.slice(0, Math.max(1, opts?.retries ?? FETCH_RETRY_MS.length))
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await sleep(delays[i])
    try {
      const data = (await fetchToolResultFull(sk, tcid)) as Record<string, unknown>
      const hit = clarificationFromToolApiData(data)
      if (hit) return hit
    } catch {
      /* tool row may not be persisted yet right after stream final */
    }
  }
  return null
}

export async function fetchPendingClarificationPanel(
  sessionKey: string,
): Promise<ClarificationPanelHit | null> {
  const sk = String(sessionKey || '').trim()
  if (!sk) return null
  try {
    const data = (await fetchPendingClarification(sk)) as Record<string, unknown> | null
    if (!data) return null
    return clarificationFromToolApiData(data)
  } catch {
    return null
  }
}

/** DB 权威 pending-clarification 优先；流式刚结束则带重试拉 tool-results。 */
export async function resolveClarificationPanelAuthoritative(
  sessionKey: string,
  opts?: { toolCallId?: string; localTool?: unknown; preferToolRetries?: boolean },
): Promise<ClarificationPanelHit | null> {
  const sk = String(sessionKey || '').trim()
  if (!sk) return null
  const tcid = String(opts?.toolCallId || '').trim()

  if (!opts?.preferToolRetries && tcid) {
    const local = opts?.localTool ? clarificationPreviewFromTool(opts.localTool) : null
    if (local?.preview && isClarificationPreviewRenderable(local.preview)) return local
  }

  const pending = await fetchPendingClarificationPanel(sk)
  if (pending) return pending

  if (tcid) {
    return fetchClarificationForToolCall(sk, tcid, opts?.localTool, { retries: FETCH_RETRY_MS.length })
  }

  return null
}

/** 会话级 latch：流里见到 ask 就记住 toolCallId，直到用户提交或会话切换清掉。 */
const clarifyLatchBySession = new Map<string, string>()

export function latchClarificationToolCall(sessionKey: string, toolCallId: string): void {
  const sk = String(sessionKey || '').trim()
  const tcid = String(toolCallId || '').trim()
  if (!sk || !tcid) return
  clarifyLatchBySession.set(sk, tcid)
}

export function peekClarificationLatch(sessionKey: string): string {
  return clarifyLatchBySession.get(String(sessionKey || '').trim()) || ''
}

export function clearClarificationLatch(sessionKey: string): void {
  clarifyLatchBySession.delete(String(sessionKey || '').trim())
}
