import { useEffect, useRef, useState, type MouseEvent } from 'react'
import {
  Bug,
  ChevronLeft,
  Clock,
  Ellipsis,
  History,
  ClipboardList,
  BookOpen,
  Layers,
  LayoutGrid,
  Play,
  Save,
  Send,
  Settings2,
} from 'lucide-react'

import AppIconTile from '../AppIconTile.tsx'
import { TauriWindowControls } from '../TauriWindowControls.tsx'

const TAURI_DRAG_PROPS = { 'data-tauri-drag-region': '' } as const

function isDesktopTauriRuntime(): boolean {
  return !!(
    typeof window !== 'undefined' &&
    ((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ ||
      (window as unknown as { __TAURI__?: unknown }).__TAURI__)
  )
}

type Props = {
  appId?: string
  appName: string
  appStatus?: string
  dirty?: boolean
  busy?: 'save' | 'publish' | null
  drawerOpen?: boolean
  titleDraft: string
  onTitleChange: (value: string) => void
  onTitleBlur: () => void
  onBack?: () => void
  onRun?: () => void
  onSave: () => void
  onPublish: () => void
  onToggleDrawer: () => void
  onOpenSettings?: () => void
  onOpenHistory?: () => void
  onOpenVersions?: () => void
  onOpenAudit?: () => void
  /** 发布后怎么用：面板运行 / API / 自动化 */
  onOpenHowToUse?: () => void
  /** @deprecated 使用 onOpenHowToUse */
  onOpenApiAccess?: () => void
  onOpenDebug?: () => void
  debugActive?: boolean
  onAutoArrange?: () => void
}

export function WorkflowToolbar({
  appId = '',
  appName = '',
  appStatus = 'draft',
  dirty,
  busy,
  drawerOpen,
  titleDraft,
  onTitleChange,
  onTitleBlur,
  onBack,
  onRun,
  onSave,
  onPublish,
  onToggleDrawer,
  onOpenSettings,
  onOpenHistory,
  onOpenVersions,
  onOpenAudit,
  onOpenHowToUse,
  onOpenApiAccess,
  onOpenDebug,
  debugActive,
  onAutoArrange,
}: Props) {
  const status = String(appStatus || 'draft').toLowerCase()
  const isPublished = status === 'published'
  const statusLabel =
    status === 'published' ? '已发布' : status === 'archived' ? '已归档' : '草稿'
  const statusClass =
    status === 'published'
      ? 'is-published'
      : status === 'archived'
        ? 'is-archived'
        : 'is-draft'
  const isTauri = isDesktopTauriRuntime()
  const openHowTo = onOpenHowToUse || onOpenApiAccess

  const [moreOpen, setMoreOpen] = useState(false)
  const moreWrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!moreOpen) return
    const onDoc = (e: Event) => {
      const t = e.target as Node | null
      if (moreWrapRef.current && t && !moreWrapRef.current.contains(t)) {
        setMoreOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      window.removeEventListener('keydown', onKey)
    }
  }, [moreOpen])

  const onTitlebarDblClick = (event: MouseEvent<HTMLElement>) => {
    if (!isTauri) return
    if (
      (event.target as HTMLElement).closest(
        '[data-tauri-no-drag], button, a, input, textarea, select',
      )
    ) {
      return
    }
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) =>
      void getCurrentWindow().toggleMaximize(),
    )
  }

  const moreItems: Array<{
    id: string
    label: string
    title?: string
    icon: typeof Clock
    active?: boolean
    onClick?: () => void
  }> = [
    onOpenHistory
      ? {
          id: 'history',
          label: '历史',
          title: '查看运行历史与状态',
          icon: Clock,
          onClick: onOpenHistory,
        }
      : null,
    // 草稿时「怎么用」仍放更多；已发布提到一级按钮
    !isPublished && openHowTo
      ? {
          id: 'howto',
          label: '怎么用',
          title: '发布后可面板运行 · API · 自动化',
          icon: BookOpen,
          onClick: openHowTo,
        }
      : null,
    onOpenVersions
      ? {
          id: 'versions',
          label: '版本',
          title: '版本快照',
          icon: History,
          onClick: onOpenVersions,
        }
      : null,
    onOpenAudit
      ? {
          id: 'audit',
          label: '操作记录',
          title: '发布 / 修改 / 运行等操作审计',
          icon: ClipboardList,
          onClick: onOpenAudit,
        }
      : null,
    onOpenDebug
      ? {
          id: 'debug',
          label: '单步验证',
          title: '单步运行 / 从此处重跑 / Trace（开发者）',
          icon: Bug,
          active: debugActive,
          onClick: onOpenDebug,
        }
      : null,
    onAutoArrange
      ? {
          id: 'arrange',
          label: '整理视图',
          title: '自适应画布',
          icon: LayoutGrid,
          onClick: onAutoArrange,
        }
      : null,
  ].filter(Boolean) as Array<{
    id: string
    label: string
    title?: string
    icon: typeof Clock
    active?: boolean
    onClick?: () => void
  }>

  return (
    <header
      className={`wf-studio-toolbar${isTauri ? ' wf-studio-toolbar--tauri-chrome' : ''}`}
      {...(isTauri
        ? {
            ...TAURI_DRAG_PROPS,
            title: '拖动窗口 · 双击最大化',
            onDoubleClick: onTitlebarDblClick,
          }
        : {})}
    >
      <div className="wf-studio-toolbar-left" {...(isTauri ? { 'data-tauri-no-drag': '' } : {})}>
        {onBack ? (
          <button type="button" className="wf-toolbar-back" onClick={onBack} title="返回工作流列表">
            <ChevronLeft size={16} strokeWidth={2.25} />
          </button>
        ) : null}

        <div className="wf-toolbar-brand">
          <AppIconTile app={{ id: appId, name: appName }} size="sm" />
          <div className="wf-toolbar-app-meta">
            <div className="wf-toolbar-title-row">
              <input
                className="wf-toolbar-app-title"
                value={titleDraft}
                placeholder="未命名工作流"
                aria-label="工作流名称"
                title={titleDraft}
                onChange={(e) => onTitleChange(e.target.value)}
                onBlur={onTitleBlur}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
              />
              <span
                className={`wf-toolbar-status-badge ${statusClass}`}
                title={
                  isPublished
                    ? '已发布：可填参运行、API、自动化'
                    : status === 'archived'
                      ? '已归档：不可新开运行'
                      : '草稿：可试跑，发布后才能对外调用'
                }
              >
                {statusLabel}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div
        className="wf-studio-toolbar-center"
        role="toolbar"
        aria-label="工具"
        {...(isTauri ? { 'data-tauri-no-drag': '' } : {})}
      >
        <button
          type="button"
          className={`wf-toolbar-icon-btn${drawerOpen ? ' is-active' : ''}`}
          onClick={onToggleDrawer}
          title={drawerOpen ? '收起节点库' : '打开节点库'}
        >
          <Layers size={14} strokeWidth={2} />
          <span className="wf-toolbar-icon-label">节点</span>
        </button>

        {onOpenSettings ? (
          <button
            type="button"
            className="wf-toolbar-icon-btn"
            onClick={onOpenSettings}
            title="工作流目标、执行方式与运行参数"
          >
            <Settings2 size={14} strokeWidth={2} />
            <span className="wf-toolbar-icon-label">设置</span>
          </button>
        ) : null}

        {isPublished && openHowTo ? (
          <button
            type="button"
            className="wf-toolbar-icon-btn"
            onClick={openHowTo}
            title="面板运行 · API · 自动化"
          >
            <BookOpen size={14} strokeWidth={2} />
            <span className="wf-toolbar-icon-label">怎么用</span>
          </button>
        ) : null}

        {moreItems.length ? (
          <div className="wf-toolbar-more" ref={moreWrapRef}>
            <button
              type="button"
              className={`wf-toolbar-icon-btn${moreOpen ? ' is-active' : ''}`}
              aria-expanded={moreOpen}
              aria-haspopup="menu"
              title="更多"
              onClick={() => setMoreOpen((v) => !v)}
            >
              <Ellipsis size={14} strokeWidth={2} />
              <span className="wf-toolbar-icon-label">更多</span>
            </button>
            {moreOpen ? (
              <div className="wf-toolbar-more-menu" role="menu">
                {moreItems.map((item) => {
                  const Icon = item.icon
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="menuitem"
                      className={`wf-toolbar-more-item${item.active ? ' is-active' : ''}`}
                      title={item.title || item.label}
                      onClick={() => {
                        setMoreOpen(false)
                        item.onClick?.()
                      }}
                    >
                      <Icon size={15} strokeWidth={2} />
                      <span>{item.label}</span>
                    </button>
                  )
                })}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {isTauri ? (
        <div className="wf-studio-toolbar-tauri-drag-gap" aria-hidden="true" {...TAURI_DRAG_PROPS} />
      ) : null}

      <div className="wf-studio-toolbar-right" {...(isTauri ? { 'data-tauri-no-drag': '' } : {})}>
        <div className="wf-toolbar-actions" role="group" aria-label="保存与运行">
          <button
            type="button"
            className={`wf-toolbar-action wf-toolbar-action--ghost${dirty ? ' is-dirty' : ''}`}
            disabled={!!busy}
            onClick={onSave}
            title={
              isPublished
                ? '保存并更新已发布定义（线上立即生效）'
                : '保存草稿'
            }
          >
            <Save size={12} strokeWidth={2.1} />
            <span>{busy === 'save' ? '保存中…' : '保存'}</span>
            {dirty && busy !== 'save' ? <i className="wf-toolbar-dirty-dot" aria-hidden /> : null}
          </button>
          <button
            type="button"
            className="wf-toolbar-action wf-toolbar-action--brand"
            disabled={!!busy}
            onClick={onPublish}
            title={isPublished ? '重新发布（刷新对外可用版本）' : '发布后可填参运行、API、自动化'}
          >
            <Send size={12} strokeWidth={2.1} />
            <span>
              {busy === 'publish' ? '发布中…' : isPublished ? '更新发布' : '发布'}
            </span>
          </button>
          {onRun ? (
            <button
              type="button"
              className="wf-toolbar-action wf-toolbar-action--run"
              onClick={onRun}
              title="在画布内填参试跑（草稿也可）"
            >
              <Play size={11} strokeWidth={2.4} fill="currentColor" />
              <span>试跑</span>
            </button>
          ) : null}
        </div>
        {isTauri ? (
          <>
            <span className="wf-studio-toolbar-win-sep" aria-hidden="true" />
            <TauriWindowControls />
          </>
        ) : null}
      </div>
    </header>
  )
}
