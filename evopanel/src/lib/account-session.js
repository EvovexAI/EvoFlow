/**
 * Current account session helpers (identity + WebUI JWT switch-user).
 */
import { getMe } from './identity-api.js'
import { clearAuthToken, getAuthToken, hasAuthToken } from './webui-remote.js'

/** @type {any | null} */
let _meCache = null
/** @type {Promise<any | null> | null} */
let _meInflight = null

const ACCOUNT_LS_KEYS = [
  'evoflow-chat-session-map-v1',
  'evopanel_workspace_history_by_session_v1',
  'evopanel_workspace_history_global_v1',
  'evopanel_local_workspace_root',
  'evopanel_local_workspace_history',
  'evopanel-chat-session-meta',
  'evopanel-chat-session-names',
  'evopanel-chat-selected-session',
  'evopanel_last_selected_session',
  'evoflow_tasks_cache',
  'evoflow_panel_state',
  'evoflow_event_stream_state',
  'evoflow_conversation_panels',
  'evopanel-chat-session-names',
]

const ACCOUNT_LS_PREFIXES = ['evopanel_sessions_snapshot']

export function getCachedMe() {
  return _meCache
}

/** Clear chat / session local caches that are not scoped per principal. */
export function clearAccountLocalState({ clearIndexedDb = true } = {}) {
  _meCache = null
  _meInflight = null
  for (const k of ACCOUNT_LS_KEYS) {
    try {
      localStorage.removeItem(k)
    } catch {
      /* ignore */
    }
  }
  try {
    const toRemove = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (!key) continue
      if (ACCOUNT_LS_PREFIXES.some((p) => key.startsWith(p))) toRemove.push(key)
    }
    for (const key of toRemove) localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
  try {
    sessionStorage.removeItem('evopanel_shell_sidebar_sync')
  } catch {
    /* ignore */
  }
  try {
    // Dynamic import avoids circular deps with ws-client.
    import('./ws-client.js')
      .then((m) => {
        try {
          m.wsClient?.invalidateSessionsListCache?.()
        } catch {
          /* ignore */
        }
      })
      .catch(() => {})
  } catch {
    /* ignore */
  }
  if (clearIndexedDb) {
    try {
      const req = indexedDB.deleteDatabase('evopanel-messages')
      req.onsuccess = () => {}
      req.onerror = () => {}
      req.onblocked = () => {}
    } catch {
      /* ignore */
    }
  }
  try {
    window.dispatchEvent(new CustomEvent('evoflow:account-changed', { detail: null }))
  } catch {
    /* ignore */
  }
}

/**
 * Call after a successful login / token swap (before reload).
 * @param {string} [token]
 */
export function prepareAccountSwitch(token) {
  clearAccountLocalState({ clearIndexedDb: true })
  if (token) {
    try {
      sessionStorage.setItem('evopanel_account_switched', '1')
    } catch {
      /* ignore */
    }
  }
}

export async function refreshMe({ retries = 2 } = {}) {
  if (_meInflight) return _meInflight
  _meInflight = (async () => {
    let lastErr = null
    for (let i = 0; i <= retries; i += 1) {
      try {
        _meCache = await getMe()
        lastErr = null
        break
      } catch (err) {
        lastErr = err
        _meCache = null
        if (i < retries) {
          await new Promise((r) => setTimeout(r, 200 * (i + 1)))
        }
      }
    }
    try {
      window.dispatchEvent(new CustomEvent('evoflow:account-changed', { detail: _meCache }))
    } catch {
      /* ignore */
    }
    if (lastErr && !_meCache) {
      console.warn('[account-session] refreshMe failed', lastErr)
    }
    return _meCache
  })()
  try {
    return await _meInflight
  } finally {
    _meInflight = null
  }
}

/** Ensure me is loaded once (shared by shell + chat send). */
export async function ensureMeReady() {
  if (_meCache?.principalId) return _meCache
  return refreshMe()
}

export function isJwtSession() {
  return hasAuthToken() || Boolean(_meCache?.canLogout) || _meCache?.authSource === 'jwt'
}

/** Navigate to switch-user login (keeps local admin until new login succeeds). */
export function navigateSwitchUser(redirect = '/chat') {
  const q = new URLSearchParams({
    switch: '1',
    redirect: redirect.startsWith('/') ? redirect : `/${redirect}`,
  })
  window.location.hash = `/login?${q.toString()}`
  // Same hash won't fire hashchange — force route reload
  if ((window.location.hash.slice(1).split('?')[0] || '') === '/login') {
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  }
}

/** Clear JWT and reload → localhost falls back to local admin. */
export function logoutToLocalAdmin() {
  clearAccountLocalState({ clearIndexedDb: true })
  clearAuthToken()
  const path = (window.location.hash || '#/chat').replace(/^#/, '') || '/chat'
  if (path.startsWith('/login')) {
    window.location.hash = '/chat'
  }
  window.location.reload()
}

export function initialsFromName(name) {
  const s = String(name || '').trim()
  if (!s) return '?'
  const parts = s.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return s.slice(0, 2).toUpperCase()
}

export function sessionLabel(me) {
  if (!me) return hasAuthToken() ? '同步中…' : '未加载'
  const name = String(me.displayName || me.username || me.principalId || '用户').trim()
  return name || '用户'
}

export function sessionHint(me) {
  if (!me) return hasAuthToken() ? '正在同步身份' : ''
  if (me.authSource === 'jwt' || getAuthToken()) {
    return me.username ? `@${me.username}` : '已登录'
  }
  if (me.isOrgAdmin) return '本机免登 · 管理员'
  return '本机免登'
}

/** SVG person icon — default when user has no custom avatar (avoid letter clutter). */
export function userAvatarIconSvg(size = 16) {
  const s = Number(size) || 16
  return `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`
}

/**
 * Absolute or same-origin URL for a principal avatar image.
 * @param {any} me
 * @param {string} [gatewayBase]
 */
export function userAvatarUrl(me, gatewayBase = '') {
  if (!me?.hasAvatar) return ''
  const pid = String(me.principalId || '').trim()
  if (!pid) return ''
  const rev = me.avatarRev ? `?v=${encodeURIComponent(String(me.avatarRev))}` : ''
  const path = me.avatarUrl
    ? String(me.avatarUrl)
    : `/api/identity/principals/${encodeURIComponent(pid)}/avatar${rev}`
  const p = path.startsWith('/api/') || path.startsWith('http') ? path : `/api${path.startsWith('/') ? '' : '/'}${path}`
  if (!gatewayBase) return p.startsWith('http') ? p : p
  if (p.startsWith('http')) return p
  return `${String(gatewayBase).replace(/\/$/, '')}${p.startsWith('/') ? p : `/${p}`}`
}

/**
 * Chip / card avatar HTML: image if set, else icon (never full display-name letters).
 * @param {any} me
 * @param {{ gatewayBase?: string, size?: number, className?: string }} [opts]
 */
export function userAvatarHtml(me, opts = {}) {
  const cls = opts.className || 'shell-account-avatar'
  const size = opts.size || 14
  const url = userAvatarUrl(me, opts.gatewayBase || '')
  if (url) {
    return `<span class="${cls} ${cls}--img" aria-hidden="true"><img src="${url.replace(/"/g, '&quot;')}" alt="" /></span>`
  }
  return `<span class="${cls} ${cls}--icon" aria-hidden="true">${userAvatarIconSvg(size)}</span>`
}

/** Boot hook: clear leftover caches after account switch reload. */
export function consumeAccountSwitchFlag() {
  try {
    if (sessionStorage.getItem('evopanel_account_switched') === '1') {
      sessionStorage.removeItem('evopanel_account_switched')
      // Token already saved; only wipe leftover chat caches (me will refresh).
      clearAccountLocalState({ clearIndexedDb: true })
      return true
    }
  } catch {
    /* ignore */
  }
  return false
}
