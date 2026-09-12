import { useCallback, useEffect, useRef, useState, type WheelEvent } from 'react'
import { createPortal } from 'react-dom'
import { normalizeMermaidCode } from '../../lib/mermaid-code.js'

function MermaidZoomModal({
  svgHtml,
  scale,
  onScaleChange,
  onClose,
  title,
}: {
  svgHtml: string
  scale: number
  onScaleChange: (next: number) => void
  onClose: () => void
  title?: string
}) {
  const handleWheel = (e: WheelEvent<HTMLDivElement>) => {
    e.preventDefault()
    const step = e.deltaY < 0 ? 0.08 : -0.08
    onScaleChange(Math.max(0.5, Math.min(3, Number((scale + step).toFixed(2)))))
  }

  if (typeof document === 'undefined') return null

  return createPortal(
    <div className="react-chat-mermaid-modal km-diagram-modal" onClick={onClose}>
      <div className="react-chat-mermaid-modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="react-chat-mermaid-modal-toolbar">
          {title ? <span className="km-diagram-modal-title">{title}</span> : null}
          <button type="button" onClick={() => onScaleChange(Math.max(0.5, Number((scale - 0.1).toFixed(2))))}>
            −
          </button>
          <span>{Math.round(scale * 100)}%</span>
          <button type="button" onClick={() => onScaleChange(Math.min(3, Number((scale + 0.1).toFixed(2))))}>
            +
          </button>
          <button type="button" onClick={() => onScaleChange(1)}>
            重置
          </button>
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="react-chat-mermaid-modal-canvas" onWheel={handleWheel}>
          <div
            className="react-chat-mermaid-modal-svg"
            style={{ transform: `scale(${scale})`, transformOrigin: 'top center' }}
            dangerouslySetInnerHTML={{ __html: svgHtml }}
          />
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function KnowledgeMapDiagramView({
  code,
  compact = false,
  label,
}: {
  code: string
  compact?: boolean
  label?: string
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const mermaidRef = useRef<{ render: (id: string, text: string) => Promise<{ svg: string }> } | null>(null)
  const [rendered, setRendered] = useState(false)
  const [renderFailed, setRenderFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewSvg, setPreviewSvg] = useState('')
  const [previewScale, setPreviewScale] = useState(1)

  const render = useCallback(async () => {
    const host = hostRef.current
    const body = normalizeMermaidCode(code)
    if (!host || !body) {
      setRendered(false)
      setRenderFailed(false)
      setLoading(false)
      return
    }
    setLoading(true)
    setRenderFailed(false)
    try {
      if (!mermaidRef.current) {
        const m = await import('mermaid')
        const api = m.default ?? m
        if (api && typeof api.initialize === 'function') {
          api.initialize({
            startOnLoad: false,
            securityLevel: 'loose',
            theme: 'base',
            themeVariables: {
              primaryColor: '#eef2ff',
              primaryBorderColor: '#6366f1',
              primaryTextColor: '#1e1b4b',
              secondaryColor: '#f5f3ff',
              tertiaryColor: '#fafafa',
              lineColor: '#6366f1',
              fontSize: compact ? '12px' : '14px',
              fontFamily:
                'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
            },
            flowchart: { htmlLabels: true, curve: 'basis', padding: compact ? 8 : 14, nodeSpacing: 36, rankSpacing: 42 },
          })
        }
        mermaidRef.current = api
      }
      const id = `km_diagram_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      const out = await mermaidRef.current!.render(id, body)
      host.innerHTML = out.svg
      host.setAttribute('data-rendered', '1')
      setRendered(true)
      setRenderFailed(false)
    } catch {
      host.innerHTML = `<pre class="km-diagram-fallback">${body.replace(/</g, '&lt;')}</pre>`
      host.removeAttribute('data-rendered')
      setRendered(false)
      setRenderFailed(true)
    } finally {
      setLoading(false)
    }
  }, [code, compact])

  useEffect(() => {
    queueMicrotask(() => void render())
  }, [render])

  useEffect(() => {
    const host = hostRef.current
    if (!host || !rendered) return
    const onClick = (e: MouseEvent) => {
      e.stopPropagation()
      const svg = host.querySelector('svg')
      if (!svg) return
      setPreviewSvg(svg.outerHTML)
      setPreviewScale(1)
      setPreviewOpen(true)
    }
    host.addEventListener('click', onClick)
    return () => host.removeEventListener('click', onClick)
  }, [rendered, code])

  if (!String(code || '').trim()) return null

  const zoomModal =
    previewOpen && previewSvg ? (
      <MermaidZoomModal
        svgHtml={previewSvg}
        scale={previewScale}
        onScaleChange={setPreviewScale}
        onClose={() => setPreviewOpen(false)}
        title={label}
      />
    ) : null

  return (
    <>
      <div className={`km-diagram-wrap${compact ? ' km-diagram-wrap--compact' : ''}`}>
        {label ? <span className="km-diagram-type-badge">{label}</span> : null}
        <div
          ref={hostRef}
          className={`km-diagram-svg-host${loading ? ' km-diagram-svg-host--loading' : ''}${
            rendered ? ' km-diagram-svg-host--zoomable' : ''
          }${renderFailed ? ' km-diagram-svg-host--failed' : ''}`}
          aria-label={label || '思维导图图表'}
          role={rendered ? 'button' : undefined}
          tabIndex={rendered ? 0 : undefined}
          onKeyDown={
            rendered
              ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    hostRef.current?.click()
                  }
                }
              : undefined
          }
        />
        {loading ? <p className="km-diagram-hint km-diagram-hint--loading">正在渲染图表…</p> : null}
        {!loading && rendered ? (
          <p className="km-diagram-hint">点击放大 · 滚轮缩放</p>
        ) : null}
        {!loading && renderFailed ? (
          <p className="km-diagram-hint km-diagram-hint--warn">图表解析失败，已显示源码</p>
        ) : null}
      </div>
      {zoomModal}
    </>
  )
}
