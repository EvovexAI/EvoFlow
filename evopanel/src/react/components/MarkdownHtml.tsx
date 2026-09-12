import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { renderMarkdown } from '../../lib/markdown.js'
import { renderMarkdownAsync } from '../../lib/markdown-render-client.js'
import { showChatLightbox } from '../../lib/chat-lightbox.js'
import { isImagePathLike } from '../../lib/chat-image-src.js'
import {
  buildStreamingPlainHtml,
  resolveReasoningStreamPaintMinMs,
  resolveStreamPlainPaintMinMs,
  streamingPlainDisplayText,
  STREAM_PLAIN_REPAIN_MIN_DELTA_CHARS,
  STREAM_REASONING_REPAIN_MIN_DELTA_CHARS,
  FULL_MARKDOWN_WORKER_MIN_CHARS,
} from '../lib/markdown-stream-paint.js'
import { isStreamThrottleEnabled } from '../lib/stream-throttle-toggle.js'

function extractMermaidSources(rawText: string): string[] {
  const src = String(rawText || '').replace(/\r\n/g, '\n')
  const out: string[] = []
  const fenced = /```mermaid\s*\n([\s\S]*?)```/gi
  let m: RegExpExecArray | null
  while ((m = fenced.exec(src)) !== null) {
    const body = String(m[1] || '').trim()
    if (body) out.push(body)
  }
  if (out.length > 0) return out
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const t = String(lines[i] || '').trim()
    if (!/^flowchart\s+(TD|LR|RL|BT)\b/i.test(t)) continue
    const block = [t]
    let j = i + 1
    while (j < lines.length) {
      const s = String(lines[j] || '').trim()
      if (!s) break
      if (/^#{1,6}\s+/.test(s)) break
      block.push(s)
      j++
    }
    out.push(block.join('\n'))
    i = j - 1
  }
  return out
}

/** 稳定空数组：避免流式期间 useMemo 每次返回新 [] → renderPendingMermaids 换引用 → displayHtml effect 误拆 DOM */
const EMPTY_MERMAID_SOURCES: string[] = []

/** 流式正文 pre（max-height + overflow-y）贴底，避免滚动条卡在上方/中间 */
function stickStreamPlainToBottom(pre: Element | null | undefined) {
  if (!(pre instanceof HTMLElement)) return
  pre.scrollTop = pre.scrollHeight
}

function isPlainStreamHtml(html: string): boolean {
  return !html || html.includes('msg-stream-plain')
}

function normalizeMermaidCode(raw: string): string {
  const src = String(raw || '').replace(/\r\n/g, '\n').trim()
  if (!src) return src
  if (src.includes('\n')) return src
  if (!/^flowchart\s+(TD|LR|RL|BT)\b/i.test(src)) return src
  let code = src
  code = code.replace(/^(flowchart\s+(?:TD|LR|RL|BT))\s+/i, '$1\n')
  code = code.replace(/([\]})"'])\s+(?=[A-Za-z_][A-Za-z0-9_]*\s*(?:-->|==>|-.->|---))/g, '$1\n')
  code = code.replace(/([\]})"'])\s+(?=(?:subgraph|end|classDef|class|style|linkStyle|click)\b)/g, '$1\n')
  return code
}

/**
 * Mermaid SVG 渲染结果 LRU 缓存（key = normalizeMermaidCode 后的源码）。
 * mermaid.render 串行且重（含 DOM 度量）；displayHtml 全量重建 / 虚拟列表
 * 滚动重挂 / window focus 重扫都会丢掉已渲染 SVG，缓存后直接恢复 innerHTML。
 */
const MERMAID_SVG_CACHE_MAX = 32
/** 单条 SVG 超大（巨型图）不缓存，防内存放大 */
const MERMAID_SVG_CACHE_MAX_CHARS = 1_000_000
const mermaidSvgCache = new Map<string, string>()

function mermaidSvgCacheGet(code: string): string | undefined {
  const key = String(code)
  if (mermaidSvgCache.has(key)) {
    const svg = mermaidSvgCache.get(key) as string
    mermaidSvgCache.delete(key)
    mermaidSvgCache.set(key, svg) // LRU touch
    return svg
  }
  return undefined
}

function mermaidSvgCacheSet(code: string, svg: string): void {
  const key = String(code)
  const val = String(svg)
  if (val.length > MERMAID_SVG_CACHE_MAX_CHARS) return
  if (mermaidSvgCache.has(key)) mermaidSvgCache.delete(key)
  mermaidSvgCache.set(key, val)
  if (mermaidSvgCache.size > MERMAID_SVG_CACHE_MAX) {
    const oldest = mermaidSvgCache.keys().next().value
    if (oldest !== undefined) mermaidSvgCache.delete(oldest)
  }
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
}: {
  text?: string
  className?: string
  /** 点击正文中的 @@绝对路径@@ / @@outputs/…@@（遗留相对） */
  onOpenWorkspaceFile?: (rawPath: string, displayName?: string) => void
  isStreaming?: boolean
  streamProfile?: 'default' | 'reasoning'
}) {
  const isReasoningStream = streamProfile === 'reasoning'
  const [displayHtml, setDisplayHtml] = useState(() => {
    const raw = String(text || '')
    if (isStreaming) return buildStreamingPlainHtml(raw)
    return raw.length > FULL_MARKDOWN_WORKER_MIN_CHARS ? '' : renderMarkdown(raw)
  })
  const textRef = useRef(String(text || ''))
  const streamPaintRafRef = useRef(0)
  const streamPaintTimerRef = useRef(0)
  const lastStreamPaintRef = useRef(0)
  const pendingRepaintRef = useRef(false)
  const lastPaintCharLenRef = useRef(0)
  const plainStreamActiveRef = useRef(false)
  /** 上次已应用到 DOM 的 displayHtml；相同则跳过全拆重建（mermaid 回调引用变化会重触发本 effect） */
  const lastAppliedHtmlRef = useRef<string | null>(null)
  const repainMinDeltaRef = useRef(STREAM_PLAIN_REPAIN_MIN_DELTA_CHARS)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    repainMinDeltaRef.current = isReasoningStream
      ? STREAM_REASONING_REPAIN_MIN_DELTA_CHARS
      : STREAM_PLAIN_REPAIN_MIN_DELTA_CHARS
  }, [isReasoningStream])

  const shouldCoalesceCatchUpPaint = (charLen: number) => {
    if (!isStreamThrottleEnabled()) return false
    const delta = charLen - lastPaintCharLenRef.current
    return delta < repainMinDeltaRef.current
  }

  const resolveStreamingPaintMinMs = (charLen: number) =>
    isStreamThrottleEnabled()
      ? isReasoningStream
        ? resolveReasoningStreamPaintMinMs(charLen)
        : resolveStreamPlainPaintMinMs(charLen)
      : 0

  const paintPlainStreamDom = (raw: string) => {
    const root = rootRef.current
    if (!root) return false
    plainStreamActiveRef.current = true
    let pre = root.querySelector('pre.msg-stream-plain')
    if (!(pre instanceof HTMLElement)) {
      root.replaceChildren()
      pre = document.createElement('pre')
      pre.className = 'msg-stream-plain'
      root.appendChild(pre)
    }
    pre.textContent = streamingPlainDisplayText(raw)
    // 用 CSS max-height 判断封顶，避免未布局时 clientHeight=0 误锁 480px
    const maxH = parseFloat(getComputedStyle(pre).maxHeight)
    if (Number.isFinite(maxH) && pre.scrollHeight > maxH + 1) {
      pre.classList.add('msg-stream-plain--capped')
    }
    stickStreamPlainToBottom(pre)
    // 换行/字体度量偶发滞后一帧，再贴一次避免停在中间
    requestAnimationFrame(() => stickStreamPlainToBottom(pre))
    return true
  }

  const mermaidSources = useMemo(
    () => (isStreaming ? EMPTY_MERMAID_SOURCES : extractMermaidSources(text || '')),
    [text, isStreaming],
  )
  const mermaidApiRef = useRef<any>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewSvg, setPreviewSvg] = useState('')
  const [previewScale, setPreviewScale] = useState(1)

  useEffect(() => {
    const raw = String(text || '')
    textRef.current = raw
    if (!isStreaming) {
      if (streamPaintRafRef.current) {
        cancelAnimationFrame(streamPaintRafRef.current)
        streamPaintRafRef.current = 0
      }
      if (streamPaintTimerRef.current) {
        clearTimeout(streamPaintTimerRef.current)
        streamPaintTimerRef.current = 0
      }
      // 仅「刚从流式结束」时保留 plain，避免 Markdown 未就绪时空闪；冷加载历史仍走 MD
      const holdPlain =
        plainStreamActiveRef.current ||
        !!rootRef.current?.querySelector('pre.msg-stream-plain')
      if (holdPlain) {
        paintPlainStreamDom(raw)
      } else {
        plainStreamActiveRef.current = false
      }
      if (raw.length > FULL_MARKDOWN_WORKER_MIN_CHARS) {
        let cancelled = false
        void renderMarkdownAsync(raw).then((html) => {
          if (!cancelled) setDisplayHtml(html)
        })
        return () => {
          cancelled = true
        }
      }
      queueMicrotask(() => setDisplayHtml(renderMarkdown(raw)))
      return
    }

    const runPaint = () => {
      streamPaintRafRef.current = 0
      const charLen = textRef.current.length
      const wait = resolveStreamingPaintMinMs(charLen) - (Date.now() - lastStreamPaintRef.current)
      if (wait > 0) {
        if (!streamPaintTimerRef.current) {
          streamPaintTimerRef.current = window.setTimeout(() => {
            streamPaintTimerRef.current = 0
            runPaint()
          }, wait)
        }
        return
      }
      lastStreamPaintRef.current = Date.now()
      lastPaintCharLenRef.current = charLen
      if (!paintPlainStreamDom(textRef.current)) {
        setDisplayHtml(buildStreamingPlainHtml(textRef.current))
      }
      if (pendingRepaintRef.current) {
        pendingRepaintRef.current = false
        if (!shouldCoalesceCatchUpPaint(textRef.current.length)) schedulePaint()
      }
    }

    const schedulePaint = () => {
      if (streamPaintRafRef.current || streamPaintTimerRef.current) {
        pendingRepaintRef.current = true
        return
      }
      streamPaintRafRef.current = requestAnimationFrame(runPaint)
    }

    schedulePaint()

    return () => {
      pendingRepaintRef.current = false
      // 切勿在 text 更新 cleanup 里清 plainStreamActiveRef：否则 displayHtml effect
      // 会用陈旧 displayHtml 拆掉 live pre，高度塌缩再被 paint 撑开 → 页面上下抖。
      if (streamPaintRafRef.current) {
        cancelAnimationFrame(streamPaintRafRef.current)
        streamPaintRafRef.current = 0
      }
      if (streamPaintTimerRef.current) {
        clearTimeout(streamPaintTimerRef.current)
        streamPaintTimerRef.current = 0
      }
    }
  }, [text, isStreaming, streamProfile])

  const renderPendingMermaids = useCallback(async () => {
    if (isStreaming) return
    const root = rootRef.current
    if (!root) return
    const nodes = Array.from(root.querySelectorAll('.mermaid')).filter(
      (n): n is HTMLElement => n instanceof HTMLElement,
    )
    if (nodes.length === 0) return
    try {
      if (!mermaidApiRef.current) {
        const m = await import('mermaid')
        const mermaid = m.default ?? m
        if (!mermaid || typeof mermaid.render !== 'function') {
           
          console.error('[mermaid] module has no render()')
          return
        }
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'loose',
          theme: 'default',
        })
        mermaidApiRef.current = mermaid
      }
      const mermaid = mermaidApiRef.current
      for (let i = 0; i < nodes.length; i++) {
        const el = nodes[i]
        if (!el) continue
        if (el.getAttribute('data-evf-mermaid') === '1') continue
        const fromRaw = mermaidSources[i] || ''
        const fromDom = (el.textContent || '').trim()
        const code = normalizeMermaidCode(fromRaw || fromDom)
        if (!code) continue
        // ★ 缓存命中：DOM 重建/滚动重挂后直接恢复 SVG，跳过昂贵的 mermaid.render
        const cachedSvg = mermaidSvgCacheGet(code)
        if (cachedSvg) {
          el.innerHTML = cachedSvg
          el.setAttribute('data-evf-mermaid', '1')
          continue
        }
        try {
          const id = `evf_mermaid_${Date.now()}_${i}`
          const out = await mermaid.render(id, code)
          el.innerHTML = out.svg
          el.setAttribute('data-evf-mermaid', '1')
          mermaidSvgCacheSet(code, out.svg)
          if (typeof out.bindFunctions === 'function') out.bindFunctions(el)
        } catch (err) {
          try {
            const fallback = (fromRaw || fromDom).trim()
            if (!fallback) throw err
            const id2 = `evf_mermaid_retry_${Date.now()}_${i}`
            const out2 = await mermaid.render(id2, fallback)
            el.innerHTML = out2.svg
            el.setAttribute('data-evf-mermaid', '1')
            mermaidSvgCacheSet(code, out2.svg)
            if (typeof out2.bindFunctions === 'function') out2.bindFunctions(el)
          } catch {
            /* ignore */
          }
        }
      }
    } catch (err) {
       
      console.error('[mermaid] import failed', err)
    }
  }, [mermaidSources, isStreaming])

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    // 流式中：DOM 由 paintPlainStreamDom 独占，禁止用 React state 回写拆树
    if (isStreaming) {
      stickStreamPlainToBottom(el.querySelector('pre.msg-stream-plain'))
      return
    }
    // 流式刚结束、Markdown 尚未就绪：继续展示 plain，避免空闪/高度悬崖
    if (plainStreamActiveRef.current && isPlainStreamHtml(displayHtml)) {
      return
    }
    plainStreamActiveRef.current = false
    // ★ displayHtml 未变化：仅补 mermaid 渲染，跳过全拆重建
    //（renderPendingMermaids 依赖 mermaidSources->text，text 未变时其引用变化是无谓触发）
    if (lastAppliedHtmlRef.current === displayHtml && el.firstChild) {
      void renderPendingMermaids()
      return
    }
    lastAppliedHtmlRef.current = displayHtml
    el.replaceChildren()
    el.insertAdjacentHTML('afterbegin', displayHtml)
    void renderPendingMermaids()
  }, [displayHtml, renderPendingMermaids, isStreaming])

  useEffect(() => {
    const rerender = () => {
      void renderPendingMermaids()
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
  }, [renderPendingMermaids])

  const handlePreviewWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault()
    const step = e.deltaY < 0 ? 0.08 : -0.08
    setPreviewScale((s) => {
      const next = s + step
      if (next < 0.5) return 0.5
      if (next > 3) return 3
      return Number(next.toFixed(2))
    })
  }

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onClick = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null
      if (!target) return
      const imgEl = target.closest('img.msg-img') as HTMLImageElement | null
      if (imgEl?.src) {
        ev.preventDefault()
        ev.stopPropagation()
        showChatLightbox(imgEl.src)
        return
      }
      const linkEl = target.closest('a') as HTMLAnchorElement | null
      if (linkEl?.href && isImagePathLike(linkEl.href)) {
        ev.preventDefault()
        ev.stopPropagation()
        showChatLightbox(linkEl.href)
        return
      }
      const fileBtn = target.closest('[data-evf-file-path]') as HTMLElement | null
      if (fileBtn && onOpenWorkspaceFile) {
        ev.preventDefault()
        ev.stopPropagation()
        const rawPath = fileBtn.getAttribute('data-evf-file-path') || ''
        const label = (fileBtn.textContent || '').replace(/^\s*📄\s*/, '').trim()
        const cleanPath = rawPath.replace(/<[^>]*>/g, '').trim()
        if (cleanPath) onOpenWorkspaceFile(cleanPath, label || undefined)
        return
      }
      const holder = target.closest('.mermaid') as HTMLElement | null
      if (!holder) return
      const svg = holder.querySelector('svg')
      if (!svg) return
      setPreviewSvg(svg.outerHTML)
      setPreviewScale(1)
      setPreviewOpen(true)
    }
    root.addEventListener('click', onClick)
    return () => root.removeEventListener('click', onClick)
  }, [displayHtml, onOpenWorkspaceFile])

  const previewModal =
    previewOpen && typeof document !== 'undefined'
      ? createPortal(
          <div className="react-chat-mermaid-modal" onClick={() => setPreviewOpen(false)}>
            <div className="react-chat-mermaid-modal-panel" onClick={(e) => e.stopPropagation()}>
              <div className="react-chat-mermaid-modal-toolbar">
                <button type="button" onClick={() => setPreviewScale((s) => Math.max(0.5, Number((s - 0.1).toFixed(2))))}>
                  -
                </button>
                <span>{Math.round(previewScale * 100)}%</span>
                <button type="button" onClick={() => setPreviewScale((s) => Math.min(3, Number((s + 0.1).toFixed(2))))}>
                  +
                </button>
                <button type="button" onClick={() => setPreviewScale(1)}>
                  重置
                </button>
                <button type="button" onClick={() => setPreviewOpen(false)}>
                  关闭
                </button>
              </div>
              <div className="react-chat-mermaid-modal-canvas" onWheel={handlePreviewWheel}>
                <div
                  className="react-chat-mermaid-modal-svg"
                  style={{ transform: `scale(${previewScale})`, transformOrigin: 'top center' }}
                  dangerouslySetInnerHTML={{ __html: previewSvg }}
                />
              </div>
            </div>
          </div>,
          document.body,
        )
      : null

  return (
    <>
      <div ref={rootRef} className={className} />
      {previewModal}
    </>
  )
}

export const MarkdownHtml = memo(MarkdownHtmlInner)
