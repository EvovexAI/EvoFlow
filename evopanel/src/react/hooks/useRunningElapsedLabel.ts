import { useEffect, useState } from 'react'
import { formatRunningElapsed } from '../lib/session-list/display.js'

/**
 * 侧栏运行中「已运行时长」：每 1s 刷新一次。
 * 与 useShellSessionRunningPreview 的刷新频率保持一致（1Hz），
 * 但只产出时长文案，不读任何工具/活动摘要。
 */
export const RUNNING_ELAPSED_TICK_MS = 1000

export function useRunningElapsedLabel(startedAtMs: number | null | undefined): string {
  const [tick, setTick] = useState(0)
  const active = startedAtMs != null && Number(startedAtMs) > 0

  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => setTick((n) => n + 1), RUNNING_ELAPSED_TICK_MS)
    return () => window.clearInterval(id)
  }, [active, startedAtMs])

  if (!active) return ''
  // tick 参与计算，确保每次心跳都重算文案
  void tick
  return formatRunningElapsed(startedAtMs, Date.now())
}
