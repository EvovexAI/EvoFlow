/**
 * Background finalize after createSessionForChat: mode, workspace bind, model display.
 * Extracted from ChatApp.tsx (P64).
 */
import type { Dispatch, SetStateAction } from 'react'
import type { SessionMode } from '../../lib/session-mode.js'
import { defaultModelFromCatalog } from '../../lib/model-catalog.js'

export type FinalizeNewSessionBackgroundCtx = {
  memoryEnabled: boolean
  modelName: string
  modelCatalog: Array<{ name?: string }>
  followResolvedModelName: string
  agentDefaultModelName: string
  primaryModelName: string
  syncModelSessionPrevKeyRef: { current: string | null }
  applySessionModePreset: (key: string, mode: SessionMode) => Promise<void>
  setLocalWorkspaceRoot: (path: string) => void
  setWorkspaceHistory: Dispatch<SetStateAction<string[]>>
  setGlobalWorkspaceHistory: Dispatch<SetStateAction<string[]>>
  setModelName: (name: string) => void
  getSessionContext: (key: string) => { local_workspace_root?: string } | null | undefined
  bindSessionWorkspace: (
    key: string,
    ws: string,
    opts: { userPinned: boolean },
  ) => Promise<{ paths?: unknown[] } | null | undefined>
  getGlobalWorkspaceHistory: () => string[]
  refreshSessions: (opts?: { skipAutoReselect?: boolean }) => Promise<void> | void
}

export async function finalizeNewSessionBackground(
  ctx: FinalizeNewSessionBackgroundCtx,
  key: string,
): Promise<void> {
  // 新建会话默认 Agent 模式，不继承上一个会话的模式（Plan/Ask 等）
  const modeForNew: SessionMode = 'agent'
  try {
    const { api } = await import('../../../lib/tauri-api.js')
    const sessionCtx = ctx.getSessionContext(key)
    const boundWs = String(sessionCtx?.local_workspace_root || '').trim()
    try {
      await api.chatUpdateContext(key, { memory_enabled: ctx.memoryEnabled })
    } catch {
      /* ignore */
    }
    try {
      await ctx.applySessionModePreset(key, modeForNew)
    } catch (e) {
      console.warn('[ChatApp] 应用会话模式失败:', e)
    }
    if (boundWs) {
      ctx.setLocalWorkspaceRoot(boundWs)
      try {
        const bound = await ctx.bindSessionWorkspace(key, boundWs, { userPinned: true })
        const next = Array.isArray(bound?.paths)
          ? bound.paths.map((x) => String(x || '').trim()).filter(Boolean)
          : [boundWs]
        ctx.setWorkspaceHistory(next)
        ctx.setGlobalWorkspaceHistory(ctx.getGlobalWorkspaceHistory())
      } catch {
        /* ignore */
      }
    }
    const pill = (ctx.modelName || '').trim()
    // 新建会话默认跟随智能体：不写 model_name。仅当用户已显式选过（且在 catalog 内）才钉死覆盖。
    const explicitOverride =
      pill &&
      ctx.modelCatalog.some((m) => m.name === pill) &&
      pill !== ctx.followResolvedModelName &&
      pill !== ctx.agentDefaultModelName
    if (explicitOverride) {
      try {
        await api.chatUpdateContext(key, { model_name: pill })
        ctx.setModelName(pill)
        ctx.syncModelSessionPrevKeyRef.current = key
      } catch (e) {
        console.warn('[ChatApp] 新会话模型覆盖写入失败:', e)
      }
    } else {
      const display =
        ctx.followResolvedModelName ||
        defaultModelFromCatalog(ctx.modelCatalog as any, ctx.primaryModelName)
      if (display) ctx.setModelName(display)
      ctx.syncModelSessionPrevKeyRef.current = key
    }
    // Defer list refresh so home dashboard first paint is not contending for Gateway.
    window.setTimeout(() => {
      void ctx.refreshSessions({ skipAutoReselect: true })
    }, 300)
  } catch {
    /* ignore */
  }
}
