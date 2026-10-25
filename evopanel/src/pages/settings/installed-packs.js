/**
 * 设置 → 资源中心 → 已装资源
 * 已装资源包实例:列表 / 详情 / 卸载;导出请到「打包分享」勾选打包
 */
import '../../style/settings-resources.css'
import { api } from '../../lib/tauri-api.js'
import { toast } from '../../components/toast.js'

/** @type {HTMLElement | null} */
let _root = null
/** @type {Array<Record<string, any>>} */
let _items = []
/** @type {string} */
let _detailId = ''

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function reportCount(n) {
  _root?.dispatchEvent(new CustomEvent('sr-count', { detail: { panel: 'installed', count: n }, bubbles: true }))
}

const ICONS = {
  team: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  pipeline: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><path d="M10 6.5h7a1 1 0 0 1 1 1V14M14 17.5H7a1 1 0 0 1-1-1V10"/></svg>',
  full: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>',
}

function kindIcon(kind) {
  return ICONS[String(kind || '').toLowerCase()] || ICONS.full
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

const ARTIFACT_LABELS = [
  ['employees', '员工'],
  ['agents', '智能体'],
  ['apps', '工作流'],
  ['skills', '技能'],
  ['extensions', '扩展'],
  ['knowledge', '知识库'],
]

function artifactSummary(arts) {
  const a = arts && typeof arts === 'object' ? arts : {}
  const parts = []
  for (const [key, label] of ARTIFACT_LABELS) {
    const n = Array.isArray(a[key]) ? a[key].length : 0
    if (n) parts.push(`${label} ${n}`)
  }
  return parts.length ? parts.join(' · ') : '无产物记录'
}

function packTitle(it) {
  return String(it?.pack_name || it?.name || it?.pack_id || '').trim() || '未命名资源包'
}

function shellHtml(embedded) {
  const header = embedded
    ? ''
    : `
      <header class="sr-header">
        <div>
          <h2 class="sr-title">已装资源</h2>
          <p class="sr-desc">从市场或本地安装的资源包实例。点击卡片查看装了哪些产物。</p>
        </div>
        <div class="sr-header-actions">
          <button type="button" class="sr-btn" data-ip-act="refresh">刷新</button>
        </div>
      </header>`
  const listHead = `
    <div class="sr-section-head">
      <h3>已装资源包</h3>
      <div class="sr-inline-actions">
        <span class="sr-muted" data-ip-count></span>
        ${embedded ? `<button type="button" class="sr-btn" data-ip-act="refresh">刷新</button>
        <button type="button" class="sr-btn" data-ip-act="goto-mine">去打包分享</button>` : ''}
      </div>
    </div>`
  return `
    <div class="sr-root sr-root--fill${embedded ? ' sr-root--embedded' : ''}">
      ${header}
      <section class="sr-section sr-section--grow" data-ip-list-pane>
        ${listHead}
        <div class="sr-list" data-ip-list>
          <div class="sr-empty">加载中…</div>
        </div>
      </section>
      <section class="sr-section sr-section--grow" data-ip-detail-pane hidden>
        <div class="sr-section-head">
          <div class="sr-inline-actions" style="gap:10px">
            <button type="button" class="sr-btn" data-ip-act="back-list">← 返回列表</button>
            <h3 data-ip-detail-title style="margin:0">资源包详情</h3>
          </div>
          <div class="sr-inline-actions">
            <button type="button" class="sr-btn sr-btn--danger" data-ip-act="uninstall-detail">卸载</button>
          </div>
        </div>
        <div class="sr-detail" data-ip-detail>
          <div class="sr-empty">加载中…</div>
        </div>
      </section>
    </div>
  `
}

function showList() {
  _detailId = ''
  const listPane = _root?.querySelector('[data-ip-list-pane]')
  const detailPane = _root?.querySelector('[data-ip-detail-pane]')
  if (listPane) listPane.hidden = false
  if (detailPane) detailPane.hidden = true
}

function showDetailPane() {
  const listPane = _root?.querySelector('[data-ip-list-pane]')
  const detailPane = _root?.querySelector('[data-ip-detail-pane]')
  if (listPane) listPane.hidden = true
  if (detailPane) detailPane.hidden = false
}

function artifactRows(arts, details, key) {
  const detailed = details && Array.isArray(details[key]) ? details[key] : null
  if (detailed && detailed.length) {
    return detailed
      .map((row) => {
        const id = String(row?.id || '').trim()
        const name = String(row?.name || '').trim()
        if (!id && !name) return null
        return { id, name: name || id }
      })
      .filter(Boolean)
  }
  const ids = arts && Array.isArray(arts[key]) ? arts[key] : []
  return ids.map((id) => ({ id: String(id), name: String(id) }))
}

function renderArtifactBlocks(arts, details) {
  const blocks = ARTIFACT_LABELS.map(([key, label]) => {
    const rows = artifactRows(arts, details, key)
    if (!rows.length) return ''
    const chips = rows
      .map((row) => {
        const showCode = row.id && row.name && row.id !== row.name
        return `<span class="sr-chip sr-chip--named" title="${esc(row.id)}">
          <b>${esc(row.name)}</b>
          ${showCode ? `<code>${esc(row.id)}</code>` : ''}
        </span>`
      })
      .join('')
    return `
      <div class="sr-detail-block">
        <h4>${esc(label)} <span class="sr-muted">(${rows.length})</span></h4>
        <div class="sr-chip-row">${chips}</div>
      </div>`
  }).filter(Boolean)
  if (!blocks.length) {
    return `<div class="sr-detail-block"><p class="sr-muted">暂无产物记录</p></div>`
  }
  return blocks.join('')
}

function renderList(items) {
  const list = _root?.querySelector('[data-ip-list]')
  const countEl = _root?.querySelector('[data-ip-count]')
  if (!list) return
  _items = Array.isArray(items) ? items : []
  reportCount(_items.length)
  if (countEl) countEl.textContent = _items.length ? `${_items.length} 个` : ''
  if (!_items.length) {
    list.innerHTML = `
      <div class="sr-empty">
        <b>还没有安装资源包</b>
        <p>资源包会一次性装好员工、工作流与技能编排。去市场逛逛,或导入本地包。</p>
        <div class="sr-empty-actions">
          <button type="button" class="sr-btn sr-btn--primary" data-ip-act="goto-market">去获取资源</button>
          <button type="button" class="sr-btn" data-ip-act="goto-mine">打包分享本机资源</button>
        </div>
      </div>`
    return
  }
  list.innerHTML = _items
    .map((it) => {
      const id = esc(it.org_instance_id)
      const title = packTitle(it)
      const desc = String(it.description || '').trim()
      const showId = it.pack_id && it.pack_id !== title
      return `
      <article class="sr-card sr-card--clickable" data-org-id="${id}" data-ip-act="open-detail" tabindex="0" role="button" aria-label="查看 ${esc(title)} 详情">
        <span class="sr-type-icon" title="${esc(kindLabel(it.kind))}">${kindIcon(it.kind)}</span>
        <div class="sr-card-main">
          <div class="sr-card-title">
            <span>${esc(title)}</span>
            <span class="sr-badge">${esc(kindLabel(it.kind))}</span>
            <span class="sr-badge sr-badge--muted">v${esc(it.pack_version)}</span>
          </div>
          ${desc ? `<div class="sr-card-meta">${esc(desc)}</div>` : ''}
          <div class="sr-card-meta">${esc(artifactSummary(it.artifacts))}${
            showId ? ` · <code>${esc(it.pack_id)}</code>` : ''
          }</div>
          <div class="sr-card-meta">安装于 ${esc(fmtTime(it.installed_at))}${
            it.workspace_path ? ` · 工作区 ${esc(it.workspace_path)}` : ''
          }</div>
        </div>
        <div class="sr-card-actions">
          <button type="button" class="sr-btn" data-ip-act="open-detail" data-org-id="${id}">详情</button>
          <button type="button" class="sr-btn sr-btn--danger" data-ip-act="uninstall" data-org-id="${id}">卸载</button>
        </div>
      </article>`
    })
    .join('')
}

function renderDetail(it) {
  const host = _root?.querySelector('[data-ip-detail]')
  const titleEl = _root?.querySelector('[data-ip-detail-title]')
  if (!host) return
  const title = packTitle(it)
  if (titleEl) titleEl.textContent = title
  const ws = String(it.workspace_path || '').trim()
  const wsWarn = ws.includes('${')
    ? `<p class="sr-warn">工作区路径仍含占位符,可能是安装时未展开。重新安装或在安装时选择工作区可修复。</p>`
    : ''
  host.innerHTML = `
    <div class="sr-detail-hero">
      <div>
        <div class="sr-card-title" style="margin:0 0 8px">
          <span>${esc(title)}</span>
          <span class="sr-badge">${esc(kindLabel(it.kind))}</span>
          <span class="sr-badge sr-badge--muted">v${esc(it.pack_version)}</span>
          <span class="sr-badge sr-badge--muted">${esc(it.status || 'active')}</span>
        </div>
        <p class="sr-card-meta" style="margin:0">${esc(it.description || '无描述')}</p>
      </div>
    </div>
    <div class="sr-detail-block">
      <h4>实例信息</h4>
      <dl class="sr-kv">
        <div><dt>显示名</dt><dd>${esc(title)}</dd></div>
        <div><dt>包 id</dt><dd><code>${esc(it.pack_id || '—')}</code></dd></div>
        <div><dt>实例 id</dt><dd><code>${esc(it.org_instance_id || '—')}</code></dd></div>
        <div><dt>安装时间</dt><dd>${esc(fmtTime(it.installed_at))}</dd></div>
        <div><dt>工作区</dt><dd>${ws ? `<code>${esc(ws)}</code>` : '—'}</dd></div>
      </dl>
      ${wsWarn}
    </div>
    <div class="sr-detail-block">
      <h4>已装产物</h4>
      <p class="sr-muted" style="margin:0 0 10px">安装时写入系统的员工 / 智能体 / 技能 / 扩展等;主文案为中文显示名,编码可悬停查看。</p>
      ${renderArtifactBlocks(it.artifacts, it.artifact_details)}
    </div>
  `
}

async function openDetail(orgId) {
  const id = String(orgId || '').trim()
  if (!id) return
  _detailId = id
  showDetailPane()
  const host = _root?.querySelector('[data-ip-detail]')
  if (host) host.innerHTML = `<div class="sr-empty">加载详情…</div>`
  try {
    let it = _items.find((x) => x.org_instance_id === id)
    const remote = await api.orgGet(id)
    if (remote && typeof remote === 'object') it = { ...(it || {}), ...remote }
    if (!it) throw new Error(`未找到实例：${id}`)
    renderDetail(it)
  } catch (e) {
    if (host) {
      host.innerHTML = `<div class="sr-empty sr-empty--error">加载失败：${esc(e?.message || e)}</div>`
    }
    toast.error(String(e?.message || e))
  }
}

async function refresh() {
  const list = _root?.querySelector('[data-ip-list]')
  if (list && !_detailId) list.innerHTML = `<div class="sr-empty">加载中…</div>`
  try {
    const res = await api.orgList('active')
    renderList(res?.items || [])
    if (_detailId) {
      const still = _items.some((x) => x.org_instance_id === _detailId)
      if (still) await openDetail(_detailId)
      else showList()
    }
  } catch (e) {
    if (list) {
      list.innerHTML = `<div class="sr-empty sr-empty--error">加载失败：${esc(e?.message || e)}</div>`
    }
    toast.error(String(e?.message || e))
  }
}

async function uninstall(orgId) {
  if (!orgId) return
  const cached = _items.find((x) => x.org_instance_id === orgId)
  const label = cached ? packTitle(cached) : orgId
  const ok = window.confirm(
    `卸载资源包「${label}」？\n将移除其员工与工作流；默认保留工作区文件。`,
  )
  if (!ok) return
  try {
    toast('正在卸载…')
    await api.orgUninstall({
      org_instance_id: orgId,
      options: { keep_primitives: false, keep_workspace: true, keep_vault_data: true },
    })
    toast.success('已卸载')
    _detailId = ''
    showList()
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
  if (act === 'back-list') showList()
  if (act === 'open-detail') {
    void openDetail(actBtn.getAttribute('data-org-id') || '')
  }
  if (act === 'uninstall') void uninstall(actBtn.getAttribute('data-org-id') || '')
  if (act === 'uninstall-detail') void uninstall(_detailId)
}

function onKeydown(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return
  const t = e.target
  if (!(t instanceof Element)) return
  const card = t.closest('article.sr-card--clickable[data-ip-act="open-detail"]')
  if (!card || t.closest('button')) return
  e.preventDefault()
  void openDetail(card.getAttribute('data-org-id') || '')
}

/**
 * @param {HTMLElement} container
 * @param {{ embedded?: boolean }} [opts]
 */
export async function mountInstalledPacksInto(container, opts = {}) {
  cleanup()
  _root = container
  _detailId = ''
  container.innerHTML = shellHtml(!!opts.embedded)
  container.addEventListener('click', onClick)
  container.addEventListener('keydown', onKeydown)
  await refresh()
}

export function cleanup() {
  if (_root) {
    _root.removeEventListener('click', onClick)
    _root.removeEventListener('keydown', onKeydown)
    _root = null
  }
  _items = []
  _detailId = ''
}
