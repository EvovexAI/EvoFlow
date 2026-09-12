/**
 * 会话通知中心 -- header 右侧铃铛 + 下拉面板。
 *
 * 数据源：session-notifications.ts（subscribe/epoch）。
 * 交互：点击铃铛展开/收起面板，显示通知列表，支持单条已读、全部已读、清空。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  subscribeSessionNotifications,
  getAllSessionNotifications,
  getUnreadSessionNotificationCount,
  markSessionNotificationRead,
  markAllSessionNotificationsRead,
  clearAllSessionNotifications,
  type SessionNotification,
} from '../lib/session-notifications.js'

const kindIcon: Record<string, string> = {
  goal_closure: '✅',
  goal_error: '⚠️',
  goal_stopped: '⏹',
}

function formatTime(ts: number | string | undefined): string {
  let ms: number
  if (typeof ts === 'string') {
    ms = new Date(ts).getTime()
  } else {
    ms = ts || 0
  }
  if (!ms || ms <= 0) ms = Date.now()
  const d = new Date(ms)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  if (sameDay) return `${hh}:${mm}`
  const mo = (d.getMonth() + 1).toString().padStart(2, '0')
  const dd = d.getDate().toString().padStart(2, '0')
  return `${mo}/${dd} ${hh}:${mm}`
}

function NotificationItem({
  n,
  onRead,
}: {
  n: SessionNotification
  onRead: (id: string) => void
}) {
  const handleClick = useCallback(() => {
    if (!n.read) onRead(n.id)
  }, [n.id, n.read, onRead])

  return (
    <div
      className={`session-notify-item${n.read ? ' is-read' : ''}`}
      onClick={handleClick}
      role="button"
      tabIndex={0}
    >
      <span className="session-notify-item-icon" aria-hidden="true">
        {kindIcon[n.kind] || '🔔'}
      </span>
      <div className="session-notify-item-body">
        <div className="session-notify-item-title-row">
          <span className="session-notify-item-title">{n.title}</span>
          <span className="session-notify-item-time">{formatTime(n.ts)}</span>
        </div>
        {n.sessionTitle ? (
          <div className="session-notify-item-session">{n.sessionTitle}</div>
        ) : null}
        <div className="session-notify-item-outcome">{n.outcome}</div>
        {n.body ? <div className="session-notify-item-text">{n.body}</div> : null}
      </div>
      {!n.read ? <span className="session-notify-item-dot" aria-hidden="true" /> : null}
    </div>
  )
}

const PANEL_WIDTH = 380
const PANEL_GAP = 6

export function SessionNotificationCenter() {
  const [, forceRender] = useState(0)
  const [open, setOpen] = useState(false)
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({})
  const rootRef = useRef<HTMLDivElement>(null)
  const bellRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // subscribe to store
  useEffect(() => {
    const unsub = subscribeSessionNotifications(() => forceRender((x) => x + 1))
    return unsub
  }, [])

  // compute panel position via bell rect (fixed positioning, portal to body)
  const computePanelStyle = useCallback(() => {
    const bell = bellRef.current
    if (!bell) return
    const rect = bell.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight

    const maxH = Math.min(480, vh * 0.7)

    // horizontal: right-align panel to bell's right edge, clamp to viewport
    let left = rect.right - PANEL_WIDTH
    if (left < 8) left = 8
    if (left + PANEL_WIDTH > vw - 8) left = vw - 8 - PANEL_WIDTH

    // vertical: open upward, panel bottom touches bell top
    const panelH = panelRef.current?.offsetHeight || maxH
    let top = rect.top - panelH - PANEL_GAP
    if (top < 8) {
      // not enough space above → fall back to downward
      top = rect.bottom + PANEL_GAP
      if (top + maxH > vh - 8) top = vh - 8 - maxH
    }

    setPanelStyle({
      position: 'fixed',
      left: `${Math.round(left)}px`,
      top: `${Math.round(top)}px`,
      width: `${PANEL_WIDTH}px`,
      maxHeight: `${Math.round(maxH)}px`,
      zIndex: 10000,
    })
  }, [])

  // recompute on open + viewport changes
  useLayoutEffect(() => {
    if (!open) return
    computePanelStyle()
    const onResize = () => computePanelStyle()
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onResize, true)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onResize, true)
    }
  }, [open, computePanelStyle])

  // close on outside click (check both root and portal panel)
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        (rootRef.current && rootRef.current.contains(target)) ||
        (panelRef.current && panelRef.current.contains(target))
      ) {
        return
      }
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open])

  const allNotifications = getAllSessionNotifications()
  const unreadCount = getUnreadSessionNotificationCount()

  const handleToggle = useCallback(() => {
    setOpen((v) => !v)
  }, [])

  const handleReadAll = useCallback(() => {
    markAllSessionNotificationsRead()
  }, [])

  const handleClearAll = useCallback(() => {
    clearAllSessionNotifications()
  }, [])

  const handleRead = useCallback((id: string) => {
    markSessionNotificationRead(id)
  }, [])

  return (
    <div className="session-notify-center" ref={rootRef}>
      <button
        type="button"
        ref={bellRef}
        className={`react-chat-toggle-sidebar-btn session-notify-bell${open ? ' is-hidden' : ''}`}
        title="会话通知"
        aria-pressed={open}
        aria-label="会话通知"
        onClick={handleToggle}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
          <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 01-3.46 0" />
        </svg>
        {unreadCount > 0 ? (
          <span className="session-notify-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
        ) : null}
      </button>
      {open ? (
        createPortal(
          <div
            className="session-notify-panel session-notify-panel--fixed"
            ref={panelRef}
            style={panelStyle}
            role="dialog"
            aria-label="会话通知"
          >
            <div className="session-notify-panel-header">
              <span className="session-notify-panel-title">会话通知</span>
              <div className="session-notify-panel-actions">
                {unreadCount > 0 ? (
                  <button type="button" className="session-notify-panel-action-btn" onClick={handleReadAll}>
                    全部已读
                  </button>
                ) : null}
                {allNotifications.length > 0 ? (
                  <button type="button" className="session-notify-panel-action-btn" onClick={handleClearAll}>
                    清空
                  </button>
                ) : null}
                <button
                  type="button"
                  className="session-notify-panel-action-btn session-notify-panel-close"
                  onClick={() => setOpen(false)}
                  aria-label="关闭"
                >
                  ✕
                </button>
              </div>
            </div>
            <div className="session-notify-panel-body">
              {allNotifications.length === 0 ? (
                <div className="session-notify-empty">暂无通知</div>
              ) : (
                allNotifications.map((n) => (
                  <NotificationItem key={n.id} n={n} onRead={handleRead} />
                ))
              )}
            </div>
          </div>,
          document.body,
        )
      ) : null}
    </div>
  )
}
