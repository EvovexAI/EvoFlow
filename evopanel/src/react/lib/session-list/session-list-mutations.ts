import { sortSessionRows } from './utils.js'
import { clearSessionPinPending, markSessionPinPending } from './session-pin-pending.js'
import { wsClient } from '../../../lib/ws-client.js'
import type { ShellSidebarSyncRow } from './types.js'

export function notifySessionsListMutated(): void {
  wsClient.invalidateSessionsListCache()
  window.dispatchEvent(new CustomEvent('evopanel:shell-sessions-mutated'))
}

export async function mutateSessionPinned(
  sessionKey: string,
  pinned: boolean,
  _opts?: {
    onOptimisticRows?: (rows: ShellSidebarSyncRow[]) => void
    skipRemoteRefresh?: boolean
  },
): Promise<void> {
  const key = String(sessionKey || '').trim()
  if (!key) return
  markSessionPinPending(key, pinned)
  try {
    const { api } = await import('../../../lib/tauri-api.js')
    await api.chatSessionSetPinned(key, pinned)
    notifySessionsListMutated()
  } catch (e) {
    clearSessionPinPending(key)
    console.warn('[SessionList] pin session', e)
    throw e
  }
}

export function applyPinOptimistic(
  rows: ShellSidebarSyncRow[],
  sessionKey: string,
  pinned: boolean,
): ShellSidebarSyncRow[] {
  const key = String(sessionKey || '').trim()
  return sortSessionRows(
    rows.map((r) => (String(r.sessionKey || '') === key ? { ...r, isPinned: !!pinned } : r)),
  )
}

export async function renameSession(sessionKey: string, title: string): Promise<void> {
  const key = String(sessionKey || '').trim()
  const cleanTitle = String(title || '').trim()
  if (!key || !cleanTitle) return
  try {
    const { setSessionTitle } = await import('./display.js')
    // 先写本地缓存并派发 session-name-updated，避免等 refresh 期间侧栏仍显示旧标题
    setSessionTitle(key, cleanTitle)
    const { api } = await import('../../../lib/tauri-api.js')
    await api.chatSessionRename(key, cleanTitle)
    notifySessionsListMutated()
  } catch (e) {
    console.warn('[SessionList] rename session', e)
    throw e
  }
}

export function applyRenameOptimistic(
  rows: ShellSidebarSyncRow[],
  sessionKey: string,
  title: string,
): ShellSidebarSyncRow[] {
  const key = String(sessionKey || '').trim()
  const cleanTitle = String(title || '').trim()
  return rows.map((r) => (String(r.sessionKey || '') === key ? { ...r, title: cleanTitle } : r))
}

export function reorderPinnedRowsInPlace(
  rows: ShellSidebarSyncRow[],
  dragKey: string,
  dropKey: string,
): ShellSidebarSyncRow[] | null {
  const from = String(dragKey || '').trim()
  const to = String(dropKey || '').trim()
  if (!from || !to || from === to || !rows.length) return null
  const pinned = rows.filter((r) => r.isPinned)
  const unpinned = rows.filter((r) => !r.isPinned)
  const fromIdx = pinned.findIndex((r) => String(r.sessionKey) === from)
  const toIdx = pinned.findIndex((r) => String(r.sessionKey) === to)
  if (fromIdx < 0 || toIdx < 0) return null
  const nextPinned = [...pinned]
  const [item] = nextPinned.splice(fromIdx, 1)
  nextPinned.splice(toIdx, 0, item)
  return [...nextPinned, ...unpinned]
}

export async function persistPinnedOrderFromRows(rows: ShellSidebarSyncRow[]): Promise<void> {
  const keys = rows
    .filter((r) => r.isPinned)
    .map((r) => String(r.sessionKey || '').trim())
    .filter(Boolean)
  if (!keys.length) return
  try {
    const { api } = await import('../../../lib/tauri-api.js')
    await api.chatSessionsReorderPinned(keys)
    notifySessionsListMutated()
  } catch (e) {
    console.warn('[SessionList] reorder pinned', e)
    throw e
  }
}
