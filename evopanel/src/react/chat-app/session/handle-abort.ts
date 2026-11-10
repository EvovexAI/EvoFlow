/**
 * Abort/stop the selected session turn from the composer stop button.
 * Extracted from ChatApp.tsx (P63).
 */
import { toast } from '../../../components/toast.js'
import { toUserFacingError } from '../../../lib/user-facing-error.js'
import type { StopSessionOptions } from '../../lib/session-execution/types.js'

export type HandleAbortCtx = {
  selectedSessionKey: string
  stopSessionExecution: (
    sessionKey: string,
    opts?: StopSessionOptions,
  ) => Promise<void>
}

export async function handleAbort(ctx: HandleAbortCtx): Promise<void> {
  const sessionKey = ctx.selectedSessionKey
  if (!sessionKey) return
  try {
    await ctx.stopSessionExecution(sessionKey, {
      showToast: false,
      source: 'composer_stop_button',
    })
  } catch (e) {
    toast(toUserFacingError((e as Error)?.message || e), 'error')
  }
}
