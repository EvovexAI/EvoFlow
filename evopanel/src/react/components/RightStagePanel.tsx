import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  FolderIcon,
  GlobeIcon,
  NetworkIcon,
  PanelRightIcon,
  PlusIcon,
  WorkflowIcon,
  type LucideIcon,
} from 'lucide-react'
import { createPortal } from 'react-dom'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  defaultTitleForKind,
  normalizeRightStageKind,
  type RightStageSurface,
} from '../../lib/right-stage/right-stage-types.js'
import type { RecentClosedRightStageTab } from '../../lib/right-stage/right-stage-store.js'
import { getRightStageKind, UnknownStageKind } from '../../lib/right-stage/right-stage-registry.js'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js'
import { KindTabIcon } from './RightStageTabIcon.js'
import { RightStageTabOverview } from './RightStageTabOverview.js'
import {
  resolveStageTabsOverflow,
  resolveStageTabsOverflowEdges,
} from './rightStageTabLayout.js'
import { useGlobalOverlayWhen } from '../hooks/useGlobalOverlayWhen.js'

/**
 * 失活仍挂载：切签像浏览器标签一样保活。
 *
 * 入列标准是「**重建成本高或会丢状态**」，不是「是右栏面板」：
 * - browser / web-embed：原生 WebView2 宿主与页面现场，卸载即丢；
 * - terminal / write：流式内容只在挂载期接收，卸载会漏 chunk；
 * - file / codeViewer / subagentTranscript / workspace-browse：滚动位置、树展开态、已加载内容；
 * - collab-workflow / mind-map / summary：异步数据与画布状态，重建会闪一下。
 *
 * 刻意不包含的 kind：
 * - `news-dashboard`：挂载即 fetch 并起 30 分钟定时器，失活常驻会持续联网，而它的数据
 *   本来就是低频刷新，切回来重新拉一次即可；
 * - `platform-feedback`：纯展示（无副作用、无异步），重建零成本。
 *   两者都靠 RightStageTabIcon + title 维持标签条外观，切回时按需挂载。
 */
const FORCE_MOUNT_KINDS = new Set([
  'browser',
  'file',
  'terminal',
  'summary',
  'write',
  'workspace-browse',
  'collab-workflow',
  'mind-map',
  'web-embed',
  'codeViewer',
  'subagentTranscript',
])

export type RightStageLauncherItemId =
  | 'browser'
  | 'workspace'
  | 'workflow'
  | 'mind-map'
  | 'summary'

export type RightStageLauncherItem = {
  id: RightStageLauncherItemId
  label: string
  description?: string
  icon: LucideIcon
  onOpen: () => void
}

type StageTabContextMenu = {
  key: string
  x: number
  y: number
}

function tabKeyOf(tab: RightStageSurface): string {
  return `${normalizeRightStageKind(tab.kind)}:${tab.id}`
}

function tabTitleOf(tab: RightStageSurface): string {
  return tab.title?.trim() || defaultTitleForKind(tab.kind)
}

function StageTabChip({
  tab,
  active,
  onActivate,
  onClose,
  onContextMenu,
}: {
  tab: RightStageSurface
  active: boolean
  onActivate: (key: string) => void
  onClose: (key: string) => void
  onContextMenu: (key: string, x: number, y: number) => void
}) {
  const key = tabKeyOf(tab)
  const title = tabTitleOf(tab)
  const kind = normalizeRightStageKind(tab.kind)
  const faviconUrl = kind === 'browser' ? String(tab.data?.faviconUrl || '') : ''
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: key,
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <button
      ref={setNodeRef}
      type="button"
      data-tauri-no-drag
      aria-selected={active}
      title={title}
      className={`react-chat-stage-tab${active ? ' is-active' : ''}${isDragging ? ' is-dragging' : ''}`}
      style={style}
      onClick={() => {
        if (!active) onActivate(key)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onContextMenu(key, e.clientX, e.clientY)
      }}
      {...attributes}
      {...listeners}
      role="tab"
    >
      <KindTabIcon kind={kind} faviconUrl={faviconUrl} />
      <span className="react-chat-stage-tab-content">
        <span className="react-chat-stage-tab-title">{title}</span>
      </span>
      <span
        role="button"
        tabIndex={-1}
        aria-label={`关闭 ${title}`}
        className="react-chat-stage-tab-close"
        onPointerDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onClose(key)
        }}
      >
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      </span>
    </button>
  )
}

export type RightStagePanelProps = {
  tabs: RightStageSurface[]
  activeKey: string | null
  recentClosed: RecentClosedRightStageTab[]
  onActivateTab: (key: string) => void
  onCloseTab: (key: string) => void
  onCloseOtherTabs?: (keepKey: string) => void
  onCloseAllTabs?: () => void
  onReorderTab: (activeId: string, overId: string) => void
  onReopenClosedTab: (key: string) => void
  /** 折叠侧栏（保留 tabs 缓存），不是 hideAll。 */
  onCollapse: () => void
  launcherItems: RightStageLauncherItem[]
  renderContent?: (surface: RightStageSurface) => ReactNode
}

export const RightStagePanel = memo(function RightStagePanel({
  tabs,
  activeKey,
  recentClosed,
  onActivateTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseAllTabs,
  onReorderTab,
  onReopenClosedTab,
  onCollapse,
  launcherItems,
  renderContent,
}: RightStagePanelProps) {
  const [draggingKey, setDraggingKey] = useState<string | null>(null)
  const [overviewOpen, setOverviewOpen] = useState(false)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [tabCtx, setTabCtx] = useState<StageTabContextMenu | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [viewportWidth, setViewportWidth] = useState(0)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  useEffect(() => {
    if (!tabCtx) return
    const close = () => setTabCtx(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
    }
  }, [tabCtx])

  const openTabContextMenu = useCallback((key: string, x: number, y: number) => {
    setTabCtx({ key, x, y })
  }, [])

  /** 菜单/拖拽进行中强制露出标签条，避免 Portal 弹出后 mouseleave 把条收回去。 */
  const chromeForcedOpen = overviewOpen || addMenuOpen || !!tabCtx || !!draggingKey
  // 原生 WebView2 不吃 CSS z-index；下拉/总览打开时先藏 HWND，否则菜单被网页挡住。
  useGlobalOverlayWhen(chromeForcedOpen, 'right-stage-chrome')

  const visibleActiveKey = useMemo(() => {
    if (activeKey && tabs.some((t) => tabKeyOf(t) === activeKey)) return activeKey
    return tabs.length ? tabKeyOf(tabs[tabs.length - 1]) : null
  }, [activeKey, tabs])

  const draggingTab = useMemo(
    () => (draggingKey ? tabs.find((t) => tabKeyOf(t) === draggingKey) ?? null : null),
    [draggingKey, tabs],
  )

  const isOverflowing = resolveStageTabsOverflow({
    addButtonWidth: 28,
    tabCount: tabs.length,
    viewportWidth,
  })
  const overflowEdges = resolveStageTabsOverflowEdges({
    isOverflowing,
    scrollLeft: viewportRef.current?.scrollLeft ?? 0,
    maxScrollLeft: Math.max(
      0,
      (viewportRef.current?.scrollWidth ?? 0) - (viewportRef.current?.clientWidth ?? 0),
    ),
  })

  const measureViewport = useCallback(() => {
    const el = viewportRef.current
    if (!el) return
    setViewportWidth(Math.round(el.clientWidth))
  }, [])

  useEffect(() => {
    measureViewport()
    const el = viewportRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measureViewport())
    ro.observe(el)
    return () => ro.disconnect()
  }, [measureViewport, tabs.length])

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setDraggingKey(String(event.active.id))
  }, [])

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDraggingKey(null)
      const { active, over } = event
      if (!over || active.id === over.id) return
      onReorderTab(String(active.id), String(over.id))
    },
    [onReorderTab],
  )

  const renderTabBody = useCallback(
    (tab: RightStageSurface) => {
      const key = tabKeyOf(tab)
      const active = key === visibleActiveKey
      const kind = normalizeRightStageKind(tab.kind)
      const forceMount = FORCE_MOUNT_KINDS.has(kind)
      if (!active && !forceMount) return null

      const def = getRightStageKind(kind)
      const body = def
        ? def.render({ surface: tab, onClose: () => onCloseTab(key), active })
        : renderContent?.(tab) ?? <UnknownStageKind kind={kind} />

      return (
        <div
          key={key}
          role="tabpanel"
          hidden={!active}
          className={`react-chat-right-stage-body${active ? ' is-active' : ''}`}
          data-stage-kind={kind}
          data-stage-tab={key}
        >
          {body}
        </div>
      )
    },
    [onCloseTab, renderContent, visibleActiveKey],
  )

  const collapseButton = (
    <button
      type="button"
      className="react-chat-stage-tab-collapse"
      data-tauri-no-drag
      title="收起侧栏面板"
      aria-label="收起侧栏面板"
      onClick={onCollapse}
    >
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M15 18l-6-6 6-6" />
      </svg>
    </button>
  )

  const addTabMenu = (
    <Popover open={addMenuOpen} onOpenChange={setAddMenuOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`react-chat-stage-tab-new${addMenuOpen ? ' is-pressed' : ''}`}
          data-tauri-no-drag
          data-side-pane-add-tab=""
          title="打开新标签"
          aria-label="打开新标签"
          aria-haspopup="menu"
          aria-expanded={addMenuOpen}
        >
          <PlusIcon className="size-4" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="react-chat-stage-popover w-56 p-1"
        data-tauri-no-drag
      >
        <div className="flex flex-col gap-0.5" role="menu">
          {launcherItems.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                data-side-pane-add-item={item.id}
                className="react-chat-stage-add-item"
                onClick={() => {
                  setAddMenuOpen(false)
                  item.onOpen()
                }}
              >
                <Icon className="size-4 shrink-0 opacity-70" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )

  // 首页不画顶栏收起钮：折叠只走聊天顶栏的 PanelRight（与 ZCode 一致）。
  const openTabLauncher = (
    <div className="react-chat-stage-open-tab-shell">
      <div className="react-chat-stage-open-tab-body">
        <div className="react-chat-stage-open-tab-content">
          <div className="react-chat-stage-open-tab-copy">
            <h2 className="react-chat-stage-open-tab-title">打开标签</h2>
            <p className="react-chat-stage-open-tab-desc">在右侧查看浏览器、工作区文件或工作流。</p>
          </div>
          <div className="react-chat-stage-open-tab-list">
            {launcherItems.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  type="button"
                  data-side-pane-open-tab-item={item.id}
                  className="react-chat-stage-open-tab-button"
                  onClick={item.onOpen}
                >
                  <Icon className="size-4 shrink-0 opacity-70" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )

  if (tabs.length === 0) {
    return (
      <aside className="react-chat-right-stage-panel react-chat-right-stage-shell" role="region" aria-label="右侧面板">
        {openTabLauncher}
      </aside>
    )
  }

  return (
    <aside className="react-chat-right-stage-panel react-chat-right-stage-shell" role="region" aria-label="右侧面板">
      {/* 顶部悬停才展开标签条：平时不占摘要等内容的视觉空间 */}
      <div
        className={`react-chat-stage-chrome${chromeForcedOpen ? ' is-open' : ''}`}
        data-tauri-no-drag
      >
        <div className="react-chat-stage-tabs" role="tablist" aria-label="右侧标签">
          <Popover open={overviewOpen} onOpenChange={setOverviewOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={`react-chat-stage-tab-new${overviewOpen ? ' is-pressed' : ''}`}
                data-tauri-no-drag
                title="搜索标签页"
                aria-label="搜索标签页"
                aria-haspopup="dialog"
                aria-expanded={overviewOpen}
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m7 6 5 5 5-5" />
                  <path d="m7 13 5 5 5-5" />
                </svg>
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="react-chat-stage-popover w-72 p-2"
              data-tauri-no-drag
            >
              <RightStageTabOverview
                tabs={tabs}
                activeKey={visibleActiveKey}
                recentClosed={recentClosed}
                onActivateTab={(key) => {
                  onActivateTab(key)
                  setOverviewOpen(false)
                }}
                onCloseTab={onCloseTab}
                onReopenClosedTab={(key) => {
                  onReopenClosedTab(key)
                  setOverviewOpen(false)
                }}
              />
            </PopoverContent>
          </Popover>

          <div
            ref={viewportRef}
            className="react-chat-stage-tabs-viewport"
            data-overflow-left={overflowEdges.left ? 'true' : undefined}
            data-overflow-right={overflowEdges.right ? 'true' : undefined}
            onScroll={measureViewport}
          >
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragCancel={() => setDraggingKey(null)}
            >
              <SortableContext items={tabs.map(tabKeyOf)} strategy={horizontalListSortingStrategy}>
                {tabs.map((tab) => (
                  <StageTabChip
                    key={tabKeyOf(tab)}
                    tab={tab}
                    active={tabKeyOf(tab) === visibleActiveKey}
                    onActivate={onActivateTab}
                    onClose={onCloseTab}
                    onContextMenu={openTabContextMenu}
                  />
                ))}
              </SortableContext>
              {!isOverflowing ? addTabMenu : null}
              <DragOverlay dropAnimation={null}>
                {draggingTab ? (
                  <button
                    type="button"
                    className="react-chat-stage-tab is-active is-dragging-overlay"
                    data-tauri-no-drag
                  >
                    <KindTabIcon
                      kind={normalizeRightStageKind(draggingTab.kind)}
                      faviconUrl={
                        normalizeRightStageKind(draggingTab.kind) === 'browser'
                          ? String(draggingTab.data?.faviconUrl || '')
                          : ''
                      }
                    />
                    <span className="react-chat-stage-tab-content">
                      <span className="react-chat-stage-tab-title">{tabTitleOf(draggingTab)}</span>
                    </span>
                  </button>
                ) : null}
              </DragOverlay>
            </DndContext>
          </div>

          <div className="react-chat-stage-tabs-tail">
            {isOverflowing ? addTabMenu : null}
            {collapseButton}
          </div>
        </div>
      </div>

      <div className="react-chat-right-stage-bodies">{tabs.map(renderTabBody)}</div>

      {tabCtx && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="react-chat-stage-tab-context-menu"
              data-tauri-no-drag
              style={{ left: tabCtx.x, top: tabCtx.y }}
              onMouseDown={(e) => e.stopPropagation()}
              role="menu"
            >
              <button
                type="button"
                role="menuitem"
                className="react-chat-stage-tab-context-menu-item"
                onClick={() => {
                  onCloseTab(tabCtx.key)
                  setTabCtx(null)
                }}
              >
                关闭标签
              </button>
              <button
                type="button"
                role="menuitem"
                className="react-chat-stage-tab-context-menu-item"
                disabled={!onCloseOtherTabs || tabs.length <= 1}
                onClick={() => {
                  onCloseOtherTabs?.(tabCtx.key)
                  setTabCtx(null)
                }}
              >
                关闭其他标签
              </button>
              <button
                type="button"
                role="menuitem"
                className="react-chat-stage-tab-context-menu-item"
                disabled={!onCloseAllTabs || tabs.length === 0}
                onClick={() => {
                  onCloseAllTabs?.()
                  setTabCtx(null)
                }}
              >
                关闭全部标签
              </button>
            </div>,
            document.body,
          )
        : null}
    </aside>
  )
})

/** 默认启动项工厂：ChatApp 注入真实 open 回调。 */
export function buildDefaultRightStageLauncherItems(handlers: {
  onOpenBrowser: () => void
  onOpenWorkspace: () => void
  onOpenWorkflow: () => void
  onOpenMindMap?: () => void
  mindMapEnabled?: boolean
  onOpenSummary?: () => void
}): RightStageLauncherItem[] {
  const items: RightStageLauncherItem[] = [
    {
      id: 'browser',
      label: '浏览器',
      icon: GlobeIcon,
      onOpen: handlers.onOpenBrowser,
    },
    {
      id: 'workspace',
      label: '工作区文件',
      icon: FolderIcon,
      onOpen: handlers.onOpenWorkspace,
    },
    {
      id: 'workflow',
      label: '工作流',
      icon: WorkflowIcon,
      onOpen: handlers.onOpenWorkflow,
    },
  ]
  if (handlers.onOpenSummary) {
    items.push({
      id: 'summary',
      label: '摘要',
      icon: PanelRightIcon,
      onOpen: handlers.onOpenSummary,
    })
  }
  if (handlers.mindMapEnabled && handlers.onOpenMindMap) {
    items.push({
      id: 'mind-map',
      label: '思维导图',
      icon: NetworkIcon,
      onOpen: handlers.onOpenMindMap,
    })
  }
  return items
}
