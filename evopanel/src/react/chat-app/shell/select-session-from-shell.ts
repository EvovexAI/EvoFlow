/**
 * Select a session from the shell sidebar list.
 * Extracted from ChatApp.tsx (P50).
 */
import { flushSync } from 'react-dom'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { skTail, ssLog } from '../../../lib/session-list-debug.js'
import { logV4Life } from '../../lib/v4-lifecycle-log.js'

export type SelectSessionFromShellCtx = {
  sessionRef: MutableRefObject<string>
  setShellSelectRevision: Dispatch<SetStateAction<number>>
  setNewChatButtonActive: (v: boolean) => void
  setMoreMenuKey: Dispatch<SetStateAction<string | null>>
  setSelectedSessionKey: (key: string) => void
  setMobileChatPane: (pane: 'list' | 'thread') => void
  /** 离开工作台仪表盘意图（点历史会话） */
  setPreferHomeDashboard?: (v: boolean) => void
}

export function selectSessionFromShell(
  ctx: SelectSessionFromShellCtx,
  sessionKey: string,
): void {
  const k = String(sessionKey || '').trim()
  if (!k) return
  const from = String(ctx.sessionRef.current || '').trim()
  ssLog('shell.select', { key: skTail(k), from: skTail(from) })
  logV4Life({
    event: 'session_click',
    sessionKey: k,
    zh: `用户点击侧栏会话，开始打开历史。session=${k}${from && from !== k ? `（从 ${from} 切过来）` : ''}`,
    detail: { from: from || null },
  })
  ctx.setShellSelectRevision((r) => r + 1)
  try {
    sessionStorage.removeItem('evopanel_pending_shell_session')
  } catch {
    /* ignore */
  }
  ctx.sessionRef.current = k
  flushSync(() => {
    ctx.setPreferHomeDashboard?.(false)
    ctx.setNewChatButtonActive(false)
    ctx.setMoreMenuKey(null)
    ctx.setSelectedSessionKey(k)
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches) {
      ctx.setMobileChatPane('thread')
    }
  })
}
