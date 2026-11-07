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
  workflow_finished: '⚙️',
}

/**
 * 状态 → 中文短标签 + 语义色。
 * outcome 的真实取值有两类：英文枚举（completed / failed / stopped …，如 workflow_finished）
 * 和中文自由文本（「任务完成」「执行过程中发生错误」「已手动停止」「（未知）」，
 * 见 useGoalMode / pushGoalClosureNotification）。徽标只有 17px 高，长句必须归一成短标签，
 * 原文交给 title 悬浮提示，不再塞进徽标。
 */
type OutcomeTone = 'success' | 'danger' | 'warning' | 'muted'

type OutcomeView = { label: string; tone: OutcomeTone; raw: string }

const OUTCOME_LABEL: Record<OutcomeTone, string> = {
  success: '已完成',
  danger: '失败',
  warning: '已停止',
  muted: '',
}

const OUTCOME_MAP: Record<string, { label: string; tone: OutcomeTone }> = {
  completed: { label: '已完成', tone: 'success' },
  complete: { label: '已完成', tone: 'success' },
  success: { label: '已完成', tone: 'success' },
  succeeded: { label: '已完成', tone: 'success' },
  finished: { label: '已完成', tone: 'success' },
  done: { label: '已完成', tone: 'success' },
  ok: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  fail: { label: '失败', tone: 'danger' },
  error: { label: '失败', tone: 'danger' },
  errored: { label: '失败', tone: 'danger' },
  stopped: { label: '已停止', tone: 'warning' },
  stop: { label: '已停止', tone: 'warning' },
  paused: { label: '已暂停', tone: 'warning' },
  cancelled: { label: '已取消', tone: 'warning' },
  canceled: { label: '已取消', tone: 'warning' },
  aborted: { label: '已中止', tone: 'warning' },
  timeout: { label: '超时', tone: 'warning' },
  running: { label: '进行中', tone: 'muted' },
  pending: { label: '等待中', tone: 'muted' },
  queued: { label: '排队中', tone: 'muted' },
}

// 中文 / 混合文本判定，口径与 session-notifications.ts 保持一致（/异常|错误|error/i → 异常，
// /停止|stop/i → 停止），再补中文成功态与取消/超时，顺序有意义：错误 > 停止 > 取消/超时 > 完成。
const RE_DANGER = /异常|错误|出错|失败|报错|超时|error|fail/i
const RE_WARNING = /停止|中止|取消|终止|暂停|stop|cancel|abort|pause/i
const RE_SUCCESS = /完成|成功|结束|已解决|done|success|complete/i

function matchTone(text: string): OutcomeTone | null {
  if (RE_DANGER.test(text)) return 'danger'
  if (RE_WARNING.test(text)) return 'warning'
  // 「未完成 / 未成功 / 没有完成」是失败态，别被 RE_SUCCESS 的「完成」误判
  if (/未(能)?(完成|成功)|没有(完成|成功)/.test(text)) return 'danger'
  if (RE_SUCCESS.test(text)) return 'success'
  return null
}

/** 把任意终态文案归一成「中文短标签 + 色调 + 原文」；认不出的保留原文、中性色。 */
function resolveOutcome(raw: string): OutcomeView | null {
  const text = String(raw || '').trim()
  if (!text) return null
  // 后端兜底占位值，不当作状态展示
  if (/^[（(]?\s*(未知|unknown|null|undefined|none)\s*[）)]?$/i.test(text)) return null

  const key = text.toLowerCase()
  const exact = OUTCOME_MAP[key]
  if (exact) return { ...exact, raw: text }

  // 形如 "completed (3/5)" / "failed: xxx" 的英文带后缀情况，取首个词判定
  const head = key.split(/[\s:：(（,，;；]/)[0]
  if (head && OUTCOME_MAP[head]) return { ...OUTCOME_MAP[head], raw: text }

  // 中文自由文本（真实数据源的主要形态）：判定色调，标签统一用短中文
  const tone = matchTone(text)
  if (tone === 'success' || tone === 'danger' || tone === 'warning') {
    return { label: OUTCOME_LABEL[tone], tone, raw: text }
  }
  return { label: text, tone: 'muted', raw: text }
}

/** 徽标显示的是归一后的短标签时，把原文放 title；未归一时原文就是徽标本身，长文本靠 CSS 截断则始终给 title。 */
function outcomeTooltip(view: OutcomeView): string | undefined {
  return view.raw
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

  const outcome = resolveOutcome(n.outcome)
  const rawOutcome = String(n.outcome || '').trim()
  const bodyText = String(n.body || '').trim()
  // body 常见形态是 "[Run_xxx] failed"：剥掉 run 前缀后若只剩状态本身，就没有信息量，不再占一行
  const bodyPayload = bodyText.replace(/^\s*[[［][^\]］]*[\]］]\s*/, '').trim()
  const bodyIsEcho =
    !bodyPayload ||
    bodyPayload === rawOutcome ||
    bodyPayload === outcome?.raw ||
    bodyPayload.toLowerCase() === outcome?.label.toLowerCase()
  // 判定用剥前缀后的内容，展示仍保留原文（含 run id，便于追溯）
  const showBody = !!bodyText && !bodyIsEcho

  return (
    <div
      className={`session-notify-item${n.read ? ' is-read' : ''}${outcome ? ` is-${outcome.tone}` : ''}`}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      title={outcome ? outcomeTooltip(outcome) : undefined}
    >
      <span className="session-notify-item-icon" aria-hidden="true">
        {kindIcon[n.kind] || '🔔'}
      </span>
      <div className="session-notify-item-body">
        <div className="session-notify-item-title-row">
          <span className="session-notify-item-title">{n.title}</span>
          <span className="session-notify-item-time">{formatTime(n.ts)}</span>
        </div>
        <div className="session-notify-item-meta-row">
          {outcome ? (
            <span
              className={`session-notify-item-badge is-${outcome.tone}`}
              title={outcomeTooltip(outcome)}
            >
              {outcome.label}
            </span>
          ) : null}
          {n.sessionTitle ? (
            <span className="session-notify-item-session">{n.sessionTitle}</span>
          ) : null}
        </div>
        {showBody ? <div className="session-notify-item-text">{bodyText}</div> : null}
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
