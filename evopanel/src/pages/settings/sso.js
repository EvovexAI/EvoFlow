/**
 * 设置 → 企业 SSO（OIDC）
 * 本机管理员配置 Issuer / Client ID / Secret、邮箱域限制与 JIT 开户。
 */
import { toast } from '../../components/toast.js'
import { getOidcConfig, updateOidcConfig } from '../../lib/webui-remote.js'

/** @type {HTMLElement | null} */
let _root = null

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function field(label, id, { type = 'text', value = '', placeholder = '', hint = '' } = {}) {
  if (type === 'checkbox') {
    return `
      <label class="sso-toggle-row">
        <span class="sso-toggle-label">${label}</span>
        <input class="cron-input sso-toggle" type="checkbox" id="${id}" ${value ? 'checked' : ''} />
      </label>`
  }
  return `
    <label class="sso-field">
      <span class="sso-field-label">${label}</span>
      <input class="cron-input" id="${id}" type="${type}" value="${escHtml(value)}" placeholder="${escHtml(placeholder)}" />
      ${hint ? `<span class="sso-field-hint">${hint}</span>` : ''}
    </label>`
}

function panelHtml(cfg) {
  const callbackHint =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/webui/oidc/callback`
      : '/api/webui/oidc/callback'

  return `
  <div class="settings-embed-wrap" id="sso-root">
    <div class="config-section">
      <div class="config-section-title">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/></svg>
        企业 SSO
      </div>
      <p class="form-hint">通过 OpenID Connect（OIDC）对接企业 IdP，Web 与桌面客户端共用同一登录页。</p>

      <div class="sso-grid">
        <section class="sso-col">
          <h3 class="sso-col-title">基本配置</h3>
          ${field('启用 SSO', 'sso-enabled', { type: 'checkbox', value: cfg.enabled })}
          ${field('Issuer URL', 'sso-issuer', { value: cfg.issuer, placeholder: 'https://login.example.com' })}
          ${field('Client ID', 'sso-client-id', { value: cfg.clientId })}
          ${field('Client Secret', 'sso-client-secret', {
            type: 'password',
            value: '',
            placeholder: cfg.hasClientSecret ? '已配置（留空则不修改）' : '必填',
          })}
          ${field('Scopes', 'sso-scopes', { value: cfg.scopes || 'openid email profile' })}
          ${field('登录按钮文案', 'sso-button-label', { value: cfg.buttonLabel || '企业 SSO 登录' })}
        </section>

        <section class="sso-col">
          <h3 class="sso-col-title">用户映射</h3>
          ${field('Subject Claim', 'sso-sub-claim', { value: cfg.subClaim || 'sub' })}
          ${field('Email Claim', 'sso-email-claim', { value: cfg.emailClaim || 'email' })}
          ${field('Name Claim', 'sso-name-claim', { value: cfg.nameClaim || 'name' })}
          ${field('允许邮箱域', 'sso-email-domain', {
            value: cfg.allowedEmailDomain || '',
            placeholder: 'example.com（留空不限制）',
          })}
          ${field('首次登录自动开户（JIT）', 'sso-auto-provision', {
            type: 'checkbox',
            value: cfg.autoProvision !== false,
          })}
          ${field('保留用户名密码登录', 'sso-password-login', {
            type: 'checkbox',
            value: cfg.passwordLoginEnabled !== false,
          })}
        </section>

        <section class="sso-col">
          <h3 class="sso-col-title">高级（可选）</h3>
          ${field('Redirect URI 覆盖', 'sso-redirect-uri', {
            value: cfg.redirectUri || '',
            placeholder: callbackHint,
            hint: `IdP 中注册的回调地址，默认为 <code>${escHtml(callbackHint)}</code>`,
          })}
          ${field('Authorization Endpoint', 'sso-auth-endpoint', { value: cfg.authorizationEndpoint || '' })}
          ${field('Token Endpoint', 'sso-token-endpoint', { value: cfg.tokenEndpoint || '' })}
          ${field('Userinfo Endpoint', 'sso-userinfo-endpoint', { value: cfg.userinfoEndpoint || '' })}
        </section>
      </div>

      <div class="sec-save-row" style="margin-top:14px">
        <button type="button" class="cron-btn primary" id="sso-save">保存配置</button>
      </div>
    </div>

    <style>
      .sso-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin-top: 8px; }
      .sso-col { display: flex; flex-direction: column; gap: 10px; }
      .sso-col-title {
        margin: 0 0 2px;
        font-size: 13px;
        font-weight: 600;
        color: var(--text-primary, #ddd);
        padding-bottom: 6px;
        border-bottom: 1px solid var(--border-color, #333);
      }
      .sso-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-muted, #888); }
      .sso-field .cron-input { width: 100%; }
      .sso-field-hint { font-size: 11px; color: var(--text-muted, #888); }
      .sso-field-hint code { background: rgba(0,0,0,0.25); padding: 1px 4px; border-radius: 4px; }
      .sso-toggle-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 13px;
        color: var(--text-primary, #ddd);
        padding: 6px 0;
      }
      .sso-toggle-label { flex: 1; }
      .sso-toggle { width: 38px; height: 22px; accent-color: var(--accent, #6366f1); cursor: pointer; }
    </style>
  </div>`
}

function readForm(root) {
  /** @param {string} id */
  const val = (id) => root.querySelector(`#${id}`)?.value?.trim() || ''
  /** @param {string} id */
  const checked = (id) => Boolean(root.querySelector(`#${id}`)?.checked)

  const body = {
    enabled: checked('sso-enabled'),
    issuer: val('sso-issuer'),
    clientId: val('sso-client-id'),
    scopes: val('sso-scopes'),
    buttonLabel: val('sso-button-label'),
    subClaim: val('sso-sub-claim'),
    emailClaim: val('sso-email-claim'),
    nameClaim: val('sso-name-claim'),
    allowedEmailDomain: val('sso-email-domain'),
    autoProvision: checked('sso-auto-provision'),
    passwordLoginEnabled: checked('sso-password-login'),
    redirectUri: val('sso-redirect-uri'),
    authorizationEndpoint: val('sso-auth-endpoint'),
    tokenEndpoint: val('sso-token-endpoint'),
    userinfoEndpoint: val('sso-userinfo-endpoint'),
  }
  const secret = val('sso-client-secret')
  if (secret) body.clientSecret = secret
  return body
}

function wireEvents(root) {
  root.querySelector('#sso-save')?.addEventListener('click', async () => {
    const btn = root.querySelector('#sso-save')
    if (btn) {
      btn.disabled = true
      btn.textContent = '保存中…'
    }
    try {
      const updated = await updateOidcConfig(readForm(root))
      toast.success('SSO 配置已保存')
      root.innerHTML = panelHtml(updated)
      wireEvents(root)
    } catch (err) {
      toast.error(err?.message || '保存失败')
    } finally {
      if (btn) {
        btn.disabled = false
        btn.textContent = '保存配置'
      }
    }
  })
}

export function cleanup() {
  _root = null
}

/** @param {HTMLElement} container */
export async function mountSsoInto(container) {
  cleanup()
  _root = container
  container.innerHTML = '<div class="settings-loading">加载中…</div>'
  try {
    const cfg = await getOidcConfig()
    container.innerHTML = panelHtml(cfg)
    wireEvents(container)
  } catch (err) {
    container.innerHTML = `<div class="settings-subview-error" style="color:var(--error)">加载失败：${escHtml(err?.message || err)}</div>`
  }
}
