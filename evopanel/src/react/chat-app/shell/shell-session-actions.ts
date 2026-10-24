/**
 * Shell sidebar session actions (pin / refresh / stop).
 * Extracted from ChatApp.tsx (P49).
 */
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { toast } from '../../../components/toast.js'
import { toUserFacingError } from '../../../lib/user-facing-error.js'
import { markSessionPinPending } from '../../lib/session-list/session-pin-pending.js'
import { patchSessionPinInRows } from '../../lib/session-list/utils.js'
import type { ChatSessionRow } from '../../chat-types.js'

export function onShellPinSession(
  setSessions: Dispatch<SetStateAction<ChatSessionRow[]>>,
  key: string,
  pinned: boolean,
): void {
  markSessionPinPending(key, pinned)
  setSessions((prev) => patchSessionPinInRows(prev, key, pinned))
}

export type OnShellRefreshSessionCtx = {
  sessionRef: MutableRefObject<string>
  setMoreMenuKey: Dispatch<SetStateAction<string | null>>
  setSelectedSessionKey: (key: string) => void
  runShellSessionRefresh: (k: string) => Promise<void>
}

export async function onShellRefreshSession(
  ctx: OnShellRefreshSessionCtx,
  k: string,
): Promise<void> {
  ctx.setMoreMenuKey(null)
  if (ctx.sessionRef.current !== k) {
    ctx.sessionRef.current = k
    ctx.setSelectedSessionKey(k)
  }
  await ctx.runShellSessionRefresh(k)
}

export type OnShellRefreshSessionListCtx = {
  sessionRef: MutableRefObject<string>
  refreshSessions: () => Promise<void> | void
  loadProactiveRoles: () => Promise<void> | void
  runShellSessionRefresh: (k: string) => Promise<void>
}

export async function onShellRefreshSessionList(
  ctx: OnShellRefreshSessionListCtx,
): Promise<void> {
  const sel = ctx.sessionRef.current
  await Promise.all([ctx.refreshSessions(), ctx.loadProactiveRoles()])
  if (sel && ctx.sessionRef.current === sel) {
    await ctx.runShellSessionRefresh(sel)
  }
}

export type OnShellStopSessionCtx = {
  setMoreMenuKey: Dispatch<SetStateAction<string | null>>
  stopSessionExecution: (k: string) => Promise<void>
}

export async function onShellStopSession(
  ctx: OnShellStopSessionCtx,
  k: string,
): Promise<void> {
  ctx.setMoreMenuKey(null)
  try {
    await ctx.stopSessionExecution(k)
  } catch (e) {
    toast(toUserFacingError((e as Error)?.message || e), 'error')
  }
}
