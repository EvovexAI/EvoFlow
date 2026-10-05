import { Fragment, memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import { assistantBodiesLooselySame } from '../../lib/chat-normalize.js'
import { collectTurnChangedFiles } from '../file-diff-util.js'
import { collectTurnDeliverables } from '../../lib/deliverable-mentions.js'
import { DeliverableCards } from './DeliverableCards.js'
import {
  recordWorkspaceFileChange,
  revertibleCountFor,
  revertWorkspaceFiles,
} from '../../lib/workspace-change-journal.js'
import { showConfirm } from '../../components/modal.js'
import { ChangedFilesSummaryRow } from './ChangedFilesSummaryRow.js'
import type { AssistantBubbleDisplayPlan, AssistantBubbleSlot } from '../lib/message-row-display-plan.js'
import { hasVisibleBodyBelowActivityChunk } from '../lib/message-row-stream-display.js'
import { bubbleMarkdownText, visibleAssistantText, visibleExploringInnerText, visiblePreToolTimelineText } from '../lib/message-row-visible-text.js'
import { formatWorkDurationText } from '../lib/turn-timing.js'
import type { MessageSegment, SubagentStreamTask, TerminalStreamTask } from '../chat-types.js'
import { ExploringActivityChunk } from './ExploringActivityChunk.js'
import { MarkdownHtml } from './MarkdownHtml.js'
import { ReasoningInlineBlock } from './ReasoningInlineBlock.js'
import { StreamRunStatusLine } from './StreamRunStatusLine.js'
import { ToolCallList } from './ToolCallList.js'
import { TurnHistoryFold } from './TurnHistoryFold.js'

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
  messageId,
  turnInterrupted,
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
  /** 落库消息 id（完成态「已工作」折叠头的 data-testid 用） */
  messageId?: string
  /** 回合被打断（ZCode「已停止」） */
  turnInterrupted?: boolean
}) {
  // ZCode 式扁平内联：plan.flatTimeline 为权威（MessageRow 默认 true，工作轨迹显式传 false）
  const flatTimeline = plan.flatTimeline !== false && !suppressExploringFold
  const layout = plan.layout
  const displayChunks = layout?.displayChunks ?? []
  const lastReasoningSegIdx = layout?.lastReasoningSegIdx ?? -1
  const lastTimelineSegmentKind = layout?.lastTimelineSegmentKind
  const streamTextPhase = layout?.streamTextPhase ?? 'pre_tools'
  const firstActivityChunkIndex = layout?.firstActivityChunkIndex ?? -1
  const finalReplyChunkIndex = layout?.finalReplyChunkIndex ?? -1
  const pendingReasoningSegIndex = plan.pendingReasoningSegIndex

  // ===== 回合文件变更聚合（「N 个文件已更改 +X −Y」+ 撤销） =====
  const changedFiles = useMemo(
    () => (isStreaming ? [] : collectTurnChangedFiles(tools)),
    [tools, isStreaming],
  )
  const deliverables = useMemo(
    () => (isStreaming ? [] : collectTurnDeliverables(rawText)),
    [rawText, isStreaming],
  )
  const [revertibleCount, setRevertibleCount] = useState(0)
  const [revertBusy, setRevertBusy] = useState(false)
  useEffect(() => {
    if (isStreaming || !sessionKey || compareSessionKey) return
    for (const f of changedFiles) {
      recordWorkspaceFileChange(sessionKey, f.path, {
        toolCallId: f.toolCallId,
        beforeContent: f.beforeContent,
        deleted: f.deleted,
      })
    }
    setRevertibleCount(revertibleCountFor(sessionKey, changedFiles.map((f) => f.path)))
  }, [changedFiles, isStreaming, sessionKey, compareSessionKey])
  const handleRevertFiles = async () => {
    if (!sessionKey || revertBusy || changedFiles.length === 0) return
    const yes = await showConfirm(
      `撤销本回合对 ${changedFiles.length} 个文件的更改？\n仅还原本会话中文件工具产生的变更（以修改前快照为准），终端命令等其它改动不受影响。`,
    )
    if (!yes) return
    setRevertBusy(true)
    try {
      await revertWorkspaceFiles(sessionKey, changedFiles)
      setRevertibleCount(revertibleCountFor(sessionKey, changedFiles.map((f) => f.path)))
    } catch {
      /* toast 已由撤销执行器给出 */
    } finally {
      setRevertBusy(false)
    }
  }

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
          enableCodeComments
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
        variant={flatTimeline ? 'flat' : 'fold'}
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

  // ZCode 对齐（ConversationTurnGroup / conversationTurnWorkSegments 同构）：
  // - 流式：头部从流式首帧即显示，「工作中 N 分 N 秒」每秒跳动，内容平铺展开；
  // - 完成：「已工作 N 分 N 秒」定格收拢；完成但缺时长（旧历史）→「已处理」；
  // - 工作轨迹（suppressExploringFold）/控制类回合退回平铺。
  const workedText = formatWorkDurationText(durationLabel)
  const foldableSlotIdx: number[] = []
  plan.slots.forEach((slot, i) => {
    if (slot.kind === 'chunk' && slot.chunk.kind !== 'text') foldableSlotIdx.push(i)
  })
  const workedLabel = (() => {
    if (plan.flatTimeline === false || suppressExploringFold) return ''
    if (isStreaming) return workedText ? `工作中 ${workedText}` : '工作中'
    if (turnInterrupted) return '已停止'
    if (workedText) return `已工作 ${workedText}`
    return foldableSlotIdx.length ? '已处理' : ''
  })()
  const foldStartIdx = foldableSlotIdx.length ? foldableSlotIdx[0] : -1
  const foldableIdxSet = new Set(foldableSlotIdx)
  /** 流式首帧还没有任何工作条目：先渲染独立头部（对齐 ZCode firstAssistantFlowItemIndex < 0 分支） */
  const showStandaloneWorkHeader = !!workedLabel && isStreaming && foldStartIdx < 0

  const renderSlot = (slot: AssistantBubbleSlot, si: number): ReactNode => {
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
                enableCodeComments
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
                enableCodeComments
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
                enableCodeComments
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
                enableCodeComments
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
  }

  return (
    <>
      {askInline}
      {showStandaloneWorkHeader ? (
        <TurnHistoryFold key="turn-history-standalone" label={workedLabel} messageId={messageId} headerOnly />
      ) : null}
      {plan.slots.map((slot, si) => {
        if (si === foldStartIdx) {
          return (
            <TurnHistoryFold
              key={`turn-history-${si}`}
              label={workedLabel}
              messageId={messageId}
              forceOpen={isStreaming}
            >
              {foldableSlotIdx.map((idx) => (
                <Fragment key={`folded-${idx}`}>{renderSlot(plan.slots[idx], idx)}</Fragment>
              ))}
            </TurnHistoryFold>
          )
        }
        if (foldableIdxSet.has(si)) return null
        return <Fragment key={`slot-${si}`}>{renderSlot(slot, si)}</Fragment>
      })}
      {!isStreaming && !compareSessionKey && sessionKey && changedFiles.length > 0 ? (
        <ChangedFilesSummaryRow
          files={changedFiles}
          onOpenFile={onOpenFile}
          onRevert={handleRevertFiles}
          revertibleCount={revertibleCount}
          revertBusy={revertBusy}
        />
      ) : null}
      {!isStreaming && !compareSessionKey && deliverables.length > 0 ? (
        <DeliverableCards items={deliverables} onOpenFile={onOpenFile} />
      ) : null}
    </>
  )
}

export const AssistantBubbleSlotView = memo(AssistantBubbleSlotViewInner)
