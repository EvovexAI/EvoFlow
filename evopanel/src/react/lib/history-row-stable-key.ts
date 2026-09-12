import type { DisplayRow } from '../chat-types.js'

/** Virtual / flat list key — must stay stable when optimistic user rows gain runId on run_started. */
export function historyItemStableKey(sessionKey: string, row: DisplayRow, index: number): string {
  const sk = String(sessionKey || 'default')
  const role = String(row.role || 'row')
  const messageId = String(row.messageId || '').trim()
  if (messageId) return `${sk}|mid|${messageId}`

  const ts =
    row.timestamp != null && Number.isFinite(Number(row.timestamp))
      ? String(Math.trunc(Number(row.timestamp)))
      : ''
  const textLen = String(row.text || '').length

  if (role === 'user') {
    if (ts) return `${sk}|user|${ts}|${textLen}`
    return `${sk}|user|${index}|${textLen}`
  }

  const runId = String(row.runId || '').trim()
  if (runId && ts) return `${sk}|${runId}|${role}|${ts}`
  if (runId) return `${sk}|${runId}|${role}`
  if (ts) return `${sk}|${role}|${ts}`
  return `${sk}|${role}|${index}|${textLen}`
}
