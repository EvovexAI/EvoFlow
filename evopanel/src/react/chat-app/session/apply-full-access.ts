/**
 * Apply full-access permission preset and auto-grant pending tool approvals.
 * Extracted from ChatApp.tsx (P52).
 */
import type { MutableRefObject } from 'react'
import type { DisplayRow, StreamState } from '../../chat-types.js'

export type ApplyFullAccessCtx = {
  streamRef: MutableRefObject<StreamState>
  rowsRef: MutableRefObject<DisplayRow[]>
  sessionRef: MutableRefObject<string>
  toolApprovalResolvedIdsRef: MutableRefObject<Set<string>>
  suppressToolApprovalToastRef: MutableRefObject<boolean>
  applyMoreMenuSessionApprovalPolicy: (
    presetId: string,
    opts?: { quiet?: boolean },
  ) => Promise<void>
  permissionPresetFullAccess: string
  collectPendingApprovalsForDock: (opts: {
    streamTools: unknown[]
    rows: DisplayRow[]
    isSending: boolean
    excludeToolCallIds: Set<string>
  }) => unknown[]
  turnBusyForSession: (sk: string) => boolean
  handleToolApproval: (action: 'grant_all') => Promise<void>
}

export async function applyFullAccessToCurrentSession(
  ctx: ApplyFullAccessCtx,
  opts?: { quiet?: boolean },
): Promise<void> {
  try {
    await ctx.applyMoreMenuSessionApprovalPolicy(ctx.permissionPresetFullAccess, {
      quiet: !!opts?.quiet,
    })
  } catch {
    return
  }
  const pendingVisible = ctx.collectPendingApprovalsForDock({
    streamTools: (ctx.streamRef.current?.turn.tools as unknown[]) || [],
    rows: ctx.rowsRef.current,
    isSending: ctx.turnBusyForSession(ctx.sessionRef.current),
    excludeToolCallIds: ctx.toolApprovalResolvedIdsRef.current,
  })
  if (pendingVisible.length) {
    ctx.suppressToolApprovalToastRef.current = true
    try {
      await ctx.handleToolApproval('grant_all')
    } finally {
      ctx.suppressToolApprovalToastRef.current = false
    }
  }
}
