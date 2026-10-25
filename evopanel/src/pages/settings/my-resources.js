/**
 * 设置 → 资源中心 → 打包分享
 * 左：本机资源可搜可选；右：三步打包台(选资源 → 包信息 → 导出)
 */
import '../../style/settings-resources.css'
import { api } from '../../lib/tauri-api.js'
import { toast } from '../../components/toast.js'
import { navigate } from '../../router.js'

/** @type {HTMLElement | null} */
let _root = null

/** @typedef {{ key: string, kind: string, id: string, title: string, meta: string, badge: string, nav: string, search: string }} InvItem */

/** @type {InvItem[]} */
let _items = []
/** @type {Set<string>} */
let _selected = new Set()
/** @type {string} */
let _filterKind = 'all'
/** @type {string} */
let _query = ''

const ICONS = {
  employee: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  agent: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M12 8V4m-5 8h.01M17 12h.01M9 16h6"/></svg>',
  app: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><path d="M10 6.5h7a1 1 0 0 1 1 1V14M14 17.5H7a1 1 0 0 1-1-1V10"/></svg>',
  skill: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4.5 13.5H11l-1 8.5L18.5 10.5H12z"/></svg>',
  knowledge: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>',
  extension: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3m0 12v3M3 12h3m12 0h3M7 7l2 2m6 6 2 2m0-10-2 2m-6 6-2 2"/><circle cx="12" cy="12" r="3"/></svg>',
}

const KIND_META = {
  employee: { label: '员工', tone: 'violet' },
  agent: { label: 'Agent', tone: 'sky' },
  app: { label: '工作流', tone: 'amber' },
  skill: { label: '技能', tone: 'emerald' },
  knowledge: { label: '知识库', tone: 'rose' },
  extension: { label: '扩展', tone: 'slate' },
}

function kindLabel(kind) {
  return KIND_META[kind]?.label || kind
}

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'employee', label: '员工' },
  { id: 'agent', label: 'Agent' },
  { id: 'app', label: '工作流' },
  { id: 'skill', label: '技能' },
  { id: 'knowledge', label: '知识库' },
  { id: 'extension', label: '扩展' },
]

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function isTauriDesktop() {
  return !!(window.__TAURI_INTERNALS__ || window.__TAURI__)
}

function reportCount(n) {
  _root?.dispatchEvent(new CustomEvent('sr-count', { detail: { panel: 'mine', count: n }, bubbles: true }))
}

function shellHtml() {
  const chips = FILTERS.map(
    (f) =>
      `<button type="button" class="sr-chip${f.id === 'all' ? ' is-active' : ''}" data-sr-filter="${f.id}" role="tab">${f.label}</button>`,
  ).join('')
  return `
    <div class="sr-root sr-root--workbench">
      <div class="sr-workbench">
        <aside class="sr-wb-left">
          <div class="sr-wb-head">
            <div class="min-w-0">
              <h3>本机资源</h3>
              <p class="sr-muted">勾选要打包的员工、工作流、技能等</p>
            </div>
            <button type="button" class="sr-btn" data-sr-act="refresh" title="刷新清单">刷新</button>
          </div>
          <div class="sr-wb-toolbar">
            <input class="sr-search" type="search" data-sr-q placeholder="搜索名称、code、id…" autocomplete="off" />
          </div>
          <div class="sr-chips" role="tablist" aria-label="资源类型">${chips}</div>
          <div class="sr-wb-bulk">
            <button type="button" class="sr-btn sr-btn--ghost" data-sr-act="select-visible">全选当前</button>
            <button type="button" class="sr-btn sr-btn--ghost" data-sr-act="clear-sel">清空选择</button>
            <button type="button" class="sr-btn sr-btn--ghost" data-sr-act="manage-kind" hidden data-sr-manage>去管理</button>
            <span class="sr-muted" data-sr-list-meta></span>
          </div>
          <div class="sr-wb-list" data-sr-list>
            <div class="sr-empty">加载中…</div>
          </div>
        </aside>
        <section class="sr-wb-right">
          <div class="sr-draft-head">
            <h3 class="sr-draft-title">打包分享</h3>
            <p class="sr-muted">把勾选的资源打包成资源包,导出后发给同事,或在另一台设备「获取资源 → 导入本地资源包」安装。</p>
          </div>

          <div class="sr-draft-block">
            <div class="sr-draft-block-head">
              <span class="sr-step-no">1</span><b>已选资源</b>
              <span class="sr-muted" data-sr-draft-summary></span>
            </div>
            <div class="sr-draft-basket" data-sr-basket></div>
            <div class="sr-draft-deps sr-muted" data-sr-deps></div>
          </div>

          <div class="sr-draft-block">
            <div class="sr-draft-block-head">
              <span class="sr-step-no">2</span><b>包信息</b>
            </div>
            <div class="sr-draft-fields">
              <div class="sr-import-row">
                <input class="sr-input" type="text" data-ex-id placeholder="包 id(kebab-case)" value="my-export" />
                <input class="sr-input" type="text" data-ex-name placeholder="显示名" value="我的资源包" />
                <input class="sr-input sr-input--sm" type="text" data-ex-ver placeholder="版本" value="1.0.0" />
              </div>
              <textarea class="sr-textarea sr-textarea--sm" data-ex-desc placeholder="简介(可选)"></textarea>
            </div>
          </div>

          <div class="sr-draft-block">
            <div class="sr-draft-block-head">
              <span class="sr-step-no">3</span><b>导出</b>
            </div>
            <div class="sr-import-row">
              <input class="sr-input" type="text" data-ex-dir placeholder="导出目录" />
              <button type="button" class="sr-btn" data-sr-act="pick-dir">选目录</button>
              <label class="sr-check"><input type="checkbox" data-ex-zip checked /> zip</label>
            </div>
            <label class="sr-check sr-check--block">
              <input type="checkbox" data-ex-vault-data />
              打包知识库正文(默认否,仅写入 vault id 引用)
            </label>
            <div class="sr-draft-actions">
              <button type="button" class="sr-btn" data-sr-act="goto-assets">打开资产中心</button>
              <button type="button" class="sr-btn sr-btn--primary" data-sr-act="export">导出资源包</button>
            </div>
            <pre class="sr-log" data-ex-log hidden></pre>
          </div>
        </section>
      </div>
    </div>
  `
}

function visibleItems() {
  const q = _query.trim().toLowerCase()
  return _items.filter((it) => {
    if (_filterKind !== 'all' && it.kind !== _filterKind) return false
    if (!q) return true
    return it.search.includes(q)
  })
}

function selectedItems() {
  return _items.filter((it) => _selected.has(it.key))
}

function renderList() {
  const list = _root?.querySelector('[data-sr-list]')
  const meta = _root?.querySelector('[data-sr-list-meta]')
  if (!list) return
  const rows = visibleItems()
  if (meta) {
    meta.textContent = `显示 ${rows.length} / 共 ${_items.length} · 已选 ${_selected.size}`
  }
  if (!_items.length) {
    list.innerHTML = `
      <div class="sr-empty">
        <b>本机还没有可列出的资源</b>
        <p>先到「工作台 / 员工 / 工作流」里创建内容,再回来打包分享。</p>
      </div>`
    return
  }
  if (!rows.length) {
    list.innerHTML = `<div class="sr-empty">没有匹配「${esc(_query)}」的项。</div>`
    return
  }
  list.innerHTML = rows
    .map((it) => {
      const on = _selected.has(it.key)
      const tone = KIND_META[it.kind]?.tone || 'slate'
      const badges = (Array.isArray(it.badges) ? it.badges : it.badge ? [it.badge] : [])
        .map((b) => `<span class="sr-badge sr-badge--muted">${esc(b)}</span>`)
        .join('')
      return `
      <label class="sr-pick${on ? ' is-selected' : ''}" data-sr-key="${esc(it.key)}">
        <input type="checkbox" data-sr-check value="${esc(it.key)}" ${on ? 'checked' : ''} />
        <span class="sr-type-icon sr-type-icon--${tone}">${ICONS[it.kind] || ICONS.extension}</span>
        <div class="sr-pick-body">
          <div class="sr-pick-title">
            <span>${esc(it.title)}</span>
            <span class="sr-badge">${esc(kindLabel(it.kind))}</span>
            ${badges}
          </div>
          ${it.meta ? `<div class="sr-pick-meta">${esc(it.meta)}</div>` : ''}
        </div>
      </label>`
    })
    .join('')
}

function renderBasket() {
  const basket = _root?.querySelector('[data-sr-basket]')
  const summary = _root?.querySelector('[data-sr-draft-summary]')
  const deps = _root?.querySelector('[data-sr-deps]')
  if (!basket || !summary) return
  const picked = selectedItems()
  const counts = {}
  for (const it of picked) {
    counts[it.kind] = (counts[it.kind] || 0) + 1
  }
  const parts = Object.keys(KIND_META)
    .filter((k) => counts[k])
    .map((k) => `${KIND_META[k].label} ${counts[k]}`)
  summary.textContent = parts.length ? parts.join(' · ') : '尚未勾选'
  if (!picked.length) {
    basket.innerHTML = `<div class="sr-inv-empty">在左侧勾选员工、工作流等,将出现在这里。</div>`
  } else {
    basket.innerHTML = `
      <ul class="sr-basket-list">
        ${picked
          .map(
            (it) => `
          <li class="sr-basket-row">
            <span class="sr-type-icon sr-type-icon--${KIND_META[it.kind]?.tone || 'slate'} sr-type-icon--xs">${ICONS[it.kind] || ICONS.extension}</span>
            <span class="sr-basket-title">${esc(it.title)}</span>
            <button type="button" class="sr-btn sr-btn--ghost sr-btn--tiny" data-sr-act="unpick" data-sr-key="${esc(it.key)}">移除</button>
          </li>`,
          )
          .join('')}
      </ul>`
  }
  if (deps) {
    const tips = []
    if (counts.employee) tips.push('员工会自动带上对应 Agent')
    if (counts.app) tips.push('工作流步骤里的 assigned_agent 会自动补入')
    if (counts.skill) tips.push('技能目录会复制进包')
    if (counts.extension) tips.push('扩展仅写入 id 引用(Gateway 无法拷贝扩展文件)')
    if (counts.knowledge) tips.push('知识库默认只写 vault id,不打包正文')
    deps.textContent = tips.length ? `将自动处理：${tips.join('；')}` : ''
  }
}

function syncFilterChips() {
  _root?.querySelectorAll('[data-sr-filter]').forEach((btn) => {
    const on = btn.getAttribute('data-sr-filter') === _filterKind
    btn.classList.toggle('is-active', on)
  })
  const manage = _root?.querySelector('[data-sr-manage]')
  if (manage instanceof HTMLElement) {
    const navByKind = {
      employee: '/proactive',
      agent: '/agents',
      app: '/apps',
      skill: '/skills',
      knowledge: '/knowledge',
      extension: '/extensions',
    }
    const nav = navByKind[_filterKind] || ''
    manage.hidden = !nav
    if (nav) manage.setAttribute('data-nav', nav)
  }
}

function rerender() {
  syncFilterChips()
  renderList()
  renderBasket()
}

function setSelected(key, on) {
  if (on) _selected.add(key)
  else _selected.delete(key)
}

function buildIncludeFromSelection() {
  const employee_codes = []
  const app_ids = []
  const agent_codes = []
  const skill_names = []
  const extension_ids = []
  const vault_ids = []
  for (const it of selectedItems()) {
    if (it.kind === 'employee') employee_codes.push(it.id)
    else if (it.kind === 'app') app_ids.push(it.id)
    else if (it.kind === 'agent') agent_codes.push(it.id)
    else if (it.kind === 'skill') skill_names.push(it.id)
    else if (it.kind === 'extension') extension_ids.push(it.id)
    else if (it.kind === 'knowledge') vault_ids.push(it.id)
  }
  return { employee_codes, app_ids, agent_codes, skill_names, extension_ids, vault_ids }
}

/**
 * @returns {Promise<InvItem[]>}
 */
async function loadAllItems() {
  const settled = await Promise.allSettled([
    api.listAgents(),
    api.proactiveListRoles(),
    api.listApps(),
    api.loadSkills(),
    api.listOwnedKnowledgeBases(),
    import('../../lib/ui-extensions.js').then((m) => m.listUiExtensions()),
  ])
  const val = (i, fb) => (settled[i].status === 'fulfilled' ? settled[i].value : fb)

  /** @type {InvItem[]} */
  const out = []

  const agents = Array.isArray(val(0, [])) ? val(0, []) : []
  for (const a of agents) {
    const id = String(a.agent_code || a.name || '').trim()
    if (!id) continue
    const title = String(a.agent_name || a.display_name || a.name || id).trim() || id
    const meta = [id !== title ? id : '', a.description ? String(a.description).slice(0, 80) : '']
      .filter(Boolean)
      .join(' · ')
    out.push({
      key: `agent:${id}`,
      kind: 'agent',
      id,
      title,
      meta,
      badge: a.model ? String(a.model) : '',
      nav: '/agents',
      search: `${title} ${id} ${meta}`.toLowerCase(),
    })
  }

  const roles = (Array.isArray(val(1, { roles: [] })?.roles) ? val(1, { roles: [] }).roles : []).filter(
    (r) => String(r.status || '') !== 'archived',
  )
  for (const r of roles) {
    const id = String(r.agent_code || '').trim()
    if (!id) continue
    const title = String(r.role_name || r.display_name || r.name || id).trim() || id
    out.push({
      key: `employee:${id}`,
      kind: 'employee',
      id,
      title,
      meta: [id !== title ? id : '', r.status].filter(Boolean).join(' · '),
      badge: r.status && r.status !== 'active' ? String(r.status) : '',
      nav: '/proactive',
      search: `${title} ${id} ${r.status || ''}`.toLowerCase(),
    })
  }

  const apps = Array.isArray(val(2, [])) ? val(2, []) : []
  for (const a of apps) {
    const id = String(a.id || a.app_id || '').trim()
    if (!id) continue
    const title = String(a.name || a.title || id).trim() || id
    out.push({
      key: `app:${id}`,
      kind: 'app',
      id,
      title,
      meta: id !== title ? id : '',
      badge: a.status ? String(a.status) : '',
      nav: '/apps',
      search: `${title} ${id}`.toLowerCase(),
    })
  }

  const skills = Array.isArray(val(3, [])) ? val(3, []) : []
  for (const s of skills) {
    const id = String(s.name || '').trim()
    if (!id) continue
    const cat = String(s.category || '').toLowerCase()
    let sourceLabel = '自定义'
    if (cat === 'public') sourceLabel = '系统'
    else if (/skillhub/i.test(String(s.license || '')) || id.toLowerCase().includes('skillhub')) {
      sourceLabel = 'SkillHub'
    } else if (cat === 'custom' || !cat) sourceLabel = '自定义'
    else sourceLabel = cat
    const badges = [sourceLabel]
    if (s.enabled === false) badges.push('已禁用')
    out.push({
      key: `skill:${id}`,
      kind: 'skill',
      id,
      title: id,
      meta: s.description ? String(s.description).slice(0, 80) : '',
      badge: badges[0],
      badges,
      nav: '/skills',
      search: `${id} ${s.description || ''} ${sourceLabel} ${cat}`.toLowerCase(),
    })
  }

  const ownedRes = val(4, { items: [] })
  const owned = Array.isArray(ownedRes?.items) ? ownedRes.items : Array.isArray(ownedRes) ? ownedRes : []
  for (const b of owned) {
    const id = String(b.id || '').trim()
    if (!id) continue
    const title = String(b.name || b.title || id).trim() || id
    const n = b.documentCount ?? b.document_count
    out.push({
      key: `knowledge:owned:${id}`,
      kind: 'knowledge',
      id,
      title,
      meta: typeof n === 'number' ? `自有 · ${n} 篇` : '自有知识库',
      badge: '自有',
      nav: '/knowledge',
      search: `${title} ${id} owned`.toLowerCase(),
    })
  }

  const exts = Array.isArray(val(5, [])) ? val(5, []) : []
  for (const x of exts) {
    if (!x || x.kind === 'suite' || String(x.manifest?.kind || '') === 'suite') continue
    const id = String(x.id || x.manifest?.id || '').trim()
    if (!id) continue
    const title = String(x.name || x.manifest?.name || id).trim() || id
    out.push({
      key: `extension:${id}`,
      kind: 'extension',
      id,
      title,
      meta: id !== title ? id : '',
      badge: x.enabled === false ? '已禁用' : '',
      nav: '/extensions',
      search: `${title} ${id}`.toLowerCase(),
    })
  }

  return out
}

async function refresh() {
  const list = _root?.querySelector('[data-sr-list]')
  if (list) list.innerHTML = `<div class="sr-empty">加载中…</div>`
  try {
    _items = await loadAllItems()
    reportCount(_items.length)
    // drop selections that no longer exist
    const keys = new Set(_items.map((i) => i.key))
    for (const k of [..._selected]) {
      if (!keys.has(k)) _selected.delete(k)
    }
    rerender()
  } catch (e) {
    if (list) {
      list.innerHTML = `<div class="sr-empty sr-empty--error">加载失败：${esc(e?.message || e)}</div>`
    }
    toast.error(String(e?.message || e))
  }
}

async function pickDir() {
  let path = ''
  if (isTauriDesktop()) {
    try {
      const dlg = await import('@tauri-apps/plugin-dialog')
      const picked = await dlg.open({
        directory: true,
        multiple: false,
        title: '选择导出父目录(将在其下创建包文件夹)',
      })
      const p = Array.isArray(picked) ? picked[0] : picked
      if (!p) return
      path = String(p)
    } catch (e) {
      toast.error(String(e?.message || e))
      return
    }
  } else {
    const next = window.prompt('导出目录绝对路径')
    if (next == null) return
    path = String(next).trim()
  }
  const idEl = _root?.querySelector('[data-ex-id]')
  const id = idEl instanceof HTMLInputElement ? idEl.value.trim() || 'my-export' : 'my-export'
  const input = _root?.querySelector('[data-ex-dir]')
  if (input instanceof HTMLInputElement) {
    const sep = path.includes('\\') ? '\\' : '/'
    input.value = `${path.replace(/[\\/]+$/, '')}${sep}${id}`
  }
}

async function runExport() {
  const include = buildIncludeFromSelection()
  if (!include.employee_codes.length && !include.app_ids.length) {
    toast.error('请至少勾选 1 个员工或 1 个工作流(资源包 kind 需要其一)')
    return
  }
  const idEl = _root?.querySelector('[data-ex-id]')
  const nameEl = _root?.querySelector('[data-ex-name]')
  const verEl = _root?.querySelector('[data-ex-ver]')
  const descEl = _root?.querySelector('[data-ex-desc]')
  const dirEl = _root?.querySelector('[data-ex-dir]')
  const zipEl = _root?.querySelector('[data-ex-zip]')
  const vaultDataEl = _root?.querySelector('[data-ex-vault-data]')
  const logEl = _root?.querySelector('[data-ex-log]')
  const packId = idEl instanceof HTMLInputElement ? idEl.value.trim() : ''
  const name = nameEl instanceof HTMLInputElement ? nameEl.value.trim() : ''
  const version = verEl instanceof HTMLInputElement ? verEl.value.trim() : '1.0.0'
  const description = descEl instanceof HTMLTextAreaElement ? descEl.value.trim() : ''
  const dir = dirEl instanceof HTMLInputElement ? dirEl.value.trim() : ''
  if (!dir) {
    toast.error('请填写导出目录')
    return
  }
  try {
    toast('正在导出…')
    const res = await api.orgExport({
      pack: {
        id: packId || 'my-export',
        name: name || packId || '我的资源包',
        version: version || '1.0.0',
        description,
      },
      include: {
        ...include,
        include_vault_data: !!(vaultDataEl instanceof HTMLInputElement && vaultDataEl.checked),
      },
      output: { dir, zip: !!(zipEl instanceof HTMLInputElement && zipEl.checked) },
    })
    if (logEl) {
      logEl.hidden = false
      logEl.textContent = JSON.stringify(res, null, 2)
    }
    const warn = Array.isArray(res?.warnings) && res.warnings.length ? `(${res.warnings.length} 条警告)` : ''
    toast.success(`已导出到 ${res?.output_dir || dir}${warn}`)
  } catch (e) {
    const detail = e?.detail
    const msg =
      (detail && typeof detail === 'object' && (detail.error || detail.detail)) || e?.message || e
    toast.error(String(msg))
    if (logEl) {
      logEl.hidden = false
      logEl.textContent = JSON.stringify(detail || String(msg), null, 2)
    }
  }
}

function onClick(e) {
  const t = e.target
  if (!(t instanceof Element)) return

  const filter = t.closest('[data-sr-filter]')
  if (filter && _root?.contains(filter)) {
    _filterKind = filter.getAttribute('data-sr-filter') || 'all'
    rerender()
    return
  }

  const actBtn = t.closest('[data-sr-act]')
  if (actBtn && _root?.contains(actBtn)) {
    const act = actBtn.getAttribute('data-sr-act')
    if (act === 'refresh') void refresh()
    if (act === 'select-visible') {
      for (const it of visibleItems()) _selected.add(it.key)
      rerender()
    }
    if (act === 'clear-sel') {
      _selected.clear()
      rerender()
    }
    if (act === 'unpick') {
      setSelected(actBtn.getAttribute('data-sr-key') || '', false)
      rerender()
    }
    if (act === 'manage-kind') {
      const path = actBtn.getAttribute('data-nav')
      if (path) navigate(path)
    }
    if (act === 'pick-dir') void pickDir()
    if (act === 'export') void runExport()
    if (act === 'goto-assets') navigate('/assets')
    return
  }
}

function onChange(e) {
  const t = e.target
  if (!(t instanceof HTMLInputElement)) return
  if (t.matches('[data-sr-check]')) {
    setSelected(t.value, t.checked)
    rerender()
  }
}

function onInput(e) {
  const t = e.target
  if (!(t instanceof HTMLInputElement)) return
  if (t.matches('[data-sr-q]')) {
    _query = t.value || ''
    renderList()
    const meta = _root?.querySelector('[data-sr-list-meta]')
    if (meta) {
      meta.textContent = `显示 ${visibleItems().length} / 共 ${_items.length} · 已选 ${_selected.size}`
    }
  }
}

/**
 * @param {HTMLElement} container
 * @param {{ embedded?: boolean, preselectKeys?: string[] }} [opts]
 */
export async function mountMyResourcesInto(container, opts = {}) {
  cleanup()
  _root = container
  _filterKind = 'all'
  _query = ''
  _selected = new Set(Array.isArray(opts.preselectKeys) ? opts.preselectKeys : [])
  container.innerHTML = shellHtml()
  container.addEventListener('click', onClick)
  container.addEventListener('change', onChange)
  container.addEventListener('input', onInput)
  await refresh()
}

export function cleanup() {
  if (_root) {
    _root.removeEventListener('click', onClick)
    _root.removeEventListener('change', onChange)
    _root.removeEventListener('input', onInput)
    _root = null
  }
  _items = []
  _selected = new Set()
  _filterKind = 'all'
  _query = ''
}
