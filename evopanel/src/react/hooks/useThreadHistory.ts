import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react'
import { toUserFacingError } from '../../lib/user-facing-error.js'
import { buildTranscriptResumeAnchorFromRawMessages, buildTranscriptResumeAnchorFromDisplayRows } from '../../lib/transcript-resume-anchor.js'
import { buildHistoryViewFromRaw } from '../lib/chatHistoryView.js'
import type { DisplayRow, MessageSegment, TokenTotals } from '../chat-types.js'
import {
  dispatchSessionTurnEvent,
  getSessionRuntime,
  hydrateSessionRuntimeRowsIfIdle,
  isTurnBusy,
  peekIdleSessionRuntimeRows,
  replaceSessionRuntimeRowsFromHistory,
} from '../lib/session-runtime-store.js'
import { mergeSoftHistoryFetch } from '../lib/merge-soft-history-fetch.js'
import { collapseSameTurnAssistantsInRows } from '../lib/collapse-same-turn-assistants.js'
import { displayRowsEquivalent } from '../lib/reconcile-last-assistant-from-history.js'
import { isActiveRunStatus } from '../lib/session-reattach.js'
import {
  fetchSessionHistoryMessages,
  fetchSessionHistoryOlderMessages,
  HISTORY_OLDER_PAGE_SIZE,
  HISTORY_OPEN_PAGE_SIZE,
} from './fetchSessionHistory.js'
import { awaitSessionHistoryWarm } from '../lib/warm-session-history-prefetch.js'

export type ThreadHistoryLiveOpts = {
  isHot: boolean
  liveRows?: DisplayRow[] | null
  liveSending?: boolean
  getLive?: () => { rows: DisplayRow[]; live: boolean } | null
  currentRunId?: string | null
  runStatus?: string | null
}

type LiveRunSnapshot = {
  run_id?: string | null
  runId?: string | null
  thread_id?: string | null
  threadId?: string | null
  status?: string | null
  partial_text?: string | null
  partialText?: string | null
  partial_tools_json?: unknown
  partialTools?: unknown
  display_segments_json?: unknown
  partialDisplaySegments?: unknown
  last_event_at_ms?: number | null
  lastEventAtMs?: number | null
}

function readPartialDisplaySegments(snapshot: LiveRunSnapshot): MessageSegment[] | null {
  const raw =
    snapshot.partialDisplaySegments ??
    snapshot.display_segments_json ??
    (snapshot as { displaySegmentsJson?: unknown }).displaySegmentsJson
  if (Array.isArray(raw) && raw.length) {
    return raw.filter((s) => s && typeof s === 'object') as MessageSegment[]
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length) {
        return parsed.filter((s) => s && typeof s === 'object') as MessageSegment[]
      }
    } catch {
      return null
    }
  }
  return null
}

async function readLiveRunSnapshot(sessionKey: string) {
  const sk = String(sessionKey || '').trim()
  if (!sk) return null
  const { gatewayJson } = await import('../../lib/gateway-json.js')
  const data = (await gatewayJson(
    'GET',
    `/api/chat/sessions/${encodeURIComponent(sk)}/live-run`,
  )) as { snapshot?: LiveRunSnapshot | null }
  return data?.snapshot ?? null
}

function findLastAssistantRowIndexForRun(rows: DisplayRow[], runId: string): number {
  const rid = String(runId || '').trim()
  if (!rid) return -1
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (row?.role !== 'assistant') continue
    if (String(row.runId || '').trim() === rid) return i
  }
  return -1
}

function findLastAssistantAfterLastUser(rows: DisplayRow[]): number {
  let lastUserIdx = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]?.role === 'user') {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx < 0) return -1
  for (let i = rows.length - 1; i > lastUserIdx; i--) {
    if (rows[i]?.role === 'assistant') return i
  }
  return -1
}

/** DB 已落库终态 assistant：有耗时/ token 且未标 incomplete。 */
export function assistantRowLooksTerminal(row: DisplayRow | undefined): boolean {
  if (!row || row.role !== 'assistant') return false
  if (row.incompleteStream === true) return false
  const hasMetrics = !!(
    String(row.durationStr || '').trim() || String(row.tokenStr || '').trim()
  )
  if (!hasMetrics) return false
  return !assistantHasRunningTools(row)
}

function assistantHasRunningTools(row: DisplayRow | undefined): boolean {
  const tools = row?.tools
  if (!Array.isArray(tools) || !tools.length) return false
  return tools.some((raw) => {
    if (!raw || typeof raw !== 'object') return false
    const st = String((raw as { status?: string }).status || '').trim().toLowerCase()
    return st === 'running' || st === 'pending' || st === 'in_progress' || st === 'executing'
  })
}

/** live-run 合并污染后：若 DB 最后一轮 assistant 已终态，强制以 DB 为准。 */
export function preferDbTerminalAssistantRows(
  mergedRows: DisplayRow[],
  dbRows: DisplayRow[],
): DisplayRow[] {
  if (!mergedRows.length || !dbRows.length) return mergedRows
  const dbIdx = findLastAssistantAfterLastUser(dbRows)
  if (dbIdx < 0) return mergedRows
  const dbRow = dbRows[dbIdx]
  if (!assistantRowLooksTerminal(dbRow)) return mergedRows

  const mergeIdx = findLastAssistantAfterLastUser(mergedRows)
  if (mergeIdx < 0) return mergedRows
  const mergedRow = mergedRows[mergeIdx]
  const dbRun = String(dbRow.runId || '').trim()
  const mergeRun = String(mergedRow.runId || '').trim()
  if (dbRun && mergeRun && dbRun !== mergeRun) return mergedRows

  if (
    mergedRow.incompleteStream === true ||
    assistantHasRunningTools(mergedRow) ||
    comparableTerminalMismatch(mergedRow, dbRow)
  ) {
    const out = [...mergedRows]
    out[mergeIdx] = {
      ...dbRow,
      runId: mergeRun || dbRun || dbRow.runId,
    }
    return out
  }
  return mergedRows
}

function comparableTerminalMismatch(local: DisplayRow, db: DisplayRow): boolean {
  if (local.incompleteStream === true && db.incompleteStream !== true) return true
  if (assistantHasRunningTools(local) && !assistantHasRunningTools(db)) return true
  return false
}

/** 仅活跃 run 才拉 /live-run；勿因 stale currentRunId 覆盖已落库历史。 */
export function shouldFetchLiveRunSnapshot(runStatus: string | null | undefined): boolean {
  return shouldMarkResumeAnchorForRun(runStatus)
}

/** 续流/切回活跃会话：须将同 run 的已落库 assistant 标 incomplete 以便 merge。 */
export function shouldMarkResumeAnchorForRun(runStatus: string | null | undefined): boolean {
  const st = String(runStatus || '').trim().toLowerCase()
  return (
    st === 'running' ||
    st === 'pending' ||
    st === 'aborted' ||
    st === 'disconnected' ||
    st === 'silent'
  )
}
/** 续流前：同 run 已落库 assistant 标为 incomplete，便于与 _stream 合并为同一气泡。 */
export function markResumeAnchorAssistantIncomplete(
  rows: DisplayRow[],
  runId: string | null | undefined,
): DisplayRow[] {
  const rid = String(runId || '').trim()
  if (!rid || !rows.length) return rows
  let idx = findLastAssistantRowIndexForRun(rows, rid)
  if (idx < 0) idx = findLastAssistantAfterLastUser(rows)
  if (idx < 0) return rows
  const row = rows[idx]
  const rowRun = String(row.runId || '').trim()
  if (row.incompleteStream === true && (!rowRun || rowRun === rid)) return rows
  const out = [...rows]
  out[idx] = {
    ...row,
    incompleteStream: true,
    runId: rid,
    durationStr: undefined,
    tokenStr: undefined,
  }
  return out
}

function mergeToolsForLiveSnapshot(existing: unknown[], incoming: unknown[]): unknown[] {
  if (!incoming.length) return existing
  if (!existing.length) return incoming
  const out = [...existing]
  for (const tool of incoming) {
    if (!tool || typeof tool !== 'object') continue
    const o = tool as { id?: string; tool_call_id?: string }
    const id = String(o.id || o.tool_call_id || '').trim()
    const idx = out.findIndex((t) => {
      const r = t as { id?: string; tool_call_id?: string }
      return String(r.id || r.tool_call_id || '').trim() === id
    })
    if (idx >= 0) out[idx] = tool
    else out.push(tool)
  }
  return out
}

export function mergeLiveSnapshotRow(rows: DisplayRow[], snapshot: LiveRunSnapshot | null, expectedRunId?: string | null) {
  if (!snapshot) return rows
  const snapshotRunId = String(snapshot.run_id || snapshot.runId || '').trim()
  const wantedRunId = String(expectedRunId || '').trim()
  if (wantedRunId && snapshotRunId && snapshotRunId !== wantedRunId) return rows

  const partialText = String(snapshot.partial_text || snapshot.partialText || '').trim()
  const partialToolsRaw = Array.isArray(snapshot.partialTools)
    ? snapshot.partialTools
    : Array.isArray(snapshot.partial_tools_json)
      ? snapshot.partial_tools_json
      : []
  const partialTools = partialToolsRaw.filter((tool) => tool && typeof tool === 'object')
  const partialDisplaySegments = readPartialDisplaySegments(snapshot)

  const anchor = buildTranscriptResumeAnchorFromDisplayRows(rows, {
    runId: snapshotRunId || wantedRunId || null,
  })
  const persistedIds = new Set((anchor.persistedToolCallIds || []).map(String))
  let appendText = partialText
  if (partialDisplaySegments?.length) {
    appendText = ''
  } else {
    const dbText = String(anchor.persistedTurnText || '').trim()
    if (dbText && partialText) {
      if (partialText.startsWith(dbText)) appendText = partialText.slice(dbText.length).trim()
      else if (dbText.startsWith(partialText)) appendText = ''
    }
  }
  const newTools = partialTools.filter((tool) => {
    const id = (tool as { id?: string; tool_call_id?: string }).id
      || (tool as { id?: string; tool_call_id?: string }).tool_call_id
    return !id || !persistedIds.has(String(id))
  })
  if (!appendText && newTools.length === 0 && !partialDisplaySegments?.length) return rows

  const out = [...rows]
  const last = out.length ? out[out.length - 1] : null
  if (last?.role === '_stream') out.pop()
  const reasoningSegments = (partialDisplaySegments || [])
    .filter((s) => s.kind === 'reasoning' && String(s.text || '').trim())
    // @ts-ignore
    .map((s) => String(s.text || ''))
  const reasoningPreview = reasoningSegments.length
    ? reasoningSegments[reasoningSegments.length - 1]
    : undefined
  const snapshotStatus = String(snapshot.status || '').trim().toLowerCase()
  const incompleteStream = snapshotStatus === 'aborted' || snapshotStatus === 'running'
  const effectiveRunId = snapshotRunId || wantedRunId || undefined

  const existingIdx = effectiveRunId ? findLastAssistantRowIndexForRun(out, effectiveRunId) : -1
  if (existingIdx >= 0) {
    const existing = out[existingIdx]
    if (
      assistantRowLooksTerminal(existing) &&
      (snapshotStatus === 'running' || snapshotStatus === 'aborted')
    ) {
      return rows
    }
    if (
      snapshotStatus === 'running' &&
      Array.isArray(existing.tools) &&
      existing.tools.length > 0 &&
      !assistantHasRunningTools(existing)
    ) {
      return rows
    }
    const segments =
      partialDisplaySegments?.length
        ? partialDisplaySegments
        : existing.segments
    const markIncomplete = incompleteStream || existing.incompleteStream === true
    out[existingIdx] = {
      ...existing,
      ...(segments?.length ? { segments } : {}),
      ...(reasoningSegments.length ? { reasoningSegments, reasoningPreview } : {}),
      tools: mergeToolsForLiveSnapshot(
        Array.isArray(existing.tools) ? existing.tools : [],
        newTools,
      ) as DisplayRow['tools'],
      text: appendText || existing.text || '',
      ...(markIncomplete
        ? { incompleteStream: true as const, durationStr: undefined, tokenStr: undefined }
        : {}),
      runId: effectiveRunId || existing.runId,
      timestamp:
        Number(snapshot.last_event_at_ms || snapshot.lastEventAtMs || 0) > 0
          ? Number(snapshot.last_event_at_ms || snapshot.lastEventAtMs || 0)
          : existing.timestamp || Date.now(),
    }
    return out
  }

  out.push({
    role: 'assistant',
    text: appendText,
    ...(partialDisplaySegments?.length ? { segments: partialDisplaySegments } : {}),
    ...(reasoningSegments.length ? { reasoningSegments, reasoningPreview } : {}),
    tools: newTools,
    ...(incompleteStream ? { incompleteStream: true } : {}),
    timestamp:
      Number(snapshot.last_event_at_ms || snapshot.lastEventAtMs || 0) > 0
        ? Number(snapshot.last_event_at_ms || snapshot.lastEventAtMs || 0)
        : Date.now(),
    runId: effectiveRunId,
  })
  return out
}


function oldestSeqFromRawMessages(messages: unknown[]): number | null {
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue
    const seq = Number((raw as { seq?: unknown }).seq)
    if (Number.isFinite(seq) && seq > 0) return Math.floor(seq)
  }
  return null
}

export function useThreadHistory(sessionKey: string | null, liveOpts: ThreadHistoryLiveOpts | null) {
  const [rows, setRows] = useState<DisplayRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tokenTotals, setTokenTotals] = useState<TokenTotals | null>(null)
  const [restoredScenarioScene, setRestoredScenarioScene] = useState<string | null>(null)
  const [historyHasMore, setHistoryHasMore] = useState(false)
  const [historyOldestSeq, setHistoryOldestSeq] = useState<number | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  /** Rows painted from idle/live runtime cache — skip heavy boot scroll in MessageVirtualList. */
  const [historyInstantPaint, setHistoryInstantPaint] = useState(false)
  const historyFetchEpochRef = useRef(0)
  /** Set when API history successfully bound to ``sessionKey``; cleared on switch. */
  const [historyBoundSessionKey, setHistoryBoundSessionKey] = useState<string | null>(null)
  const liveRef = useRef<ThreadHistoryLiveOpts | null>(liveOpts)
  const rowsRef = useRef<DisplayRow[]>([])
  const historyBoundSessionKeyRef = useRef<string | null>(null)
  const historyOldestSeqRef = useRef<number | null>(null)
  const historyHasMoreRef = useRef(false)
  const loadingOlderRef = useRef(false)
  const paintedFromIdleCacheRef = useRef(false)
  // Update ref in effect to avoid accessing ref during render
  useEffect(() => {
    liveRef.current = liveOpts
  }, [liveOpts])
  useEffect(() => {
    rowsRef.current = rows
  }, [rows])
  useEffect(() => {
    historyBoundSessionKeyRef.current = historyBoundSessionKey
  }, [historyBoundSessionKey])
  useEffect(() => {
    historyOldestSeqRef.current = historyOldestSeq
  }, [historyOldestSeq])
  useEffect(() => {
    historyHasMoreRef.current = historyHasMore
  }, [historyHasMore])

  useLayoutEffect(() => {
    historyFetchEpochRef.current += 1
    paintedFromIdleCacheRef.current = false
    setHistoryInstantPaint(false)
    setHistoryBoundSessionKey(null)
    setError(null)
    setHistoryHasMore(false)
    setHistoryOldestSeq(null)
    setLoadingOlder(false)
    loadingOlderRef.current = false
    if (!sessionKey) {
      setRows([])
      setTokenTotals(null)
      setRestoredScenarioScene(null)
      setLoading(false)
      return
    }
    const meta = liveRef.current
    const liveFromStore = meta?.getLive?.() ?? null
    const liveRows = liveFromStore?.live && liveFromStore.rows.length ? liveFromStore.rows : null
    if (liveRows) {
      setRows(liveRows)
      setLoading(false)
      setHistoryInstantPaint(true)
      return
    }
    const idleCached = peekIdleSessionRuntimeRows(sessionKey)
    if (idleCached?.length) {
      paintedFromIdleCacheRef.current = true
      setRows(idleCached)
      setLoading(false)
      setHistoryInstantPaint(true)
      return
    }
    setRows([])
    setTokenTotals(null)
    setRestoredScenarioScene(null)
    setLoading(true)
  }, [sessionKey])

  const reload = useCallback(
    async (opt?: {
      bypassCache?: boolean
      anchorRunId?: string | null
      dbOnly?: boolean
      soft?: boolean
    }) => {
      if (!sessionKey) {
        setHistoryBoundSessionKey(null)
        setRows([])
        setTokenTotals(null)
        setRestoredScenarioScene(null)
        setHistoryHasMore(false)
        setHistoryOldestSeq(null)
        setLoading(false)
        setError(null)
        return { transcriptAnchor: null }
      }
      const epoch = ++historyFetchEpochRef.current
      const meta = liveRef.current
      const dbOnly = Boolean(opt?.dbOnly)
      /** 冷启动总超时：Gateway warming（latch 未放行）时不能无限 defer 转圈，
       *  超过该窗口后按失败处理并展示错误，等用户手动刷新或 ready kick 再试。 */
      const COLD_START_TIMEOUT_MS = 60_000
      const coldStartDeadline = Date.now() + COLD_START_TIMEOUT_MS
      let soft =
        Boolean(opt?.soft) ||
        paintedFromIdleCacheRef.current ||
        (historyBoundSessionKeyRef.current === sessionKey && rowsRef.current.length > 0)

      const liveStore = meta?.getLive?.() ?? null
      const liveRowsActive =
        !dbOnly &&
        (liveStore?.live && liveStore.rows.length
          ? liveStore.rows
          : meta?.liveRows && meta.liveRows.length && (meta.isHot || meta.liveSending)
            ? meta.liveRows
            : null)
      if (dbOnly) {
        setLoading(false)
        setError(null)
      } else if (liveRowsActive && !opt?.bypassCache) {
        setRows(liveRowsActive)
        setError(null)
      } else {
        const liveRowsOnHot =
          !dbOnly && meta?.isHot && meta?.liveRows && meta.liveRows.length ? meta.liveRows : null
        const liveSendRows =
          !dbOnly && meta?.liveSending && meta?.liveRows && meta.liveRows.length ? meta.liveRows : null
        // Keep same-session transcript while refreshing: clearing flips UI into
        // home mode (hides bottom composer) if the fetch then fails or lags.
        // Soft reopen / idle-cache paint must not wipe to empty either.
        const sameSessionContent =
          historyBoundSessionKeyRef.current === sessionKey &&
          Array.isArray(rowsRef.current) &&
          rowsRef.current.length > 0
        const preserveRows =
          soft || liveRowsOnHot || liveSendRows || sameSessionContent || paintedFromIdleCacheRef.current
        if (!preserveRows) {
          setRows([])
          setTokenTotals(null)
          setRestoredScenarioScene(null)
        }
        setLoading(!preserveRows)
        setError(null)
      }

      // Cold-start: UI-first can restore the last session before Gateway liveness.
      // chatHistory sits behind the warm latch (up to ~90s) while this race used to
      // fail at 15s → "加载对话超时" on every launch. Skip the network race while
      // warming; onBackendReadyChange reloads once the latch opens.
      let deferLoadingClear = false
      try {
        const { api, isGatewayWarming, isBackendReady } = await import('../../lib/tauri-api.js')
        if (
          !dbOnly &&
          typeof isGatewayWarming === 'function' &&
          isGatewayWarming()
        ) {
          if (Date.now() >= coldStartDeadline) {
            // Gateway never came up in time — stop the endless spinner and surface an error.
            setError(toUserFacingError('加载对话超时，请稍后重试', '加载对话失败，请刷新后重试'))
            setLoading(false)
            return { transcriptAnchor: null }
          }
          setError(null)
          const keepSpinner =
            !soft &&
            !liveRowsActive &&
            !(Array.isArray(rowsRef.current) && rowsRef.current.length > 0)
          if (keepSpinner) {
            setLoading(true)
            deferLoadingClear = true
          }
          return { transcriptAnchor: null }
        }
        // Post-liveness /messages can still retry 503 starting_up for a while.
        const HISTORY_FETCH_TIMEOUT_MS = 45_000
        // Hover warm shares chatHistory inflight with this fetch — when it lands first,
        // paint idle cache immediately so the spinner does not wait for our await.
        if (!dbOnly && !soft && !liveRowsActive && !opt?.bypassCache) {
          void awaitSessionHistoryWarm(sessionKey).then(() => {
            if (epoch !== historyFetchEpochRef.current) return
            if (paintedFromIdleCacheRef.current) return
            const idleAfterWarm = peekIdleSessionRuntimeRows(sessionKey)
            if (!idleAfterWarm?.length) return
            paintedFromIdleCacheRef.current = true
            soft = true
            setRows(idleAfterWarm)
            setLoading(false)
            setHistoryInstantPaint(true)
          })
        }
        const result = await Promise.race([
          fetchSessionHistoryMessages(
            (sk, limit, opts) => api.chatHistory(sk, limit, opts),
            sessionKey,
            { limit: HISTORY_OPEN_PAGE_SIZE },
          ),
          new Promise<null>((resolve) => {
            window.setTimeout(() => resolve(null), HISTORY_FETCH_TIMEOUT_MS)
          }),
        ])
        if (epoch !== historyFetchEpochRef.current) return { transcriptAnchor: null }
        if (!result) {
          const stillCold =
            (typeof isGatewayWarming === 'function' && isGatewayWarming()) ||
            (typeof isBackendReady === 'function' && isBackendReady() !== true)
          if (stillCold) {
            // Warm latch / ready race — stay quiet for a bounded window; ready listener will reload.
            if (Date.now() >= coldStartDeadline) {
              // Gateway never came up in time: stop the endless spinner and surface an error.
              setError(toUserFacingError('加载对话超时，请稍后重试', '加载对话失败，请刷新后重试'))
              setLoading(false)
              return { transcriptAnchor: null }
            }
            setError(null)
            if (!(Array.isArray(rowsRef.current) && rowsRef.current.length > 0)) {
              setLoading(true)
              deferLoadingClear = true
            }
            return { transcriptAnchor: null }
          }
          setError(toUserFacingError('加载对话超时，请稍后重试', '加载对话失败，请刷新后重试'))
          return { transcriptAnchor: null }
        }
        // Hover may have painted idle cache while this request was in flight.
        soft =
          soft ||
          paintedFromIdleCacheRef.current ||
          (historyBoundSessionKeyRef.current === sessionKey && rowsRef.current.length > 0)
        const raw = result.messages
        const built = buildHistoryViewFromRaw(raw)
        const anchorRunId = String(opt?.anchorRunId || meta?.currentRunId || '').trim() || null
        const transcriptAnchor = anchorRunId
          ? buildTranscriptResumeAnchorFromRawMessages(raw, { runId: anchorRunId })
          : buildTranscriptResumeAnchorFromDisplayRows(built.rows, { runId: anchorRunId })

        let mergedRows = built.rows
        const runStatus = String(meta?.runStatus || '').trim().toLowerCase()
        const shouldTryLiveSnapshot = !dbOnly && !!sessionKey && shouldFetchLiveRunSnapshot(runStatus)
        if (shouldTryLiveSnapshot && sessionKey) {
          try {
            const snapshot = await readLiveRunSnapshot(sessionKey)
            if (epoch !== historyFetchEpochRef.current) return { transcriptAnchor: null }
            if (snapshot) {
              mergedRows = mergeLiveSnapshotRow(built.rows, snapshot, meta?.currentRunId || null)
            }
          } catch {
            /* best effort */
          }
        }
        mergedRows = preferDbTerminalAssistantRows(mergedRows, built.rows)
        const dbLastAssistantIdx = findLastAssistantAfterLastUser(built.rows)
        const dbTerminal = assistantRowLooksTerminal(built.rows[dbLastAssistantIdx])
        const shouldMarkResumeIncomplete =
          !!anchorRunId && shouldMarkResumeAnchorForRun(runStatus) && !dbTerminal
        if (shouldMarkResumeIncomplete && anchorRunId) {
          mergedRows = markResumeAnchorAssistantIncomplete(mergedRows, anchorRunId)
        }

        if (soft && rowsRef.current.length) {
          mergedRows = mergeSoftHistoryFetch(rowsRef.current, mergedRows)
        }
        mergedRows = collapseSameTurnAssistantsInRows(mergedRows)

        setTokenTotals(built.tokenTotals)
        setRestoredScenarioScene(built.restoredScenarioScene)
        setHistoryBoundSessionKey(sessionKey)
        const nextOldest =
          result.oldestSeq != null && Number.isFinite(result.oldestSeq)
            ? result.oldestSeq
            : oldestSeqFromRawMessages(raw)
        setHistoryOldestSeq(nextOldest)
        setHistoryHasMore(!!result.hasMore)

        const metaLive = liveRef.current
        const storeLive = metaLive?.getLive?.() ?? null
        if (
          !dbOnly &&
          !dbTerminal &&
          ((storeLive?.live && storeLive.rows.length) ||
            (metaLive?.liveSending && metaLive.liveRows?.length))
        ) {
          if (storeLive?.live && storeLive.rows.length) setRows(storeLive.rows)
          else if (metaLive?.liveSending && metaLive.liveRows?.length) setRows(metaLive.liveRows)
          return { rows: mergedRows, transcriptAnchor }
        }
        // Soft reopen: skip setRows when transcript is visually unchanged — avoids virtualizer
        // remount / scrollTop reset that looks like a top→bottom jump on a few sessions.
        const rowsUnchanged = soft && displayRowsEquivalent(rowsRef.current, mergedRows)
        if (!rowsUnchanged) {
          setRows(mergedRows)
        }
        paintedFromIdleCacheRef.current = false
        if (sessionKey) {
          const rt = getSessionRuntime(sessionKey)
          const runStatusTerminal = !isActiveRunStatus(runStatus)
          if (dbTerminal || runStatusTerminal) {
            if (
              isTurnBusy(rt) ||
              rt.turnPhase === 'reattaching' ||
              rt.turnPhase === 'degraded'
            ) {
              dispatchSessionTurnEvent(sessionKey, { type: 'TURN_IDLE' })
            }
          }
        }
        if (soft) {
          if (!rowsUnchanged) {
            replaceSessionRuntimeRowsFromHistory(sessionKey, mergedRows)
          }
        } else {
          hydrateSessionRuntimeRowsIfIdle(sessionKey, mergedRows)
        }
        return { rows: mergedRows, transcriptAnchor }
      } catch (e) {
        if (epoch !== historyFetchEpochRef.current) return { transcriptAnchor: null }
        setError(toUserFacingError((e as Error)?.message || e, '加载对话失败，请刷新后重试'))
        // Keep whatever is already on screen — wiping to [] enters home mode and
        // hides the bottom composer.
        if (!rowsRef.current.length) {
          setTokenTotals(null)
          setRestoredScenarioScene(null)
          setHistoryBoundSessionKey(null)
        }
        return { transcriptAnchor: null }
      } finally {
        if (epoch === historyFetchEpochRef.current && !deferLoadingClear) setLoading(false)
      }
    },
    [sessionKey],
  )

  const loadOlder = useCallback(async () => {
    if (!sessionKey) return { ok: false as const }
    if (!historyHasMoreRef.current || loadingOlderRef.current) return { ok: false as const }
    const beforeSeq = historyOldestSeqRef.current
    if (beforeSeq == null || beforeSeq < 1) return { ok: false as const }
    const epochAtStart = historyFetchEpochRef.current
    loadingOlderRef.current = true
    setLoadingOlder(true)
    try {
      const { api } = await import('../../lib/tauri-api.js')
      const result = await fetchSessionHistoryOlderMessages(
        (sk, limit, opts) => api.chatHistory(sk, limit, opts),
        sessionKey,
        beforeSeq,
        HISTORY_OLDER_PAGE_SIZE,
      )
      if (epochAtStart !== historyFetchEpochRef.current) return { ok: false as const }
      const built = buildHistoryViewFromRaw(result.messages)
      if (!built.rows.length) {
        setHistoryHasMore(false)
        return { ok: true as const, prepended: 0 }
      }
      const existing = rowsRef.current
      const seen = new Set(existing.map((r) => String(r.messageId || '').trim()).filter(Boolean))
      const olderUnique = built.rows.filter((r) => {
        const mid = String(r.messageId || '').trim()
        if (!mid) return true
        if (seen.has(mid)) return false
        seen.add(mid)
        return true
      })
      const nextRowsRaw = olderUnique.length ? [...olderUnique, ...existing] : existing
      // Re-fold across the page seam — seq paging can cut mid-turn so older mid
      // + newer final must collapse after concat.
      const nextRows = olderUnique.length
        ? collapseSameTurnAssistantsInRows(nextRowsRaw)
        : nextRowsRaw
      if (!olderUnique.length) {
        setHistoryHasMore(!!result.hasMore && built.rows.length > 0)
        return { ok: true as const, prepended: 0 }
      }
      setRows(nextRows)
      replaceSessionRuntimeRowsFromHistory(sessionKey, nextRows)
      const nextOldest =
        result.oldestSeq != null && Number.isFinite(result.oldestSeq)
          ? result.oldestSeq
          : oldestSeqFromRawMessages(result.messages)
      if (nextOldest != null) setHistoryOldestSeq(nextOldest)
      setHistoryHasMore(!!result.hasMore)
      return { ok: true as const, prepended: olderUnique.length }
    } catch {
      return { ok: false as const }
    } finally {
      loadingOlderRef.current = false
      setLoadingOlder(false)
    }
  }, [sessionKey])

  useEffect(() => {
    queueMicrotask(() => {
      void reload({ soft: paintedFromIdleCacheRef.current })
    })
  }, [reload])

  // 冷启动 UI-first：预热期 reload 会主动跳过；后端就绪后再拉一次历史。
  // 若挂载时已 ready，也可能是「首轮在 warming 中超时/跳过」之后才变 ready——
  // 不能再 early-return，否则会一直停在空态或超时横幅（会话列表同理会 kick）。
  useEffect(() => {
    if (!sessionKey) return
    let unsub: (() => void) | null = null
    let cancelled = false
    let readyKickTimer: number | null = null
    const kick = () => {
      if (cancelled) return
      void reload({
        soft:
          rowsRef.current.length > 0 ||
          paintedFromIdleCacheRef.current ||
          historyBoundSessionKeyRef.current === sessionKey,
      })
    }
    void import('../../lib/tauri-api.js').then((mod) => {
      if (cancelled) return
      if (mod.isBackendReady() === true) {
        // Defer slightly so we don't double-fight the mount microtask reload when
        // the gateway was already warm; still reconcile if that first race skipped.
        readyKickTimer = window.setTimeout(() => {
          if (cancelled) return
          if (historyBoundSessionKeyRef.current === sessionKey) return
          kick()
        }, 400)
        return
      }
      unsub = mod.onBackendReadyChange((ready) => {
        if (ready && !cancelled) kick()
      })
    }).catch(() => {})
    return () => {
      cancelled = true
      if (readyKickTimer != null) {
        try { window.clearTimeout(readyKickTimer) } catch { /* ignore */ }
      }
      try { unsub?.() } catch { /* ignore */ }
    }
  }, [sessionKey, reload])

  return {
    rows,
    setRows,
    loading,
    error,
    reload,
    loadOlder,
    loadingOlder,
    historyHasMore,
    historyOldestSeq,
    historyInstantPaint,
    tokenTotals,
    setTokenTotals,
    restoredScenarioScene,
    setRestoredScenarioScene,
    /** Non-null when ``rows`` came from a successful history fetch for that session key. */
    historyBoundSessionKey,
  }
}

