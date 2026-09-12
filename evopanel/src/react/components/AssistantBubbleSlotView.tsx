import { memo, type ReactNode } from 'react'
import { assistantBodiesLooselySame } from '../../lib/chat-normalize.js'
import type { AssistantBubbleDisplayPlan } from '../lib/message-row-display-plan.js'
import { hasVisibleBodyBelowActivityChunk } from '../lib/message-row-stream-display.js'
import { bubbleMarkdownText, visibleAssistantText, visibleExploringInnerText, visiblePreToolTimelineText } from '../lib/message-row-visible-text.js'
import type { MessageSegment, SubagentStreamTask, TerminalStreamTask } from '../chat-types.js'
import { ExploringActivityChunk } from './ExploringActivityChunk.js'
import { MarkdownHtml } from './MarkdownHtml.js'
import { ReasoningInlineBlock } from './ReasoningInlineBlock.js'
import { StreamRunStatusLine } from './StreamRunStatusLine.js'
import { ToolCallList } from './ToolCallList.js'

/** 按 display-plan slots 顺序渲染助手气泡内容（唯一 DOM 顺序出口） */
function AssistantBubbleSlotViewInner({
  plan,
  displaySegments,
  tools,
  rawText,
  reasoningPreview,
  isStreaming,
  askInline,
  suppressPlanExecPromptNoise,
  interactiveToolApproval,
  subagentTasks,
  terminalStreams,
  onOpenFile,
  onToolApproval,
  toolApprovalBusy,
  hideSubagentInnerTools,
  showToolTiming,
  suppressExploringFold = false,
  sessionKey,
  compareSessionKey,
  onOpenKnowledgeMap,
  durationLabel,
  liveTokenStr,
}: {
  plan: AssistantBubbleDisplayPlan
  displaySegments: MessageSegment[]
  tools: unknown[]
  rawText: string
  reasoningPreview: string
  isStreaming: boolean
  askInline: ReactNode
  suppressPlanExecPromptNoise: boolean
  interactiveToolApproval: boolean
  subagentTasks?: Record<string, SubagentStreamTask>
  terminalStreams?: Record<string, TerminalStreamTask>
  onOpenFile?: (rawUrl: string, name?: string) => void
  onToolApproval?: (
    action: 'approve' | 'approve_all' | 'deny' | 'grant_all' | 'approve_remember',
    toolCallId?: string,
    hint?: { tool_name?: string; summary?: string; args?: Record<string, unknown> },
  ) => void
  toolApprovalBusy?: boolean
  hideSubagentInnerTools?: boolean
  showToolTiming?: boolean
  /** 工作轨迹：不包 Exploring/Explored，每条工具直接平铺 */
  suppressExploringFold?: boolean
  sessionKey?: string
  compareSessionKey?: string
  onOpenKnowledgeMap?: () => void
  durationLabel?: string
  liveTokenStr?: string
}) {
  const layout = plan.layout
  const displayChunks = layout?.displayChunks ?? []
  const lastReasoningSegIdx = layout?.lastReasoningSegIdx ?? -1
  const lastTimelineSegmentKind = layout?.lastTimelineSegmentKind
  const streamTextPhase = layout?.streamTextPhase ?? 'pre_tools'
  const firstActivityChunkIndex = layout?.firstActivityChunkIndex ?? -1
  const finalReplyChunkIndex = layout?.finalReplyChunkIndex ?? -1
  const pendingReasoningSegIndex = plan.pendingReasoningSegIndex

  const renderChunk = (ci: number) => {
    const chunk = displayChunks[ci]
    if (!chunk) return null
    if (chunk.kind === 'text') {
      const segText = bubbleMarkdownText(
        firstActivityChunkIndex >= 0 && ci < firstActivityChunkIndex
          ? visiblePreToolTimelineText(chunk.text, suppressPlanExecPromptNoise, isStreaming)
          : visibleExploringInnerText(chunk.text, suppressPlanExecPromptNoise, isStreaming, tools),
      )
      if (!String(segText || '').trim()) return null
      if (
        !isStreaming &&
        finalReplyChunkIndex >= 0 &&
        ci !== finalReplyChunkIndex &&
        displayChunks[finalReplyChunkIndex]?.kind === 'text' &&
        assistantBodiesLooselySame(chunk.text, displayChunks[finalReplyChunkIndex].text)
      ) {
        return null
      }
      const textClass =
        ci === finalReplyChunkIndex
          ? 'msg-text msg-ai-final-reply'
          : firstActivityChunkIndex >= 0 && ci < firstActivityChunkIndex
            ? 'msg-text msg-ai-plan-text'
            : 'msg-text'
      // 正文后一旦出现工具/思考会 seal；封存段立刻走完整 Markdown（不再等整轮结束）。
      return (
        <MarkdownHtml
          key={`seg-t-${ci}`}
          text={segText}
          className={textClass}
          isStreaming={false}
          onOpenWorkspaceFile={onOpenFile}
        />
      )
    }
    if (chunk.kind === 'tools-standalone') {
      return (
        <ToolCallList
          key={`seg-k-${ci}`}
          tools={tools}
          filterIds={chunk.ids}
          subagentTasks={subagentTasks}
          terminalStreams={terminalStreams}
          onToolApproval={onToolApproval}
          toolApprovalBusy={toolApprovalBusy}
          interactiveToolApproval={interactiveToolApproval}
          hideSubagentInnerTools={hideSubagentInnerTools}
          activityGrouped={false}
          isStreaming={isStreaming}
          showToolTiming={showToolTiming}
          sessionKey={sessionKey}
          compareLogSource={`tools-standalone#${ci}`}
          compareSessionKey={compareSessionKey}
          onOpenKnowledgeMap={onOpenKnowledgeMap}
        />
      )
    }
    if (suppressExploringFold) {
      const ids = (chunk.pieces || [])
        .filter((p) => p?.kind === 'tools')
        .flatMap((p) => (p.kind === 'tools' && Array.isArray(p.ids) ? p.ids : []))
      return (
        <ToolCallList
          key={`trail-flat-${ci}-${chunk.startIndex}`}
          tools={tools}
          filterIds={ids.length ? ids : undefined}
          subagentTasks={subagentTasks}
          terminalStreams={terminalStreams}
          onToolApproval={onToolApproval}
          toolApprovalBusy={toolApprovalBusy}
          interactiveToolApproval={interactiveToolApproval}
          hideSubagentInnerTools={hideSubagentInnerTools}
          activityGrouped={false}
          isStreaming={isStreaming}
          showToolTiming={showToolTiming}
          sessionKey={sessionKey}
          compareLogSource={`trail-flat#${ci}`}
          compareSessionKey={compareSessionKey}
          onOpenKnowledgeMap={onOpenKnowledgeMap}
        />
      )
    }
    return (
      <ExploringActivityChunk
        key={`exploring-${ci}-${chunk.startIndex}`}
        chunkIndex={ci}
        chunkStartIndex={chunk.startIndex}
        activityPieces={chunk.pieces}
        tools={tools}
        isStreaming={isStreaming}
        lastReasoningSegIdx={lastReasoningSegIdx}
        lastTimelineSegmentKind={lastTimelineSegmentKind}
        streamTextPhase={streamTextPhase}
        rawText={rawText}
        reasoningPreview={reasoningPreview}
        displaySegments={displaySegments}
        skipReasoningSegIndex={pendingReasoningSegIndex}
        suppressPlanExecPromptNoise={suppressPlanExecPromptNoise}
        visibleAssistantText={visibleAssistantText}
        subagentTasks={subagentTasks}
        terminalStreams={terminalStreams}
        onToolApproval={onToolApproval}
        toolApprovalBusy={toolApprovalBusy}
        interactiveToolApproval={interactiveToolApproval}
        hideSubagentInnerTools={hideSubagentInnerTools}
        showToolTiming={showToolTiming}
        sessionKey={sessionKey}
        onOpenFile={onOpenFile}
        compareSessionKey={compareSessionKey}
        onOpenKnowledgeMap={onOpenKnowledgeMap}
        hasFinalReplyBelow={hasVisibleBodyBelowActivityChunk(plan.slots, ci, {
          tools,
          suppressPlanExecPromptNoise,
          isStreaming,
        })}
        durationLabel={durationLabel}
        liveTokenStr={liveTokenStr}
      />
    )
  }

  return (
    <>
      {askInline}
      {plan.slots.map((slot, si) => {
        switch (slot.kind) {
          case 'top-reasoning':
            return (
              <ReasoningInlineBlock
                key={`top-r-${slot.ord}-${si}`}
                text={slot.text}
                label={slot.label}
                isStreamingActive={slot.isStreamingActive}
                onOpenWorkspaceFile={onOpenFile}
              />
            )
          case 'plan-top':
            return (
              <MarkdownHtml
                key={`plan-top-${si}`}
                text={bubbleMarkdownText(slot.text)}
                className="msg-text msg-ai-plan-text"
                isStreaming={isStreaming}
                onOpenWorkspaceFile={onOpenFile}
              />
            )
          case 'chunk':
            return <div key={`chunk-wrap-${si}`} className="msg-chunk-slot">{renderChunk(slot.chunkIndex)}</div>
          case 'reasoning-pending':
            return (
              <ReasoningInlineBlock
                key={`reasoning-pending-${slot.segIndex}-${si}`}
                text={slot.text}
                label="思考"
                isStreamingActive
                onOpenWorkspaceFile={onOpenFile}
              />
            )
          case 'live-tail':
            return (
              <MarkdownHtml
                key={`live-tail-${si}`}
                text={slot.text}
                className="msg-text msg-ai-final-reply msg-ai-final-reply--after-activity"
                isStreaming={slot.isStreaming}
                onOpenWorkspaceFile={onOpenFile}
              />
            )
          case 'plain-body':
            return (
              <MarkdownHtml
                key={`plain-body-${si}`}
                text={slot.text}
                className="msg-text msg-ai-final-reply"
                isStreaming={slot.isStreaming}
                onOpenWorkspaceFile={onOpenFile}
              />
            )
          case 'legacy-tools':
            return (
              <ToolCallList
                key={`legacy-tools-${si}`}
                tools={tools}
                subagentTasks={subagentTasks}
                terminalStreams={terminalStreams}
                onToolApproval={onToolApproval}
                toolApprovalBusy={toolApprovalBusy}
                interactiveToolApproval={interactiveToolApproval}
                hideSubagentInnerTools={hideSubagentInnerTools}
                activityGrouped={suppressExploringFold ? false : undefined}
                isStreaming={isStreaming}
                showToolTiming={showToolTiming}
                sessionKey={sessionKey}
                onOpenKnowledgeMap={onOpenKnowledgeMap}
              />
            )
          case 'legacy-body':
            return (
              <MarkdownHtml
                key={`legacy-body-${si}`}
                text={slot.text}
                className="msg-text msg-ai-final-reply"
                isStreaming={slot.isStreaming}
                onOpenWorkspaceFile={onOpenFile}
              />
            )
          case 'orphan-tools':
            return (
              <ToolCallList
                key={`orphan-tools-${si}`}
                tools={slot.tools}
                subagentTasks={subagentTasks}
                terminalStreams={terminalStreams}
                onToolApproval={onToolApproval}
                toolApprovalBusy={toolApprovalBusy}
                interactiveToolApproval={interactiveToolApproval}
                hideSubagentInnerTools={hideSubagentInnerTools}
                isStreaming={isStreaming}
                showToolTiming={showToolTiming}
                onOpenKnowledgeMap={onOpenKnowledgeMap}
              />
            )
          case 'tool-row':
            return (
              <ToolCallList
                key={`tool-row-${si}-${slot.toolCallIds.join(',')}`}
                tools={tools}
                filterIds={slot.toolCallIds}
                subagentTasks={subagentTasks}
                terminalStreams={terminalStreams}
                onToolApproval={onToolApproval}
                toolApprovalBusy={toolApprovalBusy}
                interactiveToolApproval={interactiveToolApproval}
                hideSubagentInnerTools={hideSubagentInnerTools}
                activityGrouped={false}
                isStreaming={isStreaming}
                showToolTiming={showToolTiming}
                sessionKey={sessionKey}
                compareLogSource={`agui-tool-row#${si}`}
                compareSessionKey={compareSessionKey}
                onOpenKnowledgeMap={onOpenKnowledgeMap}
              />
            )
          case 'thinking-wait':
            return (
              <StreamRunStatusLine
                key={`thinking-wait-${si}`}
                label={slot.label}
                durationLabel={durationLabel}
                toolCount={Array.isArray(tools) ? tools.length : 0}
                showTip={!!isStreaming}
              />
            )
          default:
            return null
        }
      })}
    </>
  )
}

export const AssistantBubbleSlotView = memo(AssistantBubbleSlotViewInner)
