import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { navigate } from '../../router.js'
import {
  isUserStageExtensionKind,
  USER_STAGE_EXTENSIONS,
  type UserStageExtensionKind,
} from '../../lib/right-stage/right-stage-extensions.js'
import {
  listEnabledUiExtensions,
  onUiExtensionsChanged,
  resolveUiExtensionIconSrc,
} from '../../lib/ui-extensions.js'

const EXTENSION_ICONS: Record<string, React.ReactNode> = {
  'web-embed': (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3.6 9h16.8M3.6 15h16.8" />
      <path d="M12 3a15 15 0 010 18 15 15 0 010-18z" />
    </svg>
  ),
}

function AppsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" aria-hidden>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  )
}

function ExtensionsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" aria-hidden>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <path d="M14 17.5h7M17.5 14v7" />
    </svg>
  )
}

type InstalledExt = {
  id: string
  name: string
  description: string
  row: Record<string, unknown>
}

type OpenMenu = 'apps' | 'ext' | null

function extDisplayName(row: Record<string, unknown>): string {
  const m = (row.manifest || {}) as Record<string, unknown>
  return String(m.name || row.id || '').trim() || String(row.id || '扩展')
}

function extDescription(row: Record<string, unknown>): string {
  const m = (row.manifest || {}) as Record<string, unknown>
  return String(m.description || m.summary || '').trim() || '已安装扩展'
}

function ExtIcon({ row }: { row: Record<string, unknown> }) {
  const m = (row.manifest || {}) as Record<string, unknown>
  const resolved = resolveUiExtensionIconSrc(
    m.icon,
    String(row.install_path || row.installPath || ''),
    String(row.iconSrc || row.icon_src || ''),
  )
  if (resolved.kind === 'img') {
    return <img src={resolved.src} alt="" width={16} height={16} />
  }
  if (resolved.kind === 'glyph') {
    return <span aria-hidden>{resolved.text}</span>
  }
  return <AppsIcon />
}

export const RightStageExtensionsToolbar = memo(function RightStageExtensionsToolbar({
  activeKind,
  activeExtensionId = '',
  onSelect,
  onOpenUiExtension,
}: {
  activeKind: string | null
  /** Installed extension currently shown in the right-stage embed. */
  activeExtensionId?: string
  onSelect: (kind: UserStageExtensionKind) => void
  /** Open an installed UI extension in the right-stage browser embed. */
  onOpenUiExtension?: (extensionId: string) => void
}) {
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null)
  const [installed, setInstalled] = useState<InstalledExt[]>([])
  const rootRef = useRef<HTMLDivElement>(null)
  const activeExt = String(activeExtensionId || '').trim()
  const appsOpen = openMenu === 'apps'
  const extOpen = openMenu === 'ext'
  const hasApps = installed.length > 0

  const closeMenus = useCallback(() => setOpenMenu(null), [])

  const refreshInstalled = useCallback(async () => {
    try {
      const rows = await listEnabledUiExtensions()
      setInstalled(
        (rows || []).map((row) => {
          const r = row as Record<string, unknown>
          const id = String(r.id || '').trim()
          return {
            id,
            name: extDisplayName(r),
            description: extDescription(r),
            row: r,
          }
        }).filter((x) => x.id),
      )
    } catch {
      setInstalled([])
    }
  }, [])

  useEffect(() => {
    void refreshInstalled()
    return onUiExtensionsChanged(() => {
      void refreshInstalled()
    })
  }, [refreshInstalled])

  useEffect(() => {
    if (!openMenu) return
    void refreshInstalled()
    const onDoc = (ev: MouseEvent) => {
      const root = rootRef.current
      if (!root || !(ev.target instanceof Node) || root.contains(ev.target)) return
      closeMenus()
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') closeMenus()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [openMenu, closeMenus, refreshInstalled])

  return (
    <div className="react-chat-stage-extensions-root" ref={rootRef}>
      {hasApps ? (
        <div className="react-chat-stage-extensions-slot">
          <button
            type="button"
            className={`react-chat-toggle-sidebar-btn react-chat-stage-apps-toggle-btn${
              activeExt ? ' is-active' : ''
            }${appsOpen ? ' is-menu-open' : ''}`}
            title="应用"
            aria-label="应用"
            aria-haspopup="menu"
            aria-expanded={appsOpen}
            onClick={() => setOpenMenu((v) => (v === 'apps' ? null : 'apps'))}
          >
            <AppsIcon />
          </button>
          {appsOpen ? (
            <div className="react-chat-stage-extensions-menu react-chat-stage-extensions-menu--apps" role="menu">
              <div className="react-chat-stage-extensions-menu-head">应用</div>
              <div className="react-chat-stage-extensions-menu-scroll">
                {installed.map((ext) => (
                  <button
                    key={ext.id}
                    type="button"
                    role="menuitem"
                    className={`react-chat-stage-extensions-menu-item${
                      activeExt === ext.id ? ' is-active' : ''
                    }`}
                    onClick={() => {
                      closeMenus()
                      if (onOpenUiExtension) {
                        onOpenUiExtension(ext.id)
                      } else {
                        navigate(`/extensions/${encodeURIComponent(ext.id)}`)
                      }
                    }}
                  >
                    <span className="react-chat-stage-extensions-menu-item-icon">
                      <ExtIcon row={ext.row} />
                    </span>
                    <span className="react-chat-stage-extensions-menu-item-text">
                      <span className="react-chat-stage-extensions-menu-item-label">{ext.name}</span>
                      <span className="react-chat-stage-extensions-menu-item-desc">{ext.description}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="react-chat-stage-extensions-slot">
        <button
          type="button"
          className={`react-chat-toggle-sidebar-btn react-chat-stage-extensions-toggle-btn${
            isUserStageExtensionKind(activeKind) && !activeExt ? ' is-active' : ''
          }${extOpen ? ' is-menu-open' : ''}`}
          title="扩展"
          aria-label="扩展"
          aria-haspopup="menu"
          aria-expanded={extOpen}
          onClick={() => setOpenMenu((v) => (v === 'ext' ? null : 'ext'))}
        >
          <ExtensionsIcon />
        </button>
        {extOpen ? (
          <div className="react-chat-stage-extensions-menu" role="menu">
            <div className="react-chat-stage-extensions-menu-head">扩展</div>
            {USER_STAGE_EXTENSIONS.map((entry) => {
              const active = activeKind === entry.kind && !activeExt
              return (
                <button
                  key={entry.kind}
                  type="button"
                  role="menuitem"
                  className={`react-chat-stage-extensions-menu-item${active ? ' is-active' : ''}`}
                  onClick={() => {
                    closeMenus()
                    onSelect(entry.kind)
                  }}
                >
                  <span className="react-chat-stage-extensions-menu-item-icon">
                    {EXTENSION_ICONS[entry.kind] || <ExtensionsIcon />}
                  </span>
                  <span className="react-chat-stage-extensions-menu-item-text">
                    <span className="react-chat-stage-extensions-menu-item-label">{entry.label}</span>
                    <span className="react-chat-stage-extensions-menu-item-desc">{entry.description}</span>
                  </span>
                </button>
              )
            })}
            <div className="react-chat-stage-extensions-menu-sep" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="react-chat-stage-extensions-menu-item"
              onClick={() => {
                closeMenus()
                navigate('/extensions')
              }}
            >
              <span className="react-chat-stage-extensions-menu-item-icon">
                <ExtensionsIcon />
              </span>
              <span className="react-chat-stage-extensions-menu-item-text">
                <span className="react-chat-stage-extensions-menu-item-label">扩展应用中心</span>
                <span className="react-chat-stage-extensions-menu-item-desc">安装与管理扩展</span>
              </span>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
})
