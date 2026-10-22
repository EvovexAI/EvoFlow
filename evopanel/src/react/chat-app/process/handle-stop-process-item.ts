/**
 * Stop a background bash process item from the summary panel.
 * Extracted from ChatApp.tsx (P38).
 */
import type { MutableRefObject, RefObject } from 'react'
import type { ProcessItem } from '../../lib/chat-summary-panel-model.js'
import type { StreamState } from '../../chat-types.js'
import { stopBackgroundBashWork } from '../../lib/background-bash-api.js'
import { commitStreamSnapshot } from '../../lib/stream-snapshot-store.js'

export type HandleStopProcessItemCtx = {
  streamRef: RefObject<StreamState> | MutableRefObject<StreamState>
  sessionRef: MutableRefObject<string>
  streamSeqRef: MutableRefObject<number>
  scheduleBump: (opts?: { immediate?: boolean }) => void
}

export function handleStopProcessItem(
  ctx: HandleStopProcessItemCtx,
  item: ProcessItem,
): void {
  const workId = String(item?.workId || '').trim()
  if (!workId) return
  void stopBackgroundBashWork(workId)
    .then(() => {
      const S = ctx.streamRef.current
      const row = S?.backgroundWorks?.[workId]
      if (row) {
        row.status = 'cancelled'
        row.cancellable = false
        row.endedAt = Date.now()
      }
      const sk = String(ctx.sessionRef.current || '').trim()
      if (sk && S) {
        ctx.streamSeqRef.current += 1
        commitStreamSnapshot(sk, S, {
          seq: ctx.streamSeqRef.current,
        })
      }
      ctx.scheduleBump({ immediate: true })
    })
    .catch(() => {})
}
