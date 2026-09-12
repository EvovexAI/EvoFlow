import { useMemo, useSyncExternalStore } from 'react'
import type { DisplayRow } from '../chat-types.js'
import { applyLiveStreamOverlay } from '../lib/apply-live-stream-overlay.js'
import {
  getLiveStreamSnapshot,
  subscribeLiveStream,
} from '../lib/live-stream-store.js'
import { isLiveStreamPathEnabled } from '../lib/stream-live-path-toggle.js'

/** Subscribe to live text/reasoning and overlay onto a structural stream row. */
export function useLiveStreamOverlayRow(
  row: DisplayRow,
  sessionKey: string | null | undefined,
  isStreaming: boolean,
): DisplayRow {
  const sk = String(sessionKey || '').trim()
  const enabled = isLiveStreamPathEnabled()
  const live = useSyncExternalStore(
    (cb) => (enabled && isStreaming && sk ? subscribeLiveStream(sk, cb) : () => {}),
    () => (enabled && isStreaming && sk ? getLiveStreamSnapshot(sk) : null),
    () => null,
  )
  return useMemo(() => {
    if (!enabled || !isStreaming || !live) return row
    return applyLiveStreamOverlay(row, live)
  }, [enabled, isStreaming, row, live])
}
