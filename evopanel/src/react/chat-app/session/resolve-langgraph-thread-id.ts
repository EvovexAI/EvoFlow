/**
 * Resolve LangGraph lead thread id for a session (row hint + wsClient map).
 * Extracted from ChatApp.tsx (P24).
 */
import type { MutableRefObject } from 'react'
import { resolveLanggraphLeadThreadId } from '../../../lib/collab-thread-ids.js'

export type ResolveLangGraphThreadIdCtx = {
  sessionsRef: MutableRefObject<Array<{ sessionKey?: string; threadId?: string | null }>>
  getSessionThreadId: (sessionKey: string) => string | null | undefined
  resolveSessionThreadId: (
    sessionKey: string,
    opts: { hintThreadId?: string },
  ) => Promise<string | null | undefined>
}

export async function resolveLangGraphThreadIdForSession(
  ctx: ResolveLangGraphThreadIdCtx,
  sessionKey: string,
): Promise<string> {
  const sk = String(sessionKey || '').trim()
  if (!sk) return ''
  const rowHintRaw = String(
    ctx.sessionsRef.current.find((s) => String(s.sessionKey || '') === sk)?.threadId || '',
  ).trim()
  const rowHint =
    resolveLanggraphLeadThreadId(rowHintRaw) ||
    (rowHintRaw && !rowHintRaw.startsWith('agent:') ? rowHintRaw : '')
  const fromMap = ctx.getSessionThreadId(sk)
  const resolved = await ctx.resolveSessionThreadId(sk, {
    hintThreadId: rowHint || rowHintRaw || fromMap || undefined,
  })
  return String(resolved || '').trim()
}
