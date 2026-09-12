/**
 * 高级功能未激活时的落地页：菜单可进，页内完成激活。
 */
import '../style/license.css'
import { toast } from '../components/toast.js'
import {
  getLicenseStatus,
  refreshLicenseStatus,
  setLicenseStatus,
  isPremiumActive,
} from '../lib/license.js'
import { reloadCurrentRoute } from '../router.js'

/** @type {HTMLElement | null} */
let _root = null
/** @type {string} */
let _returnPath = '/chat'

const ICONS = {
  tasks: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>`,
  apps: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/></svg>`,
  proactive: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>`,
}

const FEATURE_META = {
  tasks: {
    title: '任务中心',
    desc: '多代理协作任务编排与执行。激活后即可创建、跟踪与管理任务。',
    icon: 'tasks',
  },
  apps: {
    title: '工作流',
    desc: '将流程固化为可复用工作流。激活后可创建、运行与管理。',
    icon: 'apps',
  },
  proactive: {
    title: '智能体员工',
    desc: '雇数字员工按岗位自动上班、写工作汇报。激活后可配置与管理员工。',
    icon: 'proactive',
  },
  premium: {
    title: '高级功能',
    desc: '任务中心、工作流、智能体员工需激活后使用。',
    icon: 'lock',
  },
}

const ALL_FEATURES = [
  { key: 'tasks', label: '任务中心', icon: 'tasks' },
  { key: 'apps', label: '工作流', icon: 'apps' },
  { key: 'proactive', label: '智能体员工', icon: 'proactive' },
]

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function featureKeyFromPath(path) {
  const p = String(path || '').split('?')[0]
  if (p === '/tasks' || p.startsWith('/task/')) return 'tasks'
  if (p === '/apps' || p.startsWith('/apps/')) return 'apps'
  if (p === '/proactive' || p.startsWith('/proactive/')) return 'proactive'
  return 'premium'
}

function noteMeta(st) {
  const status = st?.status || 'inactive'
  if (status === 'expired') {
    return { warn: true, text: '当前授权已过期，请使用新的激活码续期。' }
  }
  if (status === 'machine_mismatch') {
    return { warn: true, text: '授权已绑定其他设备。可清除后使用新激活码，或联系管理员签发本机码。' }
  }
  return { warn: false, text: '向管理员索取激活码并粘贴即可。激活成功后将自动绑定本机。' }
}

function renderHtml(st, featureKey) {
  const meta = FEATURE_META[featureKey] || FEATURE_META.premium
  const mid = st?.machine_id || '加载中…'
  const note = noteMeta(st)
  const icon = ICONS[meta.icon] || ICONS.lock
  const features = ALL_FEATURES.map(
    (f) => `
      <span class="premium-activate-feature${f.key === featureKey ? ' is-current' : ''}">
        ${ICONS[f.icon] || ''}
        ${escHtml(f.label)}
      </span>`,
  ).join('')

  return `
  <div class="page premium-activate-page">
    <div class="premium-activate-shell">
      <div class="premium-activate-card">
        <div class="premium-activate-hero">
          <div class="premium-activate-icon" aria-hidden="true">${icon}</div>
          <div>
            <p class="premium-activate-kicker">需要激活</p>
            <h1 class="premium-activate-title">${escHtml(meta.title)}</h1>
            <p class="premium-activate-desc">${escHtml(meta.desc)}</p>
          </div>
        </div>

        <div class="premium-activate-features" aria-label="高级功能范围">
          ${features}
        </div>

        <div class="premium-activate-note${note.warn ? ' premium-activate-note--warn' : ''}">
          <span class="premium-activate-note-dot" aria-hidden="true"></span>
          <span>${escHtml(note.text)}</span>
        </div>

        <div class="premium-activate-block">
          <label class="premium-activate-label" for="premium-activate-code">
            <span><span class="premium-activate-step">1</span>粘贴激活码</span>
          </label>
          <textarea id="premium-activate-code" class="form-input premium-activate-code" rows="2" placeholder="EF3-XXXXX-…" spellcheck="false" autocomplete="off"></textarea>
        </div>

        <div class="premium-activate-actions">
          <button type="button" class="btn btn-primary" id="premium-activate-submit">立即激活</button>
          <button type="button" class="btn btn-ghost" id="premium-activate-settings">授权设置</button>
        </div>

        <details class="premium-activate-advanced">
          <summary>本机机器码（换机 / 技术支持时使用）</summary>
          <div class="premium-activate-mid-row" style="margin-top:10px">
            <code id="premium-activate-mid" class="premium-activate-mid">${escHtml(mid)}</code>
            <button type="button" class="btn btn-ghost premium-activate-copy" id="premium-activate-copy">复制</button>
          </div>
          <p class="premium-activate-footer" style="border:0;margin-top:10px;padding-top:0">一般无需提供。仅在管理员要求预绑定设备，或排查换机问题时使用。</p>
        </details>
      </div>
    </div>
  </div>
  `
}

function bind(root) {
  root.querySelector('#premium-activate-copy')?.addEventListener('click', async () => {
    const mid = root.querySelector('#premium-activate-mid')?.textContent?.trim() || ''
    if (!mid || mid === '加载中…') return
    try {
      await navigator.clipboard.writeText(mid)
      toast('机器码已复制', 'success')
    } catch {
      toast('复制失败，请手动选中复制', 'error')
    }
  })

  root.querySelector('#premium-activate-settings')?.addEventListener('click', () => {
    window.location.hash = '/settings?tab=license'
  })

  root.querySelector('#premium-activate-submit')?.addEventListener('click', async () => {
    const input = /** @type {HTMLTextAreaElement | null} */ (root.querySelector('#premium-activate-code'))
    const code = (input?.value || '').trim()
    if (!code) {
      toast('请输入激活码', 'error')
      input?.focus()
      return
    }
    const btn = /** @type {HTMLButtonElement | null} */ (root.querySelector('#premium-activate-submit'))
    if (btn) {
      btn.disabled = true
      btn.textContent = '激活中…'
    }
    try {
      const { api } = await import('../lib/tauri-api.js')
      const st = await api.licenseActivate(code)
      setLicenseStatus(st)
      const days =
        typeof st?.days_remaining === 'number' ? `，剩余 ${st.days_remaining} 天` : ''
      toast(`激活成功${days}`, 'success')
      try {
        const { refreshShellAsideNav } = await import('../components/shell-aside.js')
        refreshShellAsideNav?.()
      } catch {
        /* optional */
      }
      // Same URL as the gate page — must force route reload to leave activate UI
      reloadCurrentRoute()
    } catch (e) {
      toast(String(e?.message || e || '激活失败'), 'error')
      if (btn) {
        btn.disabled = false
        btn.textContent = '立即激活'
      }
    }
  })
}

/**
 * @param {{ returnPath?: string }} [opts]
 */
export async function render(opts = {}) {
  _returnPath = String(opts.returnPath || window.location.hash.slice(1) || '/chat').split('?')[0]
  const featureKey = featureKeyFromPath(_returnPath)
  const el = document.createElement('div')
  el.className = 'premium-activate-host'
  el.style.height = '100%'
  el.innerHTML = renderHtml(getLicenseStatus(), featureKey)
  _root = el
  bind(el)

  try {
    const st = await refreshLicenseStatus()
    if (isPremiumActive()) {
      reloadCurrentRoute()
      return el
    }
    el.innerHTML = renderHtml(st, featureKey)
    bind(el)
  } catch (e) {
    toast(String(e?.message || e), 'error')
  }
  return el
}

export function cleanup() {
  _root = null
}
