/**
 * 会话通知 store -- 目标模式结果汇报等异步事件的通知中心。
 *
 * 后端 SQLite 持久化（evoflow_session_notifications 表），subscribe/epoch 模式
 * （与 session-runtime-store 对齐）。
 * 控制台过滤：`[session-notify]`
 *
 * 数据流：
 *   push  -> POST /api/session-notifications -> refreshFromApi -> notify
 *   mark  -> PATCH /api/session-notifications/read -> refreshFromApi -> notify
 *   clear -> DELETE /api/session-notifications -> refreshFromApi -> notify
 *
 * 去重：后端 fingerprint UNIQUE 约束（session_key:body[:120]），清空后也永久跳过。
 */

import { apiUrlAsync } from '../../lib/api-client.js'

export type SessionNotificationKind = 'goal_closure' | 'goal_error' | 'goal_stopped'

export type SessionNotification = {
  id: string
  sessionKey: string
  /** 会话标题（人类可读），推送时从 sessionsRef 带入 */
  sessionTitle: string
  kind: SessionNotificationKind
  title: string
  outcome: string
  body: string
  ts: number
  read: boolean
}

const MAX_NOTIFICATIONS = 200
const PREFIX = '[session-notify]'
const REFRESH_INTERVAL_MS = 60_000

// ── 内存缓存（从后端 API 加载）──────────────────────────────
let notifications: SessionNotification[] = []
let unreadCount = 0
let epoch = 0
const listeners = new Set<() => void>()

let hydrated = false
let hydrating = false
let refreshTimer: ReturnType<typeof setInterval> | null = null

// ── 清理旧 localStorage 数据 ─────────────────────────────────
try {
  localStorage.removeItem('evopanel-session-notifications-v1')
  localStorage.removeItem('evopanel-session-notifications-seen-v1')
} catch {
  /* ignore */
}

function notify(): void {
  epoch += 1
  listeners.forEach((fn) => {
    try {
      fn()
    } catch {
      /* ignore */
    }
  })
}

async function _fetchJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

function _debug(...args: any[]): void {
  if (typeof console !== 'undefined' && localStorage.getItem('EVOFLOW_NOTIFY_DEBUG') === '1') {
     
    console.log(PREFIX, ...args)
  }
}

/** 从后端加载通知列表 + 未读数，更新内存缓存。 */
async function refreshFromApi(): Promise<void> {
  try {
    const url = await apiUrlAsync('/session-notifications')
    const data = await _fetchJson(url)
    if (data && Array.isArray(data.notifications)) {
      notifications = data.notifications.slice(0, MAX_NOTIFICATIONS)
    }
    if (data && typeof data.unread_count === 'number') {
      unreadCount = data.unread_count
    }
    notify()
  } catch (e) {
    _debug('refresh failed', e)
  }
}

/** 首次加载（幂等）。 */
function hydrate(): void {
  if (hydrated || hydrating) return
  hydrating = true
  refreshFromApi()
    .catch(() => {
      /* ignore */
    })
    .finally(() => {
      hydrated = true
      hydrating = false
    })
  // 定时刷新（捕获后台会话推送的通知）
  if (!refreshTimer) {
    refreshTimer = setInterval(() => {
      refreshFromApi().catch(() => {
        /* ignore */
      })
    }, REFRESH_INTERVAL_MS)
  }
}

// ── 公共 API ────────────────────────────────────────────────

/** 订阅通知变化，返回取消订阅函数。 */
export function subscribeSessionNotifications(listener: () => void): () => void {
  hydrate()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 当前 epoch（用于 useSyncExternalStore / useMemo 依赖）。 */
export function getSessionNotificationsEpoch(): number {
  hydrate()
  return epoch
}

/** 全部通知（最新在前）。 */
export function getAllSessionNotifications(): SessionNotification[] {
  hydrate()
  return notifications
}

/** 未读数量。 */
export function getUnreadSessionNotificationCount(): number {
  hydrate()
  return unreadCount
}

/**
 * 推送一条通知（fire-and-forget）。
 * 后端 fingerprint UNIQUE 约束自动去重：同 sessionKey + body 前 120 字
 * 指纹已存在（含已清除）则不插入。
 */
export function pushSessionNotification(input: {
  sessionKey: string
  sessionTitle?: string
  kind: SessionNotificationKind
  title: string
  outcome: string
  body: string
  ts?: number
}): void {
  hydrate()
  const sk = String(input.sessionKey || '').trim()
  if (!sk) return
  const body = String(input.body || '').trim()
  const ts = input.ts && input.ts > 0 ? input.ts : Date.now()

  void (async () => {
    try {
      const url = await apiUrlAsync('/session-notifications')
      await _fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_key: sk,
          session_title: String(input.sessionTitle || '').trim(),
          kind: input.kind,
          title: String(input.title || '通知'),
          outcome: String(input.outcome || '').trim() || '（未知）',
          body,
          ts_ms: ts,
        }),
      })
      _debug('push ok', { sk, kind: input.kind, bodyLen: body.length })
      await refreshFromApi()
    } catch (e) {
      _debug('push failed', e)
    }
  })()
}

/** 标记单条已读（乐观更新 + 后端同步）。 */
export function markSessionNotificationRead(id: string): void {
  hydrate()
  const nid = String(id || '').trim()
  if (!nid) return
  // 乐观更新
  let changed = false
  notifications = notifications.map((n) => {
    if (n.id === nid && !n.read) {
      changed = true
      return { ...n, read: true }
    }
    return n
  })
  if (changed) {
    unreadCount = Math.max(0, unreadCount - 1)
    notify()
  }
  void (async () => {
    try {
      const url = await apiUrlAsync('/session-notifications/read')
      await _fetchJson(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notification_id: nid }),
      })
      await refreshFromApi()
    } catch {
      /* ignore */
    }
  })()
}

/** 标记全部已读（乐观更新 + 后端同步）。 */
export function markAllSessionNotificationsRead(): void {
  hydrate()
  let changed = false
  notifications = notifications.map((n) => {
    if (!n.read) {
      changed = true
      return { ...n, read: true }
    }
    return n
  })
  if (changed) {
    unreadCount = 0
    notify()
  }
  void (async () => {
    try {
      const url = await apiUrlAsync('/session-notifications/read-all')
      await _fetchJson(url, { method: 'PATCH' })
      await refreshFromApi()
    } catch {
      /* ignore */
    }
  })()
}

/** 清除全部通知（乐观更新 + 后端软删除）。 */
export function clearAllSessionNotifications(): void {
  hydrate()
  if (!notifications.length) return
  // 乐观更新
  notifications = []
  unreadCount = 0
  notify()
  void (async () => {
    try {
      const url = await apiUrlAsync('/session-notifications')
      await _fetchJson(url, { method: 'DELETE' })
      await refreshFromApi()
    } catch {
      /* ignore */
    }
  })()
}

/** 清除指定会话的通知（乐观更新 + 后端软删除）。 */
export function clearSessionNotifications(sessionKey: string): void {
  hydrate()
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  const before = notifications.length
  // 乐观更新
  notifications = notifications.filter((n) => n.sessionKey !== sk)
  if (notifications.length !== before) {
    unreadCount = notifications.reduce((n, x) => (x.read ? n : n + 1), 0)
    notify()
  }
  void (async () => {
    try {
      const url = await apiUrlAsync(
        `/session-notifications/session?session_key=${encodeURIComponent(sk)}`,
      )
      await _fetchJson(url, { method: 'DELETE' })
      await refreshFromApi()
    } catch {
      /* ignore */
    }
  })()
}

// ── 便捷封装：目标模式汇报 ──────────────────────────────────

/**
 * 推送目标完成/结束通知。
 * 与 useGoalMode.emitGoalClosureReport 的 { sessionKey, outcome, body, ts } 对齐。
 */
export function pushGoalClosureNotification(p: {
  sessionKey: string
  sessionTitle?: string
  outcome: string
  body: string
  ts?: number
}): void {
  const outcome = String(p.outcome || '').trim()
  const isError = /异常|错误|error/i.test(outcome)
  const isStopped = /停止|stop/i.test(outcome)
  pushSessionNotification({
    sessionKey: p.sessionKey,
    sessionTitle: p.sessionTitle,
    kind: isError ? 'goal_error' : isStopped ? 'goal_stopped' : 'goal_closure',
    title: isError ? '目标执行异常' : isStopped ? '目标已停止' : '目标完成',
    outcome: outcome || '任务完成',
    body: p.body,
    ts: p.ts && p.ts > 0 ? p.ts : Date.now(),
  })
}
