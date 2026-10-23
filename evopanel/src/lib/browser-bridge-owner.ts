/**
 * Which chat session owns the shared bridge WebView2 (single HWND).
 * Kept in a tiny module so panel-store ↔ embed-surface do not form a cycle.
 */

let bridgeOwnerSessionKey = ''

export function getBridgeOwnerSessionKey(): string {
  return bridgeOwnerSessionKey
}

export function setBridgeOwnerSessionKey(sessionKey: string | null | undefined): void {
  const next = String(sessionKey || '').trim()
  if (next === bridgeOwnerSessionKey) return
  const prev = bridgeOwnerSessionKey
  bridgeOwnerSessionKey = next
  if (typeof console !== 'undefined') {
    // eslint-disable-next-line no-console
    console.info(`[browser-bridge-owner] ${prev || '(none)'} → ${next || '(none)'}`)
  }
}
