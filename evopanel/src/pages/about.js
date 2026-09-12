/**
 * 设置中心：关于页面 — 版本、官网、源码、许可证、检查更新
 */
import { version as APP_VERSION } from '../../package.json'
import { runAboutUpdateCheck } from './about-update.js'
import { getPanelSetting, patchPanelSettings } from '../lib/panel-settings.js'
import { getLicenseStatus, LICENSE_GATE_ENABLED, refreshLicenseStatus } from '../lib/license.js'

const isTauri = !!window.__TAURI_INTERNALS__

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function licenseSummaryHtml(st) {
  const status = st?.status || 'inactive'
  let label = '未激活'
  let detail = '高级功能需激活后使用'
  let cls = 'about-license-chip--muted'
  if (status === 'active' && st?.premium) {
    label = '已激活'
    cls = 'about-license-chip--ok'
    const days = typeof st.days_remaining === 'number' ? st.days_remaining : null
    const until = st.expires_at
      ? new Date(st.expires_at).toLocaleDateString('zh-CN')
      : ''
    detail =
      days != null
        ? `剩余 ${days} 天${until ? ` · 至 ${until}` : ''}`
        : until
          ? `有效期至 ${until}`
          : '高级功能已解锁'
  } else if (status === 'expired') {
    label = '已过期'
    cls = 'about-license-chip--warn'
    detail = '请续期后重新激活'
  } else if (status === 'machine_mismatch') {
    label = '机器码不匹配'
    cls = 'about-license-chip--warn'
    detail = '请用本机机器码重新签发'
  }
  return `
    <div class="about-product-license">
      <div class="about-product-license-row">
        <span class="about-license-chip ${cls}">${escHtml(label)}</span>
        <span class="about-product-license-detail">${escHtml(detail)}</span>
      </div>
      <button type="button" class="btn btn-ghost btn-sm" id="about-goto-license">管理授权</button>
    </div>
  `
}

export function mountAboutInto(container) {
  container.innerHTML = `
    <div class="about-page">
      <div class="about-header">
        <img src="/images/logo.png" alt="EvoFlow" class="about-logo" width="64" height="64" />
        <h2 class="about-name">EvoFlow</h2>
        <p class="about-version">v${APP_VERSION}</p>
      </div>

      <div class="about-links">
        <a href="https://www.evovexai.com" target="_blank" rel="noopener" class="about-link">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
          <span>官网：www.evovexai.com</span>
        </a>
        <a href="https://github.com/EvovexAI/EvoFlow" target="_blank" rel="noopener" class="about-link">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
          <span>GitHub：EvovexAI/EvoFlow</span>
        </a>
        <a href="https://github.com/EvovexAI/EvoFlow/releases" target="_blank" rel="noopener" class="about-link">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
          <span>下载：Releases</span>
        </a>
        <a href="https://github.com/EvovexAI/EvoFlow/blob/main/LICENSE" target="_blank" rel="noopener" class="about-link about-license">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>
          <span>许可证：PolyForm Noncommercial 1.0.0（商用需授权）</span>
        </a>
        <a href="https://github.com/EvovexAI/EvoFlow/blob/main/NOTICE" target="_blank" rel="noopener" class="about-link">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/></svg>
          <span>第三方声明：NOTICE</span>
        </a>
      </div>

      ${
        LICENSE_GATE_ENABLED
          ? `<div class="about-product-license-wrap" id="about-product-license-wrap">
        ${licenseSummaryHtml(getLicenseStatus())}
      </div>
      <style>
        .about-product-license-wrap{margin-top:18px;padding:12px 14px;border:1px solid var(--border-color,#333);border-radius:10px}
        .about-product-license{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
        .about-product-license-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
        .about-license-chip{display:inline-flex;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600}
        .about-license-chip--ok{background:rgba(34,197,94,.15);color:#16a34a}
        .about-license-chip--warn{background:rgba(234,179,8,.18);color:#ca8a04}
        .about-license-chip--muted{background:rgba(113,113,122,.15);color:#71717a}
        .about-product-license-detail{font-size:12px;color:var(--text-muted,#888)}
      </style>`
          : ''
      }

      ${isTauri ? `
      <div class="about-update-section">
        <label class="about-update-pref">
          <input type="checkbox" id="about-auto-download-updates" ${getPanelSetting('autoDownloadUpdates', true) !== false ? 'checked' : ''} />
          <span>自动后台下载更新（不自动重启，就绪后提醒）</span>
        </label>
        <button type="button" class="about-check-btn" id="about-check-update">检查更新</button>
        <div class="about-update-result" id="about-update-result"></div>
      </div>
      <style>
        .about-update-pref{display:flex;align-items:flex-start;gap:8px;margin-bottom:12px;font-size:13px;color:var(--text-secondary);cursor:pointer;line-height:1.5}
        .about-update-pref input{margin-top:3px}
      </style>
      ` : ''}

      <div class="about-disclaimer" style="margin-top: 24px; padding: 12px 16px; background: var(--bg-tertiary); border-radius: 8px; font-size: 12px; line-height: 1.6; color: var(--text-tertiary);">
        <h4 style="margin: 0 0 6px 0; font-size: 13px; font-weight: 600; color: var(--text-secondary);">免责声明</h4>
        <p style="margin: 0 0 4px 0;">本软件仅用于合法的学习和开发用途，请勿用于任何违反法律法规、侵犯他人合法权益的场景。</p>
        <p style="margin: 0 0 4px 0;">使用者因使用本软件产生的任何法律责任和后果，均由使用者自行承担，开发者不承担任何相关责任。</p>
        <p style="margin: 0;">远程功能（更新检查、SkillHub/MCP 市场、模型供应商站点）会按需访问外网；第三方技能/连接器遵循其各自许可证。</p>
      </div>

      <p class="about-contact">
        <a href="mailto:cloud@evovexai.com">cloud@evovexai.com</a>
      </p>
      <p class="about-copyright">Copyright &copy; 2026 景银泰（EvovexAI）</p>
    </div>
  `

  const btn = container.querySelector('#about-check-update')
  if (btn) {
    btn.addEventListener('click', () => void handleCheckUpdate(container))
  }

  container.querySelector('#about-auto-download-updates')?.addEventListener('change', (ev) => {
    const on = /** @type {HTMLInputElement} */ (ev.target).checked
    void patchPanelSettings({ autoDownloadUpdates: on })
  })

  if (LICENSE_GATE_ENABLED) {
    const bindLicenseNav = () => {
      container.querySelector('#about-goto-license')?.addEventListener('click', () => {
        window.location.hash = '/settings?tab=license'
      })
    }
    bindLicenseNav()

    void refreshLicenseStatus()
      .then((st) => {
        const wrap = container.querySelector('#about-product-license-wrap')
        if (!wrap || !container.isConnected) return
        wrap.innerHTML = licenseSummaryHtml(st)
        bindLicenseNav()
      })
      .catch(() => {})
  }
}

async function handleCheckUpdate(container) {
  const resultEl = container.querySelector('#about-update-result')
  const btn = container.querySelector('#about-check-update')
  if (!resultEl || !btn) return
  await runAboutUpdateCheck(container, { resultEl, btn })
}

export function cleanup() {
  // nothing to clean up
}

export async function render() {
  const page = document.createElement('div')
  page.className = 'page'
  page.innerHTML = `
    <div class="page-content" style="max-width:600px" id="about-standalone-root"></div>
  `
  requestAnimationFrame(() => {
    mountAboutInto(page.querySelector('#about-standalone-root'))
  })
  return page
}
