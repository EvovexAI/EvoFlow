import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'

import {
  DEFAULT_SESSION_MODES,
  modeLabel,
  SHOW_SESSION_MODE_COLLAB_UI,
  type SessionMode,
  type SessionModeDefinition,
} from '../lib/session-mode.js'

export type SessionModePickerProps = {
  sessionMode: SessionMode
  modes?: SessionModeDefinition[] | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelectMode: (mode: SessionMode) => void | Promise<void>
  menuRef?: RefObject<HTMLDivElement | null>
  collabOn?: boolean
  collabPhase?: string
  selectedSessionKey?: string
  onCollabPhasePlanning?: () => void | Promise<void>
  onCollabPhaseExecuting?: () => void | Promise<void>
  /**
   * 挂到 body + fixed，避开输入区上拉后父级 overflow 裁切。
   * 外层点外部关闭请同时识别 `.react-chat-mode-menu--portal`。
   */
  portalFixed?: boolean
}

export function SessionModePicker({
  sessionMode,
  modes,
  open,
  onOpenChange,
  onSelectMode,
  menuRef,
  collabOn = false,
  collabPhase = '',
  selectedSessionKey = '',
  onCollabPhasePlanning,
  onCollabPhaseExecuting,
  portalFixed = false,
}: SessionModePickerProps) {
  const modeList = modes || DEFAULT_SESSION_MODES
  const label = modeLabel(sessionMode, modeList)
  const phase = String(collabPhase || '').trim().toLowerCase()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [portalStyle, setPortalStyle] = useState<CSSProperties | null>(null)

  useLayoutEffect(() => {
    if (!open || !portalFixed || typeof window === 'undefined') {
      setPortalStyle(null)
      return
    }
    const update = () => {
      const btn = triggerRef.current
      if (!btn) return
      const r = btn.getBoundingClientRect()
      const gap = 10
      const sidePad = 10
      const minW = 140
      // 与 absolute `right: 0` 一致：菜单右缘对齐触发按钮右缘
      const right = Math.max(sidePad, window.innerWidth - r.right)
      const bottom = Math.max(sidePad, window.innerHeight - r.top + gap)
      const maxH = Math.max(80, Math.min(window.innerHeight * 0.55, r.top - gap - sidePad))
      setPortalStyle({
        position: 'fixed',
        right,
        left: 'auto',
        bottom,
        top: 'auto',
        minWidth: minW,
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
  }, [open, portalFixed, label])

  const menuBody = open ? (
    <div
      className={`react-chat-mode-menu${portalFixed ? ' react-chat-mode-menu--portal' : ''}`}
      role="menu"
      style={portalFixed ? portalStyle || { display: 'none' } : undefined}
    >
      {modeList
        .filter((m) => m.visible)
        .map((m) => {
          const isActive = m.value === sessionMode
          return (
            <button
              key={m.value}
              type="button"
              className={`react-chat-mode-item${isActive ? ' active' : ''}`}
              onClick={async () => {
                onOpenChange(false)
                await onSelectMode(m.value as SessionMode)
              }}
            >
              {m.label}
            </button>
          )
        })}
      {SHOW_SESSION_MODE_COLLAB_UI && collabOn ? (
        <div className="react-chat-mode-phase-actions">
          {phase === 'executing' ? (
            <button
              type="button"
              className="react-chat-bottom-pill react-chat-bottom-mode-pill"
              disabled={!selectedSessionKey}
              title="回到只读规划阶段"
              onClick={() => void onCollabPhasePlanning?.()}
            >
              回到 Plan
            </button>
          ) : (
            <button
              type="button"
              className="react-chat-bottom-pill react-chat-bottom-mode-pill"
              disabled={!selectedSessionKey}
              title="授权进入执行阶段"
              onClick={() => void onCollabPhaseExecuting?.()}
            >
              Authorize 执行
            </button>
          )}
        </div>
      ) : null}
    </div>
  ) : null

  return (
    <div className="react-chat-mode-menu-wrap" ref={menuRef}>
      <button
        ref={triggerRef}
        type="button"
        className="react-chat-bottom-pill react-chat-bottom-mode-pill"
        onClick={() => onOpenChange(!open)}
        title="切换模式"
      >
        <svg
          className="react-chat-bottom-pill-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M12 2l2.4 6.2L21 9l-5 4 1.6 6.8L12 16.8 6.4 19.8 8 13.1 3 9l6.6-.8L12 2z" />
        </svg>
        <span className="react-chat-bottom-pill-text">{label}</span>
        <span className="react-chat-bottom-pill-caret">▾</span>
      </button>
      {portalFixed && typeof document !== 'undefined' && menuBody
        ? createPortal(menuBody, document.body)
        : menuBody}
    </div>
  )
}
