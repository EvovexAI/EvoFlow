import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import {
  browserEmbedClose,
  browserEmbedSetBounds,
  browserEmbedSupported,
  browserEmbedSupportedSync,
  browserEmbedUpsert,
  clearBrowserEmbedCdp,
  registerBrowserEmbedCdp,
} from '../../lib/browser-embed-client.js'
import {
  buildBrowserStreamPath,
  connectBrowserStream,
  restartBrowserStream,
} from '../../lib/browser-stream-client.js'
import {
  BROWSER_VIEWPORT_PRESETS,
  clickBrowserAt,
  scrollBrowserBy,
  sendBrowserCommand,
  listBrowserTabs,
  newBrowserTab,
  selectBrowserTab,
  closeBrowserTab,
  DEFAULT_BROWSER_VIEWPORT,
  setBrowserViewport,
  type BrowserViewportPresetId,
  type BrowserViewportSize,
} from '../../lib/browser-viewport-client.js'
import {
  getBrowserRuntimeSnapshot,
  applyBrowserCommandResponse,
  setBrowserTabs,
  subscribeBrowserRuntime,
} from '../../lib/browser-panel-store.js'
import { rightStageStore } from '../../lib/right-stage/right-stage-store.js'
import { normalizeRightStageKind } from '../../lib/right-stage/right-stage-types.js'
import {
  clearBrowserDebug,
  dbgLog,
  dbgWarn,
  getBrowserDebugSnapshot,
  subscribeBrowserDebug,
  type BrowserDebugEntry,
} from '../../lib/browser-debug-log.js'

export type BrowserStreamStatus = 'connecting' | 'live' | 'reconnecting' | 'error' | 'closed' | 'idle'

/** Zoom presets ported from ZCode browser viewport zoom (fit + fixed percentages). */
const ZOOM_OPTIONS = ['fit', '50', '75', '100', '125', '150', '200'] as const
type ZoomOption = (typeof ZOOM_OPTIONS)[number]



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
      width="15"
      height="15"
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
  zoom,
  zoomVisible,
  viewportBusy,
  activePreset,
  onPresetChange,
  viewport,
  onViewportSizeChange,
  onNavigate,
  onBack,
  onForward,
  navBusy,
  onZoomChange,
  onRefresh,
  debugOpen,
  onToggleDebug,
}: {
  pageUrl?: string
  streamStatus: BrowserStreamStatus
  refreshBusy?: boolean
  canRefresh?: boolean
  zoom?: ZoomOption
  zoomVisible?: boolean
  viewportBusy?: boolean
  activePreset?: BrowserViewportPresetId
  onPresetChange?: (preset: BrowserViewportPresetId, size: BrowserViewportSize) => void
  viewport?: BrowserViewportSize
  onViewportSizeChange?: (size: BrowserViewportSize) => void
  onNavigate?: (url: string) => void
  onBack?: () => void
  onForward?: () => void
  navBusy?: boolean
  onZoomChange?: (zoom: ZoomOption) => void
  onRefresh?: () => void
  onClose: () => void
  debugOpen?: boolean
  onToggleDebug?: () => void
}) {
  const displayUrl = useMemo(() => formatDisplayUrl(pageUrl || ''), [pageUrl])
  const [urlDraft, setUrlDraft] = useState(displayUrl)
  const statusClass =
    streamStatus === 'live'
      ? 'is-live'
      : streamStatus === 'reconnecting' || streamStatus === 'connecting'
        ? 'is-pending'
        : streamStatus === 'error'
          ? 'is-error'
          : 'is-idle'
  const [moreOpen, setMoreOpen] = useState(false)
  const [dimWidth, setDimWidth] = useState<string>(
    viewport?.width ? String(viewport.width) : '',
  )
  const [dimHeight, setDimHeight] = useState<string>(
    viewport?.height ? String(viewport.height) : '',
  )
  useEffect(() => {
    setDimWidth(viewport?.width ? String(viewport.width) : '')
    setDimHeight(viewport?.height ? String(viewport.height) : '')
  }, [viewport?.width, viewport?.height])
  const commitDims = () => {
    if (!onViewportSizeChange) return
    const w = Math.min(3840, Math.max(320, Number.parseInt(dimWidth || '0', 10) || 0))
    const h = Math.min(2160, Math.max(320, Number.parseInt(dimHeight || '0', 10) || 0))
    if (!w || !h) return
    if (w === viewport?.width && h === viewport?.height) return
    onViewportSizeChange({ width: w, height: h })
  }

  useEffect(() => {
    setUrlDraft(displayUrl)
  }, [displayUrl])
  const viewportIsCustom = Boolean(
    viewport && (viewport.width !== 1280 || viewport.height !== 720),
  )
  return (
    <>
      <form
        className="browser-panel-toolbar"
        onSubmit={(e) => {
          e.preventDefault()
          const next = urlDraft.trim()
          if (!next) return
          if (next === (pageUrl || '').trim()) {
            onRefresh?.()
            return
          }
          onNavigate?.(next)
        }}
      >
        <button
          type="button"
          className="browser-panel-tb-btn"
          title="后退"
          aria-label="后退"
          disabled={navBusy || !onBack}
          onClick={() => onBack?.()}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m15 18-6-6 6-6" /></svg>
        </button>
        <button
          type="button"
          className="browser-panel-tb-btn"
          title="前进"
          aria-label="前进"
          disabled={navBusy || !onForward}
          onClick={() => onForward?.()}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m9 18 6-6-6-6" /></svg>
        </button>
        <button
          type="button"
          className={`browser-panel-tb-btn${refreshBusy ? ' is-busy' : ''}`}
          title="刷新"
          aria-label="刷新"
          disabled={!canRefresh || refreshBusy}
          onClick={onRefresh}
        >
          <RefreshIcon />
        </button>
        <input
          className="browser-panel-tb-url"
          value={urlDraft}
          placeholder="输入网址后回车"
          spellCheck={false}
          aria-label="地址栏"
          onChange={(e) => setUrlDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              console.log('[browser-panel] Enter key pressed, urlDraft:', urlDraft)
              e.preventDefault()
              e.stopPropagation()
              const next = urlDraft.trim()
              if (!next) return
              if (next === (pageUrl || '').trim()) {
                onRefresh?.()
                return
              }
              onNavigate?.(next)
            } else if (e.key === 'Escape') {
              setUrlDraft(pageUrl || '')
            }
          }}
        />
        <button type="submit" style={{ display: 'none' }} />
        <button
          type="button"
          className={`browser-panel-tb-btn is-secondary${viewportIsCustom ? ' is-pressed' : ''}`}
          title="退出自由尺寸（恢复默认视口 1280×720）"
          aria-label="退出自由尺寸"
          aria-pressed={viewportIsCustom}
          disabled={viewportBusy || !onViewportSizeChange}
          onClick={() => onViewportSizeChange?.({ width: 1280, height: 720 })}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8" /><path d="M10 19v-3.96 3.15" /><path d="M7 19h5" /><rect width="6" height="10" x="16" y="12" rx="2" /></svg>
        </button>
        <button
          type="button"
          className="browser-panel-tb-btn"
          title="选择网页元素加入聊天（即将支持）"
          aria-label="选择网页元素加入聊天"
          disabled
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M14 4.1 12 6" /><path d="m5.1 8-2.9-.8" /><path d="m6 12-1.9 2" /><path d="M7.2 2.2 8 5.1" /><path d="M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z" /></svg>
        </button>
        <button
          type="button"
          className={`browser-panel-tb-btn${moreOpen ? ' is-pressed' : ''}`}
          title="更多浏览器操作"
          aria-label="更多浏览器操作"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((v) => !v)}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></svg>
        </button>
      {moreOpen ? (
        <>
          <div className="browser-panel-menu-backdrop" onClick={() => setMoreOpen(false)} aria-hidden="true"></div>
          <div className="browser-panel-menu" role="menu" aria-label="更多浏览器操作">
            <div className="browser-panel-menu-section">
              <div className="browser-panel-menu-title">浏览器状态</div>
              <div className="browser-panel-menu-row">
                <span className={`browser-panel-stream-dot ${statusClass}`} aria-hidden="true"></span>
                <span>{streamStatusLabel(streamStatus)}</span>
                {pageUrl ? (
                  <a
                    className="browser-panel-url-external"
                    href={pageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="在系统浏览器打开"
                    aria-label="在系统浏览器打开"
                  >
                    <ExternalLinkIcon />
                  </a>
                ) : null}
              </div>
            </div>
            {onPresetChange ? (
              <div className="browser-panel-menu-section">
                <div className="browser-panel-menu-title">视口</div>
                <div className="browser-panel-menu-row browser-panel-viewport-presets" role="group" aria-label="Viewport preset">
                  {BROWSER_VIEWPORT_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className={`browser-panel-viewport-btn${activePreset === preset.id ? ' is-active' : ''}`}
                      title={`${preset.label} (${preset.width}×${preset.height})`}
                      disabled={viewportBusy}
                      onClick={() => {
                        onPresetChange(preset.id, { width: preset.width, height: preset.height })
                        setMoreOpen(false)
                      }}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                {onViewportSizeChange ? (
                  <span
                    className="browser-panel-viewport-dims"
                    title="自定义视口尺寸（Enter 应用，320–3840 × 320–2160）"
                  >
                    <input
                      className="browser-panel-viewport-dim"
                      inputMode="numeric"
                      aria-label="视口宽度"
                      value={dimWidth}
                      disabled={viewportBusy}
                      onChange={(e) => setDimWidth(e.target.value.replace(/[^0-9]/g, ''))}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitDims() } }}
                      onBlur={commitDims}
                    />
                    <span className="browser-panel-viewport-dim-x" aria-hidden>×</span>
                    <input
                      className="browser-panel-viewport-dim"
                      inputMode="numeric"
                      aria-label="视口高度"
                      value={dimHeight}
                      disabled={viewportBusy}
                      onChange={(e) => setDimHeight(e.target.value.replace(/[^0-9]/g, ''))}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitDims() } }}
                      onBlur={commitDims}
                    />
                  </span>
                ) : null}
              </div>
            ) : null}
            {zoomVisible ? (
              <div className="browser-panel-menu-section">
                <div className="browser-panel-menu-title">缩放</div>
                <select
                  className="browser-panel-zoom"
                  value={zoom || 'fit'}
                  title="缩放实时画面"
                  aria-label="Zoom live view"
                  onChange={(event) => onZoomChange?.(event.target.value as ZoomOption)}
                >
                  {ZOOM_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option === 'fit' ? '适应' : `${option}%`}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {onToggleDebug ? (
              <div className="browser-panel-menu-section">
                <button
                  type="button"
                  className="browser-panel-menu-item"
                  aria-pressed={debugOpen}
                  onClick={() => {
                    onToggleDebug()
                    setMoreOpen(false)
                  }}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m8 8-4 4 4 4" /><path d="m16 8 4 4-4 4" /><path d="m13 5-2 14" /></svg>
                  调试日志{debugOpen ? '（开）' : ''}
                </button>
              </div>
            ) : null}
          </div>
        </>
        ) : null}
      </form>
    </>
  )
}

/** Site favicon (`origin/favicon.ico`); null falls back to the globe glyph. */
function faviconUrlFor(url: string): string | null {
  try {
    return `${new URL(url).origin}/favicon.ico`
  } catch {
    return null
  }
}

type SurfaceTabKind = 'browser' | 'collab-workflow' | 'mind-map'

interface SurfaceTabRender {
  key: string
  kind: SurfaceTabKind
  /** engineIndex: -2 = home chip，-1 = 占位 / surface tab，>=0 = 浏览器引擎 tab。 */
  engineIndex: number
  title: string
  url: string
  active: boolean
  /** 标识是不是 non-browser surface（工作流 / 思维导图），关闭按钮的行为不同。 */
  isSurface?: boolean
  /** 标识是不是浏览器 home chip：永远存在，不可拖拽，无关闭按钮。 */
  isHome?: boolean
}

function SurfaceIcon({ kind }: { kind: SurfaceTabKind }) {
  if (kind === 'collab-workflow') {
    return (
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="3" y="3" width="6" height="6" rx="1" />
        <rect x="15" y="3" width="6" height="6" rx="1" />
        <rect x="3" y="15" width="6" height="6" rx="1" />
        <rect x="15" y="15" width="6" height="6" rx="1" />
        <path d="M9 6h6M9 18h6M6 9v6M18 9v6" />
      </svg>
    )
  }
  if (kind === 'mind-map') {
    return (
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="12" r="3" />
        <circle cx="4" cy="5" r="2" />
        <circle cx="20" cy="5" r="2" />
        <circle cx="4" cy="19" r="2" />
        <circle cx="20" cy="19" r="2" />
        <path d="M11 10 6 7M13 10l5-3M11 14l-5 3M13 14l5 3" />
      </svg>
    )
  }
  // browser fallback (shouldn't really happen — surfaceTabs for browser always has a favicon URL)
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </svg>
  )
}

function SurfaceTabChipInner({
  tab,
  onSelect,
  onClose,
  onCloseWebTab,
  onSelectWebTab,
  onDragStartChip,
  onDragOverChip,
  onDropChip,
}: {
  tab: SurfaceTabRender
  onSelect: (kind: SurfaceTabKind) => void
  onClose: (kind: SurfaceTabKind) => void
  onCloseWebTab: (engineIndex: number) => void
  onSelectWebTab: (engineIndex: number) => void
  onDragStartChip: (engineIndex: number) => void
  onDragOverChip: (engineIndex: number) => void
  onDropChip: () => void
}) {
  const isWebTab = !tab.isSurface && !tab.isHome
  const isHomeChip = !!tab.isHome
  const [faviconFailed, setFaviconFailed] = useState(false)
  const favSrc = isWebTab ? faviconUrlFor(tab.url) : ''
  const label = tab.title
  const draggable = isWebTab
  return (
    <div
      className={`browser-panel-tabchip${tab.active ? ' is-active' : ''}${tab.isSurface ? ' is-surface' : ''}`}
      title={tab.url || undefined}
      role="tab"
      tabIndex={0}
      aria-selected={tab.active}
      draggable={draggable}
      onDragStart={(e) => {
        if (!draggable) return
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', String(tab.engineIndex))
        onDragStartChip(tab.engineIndex)
      }}
      onDragOver={(e) => {
        if (!draggable) return
        e.preventDefault()
        onDragOverChip(tab.engineIndex)
      }}
      onDrop={(e) => {
        if (!draggable) return
        e.preventDefault()
        onDropChip()
      }}
      onClick={() => {
        if (!tab.active) {
          if (isWebTab) onSelectWebTab(tab.engineIndex)
          else onSelect(tab.kind)
        }
      }}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !tab.active) {
          e.preventDefault()
          if (isWebTab) onSelectWebTab(tab.engineIndex)
          else onSelect(tab.kind)
        }
      }}
    >
      <span className="browser-panel-tabchip-icon" aria-hidden="true">
        {isWebTab ? (
          favSrc && !faviconFailed ? (
            <img
              src={favSrc}
              alt=""
              className="browser-panel-tabchip-favicon"
              draggable={false}
              referrerPolicy="no-referrer"
              onError={() => setFaviconFailed(true)}
            />
          ) : (
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
              <circle cx="12" cy="12" r="10" />
              <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
              <path d="M2 12h20" />
            </svg>
          )
        ) : (
          <SurfaceIcon kind={tab.kind} />
        )}
      </span>
      <span className="browser-panel-tabchip-title">{label}</span>
      {!isHomeChip ? (
        <button
          type="button"
          className="browser-panel-tabchip-close"
          title={isWebTab ? '关闭标签页' : '关闭视图'}
          aria-label={`关闭 ${label}`}
          onClick={(e) => {
            e.stopPropagation()
            if (isWebTab) onCloseWebTab(tab.engineIndex)
            else onClose(tab.kind)
          }}
        >
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      ) : null}
    </div>
  )
}

const SurfaceTabChip = memo(SurfaceTabChipInner)

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
  // Guards against remount churn: `pageUrl` changes on every agent navigation and
  // `syncBounds` identity can drift, but neither should tear down a mount that is
  // already in flight. Only a different thread genuinely needs a fresh mount.
  const mountedThreadRef = useRef('')

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
    // Unconditional: this is the only place that proves the embed host actually
    // mounted, so every early-return path has to be visible.
    dbgLog(
      `[browser-embed] effect enter isOpen=${isOpen} tid=${tid || '(empty)'} ` +
        `mountedRef=${mountedThreadRef.current || '(empty)'}`,
    )
    if (!isOpen || !tid) {
      // Use requestAnimationFrame to defer state updates outside of effect body
      requestAnimationFrame(() => {
        if (!cancelled) {
          dbgLog(`[browser-embed] effect idle-reset isOpen=${isOpen} tid=${tid || '(empty)'}`)
          setReady(false)
          setError('')
        }
      })
      return
    }
    // Already mounting (or mounted) for this thread: let the in-flight mount
    // finish instead of cancelling and restarting it. `mount()` spends up to
    // ~2.4s waiting for layout, and restarting on every unrelated prop change
    // means it never gets there.
    if (mountedThreadRef.current === tid) {
      dbgLog(`[browser-embed] effect skip (already mounting) tid=${tid}`)
      return
    }
    mountedThreadRef.current = tid
    dbgLog(`[browser-embed] effect start mount tid=${tid}`)

    const mount = async () => {
      const supported = await browserEmbedSupported()
      if (!supported) {
        dbgWarn(`[browser-embed] unsupported in this runtime thread=${tid}`)
        if (!cancelled) {
          setError('当前环境不支持内嵌浏览器')
          onFailed?.('embed unsupported')
        }
        return
      }
      const bounds = await waitForEmbedBounds(slotRef.current)
      if (!bounds) {
        dbgWarn(`[browser-embed] slot has no layout box yet thread=${tid}`)
        if (!cancelled) {
          setError('浏览器区域尚未就绪')
          onFailed?.('embed bounds unavailable')
        }
        return
      }
      dbgLog(
        `[browser-embed] upsert thread=${tid} bounds=${JSON.stringify(bounds)} url=${pageUrl || '(none — boot blank, navigate on result)'}`,
      )
      const info = await browserEmbedUpsert({
        threadId: tid,
        url: pageUrl,
        ...bounds,
      })
      if (!info?.cdpUrl) {
        dbgWarn(`[browser-embed] upsert returned no cdpUrl thread=${tid} info=${JSON.stringify(info)}`)
        if (!cancelled) {
          setError('内嵌浏览器启动失败')
          onFailed?.('embed upsert failed')
        }
        return
      }
      dbgLog(`[browser-embed] cdp ready thread=${tid} label=${info.webviewLabel}`)
      const ok = await registerBrowserEmbedCdp(tid, info.cdpUrl)
      if (!ok) {
        dbgWarn(`[browser-embed] cdp register rejected by backend thread=${tid}`)
        if (!cancelled) {
          setError('无法注册浏览器 CDP')
          onFailed?.('embed cdp register failed')
        }
        return
      }
      dbgLog(`[browser-embed] ready thread=${tid}`)
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

  // Once the webview exists, agent navigations only need to re-point the existing
  // window — `browser_embed_upsert` detects the live label and navigates in place.
  // A full remount here would destroy and recreate the browser (and lose scroll
  // position / form state) on every link the agent clicks.
  const lastNavigatedRef = useRef('')
  useEffect(() => {
    if (!ready) return
    const tid = String(threadId || '').trim()
    const next = String(pageUrl || '').trim()
    if (!tid || !next || next === lastNavigatedRef.current) return
    // Re-measure before re-pointing the window. Falling back to a hardcoded
    // origin here used to fling the embedded browser into the top-left corner
    // of the screen whenever the slot had not been laid out yet.
    const bounds = readEmbedBounds(slotRef.current)
    if (!bounds) {
      // Deliberately do not record the url yet: a later re-render must be able to
      // retry once layout settles.
      dbgWarn(`[browser-embed] navigate deferred, slot has no layout box thread=${tid} url=${next}`)
      return
    }
    lastNavigatedRef.current = next
    dbgLog(`[browser-embed] navigate thread=${tid} url=${next} bounds=${JSON.stringify(bounds)}`)
    void browserEmbedUpsert({ threadId: tid, url: next, ...bounds }).then((info) => {
      if (info?.cdpUrl) void registerBrowserEmbedCdp(tid, info.cdpUrl)
    })
  }, [ready, threadId, pageUrl])

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
    // Panel is gone: allow a future mount for this thread to run again.
    mountedThreadRef.current = ''
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

function BrowserDebugLog() {
  const entries = useSyncExternalStore(subscribeBrowserDebug, getBrowserDebugSnapshot)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = logRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [entries])

  if (!entries.length) {
    return (
      <div className="browser-panel-debug-empty">（暂无事件，触发浏览器工具后日志会显示在这里）</div>
    )
  }
  const formatTs = (ts: number) => {
    const d = new Date(ts)
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`
  }
  return (
    <div ref={logRef} className="browser-panel-debug-log" role="log" aria-label="Browser debug log">
      {entries.map((entry: BrowserDebugEntry, idx: number) => (
        <div
          key={`${entry.ts}-${idx}`}
          className={`browser-panel-debug-row is-${entry.level}`}
          title={entry.message}
        >
          <span className="browser-panel-debug-ts">{formatTs(entry.ts)}</span>
          <span className="browser-panel-debug-msg">{entry.message}</span>
        </div>
      ))}
    </div>
  )
}

function BrowserLiveCanvas({
  src,
  zoom = 'fit',
  viewport,
  onClickViewport,
  onWheelViewport,
}: {
  src: string
  zoom?: ZoomOption
  viewport?: BrowserViewportSize
  onClickViewport?: (cssX: number, cssY: number) => void
  onWheelViewport?: (deltaX: number, deltaY: number) => void
}) {
  const stageRef = useRef<HTMLDivElement>(null)
  // Image natural dimensions are device pixels; we render at 1:1 and scale via CSS.
  // The screen→viewport mapping uses the page's actual viewport (window.innerWidth/Height)
  // captured in `viewport` prop, which mirrors the browser engine's viewport size.
  const viewportRef = useRef<HTMLDivElement>(null)

  useStageWheelPassthrough(stageRef, onWheelViewport)

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!onClickViewport) return
      const stage = stageRef.current
      if (!stage) return
      const rect = stage.getBoundingClientRect()
      const vw = viewport?.width || DEFAULT_BROWSER_VIEWPORT.width
      const vh = viewport?.height || DEFAULT_BROWSER_VIEWPORT.height
      if (rect.width <= 0 || rect.height <= 0) return
      // Map client coords → viewport CSS px (same coordinate system the agent uses).
      const cssX = Math.max(0, Math.min(vw, ((event.clientX - rect.left) / rect.width) * vw))
      const cssY = Math.max(0, Math.min(vh, ((event.clientY - rect.top) / rect.height) * vh))
      onClickViewport(cssX, cssY)
    },
    [onClickViewport, viewport],
  )

  const zoomStyle =
    zoom === 'fit'
      ? undefined
      : ({ ['--browser-panel-zoom' as string]: String(Number(zoom) / 100) } as React.CSSProperties)

  // Browser-native decoding via <img>. Bypass the Canvas 2D middle-man: the
  // browser draws the JPEG straight to the GPU on layout. 3-5x lower paint
  // cost than the previous drawImage path, plus we keep DOM events (click) live.
  return (
    <div
      ref={stageRef}
      className={`browser-panel-stage browser-panel-stage-live browser-panel-stage-fit${
        zoom !== 'fit' ? ' is-zoomed' : ''
      }`}
      style={zoomStyle}
      onClick={onClickViewport ? handleClick : undefined}
      role={onClickViewport ? 'button' : undefined}
      aria-label={onClickViewport ? 'Live browser viewport — click to interact' : undefined}
    >
      <div ref={viewportRef} className="browser-panel-live-img-wrap">
        {src ? <img src={src} alt="" draggable={false} className="browser-panel-live-img" /> : null}
      </div>
    </div>
  )
}

/** 画布滚轮穿透：滚轮滚动 agent 页面（原生非 passive 监听，150ms 节流）。 */
function useStageWheelPassthrough(
  stageRef: RefObject<HTMLDivElement | null>,
  onWheelViewport: ((deltaX: number, deltaY: number) => void) | undefined,
) {
  const lastSentRef = useRef(0)
  useEffect(() => {
    const stage = stageRef.current
    if (!stage || !onWheelViewport) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const now = Date.now()
      if (now - lastSentRef.current < 150) return
      lastSentRef.current = now
      onWheelViewport(event.deltaX, event.deltaY)
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [stageRef, onWheelViewport])
}

function BrowserLiveViewer({
  streamPath,
  isOpen,
  refreshNonce,
  onStatusChange,
  onFrameMeta,
  viewport,
  zoom,
  onClickViewport,
  onWheelViewport,
  onStreamError,
  disabled = false,
}: {
  streamPath: string
  isOpen: boolean
  refreshNonce?: number
  onStatusChange: (status: BrowserStreamStatus) => void
  onFrameMeta?: (meta: import('../../lib/browser-stream-client.js').BrowserStreamFrameMetadata | undefined) => void
  viewport?: BrowserViewportSize
  zoom?: ZoomOption
  onClickViewport?: (cssX: number, cssY: number) => void
  onWheelViewport?: (deltaX: number, deltaY: number) => void
  onStreamError?: (message: string) => void
  /** The embedded WebView2 owns the surface: never open the screencast socket. */
  disabled?: boolean
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
    // The embedded WebView2 *is* the browser the user is looking at; the agent
    // drives it over CDP. Also opening the screencast socket would spawn a second,
    // private Chromium in the backend and stream frames from a page nobody can see
    // (status=live with frames=0 forever). Exactly one surface per panel.
    if (disabled || !isOpen || !streamPath) {
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
      onFrame: (dataUrl, meta) => {
        if (streamPathRef.current !== streamPath) return
        void (async () => {
          if (hasFrameRef.current && (await isMostlyBlankImage(dataUrl))) return
          hasFrameRef.current = true
          lastFrameRef.current = dataUrl
          setFrameSrc(dataUrl)
          setDisplaySrc(dataUrl)
          if (meta) onFrameMeta?.(meta)
          applyStatus('live')
        })()
      },
      onStatus: (next) => {
        if (streamPathRef.current !== streamPath) return
        applyStatus(next)
      },
      onError: (message?: string) => {
        if (streamPathRef.current !== streamPath) return
        if (message) onStreamError?.(message)
        if (!hasFrameRef.current) applyStatus('error')
        else applyStatus('reconnecting')
      },
    })

    return () => {
      disconnect()
    }
  }, [isOpen, streamPath, refreshNonce, applyStatus, disabled])

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
      <BrowserLiveCanvas
        src={displaySrc}
        zoom={zoom}
        viewport={viewport}
        onClickViewport={onClickViewport}
        onWheelViewport={onWheelViewport}
      />
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
  browserMode?: 'evopanel' | 'headed' | 'cdp' | 'headless' | 'embed'
  onClose: () => void
  /**
   * 当右栏外壳切换到非浏览器 surface（工作流 / 思维导图 / 工作区等）时，
   * 通过 bodySlot 注入替代内容，浏览器 chrome + page-tabs 自动隐藏，
   * BrowserStageTabstrip 仍保留作为顶层切换条。
   */
  bodySlot?: ReactNode | ((activeKind: string) => ReactNode)
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
  bodySlot,
}: BrowserPanelProps) {
  const runtime = useSyncExternalStore(subscribeBrowserRuntime, getBrowserRuntimeSnapshot)
  // Props win when a parent provides them; runtime store feeds the standalone right-stage mount.
  const effectivePageUrl = String(pageUrl || runtime.pageUrl || '').trim() || undefined
  const effectiveThreadId = String(streamThreadId || runtime.streamThreadId || '').trim()
  const effectiveMode = browserMode || runtime.browserMode
  const effectiveShared = sharedBrowser || runtime.sharedBrowser
  const operating = runtime.operating
  const [zoom, setZoom] = useState<ZoomOption>('fit')
  const [streamStatus, setStreamStatus] = useState<BrowserStreamStatus>('idle')
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [refreshBusy, setRefreshBusy] = useState(false)
  // Seeded synchronously: the Tauri marker is already on `window` at first render,
  // so the very first commit already knows whether an embedded WebView2 is the
  // surface. Starting at `false` would let the screencast socket open for one
  // render before the async probe resolves.
  const [embedSupported, setEmbedSupported] = useState(() => browserEmbedSupportedSync())
  const [embedReady, setEmbedReady] = useState(false)
  const [embedFailed, setEmbedFailed] = useState(false)
  const [viewport, setViewport] = useState<BrowserViewportSize | undefined>(undefined)
  const [viewportBusy, setViewportBusy] = useState(false)
  const [activePreset, setActivePreset] = useState<BrowserViewportPresetId>('desktop')
  const [debugOpen, setDebugOpen] = useState(false)
  const lastStreamKickRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    // Second confirmation of the synchronous seed: `__TAURI_INTERNALS__` can
    // appear a tick late when the app boots straight into a chat route. Only
    // ever upgrade to `true` here — never downgrade, or a slow probe would
    // re-open the screencast on a surface that already picked the webview.
    void browserEmbedSupported().then((ok) => {
      if (!cancelled && ok) setEmbedSupported(true)
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
  }, [isOpen, effectiveThreadId])

  const preferEmbeddedBrowser = embedSupported && Boolean(effectiveThreadId)
  // While the embed is mounting there is nothing else worth showing, so the host
  // renders as soon as the path is viable. `embedReady` only gates the *screencast
  // fallback*, never the embed host itself — gating the host on it would deadlock:
  // the flag can only be set by a host that already mounted.
  const useEmbeddedBrowser = preferEmbeddedBrowser && !embedFailed
  const streamPath = useMemo(() => {
    const direct = String(liveStreamUrl || '').trim()
    if (direct) return direct
    const tid = effectiveThreadId
    if (!tid) return ''
    return buildBrowserStreamPath(tid)
  }, [liveStreamUrl, effectiveThreadId])

  const handleRefresh = useCallback(async () => {
    if (refreshBusy || !streamPath) return
    dbgLog(`[browser-panel] refresh thread=${effectiveThreadId}`)
    setRefreshBusy(true)
    setStreamStatus((prev) => (prev === 'live' ? 'reconnecting' : prev))
    const tid = effectiveThreadId
    if (tid) {
      try {
        await restartBrowserStream(tid)
      } catch (err) {
        dbgWarn(`[browser-panel] refresh restart failed ${String(err)}`)
      }
    }
    setRefreshNonce((n) => n + 1)
    setRefreshBusy(false)
  }, [refreshBusy, streamPath, effectiveThreadId])

  // Frame metadata keeps the click overlay mapped to current viewport CSS px.
  const handleFrameMeta = useCallback(
    (meta: import('../../lib/browser-stream-client.js').BrowserStreamFrameMetadata | undefined) => {
      if (!meta) return
      if (typeof meta.deviceWidth === 'number' && typeof meta.deviceHeight === 'number') {
        setViewport({ width: meta.deviceWidth, height: meta.deviceHeight })
      }
    },
    [],
  )

  const applyViewport = useCallback(
    async (size: BrowserViewportSize, presetId: BrowserViewportPresetId) => {
      if (viewportBusy) return
      const tid = effectiveThreadId
      if (!tid) return
      dbgLog(
        `[browser-panel] applyViewport thread=${tid} preset=${presetId} ${size.width}x${size.height}`,
      )
      setViewportBusy(true)
      setActivePreset(presetId)
      try {
        const ok = await setBrowserViewport(tid, size)
        dbgLog(`[browser-panel] applyViewport ok=${ok}`)
        if (ok) setViewport(size)
      } finally {
        setViewportBusy(false)
      }
    },
    [effectiveThreadId, viewportBusy],
  )

  // 画布滚轮穿透：把滚轮增量转发给 agent 页面（引擎 scroll），150ms 节流
  const wheelThrottleRef = useRef(0)
  const handleWheelViewport = useCallback(
    (deltaX: number, deltaY: number) => {
      const tid = effectiveThreadId
      if (!tid) return
      const now = Date.now()
      if (now - wheelThrottleRef.current < 150) return
      wheelThrottleRef.current = now
      void scrollBrowserBy(tid, deltaX, deltaY)
    },
    [effectiveThreadId],
  )

  const [navBusy, setNavBusy] = useState(false)
  const [navError, setNavError] = useState('')
  const handleNavigate = useCallback(
    async (url: string) => {
      const tid = effectiveThreadId
      if (navBusy) return
      if (!tid) {
        // No engine session yet. The address bar is wired to the active chat
        // session's browser engine, so the user must either (a) ask the agent
        // to open a page or (b) wait for one to appear. Without that, any
        // navigation we POST will 503.
        setNavError(
          '浏览器会话未启动：请先在聊天中让 agent 打开一个页面，地址栏会随后可用。',
        )
        dbgLog('[browser-panel] navigate aborted: no effectiveThreadId')
        return
      }
      setNavBusy(true)
      setNavError('')
      try {
        console.error(`[nav] === START tid=${tid} url=${url}`)
        let info
        try {
          info = await browserEmbedUpsert({
            threadId: tid,
            url,
            x: 0,
            y: 0,
            width: 1280,
            height: 720,
          })
        } catch (err) {
          console.error(`[nav] browserEmbedUpsert THREW: ${String(err)}`)
          setNavBusy(false)
          setNavError(`导航异常：${String(err)}`)
          return
        }
        console.error(`[nav] browserEmbedUpsert OK cdpUrl=${info?.cdpUrl || 'MISSING'}`)
        if (!info?.cdpUrl) {
          console.error(`[nav] FAIL: no cdpUrl`)
          setNavError(`导航失败：浏览器会话未建立（thread=${tid.slice(0, 8)}）。可点击工具栏的 ⟳ 重试。`)
          return
        }
        const navUrl = url.startsWith('http') ? url : 'https://' + url
        console.error(`[nav] browserEmbedUpsert done, url=${navUrl} — applying result directly`)

        applyBrowserCommandResponse({
          threadId: tid,
          pageUrl: navUrl,
          pageTitle: '',
          streamWs: '',
        })

        console.error(`[nav] === DONE`)
      } finally {
        setNavBusy(false)
      }
    },
    [effectiveThreadId, navBusy],
  )
  const handleBack = useCallback(async () => {
    const tid = effectiveThreadId
    if (!tid || navBusy) return
    setNavBusy(true)
    try {
      const result = await sendBrowserCommand(tid, 'back')
      if (result) {
        applyBrowserCommandResponse({
          threadId: result.threadId || tid,
          pageUrl: result.pageUrl,
          pageTitle: result.pageTitle,
          streamWs: result.streamWs,
        })
      }
    } finally {
      setNavBusy(false)
    }
  }, [effectiveThreadId, navBusy])
  const handleForward = useCallback(async () => {
    const tid = effectiveThreadId
    if (!tid || navBusy) return
    setNavBusy(true)
    try {
      const result = await sendBrowserCommand(tid, 'forward')
      if (result) {
        applyBrowserCommandResponse({
          threadId: result.threadId || tid,
          pageUrl: result.pageUrl,
          pageTitle: result.pageTitle,
          streamWs: result.streamWs,
        })
      }
    } finally {
      setNavBusy(false)
    }
  }, [effectiveThreadId, navBusy])

  // 引擎标签页轮询：面板打开时拉取（含 agent 工具引起的页面变化），3s 节流。
  //
  // A failing tabList is NOT exceptional — the embed CDP path can be
  // unavailable for stretches (before the WebView registers, after it is torn
  // down). It must not be loud: a fixed 3s interval against a broken endpoint
  // produces an endless 500 stream that buries real signals, and the panel
  // silently keeps a stale tab list. Back off to 15s while failing, restore 3s
  // once it recovers, and log each state transition exactly once instead of
  // once per tick.
  useEffect(() => {
    const tid = effectiveThreadId
    if (!isOpen || !tid) {
      setBrowserTabs([])
      return
    }
    let cancelled = false
    let timer = 0
    let failStreak = 0
    let loggedDown = false
    const PULL_OK_MS = 3000
    const PULL_DOWN_MS = 15000
    const pull = async () => {
      if (cancelled) return
      const res = await listBrowserTabs(tid)
      if (cancelled) return
      if (res?.ok) {
        setBrowserTabs(res.tabs)
        if (loggedDown) {
          dbgLog('[browser-panel] tabList recovered')
          loggedDown = false
        }
        failStreak = 0
        schedule(PULL_OK_MS)
        return
      }
      // Keep the last good list so the tabstrip does not flicker to empty on
      // a transient failure; only a confirmed empty result clears it.
      failStreak += 1
      if (!loggedDown) {
        dbgWarn(
          `[browser-panel] tabList failing tid=${tid} — backing off to ${PULL_DOWN_MS / 1000}s ` +
            '(backend 500; see "browser_tabs_list FAILED" in the gateway log for the cause)',
        )
        loggedDown = true
      }
      schedule(Math.min(PULL_DOWN_MS, PULL_OK_MS * Math.min(failStreak, 5)))
    }
    const schedule = (ms: number) => {
      timer = window.setTimeout(() => void pull(), ms)
    }
    void pull()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [isOpen, effectiveThreadId, refreshNonce])

  const [streamError, setStreamError] = useState('')
  const handleStreamError = useCallback((message: string) => {
    setStreamError(String(message || '').trim())
  }, [])

  const handleSelectTab = useCallback(
    async (index: number) => {
      const tid = effectiveThreadId
      if (!tid) return
      if (await selectBrowserTab(tid, index)) {
        applyBrowserCommandResponse({ threadId: tid })
        setRefreshNonce((n) => n + 1)
      }
    },
    [effectiveThreadId],
  )
  const handleNewTab = useCallback(async () => {
    const tid = effectiveThreadId
    if (!tid) return
    const result = await newBrowserTab(tid)
    if (result) {
      applyBrowserCommandResponse({
        threadId: result.threadId || tid,
        pageUrl: result.pageUrl,
        pageTitle: result.pageTitle,
        streamWs: result.streamWs,
      })
      setRefreshNonce((n) => n + 1)
    }
  }, [effectiveThreadId])
  const handleCloseTab = useCallback(
    async (index: number) => {
      const tid = effectiveThreadId
      if (!tid) return
      if (await closeBrowserTab(tid, index)) setRefreshNonce((n) => n + 1)
    },
    [effectiveThreadId],
  )

  // Tab bar: search overlay + drag-to-reorder. `tabDisplayOrder` maps display
  // position -> engine tab index, so a reorder survives new tabs being appended.
  const [tabSearchOpen, setTabSearchOpen] = useState(false)
  const [tabDisplayOrder, setTabDisplayOrder] = useState<number[]>([])
  const dragTabRef = useRef<number | null>(null)
  useEffect(() => {
    // Reset the order when the engine tab count changes; a stale order would
    // point at tabs that no longer exist.
    setTabDisplayOrder((prev) => (prev.length === runtime.tabs.length ? prev : []))
  }, [runtime.tabs.length])
  const handleTabDragStart = useCallback((engineIndex: number) => {
    dragTabRef.current = engineIndex
  }, [])
  const handleTabDragOver = useCallback(
    (targetEngineIndex: number) => {
      const from = dragTabRef.current
      if (from == null || from === targetEngineIndex) return
      setTabDisplayOrder((prev) => {
        const base =
          prev.length === runtime.tabs.length && prev.every((i) => i >= 0 && i < runtime.tabs.length)
            ? [...prev]
            : Array.from({ length: runtime.tabs.length }, (_, i) => i)
        const fromPos = base.indexOf(from)
        const toPos = base.indexOf(targetEngineIndex)
        if (fromPos < 0 || toPos < 0) return prev
        base.splice(fromPos, 1)
        base.splice(toPos, 0, from)
        return base
      })
    },
    [runtime.tabs],
  )
  const handleTabDrop = useCallback(() => {
    dragTabRef.current = null
  }, [])

  const tabTitle = useMemo(() => {
    const raw = String(pageUrl || '').trim()
    if (!raw) return '浏览器'
    try {
      return new URL(raw).hostname || '浏览器'
    } catch {
      return raw.slice(0, 40) || '浏览器'
    }
  }, [pageUrl])

  const tabsForRender = useMemo(() => {
    const n = runtime.tabs.length
    if (n <= 0) {
      return [{ engineIndex: -1, tab: { url: pageUrl || '', title: tabTitle } }]
    }
    const order =
      tabDisplayOrder.length === n && tabDisplayOrder.every((i) => i >= 0 && i < n)
        ? tabDisplayOrder
        : Array.from({ length: n }, (_, i) => i)
    return order.map((engineIndex) => ({ engineIndex, tab: runtime.tabs[engineIndex] }))
  }, [runtime.tabs, tabDisplayOrder, pageUrl, tabTitle])

  // Stable identities for BrowserEmbedHost. Inline arrows here would be new
  // references on every parent render, and since `mount()` is keyed on
  // onReady/onFailed, each re-render would cancel the in-flight mount (via the
  // effect cleanup) and start a fresh one. `mount()` awaits ~2.4s of rAF frames
  // for layout, so it would be cancelled before it ever reached the upsert call
  // and the embed would never become ready.
  const handleEmbedReady = useCallback(() => setEmbedReady(true), [])
  const handleEmbedFailed = useCallback(() => setEmbedFailed(true), [])

  const handleViewportClick = useCallback(
    async (cssX: number, cssY: number) => {
      const tid = effectiveThreadId
      if (!tid) return
      dbgLog(
        `[browser-panel] click thread=${tid} viewport=(${viewport?.width},${viewport?.height}) click=(${cssX.toFixed(0)},${cssY.toFixed(0)})`,
      )
      // Fire-and-forget: live frames update naturally via CDP screencast.
      void clickBrowserAt(tid, { x: cssX, y: cssY })
    },
    [effectiveThreadId, viewport],
  )

  // Screenshot completed — reconnect WS only (no restart API; backend already restored stream).
  useEffect(() => {
    if (!isOpen || !streamKickNonce || streamKickNonce === lastStreamKickRef.current) return
    lastStreamKickRef.current = streamKickNonce
    setStreamStatus((prev) => (prev === 'live' ? 'reconnecting' : prev))
    setRefreshNonce((n) => n + 1)
  }, [streamKickNonce, isOpen])

  // The screencast fallback must stay out of the way the entire time the
  // embedded webview is the intended surface — not merely while it boots.
  //
  // `embedReady` flips as soon as the CDP endpoint registers, which happens
  // while the page is still blank. Gating only on "not ready yet" (the old
  // `!embedReady && !embedFailed`) made `hasStream` revive the moment the
  // channel came up, so BrowserLiveViewer seized the stage and the embed host
  // never mounted. `streamPath` is non-empty in embed mode too (the backend
  // always advertises stream_ws), which is what triggered it.
  //
  // The surface is chosen by intent, not by readiness: as soon as the embed
  // path is viable and has not failed, it owns the stage. The WS is closed
  // there, so the two surfaces can never both draw.
  const embedPending = preferEmbeddedBrowser && !embedFailed
  const hasStream = Boolean(streamPath) && !embedPending
  const embedThreadId = effectiveThreadId
  // Surface-selection diagnostic. The three surfaces are mutually exclusive and
  // picking the wrong one fails silently (blank stage, no error anywhere), so
  // log the decision inputs whenever they change rather than after the fact.
  useEffect(() => {
    dbgLog(
      `[browser-panel] surface embedSupported=${embedSupported} threadId=${effectiveThreadId || '(empty)'} ` +
        `preferEmbed=${preferEmbeddedBrowser} embedReady=${embedReady} embedFailed=${embedFailed} ` +
        `hasStream=${hasStream} mode=${effectiveMode || '(none)'}`,
    )
  }, [embedSupported, effectiveThreadId, preferEmbeddedBrowser, embedReady, embedFailed, hasStream, effectiveMode])
  // 'evopanel' = in-process Playwright engine. Browser lives in EvoPanel — there
  // is no separate desktop Chrome window to switch to, so suppress the "Chrome
  // opened on your desktop" hint. Only legacy `headed` / external `cdp` paths
  // keep that copy.
  const isExternalShared = effectiveMode === 'headed' || effectiveMode === 'cdp'
  const showSharedBrowserHint =
    !useEmbeddedBrowser &&
    !preferEmbeddedBrowser &&
    effectiveMode !== 'embed' &&
    effectiveMode !== 'evopanel' &&
    (effectiveShared || isExternalShared)
  const sharedBrowserHint =
    effectiveMode === 'cdp'
      ? '已连接你本机的 Chrome，请直接在那个窗口操作（与 Agent 共用同一浏览器）。'
      : 'Chrome 已在桌面打开，请直接在那个窗口操作（与 Agent 共用同一浏览器）。'
  const showStreamPreviewLabel = showSharedBrowserHint && hasStream
  const zoomVisible = hasStream && !useEmbeddedBrowser

  // 当前激活的 surface kind —— BrowserPanel 现在是右栏外壳，
  // body 根据 kind 切换：browser → webview/流，其他 kind → ChatApp 注入的 bodySlot。
  const activeKind = useSyncExternalStore(
    (cb) => rightStageStore.subscribe(cb),
    () => normalizeRightStageKind(String(rightStageStore.getSnapshot().surface?.kind || '')),
  )
  const isBrowserSurface = activeKind === 'browser'
  const overrideBody =
    !isBrowserSurface && bodySlot
      ? typeof bodySlot === 'function'
        ? bodySlot(activeKind)
        : bodySlot
      : null

  // 统一标签页列表：浏览器 home chip 永远在最左，surface tabs 紧随其后，浏览器引擎页面排在右。
  // 「切 surface」等价于「切标签页」——同一套 BrowserTabChip 渲染。
  // 浏览器引擎没启动时，web tab 列表为空 —— + / × 都藏起来。
  const surfaceTabs = useMemo(() => {
    const list: SurfaceTabRender[] = []
    // 1) 浏览器 home chip —— 永远在左。代表"浏览器 surface"。它不属于 web tab 列表。
    list.push({
      key: 'surface-browser',
      kind: 'browser' as const,
      engineIndex: -2, // sentinel: 表示这是 home chip，不是引擎 tab
      title: '浏览器',
      url: '',
      active: isBrowserSurface,
      isHome: true,
    })
    // 2) surface tabs
    list.push({
      key: 'surface-collab-workflow',
      kind: 'collab-workflow' as const,
      engineIndex: -1,
      title: '工作流',
      url: '',
      active: activeKind === 'collab-workflow',
      isSurface: true,
    })
    list.push({
      key: 'surface-mind-map',
      kind: 'mind-map' as const,
      engineIndex: -1,
      title: '思维导图',
      url: '',
      active: activeKind === 'mind-map',
      isSurface: true,
    })
    // 3) 浏览器引擎里的 web tabs —— 只有引擎活跃（有 stream / embedded）时才显示。
    if (hasStream) {
      tabsForRender.forEach(({ engineIndex, tab }) => {
        list.push({
          key: `ws-tab-${engineIndex}`,
          kind: 'browser' as const,
          engineIndex,
          title: tab.title || tab.url || '新标签页',
          url: tab.url || '',
          active: engineIndex < 0 ? false : Boolean(runtime.tabs[engineIndex]?.active),
        })
      })
    }
    return list
  }, [tabsForRender, runtime.tabs, activeKind, isBrowserSurface, hasStream])

  const handleSelectSurface = useCallback(
    (kind: 'browser' | 'collab-workflow' | 'mind-map') => {
      if (kind === 'browser') {
        rightStageStore.show({ kind: 'browser', id: 'primary', title: '浏览器', layout: 'wide', data: {} })
        return
      }
      const title = kind === 'collab-workflow' ? '工作流' : '思维导图'
      rightStageStore.show({ kind, id: 'primary', title, layout: 'wide', data: {} })
    },
    [],
  )

  return (
    <aside
      className={`react-chat-collab-exec-panel react-chat-right-stage-panel react-chat-browser-panel${
        operating ? ' is-agent-operating' : ''
      }${isBrowserSurface ? ' is-browser-surface' : ' is-override-surface'}`}
      role="region"
      aria-label="Browser"
    >
      {/* 唯一一行标签条 —— 一套机制：所有标签页（surface + 浏览器内多个页面）都通过 BrowserTabChip 渲染。 */}
      <div className="browser-panel-subtabs" role="tablist" aria-label="标签页">
        <button
          type="button"
          className={`browser-panel-tb-btn${tabSearchOpen ? ' is-pressed' : ''}`}
          data-tauri-no-drag
          title="搜索标签页"
          aria-label="搜索标签页"
          aria-haspopup="menu"
          aria-expanded={tabSearchOpen}
          onClick={() => setTabSearchOpen((v) => !v)}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m7 6 5 5 5-5" /><path d="m7 13 5 5 5-5" /></svg>
        </button>

        {surfaceTabs.map((surfaceTab) => (
          <SurfaceTabChip
            key={surfaceTab.key}
            tab={surfaceTab}
            onSelect={(kind) => handleSelectSurface(kind)}
            onClose={(kind) => {
              if (kind === 'browser') {
                // 关闭浏览器 surface 不允许（必须切换到另一个 surface）
                return
              }
              // 关闭工作流/思维导图 surface = 切回浏览器
              rightStageStore.show({ kind: 'browser', id: 'primary', title: '浏览器', layout: 'wide', data: {} })
            }}
            onCloseWebTab={(engineIndex) => void handleCloseTab(engineIndex)}
            onSelectWebTab={(engineIndex) => void handleSelectTab(engineIndex)}
            onDragStartChip={handleTabDragStart}
            onDragOverChip={handleTabDragOver}
            onDropChip={handleTabDrop}
          />
        ))}

        {hasStream ? (
          <button
            type="button"
            className="browser-panel-tb-btn"
            title="新建浏览器标签页"
            aria-label="新建浏览器标签页"
            onClick={() => void handleNewTab()}
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden><path d="M5 12h14" /><path d="M12 5v14" /></svg>
          </button>
        ) : null}

        <span className="browser-panel-tabstrip-spring" aria-hidden="true"></span>

        <button
          type="button"
          className="browser-panel-tb-btn"
          data-tauri-no-drag
          title="收起侧栏面板"
          aria-label="收起侧栏面板"
          onClick={onClose}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M15 3v18" />
            <path d="m8 9 3 3-3 3" />
          </svg>
        </button>
      </div>

      {/* chrome —— 仅浏览器 surface 渲染。其它 surface body 不渲染 chrome，避免空地址栏。 */}
      {isBrowserSurface ? (
        <BrowserChromeBar
          pageUrl={effectivePageUrl}
          streamStatus={useEmbeddedBrowser ? 'live' : streamStatus}
          refreshBusy={refreshBusy}
          canRefresh={hasStream}
          zoom={zoom}
          zoomVisible={zoomVisible}
          viewportBusy={viewportBusy}
          activePreset={activePreset}
          onPresetChange={(id, size) => void applyViewport(size, id)}
          viewport={viewport}
          onViewportSizeChange={(size) => void applyViewport(size, 'custom')}
          onNavigate={(url) => void handleNavigate(url)}
          onBack={() => void handleBack()}
          onForward={() => void handleForward()}
          navBusy={navBusy}
          onZoomChange={setZoom}
          onRefresh={() => void handleRefresh()}
          onClose={onClose}
          debugOpen={debugOpen}
          onToggleDebug={() => {
            setDebugOpen((prev) => {
              const next = !prev
              if (next) dbgLog('[browser-panel] debug log opened')
              return next
            })
          }}
        />
      ) : null}
      {navError ? (
        <div className="browser-panel-nav-error" role="alert">
          <span className="browser-panel-nav-error-text">{navError}</span>
          <button
            type="button"
            className="browser-panel-tb-btn"
            onClick={() => setNavError('')}
            title="关闭提示"
            aria-label="关闭提示"
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
      ) : null}
      {tabSearchOpen ? (
        <>
          <div className="browser-panel-menu-backdrop" onClick={() => setTabSearchOpen(false)} aria-hidden="true"></div>
          <div className="browser-panel-menu browser-panel-tabsearch" role="menu" aria-label="标签页列表">
            <div className="browser-panel-menu-title">打开的标签页</div>
            {surfaceTabs.map((surfaceTab) => (
              <button
                key={surfaceTab.key}
                type="button"
                className={`browser-panel-menu-item${surfaceTab.active ? ' is-active' : ''}`}
                onClick={() => {
                  if (surfaceTab.isHome) {
                    handleSelectSurface('browser')
                  } else if (surfaceTab.isSurface) {
                    handleSelectSurface(surfaceTab.kind)
                  } else if (surfaceTab.engineIndex >= 0) {
                    void handleSelectTab(surfaceTab.engineIndex)
                  }
                  setTabSearchOpen(false)
                }}
              >
                <span className="browser-panel-menu-item-label">{surfaceTab.title}</span>
                <span className="browser-panel-menu-item-hint">
                  {surfaceTab.isHome
                    ? '当前会话的浏览器主页'
                    : surfaceTab.isSurface
                      ? surfaceTab.kind === 'collab-workflow'
                        ? '节点工作流视图'
                        : '思维导图视图'
                      : surfaceTab.url
                        ? new URL(surfaceTab.url).hostname
                        : ''}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}

      {overrideBody ? (
        <div className="react-chat-collab-exec-panel-body browser-panel-body browser-panel-body-override">
          {overrideBody}
        </div>
      ) : null}
      {!overrideBody ? (
      <div className="react-chat-collab-exec-panel-body browser-panel-body browser-panel-body-live">
        {showSharedBrowserHint ? (
          <div className="browser-panel-shared-hint" role="status">
            <BrowserPanelIcon className="browser-panel-shared-hint-icon" />
            <p className="browser-panel-shared-hint-text">{sharedBrowserHint}</p>
          </div>
        ) : null}
        {hasStream ? (
          <div className={`browser-panel-live-host${showStreamPreviewLabel ? ' is-preview' : ''}`}>
            {showStreamPreviewLabel ? <div className="browser-panel-preview-label">侧栏预览</div> : null}
            {operating ? (
              <div className="browser-panel-op-float" role="status">
                <span className="browser-panel-op-dot" aria-hidden="true"></span>
                Agent 正在操作浏览器…
              </div>
            ) : null}
            {streamError && streamStatus !== 'live' ? (
              <div className="browser-panel-stream-notice is-error" role="alert">
                <p className="browser-panel-stream-notice-msg">{streamError}</p>
                <button type="button" className="browser-panel-viewport-btn" onClick={() => { setStreamError(''); void handleRefresh() }}>
                  重试
                </button>
              </div>
            ) : streamStatus === 'connecting' || streamStatus === 'reconnecting' ? (
              <div className="browser-panel-stream-notice" role="status">
                <LiveSpinner />
                <span>正在等待浏览器会话…（agent 首次打开页面后自动接入）</span>
              </div>
            ) : streamStatus === 'live' && !runtime.lastFrameMeta ? (
              /* WS connected but the engine never produced a frame. Almost always
                 means the stream is bound to the wrong thread id. */
              <div className="browser-panel-stream-notice is-stale" role="status">
                <p className="browser-panel-stream-notice-msg">
                  已连接视频流，但引擎还没有送出画面。
                </p>
                <p className="browser-panel-stream-notice-hint">
                  thread=<code>{effectiveThreadId || '(空)'}</code> · status=live · frames=0
                </p>
                <button
                  type="button"
                  className="browser-panel-viewport-btn"
                  onClick={() => { setStreamError(''); void handleRefresh() }}
                >
                  重连
                </button>
              </div>
            ) : null}
            <BrowserLiveViewer
              streamPath={streamPath}
              isOpen={isOpen}
              refreshNonce={refreshNonce}
              onStatusChange={setStreamStatus}
              onFrameMeta={handleFrameMeta}
              viewport={viewport}
              zoom={zoom}
              onClickViewport={effectiveThreadId ? handleViewportClick : undefined}
              onWheelViewport={effectiveThreadId ? handleWheelViewport : undefined}
              onStreamError={handleStreamError}
              disabled={preferEmbeddedBrowser}
            />
          </div>
        ) : preferEmbeddedBrowser && embedThreadId && !embedFailed ? (
          <BrowserEmbedHost
            isOpen={isOpen}
            threadId={embedThreadId}
            pageUrl={effectivePageUrl}
            onReady={handleEmbedReady}
            onFailed={handleEmbedFailed}
          />
        ) : (
          <div className="browser-panel-stage browser-panel-stage-empty">
            {preferEmbeddedBrowser || hasStream ? <LiveSpinner /> : <BrowserPanelIcon className="browser-panel-stage-icon" />}
          </div>
        )}
        {debugOpen ? (
          <div className="browser-panel-debug-pane" aria-label="Browser debug log panel">
            <div className="browser-panel-debug-toolbar">
              <span className="browser-panel-debug-title">Debug</span>
              <button
                type="button"
                className="browser-panel-debug-clear"
                onClick={() => clearBrowserDebug()}
                title="Clear log"
              >
                清空
              </button>
            </div>
            <BrowserDebugLog />
          </div>
        ) : null}
      </div>
      ) : null}
    </aside>
  )
})

/** ════════════════════════════════════════════════════════════
 *  Toolbar toggle icon — globe / network
 * ════════════════════════════════════════════════════════════ */
export function BrowserToolbarIcon() {
  return <GlobeNetworkIcon />
}
