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
  BotIcon,
  ChevronsDownIcon,
  FolderIcon,
  GlobeIcon,
  NetworkIcon,
  PanelRightCloseIcon,
  PanelRightIcon,
  PlusIcon,
  WorkflowIcon,
  XIcon,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@zcode/ui/components/lib/utils.js'
import { Button } from '@zcode/ui/components/ui/button.js'
import { createPortal } from 'react-dom'
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import {
  replayThemeIntoBridgeRoots,
  useHostResolvedTheme,
} from '@zcode/ui/useTheme.js'
import '@/styles-bridge.css'
import {
  defaultTitleForKind,
  normalizeRightStageKind,
  type RightStageSurface,
} from '../../lib/right-stage/right-stage-types.js'
import type { RecentClosedRightStageTab } from '../../lib/right-stage/right-stage-store.js'
import { getRightStageKind, UnknownStageKind } from '../../lib/right-stage/right-stage-registry.js'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js'
import { KindTabIcon } from './RightStageTabIcon.js'
import { XiaomiStageAvatar } from './XiaomiStageAvatar.js'
import { RightStageTabOverview } from './RightStageTabOverview.js'
import {
  resolveStageTabsOverflow,
  resolveStageTabsOverflowEdges,
} from './rightStageTabLayout.js'
import { useGlobalOverlayWhen } from '../hooks/useGlobalOverlayWhen.js'
import { TAURI_HEADER_CELL_DRAG_PROPS } from '../chat-app/utils/desktop-workspace.js'

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
  'collabSubtaskTranscript',
  'employeeProcess',
  'xiaomi',
])

export type RightStageLauncherItemId =
  | 'xiaomi'
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
  /** 有则优先于 Lucide icon（如小V 用角色头像）。 */
  iconNode?: ReactNode
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

/**
 * StageTabChip — ZCode SidePaneTabTrigger 同款视觉配方（换装 2026-10-25）：
 * class 逐条对齐 vendored zcode-ui/app-shell/SidePaneTabTrigger.tsx 的 chip 层
 * （156px 等宽收缩 / text-ui-base / bg-hover / data-active:bg-selected / mask 渐隐 /
 * hover 亮出的右上角关闭钮 / 中键关闭）。未直接复用该组件的原因：它强类型绑定
 * WorkspaceSidePaneTab 19 成员判别联合（code-viewer 等成员要求 source 等必填字段），
 * EvoFlow 的 RightStageSurface 适配不过去；数据管道（dnd 排序 / 右键菜单）保持 EvoFlow 自有。
 * 注意根节点用 div：关闭钮是真实 button，root 若是 button 会形成嵌套 button，
 * 生产包里浏览器会修 DOM 导致 tab/close/drag 事件错位（ZCode 上游同款注释）。
 */
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
  const wasDraggingRef = useRef(false)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: key,
  })
  // 横向 tabs 固定高度：钳回 dnd-kit 携带的 scale，避免拖拽时被临时压缩/拉伸（ZCode 同款）。
  const normalizedTransform = transform
    ? { ...transform, scaleX: 1, scaleY: 1 }
    : null
  const style: CSSProperties = {
    transform: CSS.Transform.toString(normalizedTransform),
    transition,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.85 : 1,
  }
  if (isDragging) wasDraggingRef.current = true

  return (
    <div
      ref={setNodeRef}
      data-tauri-no-drag
      data-side-pane-tab-id={key}
      data-active={active ? '' : undefined}
      data-state={active ? 'active' : 'inactive'}
      title={title}
      style={style}
      {...attributes}
      {...listeners}
      // dnd-kit 的 attributes 带 role="button"/tabIndex，必须放在展开后覆盖为 tab 语义。
      role="tab"
      aria-selected={active}
      tabIndex={0}
      onPointerDown={(event) => {
        listeners?.onPointerDown?.(event)
        event.preventDefault()
      }}
      onClick={(event) => {
        // 中键先在 click 阶段拦截，避免关闭前把 inactive tab 激活（ZCode 同款）。
        if (event.button === 1) {
          event.preventDefault()
          event.stopPropagation()
          return
        }
        if (wasDraggingRef.current) {
          wasDraggingRef.current = false
          event.preventDefault()
          return
        }
        onActivate(key)
      }}
      onAuxClick={(event) => {
        // 中键 = 关闭该签，active tab 保持不变（ZCode 同款）。
        if (event.button !== 1) return
        event.preventDefault()
        event.stopPropagation()
        onClose(key)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onActivate(key)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onContextMenu(key, e.clientX, e.clientY)
      }}
      className={cn(
        'group relative inline-flex items-center gap-1',
        // 勿 flex-grow：单标签撑满 viewport 会盖住拖窗空白区（data-tauri-drag-region）
        'flex-[0_1_9.75rem] !h-7 min-w-15 max-w-39 justify-start overflow-hidden rounded-md border px-1.5 pr-2 text-ui-base font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring',
        '!border-transparent !bg-transparent text-foreground-subtle !rounded-lg',
        'hover:text-foreground',
        !active && 'hover:!bg-hover',
        // 受控 isActive 补齐 data-active，保证 Tailwind 的 active variant 命中（ZCode 同款）。
        'data-active:!bg-selected data-active:text-foreground',
        'cursor-default outline-none',
        isDragging && 'cursor-grabbing shadow-md',
      )}
    >
      <span
        data-side-pane-tab-content=""
        className={cn(
          'flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,black_calc(100%-var(--tab-fade-offset)-0.5rem),transparent_calc(100%-var(--tab-fade-offset)))]',
          active ? '[--tab-fade-offset:1.25rem]' : '[--tab-fade-offset:0px]',
          'group-hover:[--tab-fade-offset:1.25rem] group-focus-within:[--tab-fade-offset:1.25rem]',
        )}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          <KindTabIcon kind={kind} faviconUrl={faviconUrl} />
        </span>
        <span data-side-pane-tab-title="" className="shrink-0 whitespace-nowrap">
          {title}
        </span>
      </span>
      <button
        type="button"
        aria-label={`关闭 ${title}`}
        className={cn(
          'absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-foreground-subtle hover:bg-hover hover:text-foreground',
          !active &&
            'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100',
        )}
        onPointerDown={(event) => {
          event.stopPropagation()
        }}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onClose(key)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onContextMenu(key, e.clientX, e.clientY)
        }}
      >
        <XIcon className="size-3" />
      </button>
    </div>
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

  // 标签条用 text-foreground-subtle 等 zcode token；不在 .zcode-bridge-root.dark 下
  // 会落到 @theme 浅色值（深灰字）→ 暗色宿主上「小V」几乎看不见。
  const hostTheme = useHostResolvedTheme()
  useLayoutEffect(() => {
    replayThemeIntoBridgeRoots(hostTheme === 'dark' ? 'zai-dark' : 'zai-light')
  }, [hostTheme])

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

  // 换装 ZCode：尾部收起钮 = WorkspaceSidePaneToggleButton 同款（ghost icon-md + PanelRightClose）。
  const collapseButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-md"
      className="text-foreground hover:bg-hover hover:text-foreground"
      data-tauri-no-drag
      title="收起侧栏面板"
      aria-label="收起侧栏面板"
      onClick={onCollapse}
    >
      <PanelRightCloseIcon className="size-4" />
    </Button>
  )

  const addTabMenu = (
    <Popover open={addMenuOpen} onOpenChange={setAddMenuOpen}>
      <PopoverTrigger asChild>
        {/* 换装 ZCode：同 SidePaneTabOverview 触发器（ghost icon-md）。 */}
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          className={`shrink-0 text-foreground-subtle hover:bg-hover hover:text-foreground${addMenuOpen ? ' bg-hover text-foreground' : ''}`}
          data-tauri-no-drag
          data-side-pane-add-tab=""
          title="打开新标签"
          aria-label="打开新标签"
          aria-haspopup="menu"
          aria-expanded={addMenuOpen}
        >
          <PlusIcon className="size-4" aria-hidden />
        </Button>
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
                {item.iconNode ? (
                  <span className="react-chat-stage-launcher-avatar shrink-0" aria-hidden>
                    {item.iconNode}
                  </span>
                ) : (
                  <Icon className="size-4 shrink-0 opacity-70" aria-hidden />
                )}
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
                  {item.iconNode ? (
                    <span className="react-chat-stage-launcher-avatar shrink-0" aria-hidden>
                      {item.iconNode}
                    </span>
                  ) : (
                    <Icon className="size-4 shrink-0 opacity-70" aria-hidden />
                  )}
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
      <aside
        className="zcode-bridge-root react-chat-right-stage-panel react-chat-right-stage-shell"
        role="region"
        aria-label="右侧面板"
      >
        {openTabLauncher}
      </aside>
    )
  }

  return (
    <aside
      className="zcode-bridge-root react-chat-right-stage-panel react-chat-right-stage-shell"
      role="region"
      aria-label="右侧面板"
    >
      {/* 标签条兼窗口拖拽区：空白处拖窗；tab/按钮各自 data-tauri-no-drag */}
      <div
        className={`react-chat-stage-chrome${chromeForcedOpen ? ' is-open' : ''}`}
        data-tauri-drag-region=""
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest('[data-tauri-no-drag],button,a,[role="tab"]')) return
          void import('@tauri-apps/api/window').then(({ getCurrentWindow }) =>
            void getCurrentWindow().toggleMaximize(),
          )
        }}
      >
        <div className="react-chat-stage-tabs" role="tablist" aria-label="右侧标签">
          <Popover open={overviewOpen} onOpenChange={setOverviewOpen}>
            <PopoverTrigger asChild>
              {/* 换装 ZCode：同 SidePaneTabOverview 触发器（ghost icon-md + ChevronsDown）。 */}
              <Button
                type="button"
                variant="ghost"
                size="icon-md"
                className={`shrink-0 text-foreground-subtle hover:bg-hover hover:text-foreground${overviewOpen ? ' bg-hover text-foreground' : ''}`}
                data-tauri-no-drag
                title="搜索标签页"
                aria-label="搜索标签页"
                aria-haspopup="dialog"
                aria-expanded={overviewOpen}
              >
                <ChevronsDownIcon className="size-4" />
              </Button>
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
                  <div
                    className={cn(
                      'relative inline-flex items-center gap-1',
                      '!h-7 min-w-15 max-w-39 justify-start overflow-hidden rounded-md px-1.5 pr-2 text-ui-base font-medium whitespace-nowrap',
                      '!rounded-lg bg-selected text-foreground cursor-grabbing shadow-md',
                    )}
                    data-tauri-no-drag
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center">
                      <KindTabIcon
                        kind={normalizeRightStageKind(draggingTab.kind)}
                        faviconUrl={
                          normalizeRightStageKind(draggingTab.kind) === 'browser'
                            ? String(draggingTab.data?.faviconUrl || '')
                            : ''
                        }
                      />
                    </span>
                    <span
                      data-side-pane-tab-title=""
                      className="shrink-0 whitespace-nowrap"
                    >
                      {tabTitleOf(draggingTab)}
                    </span>
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          </div>

          {/* WebView2：拖区须标在实际被点中的节点上；标签右侧整段空白拖整窗 */}
          <div
            className="react-chat-stage-tabs-drag-gap"
            aria-hidden="true"
            title="拖动窗口"
            {...TAURI_HEADER_CELL_DRAG_PROPS}
          />

          <div className="react-chat-stage-tabs-tail" data-tauri-no-drag="">
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
  onOpenXiaomi?: () => void
  onOpenBrowser: () => void
  onOpenWorkspace: () => void
  onOpenWorkflow: () => void
  onOpenMindMap?: () => void
  mindMapEnabled?: boolean
  onOpenSummary?: () => void
}): RightStageLauncherItem[] {
  const items: RightStageLauncherItem[] = []
  if (handlers.onOpenXiaomi) {
    items.push({
      id: 'xiaomi',
      label: '小V',
      description: '全局助手',
      icon: BotIcon,
      iconNode: <XiaomiStageAvatar size={16} />,
      onOpen: handlers.onOpenXiaomi,
    })
  }
  items.push(
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
  )
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
