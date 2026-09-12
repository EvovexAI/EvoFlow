import { useSyncExternalStore } from 'react'

const LS_STREAM_THROTTLE_KEY = 'evopanel_stream_throttle_enabled'

function readStoredThrottleEnabled(): boolean | null {
  try {
    const raw = localStorage.getItem(LS_STREAM_THROTTLE_KEY)
    if (raw === '0' || raw === 'false') return false
    if (raw === '1' || raw === 'true') return true
  } catch {
    /* ignore */
  }
  return null
}

/**
 * 流式 UI 节流总开关。
 * 默认开启——多会话并发流式时降低主线程压力，保持鼠标/点击响应。
 * 关闭后可观察不节流时的原始渲染效果（调试用）。
 */
let throttleEnabled = readStoredThrottleEnabled() ?? true
const listeners = new Set<() => void>()

export function isStreamThrottleEnabled(): boolean {
  return throttleEnabled
}

export function setStreamThrottleEnabled(enabled: boolean): void {
  if (throttleEnabled === enabled) return
  throttleEnabled = enabled
  try {
    localStorage.setItem(LS_STREAM_THROTTLE_KEY, enabled ? '1' : '0')
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l())
}

export function toggleStreamThrottle(): boolean {
  setStreamThrottleEnabled(!throttleEnabled)
  return throttleEnabled
}

export function subscribeStreamThrottleEnabled(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** React hook：订阅节流开关，切换时触发重渲染。 */
export function useStreamThrottleEnabled(): boolean {
  return useSyncExternalStore(subscribeStreamThrottleEnabled, isStreamThrottleEnabled)
}
