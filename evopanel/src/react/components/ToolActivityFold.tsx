import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { isToolRunning } from '../../lib/chat-normalize.js'
import type { ActivityPiece } from '../lib/exploring-activity-group.js'
import {
  activityPiecesHasToolSteps,
  exploringActivityStepCount,
  exploringHeaderToolMeta,
  exploringHeaderToolSummary,
} from '../lib/exploring-activity-group.js'
import { FileEditDiffStatBrief } from './FileEditDiffPanel.js'
import { AssistantRunProgress, AssistantRunTelemetry } from './AssistantRunProgress.js'
import {
  buildSemanticRunSteps,
  formatRunSummaryMeta,
} from '../lib/semantic-run-steps.js'
import {
  resolveTurnDisplayPhase,
  turnDisplayPhaseForceExpanded,
  turnDisplayPhaseIsStreamingUi,
  turnDisplayPhaseLabel,
  turnDisplayPhaseMayCollapseWhenIdle,
  turnDisplayPhaseShowSemanticProgress,
} from '../lib/turn-display-phase.js'

/**
 * 语义运行层：
 * - 最新轮按时间线：思考(一行) → 正文 → 工具
 * - 下一轮同样依次替换显示；更早轮次收入窗口，右下角「明细」可展开
 * - live 指标在气泡底 StreamRunStatusLine
 */
export function ToolActivityFold({
  tools,
  activityPieces,
  turnTools,
  isStreaming = false,
  hasFinalReplyBelow = false,
  forceCollapsed = false,
  preferLazyDuringStream: _preferLazyDuringStream = false,
  durationLabel,
  liveTokenStr,
  earlierRoundCount = 0,
  showFullHistory = false,
  onToggleFullHistory,
  children,
}: {
  tools: unknown[]
  activityPieces?: ActivityPiece[]
  turnTools?: unknown[]
  isStreaming?: boolean
  hasFinalReplyBelow?: boolean
  forceCollapsed?: boolean
  preferLazyDuringStream?: boolean
  durationLabel?: string
  liveTokenStr?: string
  earlierRoundCount?: number
  showFullHistory?: boolean
  onToggleFullHistory?: () => void
  children: ReactNode
}) {
  const activityStepCount = activityPieces?.length
    ? exploringActivityStepCount(activityPieces, tools)
    : tools?.length ?? 0
  const hasToolActivity = activityPieces?.length
    ? activityPiecesHasToolSteps(activityPieces)
    : (tools?.length ?? 0) > 0
  const stepCount = hasToolActivity ? activityStepCount : 0
  const pieceCount = activityPieces?.length ?? tools?.length ?? 0
  const { toolLabel, fileStats } = useMemo(
    () => exploringHeaderToolMeta(tools, activityPieces, turnTools ?? tools),
    [tools, activityPieces, turnTools],
  )
  const toolSummary = useMemo(
    () => exploringHeaderToolSummary(tools, activityPieces, turnTools ?? tools),
    [tools, activityPieces, turnTools],
  )
  const hasFileEditStats = fileStats.added > 0 || fileStats.removed > 0
  const runningCount = useMemo(
    () => (tools || []).filter((t) => isToolRunning(t)).length,
    [tools],
  )
  const anyRunning = runningCount > 0
  const phase = resolveTurnDisplayPhase({ isStreaming, hasFinalReplyBelow, forceCollapsed })
  const mayCollapseWhenIdle = turnDisplayPhaseMayCollapseWhenIdle(phase)
  const forceExpanded = turnDisplayPhaseForceExpanded(phase)
  const streamingUi = turnDisplayPhaseIsStreamingUi(phase)
  const showSemantic = turnDisplayPhaseShowSemanticProgress(phase) && hasToolActivity

  const semanticSteps = useMemo(() => buildSemanticRunSteps(tools || [], 12), [tools])
  const summaryMeta = useMemo(
    () =>
      formatRunSummaryMeta({
        durationLabel,
        toolCount: tools?.length ?? 0,
      }),
    [durationLabel, tools],
  )
  const liveIsActive = anyRunning || streamingUi
  const tokenStr = String(liveTokenStr || '').trim()

  const [userExpanded, setUserExpanded] = useState(false)
  const [streamFoldOpen, setStreamFoldOpen] = useState<boolean | null>(null)
  const wasStreamingRef = useRef(isStreaming)
  const streamFoldOpenRef = useRef<boolean | null>(null)
  const [overflowing, setOverflowing] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const lastScrollHeightRef = useRef(0)
  const autoFollowRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const lastProgrammaticScrollRef = useRef(0)
  const streamingActiveRef = useRef(false)

  useEffect(() => {
    streamFoldOpenRef.current = streamFoldOpen
  }, [streamFoldOpen])

  useEffect(() => {
    if (forceExpanded) {
      queueMicrotask(() => setUserExpanded(true))
    }
  }, [forceExpanded])

  useEffect(() => {
    const wasStreaming = wasStreamingRef.current
    wasStreamingRef.current = isStreaming
    if (!wasStreaming || isStreaming) return
    setUserExpanded(false)
    setStreamFoldOpen(null)
  }, [isStreaming, hasFinalReplyBelow])

  useEffect(() => {
    if (showFullHistory) {
      autoFollowRef.current = false
    }
  }, [showFullHistory])

  const defaultStreamExpanded = true
  const expanded = forceExpanded
    ? true
    : isStreaming
      ? (streamFoldOpen ?? defaultStreamExpanded)
      : mayCollapseWhenIdle
        ? userExpanded
        : userExpanded
  /** 语义层：最新轮工具/思考/正文始终直接外露 */
  const contentOpen = showSemantic ? true : expanded

  const label = (() => {
    if (showSemantic || streamingUi || anyRunning) {
      return toolLabel ? `Running · ${toolLabel}` : 'Running'
    }
    return toolLabel ? `Ran ${toolLabel}` : turnDisplayPhaseLabel(phase, expanded)
  })()

  const handleToggle = useCallback(() => {
    if (forceExpanded || showSemantic) return
    if (isStreaming) {
      setStreamFoldOpen((prev) => {
        const current = prev ?? defaultStreamExpanded
        return !current
      })
      return
    }
    setUserExpanded((prev) => !prev)
  }, [forceExpanded, showSemantic, isStreaming, defaultStreamExpanded])

  useEffect(() => {
    streamingActiveRef.current = streamingUi || anyRunning
  }, [streamingUi, anyRunning])

  const syncScrollViewport = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    // 折叠区已改为跟随文档流，不再做内嵌滚动判定
    setOverflowing(false)
    if (!contentOpen) return
    lastScrollHeightRef.current = el.scrollHeight
  }, [contentOpen])

  useEffect(() => {
    syncScrollViewport()
  }, [pieceCount, stepCount, contentOpen, showFullHistory, syncScrollViewport])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !contentOpen) return
    syncScrollViewport()
    const ro = new ResizeObserver(() => syncScrollViewport())
    ro.observe(el)
    for (const child of el.children) {
      ro.observe(child)
    }
    return () => ro.disconnect()
  }, [contentOpen, syncScrollViewport])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !contentOpen) return

    const onScroll = () => {
      if (Date.now() - lastProgrammaticScrollRef.current < 120) {
        lastScrollTopRef.current = el.scrollTop
        return
      }
      const st = el.scrollTop
      const prev = lastScrollTopRef.current
      const distBottom = el.scrollHeight - (st + el.clientHeight)
      if (st < prev - 1 && distBottom > 48) {
        autoFollowRef.current = false
      }
      if (distBottom <= 48) autoFollowRef.current = true
      lastScrollTopRef.current = st
    }
    const onWheel = (e: WheelEvent) => {
      const distBottom = el.scrollHeight - (el.scrollTop + el.clientHeight)
      if (e.deltaY < 0 && distBottom > 48) {
        autoFollowRef.current = false
        return
      }
      if (e.deltaY > 0 && distBottom - e.deltaY <= 48) {
        autoFollowRef.current = true
      }
    }

    lastScrollTopRef.current = el.scrollTop
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
    }
  }, [contentOpen])

  if (stepCount === 0) return <>{children}</>

  const foldMeta = !showSemantic ? (
    <span className="msg-tool-activity-fold-meta">
      {hasFileEditStats ? (
        <span className="msg-tool-activity-fold-tools" title={toolSummary}>
          <FileEditDiffStatBrief stats={fileStats} />
        </span>
      ) : null}
      <span
        className={`msg-tool-activity-fold-chevron${expanded ? ' is-expanded' : ''}`}
        aria-hidden
      />
    </span>
  ) : null

  return (
    <div
      className={`msg-assistant-run-block${showSemantic ? ' is-semantic-running' : ''}${
        showSemantic && showFullHistory ? ' is-full-history' : ''
      }`}
    >
      {showSemantic ? (
        <AssistantRunProgress steps={semanticSteps} isLive={liveIsActive} />
      ) : null}

      <details
        className={`msg-tool-activity-fold${contentOpen ? ' is-expanded' : ' is-collapsed'}${
          anyRunning ? ' is-running' : ' is-done'
        }${streamingUi ? ' is-streaming' : ''}${showSemantic ? ' is-live-body' : ''}`}
        open={contentOpen}
      >
        {!showSemantic ? (
          <summary
            className="msg-tool-activity-fold-toggle"
            onClick={(e) => {
              e.preventDefault()
              handleToggle()
            }}
          >
            <span className="msg-tool-activity-fold-label">{label}</span>
            {foldMeta}
          </summary>
        ) : null}
        <div
          ref={scrollRef}
          className={`msg-tool-activity-fold-scroll${overflowing ? ' is-overflowing' : ''}`}
          hidden={!contentOpen}
        >
          {contentOpen ? children : null}
        </div>
      </details>

      {showSemantic ? (
        <AssistantRunTelemetry
          summaryMeta={!liveIsActive ? summaryMeta || undefined : undefined}
          liveTokenStr={!liveIsActive ? tokenStr || undefined : undefined}
          isLive={liveIsActive}
          earlierRoundCount={earlierRoundCount}
          showFullHistory={showFullHistory}
          onToggleFullHistory={onToggleFullHistory}
        />
      ) : null}
    </div>
  )
}
