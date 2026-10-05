import { memo, useSyncExternalStore, type ReactNode } from 'react'
import { getRightStageKind, UnknownStageKind } from '../../lib/right-stage/right-stage-registry.js'
import { normalizeRightStageKind, type RightStageSurface } from '../../lib/right-stage/right-stage-types.js'
import { rightStageStore } from '../../lib/right-stage/right-stage-store.js'
import {
  getBrowserRuntimeSnapshot,
  subscribeBrowserRuntime,
} from '../../lib/browser-panel-store.js'
import {
  closeBrowserTab,
  newBrowserTab,
  selectBrowserTab,
} from '../../lib/browser-viewport-client.js'
import { TauriWindowControls } from './TauriWindowControls.js'

export type RightStageShellProps = {
  surface: RightStageSurface | null
  booting?: boolean
  bootTitle?: string
  onClose: () => void
  /** Fallback when kind not in registry (legacy inline render from ChatApp). */
  renderLegacy?: (surface: RightStageSurface) => ReactNode
}

/** kind → 16px 线性图标（lucide 风格，stroke 用 currentColor）。 */
const KIND_TAB_ICONS: Record<string, ReactNode> = {
  browser: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </>
  ),
  'web-embed': (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </>
  ),
  'collab-workflow': (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M7 7h4v4H7zM13 13h4v4h-4z" />
    </>
  ),
  'mind-map': (
    <>
      <circle cx="5" cy="12" r="2.5" />
      <circle cx="19" cy="6" r="2.5" />
      <circle cx="19" cy="18" r="2.5" />
      <path d="M7.3 11 16.7 6.8M7.3 13l9.4 4.2" />
    </>
  ),
  workspace: (
    <>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </>
  ),
  write: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </>
  ),
  'platform-feedback': (
    <>
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <path d="M8 21h8" />
    </>
  ),
  'news-dashboard': (
    <>
      <path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2z" />
      <path d="M18 14h-8M15 18h-5M10 6h8v4h-8z" />
    </>
  ),
}

function KindTabIcon({ kind }: { kind: string }) {
  const k = normalizeRightStageKind(kind)
  return (
    <span className="react-chat-stage-tab-icon" aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        width="13"
        height="13"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {KIND_TAB_ICONS[k] ?? KIND_TAB_ICONS.browser}
      </svg>
    </span>
  )
}

/** ZCode 式统一侧栏标签条：网页页签与其他面板页签共存，点击切换、× 关闭、+ 新建网页。 */
const RightStageTabStrip = memo(function RightStageTabStrip() {
  const stageSnap = useSyncExternalStore(
    (cb) => rightStageStore.subscribe(cb),
    () => rightStageStore.getSnapshot(),
  )
  const rt = useSyncExternalStore(
    (cb) => subscribeBrowserRuntime(cb),
    () => getBrowserRuntimeSnapshot(),
  )
  const stageKind = String(stageSnap.surface?.kind || '')
  const browserActive = stageKind === 'browser'
  const tid = String(rt.streamThreadId || '').trim()
  const browserStageTab = stageSnap.tabs.find((t) => t.kind === 'browser')
  const browserStageKey = browserStageTab ? `${browserStageTab.kind}:${browserStageTab.id}` : null

  const activateBrowserStage = () => {
    if (browserStageKey) rightStageStore.activateTab(browserStageKey)
    else rightStageStore.show({ kind: 'browser', id: 'primary', title: '浏览器' })
  }

  const handleNewWebPage = () => {
    activateBrowserStage()
    if (tid) void newBrowserTab(tid)
  }

  return (
    <div className="react-chat-stage-tabs" role="tablist" aria-label="侧栏标签页">
      <div className="react-chat-stage-tabs-viewport">
        {browserActive
          ? rt.tabs.map((page, i) => (
              <div
                key={page.tabId || `page-${i}`}
                role="tab"
                aria-selected={Boolean(page.active)}
                tabIndex={0}
                className={`react-chat-stage-tab is-page${page.active ? ' is-active' : ''}`}
                title={page.url || undefined}
                onClick={() => {
                  if (!page.active && tid) void selectBrowserTab(tid, i)
                }}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && !page.active && tid) {
                    e.preventDefault()
                    void selectBrowserTab(tid, i)
                  }
                }}
              >
                <KindTabIcon kind="browser" />
                <span className="react-chat-stage-tab-title">
                  {page.title || page.url || `网页 ${i + 1}`}
                </span>
                <button
                  type="button"
                  className="react-chat-stage-tab-close"
                  aria-label={`关闭 ${page.title || `网页 ${i + 1}`}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (tid) void closeBrowserTab(tid, i)
                  }}
                >
                  <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                </button>
              </div>
            ))
          : null}
        {!browserActive && browserStageKey ? (
          <div
            role="tab"
            aria-selected={false}
            tabIndex={0}
            className="react-chat-stage-tab"
            title={browserStageTab?.title || '浏览器'}
            onClick={() => activateBrowserStage()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                activateBrowserStage()
              }
            }}
          >
            <KindTabIcon kind="browser" />
            <span className="react-chat-stage-tab-title">{browserStageTab?.title || '浏览器'}</span>
          </div>
        ) : null}
        {stageSnap.tabs
          .filter((t) => t.kind !== 'browser')
          .map((t) => {
            const key = `${t.kind}:${t.id}`
            const active = stageSnap.activeKey === key
            return (
              <div
                key={key}
                role="tab"
                aria-selected={active}
                tabIndex={0}
                className={`react-chat-stage-tab${active ? ' is-active' : ''}`}
                title={t.title}
                onClick={() => rightStageStore.activateTab(key)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    rightStageStore.activateTab(key)
                  }
                }}
              >
                <KindTabIcon kind={t.kind} />
                <span className="react-chat-stage-tab-title">{t.title}</span>
                <button
                  type="button"
                  className="react-chat-stage-tab-close"
                  aria-label={`关闭 ${t.title}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    rightStageStore.closeTab(key)
                  }}
                >
                  <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                </button>
              </div>
            )
          })}
        <button
          type="button"
          className="react-chat-stage-tab-new"
          title="新建网页标签"
          aria-label="新建网页标签"
          onClick={handleNewWebPage}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden><path d="M5 12h14" /><path d="M12 5v14" /></svg>
        </button>
      </div>
      <button
        type="button"
        className="react-chat-stage-tab-collapse"
        title="收起侧栏面板"
        aria-label="收起侧栏面板"
        onClick={() => rightStageStore.hide()}
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" /><path d="m8 9 3 3-3 3" /></svg>
      </button>
      <div className="react-chat-stage-tab-win">
        <TauriWindowControls />
      </div>
    </div>
  )
})

export const RightStageShell = memo(function RightStageShell({
  surface,
  booting,
  bootTitle,
  onClose,
  renderLegacy,
}: RightStageShellProps) {
  if (!surface) return null

  const def = getRightStageKind(surface.kind)
  if (def) {
    return (
      <>
        <RightStageTabStrip />
        {def.render({ surface, onClose })}
      </>
    )
  }

  if (renderLegacy) {
    const legacy = renderLegacy(surface)
    if (legacy) {
      return (
        <>
          <RightStageTabStrip />
          {legacy}
        </>
      )
    }
  }

  // 已迁移到侧栏的面板种类：不占用 Right Stage 布局
  if (normalizeRightStageKind(surface.kind) === 'artifacts') {
    return null
  }

  if (booting && bootTitle) {
    return (
      <aside className="react-chat-right-stage-panel" role="region" aria-busy="true" aria-label={bootTitle}>
        <header className="react-chat-collab-exec-panel-header">
          <div className="react-chat-collab-exec-panel-title-wrap">
            <span className="react-chat-collab-exec-panel-title">{bootTitle}</span>
          </div>
        </header>
        <div className="react-chat-collab-exec-panel-body react-chat-side-panel-boot">
          <div className="page-loader-spinner" aria-hidden="true" />
          <span className="page-loader-text">加载中…</span>
        </div>
      </aside>
    )
  }

  return <UnknownStageKind kind={surface.kind} />
})
