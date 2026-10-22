// @ts-nocheck — mechanical P91 extract.
/**
 * Chat header icon buttons / workspace folder group. Extracted from ChatApp.tsx (P91).
 */
import type { ReactNode } from 'react'
import { ChevronDown, Folder, FolderOpen, Globe, PanelRightClose, PanelRightOpen } from 'lucide-react'

export function renderBrowserToggleButton(ctx: {
  browserStageActive: boolean
  browserStageOpen: boolean
  toggleBrowserStage: () => void
}): ReactNode {
  const browserToggleTitle = ctx.browserStageOpen ? '隐藏浏览器' : '打开浏览器'
  return (
    <button
      type="button"
      className={`react-chat-header-icon-btn react-chat-browser-stage-toggle-btn${
        ctx.browserStageActive ? ' is-active' : ''
      }`}
      title={browserToggleTitle}
      aria-label={browserToggleTitle}
      aria-pressed={ctx.browserStageOpen}
      onClick={ctx.toggleBrowserStage}
    >
      <Globe className="react-chat-header-icon" aria-hidden />
    </button>
  )
}

export function renderInfoRailHeaderToggle(ctx: {
  rightStageOpen: boolean
  toggleInfoRail: () => void
}): ReactNode {
  return (
    <button
      type="button"
      className={`react-chat-header-icon-btn${ctx.rightStageOpen ? ' is-active' : ''}`}
      title={ctx.rightStageOpen ? '收起右侧面板' : '打开右侧面板'}
      aria-pressed={ctx.rightStageOpen}
      aria-label={ctx.rightStageOpen ? '收起右侧面板' : '打开右侧面板'}
      data-info-rail-open={ctx.rightStageOpen ? 'true' : 'false'}
      data-right-stage-open={ctx.rightStageOpen ? 'true' : 'false'}
      onClick={ctx.toggleInfoRail}
    >
      {ctx.rightStageOpen ? (
        <PanelRightClose className="react-chat-header-icon" aria-hidden />
      ) : (
        <PanelRightOpen className="react-chat-header-icon" aria-hidden />
      )}
    </button>
  )
}

export function renderWorkspaceFolderToggleButton(ctx: {
  workspaceStageActive: boolean
  workspacePanelOpen: boolean
  workspaceFolderToggleTitle: string
  toggleWorkspacePanel: () => void
}): ReactNode {
  return (
    <button
      type="button"
      className={`react-chat-header-icon-btn react-chat-workspace-folder-btn${
        ctx.workspaceStageActive ? ' is-active' : ''
      }`}
      title={ctx.workspaceFolderToggleTitle}
      aria-label={ctx.workspaceFolderToggleTitle}
      aria-pressed={ctx.workspacePanelOpen}
      onClick={ctx.toggleWorkspacePanel}
    >
      <Folder className="react-chat-header-icon" aria-hidden />
    </button>
  )
}

export function renderWorkspaceFolderGroup(ctx: {
  workspaceFolderMenuOpen: boolean
  workspaceFolderToggleTitle: string
  openCurrentWorkspaceInFileManager: () => void | Promise<void>
  setWorkspaceFolderMenuOpen: (v: boolean | ((prev: boolean) => boolean)) => void
  toggleWorkspacePanel: () => void
}): ReactNode {
  return (
    <div className="react-chat-header-btn-group">
      <button
        type="button"
        className="react-chat-header-icon-btn react-chat-header-btn-group-main"
        data-tauri-no-drag
        title="在资源管理器中打开工作区"
        aria-label="在资源管理器中打开工作区"
        onClick={() => {
          void ctx.openCurrentWorkspaceInFileManager()
        }}
      >
        <FolderOpen className="react-chat-header-icon" aria-hidden />
      </button>
      <button
        type="button"
        className="react-chat-header-icon-btn react-chat-header-btn-group-more"
        data-tauri-no-drag
        title="选择打开方式"
        aria-label="选择打开方式"
        aria-haspopup="menu"
        aria-expanded={ctx.workspaceFolderMenuOpen}
        onClick={() => ctx.setWorkspaceFolderMenuOpen((v) => !v)}
      >
        <ChevronDown className="react-chat-header-icon react-chat-header-icon--xs" aria-hidden />
      </button>
      {ctx.workspaceFolderMenuOpen ? (
        <>
          <div
            className="react-chat-header-menu-scrim"
            onClick={() => ctx.setWorkspaceFolderMenuOpen(false)}
            aria-hidden="true"
          />
          <div className="react-chat-header-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              className="react-chat-header-menu-item"
              onClick={() => {
                ctx.setWorkspaceFolderMenuOpen(false)
                ctx.toggleWorkspacePanel()
              }}
            >
              <Folder className="react-chat-header-icon" aria-hidden />
              <span>{ctx.workspaceFolderToggleTitle}</span>
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
}
