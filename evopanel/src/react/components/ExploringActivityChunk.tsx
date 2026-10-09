import { Fragment, memo, type ReactNode } from 'react'
import type { ActivityPiece } from '../lib/exploring-activity-group.js'
import {
  toolsForActivityPieces,
  reasoningPiecesInActivity,
} from '../lib/exploring-activity-group.js'
import { findLatestDisplayRoundStart } from '../lib/window-live-exploring-pieces.js'
import {
  reasoningLabelForActivityPiece,
} from '../lib/message-row-reasoning-display.js'
import {
  resolveActiveReasoningDisplayText,
  shouldHidePostToolReasoningAsBodyDup,
  activityFoldHasVisibleInnerContent,
  isReasoningPieceActivelyStreaming,
} from '../lib/message-row-reasoning-render.js'
import type { MessageSegment, SubagentStreamTask, TerminalStreamTask } from '../chat-types.js'
import { ReasoningInlineBlock } from './ReasoningInlineBlock.js'
import { ToolCallList } from './ToolCallList.js'
import { MarkdownHtml } from './MarkdownHtml.js'
import { TurnHistoryFold } from './TurnHistoryFold.js'

/**
 * 单个「探索中」段落（思考 + 工具 + 旁白）。
 *
 * v3 设计：把 activityPieces 按 findLatestDisplayRoundStart 切成两段：
 *   - livePieces   = 工具后第一个新思考/正文 起的所有 piece → 外露（最新轮）
 *   - historyPieces = 它之前的所有 piece → 进内层 TurnHistoryFold（默认收起）
 *
 * 视觉效果：
 *   - 当前正在流式的最新思考/正文/工具/旁白 永远可见；
 *   - 更早的轮次（历史）默认收在「历史 N 项」折叠里，用户点开看完整轨迹。
 */
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
  durationLabel: _durationLabel = undefined,
  liveTokenStr: _liveTokenStr = undefined,
  afterChunk,
  variant = 'flat',
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
  /** 运行时长等用户层摘要，如 9m40s（v2 折叠头已自取，本组件不再用） */
  durationLabel?: string
  /** 本轮流式累计 token 展示串（v2 折叠头已自取，本组件不再用） */
  liveTokenStr?: string
  afterChunk?: ReactNode
  /** v2 仅保留 flat 路径；'fold' 已被外层 TurnHistoryFold 接管 */
  variant?: 'fold' | 'flat'
}) {
  // 标题步数 / 可见性判断仍用全量 pieces；children 直接全量
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

  // v3：把 activityPieces 按 findLatestDisplayRoundStart 切成历史 / 最新两段。
  // 历史 = 工具之后再次出现新思考/正文 之前的所有 piece
  // 最新 = 那个边界起（含）到结尾的所有 piece
  // 边界 = 0 表示整段是同一轮（没有切分点），历史为空。
  const roundStart = isStreaming ? findLatestDisplayRoundStart(activityPieces) : 0
  const livePieces = activityPieces.slice(roundStart)
  const historyPieces = activityPieces.slice(0, roundStart)
  // history 里有意义的轮次数 = 历史里 tools piece 的段数
  const historyToolRoundCount = historyPieces.filter(
    (p) => p.kind === 'tools' && p.ids.some((id) => String(id).trim()),
  ).length
  const historyFoldLabel = historyToolRoundCount > 0
    ? `历史 ${historyToolRoundCount} 轮`
    : '历史过程'

  const renderActivityInner = (pieces: ActivityPiece[]) => {
    let reasoningOrd = 0
    return (
      <div className="msg-tool-activity-fold-inner">
        {pieces.map((piece, pi) => {
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
                collapsible
                label={reasoningLabelForActivityPiece(0, ord, true)}
                isStreamingActive={isActiveReasoning}
                durationMs={
                  piece.startedAtMs != null && piece.endedAtMs != null
                    ? Math.max(0, piece.endedAtMs - piece.startedAtMs)
                    : null
                }
                startedAtMs={piece.startedAtMs ?? null}
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

  if (!hasExploringContent) {
    return (
      <Fragment key={`exploring-${chunkIndex}-${chunkStartIndex}`}>{afterChunk}</Fragment>
    )
  }

  if (!hasVisibleFoldInner) {
    return (
      <Fragment key={`exploring-${chunkIndex}-${chunkStartIndex}`}>{afterChunk}</Fragment>
    )
  }

  // v3：fold / flat 两条路径合并为同一条平铺；variant 保留仅为向后兼容。
  // 历史轮次进内层 TurnHistoryFold（默认收起），最新轮永远外露。
  return (
    <Fragment key={`exploring-${chunkIndex}-${chunkStartIndex}`}>
      {historyPieces.length > 0 ? (
        <TurnHistoryFold
          key={`exploring-history-${chunkIndex}-${chunkStartIndex}`}
          label={historyFoldLabel}
        >
          {renderActivityInner(historyPieces)}
        </TurnHistoryFold>
      ) : null}
      <div className={`msg-flat-activity-chunk${variant === 'fold' ? ' is-legacy-fold' : ''}`}>
        {renderActivityInner(livePieces)}
      </div>
      {afterChunk}
    </Fragment>
  )
}

export const ExploringActivityChunk = memo(ExploringActivityChunkInner)
