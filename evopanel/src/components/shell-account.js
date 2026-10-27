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
/** @type {boolean} */
let _resyncing = false
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

function failedMenuHtml() {
  const resyncLabel = _resyncing ? '同步中…' : '重新同步'
  return `
    <div class="shell-account-menu-head">
      <div class="shell-account-menu-name">身份未同步</div>
      <div class="shell-account-menu-hint">本机身份还没就绪。新安装请先配置 AI 模型；配好后点「重新同步」，或稍等服务启动完成。</div>
    </div>
    <button type="button" class="shell-account-item shell-account-item--primary" role="menuitem" data-act="models">
      <span class="shell-account-item-ic" aria-hidden="true">✦</span>
      去配置模型
    </button>
    <button type="button" class="shell-account-item" role="menuitem" data-act="resync" ${_resyncing ? 'disabled' : ''}>
      <span class="shell-account-item-ic" aria-hidden="true">↻</span>
      ${esc(resyncLabel)}
    </button>
    <button type="button" class="shell-account-item" role="menuitem" data-act="settings">
      <span class="shell-account-item-ic" aria-hidden="true">⚙</span>
      设置
    </button>`
}

function readyMenuHtml(me) {
  const label = sessionLabel(me)
  const hint = sessionHint(me)
  const jwt = isJwtSession()
  const isAdmin = Boolean(me?.isOrgAdmin)
  return `
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
    }`
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
  const failed = !me && !_loading
  const chipTitle = failed ? '点击查看如何同步身份' : [label, hint].filter(Boolean).join(' · ')
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
        ${failed ? failedMenuHtml() : readyMenuHtml(me)}
      </div>
    </div>`

  bind()
}

async function tryResync({ keepOpen = false, silent = false } = {}) {
  if (_resyncing) return _me
  _resyncing = true
  if (!silent) render()
  try {
    _me = await refreshMe({ retries: 2 })
  } finally {
    _resyncing = false
  }
  _loading = false
  if (keepOpen && _me) _open = true
  render()
  if (!_me && !silent) toast('仍未同步，请先配置模型或稍后再试', 'warning')
  return _me
}

function bind() {
  if (!_mount) return
  _mount.querySelector('#shell-account-btn')?.addEventListener('click', (e) => {
    e.stopPropagation()
    const wasOpen = _open
    toggleMenu()
    // 失败态打开浮窗时后台再试一次；成功则切回正常账号菜单并保持打开
    if (!_me && !wasOpen) {
      void tryResync({ keepOpen: true, silent: true })
    }
  })
  _mount.querySelectorAll('[data-act]').forEach((el) => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation()
      const act = el.getAttribute('data-act')
      if (act === 'resync') {
        await tryResync({ keepOpen: true })
        return
      }
      closeMenu()
      if (act === 'models') {
        navigate('/models')
        return
      }
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
  _resyncing = false
  _gatewayBase = ''
}
