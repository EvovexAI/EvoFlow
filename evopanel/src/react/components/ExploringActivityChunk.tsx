import { Fragment, memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ActivityPiece } from '../lib/exploring-activity-group.js'
import { toolsForActivityPieces, reasoningPiecesInActivity } from '../lib/exploring-activity-group.js'
import {
  reasoningLabelForActivityPiece,
} from '../lib/message-row-reasoning-display.js'
import {
  resolveActiveReasoningDisplayText,
  shouldHidePostToolReasoningAsBodyDup,
  activityFoldHasVisibleInnerContent,
  isReasoningPieceActivelyStreaming,
} from '../lib/message-row-reasoning-render.js'
import {
  LIVE_TOOL_ROUND_WINDOW,
  windowLiveExploringPieces,
} from '../lib/window-live-exploring-pieces.js'
import type { MessageSegment, SubagentStreamTask, TerminalStreamTask } from '../chat-types.js'
import { ReasoningInlineBlock } from './ReasoningInlineBlock.js'
import { ToolActivityFold } from './ToolActivityFold.js'
import { ToolCallList } from './ToolCallList.js'
import { MarkdownHtml } from './MarkdownHtml.js'

/** 展开完整过程时不再裁剪工具轮次 */
const FULL_HISTORY_TOOL_ROUNDS = 10_000

function ExploringActivityChunkInner({
  chunkIndex,
  chunkStartIndex,
  activityPieces,
  tools,
  isStreaming,
  lastReasoningSegIdx,
  lastTimelineSegmentKind,
  streamTextPhase,
  rawText,
  reasoningPreview = '',
  displaySegments = [],
  skipReasoningSegIndex = null,
  suppressPlanExecPromptNoise,
  visibleAssistantText,
  subagentTasks,
  terminalStreams,
  onToolApproval,
  toolApprovalBusy,
  interactiveToolApproval,
  hideSubagentInnerTools,
  showToolTiming,
  sessionKey,
  onOpenFile,
  compareSessionKey,
  onOpenKnowledgeMap,
  hasFinalReplyBelow = false,
  durationLabel,
  liveTokenStr,
  afterChunk,
}: {
  chunkIndex: number
  chunkStartIndex: number
  activityPieces: ActivityPiece[]
  tools: unknown[]
  isStreaming: boolean
  lastReasoningSegIdx: number
  /** layout 时间线末尾 segment；仅 reasoning 时当前段才视为流式活跃 */
  lastTimelineSegmentKind?: string
  streamTextPhase: 'pre_tools' | 'post_tools'
  rawText: string
  reasoningPreview?: string
  displaySegments?: MessageSegment[]
  /** display-plan 的 reasoning-pending 已负责该段时，fold 内跳过 */
  skipReasoningSegIndex?: number | null
  suppressPlanExecPromptNoise: boolean
  visibleAssistantText: (
    raw: string,
    tools: unknown[],
    suppress?: boolean,
    streaming?: boolean,
  ) => string
  subagentTasks?: Record<string, SubagentStreamTask>
  terminalStreams?: Record<string, TerminalStreamTask>
  onToolApproval?: (
    action: 'approve' | 'approve_all' | 'deny' | 'grant_all' | 'approve_remember',
    toolCallId?: string,
    hint?: { tool_name?: string; summary?: string; args?: Record<string, unknown> },
  ) => void
  toolApprovalBusy?: boolean
  interactiveToolApproval?: boolean
  hideSubagentInnerTools?: boolean
  showToolTiming?: boolean
  sessionKey?: string
  onOpenFile?: (rawUrl: string, name?: string) => void
  compareSessionKey?: string
  onOpenKnowledgeMap?: () => void
  hasFinalReplyBelow?: boolean
  /** 运行时长等用户层摘要，如 9m40s */
  durationLabel?: string
  /** 本轮流式累计 token 展示串 */
  liveTokenStr?: string
  afterChunk?: ReactNode
}) {
  const [showFullHistory, setShowFullHistory] = useState(false)

  // 流式结束后恢复默认窗口行为（结束后本来就全量）
  useEffect(() => {
    if (!isStreaming) setShowFullHistory(false)
  }, [isStreaming])

  const windowed = useMemo(
    () =>
      windowLiveExploringPieces({
        pieces: activityPieces,
        tools,
        keepLastToolRounds: showFullHistory ? FULL_HISTORY_TOOL_ROUNDS : LIVE_TOOL_ROUND_WINDOW,
        isStreaming: !!isStreaming,
      }),
    [activityPieces, tools, isStreaming, showFullHistory],
  )

  const renderPieces = windowed.visiblePieces
  const hiddenEarlierRounds = windowed.hiddenToolRoundCount
  const preferLazyDuringStream = !showFullHistory && hiddenEarlierRounds > 0
  const showHistoryToggle = !!isStreaming && (hiddenEarlierRounds > 0 || showFullHistory)

  // 标题步数 / 可见性判断仍用全量 pieces；children 只用窗口（或完整过程）
  const activityTools = toolsForActivityPieces(activityPieces, tools)
  const hasToolPiecesInActivity = activityPieces.some(
    (p) => p.kind === 'tools' && p.ids.some((id) => String(id).trim()),
  )
  const hasExploringContent =
    activityTools.length > 0 ||
    reasoningPiecesInActivity(activityPieces).length > 0 ||
    (isStreaming && hasToolPiecesInActivity)
  const hasVisibleFoldInner = activityFoldHasVisibleInnerContent({
    activityPieces,
    tools,
    isStreaming,
    lastReasoningSegIdx,
    streamTextPhase,
    displaySegments,
    rawText,
    reasoningPreview,
    skipReasoningSegIndex: skipReasoningSegIndex ?? null,
    suppressPlanExecPromptNoise,
    lastTimelineSegmentKind,
  })
  const shouldHideReasoningAsBodyDup = (
    piece: Extract<ActivityPiece, { kind: 'reasoning' }>,
  ): boolean =>
    shouldHidePostToolReasoningAsBodyDup({
      isStreaming,
      streamTextPhase,
      piece,
      activityPieces,
      displaySegments,
      rawText,
    })

  const renderActivityInner = () => {
    let reasoningOrd = 0
    return (
      <div className="msg-tool-activity-fold-inner">
        {renderPieces.map((piece, pi) => {
          if (piece.kind === 'reasoning') {
            if (skipReasoningSegIndex != null && piece.segIndex === skipReasoningSegIndex) {
              return null
            }
            if (shouldHideReasoningAsBodyDup(piece)) return null
            const isActiveReasoning = isReasoningPieceActivelyStreaming({
              isStreaming,
              pieceSegIndex: piece.segIndex,
              lastReasoningSegIdx,
              lastTimelineSegmentKind,
              pieceId: piece.id,
            })
            const displayText = resolveActiveReasoningDisplayText(
              piece.text,
              reasoningPreview,
              isActiveReasoning,
            )
            if (!String(displayText || '').trim() && !isActiveReasoning) return null
            const ord = reasoningOrd++
            return (
              <ReasoningInlineBlock
                key={`act-r-${chunkIndex}-${piece.segIndex}-${ord}`}
                text={displayText}
                inExploring
                label={reasoningLabelForActivityPiece(0, ord, true)}
                isStreamingActive={isActiveReasoning}
                onOpenWorkspaceFile={onOpenFile}
              />
            )
          }
          if (piece.kind === 'text') {
            const innerText = visibleAssistantText(
              piece.text,
              tools,
              suppressPlanExecPromptNoise,
              true,
            )
            if (!String(innerText || '').trim()) return null
            return (
              <div
                key={`act-x-${chunkIndex}-${piece.segIndex}-${pi}`}
                className="msg-text msg-ai-final-reply msg-ai-final-reply--in-round"
              >
                <MarkdownHtml
                  text={innerText}
                  className="msg-text"
                  /* 轮内正文用正常 Markdown，勿走 msg-stream-plain 黑框纯文本 */
                  isStreaming={false}
                  onOpenWorkspaceFile={onOpenFile}
                />
              </div>
            )
          }
          if (piece.kind === 'tools') {
            return (
              <ToolCallList
                key={`act-t-${chunkIndex}-${piece.segIndex}-${pi}`}
                tools={tools}
                filterIds={piece.ids}
                subagentTasks={subagentTasks}
                terminalStreams={terminalStreams}
                onToolApproval={onToolApproval}
                toolApprovalBusy={toolApprovalBusy}
                interactiveToolApproval={interactiveToolApproval}
                hideSubagentInnerTools={hideSubagentInnerTools}
                nestedInExploring
                activityGrouped={false}
                isStreaming={!!isStreaming}
                showToolTiming={showToolTiming}
                sessionKey={sessionKey}
                compareLogSource={`exploring#${chunkIndex}`}
                compareSessionKey={compareSessionKey}
                onOpenKnowledgeMap={onOpenKnowledgeMap}
              />
            )
          }
          return null
        })}
      </div>
    )
  }

  if (!hasExploringContent || !hasVisibleFoldInner) {
    return (
      <Fragment key={`exploring-${chunkIndex}-${chunkStartIndex}`}>{afterChunk}</Fragment>
    )
  }

  return (
    <Fragment key={`exploring-${chunkIndex}-${chunkStartIndex}`}>
      <ToolActivityFold
        key={`exploring-fold-${chunkIndex}-${chunkStartIndex}`}
        tools={activityTools}
        turnTools={tools}
        activityPieces={activityPieces}
        isStreaming={!!isStreaming}
        hasFinalReplyBelow={hasFinalReplyBelow}
        preferLazyDuringStream={preferLazyDuringStream}
        durationLabel={durationLabel}
        liveTokenStr={liveTokenStr}
        earlierRoundCount={hiddenEarlierRounds}
        showFullHistory={showFullHistory}
        onToggleFullHistory={
          showHistoryToggle ? () => setShowFullHistory((v) => !v) : undefined
        }
      >
        {renderActivityInner()}
      </ToolActivityFold>
      {afterChunk}
    </Fragment>
  )
}

export const ExploringActivityChunk = memo(ExploringActivityChunkInner)
