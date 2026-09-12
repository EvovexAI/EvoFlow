import type { ReactNode } from 'react'
import type { SubagentStreamTask, TerminalStreamTask } from '../chat-types.js'
import { normalizeStreamStatusLabel } from '../lib/stream-status-label.js'
import { MarkdownHtml } from './MarkdownHtml.js'
import { ReasoningInlineBlock } from './ReasoningInlineBlock.js'
import { ToolCallList } from './ToolCallList.js'

function shouldShowLegacyStreamCursor(opts: {
  isStreaming: boolean
  textTrimmed: boolean
  reasoningSegments: string[]
  systemActivityLabel: string
}): boolean {
  const { isStreaming, textTrimmed, reasoningSegments, systemActivityLabel } = opts
  if (!isStreaming || textTrimmed || systemActivityLabel) return false
  if (reasoningSegments.length > 0) {
    const active = String(reasoningSegments[reasoningSegments.length - 1] || '').trim()
    if (active) return false
  }
  return true
}

/** 无 display_segments 时的旧版助手气泡：工具列表在上、正文与思考占位在下 */
export function AssistantLegacyBodyView({
  tools,
  text,
  textTrimmed,
  isStreaming,
  reasoningSegments,
  topReasoningBlocks,
  askInline,
  askBubbleHint,
  systemActivityLabel,
  streamThinkingLabel,
  subagentTasks,
  terminalStreams,
  onOpenFile,
  onToolApproval,
  toolApprovalBusy,
  interactiveToolApproval,
  hideSubagentInnerTools,
  showToolTiming,
  sessionKey,
}: {
  tools: unknown[]
  text: string
  textTrimmed: boolean
  isStreaming: boolean
  reasoningSegments: string[]
  topReasoningBlocks: ReactNode
  askInline: ReactNode
  askBubbleHint: string | null
  systemActivityLabel: string
  streamThinkingLabel: string
  subagentTasks?: Record<string, SubagentStreamTask>
  terminalStreams?: Record<string, TerminalStreamTask>
  onOpenFile?: (rawUrl: string, name?: string) => void
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
}) {
  const showLegacyStreamCursor = shouldShowLegacyStreamCursor({
    isStreaming,
    textTrimmed,
    reasoningSegments,
    systemActivityLabel,
  })
  const showBody = textTrimmed || isStreaming || !!askBubbleHint

  return (
    <>
      {tools.length > 0 ? (
        <ToolCallList
          tools={tools}
          subagentTasks={subagentTasks}
          terminalStreams={terminalStreams}
          onToolApproval={onToolApproval}
          toolApprovalBusy={toolApprovalBusy}
          hideSubagentInnerTools={hideSubagentInnerTools}
          interactiveToolApproval={interactiveToolApproval}
          isStreaming={isStreaming}
          showToolTiming={showToolTiming}
          sessionKey={sessionKey}
        />
      ) : null}
      {showBody ? (
        <>
          {topReasoningBlocks}
          {askInline}
          {textTrimmed ? (
            <MarkdownHtml
              text={text || ''}
              isStreaming={isStreaming}
              onOpenWorkspaceFile={onOpenFile}
            />
          ) : null}
          {showLegacyStreamCursor || systemActivityLabel ? (
            <ReasoningInlineBlock
              key="stream-thinking-wait-legacy"
              text=""
              label={normalizeStreamStatusLabel(systemActivityLabel || streamThinkingLabel)}
              isStreamingActive
              onOpenWorkspaceFile={onOpenFile}
            />
          ) : null}
        </>
      ) : null}
    </>
  )
}
