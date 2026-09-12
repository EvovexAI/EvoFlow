/** Lazy-fetch full tool output from evoflow_chat_messages via Gateway API. */

import { gatewayJson } from './gateway-json.js'

export async function fetchToolResultFull(sessionKey, toolCallId) {
  const sk = String(sessionKey || '').trim()
  const tcid = String(toolCallId || '').trim()
  if (!sk || !tcid) {
    throw new Error('sessionKey and toolCallId required')
  }
  return gatewayJson(
    'GET',
    `/api/chat/sessions/${encodeURIComponent(sk)}/tool-results/${encodeURIComponent(tcid)}`,
  )
}

/** Authoritative pending ask_clarification from transcript DB scan. Returns null when none (404). */
export async function fetchPendingClarification(sessionKey) {
  const sk = String(sessionKey || '').trim()
  if (!sk) return null
  try {
    return await gatewayJson(
      'GET',
      `/api/chat/sessions/${encodeURIComponent(sk)}/pending-clarification`,
    )
  } catch (e) {
    if (Number(e?.status) === 404) return null
    throw e
  }
}

export function formatToolResultByteLabel(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10_240 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
