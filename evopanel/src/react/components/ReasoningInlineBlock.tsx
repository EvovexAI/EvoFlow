import { memo, useEffect, useId, useState } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import type { MessageSegment } from '../chat-types.js'
import { formatReasoningDurationLabel } from '../lib/turn-timing.js'
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

/**
 * ZCode 风格可折叠思考块：脑图标 + 「思考」+ 可选「· 持续了 X 秒」，
 * 箭头默认隐藏、悬停/聚焦显现，展开后旋转 90°；
 * 内容容器常驻 DOM（closed 时 display:none，对齐 ZCode 的 hidden collapsible-content），
 * 展开/收起均有动画。
 */
function CollapsedReasoningBlock({
  displayLabel,
  durationMs,
  paragraphs,
}: {
  displayLabel: string
  durationMs?: number | null
  paragraphs: string[]
}) {
  const [expanded, setExpanded] = useState(false)
  /** 收起动画期间保持 is-expanded，动画结束再真正折叠 */
  const [closing, setClosing] = useState(false)
  useEffect(() => {
    if (!closing) return
    const t = window.setTimeout(() => setClosing(false), 190)
    return () => window.clearTimeout(t)
  }, [closing])
  const showBody = expanded || closing
  const toggle = () => {
    if (expanded) {
      setExpanded(false)
      setClosing(true)
    } else {
      setExpanded(true)
      setClosing(false)
    }
  }
  const durationLabel = formatReasoningDurationLabel(durationMs)
  const contentId = useId()
  return (
    <div className={`react-chat-inline-reasoning${showBody ? ' is-expanded' : ' is-collapsed'}`}>
      <button
        type="button"
        className="react-chat-inline-reasoning-toggle"
        data-testid="chat-reasoning-trigger"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={toggle}
      >
        <Brain className="react-chat-inline-reasoning-brain" size={16} strokeWidth={1.5} aria-hidden />
        <span className="react-chat-inline-reasoning-toggle-label">{displayLabel}</span>
        {durationLabel ? (
          <>
            <span className="react-chat-inline-reasoning-toggle-sep" aria-hidden>
              ·
            </span>
            <span className="react-chat-inline-reasoning-toggle-duration">{durationLabel}</span>
          </>
        ) : null}
        <ChevronRight
          className={`react-chat-inline-reasoning-toggle-chevron-icon${
            expanded ? ' is-expanded' : ''
          }`}
          size={16}
          strokeWidth={1.5}
          aria-hidden
        />
      </button>
      {paragraphs.length ? (
        <div
          id={contentId}
          className={`react-chat-inline-reasoning-body${closing ? ' is-closing' : ''}`}
          data-state={expanded ? 'open' : 'closed'}
          data-reasoning-content="true"
          data-reasoning-content-variant="default"
          data-testid="chat-reasoning-content"
        >
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
 * - 流式（当前轮 / flat 时间线）：单行扫描，正文在下方正常显示
 * - 完成 + collapsible（ZCode flat 模式 / 历史气泡）：可折叠块，带「· 持续了 X 秒」
 * - 完成 + 折叠区内（Exploring fold）：紧凑单行
 */
function ReasoningInlineBlockInner({
  text,
  isStreamingActive = false,
  label = '思考',
  inExploring = false,
  hideChevron = false,
  durationMs = null,
  collapsible = false,
}: {
  text: string
  isStreamingActive?: boolean
  label?: string
  inExploring?: boolean
  hideChevron?: boolean
  /** 本段思考耗时（ms）；有值时折叠头显示「· 持续了 X 秒」 */
  durationMs?: number | null
  /** 完成段强制走 ZCode 可折叠样式（flat 时间线用；fold 内保持紧凑单行） */
  collapsible?: boolean
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

  // 流式思考：单行扫描
  if (isStreamingActive || (inExploring && !collapsible)) {
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
      durationMs={durationMs}
      paragraphs={reasoningDisplayParagraphs(reasoningHeadForDisplay(body))}
    />
  )
}

export const ReasoningInlineBlock = memo(ReasoningInlineBlockInner)
