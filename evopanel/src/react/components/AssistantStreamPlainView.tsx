import type { ReactNode } from 'react'
import { normalizeStreamStatusLabel } from '../lib/stream-status-label.js'
import { MarkdownHtml } from './MarkdownHtml.js'
import { ReasoningInlineBlock } from './ReasoningInlineBlock.js'

export function AssistantStreamPlainView({
  topReasoningBlocks,
  askInline,
  streamPlainMd,
  showStreamThinkingCursor,
  systemActivityLabel,
  streamThinkingLabel,
  onOpenFile,
}: {
  topReasoningBlocks: ReactNode
  askInline: ReactNode
  streamPlainMd: string
  showStreamThinkingCursor: boolean
  systemActivityLabel: string
  streamThinkingLabel: string
  onOpenFile?: (rawUrl: string, name?: string) => void
}) {
  return (
    <>
      {topReasoningBlocks}
      {askInline}
      {streamPlainMd ? (
        <MarkdownHtml
          key="stream-plain-live"
          text={streamPlainMd}
          className="msg-text msg-ai-final-reply"
          isStreaming
          onOpenWorkspaceFile={onOpenFile}
        />
      ) : showStreamThinkingCursor || systemActivityLabel ? (
        <ReasoningInlineBlock
          key="stream-thinking-wait-plain"
          text=""
          label={normalizeStreamStatusLabel(systemActivityLabel || streamThinkingLabel)}
          isStreamingActive
          onOpenWorkspaceFile={onOpenFile}
        />
      ) : null}
    </>
  )
}
