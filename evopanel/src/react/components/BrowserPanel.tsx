import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  browserEmbedClose,
  browserEmbedSetBounds,
  browserEmbedSupported,
  browserEmbedUpsert,
  clearBrowserEmbedCdp,
  registerBrowserEmbedCdp,
} from '../../lib/browser-embed-client.js'
import {
  buildBrowserStreamPath,
  connectBrowserStream,
  restartBrowserStream,
} from '../../lib/browser-stream-client.js'

export type BrowserStreamStatus = 'connecting' | 'live' | 'reconnecting' | 'error' | 'closed' | 'idle'

function formatDisplayUrl(raw: string): string {
  const url = String(raw || '').trim()
  if (!url) return ''
  try {
    const u = new URL(url)
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')
    return `${u.hostname}${path}${u.search || ''}`
  } catch {
    return url
  }
}

function GlobeNetworkIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.8 3.2 4.2 7 4.2 9s-1.4 5.8-4.2 9" />
      <path d="M12 3c-2.8 3.2-4.2 7-4.2 9s1.4 5.8 4.2 9" />
    </svg>
  )
}

function BrowserPanelIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M3 8.5h18" />
      <circle cx="7" cy="6.25" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="10" cy="6.25" r="0.9" fill="currentColor" stroke="none" />
      <path d="M8 13h8M8 16h5" strokeLinecap="round" />
    </svg>
  )
}

function ExternalLinkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M14 5h5v5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 14L19 5" strokeLinecap="round" />
      <path d="M19 14v5H5V5h5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M21 3v6h-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function LiveSpinner() {
  return <span className="browser-panel-spinner" aria-hidden />
}

/** Skip all-white screencast frames that appear during screenshot capture. */
function isMostlyBlankImage(dataUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const raw = String(dataUrl || '').trim()
    if (!raw) {
      resolve(true)
      return
    }
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => {
      try {
        const w = Math.min(24, Math.max(1, img.naturalWidth))
        const h = Math.min(24, Math.max(1, img.naturalHeight))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(false)
          return
        }
        ctx.drawImage(img, 0, 0, w, h)
        const { data } = ctx.getImageData(0, 0, w, h)
        let bright = 0
        const total = w * h
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i] ?? 0
          const g = data[i + 1] ?? 0
          const b = data[i + 2] ?? 0
          if (r > 245 && g > 245 && b > 245) bright += 1
        }
        resolve(bright / total > 0.9)
      } catch {
        resolve(false)
      }
    }
    img.onerror = () => resolve(false)
    img.src = raw
  })
}

function streamStatusLabel(status: BrowserStreamStatus): string {
  switch (status) {
    case 'live':
      return 'Live'
    case 'connecting':
      return 'Connecting'
    case 'reconnecting':
      return 'Reconnecting'
    case 'error':
      return 'Offline'
    case 'closed':
      return 'Closed'
    default:
      return 'Idle'
  }
}

function BrowserChromeBar({
  pageUrl,
  streamStatus,
  refreshBusy,
  canRefresh,
  onRefresh,
  onClose,
}: {
  pageUrl?: string
  streamStatus: BrowserStreamStatus
  refreshBusy?: boolean
  canRefresh?: boolean
  onRefresh?: () => void
  onClose: () => void
}) {
  const displayUrl = useMemo(() => formatDisplayUrl(pageUrl || ''), [pageUrl])
  const statusClass =
    streamStatus === 'live'
      ? 'is-live'
      : streamStatus === 'reconnecting' || streamStatus === 'connecting'
        ? 'is-pending'
        : streamStatus === 'error'
          ? 'is-error'
          : 'is-idle'

  return (
    <header className="browser-panel-chrome" aria-label="Browser toolbar">
      <button
        type="button"
        className={`browser-panel-url-refresh${refreshBusy ? ' is-busy' : ''}`}
        title="Refresh live view"
        aria-label="Refresh live view"
        disabled={!canRefresh || refreshBusy}
        onClick={onRefresh}
      >
        <RefreshIcon />
      </button>
      <div className={`browser-panel-url-bar${displayUrl ? '' : ' is-empty'}`}>
        <span className="browser-panel-url-favicon" aria-hidden>
          {displayUrl ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
              <circle cx="12" cy="12" r="9" />
              <path d="M3 12h18M12 3c2.5 2.8 3.8 6.2 3.8 9s-1.3 6.2-3.8 9M12 3c-2.5 2.8-3.8 6.2-3.8 9s1.3 6.2 3.8 9" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
              <circle cx="12" cy="12" r="9" />
              <path d="M8 12h8" strokeLinecap="round" />
            </svg>
          )}
        </span>
        <span className="browser-panel-url-text" title={pageUrl || undefined}>
          {displayUrl || 'Waiting for page…'}
        </span>
      </div>
      <span
        className={`browser-panel-stream-dot ${statusClass}`}
        title={streamStatusLabel(streamStatus)}
        aria-label={streamStatusLabel(streamStatus)}
      />
      {pageUrl ? (
        <a
          className="browser-panel-url-external"
          href={pageUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="Open in system browser"
          aria-label="Open in system browser"
        >
          <ExternalLinkIcon />
        </a>
      ) : null}
      <button
        type="button"
        className="browser-panel-chrome-close"
        title="Close browser panel"
        aria-label="Close browser panel"
        onClick={onClose}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
        </svg>
      </button>
    </header>
  )
}

function readEmbedBounds(el: HTMLElement | null) {
  if (!el) return null
  const rect = el.getBoundingClientRect()
  if (rect.width < 8 || rect.height < 8) return null
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  }
}

async function waitForEmbedBounds(el: HTMLElement | null, timeoutMs = 2400) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const bounds = readEmbedBounds(el)
    if (bounds) return bounds
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
  return readEmbedBounds(el)
}

function BrowserEmbedHost({
  isOpen,
  threadId,
  pageUrl,
  onReady,
  onFailed,
}: {
  isOpen: boolean
  threadId: string
  pageUrl?: string
  onReady?: () => void
  onFailed?: (message: string) => void
}) {
  const slotRef = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')

  const syncBounds = useCallback(async () => {
    const tid = String(threadId || '').trim()
    if (!tid || !isOpen) return
    const bounds = readEmbedBounds(slotRef.current)
    if (!bounds) return
    await browserEmbedSetBounds({ threadId: tid, ...bounds })
  }, [isOpen, threadId])

  useLayoutEffect(() => {
    let cancelled = false
    const tid = String(threadId || '').trim()
    if (!isOpen || !tid) {
      // Use requestAnimationFrame to defer state updates outside of effect body
      requestAnimationFrame(() => {
        if (!cancelled) {
          setReady(false)
          setError('')
        }
      })
      return
    }

    const mount = async () => {
      const supported = await browserEmbedSupported()
      if (!supported) {
        if (!cancelled) {
          setError('当前环境不支持内嵌浏览器')
          onFailed?.('embed unsupported')
        }
        return
      }
      const bounds = await waitForEmbedBounds(slotRef.current)
      if (!bounds) {
        if (!cancelled) {
          setError('浏览器区域尚未就绪')
          onFailed?.('embed bounds unavailable')
        }
        return
      }
      const info = await browserEmbedUpsert({
        threadId: tid,
        url: pageUrl,
        ...bounds,
      })
      if (!info?.cdpUrl) {
        if (!cancelled) {
          setError('内嵌浏览器启动失败')
          onFailed?.('embed upsert failed')
        }
        return
      }
      const ok = await registerBrowserEmbedCdp(tid, info.cdpUrl)
      if (!ok) {
        if (!cancelled) {
          setError('无法注册浏览器 CDP')
          onFailed?.('embed cdp register failed')
        }
        return
      }
      if (!cancelled) {
        setError('')
        setReady(true)
        onReady?.()
        void syncBounds()
      }
    }

    void mount()
    return () => {
      cancelled = true
    }
  }, [isOpen, threadId, pageUrl, onReady, onFailed, syncBounds])

  useEffect(() => {
    if (!isOpen || !ready) return
    const onResize = () => {
      void syncBounds()
    }
    window.addEventListener('resize', onResize)
    const ro =
      typeof ResizeObserver !== 'undefined' && slotRef.current
        ? new ResizeObserver(() => {
            void syncBounds()
          })
        : null
    if (slotRef.current) ro?.observe(slotRef.current)
    return () => {
      window.removeEventListener('resize', onResize)
      ro?.disconnect()
    }
  }, [isOpen, ready, syncBounds])

  useEffect(() => {
    if (isOpen) return
    const tid = String(threadId || '').trim()
    if (!tid) return
    void browserEmbedClose(tid)
    void clearBrowserEmbedCdp(tid)
    // Defer state update to avoid cascading renders
    requestAnimationFrame(() => {
      setReady(false)
    })
  }, [isOpen, threadId])

  return (
    <div className="browser-panel-embed-host">
      <div ref={slotRef} className="browser-panel-embed-slot" aria-hidden />
      {!ready && !error ? <LiveSpinner /> : null}
      {error ? <p className="browser-panel-embed-error">{error}</p> : null}
    </div>
  )
}

function BrowserLiveCanvas({ src }: { src: string }) {
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const srcRef = useRef(src)
  const lastGoodSrcRef = useRef('')

  useEffect(() => {
    srcRef.current = src
  }, [src])

  useEffect(() => {
    const stage = stageRef.current
    const canvas = canvasRef.current
    if (!stage || !canvas) return

    let cancelled = false

    const paint = (dataUrl: string) => {
      if (!dataUrl || cancelled) return
      const img = new Image()
      img.decoding = 'async'
      img.onload = () => {
        if (cancelled) return
        const cw = Math.max(1, stage.clientWidth)
        const ch = Math.max(1, stage.clientHeight)
        const iw = Math.max(1, img.naturalWidth)
        const ih = Math.max(1, img.naturalHeight)
        const scale = Math.min(cw / iw, ch / ih)
        const drawW = Math.max(1, Math.round(iw * scale))
        const drawH = Math.max(1, Math.round(ih * scale))
        const offsetX = Math.round((cw - drawW) / 2)
        const offsetY = Math.round((ch - drawH) / 2)

        canvas.width = cw
        canvas.height = ch
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.fillStyle = '#0b1220'
        ctx.fillRect(0, 0, cw, ch)
        ctx.drawImage(img, offsetX, offsetY, drawW, drawH)
        lastGoodSrcRef.current = dataUrl
      }
      img.onerror = () => {
        if (cancelled) return
        const fallback = lastGoodSrcRef.current
        if (fallback && fallback !== dataUrl) paint(fallback)
      }
      img.src = dataUrl
    }

    paint(srcRef.current)

    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            paint(srcRef.current || lastGoodSrcRef.current)
          })
        : null
    ro?.observe(stage)

    return () => {
      cancelled = true
      ro?.disconnect()
    }
  }, [src])

  return (
    <div ref={stageRef} className="browser-panel-stage browser-panel-stage-live browser-panel-stage-fit">
      <canvas ref={canvasRef} className="browser-panel-live-canvas" aria-hidden />
    </div>
  )
}

function BrowserLiveViewer({
  streamPath,
  isOpen,
  refreshNonce,
  onStatusChange,
}: {
  streamPath: string
  isOpen: boolean
  refreshNonce?: number
  onStatusChange: (status: BrowserStreamStatus) => void
}) {
  const [frameSrc, setFrameSrc] = useState('')
  const [status, setStatus] = useState<BrowserStreamStatus>('connecting')
  const streamPathRef = useRef(streamPath)
  const hasFrameRef = useRef(false)
  const lastFrameRef = useRef('')
  const [displaySrc, setDisplaySrc] = useState('')

  useEffect(() => {
    if (frameSrc) {
      queueMicrotask(() => setDisplaySrc(frameSrc))
    } else if (lastFrameRef.current) {
      queueMicrotask(() => setDisplaySrc(lastFrameRef.current))
    }
  }, [frameSrc])

  const applyStatus = useCallback(
    (next: BrowserStreamStatus) => {
      setStatus(next)
      onStatusChange(next)
    },
    [onStatusChange],
  )

  useEffect(() => {
    streamPathRef.current = streamPath
  }, [streamPath])

  useEffect(() => {
    if (!isOpen || !streamPath) {
      hasFrameRef.current = false
      lastFrameRef.current = ''
      // Defer state updates to avoid cascading renders
      requestAnimationFrame(() => {
        setFrameSrc('')
        applyStatus('idle')
      })
      return
    }

    hasFrameRef.current = Boolean(lastFrameRef.current)
    applyStatus(lastFrameRef.current ? 'reconnecting' : 'connecting')

    const disconnect = connectBrowserStream(streamPath, {
      onFrame: (dataUrl) => {
        if (streamPathRef.current !== streamPath) return
        void (async () => {
          if (hasFrameRef.current && (await isMostlyBlankImage(dataUrl))) return
          hasFrameRef.current = true
          lastFrameRef.current = dataUrl
          setFrameSrc(dataUrl)
          setDisplaySrc(dataUrl)
          applyStatus('live')
        })()
      },
      onStatus: (next) => {
        if (streamPathRef.current !== streamPath) return
        applyStatus(next)
      },
      onError: () => {
        if (streamPathRef.current !== streamPath) return
        if (!hasFrameRef.current) applyStatus('error')
        else applyStatus('reconnecting')
      },
    })

    return () => {
      disconnect()
    }
  }, [isOpen, streamPath, refreshNonce, applyStatus])

  if (status === 'connecting' && !displaySrc) {
    return (
      <div className="browser-panel-stage browser-panel-stage-empty">
        <LiveSpinner />
      </div>
    )
  }

  if (status === 'error' && !displaySrc) {
    return (
      <div className="browser-panel-stage browser-panel-stage-empty">
        <BrowserPanelIcon className="browser-panel-stage-icon" />
      </div>
    )
  }

  if (!displaySrc) {
    return (
      <div className="browser-panel-stage browser-panel-stage-empty">
        <BrowserPanelIcon className="browser-panel-stage-icon" />
      </div>
    )
  }

  return (
    <>
      <BrowserLiveCanvas src={displaySrc} />
    </>
  )
}

export type BrowserPanelProps = {
  isOpen: boolean
  pageUrl?: string
  liveStreamUrl?: string
  streamThreadId?: string
  streamKickNonce?: number
  sharedBrowser?: boolean
  browserMode?: 'headed' | 'cdp' | 'headless' | 'embed'
  onClose: () => void
}

export const BrowserPanel = memo(function BrowserPanel({
  isOpen,
  pageUrl,
  liveStreamUrl,
  streamThreadId,
  streamKickNonce = 0,
  sharedBrowser = false,
  browserMode,
  onClose,
}: BrowserPanelProps) {
  const [streamStatus, setStreamStatus] = useState<BrowserStreamStatus>('idle')
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [refreshBusy, setRefreshBusy] = useState(false)
  const [embedSupported, setEmbedSupported] = useState(false)
  const [embedReady, setEmbedReady] = useState(false)
  const [embedFailed, setEmbedFailed] = useState(false)
  const lastStreamKickRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    void browserEmbedSupported().then((ok) => {
      if (!cancelled) setEmbedSupported(ok)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!isOpen) {
      // Defer state updates to avoid cascading renders
      requestAnimationFrame(() => {
        setEmbedReady(false)
        setEmbedFailed(false)
      })
    }
  }, [isOpen, streamThreadId])

  const preferEmbeddedBrowser = embedSupported && Boolean(String(streamThreadId || '').trim())
  const useEmbeddedBrowser = preferEmbeddedBrowser && embedReady && !embedFailed
  const streamPath = useMemo(() => {
    const direct = String(liveStreamUrl || '').trim()
    if (direct) return direct
    const tid = String(streamThreadId || '').trim()
    if (!tid) return ''
    return buildBrowserStreamPath(tid)
  }, [liveStreamUrl, streamThreadId])

  const handleRefresh = useCallback(async () => {
    if (refreshBusy || !streamPath) return
    setRefreshBusy(true)
    setStreamStatus((prev) => (prev === 'live' ? 'reconnecting' : prev))
    const tid = String(streamThreadId || '').trim()
    if (tid) {
      try {
        await restartBrowserStream(tid)
      } catch {
        // best-effort — still reconnect WS
      }
    }
    setRefreshNonce((n) => n + 1)
    setRefreshBusy(false)
  }, [refreshBusy, streamPath, streamThreadId])

  // Screenshot completed — reconnect WS only (no restart API; backend already restored stream).
  useEffect(() => {
    if (!isOpen || !streamKickNonce || streamKickNonce === lastStreamKickRef.current) return
    lastStreamKickRef.current = streamKickNonce
    setStreamStatus((prev) => (prev === 'live' ? 'reconnecting' : prev))
    setRefreshNonce((n) => n + 1)
  }, [streamKickNonce, isOpen])

  if (!isOpen) return null

  const hasStream = Boolean(streamPath) && (!preferEmbeddedBrowser || embedFailed || !embedReady)
  const embedThreadId = String(streamThreadId || '').trim()
  const showSharedBrowserHint =
    !useEmbeddedBrowser &&
    !preferEmbeddedBrowser &&
    browserMode !== 'embed' &&
    (sharedBrowser || browserMode === 'headed' || browserMode === 'cdp')
  const sharedBrowserHint =
    browserMode === 'cdp'
      ? '已连接你本机的 Chrome，请直接在那个窗口操作（与 Agent 共用同一浏览器）。'
      : 'Chrome 已在桌面打开，请直接在那个窗口操作（与 Agent 共用同一浏览器）。'
  const showStreamPreviewLabel = showSharedBrowserHint && hasStream

  return (
    <aside className="react-chat-collab-exec-panel react-chat-browser-panel" role="region" aria-label="Browser">
      <BrowserChromeBar
        pageUrl={pageUrl}
        streamStatus={useEmbeddedBrowser ? 'live' : streamStatus}
        refreshBusy={refreshBusy}
        canRefresh={hasStream}
        onRefresh={() => void handleRefresh()}
        onClose={onClose}
      />
      <div className="react-chat-collab-exec-panel-body browser-panel-body browser-panel-body-live">
        {showSharedBrowserHint ? (
          <div className="browser-panel-shared-hint" role="status">
            <BrowserPanelIcon className="browser-panel-shared-hint-icon" />
            <p className="browser-panel-shared-hint-text">{sharedBrowserHint}</p>
          </div>
        ) : null}
        {useEmbeddedBrowser && embedThreadId ? (
          <BrowserEmbedHost
            isOpen={isOpen}
            threadId={embedThreadId}
            pageUrl={pageUrl}
            onReady={() => setEmbedReady(true)}
            onFailed={() => setEmbedFailed(true)}
          />
        ) : hasStream ? (
          <div className={`browser-panel-live-host${showStreamPreviewLabel ? ' is-preview' : ''}`}>
            {showStreamPreviewLabel ? <div className="browser-panel-preview-label">侧栏预览</div> : null}
            <BrowserLiveViewer
              streamPath={streamPath}
              isOpen={isOpen}
              refreshNonce={refreshNonce}
              onStatusChange={setStreamStatus}
            />
          </div>
        ) : preferEmbeddedBrowser && embedThreadId && !embedFailed ? (
          <BrowserEmbedHost
            isOpen={isOpen}
            threadId={embedThreadId}
            pageUrl={pageUrl}
            onReady={() => setEmbedReady(true)}
            onFailed={() => setEmbedFailed(true)}
          />
        ) : (
          <div className="browser-panel-stage browser-panel-stage-empty">
            {preferEmbeddedBrowser || hasStream ? <LiveSpinner /> : <BrowserPanelIcon className="browser-panel-stage-icon" />}
          </div>
        )}
      </div>
    </aside>
  )
})

/** Toolbar toggle icon — globe / network */
export function BrowserToolbarIcon() {
  return <GlobeNetworkIcon />
}
