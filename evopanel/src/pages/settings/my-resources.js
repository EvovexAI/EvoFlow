/**
 * 设置 → 资源 → 我的
 * 左：本机资源可搜可选；右：资源包草稿（导出）
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

const KIND_LABEL = {
  employee: '员工',
  agent: 'Agent',
  app: '工作流',
  skill: '技能',
  knowledge: '知识库',
  extension: '扩展',
}

const FILTERS = [
  { id: 'all', label: '全部', nav: '' },
  { id: 'employee', label: '员工', nav: '/proactive' },
  { id: 'agent', label: 'Agent', nav: '/agents' },
  { id: 'app', label: '工作流', nav: '/apps' },
  { id: 'skill', label: '技能', nav: '/skills' },
  { id: 'knowledge', label: '知识库', nav: '/knowledge' },
  { id: 'extension', label: '扩展', nav: '/extensions' },
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

function shellHtml() {
  const chips = FILTERS.map(
    (f) =>
      `<button type="button" class="sr-chip${f.id === 'all' ? ' is-active' : ''}" data-sr-filter="${f.id}" role="tab">${f.label}</button>`,
  ).join('')
  return `
    <div class="sr-root sr-root--workbench">
      <div class="sr-workbench">
        <aside class="sr-wb-left">
          <div class="sr-wb-toolbar">
            <input class="sr-search" type="search" data-sr-q placeholder="搜索名称、code、id…" autocomplete="off" />
            <button type="button" class="sr-btn" data-sr-act="refresh" title="刷新">刷新</button>
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
            <h3 class="sr-draft-title">资源包草稿</h3>
            <p class="sr-muted">勾选左侧资源后在此打包导出；别处可用「市场 → 导入本地」安装。</p>
          </div>
          <div class="sr-draft-fields">
            <div class="sr-import-row">
              <input class="sr-input" type="text" data-ex-id placeholder="包 id（kebab-case）" value="my-export" />
              <input class="sr-input" type="text" data-ex-name placeholder="显示名" value="我的资源包" />
              <input class="sr-input sr-input--sm" type="text" data-ex-ver placeholder="版本" value="1.0.0" />
            </div>
            <textarea class="sr-textarea sr-textarea--sm" data-ex-desc placeholder="简介（可选）"></textarea>
          </div>
          <div class="sr-draft-summary" data-sr-draft-summary></div>
          <div class="sr-draft-basket" data-sr-basket></div>
          <div class="sr-draft-deps sr-muted" data-sr-deps></div>
          <div class="sr-draft-export">
            <div class="sr-import-row">
              <input class="sr-input" type="text" data-ex-dir placeholder="导出目录" />
              <button type="button" class="sr-btn" data-sr-act="pick-dir">选目录</button>
              <label class="sr-check"><input type="checkbox" data-ex-zip checked /> zip</label>
            </div>
            <label class="sr-check sr-check--block">
              <input type="checkbox" data-ex-vault-data />
              打包知识库正文（默认否，仅写入 vault id 引用）
            </label>
            <div class="sr-import-actions">
              <button type="button" class="sr-btn" data-sr-act="goto-assets">资产中心</button>
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
    list.innerHTML = `<div class="sr-empty">本机还没有可列出的资源。</div>`
    return
  }
  if (!rows.length) {
    list.innerHTML = `<div class="sr-empty">没有匹配「${esc(_query)}」的项。</div>`
    return
  }
  list.innerHTML = rows
    .map((it) => {
      const on = _selected.has(it.key)
      return `
      <label class="sr-pick${on ? ' is-selected' : ''}" data-sr-key="${esc(it.key)}">
        <input type="checkbox" data-sr-check value="${esc(it.key)}" ${on ? 'checked' : ''} />
        <div class="sr-pick-body">
          <div class="sr-pick-title">
            <span>${esc(it.title)}</span>
            <span class="sr-badge">${esc(KIND_LABEL[it.kind] || it.kind)}</span>
            ${(Array.isArray(it.badges) ? it.badges : it.badge ? [it.badge] : [])
              .map((b) => `<span class="sr-badge sr-badge--muted">${esc(b)}</span>`)
              .join('')}
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
  const parts = Object.keys(KIND_LABEL)
    .filter((k) => counts[k])
    .map((k) => `${KIND_LABEL[k]} ${counts[k]}`)
  summary.textContent = parts.length ? `已选：${parts.join(' · ')}` : '尚未勾选资源'
  if (!picked.length) {
    basket.innerHTML = `<div class="sr-inv-empty">在左侧勾选员工、工作流等，将出现在这里。</div>`
  } else {
    basket.innerHTML = `
      <ul class="sr-basket-list">
        ${picked
          .map(
            (it) => `
          <li class="sr-basket-row">
            <span class="sr-badge sr-badge--muted">${esc(KIND_LABEL[it.kind] || it.kind)}</span>
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
    if (counts.extension) tips.push('扩展仅写入 id 引用（Gateway 无法拷贝扩展文件）')
    if (counts.knowledge) tips.push('知识库默认只写 vault id，不打包正文')
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
    const f = FILTERS.find((x) => x.id === _filterKind)
    const nav = f?.nav || ''
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
    api.listKnowledgeVaults(),
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

  const vaultsRaw = val(5, [])
  const vaults = Array.isArray(vaultsRaw)
    ? vaultsRaw
    : Array.isArray(vaultsRaw?.items)
      ? vaultsRaw.items
      : Array.isArray(vaultsRaw?.vaults)
        ? vaultsRaw.vaults
        : []
  for (const v of vaults) {
    const id = String(v.id || '').trim()
    if (!id) continue
    const title = String(v.name || v.title || id).trim() || id
    out.push({
      key: `knowledge:vault:${id}`,
      kind: 'knowledge',
      id,
      title,
      meta: v.path ? String(v.path) : 'Vault',
      badge: 'Vault',
      nav: '/knowledge',
      search: `${title} ${id} vault ${v.path || ''}`.toLowerCase(),
    })
  }

  const exts = Array.isArray(val(6, [])) ? val(6, []) : []
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
        title: '选择导出父目录（将在其下创建包文件夹）',
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
    toast.error('请至少勾选 1 个员工或 1 个工作流（资源包 kind 需要其一）')
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
    const warn = Array.isArray(res?.warnings) && res.warnings.length ? `（${res.warnings.length} 条警告）` : ''
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
