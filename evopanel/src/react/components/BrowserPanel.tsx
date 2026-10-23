import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import {
  browserEmbedClose,
  browserEmbedExists,
  browserEmbedSetZoom,
  browserEmbedSupported,
  browserEmbedSupportedSync,
  clearBrowserEmbedCdp,
  registerBrowserEmbedCdp,
} from '../../lib/browser-embed-client.js'
import { ensureNativeEmbed, reportEmbedSlot } from '../../lib/browser-embed-surface.js'
import { blogTimeline } from '../../lib/browser-unified-log.js'
import { useGlobalOverlayWhen } from '../hooks/useGlobalOverlayWhen.js'
import { DropdownSelect } from './DropdownSelect.js'
import {
  buildBrowserStreamPath,
  connectBrowserStream,
  restartBrowserStream,
} from '../../lib/browser-stream-client.js'
import {
  clickBrowserAt,
  scrollBrowserBy,
  sendBrowserCommand,
  listBrowserTabs,
  DEFAULT_BROWSER_VIEWPORT,
  setBrowserViewport,
  type BrowserViewportPresetId,
  type BrowserViewportSize,
} from '../../lib/browser-viewport-client.js'
import {
  getBrowserRuntimeSnapshot,
  applyBrowserCommandResponse,
  isUserNavigateIntent,
  markUserNavigateIntent,
  pushBrowserTabHistory,
  setBrowserTabs,
  stepBrowserTabHistory,
  subscribeBrowserRuntime,
} from '../../lib/browser-panel-store.js'
import {
  isBrowserInternalErrorUrl,
  isNavigableBrowserUrl,
  isSameBrowserLoad,
  sanitizeBrowserPageUrl,
} from '../../lib/browser-page-url.js'
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
const ZOOM_OPTIONS = ['fit', '50', '67', '75', '100', '125', '150', '200'] as const
type ZoomOption = (typeof ZOOM_OPTIONS)[number]
const EMBED_ZOOM_STORAGE_KEY = 'evoflow-browser-embed-zoom-v3'
/** 打开时固定 75%，不跟槽位宽窄自动变。 */
const DEFAULT_EMBED_ZOOM: ZoomOption = '75'

function readStoredEmbedZoom(): ZoomOption {
  try {
    const raw = String(localStorage.getItem(EMBED_ZOOM_STORAGE_KEY) || '').trim()
    if ((ZOOM_OPTIONS as readonly string[]).includes(raw)) return raw as ZoomOption
  } catch {
    /* ignore */
  }
  return DEFAULT_EMBED_ZOOM
}

/**
 * 按槽位 CSS 像素估 ZoomFactor。
 * 右栏很窄时压到 ~50%，方便一屏多看；窗口放大、槽位变宽后提到 ~100%。
 */
function fitZoomFromSlot(cssWidth: number, cssHeight: number): number {
  const w = Math.max(0, cssWidth)
  const h = Math.max(0, cssHeight)
  let factor: number
  if (w < 480) factor = 0.5
  else if (w < 620) factor = 0.55
  else if (w < 760) factor = 0.65
  else if (w < 920) factor = 0.8
  else if (w < 1100) factor = 0.9
  else factor = 1.0
  if (h > 0 && h < 400 && factor > 0.55) factor = Math.max(0.5, factor - 0.1)
  if (h >= 720 && w >= 920) factor = Math.min(1.1, factor + 0.05)
  return Math.min(1.25, Math.max(0.5, Math.round(factor * 100) / 100))
}

function embedZoomFactor(zoom: ZoomOption, slotCssWidth = 0, slotCssHeight = 0): number {
  if (zoom === 'fit') return fitZoomFromSlot(slotCssWidth, slotCssHeight)
  const n = Number(zoom)
  if (!Number.isFinite(n) || n <= 0) return fitZoomFromSlot(slotCssWidth, slotCssHeight)
  return Math.min(2.5, Math.max(0.5, n / 100))
}



function formatDisplayUrl(raw: string): string {
  const url = String(raw || '').trim()
  if (!url) return ''
  // about:blank（新标签/空白页）在地址栏里只显示成没头没尾的「blank」，
  // 留空让 placeholder 出来；其它 about: 页同样按无地址处理。
  if (url.startsWith('about:')) return ''
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

/** ZCode BrowserEmptyState：未导航时只显示地球和文字，不转圈。 */
function BrowserEmptyState() {
  return (
    <div className="browser-panel-empty" role="status">
      <div className="browser-panel-empty-inner">
        <GlobeNetworkIcon className="browser-panel-empty-icon" />
        <h3 className="browser-panel-empty-title">浏览器</h3>
        <p className="browser-panel-empty-hint">粘贴或输入 URL 以打开网页。</p>
      </div>
    </div>
  )
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

function BrowserChromeBar({
  pageUrl,
  refreshBusy,
  canRefresh,
  zoom,
  liveZoomPercent,
  zoomVisible,
  viewportBusy,
  viewport,
  onViewportSizeChange,
  onNavigate,
  onBack,
  onForward,
  canGoBack,
  canGoForward,
  navBusy,
  onZoomChange,
  onRefresh,
  isResponsiveMode,
  onToggleResponsiveMode,
  debugOpen,
  onToggleDebug,
}: {
  pageUrl?: string
  refreshBusy?: boolean
  canRefresh?: boolean
  zoom?: ZoomOption
  /** WebView2 当前 ZoomFactor，四舍五入成百分比。有值时下拉框显示它。 */
  liveZoomPercent?: number | null
  zoomVisible?: boolean
  viewportBusy?: boolean
  viewport?: BrowserViewportSize
  onViewportSizeChange?: (size: BrowserViewportSize) => void
  onNavigate?: (url: string) => void
  onBack?: () => void
  onForward?: () => void
  canGoBack?: boolean | null
  canGoForward?: boolean | null
  navBusy?: boolean
  onZoomChange?: (zoom: ZoomOption) => void
  onRefresh?: () => void
  isResponsiveMode?: boolean
  onToggleResponsiveMode?: () => void
  onClose: () => void
  debugOpen?: boolean
  onToggleDebug?: () => void
}) {
  const displayUrl = useMemo(() => formatDisplayUrl(pageUrl || ''), [pageUrl])
  const [urlDraft, setUrlDraft] = useState(displayUrl)
  const [urlEditing, setUrlEditing] = useState(false)
  // 修复：agent 导航后面板地址栏不跟随——pageUrl 变化时同步草稿（用户正在输入时不打断）
  useEffect(() => {
    if (!urlEditing) setUrlDraft(displayUrl)
  }, [displayUrl, urlEditing])
  const [moreOpen, setMoreOpen] = useState(false)
  // 原生 WebView2 盖在 HTML 之上，菜单打开时必须藏 HWND，否则下拉被网页挡住。
  useGlobalOverlayWhen(moreOpen, 'browser-chrome-more')
  const [dimWidth, setDimWidth] = useState<string>(
    viewport?.width ? String(viewport.width) : String(DEFAULT_BROWSER_VIEWPORT.width),
  )
  const [dimHeight, setDimHeight] = useState<string>(
    viewport?.height ? String(viewport.height) : String(DEFAULT_BROWSER_VIEWPORT.height),
  )
  useEffect(() => {
    setDimWidth(viewport?.width ? String(viewport.width) : String(DEFAULT_BROWSER_VIEWPORT.width))
    setDimHeight(viewport?.height ? String(viewport.height) : String(DEFAULT_BROWSER_VIEWPORT.height))
  }, [viewport?.width, viewport?.height])
  const commitDims = () => {
    if (!onViewportSizeChange) return
    const w = Math.min(3840, Math.max(320, Number.parseInt(dimWidth || '0', 10) || 0))
    const h = Math.min(2160, Math.max(320, Number.parseInt(dimHeight || '0', 10) || 0))
    if (!w || !h) return
    if (w === viewport?.width && h === viewport?.height) return
    onViewportSizeChange({ width: w, height: h })
  }
  const submitUrl = () => {
    const next = urlDraft.trim()
    if (!next) return
    if (next === (pageUrl || '').trim()) {
      onRefresh?.()
      return
    }
    onNavigate?.(next)
  }

  return (
    <>
      <form
        className="browser-panel-toolbar"
        onSubmit={(e) => {
          e.preventDefault()
          submitUrl()
        }}
      >
        <button
          type="button"
          className="browser-panel-tb-btn"
          title="后退"
          aria-label="后退"
          disabled={navBusy || !onBack || canGoBack === false}
          onClick={() => onBack?.()}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m15 18-6-6 6-6" /></svg>
        </button>
        <button
          type="button"
          className="browser-panel-tb-btn"
          title="前进"
          aria-label="前进"
          disabled={navBusy || !onForward || canGoForward === false}
          onClick={() => onForward?.()}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m9 18 6-6-6-6" /></svg>
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
          onFocus={() => setUrlEditing(true)}
          onBlur={() => setUrlEditing(false)}
          onChange={(e) => setUrlDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.stopPropagation()
              submitUrl()
            } else if (e.key === 'Escape') {
              setUrlDraft(displayUrl)
            }
          }}
        />
        <button type="submit" style={{ display: 'none' }} />
        {zoomVisible || onZoomChange ? (
          <DropdownSelect
            className="browser-panel-zoom-dropdown"
            triggerClassName="browser-panel-zoom"
            variant="pill"
            placement="down"
            portal
            value={
              liveZoomPercent != null && Number.isFinite(liveZoomPercent)
                ? String(liveZoomPercent)
                : zoom || DEFAULT_EMBED_ZOOM
            }
            title="页面缩放，与内嵌网页的实际比例同步。Ctrl+滚轮或捏合也会改这里"
            aria-label="页面缩放"
            options={[
              ...(liveZoomPercent != null &&
              Number.isFinite(liveZoomPercent) &&
              !(ZOOM_OPTIONS as readonly string[]).includes(String(liveZoomPercent))
                ? [{ value: String(liveZoomPercent), label: `${liveZoomPercent}%` }]
                : []),
              ...ZOOM_OPTIONS.map((option) => ({
                value: option,
                label: option === 'fit' ? '适应窗口' : `${option}%`,
              })),
            ]}
            onChange={(raw) => {
              if ((ZOOM_OPTIONS as readonly string[]).includes(raw)) {
                onZoomChange?.(raw as ZoomOption)
              }
            }}
          />
        ) : null}
        <button
          type="button"
          className={`browser-panel-tb-btn${isResponsiveMode ? ' is-pressed is-secondary' : ''}`}
          title={isResponsiveMode ? '退出响应式视口' : '进入响应式视口'}
          aria-label={isResponsiveMode ? '退出响应式视口' : '进入响应式视口'}
          aria-pressed={Boolean(isResponsiveMode)}
          disabled={!onToggleResponsiveMode}
          onClick={() => onToggleResponsiveMode?.()}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8" /><path d="M10 19v-3.96 3.15" /><path d="M7 19h5" /><rect width="6" height="10" x="16" y="12" rx="2" /></svg>
        </button>
        <button
          type="button"
          className="browser-panel-tb-btn"
          title="选择网页元素加入聊天（即将支持）"
          aria-label="选择网页元素加入聊天"
          disabled
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M14 4.1 12 6" /><path d="m5.1 8-2.9-.8" /><path d="m6 12-1.9 2" /><path d="M7.2 2.2 8 5.1" /><path d="M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z" /></svg>
        </button>
        <button
          type="button"
          className={`browser-panel-tb-btn${moreOpen ? ' is-pressed' : ''}`}
          title="更多"
          aria-label="更多"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((v) => !v)}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></svg>
        </button>
        {moreOpen ? (
          <>
            <div className="browser-panel-menu-backdrop" onClick={() => setMoreOpen(false)} aria-hidden="true"></div>
            <div className="browser-panel-menu" role="menu" aria-label="更多浏览器操作">
              {pageUrl && !pageUrl.startsWith('about:') ? (
                <a
                  className="browser-panel-menu-item"
                  href={pageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  role="menuitem"
                  onClick={() => setMoreOpen(false)}
                >
                  <ExternalLinkIcon />
                  在系统浏览器打开
                </a>
              ) : (
                <button type="button" className="browser-panel-menu-item" role="menuitem" disabled>
                  <ExternalLinkIcon />
                  在系统浏览器打开
                </button>
              )}
              {onToggleDebug ? (
                <button
                  type="button"
                  className="browser-panel-menu-item"
                  role="menuitem"
                  aria-pressed={debugOpen}
                  onClick={() => {
                    onToggleDebug()
                    setMoreOpen(false)
                  }}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m8 8-4 4 4 4" /><path d="m16 8 4 4-4 4" /><path d="m13 5-2 14" /></svg>
                  调试日志{debugOpen ? '（开）' : ''}
                </button>
              ) : null}
            </div>
          </>
        ) : null}
      </form>
      {isResponsiveMode ? (
        <div className="browser-panel-toolbar-sub" aria-label="响应式视口">
          <input
            className="browser-panel-viewport-dim"
            inputMode="numeric"
            aria-label="视口宽度"
            value={dimWidth}
            disabled={viewportBusy || !onViewportSizeChange}
            onChange={(e) => setDimWidth(e.target.value.replace(/[^0-9]/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitDims()
              }
            }}
            onBlur={commitDims}
          />
          <span className="browser-panel-viewport-dim-x" aria-hidden>
            ×
          </span>
          <input
            className="browser-panel-viewport-dim"
            inputMode="numeric"
            aria-label="视口高度"
            value={dimHeight}
            disabled={viewportBusy || !onViewportSizeChange}
            onChange={(e) => setDimHeight(e.target.value.replace(/[^0-9]/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitDims()
              }
            }}
            onBlur={commitDims}
          />
        </div>
      ) : null}
    </>
  )
}

let lastRegionLogAt = 0
let lastRegionKey = ''
let lastCoordsConsoleAt = 0
let lastCoordsPhase = ''

/** 主窗标题拖拽区底边。子 HWND 的 y 绝不能小于它，否则双击还原被原生窗吞掉。 */
function chromeFloorY(): number {
  try {
    const nodes = document.querySelectorAll<HTMLElement>('[data-tauri-drag-region]')
    let floor = 0
    nodes.forEach((el) => {
      const b = el.getBoundingClientRect().bottom
      if (b > floor) floor = b
    })
    if (floor >= 24) return Math.ceil(floor)
  } catch {
    /* ignore */
  }
  return 48
}

function readEmbedBounds(el: HTMLElement | null, opts?: { forceRegionLog?: boolean }) {
  if (!el) return null
  const rect = el.getBoundingClientRect()
  if (rect.width < 8 || rect.height < 8) return null
  // 槽位坐标 = getBoundingClientRect，和主窗口客户区同一套像素。
  // 不要再乘 devicePixelRatio。实测 dpr=1.75 时 CSS 槽位已是 (894,97 532x706)，
  // 乘完变成 (1565,169 932x1236)，主客户区只有约 1440x810，窗口被推到主窗口外面。
  const dpr = window.devicePixelRatio || 1
  // 右栏外壳有 1px 左边线，拖拽条还用负边距压进面板约 3px。
  // 原生 HWND 在所有 HTML 之上，贴齐槽位左缘就会盖住这条分隔线。
  // 左侧让出 4px，窗口才和「框定区域」重合，分隔线留在外面。
  const insetLeft = 4
  const floor = chromeFloorY()
  let y = Math.round(rect.top)
  let height = Math.round(rect.height)
  // 顶栏地板：最大化后槽位若顶到标题条，把 y 压下来并缩短高度，保住双击还原。
  if (y < floor) {
    height = Math.max(80, height - (floor - y))
    y = floor
  }
  const bounds = {
    x: Math.round(rect.left) + insetLeft,
    y,
    width: Math.max(120, Math.round(rect.width) - insetLeft),
    height,
    // Rust 用主窗口客户区像素 / 这个视口，把 CSS 槽位换成 SetWindowPos 坐标。
    viewportWidth: Math.round(window.innerWidth || rect.width),
    viewportHeight: Math.round(window.innerHeight || rect.height),
  }
  const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`
  const now = Date.now()
  if (opts?.forceRegionLog || key !== lastRegionKey || now - lastRegionLogAt > 500) {
    lastRegionKey = key
    lastRegionLogAt = now
    const screenLeft = Math.round((window.screenX || 0) + rect.left)
    const screenTop = Math.round((window.screenY || 0) + rect.top)
    const msg =
      `[右侧区域] css=(${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}) ` +
      `screen≈=(${screenLeft},${screenTop} ${bounds.width}x${bounds.height}) ` +
      `dpr=${dpr} viewport=(${bounds.viewportWidth}x${bounds.viewportHeight})`
    dbgLog(`[browser-embed] ${msg}`)
    console.log(msg)
  }
  return bounds
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
  surfaceActive,
  stageId,
  threadId,
  pageUrl,
  onReady,
  onFailed,
}: {
  isOpen: boolean
  /** 右栏当前标签是否是这一页。显隐由 browser-embed-surface 决定，这里只在前台时上报槽位。 */
  surfaceActive: boolean
  stageId: string
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
  const readyRef = useRef(false)

  const surfaceActiveRef = useRef(surfaceActive)
  surfaceActiveRef.current = surfaceActive
  const pageUrlRef = useRef(pageUrl)
  pageUrlRef.current = pageUrl
  const threadIdRef = useRef(threadId)
  threadIdRef.current = threadId
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const onFailedRef = useRef(onFailed)
  onFailedRef.current = onFailed
  const syncBoundsRef = useRef<() => Promise<void>>(async () => {})

  const stageIdRef = useRef(stageId)
  stageIdRef.current = stageId

  const syncBounds = useCallback(async (force = false) => {
    if (!surfaceActiveRef.current || !isOpen) return
    const bounds = readEmbedBounds(slotRef.current)
    if (!bounds) return
    const started = performance.now()
    // Soft-decouple: bounds sync never re-navigates — agent/CDP owns the URL.
    reportEmbedSlot(stageIdRef.current, bounds, { force })
    const elapsed = Math.round(performance.now() - started)
    if (elapsed >= 200) {
      console.warn(
        `[browser-embed] STALL setBounds ${elapsed}ms slot=(${Math.round(bounds.x)},${Math.round(bounds.y)} ${Math.round(bounds.width)}x${Math.round(bounds.height)})`,
      )
    }
  }, [isOpen])
  syncBoundsRef.current = () => syncBounds(true)

  // Shared with mount + navigate effects: avoid remount→navigate double ensure.
  const lastNavigatedRef = useRef('')

  useLayoutEffect(() => {
    let cancelled = false
    const tid = String(threadId || '').trim()
    dbgLog(
      `[browser-embed] effect enter isOpen=${isOpen} tid=${tid || '(empty)'} ` +
        `mountedRef=${mountedThreadRef.current || '(empty)'} ready=${readyRef.current}`,
    )
    if (!isOpen || !tid) {
      requestAnimationFrame(() => {
        if (!cancelled) {
          dbgLog(`[browser-embed] effect idle-reset isOpen=${isOpen} tid=${tid || '(empty)'}`)
          setReady(false)
          readyRef.current = false
          setError('')
        }
      })
      return
    }
    // Already successfully mounted for this thread — do not recreate.
    if (mountedThreadRef.current === tid && readyRef.current) {
      dbgLog(`[browser-embed] effect skip (already ready) tid=${tid}`)
      return
    }
    // In-flight for this thread (Strict Mode / short re-entry): let it finish.
    if (mountedThreadRef.current === tid) {
      dbgLog(`[browser-embed] effect skip (already mounting) tid=${tid}`)
      return
    }
    mountedThreadRef.current = tid
    dbgLog(`[browser-embed] effect start mount tid=${tid}`)

    const failMount = (message: string, userError: string) => {
      if (mountedThreadRef.current === tid) mountedThreadRef.current = ''
      if (cancelled) return
      blogTimeline(
        '失败',
        `窗口贴位失败 线程=${tid} 原因=${message} 界面提示=${userError}`,
      )
      setError(userError)
      onFailedRef.current?.(message)
    }

    const finishReady = () => {
      // HWND already exists after upsert — always claim the slot even if this
      // effect instance was cleaned up (React Strict Mode / prop churn). Leaving
      // ready=false here is what made the 10s iframe steal the surface while
      // CDP kept driving the unmanaged popup.
      setError('')
      setReady(true)
      readyRef.current = true
      blogTimeline(
        '窗口贴位',
        `面板挂载完成 线程=${tid} 地址栏=${pageUrlRef.current || '(无)'}（槽位已显示；真正出字看「页面内容就绪」）`,
      )
      onReadyRef.current?.()
      void syncBoundsRef.current()
      for (const delay of [300, 1000, 3000]) {
        window.setTimeout(() => {
          void syncBoundsRef.current()
        }, delay)
      }
    }

    const mount = async () => {
      // 后台标签也 force-mount，但绝不能抢 HWND（否则新标签 blank 会被旧标签 URL 顶掉）。
      if (!surfaceActiveRef.current) {
        dbgLog(`[browser-embed] effect skip mount (inactive) tid=${tid} stage=${stageIdRef.current}`)
        return
      }
      const supported = await browserEmbedSupported()
      const pageUrlNow = pageUrlRef.current
      dbgLog(`[browser-embed] supported=${supported} tid=${tid} pageUrl=${pageUrlNow || '(none)'}`)
      if (!supported) {
        dbgWarn(`[browser-embed] unsupported in this runtime thread=${tid}`)
        failMount('embed unsupported', '当前环境不支持内嵌浏览器')
        return
      }
      const settleStart = Date.now()
      while (Date.now() - settleStart < 5000) {
        const b = readEmbedBounds(slotRef.current)
        if (b && b.width >= 320 && b.height >= 220) break
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        if (cancelled && !readyRef.current) {
          // Cleared latch below in cleanup; abort before creating a HWND.
          return
        }
        if (!surfaceActiveRef.current) return
      }
      if (!surfaceActiveRef.current) return
      const bounds = await waitForEmbedBounds(slotRef.current)
      if (!bounds) {
        dbgWarn(`[browser-embed] slot has no layout box yet thread=${tid}`)
        failMount('embed bounds unavailable', '浏览器区域尚未就绪')
        return
      }
      const boundsLogged = readEmbedBounds(slotRef.current, { forceRegionLog: true }) || bounds
      // Soft-decouple: mount never navigates. Agent CDP owns Page.navigate;
      // passing url here (when exists-check flaked false) rebuilt HWND mid-settle
      // → guest-poll timeout (~8–17s). Place/create blank only; chrome URL is sync.
      const hwndReady = await browserEmbedExists(tid)
      dbgLog(
        `[browser-embed] upsert thread=${tid} bounds=${JSON.stringify(boundsLogged)} ` +
          `hwndReady=${hwndReady} placeOnly=true url=${pageUrlNow || '(none)'}`,
      )
      // HMR / 冷启动时 create 常超时一次，但 HWND 晚几百 ms 才就绪；一次失败就
      // embedFailed 会逼用户关再开。对齐 Rust late-ok：多试几次再认输。
      let info: Awaited<ReturnType<typeof ensureNativeEmbed>> = null
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (cancelled && !readyRef.current) return
        if (!surfaceActiveRef.current) return
        info = await ensureNativeEmbed({
          placeOnly: true,
          slot: bounds,
          stageId: stageIdRef.current,
          reason: attempt === 1 ? 'panel-mount' : `panel-mount-retry-${attempt}`,
        })
        dbgLog(
          `[browser-embed] upsert done attempt=${attempt} cdpUrl=${info?.cdpUrl ? 'OK' : 'MISSING'} label=${info?.webviewLabel || '-'}`,
        )
        if (info?.cdpUrl) break
        // 超时后窗口可能刚建好：先问 exists，再等一把再 ensure。
        const late = await browserEmbedExists(tid)
        dbgWarn(
          `[browser-embed] upsert miss attempt=${attempt} lateExists=${late} thread=${tid}`,
        )
        if (attempt < 3) {
          await new Promise<void>((r) => window.setTimeout(r, 400 * attempt))
        }
      }
      if (!info?.cdpUrl) {
        dbgWarn(`[browser-embed] upsert returned no cdpUrl thread=${tid} info=${JSON.stringify(info)}`)
        failMount('embed upsert failed', '内嵌浏览器启动失败')
        return
      }
      // Mark current URL so the navigate effect does not immediately re-ensure.
      if (pageUrlNow) lastNavigatedRef.current = pageUrlNow
      dbgLog(`[browser-embed] cdp ready thread=${tid} label=${info.webviewLabel}`)
      const ok = await registerBrowserEmbedCdp(tid, info.cdpUrl)
      dbgLog(`[browser-embed] cdp register ok=${ok} url=${info.cdpUrl.slice(0, 60)}`)
      if (!ok) {
        dbgWarn(`[browser-embed] cdp register rejected by backend thread=${tid}`)
        failMount('embed cdp register failed', '无法注册浏览器 CDP')
        return
      }
      dbgLog(`[browser-embed] ready thread=${tid}`)
      if (!surfaceActiveRef.current) return
      finishReady()
    }

    void mount()
    return () => {
      cancelled = true
      // Drop the "already mounting" latch when ready never arrived, so the next
      // effect run (Strict Mode remount) can retry instead of skipping forever.
      if (!readyRef.current && mountedThreadRef.current === tid) {
        mountedThreadRef.current = ''
        dbgLog(`[browser-embed] effect cleanup cleared mount latch tid=${tid}`)
      }
    }
    // surfaceActive：后台 force-mount 时跳过抢 HWND；切到前台后再真正 upsert。
  }, [isOpen, threadId, surfaceActive])

  // Soft-decouple: pageUrl from agent/getState is chrome-only. HWND navigation
  // is owned by CDP (agent) or explicit user actions (address bar → engine
  // navigate, back/forward / tab switch → ensureNativeEmbed). Never upsert-
  // navigate here — that double-loaded every agent goto.
  useEffect(() => {
    if (!ready) return
    const next = String(pageUrl || '').trim()
    if (!next) return
    if (next === lastNavigatedRef.current || isSameBrowserLoad(next, lastNavigatedRef.current)) {
      lastNavigatedRef.current = next
      return
    }
    if (!isNavigableBrowserUrl(next)) {
      lastNavigatedRef.current = next
      return
    }
    if (isUserNavigateIntent(next)) {
      // User already drove HWND via sendBrowserCommand / ensureNativeEmbed;
      // only sync the latch so we do not treat the next agent sync as new.
      lastNavigatedRef.current = next
      dbgLog(`[browser-embed] pageUrl follow (user intent) url=${next}`)
      return
    }
    lastNavigatedRef.current = next
    dbgLog(`[browser-embed] pageUrl follow (agent/chrome-only) url=${next}`)
  }, [ready, threadId, pageUrl])

  useEffect(() => {
    if (!ready || !isOpen || !surfaceActive) return
    // 切签后槽位可能刚从 hidden 恢复，连贴几次避免和 ensure 竞态丢显影。
    void syncBounds()
    const t1 = window.setTimeout(() => void syncBoundsRef.current(), 50)
    const t2 = window.setTimeout(() => void syncBoundsRef.current(), 200)
    const t3 = window.setTimeout(() => void syncBoundsRef.current(), 500)
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
      window.clearTimeout(t3)
    }
  }, [surfaceActive, ready, isOpen, syncBounds])

  // 显隐不在这里做。browser-embed-surface 看到激活页离开浏览器 id 就会隐藏。
  useEffect(() => {
    const onGate = (ev: Event) => {
      const detail = (ev as CustomEvent<{ show?: boolean; id?: string }>).detail
      if (!detail?.show) return
      if (detail.id && detail.id !== stageIdRef.current) return
      if (!surfaceActiveRef.current) return
      dbgLog(`[browser-embed] gate show id=${detail.id || '(none)'} → sync bounds`)
      void syncBoundsRef.current()
      window.setTimeout(() => void syncBoundsRef.current(), 80)
      window.setTimeout(() => void syncBoundsRef.current(), 250)
    }
    window.addEventListener('browser-embed-gate', onGate)
    return () => window.removeEventListener('browser-embed-gate', onGate)
  }, [])

  useEffect(() => {
    if (!isOpen || !ready || !surfaceActive) return
    // 缩放/布局变化：节流贴位。不要 force——拖动主窗时 RO/resize 若连发 force
    // 会绕过槽位去重打到 SetWindowPos，和 Moved 重入叠在一起整窗卡死。
    // 最大化后布局晚一拍用后面的延迟再贴一次即可。
    let timer = 0
    const schedule = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        void syncBounds()
      }, 120)
    }
    // 小V 侧栏开合/拖宽：#main-col margin 变了但 window.resize 不响；必须 force 贴位，
    // 否则原生 WebView 仍占旧矩形，盖住右侧小V HTML 面板。
    // 节流：dock-open/settle 连发时不要立刻刷 SetWindowPos，避免和 create 抢主线程。
    const onXmDock = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        void syncBoundsRef.current()
      }, 80)
    }
    window.addEventListener('resize', schedule)
    window.addEventListener('evopanel:xm-dock-layout', onXmDock)
    const ro =
      typeof ResizeObserver !== 'undefined' && slotRef.current
        ? new ResizeObserver(() => {
            schedule()
          })
        : null
    if (slotRef.current) ro?.observe(slotRef.current)
    // 最大化切换后布局晚一拍，连贴两次确保顶栏地板生效。
    schedule()
    const t2 = window.setTimeout(schedule, 280)
    return () => {
      window.clearTimeout(timer)
      window.clearTimeout(t2)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('evopanel:xm-dock-layout', onXmDock)
      ro?.disconnect()
    }
  }, [isOpen, ready, surfaceActive, syncBounds])

  // Rust 回传 WebView 实际屏幕矩形 → 控制台对照右侧区域
  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    let unlisten: (() => void) | undefined
    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        if (cancelled) return
        const unlistenStall = await listen<{ message?: string }>('browser-embed-stall', (ev) => {
          const message = String(ev.payload?.message || '')
          if (!message) return
          console.warn(message)
        })
        const unlistenCoords = await listen<{
          phase?: string
          kind?: string
          slotClient?: { x: number; y: number; w: number; h: number }
          webviewScreen?: { x: number; y: number; w: number; h: number }
          expectScreen?: { x: number; y: number; w: number; h: number }
          delta?: { x: number; y: number }
          matchesSlot?: boolean
          fitsClient?: boolean
        }>('browser-embed-coords', (ev) => {
          const p = ev.payload || {}
          const phase = String(p.phase || '')
          const now = Date.now()
          // 拖动主窗口时 follow 很密，控制台节流；贴位/创建立刻打
          if (
            phase.startsWith('follow') &&
            now - lastCoordsConsoleAt < 200 &&
            lastCoordsPhase === phase
          ) {
            return
          }
          lastCoordsConsoleAt = now
          lastCoordsPhase = phase
          const slot = p.slotClient
          const wv = p.webviewScreen
          const exp = p.expectScreen
          const slotMsg = slot
            ? `[右侧区域→传给WebView] client=(${Math.round(slot.x)},${Math.round(slot.y)} ${Math.round(slot.w)}x${Math.round(slot.h)})`
            : '[右侧区域→传给WebView] (无)'
          const wvMsg = wv
            ? `[WebView实际] screen=(${Math.round(wv.x)},${Math.round(wv.y)} ${Math.round(wv.w)}x${Math.round(wv.h)}) kind=${p.kind || '?'} phase=${phase || '?'}`
            : '[WebView实际] (读不到)'
          const align =
            exp && wv
              ? ` delta=(${Math.round(p.delta?.x || 0)},${Math.round(p.delta?.y || 0)}) matches=${p.matchesSlot} fits=${p.fitsClient}`
              : ''
          console.log(slotMsg)
          console.log(wvMsg + align)
          dbgLog(`[browser-embed] ${slotMsg} | ${wvMsg}${align}`)
        })
        unlisten = () => {
          unlistenStall()
          unlistenCoords()
        }
      } catch (err) {
        dbgWarn(`[browser-embed] coords listen failed ${String(err)}`)
      }
    })()
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [isOpen])

  useEffect(() => {
    if (isOpen) return
    const tid = String(threadId || '').trim()
    if (!tid) return
    void browserEmbedClose(tid)
    void clearBrowserEmbedCdp(tid)
    // Panel is gone: allow a future mount for this thread to run again.
    mountedThreadRef.current = ''
    readyRef.current = false
    // Defer state update to avoid cascading renders
    requestAnimationFrame(() => {
      setReady(false)
    })
  }, [isOpen, threadId])

  return (
    <div className="browser-panel-embed-host">
      <div ref={slotRef} className="browser-panel-embed-slot" aria-hidden />
      {!ready && !error ? (
        <span className="browser-panel-spinner-anchor" aria-hidden>
          <LiveSpinner />
        </span>
      ) : null}
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

  if (!displaySrc) {
    return <BrowserEmptyState />
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
  /** 关闭浏览器这一页（right-stage closeTab），不是收起整栏。 */
  onClose: () => void
  /** 当前右栏标签是否激活。失活时由 browser-embed-surface 隐藏原生窗。 */
  surfaceActive?: boolean
  /** 右栏浏览器页 id。多个页共用一扇原生窗，只有和前台 id 一致时才贴位。 */
  stageId?: string
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
  surfaceActive = true,
  stageId = 'primary',
}: BrowserPanelProps) {
  const runtime = useSyncExternalStore(subscribeBrowserRuntime, getBrowserRuntimeSnapshot)
  // 多标签：每个 BrowserPanel 只展示本标签的 pageUrl（props）。
  // 前台标签在导航瞬间用 runtime 跟 HWND 对齐；后台标签绝不能读 runtime，否则会串成同一网址。
  const tabPageUrl = String(pageUrl || '').trim()
  const livePageUrl = String(runtime.pageUrl || '').trim()
  const effectivePageUrl = (
    surfaceActive
      ? livePageUrl || tabPageUrl
      : tabPageUrl || ''
  ).trim() || undefined
  const effectiveThreadId = String(streamThreadId || runtime.streamThreadId || '').trim()
  const effectiveMode = browserMode || runtime.browserMode
  const effectiveShared = sharedBrowser || runtime.sharedBrowser
  const operating = runtime.operating
  const [zoom, setZoom] = useState<ZoomOption>(() => readStoredEmbedZoom())
  /** WebView 实际比例（Ctrl+滚轮 / 工具栏写入都会更新）。 */
  const [liveZoomPercent, setLiveZoomPercent] = useState<number | null>(null)
  const programmaticFactorRef = useRef<number | null>(null)
  /** 用户已用滚轮改过比例时，适应窗口不再把 ZoomFactor 写回去。 */
  const userZoomLockRef = useRef(false)
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
  // iframe 回退：原生嵌入链路（Tauri invoke）挂起或失败时，面板直接用 iframe
  // 显示网页内容——零后端依赖，保证「打开就有内容」。
  const [iframeFallback, setIframeFallback] = useState(false)
  const [iframeSrc, setIframeSrc] = useState('')
  const [iframeNonce, setIframeNonce] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [viewport, setViewport] = useState<BrowserViewportSize | undefined>(undefined)
  const [viewportBusy, setViewportBusy] = useState(false)
  const [activePreset, setActivePreset] = useState<BrowserViewportPresetId>('desktop')
  const [isResponsiveMode, setIsResponsiveMode] = useState(false)
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
      return
    }
    dbgLog(
      `[browser-panel] open tid=${effectiveThreadId || '(empty)'} pageUrl=${effectivePageUrl || '(none)'} ` +
        `embedSupported=${embedSupported} transport=${'see /api/browser/transport'}`,
    )
  }, [isOpen, effectiveThreadId, effectivePageUrl, embedSupported])

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
    if (iframeFallback || !embedSupported) {
      setIframeNonce((n) => n + 1)
      return
    }
    if (refreshBusy) return
    const tid = effectiveThreadId
    dbgLog(`[browser-panel] refresh thread=${tid || '(none)'} embed=${preferEmbeddedBrowser}`)
    setRefreshBusy(true)
    try {
      if (preferEmbeddedBrowser && tid) {
        // Embed path: reload the live WebView2 page (not the old screencast).
        const result = await sendBrowserCommand(tid, 'reload')
        if (result) {
          applyBrowserCommandResponse({
            threadId: result.threadId || tid,
            pageUrl: result.pageUrl,
            pageTitle: result.pageTitle,
            streamWs: result.streamWs,
            canGoBack: result.canGoBack,
            canGoForward: result.canGoForward,
          })
        }
      } else if (streamPath && tid) {
        setStreamStatus((prev) => (prev === 'live' ? 'reconnecting' : prev))
        try {
          await restartBrowserStream(tid)
        } catch (err) {
          dbgWarn(`[browser-panel] refresh restart failed ${String(err)}`)
        }
      }
      setRefreshNonce((n) => n + 1)
    } finally {
      setRefreshBusy(false)
    }
  }, [
    refreshBusy,
    streamPath,
    effectiveThreadId,
    iframeFallback,
    embedSupported,
    preferEmbeddedBrowser,
  ])

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
      dbgLog(
        `[browser-panel] applyViewport thread=${tid || '(none)'} preset=${presetId} ${size.width}x${size.height}`,
      )
      setViewportBusy(true)
      setActivePreset(presetId)
      try {
        if (!tid) {
          setViewport(size)
          return
        }
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
      const normalized = url.startsWith('http') || url.startsWith('about:') ? url : 'https://' + url
      const tid = String(effectiveThreadId || '').trim()
      // iframe 路径：显式回退 / 无嵌入能力 / 尚无引擎 thread —— 地址栏直接驱动 iframe
      if (iframeFallback || !embedSupported || !tid) {
        setIframeFallback(true)
        setIframeSrc(normalized)
        applyBrowserCommandResponse({
          threadId: tid,
          pageUrl: normalized,
          pageTitle: '',
          streamWs: '',
          pushHistory: true,
          navigateIntent: true,
        })
        return
      }
      if (navBusy) return
      setNavBusy(true)
      setNavError('')
      try {
        // 先压逻辑栈并 seed URL，再让引擎 CDP 导航（面板不再二次 upsert）。
        applyBrowserCommandResponse({
          threadId: tid,
          pageUrl: normalized,
          pageTitle: '',
          streamWs: '',
          pushHistory: true,
          navigateIntent: true,
        })
        const result = await sendBrowserCommand(tid, 'navigate', normalized)
        if (result) {
          const settled = sanitizeBrowserPageUrl(result.pageUrl, normalized) || normalized
          if (isBrowserInternalErrorUrl(result.pageUrl)) {
            setNavError('页面加载失败，请检查网址或网络后重试')
          } else if (settled !== normalized) {
            // 重定向：用最终 URL 更新栈顶（再 push 一次会去重同 URL）。
            pushBrowserTabHistory(settled, result.pageTitle || '')
          }
          applyBrowserCommandResponse({
            threadId: result.threadId || tid,
            pageUrl: settled,
            pageTitle: result.pageTitle,
            streamWs: result.streamWs,
          })
        }
        setRefreshNonce((n) => n + 1)
      } finally {
        setNavBusy(false)
      }
    },
    [effectiveThreadId, navBusy, iframeFallback, embedSupported],
  )
  const handleBack = useCallback(async () => {
    if (iframeFallback || !embedSupported) {
      iframeRef.current?.contentWindow?.history.back()
      return
    }
    if (navBusy) return
    const target = stepBrowserTabHistory(-1)
    if (!target) return
    setNavBusy(true)
    setNavError('')
    try {
      markUserNavigateIntent(target)
      // 单 HWND：用 replace 跳到逻辑栈目标，不碰 window.history.back()。
      await ensureNativeEmbed({
        url: target,
        stageId,
        reason: 'history-back',
        replace: true,
      })
      setRefreshNonce((n) => n + 1)
    } finally {
      setNavBusy(false)
    }
  }, [navBusy, iframeFallback, embedSupported, stageId])
  const handleForward = useCallback(async () => {
    if (iframeFallback || !embedSupported) {
      iframeRef.current?.contentWindow?.history.forward()
      return
    }
    if (navBusy) return
    const target = stepBrowserTabHistory(1)
    if (!target) return
    setNavBusy(true)
    setNavError('')
    try {
      markUserNavigateIntent(target)
      await ensureNativeEmbed({
        url: target,
        stageId,
        reason: 'history-forward',
        replace: true,
      })
      setRefreshNonce((n) => n + 1)
    } finally {
      setNavBusy(false)
    }
  }, [navBusy, iframeFallback, embedSupported, stageId])

  // 引擎标签页轮询：只读会话里记下的地址，不跑页面脚本。3s 节流。
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
  const zoomVisible = preferEmbeddedBrowser || (hasStream && !useEmbeddedBrowser)

  const panelRootRef = useRef<HTMLDivElement | null>(null)

  const handleZoomChange = useCallback((next: ZoomOption) => {
    userZoomLockRef.current = false
    setZoom(next)
    try {
      localStorage.setItem(EMBED_ZOOM_STORAGE_KEY, next)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    if (!preferEmbeddedBrowser) return
    let cancelled = false
    let unlisten: (() => void) | undefined
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      if (cancelled) return
      unlisten = await listen<{ factor?: number }>('browser-embed-zoom', (ev) => {
        const factor = Number(ev.payload?.factor)
        if (!Number.isFinite(factor) || factor <= 0) return
        const percent = Math.round(factor * 100)
        setLiveZoomPercent(percent)
        const programmed = programmaticFactorRef.current
        if (programmed != null && Math.abs(factor - programmed) > 0.035) {
          userZoomLockRef.current = true
        }
      })
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [preferEmbeddedBrowser])

  // 把工具栏缩放落到 WebView2 ZoomFactor（CSS zoom 管不到原生 HWND）。
  // 「适应窗口」跟槽位尺寸走：侧栏窄 → 更小；窗口放大 → 更大。
  useEffect(() => {
    if (!preferEmbeddedBrowser || !embedReady || !surfaceActive) return
    const tid = String(embedThreadId || effectiveThreadId || '').trim()
    if (!tid) return

    const apply = () => {
      if (userZoomLockRef.current) return
      const slot =
        panelRootRef.current?.querySelector('.browser-panel-embed-slot') ||
        panelRootRef.current?.querySelector('.browser-panel-body')
      const rect = slot instanceof HTMLElement ? slot.getBoundingClientRect() : null
      const factor = embedZoomFactor(zoom, rect?.width || 0, rect?.height || 0)
      programmaticFactorRef.current = factor
      void browserEmbedSetZoom(tid, factor).then((ok) => {
        if (!ok) dbgWarn(`[browser-panel] setZoom failed factor=${factor} zoom=${zoom}`)
      })
    }

    apply()
    if (zoom !== 'fit') return

    let timer = 0
    const schedule = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(apply, 120)
    }
    window.addEventListener('resize', schedule)
    window.addEventListener('evopanel:xm-dock-layout', schedule)
    const ro =
      typeof ResizeObserver !== 'undefined' && panelRootRef.current
        ? new ResizeObserver(schedule)
        : null
    if (panelRootRef.current) ro?.observe(panelRootRef.current)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('evopanel:xm-dock-layout', schedule)
      ro?.disconnect()
    }
  }, [preferEmbeddedBrowser, embedReady, surfaceActive, embedThreadId, effectiveThreadId, zoom])

  // 内嵌 WebView2 可用时不要再铺一层 iframe。iframe 只显示打开时的地址
  // （例如百度首页），CDP 仍驱动槽外的原生窗口去搜索，两扇窗各看各的。
  useEffect(() => {
    if (preferEmbeddedBrowser && iframeFallback) setIframeFallback(false)
  }, [preferEmbeddedBrowser, iframeFallback])

  return (
    <div
      ref={panelRootRef}
      className={`react-chat-collab-exec-panel react-chat-browser-panel react-chat-browser-panel-content is-browser-surface${
        operating ? ' is-agent-operating' : ''
      }`}
      role="region"
      aria-label="Browser"
    >
      <BrowserChromeBar
        pageUrl={effectivePageUrl || iframeSrc || undefined}
        refreshBusy={refreshBusy}
        canRefresh={
          preferEmbeddedBrowser ||
          hasStream ||
          iframeFallback ||
          Boolean(iframeSrc || effectivePageUrl)
        }
        zoom={zoom}
        liveZoomPercent={preferEmbeddedBrowser ? liveZoomPercent : null}
        zoomVisible={zoomVisible || isResponsiveMode}
        viewportBusy={viewportBusy}
        viewport={viewport || DEFAULT_BROWSER_VIEWPORT}
        onViewportSizeChange={(size) => void applyViewport(size, 'custom')}
        onNavigate={(url) => void handleNavigate(url)}
        onBack={
          iframeFallback || hasStream || preferEmbeddedBrowser || Boolean(effectiveThreadId)
            ? () => void handleBack()
            : undefined
        }
        onForward={
          iframeFallback || hasStream || preferEmbeddedBrowser || Boolean(effectiveThreadId)
            ? () => void handleForward()
            : undefined
        }
        canGoBack={runtime.canGoBack}
        canGoForward={runtime.canGoForward}
        navBusy={navBusy}
        onZoomChange={handleZoomChange}
        onRefresh={() => void handleRefresh()}
        isResponsiveMode={isResponsiveMode}
        onToggleResponsiveMode={() => setIsResponsiveMode((v) => !v)}
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
      <div className="react-chat-collab-exec-panel-body browser-panel-body browser-panel-body-live">
        {showSharedBrowserHint ? (
          <div className="browser-panel-shared-hint" role="status">
            <BrowserPanelIcon className="browser-panel-shared-hint-icon" />
            <p className="browser-panel-shared-hint-text">{sharedBrowserHint}</p>
          </div>
        ) : null}
        {!(iframeSrc || effectivePageUrl) ? (
          <BrowserEmptyState />
        ) : preferEmbeddedBrowser && embedThreadId && !embedFailed ? (
          <BrowserEmbedHost
            isOpen={isOpen}
            surfaceActive={surfaceActive}
            stageId={stageId}
            threadId={embedThreadId}
            pageUrl={effectivePageUrl}
            onReady={handleEmbedReady}
            onFailed={handleEmbedFailed}
          />
        ) : !preferEmbeddedBrowser &&
          (iframeFallback || !embedSupported || (!effectiveThreadId && !hasStream)) ? (
            <div className="browser-panel-iframe-host">
              <iframe
                key={`iframe-${iframeNonce}-${iframeSrc || effectivePageUrl}`}
                ref={iframeRef}
                src={iframeSrc || effectivePageUrl}
                className="browser-panel-iframe"
                title="内置浏览器"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
                referrerPolicy="no-referrer-when-downgrade"
              />
            </div>
        ) : hasStream ? (
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
            ) : streamStatus === 'live' && !runtime.lastFrameMeta ? (
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
        ) : (
          <BrowserEmptyState />
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
    </div>
  )
})

/** ════════════════════════════════════════════════════════════
 *  Toolbar toggle icon — globe / network
 * ════════════════════════════════════════════════════════════ */
export function BrowserToolbarIcon() {
  return <GlobeNetworkIcon />
}
