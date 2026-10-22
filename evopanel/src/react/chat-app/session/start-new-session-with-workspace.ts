/**
 * Start a new session draft, optionally pinned to a workspace path.
 * Extracted from ChatApp.tsx (P60).
 */
import { flushSync } from 'react-dom'
import type { MutableRefObject } from 'react'
import { skTail, ssLog } from '../../../lib/session-list-debug.js'
import {
  commitActiveSessionRuntime,
  getSessionRuntime,
} from '../../lib/session-runtime-store.js'
import { normalizeWorkspacePathKey } from '../../lib/session-list/workspace-groups.js'
import type { DisplayRow, StreamState } from '../../chat-types.js'

export type StartNewSessionWithWorkspaceCtx = {
  selectedSessionKey: string
  sessionRef: MutableRefObject<string>
  rowsRef: MutableRefObject<DisplayRow[]>
  streamRef: MutableRefObject<StreamState>
  seenRunIdsRef: MutableRefObject<Set<string>>
  activeChatRunIdRef: MutableRefObject<string | null>
  composerTextRef: { readonly current: string | null }
  pendingComposerDraftCarryRef: { current: string | null }
  pendingNewSessionRef: MutableRefObject<boolean>
  pendingNewSessionWorkspaceRef: MutableRefObject<{ sessionKey: string; path: string } | null>
  setSelectedSessionKey: (key: string) => void
  setNewChatButtonActive: (v: boolean) => void
  setSessionHadContent: (v: boolean) => void
  setLocalWorkspaceRoot: (path: string) => void
  resetChatSurfaceForNewDraft: () => void
  coalesceCreateSession: (factory: () => Promise<string | null>) => Promise<string | null>
  createSessionForChat: (opts?: { workspaceRoot?: string | null }) => Promise<string | null>
}

export function startNewSessionWithWorkspace(
  ctx: StartNewSessionWithWorkspaceCtx,
  workspacePath: string | null,
): void {
  ctx.pendingComposerDraftCarryRef.current = ctx.composerTextRef.current
  const oldSk = String(ctx.selectedSessionKey || ctx.sessionRef.current || '').trim()
  if (oldSk) {
    const prevRt = getSessionRuntime(oldSk)
    commitActiveSessionRuntime(oldSk, {
      rows: ctx.rowsRef.current,
      stream:
        ctx.streamRef.current === prevRt.stream ||
        String(ctx.sessionRef.current || '').trim() === oldSk
          ? ctx.streamRef.current
          : prevRt.stream,
      seenRunIds: ctx.seenRunIdsRef.current,
      activeChatRunId: ctx.activeChatRunIdRef.current,
    })
  }
  ctx.pendingNewSessionRef.current = true
  // flushSync：侧栏「+」/新建必须同帧切到空白草稿，否则下一帧前像没点上
  ctx.sessionRef.current = ''
  flushSync(() => {
    ctx.setSelectedSessionKey('')
    ctx.setNewChatButtonActive(true)
    ctx.setSessionHadContent(false)
    if (workspacePath) {
      ctx.setLocalWorkspaceRoot(String(workspacePath).trim())
    } else {
      ctx.setLocalWorkspaceRoot('')
    }
  })
  ctx.resetChatSurfaceForNewDraft()
  // 已在空工作台时视觉变化小：聚焦输入框，避免「点了没反应」
  queueMicrotask(() => {
    try {
      const el = document.querySelector(
        '.evo-home-composer__input, .react-chat-composer-input, textarea.react-chat-input',
      ) as HTMLTextAreaElement | HTMLInputElement | null
      el?.focus?.()
    } catch {
      /* ignore */
    }
  })
  ssLog('new.start', { oldSk: skTail(oldSk), workspace: workspacePath || '(default)' })
  void ctx
    .coalesceCreateSession(() => ctx.createSessionForChat({ workspaceRoot: workspacePath }))
    .then((key) => {
      ssLog('new.complete', { key: skTail(key || ''), sessionRef: skTail(ctx.sessionRef.current) })
      if (key) {
        ctx.setSelectedSessionKey(key)
        ctx.sessionRef.current = key
        ctx.setNewChatButtonActive(false)
        if (workspacePath) {
          const ws = String(workspacePath).trim()
          ctx.pendingNewSessionWorkspaceRef.current = { sessionKey: key, path: ws }
          ctx.setLocalWorkspaceRoot(ws)
          window.dispatchEvent(
            new CustomEvent('evopanel:shell-expand-workspace', {
              detail: { workspaceKey: normalizeWorkspacePathKey(ws) },
            }),
          )
        } else {
          ctx.pendingNewSessionWorkspaceRef.current = null
          ctx.setLocalWorkspaceRoot('')
        }
      } else {
        ctx.setSelectedSessionKey('')
        ctx.sessionRef.current = ''
        ctx.setNewChatButtonActive(true)
        ctx.resetChatSurfaceForNewDraft()
      }
    })
    .finally(() => {
      // 延后清 pending：避免 create 刚写完 sessionRef、React 尚未同步 selectedSessionKeyRef
      // 时，在途的列表刷新走 first-selectable 把选中抢回历史会话。
      queueMicrotask(() => {
        window.setTimeout(() => {
          ctx.pendingNewSessionRef.current = false
          ssLog('new.inflight-end', { sessionRef: skTail(ctx.sessionRef.current) })
        }, 0)
      })
    })
}
