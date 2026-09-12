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

/**
 * Phase 0：文本/思考走 LiveStream store + rAF，不 bump 整表 streamDisplayTick。
 * 默认开启；localStorage ``evopanel_live_stream_path=0`` 可回退旧路径。
 */
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
