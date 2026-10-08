/**
 * Live-stream path toggle (no-store version).
 *
 * Replaces the original localStorage + listeners that toggled a runtime flag
 * used by ``live-stream-ui``/``live-stream-store``. The refactor collapsed those
 * into ``stream-snapshot-store`` + ``buildStreamDisplayRow``, so this file
 * only keeps:
 *  - the persisted enabled flag (read once on module load), and
 *  - the React subscription hook used by perf/UI panels.
 *
 * Mutators (``setLiveStreamPathEnabled``) are kept for bench/scenario parity
 * but no longer push to a live-stream channel.
 */

import { useSyncExternalStore } from 'react'

const LS_KEY = 'evopanel_live_stream_path'

function readStored(): boolean | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw === '0' || raw === 'false') return false
    if (raw === '1' || raw === 'true') return true
  } catch {
    /* ignore */
  }
  return null
}

let enabled = readStored() ?? true
const listeners = new Set<() => void>()

export function isLiveStreamPathEnabled(): boolean {
  return enabled
}

export function setLiveStreamPathEnabled(next: boolean): void {
  if (enabled === next) return
  enabled = next
  try {
    localStorage.setItem(LS_KEY, next ? '1' : '0')
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l())
}

export function subscribeLiveStreamPathEnabled(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function useLiveStreamPathEnabled(): boolean {
  return useSyncExternalStore(subscribeLiveStreamPathEnabled, isLiveStreamPathEnabled)
}
