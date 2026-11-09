/**
 * Tick soft-creep progress while a node/task is running so the % doesn't sit at 10.
 */
import { useEffect, useRef, useState } from 'react'
import {
  parseProgressStartMs,
  softDisplayProgressPercent,
} from '../../lib/soft-progress-display.js'

const TICK_MS = 1000

function isRunningStatus(status?: string | null): boolean {
  const s = String(status || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')
  return s === 'in_progress' || s === 'running' || s === 'executing' || s === 'active'
}

/**
 * @param id stable key (subtaskId / taskId) so remounts / id switches reset the clock
 * @param startedAt optional server started_at (ISO); falls back to first time we saw running
 */
export function useSoftProgressDisplay(
  id: string,
  status: string | null | undefined,
  stored: number | null | undefined,
  startedAt?: string | number | null,
): number | null {
  const sid = String(id || '').trim()
  const running = isRunningStatus(status)
  const clientStartRef = useRef<Map<string, number>>(new Map())
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!sid || !running) return
    if (!clientStartRef.current.has(sid)) {
      const fromServer = parseProgressStartMs(startedAt)
      clientStartRef.current.set(sid, fromServer ?? Date.now())
    }
    const timer = window.setInterval(() => setTick((n) => n + 1), TICK_MS)
    return () => window.clearInterval(timer)
  }, [sid, running, startedAt])

  useEffect(() => {
    if (!sid) return
    if (!running) clientStartRef.current.delete(sid)
  }, [sid, running])

  const startMs =
    (sid && clientStartRef.current.get(sid)) ||
    parseProgressStartMs(startedAt) ||
    (running ? Date.now() : 0)
  const runningForMs = running && startMs ? Math.max(0, Date.now() - startMs) : 0

  return softDisplayProgressPercent({
    stored,
    status,
    runningForMs,
  })
}
