/**
 * 会话旁子工作图标诊断（出现 / 状态变化 / 完成消失）。
 *
 * ## 落点
 * 1. DevTools Console：过滤 `[session-child-work]`
 * 2. 桌面端：`~/.evoflow/logs/frontend-YYYY-MM-DD.log`（`append_frontend_log`）
 *
 * 关闭：localStorage.setItem('EVOFLOW_SESSION_CHILD_WORK_LOG', '0')
 */
import type { SessionChildWorkItem } from './session-reattach.js'

const PREFIX = '[session-child-work]'
const LS_ENABLE_KEY = 'EVOFLOW_SESSION_CHILD_WORK_LOG'
const ACTIVE = new Set(['pending', 'running'])

function isActive(status: string | null | undefined): boolean {
  return ACTIVE.has(String(status || '').trim().toLowerCase())
}

export type SessionChildWorkLogEvent =
  | 'appear'
  | 'status_change'
  | 'complete'
  | 'disappear'
  | 'icon_click'
  | 'pane_open'

type Snap = {
  workId: string
  kind: string
  refId: string
  status: string
  title: string
  active: boolean
}

const prevBySession = new Map<string, Map<string, Snap>>()

function enabled(): boolean {
  try {
    if (typeof localStorage === 'undefined') return true
    return localStorage.getItem(LS_ENABLE_KEY) !== '0'
  } catch {
    return true
  }
}

function workKey(w: SessionChildWorkItem): string {
  const wid = String(w.workId || '').trim()
  if (wid) return wid
  return `${String(w.kind || '').trim()}:${String(w.refId || '').trim()}`
}

function toSnap(w: SessionChildWorkItem): Snap {
  const status = String(w.status || '').trim()
  return {
    workId: workKey(w),
    kind: String(w.kind || '').trim() || 'unknown',
    refId: String(w.refId || '').trim(),
    status,
    title: String(w.title || '').trim(),
    active: isActive(status),
  }
}

function emit(
  event: SessionChildWorkLogEvent,
  opts: {
    sessionKey: string
    snap: Snap
    prevStatus?: string
    level?: 'info' | 'warn'
    detail?: Record<string, unknown>
  },
): void {
  if (!enabled()) return
  const at = new Date().toISOString()
  const { sessionKey, snap, prevStatus, level = 'info', detail } = opts
  const title = snap.title || snap.refId || snap.workId
  let zh = ''
  if (event === 'appear') {
    zh = `图标出现 · ${snap.kind}「${title}」状态=${snap.status}`
  } else if (event === 'status_change') {
    zh = `状态变化 · ${snap.kind}「${title}」${prevStatus || '?'} → ${snap.status}`
  } else if (event === 'complete') {
    zh = `完成收口 · ${snap.kind}「${title}」终态=${snap.status}（图标将消失）`
  } else if (event === 'disappear') {
    zh = `从列表消失 · ${snap.kind}「${title}」上次状态=${prevStatus || '?'}`
  } else if (event === 'icon_click') {
    zh = `点击图标 · ${snap.kind}「${title}」状态=${snap.status}`
  } else if (event === 'pane_open') {
    zh = `打开运行面板 · focus=${snap.kind || 'all'}`
  }

  const payload = {
    at,
    event,
    zh,
    sessionKey,
    workId: snap.workId,
    kind: snap.kind,
    refId: snap.refId,
    title: snap.title,
    status: snap.status,
    prevStatus: prevStatus || undefined,
    active: snap.active,
    ...(detail || {}),
  }

  const line = `${PREFIX} ${zh} | ${JSON.stringify(payload)}`
  try {
    if (level === 'warn') console.warn(line)
    else console.info(line)
  } catch {
    /* ignore */
  }
  try {
    void import('../../lib/tauri-api.js')
      .then((m) => m.appendFrontendLog?.(level, line.slice(0, 11_500)))
      .catch(() => {})
  } catch {
    /* ignore */
  }
}

/** Diff poll snapshot → appear / status_change / complete / disappear. */
export function logSessionChildWorksDiff(
  sessionKey: string,
  works: SessionChildWorkItem[],
): void {
  const sk = String(sessionKey || '').trim()
  if (!sk || !enabled()) return

  const next = new Map<string, Snap>()
  for (const w of works) {
    const snap = toSnap(w)
    if (!snap.workId || snap.workId === ':') continue
    next.set(snap.workId, snap)
  }

  const prev = prevBySession.get(sk) || new Map<string, Snap>()

  for (const [id, snap] of next) {
    const old = prev.get(id)
    if (!old) {
      if (snap.active) {
        emit('appear', { sessionKey: sk, snap })
      }
      continue
    }
    if (old.status !== snap.status) {
      emit('status_change', {
        sessionKey: sk,
        snap,
        prevStatus: old.status,
      })
      if (old.active && !snap.active) {
        emit('complete', {
          sessionKey: sk,
          snap,
          prevStatus: old.status,
        })
      } else if (!old.active && snap.active) {
        emit('appear', {
          sessionKey: sk,
          snap,
          prevStatus: old.status,
          detail: { reappeared: true },
        })
      }
    }
  }

  for (const [id, old] of prev) {
    if (next.has(id)) continue
    if (old.active) {
      emit('disappear', {
        sessionKey: sk,
        snap: old,
        prevStatus: old.status,
        detail: { reason: 'dropped_from_execution_state' },
      })
    }
  }

  prevBySession.set(sk, next)
}

export function logSessionChildWorkIconClick(opts: {
  sessionKey: string
  focusKind?: string | null
  works?: SessionChildWorkItem[]
}): void {
  const sk = String(opts.sessionKey || '').trim()
  if (!sk || !enabled()) return
  const focus = String(opts.focusKind || '').trim()
  const pool = Array.isArray(opts.works) ? opts.works : []
  const focused = focus
    ? pool.filter((w) => String(w.kind || '') === focus && isActive(w.status))
    : pool.filter((w) => isActive(w.status))
  const first = focused[0]
  const snap: Snap = first
    ? toSnap(first)
    : {
        workId: '',
        kind: focus || 'all',
        refId: '',
        status: '',
        title: '',
        active: focused.length > 0,
      }
  emit('icon_click', {
    sessionKey: sk,
    snap,
    detail: {
      focusKind: focus || null,
      activeCount: focused.length,
      titles: focused.map((w) => String(w.title || w.refId || '').trim()).filter(Boolean).slice(0, 8),
    },
  })
  emit('pane_open', {
    sessionKey: sk,
    snap,
    detail: { focusKind: focus || null, activeCount: focused.length },
  })
}

export function resetSessionChildWorkLog(sessionKey?: string | null): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) {
    prevBySession.clear()
    return
  }
  prevBySession.delete(sk)
}
