import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from 'react'
import { createPortal } from 'react-dom'
import {
  PERMISSION_PRESETS,
  permissionPresetPillLabel,
} from '../../lib/permission-tier.js'

const PERMISSION_LEARN_MORE_HREF = '#/settings?tab=security'

export type PermissionPresetMenuProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  presetId: string
  onSelect: (presetId: string) => void | Promise<void>
  onBeforeOpen?: () => void
  rootRef?: Ref<HTMLDivElement | null>
  manageDismiss?: boolean
  className?: string
}

function PermissionPresetIcon({ kind, className = '' }: { kind: string; className?: string }) {
  if (kind === 'hand') {
    return (
      <svg
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M7 11V8a2 2 0 1 1 4 0v1" />
        <path d="M11 10V7a2 2 0 1 1 4 0v4" />
        <path d="M15 11V9a2 2 0 1 1 4 0v6.5a5.5 5.5 0 0 1-5.5 5.5H11a4 4 0 0 1-4-4v-2.5a2 2 0 0 1 2-2h1.5" />
      </svg>
    )
  }
  if (kind === 'full') {
    return (
      <svg
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <path d="M9 12l2 2 4-4" />
      </svg>
    )
  }
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M8 11h8" />
      <path d="M10 15h4" />
    </svg>
  )
}

export function PermissionPresetMenu({
  open,
  onOpenChange,
  presetId,
  onSelect,
  onBeforeOpen,
  rootRef,
  className = '',
}: PermissionPresetMenuProps) {
  const pillLabel = permissionPresetPillLabel(presetId)
  const activePreset = PERMISSION_PRESETS.find((p) => p.id === presetId)
  const [portalStyle, setPortalStyle] = useState<CSSProperties | null>(null)
  const localRootRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const setRootNode = (node: HTMLDivElement | null) => {
    localRootRef.current = node
    if (typeof rootRef === 'function') rootRef(node)
    else if (rootRef && typeof rootRef === 'object') {
      ;(rootRef as { current: HTMLDivElement | null }).current = node
    }
  }

  useLayoutEffect(() => {
    if (!open || typeof window === 'undefined') {
      setPortalStyle(null)
      return
    }
    const update = () => {
      const btn = triggerRef.current
      if (!btn) return
      const r = btn.getBoundingClientRect()
      const gap = 10
      const sidePad = 10
      const minW = 340
      const left = Math.max(sidePad, Math.min(r.left, window.innerWidth - sidePad - minW))
      const bottom = Math.max(sidePad, window.innerHeight - r.top + gap)
      const maxH = Math.max(160, Math.min(window.innerHeight * 0.55, r.top - gap - sidePad))
      setPortalStyle({
        position: 'fixed',
        left,
        bottom,
        top: 'auto',
        minWidth: minW,
        maxWidth: Math.min(420, window.innerWidth - sidePad * 2),
        maxHeight: maxH,
        zIndex: 10060,
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, pillLabel])

  const menuBody =
    open ? (
      <div
        ref={menuRef}
        className="react-chat-permission-card react-chat-permission-card--portal"
        role="menu"
        aria-label="权限批准方式"
        style={portalStyle || { display: 'none' }}
      >
        <div className="react-chat-permission-card-header">
          <span className="react-chat-permission-card-title">应如何批准 Agent 操作？</span>
          <a
            className="react-chat-permission-card-learn"
            href={PERMISSION_LEARN_MORE_HREF}
            onClick={() => onOpenChange(false)}
          >
            了解更多
          </a>
        </div>
        <div className="react-chat-permission-card-options">
          {PERMISSION_PRESETS.map((tier) => {
            const active = presetId === tier.id
            return (
              <button
                key={tier.id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={`react-chat-permission-option${active ? ' is-active' : ''}`}
                onClick={() => {
                  void Promise.resolve(onSelect(tier.id)).then(() => {
                    onOpenChange(false)
                  })
                }}
              >
                <span className="react-chat-permission-option-icon" aria-hidden="true">
                  <PermissionPresetIcon kind={tier.icon} />
                </span>
                <span className="react-chat-permission-option-body">
                  <span className="react-chat-permission-option-title">{tier.pillLabel}</span>
                  <span className="react-chat-permission-option-desc">{tier.menuDesc}</span>
                </span>
                {active ? (
                  <span className="react-chat-permission-option-check" aria-hidden="true">
                    ✓
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      </div>
    ) : null

  return (
    <div className={`react-chat-bottom-pill-root${className ? ` ${className}` : ''}`} ref={setRootNode}>
      <button
        ref={triggerRef}
        type="button"
        className={`react-chat-bottom-pill react-chat-bottom-permission-pill${
          open ? ' react-chat-bottom-pill--open' : ''
        }${presetId === 'full-access' ? ' react-chat-bottom-permission-pill--full' : ''}`}
        title={`权限：${pillLabel}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => {
          const next = !open
          if (next) onBeforeOpen?.()
          onOpenChange(next)
        }}
      >
        <span className="react-chat-permission-pill-icon" aria-hidden="true">
          <PermissionPresetIcon kind={activePreset?.icon || 'shield'} />
        </span>
        <span className="react-chat-bottom-pill-text">{pillLabel}</span>
      </button>
      {open && typeof document !== 'undefined' ? createPortal(menuBody, document.body) : null}
    </div>
  )
}
