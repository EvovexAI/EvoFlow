import { useCallback, useEffect, useRef, useState } from 'react'
import { formatActivityDetailFromToolCalls } from '../../lib/tool-display.js'
import { fetchSessionRuntimeStatus } from '../lib/session-reattach.js'
import { getSessionRuntime, isSessionRuntimeLive, isTurnBusy } from '../lib/session-runtime-store.js'
import { isSessionRecoveryCooldownActive } from '../lib/stream-reattach-cooldown.js'

import { logPollLoopEnd, logPollLoopStart, logPollTick } from '../../lib/poll-loop-log.js'

export type RunningSessionSummary = {
  sessionKey: string
  runId: string | null
  threadId: string | null
  status: string
  previewText: string
  toolSummary: string
  lastEventAt: number
  hasUnseenUpdate: boolean
}

const POLL_MS = 6000
const MAX_BACKGROUND_KEYS = 4

function pageIsHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

async function readLiveRunPreview(sessionKey: string): Promise<Partial<RunningSessionSummary>> {
  try {
    const { gatewayJson } = await import('../../lib/gateway-json.js')
    const data = (await gatewayJson(
      'GET',
      `/api/chat/sessions/${encodeURIComponent(sessionKey)}/live-run`,
    )) as { snapshot?: Record<string, unknown> | null }
    const snap = data?.snapshot
    if (!snap || typeof snap !== 'object') return {}
    const partialTools = Array.isArray(snap.partialTools) ? snap.partialTools : []
    const toolSummaryRaw = partialTools.length ? formatActivityDetailFromToolCalls(partialTools) : ''
    const toolSummary = toolSummaryRaw !== '调用工具…' ? toolSummaryRaw : ''
    return {
      previewText: String(snap.partialText || '').trim(),
      toolSummary,
      lastEventAt: Number(snap.lastEventAtMs || 0),
      runId: String(snap.runId || '').trim() || null,
      threadId: String(snap.threadId || '').trim() || null,
    }
  } catch {
    return {}
  }
}

export function useRunningSessionSummaries(
  sessionKeys: string[],
  selectedSessionKey: string | null,
) {
  const [map, setMap] = useState<Record<string, RunningSessionSummary>>({})
  const lastSeenRef = useRef<Record<string, number>>({})
  const keysRef = useRef<string[]>(sessionKeys)

  useEffect(() => {
    keysRef.current = sessionKeys
  })

  const clearUnseen = useCallback((sessionKey: string) => {
    const sk = String(sessionKey || '').trim()
    if (!sk) return
    const cur = lastSeenRef.current[sk]
    setMap((prev) => {
      const row = prev[sk]
      if (!row) return prev
      lastSeenRef.current[sk] = row.lastEventAt || Date.now()
      return { ...prev, [sk]: { ...row, hasUnseenUpdate: false } }
    })
    if (cur == null) lastSeenRef.current[sk] = Date.now()
  }, [])

  useEffect(() => {
    if (selectedSessionKey) clearUnseen(selectedSessionKey)
  }, [selectedSessionKey, clearUnseen])

  useEffect(() => {
    const active = new Set(
      keysRef.current.map((k) => String(k || '').trim()).filter(Boolean),
    )
    setMap((prev) => {
      let changed = false
      const next = { ...prev }
      for (const sk of Object.keys(next)) {
        if (!active.has(sk)) {
          delete next[sk]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [sessionKeys.join('|')])

  useEffect(() => {
    const selected = String(selectedSessionKey || '').trim()
    const backgroundKeys = keysRef.current
      .map((k) => String(k || '').trim())
      .filter((k) => k && k !== selected)
      .slice(0, MAX_BACKGROUND_KEYS)

    if (!backgroundKeys.length) return

    logPollLoopStart('running_session_summaries', { count: backgroundKeys.length })
    let cancelled = false

    const pollOne = async (sk: string) => {
      if (isSessionRecoveryCooldownActive(sk)) return
      const [live, rt] = await Promise.all([readLiveRunPreview(sk), fetchSessionRuntimeStatus(sk)])
      if (cancelled) return
      const previewText = String(live.previewText || rt?.latestPartialText || '').trim()
      const toolSummary = String(live.toolSummary || rt?.latestToolSummary || '').trim()
      const lastEventAt = Number(live.lastEventAt || rt?.lastEventAtMs || 0)
      const runId = live.runId || String(rt?.runId || '').trim() || null
      const threadId = live.threadId || String(rt?.threadId || '').trim() || null
      const status = String(rt?.runStatus || '').trim().toLowerCase()
      const runtimeLive = isSessionRuntimeLive(getSessionRuntime(sk))
      if (rt?.attachRecommended === false && !runtimeLive && !isTurnBusy(getSessionRuntime(sk))) {
        setMap((prev) => {
          if (!prev[sk]) return prev
          const next = { ...prev }
          delete next[sk]
          return next
        })
        return
      }
      const stillRunning =
        runtimeLive || status === 'running' || status === 'pending'
      if (!stillRunning) {
        setMap((prev) => {
          if (!prev[sk]) return prev
          const next = { ...prev }
          delete next[sk]
          return next
        })
        return
      }
      const previewFromRuntime = String(getSessionRuntime(sk).lastVisibleTextPreview || '').trim()
      const toolFromRuntime = String(getSessionRuntime(sk).lastToolPreview || '').trim()
      const mergedPreview = previewText || previewFromRuntime
      const mergedTool = toolSummary || toolFromRuntime
      const seenAt = lastSeenRef.current[sk] ?? 0
      const hasUnseenUpdate = lastEventAt > seenAt && sk !== selected
      setMap((prev) => ({
        ...prev,
        [sk]: {
          sessionKey: sk,
          runId,
          threadId,
          status: status || (runtimeLive ? 'running' : ''),
          previewText: mergedPreview,
          toolSummary: mergedTool,
          lastEventAt,
          hasUnseenUpdate,
        },
      }))
    }

    const pollAll = () => {
      if (pageIsHidden()) return
      logPollTick('running_session_summaries', backgroundKeys.join(','), 30000, {
        count: backgroundKeys.length,
      })
      for (const sk of backgroundKeys) void pollOne(sk)
    }

    const onVisibility = () => {
      if (!pageIsHidden()) pollAll()
    }

    pollAll()
    const timer = window.setInterval(pollAll, POLL_MS)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      logPollLoopEnd('running_session_summaries')
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [selectedSessionKey, sessionKeys.join('|')])

  return { runningSessionMap: map, clearUnseenForSession: clearUnseen }
}
