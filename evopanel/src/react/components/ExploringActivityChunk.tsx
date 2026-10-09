import { Fragment, memo, type ReactNode } from 'react'
import type { ActivityPiece } from '../lib/exploring-activity-group.js'
import {
  toolsForActivityPieces,
  reasoningPiecesInActivity,
} from '../lib/exploring-activity-group.js'
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

/**
 * 单个「探索中」段落（思考 + 工具 + 旁白）。
 *
 * v5.2 设计：所有 piece 平铺渲染（无二级折叠）。
 * 折叠由外层 `AssistantBubbleSlotView` 的 `<TurnHistoryFold>`（"工作中 / 已工作 X / ⏹ 已停止"）
 * 统一承担 —— 工作中默认展开，已工作 / 已停止默认折叠。
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

  // v5.2 反馈：去掉「过程 N 项」二级折叠头。所有 piece 平铺渲染；
  // 外层 TurnHistoryFold（"工作中 / 已工作 X / ⏹ 已停止"）才是唯一折叠入口。
  // v5.4 反馈：折叠后只露"最新正文"，不露历史工具/思考。
  //   - text 段（轮内正文）= 用户关心的"最新"内容 → 永远 latest
  //   - tools / reasoning 段 = 历史过程 → 折叠时 history 隐藏
  // role 切分在 renderActivityInner 内部按 piece.kind 决定，不依赖切轮。
  const renderActivityInner = (pieces: ActivityPiece[]) => {
    let reasoningOrd = 0
    const renderPiece = (piece: ActivityPiece, pi: number): ReactNode => {
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
    }
    return (
      <div className="msg-tool-activity-fold-inner">
        {(() => {
          // v5.5 反馈：用户期望"折叠后只显示最新正文"，不是所有 text 都显示。
          //   - 只有"最后一个 text piece"是 latest（永远显示）
          //   - 前面所有 text piece + 所有 tools + 所有 reasoning = history（折叠时藏）
          // 例：chunk 顺序 = tools / text① / tools / text② / tools / text③（最新）
          //   → text① text② 都是 history，text③ 是 latest。
          let lastTextPieceIndex = -1
          pieces.forEach((p, i) => {
            if (p.kind === 'text') lastTextPieceIndex = i
          })
          return pieces.map((piece, pi) => {
            const role: 'latest' | 'history' =
              piece.kind === 'text' && pi === lastTextPieceIndex
                ? 'latest'
                : 'history'
            const inner = renderPiece(piece, pi)
            if (inner == null) return null
            return (
              <div
                key={`act-wrap-${chunkIndex}-${pi}-${role}`}
                className="msg-tool-activity-piece"
                data-piece-role={role}
              >
                {inner}
              </div>
            )
          })
        })()}
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

  // v5.4：所有 piece 平铺到外层 TurnHistoryFold body；按 piece.kind 标 data-piece-role
  //       （text=latest, tools/reasoning=history）。折叠由外层 + CSS 共同控制。
  return (
    <Fragment key={`exploring-${chunkIndex}-${chunkStartIndex}`}>
      <div className={`msg-flat-activity-chunk${variant === 'fold' ? ' is-legacy-fold' : ''}`}>
        {renderActivityInner(activityPieces)}
      </div>
      {afterChunk}
    </Fragment>
  )
}

export const ExploringActivityChunk = memo(ExploringActivityChunkInner)
