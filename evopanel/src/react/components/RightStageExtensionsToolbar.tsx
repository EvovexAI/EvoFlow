import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { navigate } from '../../router.js'
import {
  isUserStageExtensionKind,
  USER_STAGE_EXTENSIONS,
  type UserStageExtensionKind,
} from '../../lib/right-stage/right-stage-extensions.js'

const EXTENSION_ICONS: Record<string, React.ReactNode> = {
  'web-embed': (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3.6 9h16.8M3.6 15h16.8" />
      <path d="M12 3a15 15 0 010 18 15 15 0 010-18z" />
    </svg>
  ),
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


type OpenMenu = 'apps' | 'ext' | null




export const RightStageExtensionsToolbar = memo(function RightStageExtensionsToolbar({
  activeKind,
  onSelect,
}: {
  activeKind: string | null
  onSelect: (kind: UserStageExtensionKind) => void
}) {
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const extOpen = openMenu === 'ext'

  const closeMenus = useCallback(() => setOpenMenu(null), [])

  useEffect(() => {
    if (!openMenu) return
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
  }, [openMenu, closeMenus])

  return (
    <div className="react-chat-stage-extensions-root" ref={rootRef}>
      <div className="react-chat-stage-extensions-slot">
        <button
          type="button"
          className={`react-chat-toggle-sidebar-btn react-chat-stage-extensions-toggle-btn${
            isUserStageExtensionKind(activeKind) ? ' is-active' : ''
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
              const active = activeKind === entry.kind
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
