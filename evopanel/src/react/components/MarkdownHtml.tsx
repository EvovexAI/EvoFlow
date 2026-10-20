import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { StreamPerfProfiler } from './StreamPerfProfiler.js'
import {
  buildAssistantCodeCommentCards,
  projectAssistantCodeComments,
  type AssistantCodeCommentCard,
} from '../../lib/assistant-code-comment.js'
import { getChatWorkspaceRoot } from '../../lib/chat-workspace-context.js'
import { AssistantCodeCommentCards } from './AssistantCodeCommentCards.js'
import { StreamdownRenderer } from './StreamdownRenderer.js'
import {
  buildStreamingPlainHtml,
  streamingPlainDisplayText,
  STREAM_PLAIN_DISPLAY_MAX_CHARS,
  STREAM_TWEEN_EASEOUT_K,
  STREAM_TWEEN_MIN_STEP,
  STREAM_TWEEN_MAX_STEP,
} from '../lib/markdown-stream-paint.js'

/** 流式正文 pre（max-height + overflow-y）贴底，避免滚动条卡在上方/中间 */
function stickStreamPlainToBottom(pre: Element | null | undefined) {
  if (!(pre instanceof HTMLElement)) return
  pre.scrollTop = pre.scrollHeight
}

function isPlainStreamHtml(html: string): boolean {
  return !html || html.includes('msg-stream-plain')
}

/** 与经典聊天页一致：沿用 markdown.js（代码高亮、Copy） */
function MarkdownHtmlInner({
  text,
  className = 'msg-text',
  onOpenWorkspaceFile,
  /** 流式进行中：纯文本直写 DOM；结束后一次性渲染 Markdown */
  isStreaming = false,
  /** 思考流：更短节流间隔 */
  streamProfile = 'default',
  /**
   * 助手正文：投影 `::code-comment{...}` 为评论卡片。
   * 默认开启，避免历史/轮内等漏传 props 时仍露出协议原文；文档预览等需原文处显式传 false。
   */
  enableCodeComments = true,
}: {
  text?: string
  className?: string
  /** 点击正文中的 @@绝对路径@@ / @@outputs/…@@（遗留相对）；opts.line/annotation 用于代码评论定位 */
  onOpenWorkspaceFile?: (
    rawPath: string,
    displayName?: string,
    opts?: {
      line?: number
      endLine?: number
      annotation?: { title?: string; body?: string; priority?: number }
    },
  ) => void
  isStreaming?: boolean
  streamProfile?: 'default' | 'reasoning'
  enableCodeComments?: boolean
}) {
  const isReasoningStream = streamProfile === 'reasoning'
  
  // 投影一次供正文渲染与卡片共用：visibleText 抹掉协议原文，comments 转结构化评论。
  const projection = useMemo(() => {
    if (!enableCodeComments) return null
    return projectAssistantCodeComments(String(text || ''), { streaming: isStreaming })
  }, [text, isStreaming, enableCodeComments])
  
  const renderText = projection ? projection.visibleText : String(text || '')
  const codeCommentCards = useMemo<AssistantCodeCommentCard[]>(() => {
    if (!projection || projection.comments.length === 0) return []
    return buildAssistantCodeCommentCards(projection.comments, getChatWorkspaceRoot(), 50)
  }, [projection])

  const textRef = useRef(String(text || ''))
  const streamTweenRafRef = useRef(0)
  const streamShownLenRef = useRef(0)
  const streamTargetLenRef = useRef(0)
  
  // Streamdown 在流式结束后直接渲染，不需要 displayHtml state
  const streamPaintRafRef = useRef(0)
  const lastStreamPaintRef = useRef(0)
  const lastPaintedLenRef = useRef(0)
  const plainStreamActiveRef = useRef(false)
  
  // dev-only: ?paintlog=1 OR localStorage.evoflow_paintlog=1 enables console paint telemetry.
  if (typeof window !== 'undefined' && (window as { __streamPaintLog?: boolean }).__streamPaintLog === undefined) {
    let enable = false
    try {
      const url = new URL(window.location.href)
      enable = url.searchParams.get('paintlog') === '1'
    } catch {
      /* ignore */
    }
    if (!enable) {
      try {
        enable = localStorage.getItem('evoflow_paintlog') === '1'
      } catch {
        /* ignore */
      }
    }
    if (enable) {
      ;(window as { __streamPaintLog?: boolean }).__streamPaintLog = true
      console.info(
        '[streamPaint] telemetry ON — open DevTools console; filter by [streamPaint]',
      )
    }
  }

  const lastAppliedHtmlRef = useRef<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const lastPaintedTextRef = useRef('')

  const writePlainDom = (displayRaw: string) => {
    const root = rootRef.current
    if (!root) return false
    // 幂等：相同文本不重复写 DOM (React 重 render / 重复 effect 时常见)
    if (displayRaw === lastPaintedTextRef.current) return true
    plainStreamActiveRef.current = true
    let pre = root.querySelector('pre.msg-stream-plain')
    if (!(pre instanceof HTMLElement)) {
      root.replaceChildren()
      pre = document.createElement('pre')
      pre.className = 'msg-stream-plain'
      root.appendChild(pre)
      lastAppliedHtmlRef.current = 'plain-stream-dom'
    }
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now()
    const displayText = streamingPlainDisplayText(displayRaw)
    pre.textContent = displayText
    lastPaintedTextRef.current = displayRaw
    // dev-only telemetry
    try {
      if (typeof window !== 'undefined' && (window as { __streamPaintLog?: boolean }).__streamPaintLog) {
        const len = displayRaw.length
        if (len !== lastPaintedLenRef.current) {
          const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
          const gap = Math.round(now - lastStreamPaintRef.current)
          console.log(
            '[streamPaint]',
            `gap=${gap}ms`,
            `len=${len}`,
            `Δ=${len - lastPaintedLenRef.current}`,
            `paintUs=${Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0) * 1000)}`,
          )
          lastPaintedLenRef.current = len
        }
      }
    } catch {
      /* ignore */
    }
    pre.scrollTop = pre.scrollHeight
    const maxH = parseFloat(getComputedStyle(pre).maxHeight)
    if (Number.isFinite(maxH) && pre.scrollHeight > maxH + 1) {
      pre.classList.add('msg-stream-plain--capped')
    }
    return true
  }

  const cancelStreamTween = () => {
    if (streamTweenRafRef.current) {
      if (typeof cancelAnimationFrame === 'function') {
        try { cancelAnimationFrame(streamTweenRafRef.current) } catch { /* ignore */ }
      }
      streamTweenRafRef.current = 0
    }
  }

  /**
   * 打字机 tween：上游 IPC 每 50ms 一包（可能一大段文字），直接全量显示会
   * "一跳一跳"。tween 每帧以 easeOut 步进推进 shownLen（新到的 delta 在
   * ~200ms 内匀速渐显），rAF 循环持续到追平 targetLen。
   */
  const startStreamTween = () => {
    if (streamTweenRafRef.current) return
    const step = () => {
      streamTweenRafRef.current = 0
      const root = rootRef.current
      const raw = String(textRef.current || '')
      if (!root || !raw) return
      if (raw.length > STREAM_PLAIN_DISPLAY_MAX_CHARS || raw.length < streamShownLenRef.current) {
        streamShownLenRef.current = raw.length
        streamTargetLenRef.current = raw.length
        writePlainDom(raw)
        return
      }
      streamTargetLenRef.current = raw.length
      const remaining = streamTargetLenRef.current - streamShownLenRef.current
      if (remaining <= 0) return
      const stepChars = Math.min(
        STREAM_TWEEN_MAX_STEP,
        Math.max(STREAM_TWEEN_MIN_STEP, Math.ceil(remaining * STREAM_TWEEN_EASEOUT_K)),
      )
      const shown = Math.min(streamTargetLenRef.current, streamShownLenRef.current + stepChars)
      streamShownLenRef.current = shown
      writePlainDom(raw.slice(0, shown))
      if (shown < streamTargetLenRef.current || String(textRef.current || '').length > shown) {
        streamTweenRafRef.current = requestAnimationFrame(step)
      }
    }
    streamTweenRafRef.current = requestAnimationFrame(step)
  }

  const paintPlainStreamDom = (raw: string, smooth = true) => {
    const root = rootRef.current
    if (!root) return false
    const text = String(raw || '')
    if (!smooth || text.length > STREAM_PLAIN_DISPLAY_MAX_CHARS) {
      cancelStreamTween()
      streamShownLenRef.current = text.length
      streamTargetLenRef.current = text.length
      writePlainDom(text)
      return true
    }
    if (text.length < streamShownLenRef.current) {
      cancelStreamTween()
      streamShownLenRef.current = text.length
      streamTargetLenRef.current = text.length
      writePlainDom(text)
      return true
    }
    if (text === lastPaintedTextRef.current && streamShownLenRef.current >= text.length) {
      return true
    }
    streamTargetLenRef.current = text.length
    startStreamTween()
    return true
  }

  /**
   * Effect 1（生命周期）：建立/销毁流式 paint 调度器。
   */
  useEffect(() => {
    const runPaint = () => {
      streamPaintRafRef.current = 0
      lastStreamPaintRef.current =
        typeof performance !== 'undefined' ? performance.now() : Date.now()
      if (!paintPlainStreamDom(textRef.current)) {
        setMarkdownReady(true)
      }
    }

    const schedulePaint = () => {
      if (streamPaintRafRef.current) return
      const useRaf = typeof requestAnimationFrame === 'function'
      if (useRaf) {
        streamPaintRafRef.current = window.requestAnimationFrame(() => {
          streamPaintRafRef.current = 0
          runPaint()
        }) as unknown as number
      } else {
        streamPaintRafRef.current = window.setTimeout(() => {
          streamPaintRafRef.current = 0
          runPaint()
        }, 0)
      }
    }

    scheduleStreamPaintRef.current = schedulePaint

    return () => {
      cancelStreamTween()
      if (streamPaintRafRef.current) {
        clearTimeout(streamPaintRafRef.current as unknown as number)
        if (typeof cancelAnimationFrame === 'function') {
          try { cancelAnimationFrame(streamPaintRafRef.current) } catch { /* ignore */ }
        }
        streamPaintRafRef.current = 0
      }
    }
  }, [isStreaming, streamProfile, isReasoningStream])

  /**
   * Effect 2（正文增长）：每次 renderText 变化时触发 paint。
   */
  const scheduleStreamPaintRef = useRef<() => void>(() => {})
  const [markdownReady, setMarkdownReady] = useState(false)

  useEffect(() => {
    if (!isStreaming) return
    textRef.current = renderText
    scheduleStreamPaintRef.current()
  }, [renderText, isStreaming])

  /**
   * Effect 3（结束落 MD）：非流式时清掉流式 plain DOM，交给 Streamdown。
   * 不再把 plain `<pre>` 留到 ready 之后，避免协议原文与 MD 双份残留。
   */
  useEffect(() => {
    if (isStreaming) return
    const raw = renderText
    textRef.current = raw
    cancelStreamTween()
    plainStreamActiveRef.current = false
    lastPaintedTextRef.current = ''
    const root = rootRef.current
    const leftover = root?.querySelector('pre.msg-stream-plain')
    if (leftover) {
      try {
        leftover.remove()
      } catch {
        /* ignore */
      }
    }
    setMarkdownReady(true)
  }, [renderText, isStreaming])

  /**
   * Effect 4（DOM 应用）：仅流式期间维护 plain DOM。
   */
  useEffect(() => {
    const el = rootRef.current
    if (!el) return

    if (isStreaming) {
      const pre = el.querySelector('pre.msg-stream-plain')
      if (!pre && textRef.current) {
        paintPlainStreamDom(textRef.current)
      } else {
        stickStreamPlainToBottom(pre)
      }
      return
    }

    plainStreamActiveRef.current = false
  }, [isStreaming, markdownReady])

  /**
   * Effect 5（window focus/visibility）：重新渲染 mermaid
   * Streamdown 的 mermaid 插件会自动处理，但需要 focus event
   */
  useEffect(() => {
    const rerender = () => {
      // Streamdown 内部会自动处理 mermaid 重渲
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') rerender()
    }
    window.addEventListener('focus', rerender)
    window.addEventListener('pageshow', rerender)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', rerender)
      window.removeEventListener('pageshow', rerender)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return (
    <>
      <div ref={rootRef} className={className}>
        {/* 流式期间：显示 <pre>；非流式且 ready：显示 Streamdown */}
        {!isStreaming && markdownReady && renderText ? (
          <StreamdownRenderer
            text={renderText}
            isStreaming={false}
            onOpenWorkspaceFile={onOpenWorkspaceFile}
          />
        ) : null}
      </div>
      {codeCommentCards.length > 0 ? (
        <AssistantCodeCommentCards cards={codeCommentCards} onOpenWorkspaceFile={onOpenWorkspaceFile} />
      ) : null}
    </>
  )
}

function MarkdownHtmlProfiled(props: Parameters<typeof MarkdownHtmlInner>[0]) {
  return (
    <StreamPerfProfiler id="markdown">
      <MarkdownHtmlInner {...props} />
    </StreamPerfProfiler>
  )
}

export const MarkdownHtml = memo(MarkdownHtmlProfiled)
