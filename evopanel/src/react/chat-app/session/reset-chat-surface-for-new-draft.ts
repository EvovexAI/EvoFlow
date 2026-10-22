/**
 * Clear live stream/rows/plan UI when starting a blank draft session.
 * Extracted from ChatApp.tsx (P59).
 */
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { emptyStream } from '../../lib/stream-state.js'
import { emptyThreadPanel, clearThreadPanelActivity } from '../thread-panel/state.js'
import type { DisplayRow, StreamState, ThreadPanelState, TokenTotals } from '../../chat-types.js'
import type { SessionMode } from '../../lib/session-mode.js'

export type ResetChatSurfaceForNewDraftCtx = {
  streamRef: MutableRefObject<StreamState>
  streamRefKeyRef: MutableRefObject<string>
  rowsRef: MutableRefObject<DisplayRow[]>
  processedTaskIdRef: MutableRefObject<string | null>
  setLiveTurnAssistantRunId: (id: string | null) => void
  setRows: Dispatch<SetStateAction<DisplayRow[]>>
  setTokenTotals: Dispatch<SetStateAction<TokenTotals | null>>
  setLiveTurnTokens: Dispatch<SetStateAction<TokenTotals | null>>
  setSubagentDockTasks: Dispatch<SetStateAction<any>>
  setThreadPanelState: Dispatch<SetStateAction<ThreadPanelState>>
  setSessionMode: (mode: SessionMode) => void
  resetCollabPlanUiForSession: (opts: { closeSidebar: boolean }) => void
  scheduleBump: (opts?: { immediate?: boolean }) => void
}

export function resetChatSurfaceForNewDraft(ctx: ResetChatSurfaceForNewDraftCtx): void {
  ctx.streamRef.current = emptyStream()
  ctx.streamRefKeyRef.current = ''
  ctx.setLiveTurnAssistantRunId(null)
  ctx.rowsRef.current = []
  ctx.setRows([])
  ctx.setTokenTotals(null)
  ctx.setLiveTurnTokens(null)
  ctx.setSubagentDockTasks({})
  ctx.setThreadPanelState(clearThreadPanelActivity(emptyThreadPanel()))
  ctx.resetCollabPlanUiForSession({ closeSidebar: true })
  ctx.processedTaskIdRef.current = null
  // 新建会话统一回落 Agent 模式，不继承上一个会话的模式
  ctx.setSessionMode('agent')
  ctx.scheduleBump({ immediate: true })
}
