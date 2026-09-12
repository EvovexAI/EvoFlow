/**
 * 设置 → 用户与权限（org_admin 管理普通用户 / 管理员）
 * Backend: /api/identity/*
 *
 * 多用户隔离始终开启（无 off/shadow/enforce 模式切换）。
 * 身份主键字段：principalId；展示优先用 displayName。
 */
import { toast } from '../../components/toast.js'
import { showModal } from '../../components/modal.js'
import {
  createPrincipal,
  deletePrincipalAvatar,
  getMe,
  listPrincipals,
  promoteAdmin,
  resetPrincipalPassword,
  revokeAdmin,
  setPrincipalStatus,
  updatePrincipal,
  uploadPrincipalAvatar,
} from '../../lib/identity-api.js'
import { refreshMe, userAvatarHtml } from '../../lib/account-session.js'
import { getGatewayBaseUrl } from '../../lib/tauri-api.js'

/** @type {HTMLElement | null} */
let _root = null
/** @type {any | null} */
let _me = null
/** @type {any[]} */
let _principals = []
/** @type {boolean} */
let _loading = false
/** @type {string | null} */
let _lastCreatedPassword = null
/** @type {string | null} */
let _lastCreatedName = null
/** @type {string} */
let _gatewayBase = ''

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function initials(name) {
  const s = String(name || '').trim()
  if (!s) return '?'
  const parts = s.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return s.slice(0, 2).toUpperCase()
}

function avatarBlock(person, { editable = false, sizeClass = '' } = {}) {
  const cls = `users-avatar${sizeClass ? ` ${sizeClass}` : ''}`
  const inner = userAvatarHtml(person, {
    gatewayBase: _gatewayBase,
    size: sizeClass.includes('sm') ? 14 : 18,
    className: 'users-avatar-face',
  })
  if (!editable) {
    return `<div class="${cls}" aria-hidden="true">${inner}</div>`
  }
  return `
    <div class="${cls} users-avatar--editable" aria-hidden="false">
      ${inner}
      <button type="button" class="users-avatar-edit" data-act="change-avatar" title="更换头像">换头像</button>
      <input type="file" accept="image/png,image/webp" class="users-avatar-file" hidden data-act="avatar-file" />
    </div>`
}

function roleBadge(p) {
  const st = String(p?.status || 'active')
  if (st === 'deactivated') {
    return '<span class="users-pill users-pill--muted">已停用</span>'
  }
  if (p?.isOrgAdmin) {
    return '<span class="users-pill users-pill--admin">管理员</span>'
  }
  return '<span class="users-pill users-pill--member">普通用户</span>'
}

function iconUser() {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`
}

function iconUsers() {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>`
}

function iconPlus() {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>`
}

function pidOf(p) {
  return String(p?.principalId || p?.userId || '')
}

function labelOf(p) {
  return String(p?.displayName || p?.username || pidOf(p) || '—')
}

function meSectionHtml() {
  const name = _me?.displayName || '—'
  const pid = _me?.principalId || '—'
  const scope = _me?.personalScopeId || '—'
  const isAdmin = Boolean(_me?.isOrgAdmin)
  return `
  <div class="config-section users-section">
    <div class="config-section-title">
      ${iconUser()}
      当前身份
    </div>
    <p class="form-hint users-section-hint">可设置自己的头像与显示名。侧栏只显示头像和名字；多用户隔离始终开启。</p>
    <div class="users-identity-card">
      ${avatarBlock(_me, { editable: true })}
      <div class="users-identity-main">
        <div class="users-identity-name-row">
          <span class="users-identity-name">${esc(name)}</span>
          ${roleBadge({ isOrgAdmin: isAdmin, status: 'active' })}
          <span class="users-pill users-pill--enforce">多用户隔离</span>
        </div>
        <div class="users-identity-meta">
          <span><span class="users-meta-label">身份 ID</span> <code>${esc(pid)}</code></span>
          <span><span class="users-meta-label">工作区</span> <code>${esc(scope)}</code></span>
        </div>
        <div class="users-identity-actions">
          <button type="button" class="cron-btn sm" data-act="edit-me">编辑资料</button>
          ${_me?.hasAvatar ? '<button type="button" class="cron-btn sm" data-act="clear-avatar">移除头像</button>' : ''}
        </div>
      </div>
    </div>
  </div>`
}

function createSectionHtml() {
  return `
  <div class="config-section users-section">
    <div class="config-section-title">
      ${iconPlus()}
      创建用户
    </div>
    <p class="form-hint users-section-hint">新用户可设登录名与密码，用于侧栏「切换用户」。未填登录名则无法用密码登录。</p>
    <div class="users-form-grid">
      <label class="form-field">
        <span class="form-label">显示名 <span class="users-req">*</span></span>
        <input class="form-input" id="users-display-name" placeholder="例如：张三" autocomplete="off" />
      </label>
      <label class="form-field">
        <span class="form-label">登录用户名 <span class="users-req">*</span></span>
        <input class="form-input" id="users-username" placeholder="切换用户 / 远程登录用" autocomplete="off" />
      </label>
      <label class="form-field">
        <span class="form-label">邮箱</span>
        <input class="form-input" id="users-email" type="email" placeholder="可选" autocomplete="off" />
      </label>
      <label class="form-field">
        <span class="form-label">初始密码</span>
        <input class="form-input" id="users-password" type="password" placeholder="留空则自动生成" autocomplete="new-password" />
      </label>
      <label class="users-check-field">
        <input type="checkbox" id="users-promote" />
        <span>同时设为组织管理员</span>
      </label>
      <div class="users-form-actions">
        <button type="button" class="cron-btn primary" id="users-create-btn">创建用户</button>
      </div>
    </div>
    ${_lastCreatedPassword
      ? `<div class="users-pw-banner">
          <span>用户 <strong>${esc(_lastCreatedName || '')}</strong> 的初始密码（仅显示一次）：</span>
          <code id="users-pw-value">${esc(_lastCreatedPassword)}</code>
          <button type="button" class="cron-btn sm" id="users-copy-pw">复制</button>
        </div>`
      : ''}
  </div>`
}

function directorySectionHtml(meId) {
  const cards = _principals
    .map((p) => {
      const pid = pidOf(p)
      const isSelf = pid === meId
      const active = String(p.status || '') === 'active'
      const name = labelOf(p)
      const username = p.username ? `@${p.username}` : (p.hasLogin ? '—' : '无登录名')
      const email = p.primaryEmail || '—'
      return `
      <div class="users-person-card ${active ? '' : 'is-inactive'}" data-principal-id="${esc(pid)}">
        <div class="users-person-left">
          <div class="users-avatar users-avatar--sm" aria-hidden="true">${userAvatarHtml(p, { gatewayBase: _gatewayBase, size: 14, className: 'users-avatar-face' })}</div>
          <div class="users-person-text">
            <div class="users-person-name-row">
              <span class="users-person-name">${esc(name)}</span>
              ${isSelf ? '<span class="users-pill users-pill--you">我</span>' : ''}
              ${roleBadge(p)}
            </div>
            <div class="users-person-meta">
              <span><span class="users-meta-label">登录</span> ${esc(username)}</span>
              <span><span class="users-meta-label">邮箱</span> ${esc(email)}</span>
            </div>
            <div class="users-person-id"><code>${esc(pid)}</code></div>
          </div>
        </div>
        <div class="users-person-actions">
          <button type="button" class="cron-btn sm" data-act="edit">编辑</button>
          ${
            p.hasLogin
              ? `<button type="button" class="cron-btn sm" data-act="reset-pw">重置密码</button>`
              : ''
          }
          ${
            active
              ? `<button type="button" class="cron-btn sm" data-act="deactivate" ${isSelf ? 'disabled title="不能停用自己"' : ''}>停用</button>`
              : `<button type="button" class="cron-btn sm" data-act="activate">启用</button>`
          }
          ${
            p.isOrgAdmin
              ? `<button type="button" class="cron-btn sm" data-act="revoke-admin" ${isSelf ? 'disabled title="不能撤销自己的管理员"' : ''}>撤销管理员</button>`
              : `<button type="button" class="cron-btn sm primary" data-act="promote" ${active ? '' : 'disabled'}>设为管理员</button>`
          }
        </div>
      </div>`
    })
    .join('')

  return `
  <div class="config-section users-section">
    <div class="config-section-title">
      ${iconUsers()}
      用户目录
      <span class="users-count">${_principals.length}</span>
    </div>
    <p class="form-hint users-section-hint">可编辑显示名、邮箱、登录名，并重置密码。停用后该用户无法登录。</p>
    <div class="users-directory">
      ${cards || '<div class="users-empty">暂无用户</div>'}
    </div>
  </div>`
}

function guestSectionHtml() {
  const name = _me?.displayName || '—'
  const pid = _me?.principalId || '—'
  const scope = _me?.personalScopeId || '—'
  const isAdmin = Boolean(_me?.isOrgAdmin)
  return `
  <div class="config-section users-section">
    <div class="config-section-title">
      ${iconUser()}
      我的身份
    </div>
    <p class="form-hint users-section-hint">可设置自己的头像与显示名。如需管理其他用户，请联系管理员。</p>
    <div class="users-identity-card">
      ${avatarBlock(_me, { editable: true })}
      <div class="users-identity-main">
        <div class="users-identity-name-row">
          <span class="users-identity-name">${esc(name)}</span>
          ${roleBadge({ isOrgAdmin: isAdmin, status: 'active' })}
        </div>
        <div class="users-identity-meta">
          <span><span class="users-meta-label">身份 ID</span> <code>${esc(pid)}</code></span>
          <span><span class="users-meta-label">工作区</span> <code>${esc(scope)}</code></span>
        </div>
        <div class="users-identity-actions">
          <button type="button" class="cron-btn sm" data-act="edit-me">编辑资料</button>
          ${_me?.hasAvatar ? '<button type="button" class="cron-btn sm" data-act="clear-avatar">移除头像</button>' : ''}
        </div>
      </div>
    </div>
  </div>`
}

function render() {
  if (!_root) return
  const isAdmin = Boolean(_me?.isOrgAdmin)
  const meId = String(_me?.principalId || '')

  if (_loading && !_me) {
    _root.innerHTML = `
      <div class="users-loading">
        <div class="users-loading-spinner" aria-hidden="true"></div>
        <span>正在加载用户与权限…</span>
      </div>`
    return
  }

  if (!isAdmin) {
    _root.innerHTML = `<div class="users-page">${guestSectionHtml()}</div>`
    bind()
    return
  }

  _root.innerHTML = `
    <div class="users-page">
      ${meSectionHtml()}
      ${createSectionHtml()}
      ${directorySectionHtml(meId)}
    </div>`
  bind()
}

function bind() {
  if (!_root) return
  _root.querySelector('#users-create-btn')?.addEventListener('click', onCreate)
  _root.querySelector('#users-copy-pw')?.addEventListener('click', async () => {
    const pw = _lastCreatedPassword
    if (!pw) return
    try {
      await navigator.clipboard.writeText(pw)
      toast('已复制初始密码', 'success')
    } catch {
      toast('复制失败，请手动选中复制', 'error')
    }
  })
  _root.querySelectorAll('[data-principal-id]').forEach((card) => {
    const pid = card.getAttribute('data-principal-id')
    card.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => onRowAction(pid, btn.getAttribute('data-act')))
    })
  })
  _root.querySelector('[data-act="edit-me"]')?.addEventListener('click', () => showEditMeModal())
  _root.querySelector('[data-act="clear-avatar"]')?.addEventListener('click', () => onClearMyAvatar())
  _root.querySelector('[data-act="change-avatar"]')?.addEventListener('click', () => {
    _root?.querySelector('[data-act="avatar-file"]')?.click()
  })
  _root.querySelector('[data-act="avatar-file"]')?.addEventListener('change', onPickMyAvatar)
}

async function showEditMeModal() {
  if (!_me?.principalId) return
  const pid = String(_me.principalId)
  showModal({
    title: '编辑我的资料',
    width: 440,
    fields: [
      { name: 'displayName', label: '显示名', value: _me.displayName || '', placeholder: '例如：张三' },
      { name: 'primaryEmail', label: '邮箱', type: 'email', value: _me.primaryEmail || '', placeholder: '可选' },
    ],
    onConfirm: async (values) => {
      const displayName = String(values.displayName || '').trim()
      if (!displayName) {
        toast('请填写显示名', 'error')
        return false
      }
      try {
        await updatePrincipal(pid, {
          displayName,
          primaryEmail: String(values.primaryEmail || '').trim() || null,
        })
        toast('资料已更新', 'success')
        await refreshMe({ retries: 1 })
        await reload()
        return true
      } catch (e) {
        toast(String(e?.message || e || '更新失败'), 'error')
        return false
      }
    },
  })
}

async function onPickMyAvatar(e) {
  const input = e?.target
  const file = input?.files?.[0]
  if (!file || !_me?.principalId) return
  try {
    const updated = await uploadPrincipalAvatar(_me.principalId, file, file.name || 'avatar.webp')
    _me = { ..._me, ...updated }
    await refreshMe({ retries: 1 })
    toast('头像已更新', 'success')
    await reload()
  } catch (err) {
    toast(String(err?.message || err || '上传失败'), 'error')
  } finally {
    if (input) input.value = ''
  }
}

async function onClearMyAvatar() {
  if (!_me?.principalId) return
  try {
    const updated = await deletePrincipalAvatar(_me.principalId)
    _me = { ..._me, ...updated }
    await refreshMe({ retries: 1 })
    toast('已移除头像', 'success')
    await reload()
  } catch (err) {
    toast(String(err?.message || err || '移除失败'), 'error')
  }
}

async function reload() {
  _loading = true
  render()
  try {
    try {
      _gatewayBase = (await getGatewayBaseUrl()) || ''
    } catch {
      _gatewayBase = ''
    }
    _me = await getMe()
    if (_me?.isOrgAdmin) {
      const res = await listPrincipals()
      _principals = Array.isArray(res?.principals) ? res.principals : []
    } else {
      _principals = []
    }
  } catch (e) {
    toast(String(e?.message || e || '加载失败'), 'error')
  } finally {
    _loading = false
    render()
  }
}

async function onCreate() {
  const displayName = String(_root?.querySelector('#users-display-name')?.value || '').trim()
  const username = String(_root?.querySelector('#users-username')?.value || '').trim() || undefined
  const password = String(_root?.querySelector('#users-password')?.value || '').trim() || undefined
  const primaryEmail = String(_root?.querySelector('#users-email')?.value || '').trim() || undefined
  const promoteAdminFlag = Boolean(_root?.querySelector('#users-promote')?.checked)
  if (!displayName) {
    toast('请填写显示名', 'error')
    _root?.querySelector('#users-display-name')?.focus()
    return
  }
  if (!username) {
    toast('请填写登录用户名（切换用户需要）', 'error')
    _root?.querySelector('#users-username')?.focus()
    return
  }
  const btn = _root?.querySelector('#users-create-btn')
  if (btn) btn.disabled = true
  try {
    const created = await createPrincipal({
      displayName,
      username,
      password,
      primaryEmail,
      promoteAdmin: promoteAdminFlag,
    })
    _lastCreatedName = created?.displayName || created?.principalId || displayName
    _lastCreatedPassword = created?.initialPassword || null
    toast('用户已创建', 'success')
    await reload()
  } catch (e) {
    toast(String(e?.message || e || '创建失败'), 'error')
  } finally {
    if (btn) btn.disabled = false
  }
}

async function showEditUserModal(p) {
  if (!p) return
  const hasLogin = Boolean(p.hasLogin)
  const pid = pidOf(p)
  showModal({
    title: `编辑用户 · ${labelOf(p)}`,
    width: 480,
    fields: [
      { name: 'displayName', label: '显示名', value: p.displayName || '', placeholder: '例如：张三' },
      { name: 'primaryEmail', label: '邮箱', type: 'email', value: p.primaryEmail || '', placeholder: '可选' },
      {
        name: 'username',
        label: '登录用户名',
        value: p.username || '',
        placeholder: hasLogin ? '登录用' : '该用户无登录账号',
        readonly: !hasLogin,
        hint: hasLogin ? '修改后需用新用户名登录' : '仅创建时设置了登录名的用户可改',
      },
    ],
    onConfirm: async (values) => {
      const displayName = String(values.displayName || '').trim()
      if (!displayName) {
        toast('请填写显示名', 'error')
        return false
      }
      const body = {
        displayName,
        primaryEmail: String(values.primaryEmail || '').trim() || null,
      }
      if (hasLogin) {
        const uname = String(values.username || '').trim()
        if (!uname) {
          toast('请填写登录用户名', 'error')
          return false
        }
        body.username = uname
      }
      try {
        await updatePrincipal(pid, body)
        toast('用户资料已更新', 'success')
        _lastCreatedPassword = null
        await reload()
        return true
      } catch (e) {
        toast(String(e?.message || e || '更新失败'), 'error')
        return false
      }
    },
  })
}

async function showResetPasswordModal(p) {
  if (!p?.hasLogin) {
    toast('该用户没有登录账号', 'warn')
    return
  }
  const pid = pidOf(p)
  showModal({
    title: `重置密码 · ${labelOf(p)}`,
    width: 440,
    fields: [
      {
        name: 'newPassword',
        label: '新密码',
        type: 'password',
        placeholder: '留空则自动生成',
        hint: '至少 8 个字符；重置后仅显示一次',
      },
      { name: 'confirmPassword', label: '确认密码', type: 'password', placeholder: '再次输入新密码' },
    ],
    onConfirm: async (values) => {
      const pw1 = String(values.newPassword || '').trim()
      const pw2 = String(values.confirmPassword || '').trim()
      if (pw1 || pw2) {
        if (pw1.length < 8) {
          toast('密码至少 8 个字符', 'error')
          return false
        }
        if (pw1 !== pw2) {
          toast('两次输入的密码不一致', 'error')
          return false
        }
      }
      try {
        const res = await resetPrincipalPassword(pid, pw1 ? { newPassword: pw1 } : {})
        _lastCreatedName = labelOf(p)
        _lastCreatedPassword = res?.newPassword || null
        toast('密码已重置', 'success')
        await reload()
        return true
      } catch (e) {
        toast(String(e?.message || e || '重置失败'), 'error')
        return false
      }
    },
  })
}

async function onRowAction(principalId, act) {
  if (!principalId || !act) return
  const p = _principals.find((x) => pidOf(x) === String(principalId))
  try {
    if (act === 'edit') {
      await showEditUserModal(p)
      return
    }
    if (act === 'reset-pw') {
      await showResetPasswordModal(p)
      return
    }
    if (act === 'deactivate') {
      await setPrincipalStatus(principalId, 'deactivated')
      toast('已停用', 'success')
    } else if (act === 'activate') {
      await setPrincipalStatus(principalId, 'active')
      toast('已启用', 'success')
    } else if (act === 'promote') {
      await promoteAdmin(principalId)
      toast('已设为管理员', 'success')
    } else if (act === 'revoke-admin') {
      await revokeAdmin(principalId)
      toast('已撤销管理员', 'success')
    }
    _lastCreatedPassword = null
    await reload()
  } catch (e) {
    toast(String(e?.message || e || '操作失败'), 'error')
  }
}

/**
 * @param {HTMLElement} container
 */
export async function mountUsersInto(container) {
  _root = container
  _lastCreatedPassword = null
  _lastCreatedName = null
  await reload()
}

export function cleanup() {
  _root = null
  _me = null
  _principals = []
  _lastCreatedPassword = null
  _lastCreatedName = null
}
