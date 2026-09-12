/**
 * EvoFlow 访问密码登录（主应用与 agent-trace 独立页共用）
 */
import { version as APP_VERSION } from '../../package.json'

export const isTauri = !!window.__TAURI_INTERNALS__

export const LOGIN_LOGO_SVG = `<svg class="login-logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
  <path d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z"/>
  <path d="M18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z"/>
</svg>`

export async function checkAuth() {
  if (isTauri) {
    try {
      const { api } = await import('./tauri-api.js')
      const cfg = await api.readPanelConfig()
      if (!cfg.accessPassword) return { ok: true }
      if (sessionStorage.getItem('evopanel_authed') === '1' || sessionStorage.getItem('evopanel_authed') === '1') return { ok: true }
      return {
        ok: false,
        mustChangePassword: !!cfg.mustChangePassword,
      }
    } catch {
      return { ok: true }
    }
  }
  try {
    const resp = await fetch('/__api/auth_check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    const data = await resp.json()
    if (!data.required || data.authenticated) return { ok: true }
    return { ok: false, mustChangePassword: !!data.mustChangePassword }
  } catch {
    return { ok: true }
  }
}

let _loginFailCount = 0
const CAPTCHA_THRESHOLD = 3

function _genCaptcha() {
  const a = Math.floor(Math.random() * 20) + 1
  const b = Math.floor(Math.random() * 20) + 1
  return { q: `${a} + ${b} = ?`, a: a + b }
}

export function showLoginOverlay(mustChangePassword = false) {
  const needsChangeHint = !!mustChangePassword
  const overlay = document.createElement('div')
  overlay.id = 'login-overlay'
  let _captcha = _loginFailCount >= CAPTCHA_THRESHOLD ? _genCaptcha() : null
  overlay.innerHTML = `
    <div class="login-card">
      ${LOGIN_LOGO_SVG}
      <div class="login-title">EvoFlow</div>
      <div class="login-desc">${needsChangeHint
        ? '首次使用请使用配置中的初始密码登录，登录后请立即修改'
        : isTauri
          ? '应用已锁定，请输入密码'
          : '请输入访问密码'}</div>
      <form id="login-form">
        <input class="login-input" type="password" id="login-pw" placeholder="访问密码" autocomplete="current-password" autofocus />
        <div id="login-captcha" style="display:${_captcha ? 'block' : 'none'};margin-bottom:10px">
          <div style="font-size:12px;color:#888;margin-bottom:6px">请先完成验证：<strong id="captcha-q" style="color:var(--text-primary,#333)">${_captcha ? _captcha.q : ''}</strong></div>
          <input class="login-input" type="number" id="login-captcha-input" placeholder="输入计算结果" style="text-align:center" />
        </div>
        <button class="login-btn" type="submit">登 录</button>
        <div class="login-error" id="login-error"></div>
      </form>
      ${!needsChangeHint
        ? `<details class="login-forgot" style="margin-top:16px;text-align:center">
        <summary style="font-size:11px;color:#aaa;cursor:pointer;list-style:none;user-select:none">忘记密码？</summary>
        <div style="margin-top:8px;font-size:11px;color:#888;line-height:1.8;text-align:left;background:rgba(0,0,0,.03);border-radius:8px;padding:10px 14px">
          ${isTauri
            ? '删除配置文件中的 <code style="background:rgba(99,102,241,.1);padding:1px 5px;border-radius:3px;font-size:10px">accessPassword</code> 字段即可重置：<br><code style="background:rgba(99,102,241,.1);padding:2px 6px;border-radius:3px;font-size:10px;word-break:break-all">~/.evoflow/evopanel.json</code>'
            : '编辑服务器上的配置文件，删除 <code style="background:rgba(99,102,241,.1);padding:1px 5px;border-radius:3px;font-size:10px">accessPassword</code> 字段后重启服务：<br><code style="background:rgba(99,102,241,.1);padding:2px 6px;border-radius:3px;font-size:10px;word-break:break-all">~/.evoflow/evopanel.json</code>'
          }
        </div>
      </details>`
        : ''}
      <div style="margin-top:${needsChangeHint ? '20' : '12'}px;font-size:11px;color:#aaa;text-align:center">
        v${APP_VERSION}
      </div>
    </div>
  `
  document.body.appendChild(overlay)

  return new Promise((resolve) => {
    overlay.querySelector('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault()
      const pw = overlay.querySelector('#login-pw').value
      const btn = overlay.querySelector('.login-btn')
      const errEl = overlay.querySelector('#login-error')
      btn.disabled = true
      btn.textContent = '登录中...'
      errEl.textContent = ''
      if (_captcha) {
        const captchaVal = parseInt(overlay.querySelector('#login-captcha-input')?.value, 10)
        if (captchaVal !== _captcha.a) {
          errEl.textContent = '验证码错误'
          _captcha = _genCaptcha()
          const qEl = overlay.querySelector('#captcha-q')
          if (qEl) qEl.textContent = _captcha.q
          overlay.querySelector('#login-captcha-input').value = ''
          btn.disabled = false
          btn.textContent = '登 录'
          return
        }
      }
      try {
        if (isTauri) {
          const { api } = await import('./tauri-api.js')
          const cfg = await api.readPanelConfig()
          if (pw !== cfg.accessPassword) {
            _loginFailCount++
            if (_loginFailCount >= CAPTCHA_THRESHOLD && !_captcha) {
              _captcha = _genCaptcha()
              const cEl = overlay.querySelector('#login-captcha')
              if (cEl) {
                cEl.style.display = 'block'
                cEl.querySelector('#captcha-q').textContent = _captcha.q
              }
            }
            errEl.textContent = `密码错误${_loginFailCount >= CAPTCHA_THRESHOLD ? '' : ` (${_loginFailCount}/${CAPTCHA_THRESHOLD})`}`
            btn.disabled = false
            btn.textContent = '登 录'
            return
          }
          sessionStorage.setItem('evopanel_authed', '1')
          overlay.classList.add('hide')
          setTimeout(() => overlay.remove(), 400)
          if (cfg.mustChangePassword) {
            sessionStorage.setItem('evopanel_must_change_pw', '1')
          }
          resolve()
        } else {
          const resp = await fetch('/__api/auth_login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pw }),
          })
          const data = await resp.json()
          if (!resp.ok) {
            _loginFailCount++
            if (_loginFailCount >= CAPTCHA_THRESHOLD && !_captcha) {
              _captcha = _genCaptcha()
              const cEl = overlay.querySelector('#login-captcha')
              if (cEl) {
                cEl.style.display = 'block'
                cEl.querySelector('#captcha-q').textContent = _captcha.q
              }
            }
            errEl.textContent =
              (data.error || '登录失败') + (_loginFailCount >= CAPTCHA_THRESHOLD ? '' : ` (${_loginFailCount}/${CAPTCHA_THRESHOLD})`)
            btn.disabled = false
            btn.textContent = '登 录'
            return
          }
          overlay.classList.add('hide')
          setTimeout(() => overlay.remove(), 400)
          if (data.mustChangePassword) {
            sessionStorage.setItem('evopanel_must_change_pw', '1')
          }
          resolve()
        }
      } catch (err) {
        errEl.textContent = '网络错误: ' + (err.message || err)
        btn.disabled = false
        btn.textContent = '登 录'
      }
    })
  })
}

export function installEvopanelGlobalLoginHandler() {
  window.__evopanel_show_login = async function () {
    if (document.getElementById('login-overlay')) return
    await showLoginOverlay()
    location.reload()
  }
}
