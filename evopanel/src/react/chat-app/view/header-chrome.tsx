// @ts-nocheck — mechanical P91 extract.
/**
 * Chat header icon buttons / workspace folder group. Extracted from ChatApp.tsx (P91).
 */
import { useEffect, useState, type ReactNode } from 'react'
import {
  Activity,
  BookOpen,
  Bug,
  ChevronDown,
  CircleHelp,
  Download,
  Folder,
  FolderOpen,
  Globe,
  Info,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  ScrollText,
} from 'lucide-react'
import {
  fetchObsEnabledStatus,
  setObsEnabled,
} from '../../obs/lib/obs-api.js'

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

/** 当前会话：从 DB 重拉历史（多轮错乱 / 误停后对账） */
export function renderSessionHistoryRefreshButton(ctx: {
  disabled?: boolean
  busy?: boolean
  onRefresh: () => void
}): ReactNode {
  const busy = !!ctx.busy
  const title = busy ? '正在刷新对话…' : '刷新对话历史'
  return (
    <button
      type="button"
      className={`react-chat-header-icon-btn react-chat-header-history-refresh-btn${
        busy ? ' is-refreshing' : ''
      }`}
      title={title}
      aria-label={title}
      disabled={!!ctx.disabled || busy}
      data-tauri-no-drag=""
      onClick={() => {
        if (busy || ctx.disabled) return
        ctx.onRefresh()
      }}
    >
      <RefreshCw
        className={`react-chat-header-icon${busy ? ' animate-spin' : ''}`}
        aria-hidden
      />
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

async function toastMsg(message: string, type: 'success' | 'error' | 'info' = 'info') {
  try {
    const { toast } = await import('../../../components/toast.js')
    toast(message, type)
  } catch {
    window.alert(message)
  }
}

/** 主对话顶栏问号：文档 / 系统日志 / 导出日志 / 资源管理器 / 调试模式 / 运维观测 / 更新 / 关于。 */
export function ChatHeaderHelpMenu(): ReactNode {
  const [open, setOpen] = useState(false)
  const [debugOn, setDebugOn] = useState(false)
  const [debugLocked, setDebugLocked] = useState(false)
  const [debugBusy, setDebugBusy] = useState(false)

  const close = () => setOpen(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void fetchObsEnabledStatus()
      .then((st) => {
        if (cancelled) return
        setDebugOn(st.enabled)
        setDebugLocked(st.lockedByEnv)
      })
      .catch(() => {
        if (!cancelled) {
          setDebugOn(false)
          setDebugLocked(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const openDocs = () => {
    close()
    // 内置「EvoFlow 用户指南」owned 知识库（与 page-help.js USER_GUIDE_KB_ID 一致）
    window.location.hash = `/knowledge/owned/${encodeURIComponent('kb_builtin_user_guide')}`
  }

  const openSystemLogs = () => {
    close()
    window.location.hash = '/system-logs'
  }

  const exportLogs = () => {
    close()
    void (async () => {
      await toastMsg('正在导出日志…', 'info')
      try {
        const { api } = await import('../../../lib/tauri-api.js')
        const result = await api.exportLogs()
        if (result?.success) {
          await toastMsg(
            `日志已导出（${result.fileCount || 0} 个文件）${result.path ? `：${result.path}` : ''}`,
            'success',
          )
        } else if (result?.error === '已取消') {
          /* user cancelled */
        } else {
          await toastMsg(`导出日志失败：${result?.error || 'unknown'}`, 'error')
        }
      } catch (e) {
        await toastMsg(`导出日志失败：${e?.message || e}`, 'error')
      }
    })()
  }

  const openResourceManager = () => {
    close()
    void import('../../../lib/resource-manager-overlay.js')
      .then((m) => m.openResourceManagerOverlay())
      .catch((e) => {
        console.error('[resource-manager]', e)
        void toastMsg(`无法打开资源管理器：${e?.message || e}`, 'error')
      })
  }

  const toggleDebugMode = () => {
    if (debugBusy || debugLocked) {
      if (debugLocked) {
        void toastMsg('调试模式被环境变量 EVOFLOW_OBSERVABILITY 锁定，无法在界面切换', 'error')
      }
      return
    }
    const next = !debugOn
    setDebugBusy(true)
    void setObsEnabled(next)
      .then((st) => {
        setDebugOn(st.enabled)
        setDebugLocked(st.lockedByEnv)
        void toastMsg(
          st.enabled
            ? '调试模式已开启：摘要「调试」+ 流式专项日志（~/.evoflow/logs/stream-compare）'
            : '调试模式已关闭（流式专项日志一并关掉）',
          'success',
        )
      })
      .catch((e) => {
        const msg = String(e?.message || e || '')
        if (/org_admin|403|forbidden/i.test(msg)) {
          void toastMsg('需要管理员权限才能开启调试模式', 'error')
        } else if (/locked_by_env|EVOFLOW_OBSERVABILITY/i.test(msg)) {
          setDebugLocked(true)
          void toastMsg('调试模式被环境变量锁定，无法在界面切换', 'error')
        } else {
          void toastMsg(`切换调试模式失败：${msg || 'unknown'}`, 'error')
        }
      })
      .finally(() => setDebugBusy(false))
  }

  const openOpsObservability = () => {
    close()
    window.location.hash = '/observability'
  }

  const checkUpdates = () => {
    close()
    void (async () => {
      try {
        const { openSettingsModal } = await import('../../../components/settings-modal.js')
        await openSettingsModal({ initialTab: 'about' })
        // about 页内自带检查更新按钮；再主动触发一次检测
        const { checkDesktopAppUpdate } = await import('../../../lib/desktop-updater.js')
        const res = await checkDesktopAppUpdate()
        if (res?.available) {
          await toastMsg(`发现新版本 ${res.version || ''}，请在关于页下载/重启`, 'success')
        } else if (res?.error && res.error !== 'not_tauri') {
          await toastMsg(`检查更新失败：${res.error}`, 'error')
        } else {
          await toastMsg('当前已是最新版本', 'success')
        }
      } catch (e) {
        await toastMsg(`检查更新失败：${e?.message || e}`, 'error')
      }
    })()
  }

  const openAbout = () => {
    close()
    void import('../../../components/settings-modal.js')
      .then((m) => m.openSettingsModal({ initialTab: 'about' }))
      .catch((e) => void toastMsg(`无法打开关于页：${e?.message || e}`, 'error'))
  }

  return (
    <div className="react-chat-header-btn-group react-chat-header-btn-group--help">
      <button
        type="button"
        className="react-chat-header-icon-btn"
        data-tauri-no-drag
        title="帮助"
        aria-label="帮助"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <CircleHelp className="react-chat-header-icon" aria-hidden />
      </button>
      {open ? (
        <>
          <div
            className="react-chat-header-menu-scrim"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div className="react-chat-header-menu react-chat-header-menu--end" role="menu">
            <button type="button" role="menuitem" className="react-chat-header-menu-item" onClick={openDocs}>
              <BookOpen className="react-chat-header-icon" aria-hidden />
              <span>查看文档</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="react-chat-header-menu-item"
              onClick={openSystemLogs}
            >
              <ScrollText className="react-chat-header-icon" aria-hidden />
              <span>系统日志</span>
            </button>
            <div className="react-chat-header-menu-sep" aria-hidden="true" />
            <button type="button" role="menuitem" className="react-chat-header-menu-item" onClick={exportLogs}>
              <Download className="react-chat-header-icon" aria-hidden />
              <span>导出日志</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="react-chat-header-menu-item"
              onClick={openResourceManager}
            >
              <Activity className="react-chat-header-icon" aria-hidden />
              <span>资源管理器</span>
            </button>
            <div className="react-chat-header-menu-sep" aria-hidden="true" />
            <button
              type="button"
              role="menuitemcheckbox"
              className="react-chat-header-menu-item react-chat-header-menu-item--toggle"
              aria-checked={debugOn}
              disabled={debugBusy || debugLocked}
              title={
                debugLocked
                  ? '被环境变量 EVOFLOW_OBSERVABILITY 锁定'
                  : '开启后：摘要「调试」+ 落盘流式专项日志（stream-compare）'
              }
              onClick={toggleDebugMode}
            >
              <Bug className="react-chat-header-icon" aria-hidden />
              <span>开启调试模式</span>
              <span
                className={`react-chat-header-menu-switch${debugOn ? ' is-on' : ''}${
                  debugLocked ? ' is-locked' : ''
                }`}
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              role="menuitem"
              className="react-chat-header-menu-item"
              onClick={openOpsObservability}
            >
              <Activity className="react-chat-header-icon" aria-hidden />
              <span>运维观测</span>
            </button>
            <div className="react-chat-header-menu-sep" aria-hidden="true" />
            <button
              type="button"
              role="menuitem"
              className="react-chat-header-menu-item"
              onClick={checkUpdates}
            >
              <RefreshCw className="react-chat-header-icon" aria-hidden />
              <span>检查更新</span>
            </button>
            <button type="button" role="menuitem" className="react-chat-header-menu-item" onClick={openAbout}>
              <Info className="react-chat-header-icon" aria-hidden />
              <span>关于 EvoFlow</span>
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
}
