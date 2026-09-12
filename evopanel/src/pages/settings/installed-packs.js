/**
 * 设置 → 资源 → 已装（资源包实例）
 * 卸载；导出请到「我的」勾选打包
 */
import '../../style/settings-resources.css'
import { api } from '../../lib/tauri-api.js'
import { toast } from '../../components/toast.js'

/** @type {HTMLElement | null} */
let _root = null

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function kindLabel(kind) {
  const k = String(kind || '').toLowerCase()
  if (k === 'team') return '团队'
  if (k === 'pipeline') return '流水线'
  if (k === 'full') return '完整'
  return kind || '—'
}

function fmtTime(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return String(iso)
    return d.toLocaleString('zh-CN', { hour12: false })
  } catch {
    return String(iso)
  }
}

function artifactSummary(arts) {
  const a = arts && typeof arts === 'object' ? arts : {}
  const parts = []
  const map = [
    ['employees', '员工'],
    ['agents', '智能体'],
    ['apps', '工作流'],
    ['skills', '技能'],
    ['extensions', '扩展'],
  ]
  for (const [key, label] of map) {
    const n = Array.isArray(a[key]) ? a[key].length : 0
    if (n) parts.push(`${label} ${n}`)
  }
  return parts.length ? parts.join(' · ') : '无产物记录'
}

function shellHtml(embedded) {
  const header = embedded
    ? ''
    : `
      <header class="sr-header">
        <div>
          <h2 class="sr-title">已装资源包</h2>
          <p class="sr-desc">从市场或本地安装的整包场景实例。</p>
        </div>
        <div class="sr-header-actions">
          <button type="button" class="sr-btn" data-ip-act="refresh">刷新</button>
        </div>
      </header>`
  const listHead = embedded
    ? `<div class="sr-section-head">
        <h3>已装资源包</h3>
        <div class="sr-inline-actions">
          <span class="sr-muted" data-ip-count></span>
          <button type="button" class="sr-btn" data-ip-act="refresh">刷新</button>
          <button type="button" class="sr-btn" data-ip-act="goto-mine">去「我的」打包</button>
        </div>
      </div>`
    : `<div class="sr-section-head">
        <h3>已装资源包</h3>
        <span class="sr-muted" data-ip-count></span>
      </div>`
  return `
    <div class="sr-root sr-root--fill${embedded ? ' sr-root--embedded' : ''}">
      ${header}
      <section class="sr-section sr-section--grow">
        ${listHead}
        <div class="sr-list" data-ip-list>
          <div class="sr-empty">加载中…</div>
        </div>
      </section>
    </div>
  `
}

function renderList(items) {
  const list = _root?.querySelector('[data-ip-list]')
  const countEl = _root?.querySelector('[data-ip-count]')
  if (!list) return
  const rows = Array.isArray(items) ? items : []
  if (countEl) countEl.textContent = rows.length ? `${rows.length} 个` : ''
  if (!rows.length) {
    list.innerHTML = `
      <div class="sr-empty">
        还没有安装资源包。
        <button type="button" class="sr-btn sr-btn--primary" data-ip-act="goto-market" style="margin-top:12px">去市场安装</button>
      </div>`
    return
  }
  list.innerHTML = rows
    .map((it) => {
      const id = esc(it.org_instance_id)
      return `
      <article class="sr-card" data-org-id="${id}">
        <div class="sr-card-main">
          <div class="sr-card-title">
            <span>${esc(it.pack_id)}</span>
            <span class="sr-badge">${esc(kindLabel(it.kind))}</span>
            <span class="sr-badge sr-badge--muted">v${esc(it.pack_version)}</span>
          </div>
          <div class="sr-card-meta">${esc(artifactSummary(it.artifacts))}</div>
          <div class="sr-card-meta">安装于 ${esc(fmtTime(it.installed_at))}${
            it.workspace_path ? ` · 工作区 ${esc(it.workspace_path)}` : ''
          }</div>
        </div>
        <div class="sr-card-actions">
          <button type="button" class="sr-btn sr-btn--danger" data-ip-act="uninstall" data-org-id="${id}">卸载</button>
        </div>
      </article>`
    })
    .join('')
}

async function refresh() {
  const list = _root?.querySelector('[data-ip-list]')
  if (list) list.innerHTML = `<div class="sr-empty">加载中…</div>`
  try {
    const res = await api.orgList('active')
    renderList(res?.items || [])
  } catch (e) {
    if (list) {
      list.innerHTML = `<div class="sr-empty sr-empty--error">加载失败：${esc(e?.message || e)}</div>`
    }
    toast.error(String(e?.message || e))
  }
}

async function uninstall(orgId) {
  if (!orgId) return
  const ok = window.confirm(
    `卸载资源包实例「${orgId}」？\n将移除其员工与工作流；默认保留工作区文件。`,
  )
  if (!ok) return
  try {
    toast('正在卸载…')
    await api.orgUninstall({
      org_instance_id: orgId,
      options: { keep_primitives: false, keep_workspace: true, keep_vault_data: true },
    })
    toast.success('已卸载')
    await refresh()
  } catch (e) {
    toast.error(String(e?.detail?.error || e?.message || e))
  }
}

function onClick(e) {
  const t = e.target
  if (!(t instanceof Element)) return
  const actBtn = t.closest('[data-ip-act]')
  if (!actBtn) return
  const act = actBtn.getAttribute('data-ip-act')
  if (act === 'refresh') void refresh()
  if (act === 'goto-market') {
    import('./resources.js').then((m) => m.switchResourcesPanel('market'))
  }
  if (act === 'goto-mine') {
    import('./resources.js').then((m) => m.switchResourcesPanel('mine'))
  }
  if (act === 'uninstall') void uninstall(actBtn.getAttribute('data-org-id') || '')
}

/**
 * @param {HTMLElement} container
 * @param {{ embedded?: boolean }} [opts]
 */
export async function mountInstalledPacksInto(container, opts = {}) {
  cleanup()
  _root = container
  container.innerHTML = shellHtml(!!opts.embedded)
  container.addEventListener('click', onClick)
  await refresh()
}

export function cleanup() {
  if (_root) {
    _root.removeEventListener('click', onClick)
    _root = null
  }
}
