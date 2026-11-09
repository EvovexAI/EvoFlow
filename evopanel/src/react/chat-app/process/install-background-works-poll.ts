// @ts-nocheck — mechanical P98 extract.
/**
 * Poll running background bash works into the live stream snapshot. Extracted (P98).
 */
import { pruneFinishedBackgroundWorks } from '../../lib/background-work-merge.js'

export type InstallBackgroundWorksPollCtx = Record<string, any>

export function runBackgroundWorksPollEffect(
  ctx: InstallBackgroundWorksPollCtx,
): void | (() => void) {
  const {
    backgroundWorksPollSigRef,
    commitStreamSnapshot,
    listBackgroundBashWorks,
    liveProcessPanelEnabled,
    selectedSessionKey,
    selectedThreadId,
    streamRef,
    streamSeqRef,
    watchBackgroundBashRef,
  } = ctx
  if (!liveProcessPanelEnabled) return
  backgroundWorksPollSigRef.current = ''
  let cancelled = false
  let timer: number | null = null
  const clearTimer = () => {
    if (timer != null) {
      window.clearTimeout(timer)
      timer = null
    }
  }
  const tick = async () => {
    timer = null
    if (cancelled) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    try {
      const works = await listBackgroundBashWorks({
        runningOnly: true,
        threadId: selectedThreadId || undefined,
      })
      if (cancelled) return
      const S = streamRef.current
      if (!S) return
      if (!S.backgroundWorks) S.backgroundWorks = {}
      // runningOnly 列表只含仍在跑的；本地 map 里消失的 running 必须收口，
      // 否则进程 tab 会一直转圈（生产日志：运行中 9/18 堆积 sleep/powershell）。
      const runningIds = works
        .map((w) => String(w.workId || '').trim())
        .filter(Boolean)
      const pruned = pruneFinishedBackgroundWorks(S.backgroundWorks, runningIds)
      const signature = `${pruned}|${works
        .map((w) => `${w.workId}:${w.status}:${w.endedAt || 0}`)
        .sort()
        .join('|')}`
      const changed = signature !== backgroundWorksPollSigRef.current
      backgroundWorksPollSigRef.current = signature
      if (changed) {
        for (const w of works) {
          S.backgroundWorks[w.workId] = {
            workId: w.workId,
            kind: 'bash',
            title: w.title || w.command || w.workId,
            status: w.status || 'running',
            startedAt: w.startedAt || Date.now(),
            endedAt: w.endedAt,
            cancellable: w.status === 'running' && w.cancellable !== false,
            toolCallId: w.toolCallId || w.workId,
            command: w.command,
          }
        }
        const sk = String(selectedSessionKey || '').trim()
        if (sk) {
          streamSeqRef.current += 1
          commitStreamSnapshot(sk, S, { seq: streamSeqRef.current })
        }
      }
      const stillRunning = works.some((w) => String(w.status || 'running') === 'running')
      if (stillRunning && !cancelled) {
        timer = window.setTimeout(() => void tick(), 2000)
      }
    } catch {
      /* gateway may be down; a later background_work event retries */
    }
  }
  watchBackgroundBashRef.current = () => {
    if (cancelled || timer != null) return
    void tick()
  }
  void tick()
  return () => {
    cancelled = true
    watchBackgroundBashRef.current = null
    clearTimer()
  }
}
