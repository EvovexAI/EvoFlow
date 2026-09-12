import type { MouseEvent } from 'react'
import {
  Bug,
  ChevronLeft,
  Clock,
  History,
  KeyRound,
  Layers,
  LayoutGrid,
  Play,
  Save,
  Send,
  Settings2,
} from 'lucide-react'

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
  appIcon?: string
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
  onOpenApiAccess?: () => void
  onOpenDebug?: () => void
  debugActive?: boolean
  /** 预留：自动整理画布；无复杂布局算法时由父级回调 fitView */
  onAutoArrange?: () => void
}

export function WorkflowToolbar({
  appIcon = '◇',
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
  onOpenApiAccess,
  onOpenDebug,
  debugActive,
  onAutoArrange,
}: Props) {
  const status = String(appStatus || 'draft').toLowerCase()
  const statusLabel =
    status === 'published' ? '已发布' : status === 'archived' ? '已归档' : '草稿'
  const statusClass =
    status === 'published'
      ? 'is-published'
      : status === 'archived'
        ? 'is-archived'
        : 'is-draft'
  const isTauri = isDesktopTauriRuntime()

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
            <ChevronLeft size={20} strokeWidth={2.25} />
          </button>
        ) : null}

        <div className="wf-toolbar-brand">
          <span className="wf-toolbar-app-icon" aria-hidden>
            {appIcon || '◇'}
          </span>
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
                  status === 'published'
                    ? '已发布：列表可填参运行，可创建 API Key'
                    : status === 'archived'
                      ? '已归档：不可新开运行'
                      : '草稿：可在画布调试，发布后才能列表运行 / API'
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
          <Layers size={16} strokeWidth={2} />
          <span className="wf-toolbar-icon-label">节点</span>
        </button>

        {onOpenSettings ? (
          <button
            type="button"
            className="wf-toolbar-icon-btn"
            onClick={onOpenSettings}
            title="工作流设置与运行参数"
          >
            <Settings2 size={16} strokeWidth={2} />
            <span className="wf-toolbar-icon-label">参数</span>
          </button>
        ) : null}

        {onOpenHistory ? (
          <button
            type="button"
            className="wf-toolbar-icon-btn"
            onClick={onOpenHistory}
            title="运行历史"
          >
            <Clock size={16} strokeWidth={2} />
            <span className="wf-toolbar-icon-label">历史</span>
          </button>
        ) : null}

        {onOpenVersions ? (
          <button
            type="button"
            className="wf-toolbar-icon-btn"
            onClick={onOpenVersions}
            title="版本快照"
          >
            <History size={16} strokeWidth={2} />
            <span className="wf-toolbar-icon-label">版本</span>
          </button>
        ) : null}

        {onOpenApiAccess ? (
          <button
            type="button"
            className="wf-toolbar-icon-btn"
            onClick={onOpenApiAccess}
            title="API 访问（发布后对外调用）"
          >
            <KeyRound size={16} strokeWidth={2} />
            <span className="wf-toolbar-icon-label">API</span>
          </button>
        ) : null}

        {onOpenDebug ? (
          <button
            type="button"
            className={`wf-toolbar-icon-btn${debugActive ? ' is-active' : ''}`}
            onClick={onOpenDebug}
            title="调试器：单步运行 / 从此处重跑 / 查看 Trace"
          >
            <Bug size={16} strokeWidth={2} />
            <span className="wf-toolbar-icon-label">调试器</span>
          </button>
        ) : null}

        {onAutoArrange ? (
          <button
            type="button"
            className="wf-toolbar-icon-btn"
            onClick={onAutoArrange}
            title="整理视图（自适应画布）"
          >
            <LayoutGrid size={16} strokeWidth={2} />
            <span className="wf-toolbar-icon-label">整理</span>
          </button>
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
            title="保存草稿（不影响已发布线上版本）"
          >
            <Save size={14} strokeWidth={2.1} />
            <span>{busy === 'save' ? '保存中…' : '保存'}</span>
            {dirty && busy !== 'save' ? <i className="wf-toolbar-dirty-dot" aria-hidden /> : null}
          </button>
          <button
            type="button"
            className="wf-toolbar-action wf-toolbar-action--brand"
            disabled={!!busy}
            onClick={onPublish}
            title="发布后，列表「填参运行」与 API Key 才可用"
          >
            <Send size={14} strokeWidth={2.1} />
            <span>{busy === 'publish' ? '发布中…' : '发布'}</span>
          </button>
          {onRun ? (
            <button
              type="button"
              className="wf-toolbar-action wf-toolbar-action--run"
              onClick={onRun}
              title="在画布内填参试跑（草稿也可）"
            >
              <Play size={13} strokeWidth={2.4} fill="currentColor" />
              <span>调试</span>
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
