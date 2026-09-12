/**
 * 设置 → WebUI 远程访问
 * 启用/停止开关 + 访问地址 + 账号密码管理 + 二维码登录。
 *
 * Backend: /api/webui/* (status, enable, disable, credentials, qr-token)
 */
import { toast } from '../../components/toast.js'
import {
  getWebuiStatus,
  enableWebui,
  disableWebui,
  changePassword,
  changeUsername,
  resetPassword,
  generateQrToken,
  getAccessUrls,
} from '../../lib/webui-remote.js'
import { qrImageHtml } from '../../lib/qr-image.js'

/** @type {HTMLElement | null} */
let _root = null
/** @type {any | null} */
let _status = null
/** @type {string | null} */
let _initialPassword = null
/** @type {any | null} */
let _qrData = null
/** @type {number | null} */
let _qrRefreshTimer = null

async function reloadGatewayIfDesktop() {
  if (!window.__TAURI_INTERNALS__) return
  try {
    const { api } = await import('../../lib/tauri-api.js')
    await api.reloadGateway()
  } catch {
    /* gateway may still pick up bind-host on next manual restart */
  }
}

// ── Helpers ──────────────────────────────────────────────────

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function fmtExpires(ts) {
  if (!ts) return '—'
  try {
    const d = new Date(ts)
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return String(ts)
  }
}

/**
 * Placeholder QR slot; filled asynchronously by fillRemoteQrDisplay().
 */
function qrCodeHtml(url) {
  if (!url) {
    return '<p style="color:var(--text-muted,#888);font-size:13px">点击「生成二维码」按钮创建登录二维码</p>'
  }
  return `
    <div style="display:flex;flex-direction:column;align-items:center;gap:8px">
      <div id="remote-qr-img-slot" data-qr-url="${escHtml(url)}" style="min-height:200px;display:flex;align-items:center;justify-content:center;color:var(--text-muted,#888);font-size:12px">正在生成本地二维码…</div>
      <p style="font-size:12px;color:var(--text-muted,#888);margin:0">扫描二维码即可在手机浏览器中自动登录</p>
    </div>`
}

async function fillRemoteQrDisplay(root) {
  const slot = root?.querySelector('#remote-qr-img-slot')
  if (!slot) return
  const url = slot.getAttribute('data-qr-url')
  if (!url) return
  slot.outerHTML = await qrImageHtml(url, { size: 200, alt: '远程登录二维码' })
}

// ── Section HTML ─────────────────────────────────────────────

function enableSectionHtml() {
  const enabled = _status?.enabled || false
  const running = _status?.running || false
  return `
  <div class="config-section" id="remote-enable-section">
    <div class="config-section-title">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
      WebUI 远程访问
    </div>
    <p class="form-hint">启用后，手机、平板或远程浏览器可以访问 EvoPanel，需使用下方账号密码登录。</p>

    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin:12px 0">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:14px">启用 WebUI</span>
        ${running ? '<span style="font-size:12px;color:var(--success,#16a34a)">✓ 运行中</span>' : ''}
      </div>
      <label class="remote-switch-wrap" style="position:relative;display:inline-flex;align-items:center;cursor:pointer">
        <input type="checkbox" id="remote-toggle" ${enabled ? 'checked' : ''} style="position:absolute;opacity:0;width:0;height:0" />
        <span class="remote-switch-track" style="width:44px;height:24px;border-radius:12px;background:${enabled ? 'var(--success,#16a34a)' : 'var(--border-color,#444)'};transition:background 0.2s;position:relative">
          <span style="position:absolute;top:2px;left:${enabled ? '22px' : '2px'};width:20px;height:20px;border-radius:50%;background:#fff;transition:left 0.2s"></span>
        </span>
      </label>
    </div>
  </div>`
}

function accessSectionHtml() {
  if (!_status?.enabled) return ''
  const urls = _status?.access_urls || []
  const urlList = urls.map((u) => {
    const isLocal = u.includes('localhost') || u.includes('127.0.0.1')
    return `
      <div style="display:flex;align-items:center;gap:8px;margin:4px 0">
        <code style="flex:1;padding:6px 10px;background:rgba(0,0,0,0.06);border-radius:6px;font-size:13px">${escHtml(u)}</code>
        ${isLocal ? '<span style="font-size:11px;color:var(--text-muted,#888)">本机</span>' : '<span style="font-size:11px;color:var(--success,#16a34a)">局域网</span>'}
        <button type="button" class="cron-btn sm" data-remote-copy="${escHtml(u)}">复制</button>
      </div>`
  }).join('')

  return `
  <div class="config-section" id="remote-access-section">
    <div class="config-section-title">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
      访问地址
    </div>
    <p class="form-hint">通过以下地址在手机或远程浏览器中访问 EvoPanel（桌面安装版为 Gateway 端口，与开发环境 Vite 端口不同）。启用后会自动重启后端并监听局域网。</p>
    <div id="remote-url-list" style="margin-top:8px">${urlList || '<p style="color:var(--text-muted,#888)">未检测到可用地址</p>'}</div>
  </div>`
}

function credentialSectionHtml() {
  if (!_status?.enabled) return ''
  const username = _status?.admin_username || 'admin'
  const passwordSet = _status?.password_set ?? true
  const displayPassword = _initialPassword
    ? _initialPassword
    : passwordSet
      ? '••••••••••'
      : '未设置'

  return `
  <div class="config-section" id="remote-cred-section">
    <div class="config-section-title">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
      登录信息
    </div>

    ${_initialPassword ? `
    <div style="margin:8px 0;padding:12px;border:1px solid var(--warning,#ca8a04);border-radius:8px;background:rgba(202,138,4,0.08)">
      <p style="margin:0 0 6px;font-weight:600;color:var(--warning,#ca8a04)">随机密码（仅显示一次）</p>
      <div style="display:flex;gap:8px;align-items:center">
        <code style="flex:1;padding:6px 8px;background:rgba(0,0,0,0.06);border-radius:4px;font-size:13px;word-break:break-all;user-select:all">${escHtml(_initialPassword)}</code>
        <button type="button" class="cron-btn sm" id="remote-copy-initial-pw">复制</button>
      </div>
      <p style="margin:6px 0 0;font-size:12px;color:var(--text-muted,#888)">请妥善保存，关闭后不再显示。建议改用「修改密码」设置易记密码。</p>
    </div>` : ''}

    <table style="width:100%;border-collapse:collapse;margin-top:8px">
      <tr>
        <td style="padding:6px 0;width:100px;font-size:13px;color:var(--text-muted,#888)">用户名</td>
        <td style="padding:6px 0">
          <code style="font-size:14px">${escHtml(username)}</code>
          <button type="button" class="cron-btn sm" id="remote-change-username-btn" style="margin-left:8px">修改</button>
        </td>
      </tr>
      <tr>
        <td style="padding:6px 0;font-size:13px;color:var(--text-muted,#888)">密码</td>
        <td style="padding:6px 0">
          <code style="font-size:14px">${escHtml(displayPassword)}</code>
          <button type="button" class="cron-btn sm" id="remote-change-pw-btn" style="margin-left:8px">修改密码</button>
          <button type="button" class="cron-btn sm" id="remote-reset-pw-btn" style="margin-left:4px">随机生成</button>
        </td>
      </tr>
    </table>
  </div>`
}

function qrSectionHtml() {
  if (!_status?.enabled) return ''
  const qrUrl = _qrData
    ? `${_status.access_urls?.[1] || _status.access_urls?.[0] || window.location.origin}/qr-login?token=${encodeURIComponent(_qrData.token)}`
    : null

  return `
  <div class="config-section" id="remote-qr-section">
    <div class="config-section-title">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h7v7h-7z"/></svg>
      二维码登录
    </div>
    <p class="form-hint">使用手机扫描二维码，即可在手机浏览器中自动登录。</p>
    <div style="display:flex;gap:12px;margin:8px 0;align-items:flex-start">
      <div id="remote-qr-display" style="flex:1">${qrCodeHtml(qrUrl)}</div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <button type="button" class="cron-btn sm primary" id="remote-gen-qr-btn">生成二维码</button>
        ${_qrData ? `<p style="font-size:11px;color:var(--text-muted,#888);margin:0">有效期至 ${fmtExpires(_qrData.expires_at_ms)}</p>` : ''}
      </div>
    </div>
  </div>`
}

function modalHtml(title, fields, btnId, btnLabel, extraHtml = '') {
  const inputs = fields.map((f) => `
    <label style="display:flex;flex-direction:column;gap:2px;margin-bottom:8px">
      <span style="font-size:12px;color:var(--text-muted,#888)">${escHtml(f.label)}</span>
      <input id="${escHtml(f.id)}" class="cron-input" type="${f.type || 'text'}" placeholder="${escHtml(f.placeholder || '')}" value="${escHtml(f.value || '')}" style="width:100%" />
    </label>`).join('')
  return `
  <div id="remote-modal-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1000020">
    <div style="background:var(--bg-primary,#1a1a1a);border:1px solid var(--border-color,#333);border-radius:12px;padding:20px;min-width:320px;max-width:90vw">
      <h3 style="margin:0 0 12px;font-size:16px">${escHtml(title)}</h3>
      ${inputs}
      ${extraHtml}
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
        <button type="button" class="cron-btn sm" id="remote-modal-cancel">取消</button>
        <button type="button" class="cron-btn sm primary" id="${escHtml(btnId)}">${escHtml(btnLabel)}</button>
      </div>
    </div>
  </div>`
}

function openModal(title, fields, btnId, btnLabel, onConfirm, extraHtml = '') {
  const overlay = document.createElement('div')
  overlay.innerHTML = modalHtml(title, fields, btnId, btnLabel, extraHtml)
  document.body.appendChild(overlay)
  const close = () => overlay.remove()
  overlay.querySelector('#remote-modal-cancel')?.addEventListener('click', close)
  overlay.querySelector(`#${btnId}`)?.addEventListener('click', async () => {
    const values = {}
    for (const f of fields) {
      values[f.id] = overlay.querySelector(`#${f.id}`)?.value ?? ''
    }
    await onConfirm(values, close)
  })
  return close
}

function validatePasswordPair(password, confirm, label = '密码') {
  const pw = String(password || '').trim()
  const cf = String(confirm || '').trim()
  if (pw.length < 8) {
    toast(`${label}至少 8 个字符`, 'warn')
    return null
  }
  if (pw !== cf) {
    toast('两次输入的密码不一致', 'warn')
    return null
  }
  return pw
}

function showEnableSetupModal(defaultUsername, onDone, { passwordOptional = false } = {}) {
  openModal(
    '设置登录账号',
    [
      { id: 'remote-setup-username', label: '用户名', placeholder: 'admin', value: defaultUsername || 'admin' },
      { id: 'remote-setup-password', label: passwordOptional ? '密码（留空保持不变）' : '密码', type: 'password', placeholder: '至少 8 个字符' },
      { id: 'remote-setup-password2', label: passwordOptional ? '确认密码' : '确认密码', type: 'password', placeholder: passwordOptional ? '再次输入新密码' : '再次输入密码' },
    ],
    'remote-setup-confirm',
    '启用',
    async (values, close) => {
      const username = values['remote-setup-username']?.trim()
      const pw1 = String(values['remote-setup-password'] || '').trim()
      const pw2 = String(values['remote-setup-password2'] || '').trim()
      if (!username || username.length < 2) {
        toast('用户名至少 2 个字符', 'warn')
        return
      }
      let password = null
      if (pw1 || pw2) {
        password = validatePasswordPair(pw1, pw2)
        if (!password) return
      } else if (!passwordOptional) {
        toast('请设置密码', 'warn')
        return
      }
      close()
      await onDone({ username, password })
    },
    `<p style="margin:0;font-size:12px;color:var(--text-muted,#888)">${passwordOptional ? '远程浏览器登录时使用此账号密码。留空密码则保持现有密码不变。' : '远程浏览器登录时使用此账号密码。'}</p>`,
  )
}

function showChangePasswordModal(onDone) {
  openModal(
    '修改密码',
    [
      { id: 'remote-pw-new', label: '新密码', type: 'password', placeholder: '至少 8 个字符' },
      { id: 'remote-pw-confirm', label: '确认密码', type: 'password', placeholder: '再次输入密码' },
    ],
    'remote-pw-confirm-btn',
    '保存',
    async (values, close) => {
      const password = validatePasswordPair(values['remote-pw-new'], values['remote-pw-confirm'], '新密码')
      if (!password) return
      close()
      await onDone(password)
    },
  )
}

// ── Full render ──────────────────────────────────────────────

function fullHtml() {
  return `
  <div class="settings-modal-pane settings-modal-pane--remote settings-embed-wrap" id="remote-root">
    ${enableSectionHtml()}
    ${accessSectionHtml()}
    ${credentialSectionHtml()}
    ${qrSectionHtml()}
  </div>`
}

// ── Event wiring ─────────────────────────────────────────────

function wireEvents(root) {
  // Toggle enable/disable
  root.querySelector('#remote-toggle')?.addEventListener('change', async (e) => {
    const checked = e.target.checked
    if (!checked) {
      try {
        await disableWebui()
        await reloadGatewayIfDesktop()
        _status = { ..._status, enabled: false, running: false }
        _initialPassword = null
        _qrData = null
        toast('WebUI 已停止', 'success')
        root.innerHTML = fullHtml()
        wireEvents(root)
      } catch (err) {
        toast(`操作失败：${err?.message || err}`, 'error')
        e.target.checked = true
      }
      return
    }

    // Enable — confirm credentials when turning on.
    e.target.checked = false
    const passwordOptional = !!_status?.password_set
    showEnableSetupModal(_status?.admin_username || 'admin', async ({ username, password }) => {
      try {
        const body = { username }
        if (password) body.password = password
        const resp = await enableWebui(body)
        await reloadGatewayIfDesktop()
        _status = {
          ..._status,
          enabled: true,
          running: true,
          password_set: true,
          admin_username: resp.admin_username,
          access_urls: resp.access_urls,
        }
        _initialPassword = resp.initial_password
        toast('WebUI 已启用', 'success')
        root.innerHTML = fullHtml()
        wireEvents(root)
      } catch (err) {
        toast(`启用失败：${err?.message || err}`, 'error')
      }
    }, { passwordOptional })
  })

  // Copy buttons
  root.querySelectorAll('[data-remote-copy]').forEach((btn) => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.remoteCopy).then(() => toast('已复制', 'success'))
    })
  })

  // Copy initial password
  root.querySelector('#remote-copy-initial-pw')?.addEventListener('click', () => {
    if (_initialPassword) {
      navigator.clipboard.writeText(_initialPassword).then(() => toast('密码已复制', 'success'))
    }
  })

  // Change password
  root.querySelector('#remote-change-pw-btn')?.addEventListener('click', () => {
    showChangePasswordModal(async (password) => {
      try {
        await changePassword({ new_password: password })
        _initialPassword = null
        toast('密码已修改', 'success')
        root.innerHTML = fullHtml()
        wireEvents(root)
      } catch (err) {
        toast(`修改失败：${err?.message || err}`, 'error')
      }
    })
  })

  // Random password (optional fallback)
  root.querySelector('#remote-reset-pw-btn')?.addEventListener('click', async () => {
    if (!confirm('生成新的随机密码？当前密码将失效。')) return
    try {
      const resp = await resetPassword()
      _initialPassword = resp.new_password
      toast('已生成随机密码', 'success')
      root.innerHTML = fullHtml()
      wireEvents(root)
    } catch (err) {
      toast(`生成失败：${err?.message || err}`, 'error')
    }
  })

  // Change username
  root.querySelector('#remote-change-username-btn')?.addEventListener('click', () => {
    openModal('修改用户名', [
      { id: 'remote-modal-username', label: '新用户名', placeholder: '输入新用户名', value: _status?.admin_username || 'admin' },
    ], 'remote-modal-username-confirm', '确认', async (values, close) => {
      const newUsername = values['remote-modal-username']?.trim()
      if (!newUsername || newUsername.length < 2) {
        toast('用户名至少 2 个字符', 'warn')
        return
      }
      try {
        await changeUsername({ new_username: newUsername })
        _status = { ..._status, admin_username: newUsername }
        toast('用户名已修改', 'success')
        close()
        root.innerHTML = fullHtml()
        wireEvents(root)
      } catch (err) {
        toast(`修改失败：${err?.message || err}`, 'error')
      }
    })
  })

  // Generate QR code
  root.querySelector('#remote-gen-qr-btn')?.addEventListener('click', async () => {
    try {
      const data = await generateQrToken()
      _qrData = data
      root.innerHTML = fullHtml()
      wireEvents(root)
      void fillRemoteQrDisplay(root)
      toast('二维码已生成', 'success')
      // Auto-refresh after 4 minutes (token expires in 5)
      if (_qrRefreshTimer) clearTimeout(_qrRefreshTimer)
      _qrRefreshTimer = setTimeout(() => {
        root.querySelector('#remote-gen-qr-btn')?.click()
      }, 4 * 60 * 1000)
    } catch (err) {
      toast(`生成失败：${err?.message || err}`, 'error')
    }
  })

  void fillRemoteQrDisplay(root)
}

// ── Lifecycle ────────────────────────────────────────────────

export function cleanup() {
  _root = null
  _status = null
  _initialPassword = null
  _qrData = null
  if (_qrRefreshTimer) {
    clearTimeout(_qrRefreshTimer)
    _qrRefreshTimer = null
  }
}

/** @param {HTMLElement} container */
export async function mountRemoteInto(container) {
  cleanup()
  _root = container
  container.classList.add('settings-modal-pane--remote', 'settings-embed-wrap')
  container.innerHTML = '<div class="stat-card loading-placeholder" style="height:120px"></div>'

  try {
    _status = await getWebuiStatus()
    container.innerHTML = fullHtml()
    wireEvents(container)
  } catch (err) {
    container.innerHTML = `<div class="config-section"><p class="form-hint" style="color:var(--danger)">加载失败：${escHtml(err?.message || err)}</p></div>`
  }
}
