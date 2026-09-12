import { memo, useState } from 'react'
import type { MessageSegment } from '../chat-types.js'
import {
  reasoningDisplayParagraphs,
  reasoningHeadForDisplay,
  reasoningPreviewOneLine,
  reasoningStreamOneLine,
} from '../lib/reasoning-display-text.js'
import { RunningScanText } from './RunningScanText.js'

export { reasoningPreviewOneLine } from '../lib/reasoning-display-text.js'

export function findLastReasoningSegmentIndex(segments: MessageSegment[]): number {
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].kind === 'reasoning') return i
  }
  return -1
}

export function reasoningSegmentLabel(_segments: MessageSegment[], _index: number): string {
  return '思考'
}

export function ReasoningStreamDots() {
  return (
    <span className="react-chat-inline-reasoning-dots" aria-hidden>
      <span className="react-chat-inline-reasoning-dot" />
      <span className="react-chat-inline-reasoning-dot" />
      <span className="react-chat-inline-reasoning-dot" />
    </span>
  )
}

function ReasoningTextBody({ paragraphs, className }: { paragraphs: string[]; className?: string }) {
  if (!paragraphs.length) return null
  return (
    <div className={className}>
      {paragraphs.map((para, i) => (
        <p key={i}>{para}</p>
      ))}
    </div>
  )
}

function CollapsedReasoningBlock({
  displayLabel,
  preview,
  paragraphs,
}: {
  displayLabel: string
  preview: string
  paragraphs: string[]
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className={`react-chat-inline-reasoning${expanded ? ' is-expanded' : ' is-collapsed'}`}>
      <button
        type="button"
        className="react-chat-inline-reasoning-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="react-chat-inline-reasoning-status-dot" aria-hidden />
        <span className="react-chat-inline-reasoning-toggle-label">{displayLabel}</span>
        <span
          className={`react-chat-inline-reasoning-toggle-chevron msg-tool-activity-fold-chevron${
            expanded ? ' is-expanded' : ''
          }`}
          aria-hidden
        />
      </button>
      {!expanded && preview ? (
        <p className="react-chat-inline-reasoning-preview">{preview}</p>
      ) : null}
      {expanded && paragraphs.length ? (
        <div className="react-chat-inline-reasoning-body">
          <ReasoningTextBody
            paragraphs={paragraphs}
            className="react-chat-inline-reasoning-text react-chat-inline-reasoning-md"
          />
        </div>
      ) : null}
    </div>
  )
}

/**
 * 思考展示：
 * - Exploring / 当前轮：永远「思考」+ 单行；正文在下方正常显示
 * - 气泡顶栏历史：可折叠看更多
 */
function ReasoningInlineBlockInner({
  text,
  isStreamingActive = false,
  label = '思考',
  inExploring = false,
  hideChevron = false,
}: {
  text: string
  isStreamingActive?: boolean
  label?: string
  inExploring?: boolean
  hideChevron?: boolean
  onOpenWorkspaceFile?: (rawUrl: string, name?: string) => void
}) {
  const body = String(text || '').trim()
  const waitingOnly = isStreamingActive && !body

  const rawLabel = String(label || '').trim()
  const displayLabel = (() => {
    const stripped = rawLabel.replace(/[.…．]+$/u, '').trim()
    if (
      !stripped ||
      stripped === 'Thinking' ||
      stripped === '正在思考' ||
      stripped === '思考'
    ) {
      return '思考'
    }
    return stripped
  })()

  if (hideChevron && !body) {
    return (
      <div className="react-chat-inline-reasoning is-waiting">
        <button type="button" className="react-chat-inline-reasoning-toggle is-static" disabled>
          <span className="react-chat-inline-reasoning-status-dot" aria-hidden />
          <span className="react-chat-inline-reasoning-toggle-label">{displayLabel}</span>
        </button>
      </div>
    )
  }

  if (!body && !isStreamingActive) return null

  // 当前轮 / Exploring：思考只占一行
  if (inExploring || isStreamingActive) {
    const line = body
      ? isStreamingActive
        ? reasoningStreamOneLine(body)
        : reasoningPreviewOneLine(body)
      : ''
    return (
      <div
        className={`react-chat-inline-reasoning is-oneline-stream${
          isStreamingActive ? ' is-streaming-active' : ''
        }${waitingOnly ? ' is-waiting' : ''}${
          inExploring ? ' react-chat-inline-reasoning--in-exploring' : ''
        }`}
      >
        <div className="react-chat-inline-reasoning-stream-row" aria-live="polite">
          <span className="react-chat-inline-reasoning-stream-label">
            {isStreamingActive ? (
              <RunningScanText text={displayLabel} maxChars={16} />
            ) : (
              displayLabel
            )}
          </span>
          {waitingOnly ? null : (
            <span
              className={`react-chat-inline-reasoning-stream-line${
                isStreamingActive ? ' is-scan-active' : ''
              }`}
              title={reasoningPreviewOneLine(body, 280)}
            >
              {isStreamingActive ? (
                <RunningScanText text={line} maxChars={96} />
              ) : (
                line
              )}
            </span>
          )}
        </div>
      </div>
    )
  }

  return (
    <CollapsedReasoningBlock
      displayLabel={displayLabel}
      preview={reasoningPreviewOneLine(body)}
      paragraphs={reasoningDisplayParagraphs(reasoningHeadForDisplay(body))}
    />
  )
}

export const ReasoningInlineBlock = memo(ReasoningInlineBlockInner)
