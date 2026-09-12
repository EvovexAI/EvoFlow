import type { ContextUsageSnapshot } from './context-usage.js'

export type ManualContextCompactionResponse = {
  ok: boolean
  changed: boolean
  reason: string
  beforeGateTokens: number
  afterGateTokens: number
  beforeMessageCount: number
  afterMessageCount: number
  contextUsage: Record<string, unknown>
  persistedSummary: boolean
}

function parseContextUsageFromApi(raw: Record<string, unknown> | null | undefined): ContextUsageSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const usedTokens = Number(raw.used_tokens ?? raw.usedTokens) || 0
  const windowTokens = Number(raw.window_tokens ?? raw.windowTokens) || 0
  if (windowTokens <= 0) return null
  const messageCountRaw = raw.message_count ?? raw.messageCount
  const messageCount =
    messageCountRaw != null && Number.isFinite(Number(messageCountRaw))
      ? Number(messageCountRaw)
      : undefined
  const beforeRaw = raw.before_tokens ?? raw.beforeTokens
  const beforeTokens =
    beforeRaw != null && Number.isFinite(Number(beforeRaw)) ? Number(beforeRaw) : null
  const pctRaw = Number(raw.pct)
  const pct =
    Number.isFinite(pctRaw) && pctRaw >= 0
      ? pctRaw
      : Math.round((usedTokens / windowTokens) * 1000) / 10
  const updatedRaw = raw.updated_at_ms ?? raw.updatedAt
  const updatedAt =
    updatedRaw != null && Number.isFinite(Number(updatedRaw)) ? Number(updatedRaw) : Date.now()
  return {
    usedTokens,
    windowTokens,
    messageCount,
    pct,
    beforeTokens,
    compacted: Boolean(raw.compacted),
    note: String(raw.note || ''),
    updatedAt,
  }
}

export async function requestManualContextCompaction(
  sessionKey: string,
): Promise<{ snapshot: ContextUsageSnapshot | null; response: ManualContextCompactionResponse }> {
  const { gatewayJson } = await import('../../lib/gateway-json.js')
  const sk = String(sessionKey || '').trim()
  if (!sk) throw new Error('session_key required')
  try {
    const data = (await gatewayJson(
      'POST',
      `/api/chat/sessions/${encodeURIComponent(sk)}/compact-context`,
      {},
    )) as ManualContextCompactionResponse & { detail?: string }
    return {
      response: data,
      snapshot: parseContextUsageFromApi(data.contextUsage),
    }
  } catch (e: any) {
    const detail =
      typeof e?.gatewayResult?.detail === 'string'
        ? e.gatewayResult.detail
        : typeof e?.message === 'string'
          ? e.message
          : `HTTP ${e?.status || '?'}`
    throw new Error(detail)
  }
}
