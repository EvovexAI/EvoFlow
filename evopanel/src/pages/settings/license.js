/**
 * 设置 → 授权
 * 展示机器码、激活状态、有效期/剩余天数，输入激活码解锁高级功能。
 *
 * 数据落库：本机 SQLite ``evoflow_app_settings``，key = ``license.state``
 *（通常在 ~/.evoflow 或 EVOFLOW_HOME 下的 evoflow.db）。
 */
import '../../style/license.css'
import { toast } from '../../components/toast.js'
import {
  getLicenseStatus,
  refreshLicenseStatus,
  setLicenseStatus,
} from '../../lib/license.js'

/** @type {HTMLElement | null} */
let _root = null

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function fmtDate(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  } catch {
    return String(iso)
  }
}

function fmtDateOnly(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
  } catch {
    return String(iso)
  }
}

function statusMeta(st) {
  const status = st?.status || 'inactive'
  if (status === 'active' && st?.premium) {
    return {
      text: '已激活',
      cls: 'license-badge--ok',
      tip: '高级功能可用：任务中心、工作流、智能体员工',
    }
  }
  if (status === 'expired') {
    return {
      text: '已过期',
      cls: 'license-badge--warn',
      tip: '授权已到期，请联系管理员续期后重新激活',
    }
  }
  if (status === 'machine_mismatch') {
    return {
      text: '机器码不匹配',
      cls: 'license-badge--warn',
      tip: '当前授权绑定了其他设备，请用本机机器码重新签发',
    }
  }
  return {
    text: '未激活',
    cls: 'license-badge--muted',
    tip: '输入绑定本机机器码的激活码后，即可解锁高级功能',
  }
}

function remainingHtml(st) {
  if (st?.status === 'active' && st?.premium) {
    const days =
      typeof st.days_remaining === 'number' ? st.days_remaining : null
    if (days == null) return '—'
    if (days <= 0) return '不足 1 天'
    if (days < 30) return `${days} 天（即将到期）`
    return `${days} 天`
  }
  if (st?.status === 'expired') return '0 天（已过期）'
  return '—'
}

function durationHtml(st) {
  if (typeof st?.duration_days === 'number' && st.duration_days > 0) {
    return `${st.duration_days} 天`
  }
  if (st?.activated_at && st?.expires_at) {
    const a = new Date(st.activated_at).getTime()
    const e = new Date(st.expires_at).getTime()
    if (Number.isFinite(a) && Number.isFinite(e) && e > a) {
      return `${Math.max(1, Math.floor((e - a) / 86400000))} 天`
    }
  }
  return '—'
}

function statusCardHtml(st) {
  const badge = statusMeta(st)
  const premium = !!(st && st.premium)
  return `
    <div class="license-status-card license-status-card--${escHtml(st?.status || 'inactive')}">
      <div class="license-status-card-head">
        <span class="license-badge ${badge.cls}">${escHtml(badge.text)}</span>
        <span class="license-status-card-tip">${escHtml(badge.tip)}</span>
      </div>
      <div class="license-status-grid">
        <div class="license-status-cell">
          <div class="license-status-label">激活状态</div>
          <div class="license-status-value">${escHtml(badge.text)}</div>
        </div>
        <div class="license-status-cell">
          <div class="license-status-label">剩余时长</div>
          <div class="license-status-value${premium && typeof st?.days_remaining === 'number' && st.days_remaining < 30 ? ' license-status-value--warn' : ''}">${escHtml(remainingHtml(st))}</div>
        </div>
        <div class="license-status-cell">
          <div class="license-status-label">授权总时长</div>
          <div class="license-status-value">${escHtml(durationHtml(st))}</div>
        </div>
        <div class="license-status-cell">
          <div class="license-status-label">激活时间</div>
          <div class="license-status-value">${escHtml(fmtDate(st?.activated_at))}</div>
        </div>
        <div class="license-status-cell">
          <div class="license-status-label">到期时间</div>
          <div class="license-status-value">${escHtml(st?.expires_at ? fmtDateOnly(st.expires_at) : '—')}</div>
        </div>
        <div class="license-status-cell">
          <div class="license-status-label">已解锁功能</div>
          <div class="license-status-value">${
            premium
              ? '任务中心 · 工作流 · 智能体员工'
              : '无（需激活）'
          }</div>
        </div>
      </div>
    </div>
  `
}

function renderHtml(st) {
  const mid = st?.machine_id || '—'
  const hasStored =
    !!(st?.activated_at || st?.expires_at || st?.status === 'expired' || st?.status === 'machine_mismatch')
  return `
  <div class="config-section" id="license-section">
    <div class="config-section-title">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
      产品授权
    </div>
    <p class="form-hint">向管理员索取激活码并粘贴即可；首次激活自动绑定本机。任务中心、工作流、智能体员工解锁后可用。</p>

    <div class="form-group" style="margin-top:16px">
      <label class="form-label">授权概况</label>
      ${statusCardHtml(st)}
    </div>

    <div class="form-group" style="margin-top:20px">
      <label class="form-label" for="license-code-input">激活码</label>
      <textarea id="license-code-input" class="form-input license-code-input" rows="2" placeholder="粘贴激活码（EF3-XXXXX-…）" spellcheck="false"></textarea>
      <div class="license-actions">
        <button type="button" class="btn btn-primary" id="license-activate-btn">激活</button>
        ${
          hasStored || st?.premium
            ? `<button type="button" class="btn btn-ghost" id="license-deactivate-btn">清除授权</button>`
            : ''
        }
        <button type="button" class="btn btn-ghost" id="license-refresh-btn">刷新状态</button>
      </div>
    </div>

    <details class="premium-activate-advanced" style="margin-top:20px">
      <summary>本机机器码（可选）</summary>
      <div class="license-mid-row" style="margin-top:10px">
        <code id="license-machine-id" class="license-mid-code">${escHtml(mid)}</code>
        <button type="button" class="btn btn-ghost btn-sm" id="license-copy-mid">复制</button>
      </div>
      <p class="form-hint" style="margin-top:6px">一般无需提供。仅管理员要求预绑定设备，或换机排查时使用。授权记录保存在本机数据库（license.state）。</p>
    </details>
  </div>
  `
}

async function reload() {
  if (!_root) return
  let st = getLicenseStatus()
  try {
    st = await refreshLicenseStatus()
  } catch (e) {
    toast(String(e?.message || e), 'error')
  }
  _root.innerHTML = renderHtml(st)
  bind(_root)
}

/**
 * @param {HTMLElement} root
 */
function bind(root) {
  root.querySelector('[data-nav="/license-keys"]')?.addEventListener('click', (e) => {
    e.preventDefault()
    void import('../../router.js').then(({ navigate }) => navigate('/license-keys'))
  })

  root.querySelector('#license-copy-mid')?.addEventListener('click', async () => {
    const mid = root.querySelector('#license-machine-id')?.textContent?.trim() || ''
    if (!mid || mid === '—') return
    try {
      await navigator.clipboard.writeText(mid)
      toast('机器码已复制', 'success')
    } catch {
      toast('复制失败，请手动选中复制', 'error')
    }
  })

  root.querySelector('#license-refresh-btn')?.addEventListener('click', () => {
    void reload()
  })

  root.querySelector('#license-activate-btn')?.addEventListener('click', async () => {
    const input = /** @type {HTMLTextAreaElement | null} */ (root.querySelector('#license-code-input'))
    const code = (input?.value || '').trim()
    if (!code) {
      toast('请输入激活码', 'error')
      return
    }
    const btn = /** @type {HTMLButtonElement | null} */ (root.querySelector('#license-activate-btn'))
    if (btn) btn.disabled = true
    try {
      const { api } = await import('../../lib/tauri-api.js')
      const st = await api.licenseActivate(code)
      setLicenseStatus(st)
      const days =
        typeof st?.days_remaining === 'number' ? `，剩余 ${st.days_remaining} 天` : ''
      toast(`激活成功${days}`, 'success')
      try {
        const { refreshShellAsideNav } = await import('../../components/shell-aside.js')
        refreshShellAsideNav?.()
      } catch {
        /* optional */
      }
      await reload()
    } catch (e) {
      const msg =
        e?.detail?.message ||
        e?.message ||
        (typeof e === 'string' ? e : '激活失败')
      toast(String(msg), 'error')
      if (btn) btn.disabled = false
    }
  })

  root.querySelector('#license-deactivate-btn')?.addEventListener('click', async () => {
    if (!confirm('确定清除本机授权？高级功能将回到激活页。')) return
    try {
      const { api } = await import('../../lib/tauri-api.js')
      const st = await api.licenseDeactivate()
      setLicenseStatus(st)
      toast('已清除授权', 'success')
      try {
        const { refreshShellAsideNav } = await import('../../components/shell-aside.js')
        refreshShellAsideNav?.()
      } catch {
        /* optional */
      }
      await reload()
    } catch (e) {
      toast(String(e?.message || e), 'error')
    }
  })
}

/**
 * @param {HTMLElement} container
 */
export async function mountLicenseInto(container) {
  _root = container
  container.innerHTML = renderHtml(getLicenseStatus())
  bind(container)
  await reload()
}

export function cleanup() {
  _root = null
}
