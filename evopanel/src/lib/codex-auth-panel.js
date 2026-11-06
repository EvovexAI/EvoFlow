/**
 * ChatGPT / Codex subscription auth panel helpers for Settings → 模型 → OpenAI.
 */

import { gatewayJson } from './gateway-json.js'

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** @param {any} status */
export function codexAuthCardHtml(status) {
  const loggedIn = !!status?.logged_in
  const hint = status?.account_hint || status?.account_id || ''
  const source = status?.source || ''
  const err = !loggedIn ? status?.error || '' : ''
  const cliPresent = !!status?.cli_auth_present

  const statusLine = loggedIn
    ? `<div class="form-hint" style="margin:0">已登录${hint ? ` · ${escHtml(hint)}` : ''}${source ? ` · 来源 ${escHtml(source)}` : ''}。调用走 Codex 订阅额度，无需 API Key。</div>`
    : `<div class="form-hint" style="margin:0">${err ? escHtml(err) : '未登录。可用 ChatGPT / Codex 账号授权，或导入本机 Codex CLI 凭据。'}</div>`

  const pendingSlot = `<div data-codex-pending hidden style="margin-top:10px;padding:10px;border:1px dashed var(--border);border-radius:var(--radius-md)">
      <div class="form-hint" style="margin:0 0 6px">请在浏览器打开验证页，并输入下方代码：</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <code data-codex-user-code style="font-size:1.1em;letter-spacing:0.08em"></code>
        <a data-codex-verify-link href="#" target="_blank" rel="noopener noreferrer" class="btn btn-xs btn-secondary">打开验证页</a>
      </div>
      <div class="form-hint" data-codex-poll-hint style="margin:8px 0 0">等待授权中…</div>
    </div>`

  const actions = loggedIn
    ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
        <button type="button" class="btn btn-sm btn-primary" data-codex-action="ensure-model">添加 Codex 模型并可用</button>
        <button type="button" class="btn btn-sm btn-secondary" data-codex-action="refresh">刷新令牌</button>
        <button type="button" class="btn btn-sm btn-danger" data-codex-action="logout">退出登录</button>
      </div>`
    : `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
        <button type="button" class="btn btn-sm btn-primary" data-codex-action="login">授权登录</button>
        <button type="button" class="btn btn-sm btn-secondary" data-codex-action="import-cli"${cliPresent ? '' : ' title="未检测到 ~/.codex/auth.json"'}>使用本机 Codex CLI</button>
      </div>`

  return `<section class="models-codex-auth-card" data-codex-auth-card style="margin:0 0 14px;padding:12px 14px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--bg-elevated, var(--surface))">
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start">
      <div>
        <strong>ChatGPT / Codex 账号登录</strong>
        ${statusLine}
      </div>
      <span class="tag ${loggedIn ? 'tag--primary' : ''}" style="flex-shrink:0">${loggedIn ? '已连接' : '未连接'}</span>
    </div>
    ${actions}
    ${pendingSlot}
    <p class="form-hint" style="margin:10px 0 0">与上方 API Key（按量）互不替代：订阅登录走 chatgpt.com Codex 通道；API Key 仍走 api.openai.com / 兼容网关。</p>
  </section>`
}

export async function fetchCodexAuthStatus() {
  try {
    return await gatewayJson('GET', '/api/codex-auth/status')
  } catch (e) {
    return { logged_in: false, error: e?.message || String(e), cli_auth_present: false }
  }
}

function errorMessage(e) {
  const detail = e?.detail ?? e?.gatewayResult ?? e?.body ?? e?.message ?? e
  if (detail && typeof detail === 'object') {
    if (typeof detail.message === 'string') return detail.message
    if (typeof detail.detail === 'string') return detail.detail
    if (detail.detail && typeof detail.detail === 'object' && detail.detail.message) return detail.detail.message
    try {
      return JSON.stringify(detail)
    } catch {
      return String(e?.message || e)
    }
  }
  return String(detail || e || '请求失败')
}

/**
 * @param {HTMLElement} mount
 * @param {{ toast?: (msg: string, kind?: string) => void, onChanged?: () => void | Promise<void> }} [opts]
 */
export function bindCodexAuthCard(mount, opts = {}) {
  const root = mount?.querySelector?.('[data-codex-auth-card]')
  if (!root || root.dataset.bound === '1') return
  root.dataset.bound = '1'

  const toast = typeof opts.toast === 'function' ? opts.toast : () => {}
  const onChanged = typeof opts.onChanged === 'function' ? opts.onChanged : async () => {}

  let pollTimer = null
  const clearPoll = () => {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  const refreshCard = async () => {
    clearPoll()
    const status = await fetchCodexAuthStatus()
    const html = codexAuthCardHtml(status)
    const wrap = document.createElement('div')
    wrap.innerHTML = html
    const next = wrap.firstElementChild
    if (next && root.parentNode) {
      root.replaceWith(next)
      bindCodexAuthCard(mount, opts)
    }
    await onChanged()
  }

  root.querySelectorAll('[data-codex-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.codexAction
      btn.disabled = true
      try {
        if (action === 'login') {
          const started = await gatewayJson('POST', '/api/codex-auth/device/start', { open_browser: true })
          const pending = root.querySelector('[data-codex-pending]')
          const codeEl = root.querySelector('[data-codex-user-code]')
          const linkEl = root.querySelector('[data-codex-verify-link]')
          const hintEl = root.querySelector('[data-codex-poll-hint]')
          if (pending) pending.hidden = false
          if (codeEl) codeEl.textContent = started.user_code || ''
          if (linkEl) linkEl.href = started.verification_url || '#'
          const sessionId = started.session_id
          const intervalMs = Math.max(3, Number(started.poll_interval) || 5) * 1000
          clearPoll()
          pollTimer = setInterval(async () => {
            try {
              const polled = await gatewayJson('POST', '/api/codex-auth/device/poll', { session_id: sessionId })
              if (polled.status === 'pending') {
                if (hintEl) hintEl.textContent = '等待授权中…'
                return
              }
              clearPoll()
              if (polled.status === 'success') {
                toast('Codex 账号登录成功', 'success')
                await refreshCard()
              } else {
                toast(polled.error || '登录失败', 'error')
                if (hintEl) hintEl.textContent = polled.error || '登录失败'
              }
            } catch (e) {
              clearPoll()
              toast(errorMessage(e), 'error')
            }
          }, intervalMs)
          toast('已发起授权，请在浏览器完成登录', 'success')
          return
        }
        if (action === 'import-cli') {
          await gatewayJson('POST', '/api/codex-auth/import-cli', {})
          toast('已导入本机 Codex CLI 凭据', 'success')
          await refreshCard()
          return
        }
        if (action === 'refresh') {
          await gatewayJson('POST', '/api/codex-auth/refresh', {})
          toast('令牌已刷新', 'success')
          await refreshCard()
          return
        }
        if (action === 'logout') {
          await gatewayJson('POST', '/api/codex-auth/logout', {})
          toast('已退出 Codex 登录', 'success')
          await refreshCard()
          return
        }
        if (action === 'ensure-model') {
          const res = await gatewayJson('POST', '/api/codex-auth/ensure-model', {
            model: 'gpt-5.4',
            set_primary: false,
          })
          toast(res?.created ? `已添加模型 ${res.model_name}` : `已更新模型 ${res.model_name}`, 'success')
          window.dispatchEvent(new CustomEvent('evopanel:models-changed'))
          await onChanged()
        }
      } catch (e) {
        toast(errorMessage(e), 'error')
      } finally {
        btn.disabled = false
      }
    })
  })
}
