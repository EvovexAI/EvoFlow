/**
 * Shell aside account chip + popover (switch user / logout).
 * Renders in the left-bottom footer bar beside settings.
 */
import { toast } from './toast.js'
import {
  isJwtSession,
  logoutToLocalAdmin,
  navigateSwitchUser,
  refreshMe,
  sessionHint,
  sessionLabel,
  userAvatarHtml,
} from '../lib/account-session.js'
import { getCurrentRoute, navigate } from '../router.js'

/** @type {HTMLElement | null} */
let _mount = null
/** @type {any | null} */
let _me = null
/** @type {boolean} */
let _open = false
/** @type {boolean} */
let _loading = true
/** @type {string} */
let _gatewayBase = ''

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function closeMenu() {
  _open = false
  const menu = _mount?.querySelector('.shell-account-menu')
  if (menu) menu.hidden = true
  const btn = _mount?.querySelector('#shell-account-btn')
  if (btn) btn.setAttribute('aria-expanded', 'false')
}

function openMenu() {
  _open = true
  const menu = _mount?.querySelector('.shell-account-menu')
  if (menu) menu.hidden = false
  const btn = _mount?.querySelector('#shell-account-btn')
  if (btn) btn.setAttribute('aria-expanded', 'true')
}

function toggleMenu() {
  if (_open) closeMenu()
  else openMenu()
}

function loadingHtml() {
  return `
    <div class="shell-account shell-account--loading">
      <div class="shell-account-btn shell-account-btn--placeholder" aria-hidden="true">
        <span class="shell-account-avatar shell-account-avatar--pulse"></span>
        <span class="shell-account-text">
          <span class="shell-account-name shell-account-skel"></span>
        </span>
      </div>
    </div>`
}

function render() {
  if (!_mount) return

  if (_loading && !_me) {
    _mount.innerHTML = loadingHtml()
    return
  }

  const me = _me
  const label = sessionLabel(me)
  const hint = sessionHint(me)
  const jwt = isJwtSession()
  const isAdmin = Boolean(me?.isOrgAdmin)
  const failed = !me && !_loading
  const chipTitle = failed ? '点击重试同步身份' : [label, hint].filter(Boolean).join(' · ')
  const avatar = failed
    ? `<span class="shell-account-avatar shell-account-avatar--icon" aria-hidden="true">!</span>`
    : userAvatarHtml(me, { gatewayBase: _gatewayBase, size: 14, className: 'shell-account-avatar' })

  _mount.innerHTML = `
    <div class="shell-account${failed ? ' shell-account--failed' : ''}">
      <button type="button" class="shell-account-btn" id="shell-account-btn" aria-haspopup="menu" aria-expanded="${_open ? 'true' : 'false'}" title="${esc(chipTitle)}">
        ${avatar}
        <span class="shell-account-text">
          <span class="shell-account-name">${esc(failed ? '身份未同步' : label)}</span>
        </span>
      </button>
      <div class="shell-account-menu" role="menu" ${_open ? '' : 'hidden'}>
        <div class="shell-account-menu-head">
          <div class="shell-account-menu-name">${esc(label)}</div>
          ${hint ? `<div class="shell-account-menu-hint">${esc(hint)}</div>` : ''}
          <div class="shell-account-menu-meta">
            ${isAdmin ? '<span class="shell-account-pill">管理员</span>' : '<span class="shell-account-pill shell-account-pill--muted">用户</span>'}
            ${jwt ? '<span class="shell-account-pill shell-account-pill--online">已登录</span>' : '<span class="shell-account-pill shell-account-pill--local">本机</span>'}
          </div>
        </div>
        <button type="button" class="shell-account-item" role="menuitem" data-act="switch">
          <span class="shell-account-item-ic" aria-hidden="true">⇄</span>
          切换用户
        </button>
        ${
          jwt
            ? `<button type="button" class="shell-account-item" role="menuitem" data-act="logout">
                <span class="shell-account-item-ic" aria-hidden="true">⎋</span>
                退出账号
              </button>`
            : ''
        }
        <button type="button" class="shell-account-item" role="menuitem" data-act="profile">
          <span class="shell-account-item-ic" aria-hidden="true">☺</span>
          编辑资料
        </button>
        <button type="button" class="shell-account-item" role="menuitem" data-act="settings">
          <span class="shell-account-item-ic" aria-hidden="true">⚙</span>
          设置
        </button>
        ${
          isAdmin
            ? `<button type="button" class="shell-account-item" role="menuitem" data-act="users">
                <span class="shell-account-item-ic" aria-hidden="true">👤</span>
                用户权限
              </button>`
            : ''
        }
        ${
          !jwt
            ? `<div class="shell-account-note">本机默认免登为本地管理员。切换用户后，会话与数据按账号隔离。</div>`
            : ''
        }
      </div>
    </div>`

  bind()
}

function bind() {
  if (!_mount) return
  _mount.querySelector('#shell-account-btn')?.addEventListener('click', async (e) => {
    e.stopPropagation()
    if (!_me) {
      _loading = true
      render()
      _me = await refreshMe({ retries: 2 })
      _loading = false
      render()
      return
    }
    toggleMenu()
  })
  _mount.querySelectorAll('[data-act]').forEach((el) => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation()
      const act = el.getAttribute('data-act')
      closeMenu()
      if (act === 'switch') {
        const route = getCurrentRoute() || '/chat'
        navigateSwitchUser(route.split('?')[0] || '/chat')
        return
      }
      if (act === 'logout') {
        toast('已退出，恢复本机管理员', 'success')
        logoutToLocalAdmin()
        return
      }
      if (act === 'profile' || act === 'settings' || act === 'users') {
        try {
          const { openSettingsModal } = await import('./settings-modal.js')
          await openSettingsModal({
            initialTab: act === 'settings' ? undefined : 'users',
          })
        } catch {
          navigate('/settings')
        }
      }
    })
  })
}

function onDocClick(e) {
  if (!_open || !_mount) return
  if (_mount.contains(e.target)) return
  closeMenu()
}

function onAccountChanged(e) {
  _me = e?.detail ?? null
  _loading = false
  render()
}

/**
 * @param {HTMLElement | null} el
 */
export async function mountShellAccount(el) {
  if (!el) return
  _mount = el
  _loading = true
  render()
  document.addEventListener('click', onDocClick)
  window.addEventListener('evoflow:account-changed', onAccountChanged)
  try {
    const { getGatewayBaseUrl } = await import('../lib/tauri-api.js')
    _gatewayBase = (await getGatewayBaseUrl()) || ''
  } catch {
    _gatewayBase = ''
  }
  _me = await refreshMe({ retries: 3 })
  _loading = false
  render()
}

export function unmountShellAccount() {
  document.removeEventListener('click', onDocClick)
  window.removeEventListener('evoflow:account-changed', onAccountChanged)
  _mount = null
  _me = null
  _open = false
  _loading = true
  _gatewayBase = ''
}
