/**
 * Composer latency warmup: ensure-thread on focus so send skips cold thread setup.
 *
 * Intentionally does NOT prime hydration on type: send always appends a new user
 * row (or injects an in-flight Human), so watermark skip cannot hit on the first
 * before_model of that turn — prime would only add DB load.
 */

import { wsClient } from '../../lib/ws-client.js'

/** Focus → ensure LangGraph thread for the active session (best-effort). */
export async function warmComposerSession(sessionKey: string): Promise<void> {
  const key = String(sessionKey || '').trim()
  if (!key) return
  try {
    await wsClient.ensureChatThread(key)
  } catch (e) {
    console.debug('[warmup] ensure-thread', key, e)
  }
}
