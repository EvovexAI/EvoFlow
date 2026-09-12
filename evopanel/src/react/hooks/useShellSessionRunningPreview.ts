import { useEffect, useMemo, useState } from 'react'
import type { RunningSessionSummary } from './useRunningSessionSummaries.js'
import type { ResolvedLiveStreamActivity } from '../lib/resolve-live-stream-activity.js'
import { SESSION_RUNNING_ACTIVITY_LABEL } from '../lib/resolve-live-stream-activity.js'
import { formatRunningPreviewLine } from '../lib/session-list/build-shell-rows.js'

/** 侧栏运行预览最高刷新频率：1Hz。不订 runtime epoch，避免 200ms 打一行、打断转圈动画。 */
export const SHELL_RUNNING_PREVIEW_INTERVAL_MS = 1000

export function useShellSessionRunningPreview(opts: {
  sessionKey: string
  executing: boolean
  isSelectedRow: boolean
  staticPreviewLine: string
  runningSummary?: RunningSessionSummary | null
  resolveLiveStreamActivity: (
    sessionKey: string,
    isSelectedRow: boolean,
  ) => ResolvedLiveStreamActivity | null
}): string {
  const {
    sessionKey,
    executing,
    isSelectedRow,
    staticPreviewLine,
    runningSummary,
    resolveLiveStreamActivity,
  } = opts
  const sk = String(sessionKey || '').trim()

  const [timingTick, setTimingTick] = useState(0)
  useEffect(() => {
    if (!executing || !sk) return
    const id = window.setInterval(
      () => setTimingTick((n) => n + 1),
      SHELL_RUNNING_PREVIEW_INTERVAL_MS,
    )
    return () => window.clearInterval(id)
  }, [executing, sk])

  return useMemo(() => {
    if (!executing || !sk) return staticPreviewLine
    void timingTick
    const dockActivity = resolveLiveStreamActivity(sk, isSelectedRow)
    const dockLine = String(dockActivity?.dockLabel || '').trim()
    if (dockLine) return dockLine
    const fromSummary = formatRunningPreviewLine({
      runningPreviewLine: '',
      runningPreview: runningSummary?.previewText,
      runningToolSummary: runningSummary?.toolSummary,
    })
    if (fromSummary) return fromSummary
    return SESSION_RUNNING_ACTIVITY_LABEL
  }, [
    executing,
    sk,
    isSelectedRow,
    staticPreviewLine,
    runningSummary,
    resolveLiveStreamActivity,
    timingTick,
  ])
}
