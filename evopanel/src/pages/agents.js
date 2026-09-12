/**
 * 智能体列表页 — #/expert (agents tab)
 * 二级视图 + 压缩筛选 + 扁平角色列表
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { showContentModal } from '../components/modal.js'
import {
  AGENT_DEPLOY_OPTIONS,
  AGENT_PURPOSE_OPTIONS,
  AGENT_SORT_OPTIONS,
  AGENT_SOURCE_OPTIONS,
  AGENT_STATUS_OPTIONS,
  collectTagsFromAgents,
  countAgentsWithTag,
  escapeAttr,
  escapeHtml,
  sortAgents,
  tagMetaForLabel,
} from './agents-shared.js'
import {
  attachRoleEvents,
  closeAgentDetailDrawer,
  preloadRoleToolsMeta,
  renderRoleCards,
  renderRoleSkeleton,
  showCreateRoleDialog,
} from './agents-role-ui.js'
import { readStoredPageSize } from '../components/list-pager.js'

const AGENTS_PAGE_SIZE_KEY = 'evopanel_agents_page_size'

const SKILLHUB_PACKAGE_HOME = 'https://www.skillhub.cn/skillspackage'
const SKILLHUB_EXAMPLE_URL = 'https://www.skillhub.cn/skillspackage/media-script-breakdown'

const VIEW_TABS = [
  { id: 'mine', label: '我的智能体' },
  { id: 'deployed', label: '已部署' },
  { id: 'market', label: '模板市场' },
]

/** 空间不足时优先收进「更多筛选」的顺序（先收右侧） */
const COLLAPSE_FILTER_ORDER = [
  'roles-filter-deploy',
  'roles-filter-source',
  'roles-filter-purpose',
  'roles-filter-status',
]

function collectCodesFromObject(obj, out) {
  if (!obj || typeof obj !== 'object') return
  if (Array.isArray(obj)) {
    obj.forEach((x) => collectCodesFromObject(x, out))
    return
  }
  for (const [k, v] of Object.entries(obj)) {
    const key = String(k || '').toLowerCase()
    if (
      (key === 'assigned_agent' || key === 'agent_code' || key === 'agent_id') &&
      typeof v === 'string' &&
      v.trim()
    ) {
      out.add(String(v).trim())
    } else if (v && typeof v === 'object') {
      collectCodesFromObject(v, out)
    }
  }
}

function collectAppAgentMap(apps) {
  /** @type {Map<string, { appId: string, appName: string }>} */
  const map = new Map()
  for (const app of apps || []) {
    const appId = String(app?.id || app?.app_id || '').trim()
    const appName = String(app?.name || app?.title || appId).trim()
    const codes = new Set()
    collectCodesFromObject(app, codes)
    for (const code of codes) {
      if (!map.has(code)) map.set(code, { appId, appName })
    }
  }
  return map
}

function selectHtml(id, options, emptyLabel, extraClass = '') {
  return `
    <select class="role-filter-select${extraClass ? ` ${extraClass}` : ''}" id="${id}" data-filter-id="${id}" aria-label="${escapeAttr(emptyLabel)}">
      <option value="">${escapeHtml(emptyLabel)}</option>
      ${options
        .map((o) => `<option value="${escapeAttr(o.key)}">${escapeHtml(o.label)}</option>`)
        .join('')}
    </select>`
}

function renderActiveFilterChips(page, state) {
  const row = page.querySelector('#roles-active-filters')
  if (!row) return
  // 模板市场用自己的芯片行，我的/已部署用此行
  if (state.view === 'market') {
    row.hidden = true
    row.innerHTML = ''
    renderMarketActiveChips(page, state)
    return
  }
  const marketChips = page.querySelector('#roles-market-active-filters')
  if (marketChips) {
    marketChips.hidden = true
    marketChips.innerHTML = ''
  }

  const chips = []
  const push = (key, label) => chips.push({ key, label })
  if (state.statusFilter) {
    const o = AGENT_STATUS_OPTIONS.find((x) => x.key === state.statusFilter)
    push('status', o?.label || state.statusFilter)
  }
  if (state.purposeFilter) {
    const o = AGENT_PURPOSE_OPTIONS.find((x) => x.key === state.purposeFilter)
    push('purpose', o?.label || state.purposeFilter)
  }
  if (state.sourceFilter) {
    const o = AGENT_SOURCE_OPTIONS.find((x) => x.key === state.sourceFilter)
    push('source', o?.label || state.sourceFilter)
  }
  if (state.deployFilter) {
    const o = AGENT_DEPLOY_OPTIONS.find((x) => x.key === state.deployFilter)
    push('deploy', o?.label || state.deployFilter)
  }
  for (const t of state.tagFilters || []) {
    push(`tag:${t}`, t)
  }

  if (!chips.length) {
    row.hidden = true
    row.innerHTML = ''
    return
  }

  row.hidden = false
  row.innerHTML = `
    <span class="role-active-filters-label">当前筛选：</span>
    ${chips
      .map(
        (c) => `
      <button type="button" class="role-active-chip" data-clear-filter="${escapeAttr(c.key)}">
        ${escapeHtml(c.label)} <span aria-hidden="true">×</span>
      </button>`,
      )
      .join('')}
    <button type="button" class="role-active-clear" data-clear-filter="all">清除全部</button>
  `
}

function renderMarketActiveChips(page, state) {
  const row = page.querySelector('#roles-market-active-filters')
  if (!row) return
  const chips = []
  if (state.purposeFilter) {
    const o = AGENT_PURPOSE_OPTIONS.find((x) => x.key === state.purposeFilter)
    chips.push({ key: 'purpose', label: o?.label || state.purposeFilter })
  }
  for (const t of state.tagFilters || []) {
    chips.push({ key: `tag:${t}`, label: t })
  }
  if (!chips.length) {
    row.hidden = true
    row.innerHTML = ''
    return
  }
  row.hidden = false
  row.innerHTML = `
    <span class="role-active-filters-label">当前筛选：</span>
    ${chips
      .map(
        (c) => `
      <button type="button" class="role-active-chip" data-clear-filter="${escapeAttr(c.key)}">
        ${escapeHtml(c.label)} <span aria-hidden="true">×</span>
      </button>`,
      )
      .join('')}
    <button type="button" class="role-active-clear" data-clear-filter="all">清除全部</button>
  `
}

function renderMoreFiltersPanel(page, state) {
  const tagsEl = page.querySelector('#roles-more-tags')
  if (!tagsEl) return
  const tags = collectTagsFromAgents(state.agents)
  const selected = new Set(state.tagFilters || [])
  tagsEl.innerHTML = tags
    .map((label) => {
      const meta = tagMetaForLabel(label)
      const count = countAgentsWithTag(state.agents, label)
      if (!count && !selected.has(label)) return ''
      const on = selected.has(label)
      return `
        <button type="button" class="agent-tag-chip${on ? ' agent-tag-chip--active' : ''}" data-tag-toggle="${escapeAttr(label)}" style="--tag-color:${meta.color}">
          ${escapeHtml(meta.icon || '🏷️')} ${escapeHtml(label)} (${count})
        </button>`
    })
    .join('')
}

function syncMoreFilterButton(page, state) {
  const btn = page.querySelector('#roles-more-trigger')
  if (!btn) return
  const overflowSlot = page.querySelector('#roles-more-overflow')
  const overflowActive = overflowSlot
    ? [...overflowSlot.querySelectorAll('select')].some((s) => String(s.value || '').trim())
    : false
  const tagN = (state.tagFilters || []).length
  const active = tagN > 0 || overflowActive
  btn.classList.toggle('is-active', active)
  btn.textContent = tagN > 0 ? `更多筛选 (${tagN})` : '更多筛选'
}

function refreshList(page, state, { resetPage = false } = {}) {
  if (resetPage) state.page = 1
  renderActiveFilterChips(page, state)
  syncMoreFilterButton(page, state)
  renderRoleCards(page, state)
  const text = page.querySelector('#roles-count')?.textContent || ''
  const marketCount = page.querySelector('#roles-market-count')
  if (marketCount) marketCount.textContent = text
  requestAnimationFrame(() => layoutMineFilters(page))
}

function updateChromeForView(page, state, view) {
  const isMarket = view === 'market'
  const mineToolbar = page.querySelector('#roles-mine-toolbar')
  const marketBlock = page.querySelector('#roles-market-block')
  const countEl = page.querySelector('#roles-count')

  if (mineToolbar) mineToolbar.hidden = isMarket
  if (marketBlock) marketBlock.hidden = !isMarket
  if (countEl) countEl.hidden = isMarket

  const marketCount = page.querySelector('#roles-market-count')
  if (marketCount) marketCount.hidden = !isMarket

  const expertNew = page.closest('.expert-page')?.querySelector('#expert-primary-action, #expert-new-agent')
  if (expertNew) expertNew.hidden = isMarket

  page.querySelectorAll('.role-subtab').forEach((btn) => {
    btn.classList.toggle('role-subtab--active', btn.dataset.view === view)
  })
}

function setView(page, state, view) {
  state.view = view
  state.page = 1
  updateChromeForView(page, state, view)
  closeAgentDetailDrawer(page)
  // 切到市场时关闭更多筛选弹层
  const morePanel = page.querySelector('#roles-more-panel')
  if (morePanel) morePanel.hidden = true
  refreshList(page, state)
}

function clearFilterKey(state, key) {
  if (key === 'all') {
    state.statusFilter = ''
    state.purposeFilter = ''
    state.sourceFilter = ''
    state.deployFilter = ''
    state.tagFilters = []
    return
  }
  if (key === 'status') state.statusFilter = ''
  else if (key === 'purpose') state.purposeFilter = ''
  else if (key === 'source') state.sourceFilter = ''
  else if (key === 'deploy') state.deployFilter = ''
  else if (String(key).startsWith('tag:')) {
    const label = String(key).slice(4)
    state.tagFilters = (state.tagFilters || []).filter((t) => t !== label)
  }
}

function syncFilterControls(page, state) {
  const setVal = (id, v) => {
    const el = page.querySelector(id)
    if (el) el.value = v || ''
  }
  setVal('#roles-filter-status', state.statusFilter)
  setVal('#roles-filter-purpose', state.purposeFilter)
  setVal('#roles-filter-source', state.sourceFilter)
  setVal('#roles-filter-deploy', state.deployFilter)
  setVal('#roles-filter-sort', state.sortKey || 'recent')
  setVal('#roles-market-category', state.purposeFilter)
  setVal('#roles-market-sort', state.sortKey || 'recent')
  const search = page.querySelector('#roles-search')
  const marketSearch = page.querySelector('#roles-market-search')
  if (search && state.view !== 'market') search.value = state.filter || ''
  if (marketSearch && state.view === 'market') marketSearch.value = state.filter || ''
  syncMoreFilterButton(page, state)
}

/**
 * 单行筛选：空间不足时把状态/用途/来源/部署收进「更多筛选」，避免换行。
 */
function layoutMineFilters(page) {
  const toolbar = page.querySelector('#roles-mine-toolbar')
  const row = page.querySelector('#roles-filters-row')
  const inline = page.querySelector('#roles-filters-inline')
  const overflow = page.querySelector('#roles-more-overflow')
  if (!toolbar || toolbar.hidden || !row || !inline || !overflow) return

  // 先全部放回主行
  for (const id of [...COLLAPSE_FILTER_ORDER].reverse()) {
    const el = page.querySelector(`#${id}`)
    if (el && el.parentElement !== inline) inline.appendChild(el)
  }
  overflow.hidden = overflow.children.length === 0

  // 逐个从右往左收纳，直到不溢出
  const fits = () => row.scrollWidth <= row.clientWidth + 1
  if (fits()) {
    overflow.hidden = overflow.children.length === 0
    return
  }
  for (const id of COLLAPSE_FILTER_ORDER) {
    if (fits()) break
    const el = page.querySelector(`#${id}`)
    if (!el || el.parentElement === overflow) continue
    overflow.appendChild(el)
  }
  overflow.hidden = overflow.children.length === 0
}

async function openSkillHubPackagesInBrowser() {
  try {
    const { open } = await import('@tauri-apps/plugin-shell')
    await open(SKILLHUB_PACKAGE_HOME)
    return
  } catch (e) {
    console.warn('[skillhub] shell open failed', e)
  }
  window.open(SKILLHUB_PACKAGE_HOME, '_blank', 'noopener,noreferrer')
}

function openSkillHubInstallModal(onDone) {
  const overlay = showContentModal({
    title: '从 SkillHub 安装专家',
    width: 560,
    content: `
      <div class="skillhub-install-help">
        <p class="skillhub-install-lead">
          把 SkillHub「专家包」页面的<strong>浏览器地址</strong>粘贴到下方，系统会自动安装其中的技能、创建对应智能体，并提取头像。
        </p>
        <ol class="skillhub-install-steps">
          <li>
            打开 SkillHub 专家包列表
            <button type="button" class="btn btn-secondary btn-sm skillhub-open-site" id="skillhub-open-packages">打开专家包页面</button>
          </li>
          <li>点进你想要的专家（例如「脚本拆解」），进入详情页</li>
          <li>复制浏览器地址栏里的链接（形如 <code>…/skillspackage/包名</code>）</li>
          <li>粘贴到下方输入框，点击「开始安装」</li>
        </ol>
        <div class="skillhub-install-example">
          <div class="skillhub-install-example-label">示例链接</div>
          <code class="skillhub-install-example-url">${escapeHtml(SKILLHUB_EXAMPLE_URL)}</code>
          <button type="button" class="btn btn-secondary btn-sm" id="skillhub-fill-example">填入示例</button>
        </div>
        <div class="form-group" style="margin-top:14px;margin-bottom:0">
          <label class="form-label" for="skillhub-pack-url">粘贴专家包链接</label>
          <input
            class="form-input"
            id="skillhub-pack-url"
            type="text"
            placeholder="${escapeAttr(SKILLHUB_EXAMPLE_URL)}"
            autocomplete="off"
            spellcheck="false"
          >
          <div class="form-hint">只支持专家包页（地址里带 <code>skillspackage</code>）。单个技能页请到「技能」页安装。</div>
        </div>
      </div>
    `,
    buttons: [{ label: '开始安装', className: 'btn btn-primary btn-sm', id: 'skillhub-install-confirm' }],
  })

  const input = overlay.querySelector('#skillhub-pack-url')
  overlay.querySelector('#skillhub-open-packages')?.addEventListener('click', (e) => {
    e.preventDefault()
    void openSkillHubPackagesInBrowser()
  })
  overlay.querySelector('#skillhub-fill-example')?.addEventListener('click', (e) => {
    e.preventDefault()
    if (input) {
      input.value = SKILLHUB_EXAMPLE_URL
      input.focus()
      input.select()
    }
  })

  const startInstall = () => {
    const url = String(input?.value || '').trim()
    if (!url) {
      toast('请先粘贴专家包链接', 'error')
      input?.focus()
      return
    }
    if (!/skillspackage/i.test(url) && !/^[a-z0-9-]+$/i.test(url)) {
      toast('请粘贴专家包页面链接（地址中应包含 skillspackage）', 'error')
      input?.focus()
      return
    }
    overlay.close?.()
    toast('正在从 SkillHub 安装专家包…', 'info')
    void api
      .installAgentFromSkillHub({ url })
      .then((result) => {
        const name = result?.agent_name || result?.agent_code || '专家'
        const n = Array.isArray(result?.skills) ? result.skills.length : 0
        toast(`已安装「${name}」（${n} 个技能）`, 'success')
        onDone?.(result)
      })
      .catch((e) => {
        toast('安装失败: ' + (e?.message || e), 'error')
      })
  }

  overlay.querySelector('#skillhub-install-confirm')?.addEventListener('click', startInstall)
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      startInstall()
    }
  })
}

export async function render() {
  const page = document.createElement('div')
  page.className = 'page role-page role-page--agents-flat'

  page.innerHTML = `
    <div class="role-subtabs" role="tablist" aria-label="智能体视图">
      ${VIEW_TABS.map(
        (t) => `
        <button type="button" class="role-subtab${t.id === 'mine' ? ' role-subtab--active' : ''}" data-view="${t.id}" role="tab">
          ${escapeHtml(t.label)}
        </button>`,
      ).join('')}
    </div>

    <div class="role-toolbar role-toolbar--agents" id="roles-mine-toolbar">
      <div class="role-filters-row" id="roles-filters-row">
        <div class="role-search-wrap">
          <svg class="role-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input class="role-search-input" id="roles-search" placeholder="搜索智能体" autocomplete="off">
        </div>
        <div class="role-filters-inline" id="roles-filters-inline">
          ${selectHtml('roles-filter-status', AGENT_STATUS_OPTIONS, '状态：全部')}
          ${selectHtml('roles-filter-purpose', AGENT_PURPOSE_OPTIONS, '用途：全部')}
          ${selectHtml('roles-filter-source', AGENT_SOURCE_OPTIONS, '来源：全部')}
          ${selectHtml('roles-filter-deploy', AGENT_DEPLOY_OPTIONS, '部署：全部')}
        </div>
        <div class="role-more-filters-wrap">
          <button type="button" class="role-filter-btn" id="roles-more-trigger" aria-haspopup="true" aria-expanded="false">更多筛选</button>
          <div class="role-more-panel" id="roles-more-panel" hidden>
            <div class="role-more-panel-section" id="roles-more-overflow" hidden></div>
            <div class="role-more-panel-head">标签</div>
            <div class="role-more-panel-tags" id="roles-more-tags"></div>
          </div>
        </div>
        <select class="role-filter-select" id="roles-filter-sort" aria-label="排序">
          ${AGENT_SORT_OPTIONS.map(
            (o) =>
              `<option value="${escapeAttr(o.key)}"${o.key === 'recent' ? ' selected' : ''}>${escapeHtml(o.label)}</option>`,
          ).join('')}
        </select>
      </div>
      <div class="role-toolbar-actions">
        <span class="role-total" id="roles-count"></span>
      </div>
    </div>

    <div class="role-active-filters" id="roles-active-filters" hidden></div>

    <div class="role-market-block" id="roles-market-block" hidden>
      <div class="role-market-banner" id="roles-market-banner">
        <div>
          <strong>模板市场</strong>
          <p>浏览系统模板，或从 SkillHub 安装专家包到「我的智能体」。</p>
        </div>
        <button type="button" class="btn btn-primary btn-sm" id="btn-market-install">从 SkillHub 安装</button>
      </div>
      <div class="role-toolbar role-toolbar--agents role-toolbar--market">
        <div class="role-filters-row role-filters-row--market">
          <div class="role-search-wrap">
            <svg class="role-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
            <input class="role-search-input" id="roles-market-search" placeholder="搜索模板" autocomplete="off">
          </div>
          ${selectHtml('roles-market-category', AGENT_PURPOSE_OPTIONS, '分类：全部')}
          <select class="role-filter-select" id="roles-market-sort" aria-label="排序">
            ${AGENT_SORT_OPTIONS.map(
              (o) =>
                `<option value="${escapeAttr(o.key)}"${o.key === 'recent' ? ' selected' : ''}>${escapeHtml(o.label)}</option>`,
            ).join('')}
          </select>
        </div>
        <div class="role-toolbar-actions">
          <span class="role-total" id="roles-market-count"></span>
        </div>
      </div>
      <div class="role-active-filters" id="roles-market-active-filters" hidden></div>
    </div>

    <div class="role-grid" id="roles-list"></div>
    <div class="role-list-pager-wrap" id="roles-list-pager"></div>

    <div class="ef-side-drawer-root role-drawer-root" id="roleDrawer" hidden>
      <div class="ef-side-drawer-mask role-drawer-mask" data-action="close-drawer"></div>
      <aside class="ef-side-drawer role-drawer" role="dialog" aria-label="智能体详情">
        <header class="ef-side-drawer__head role-drawer__head">
          <div class="ef-side-drawer__brand">
            <span class="ef-side-drawer__mark" aria-hidden="true">员</span>
            <div class="ef-side-drawer__heading">
              <h2 class="ef-side-drawer__title role-drawer__title" id="roleDrawerTitle">智能体详情</h2>
              <div class="ef-side-drawer__meta role-drawer__subtitle" id="roleDrawerSubtitle"></div>
            </div>
          </div>
          <button type="button" class="ef-side-drawer__close role-drawer__close" data-action="close-drawer" aria-label="关闭">×</button>
        </header>
        <div class="ef-side-drawer__body role-drawer__body" id="roleDrawerBody"></div>
        <footer class="ef-side-drawer__foot role-drawer__foot" id="roleDrawerFoot"></footer>
      </aside>
    </div>
  `

  const state = {
    agents: [],
    /** @type {Set<string>} */
    hiredCodes: new Set(),
    /** @type {Map<string, object>} */
    hiredRolesByCode: new Map(),
    /** @type {Map<string, { appId: string, appName: string }>} */
    appAgentCodes: new Map(),
    /** @type {Set<string>} */
    automationAgentCodes: new Set(),
    view: 'mine',
    filter: '',
    statusFilter: '',
    purposeFilter: '',
    sourceFilter: '',
    deployFilter: '',
    tagFilters: [],
    sortKey: 'recent',
    selectedId: null,
    toolsMeta: null,
    onRefresh: null,
    page: 1,
    pageSize: readStoredPageSize(AGENTS_PAGE_SIZE_KEY),
  }

  // 卡片计数写到当前可见的 count 节点
  async function reload() {
    const listEl = page.querySelector('#roles-list')
    renderRoleSkeleton(listEl)
    try {
      const [agents, rolesRes, apps, automations] = await Promise.all([
        api.listAgents(),
        api.proactiveListRoles().catch(() => ({ roles: [] })),
        api.listApps().catch(() => []),
        api.automationList().catch(() => ({ automations: [] })),
      ])
      state.agents = sortAgents(Array.isArray(agents) ? agents : [])
      const roles = rolesRes?.roles || []
      state.hiredCodes = new Set(
        roles
          .filter((r) => String(r.status || '') !== 'archived')
          .map((r) => String(r.agent_code || '').trim())
          .filter(Boolean),
      )
      state.hiredRolesByCode = new Map(
        roles
          .filter((r) => String(r.agent_code || '').trim())
          .map((r) => [String(r.agent_code).trim(), r]),
      )
      state.appAgentCodes = collectAppAgentMap(Array.isArray(apps) ? apps : [])
      const autoList = automations?.automations || automations?.tasks || (Array.isArray(automations) ? automations : [])
      const autoCodes = new Set()
      for (const t of autoList) {
        const code = String(t?.agent_code || '').trim()
        if (code) autoCodes.add(code)
      }
      state.automationAgentCodes = autoCodes
      window._roleState = state
      refreshList(page, state)
    } catch (e) {
      if (listEl) listEl.innerHTML = `<div class="role-empty"><span>加载失败: ${escapeHtml(String(e))}</span></div>`
      toast('加载智能体失败: ' + e, 'error')
    }
  }

  state.onRefresh = reload
  state.onFiltersChange = () => {
    syncFilterControls(page, state)
    refreshList(page, state, { resetPage: true })
  }

  page.querySelector('.role-subtabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.role-subtab')
    if (!btn) return
    setView(page, state, btn.dataset.view || 'mine')
  })

  const onSearch = (e) => {
    state.filter = String(e.target.value || '').trim().toLowerCase()
    refreshList(page, state, { resetPage: true })
  }
  page.querySelector('#roles-search')?.addEventListener('input', onSearch)
  page.querySelector('#roles-market-search')?.addEventListener('input', onSearch)

  const bindSelect = (id, key) => {
    page.querySelector(id)?.addEventListener('change', (e) => {
      state[key] = String(e.target.value || '').trim()
      syncFilterControls(page, state)
      refreshList(page, state, { resetPage: true })
    })
  }
  bindSelect('#roles-filter-status', 'statusFilter')
  bindSelect('#roles-filter-purpose', 'purposeFilter')
  bindSelect('#roles-filter-source', 'sourceFilter')
  bindSelect('#roles-filter-deploy', 'deployFilter')
  bindSelect('#roles-market-category', 'purposeFilter')

  const onSort = (e) => {
    state.sortKey = String(e.target.value || 'recent').trim() || 'recent'
    syncFilterControls(page, state)
    refreshList(page, state, { resetPage: true })
  }
  page.querySelector('#roles-filter-sort')?.addEventListener('change', onSort)
  page.querySelector('#roles-market-sort')?.addEventListener('change', onSort)

  page.querySelector('#roles-more-trigger')?.addEventListener('click', (e) => {
    e.stopPropagation()
    const panel = page.querySelector('#roles-more-panel')
    const trigger = page.querySelector('#roles-more-trigger')
    if (!panel) return
    const open = panel.hidden
    if (open) {
      renderMoreFiltersPanel(page, state)
      layoutMineFilters(page)
      panel.hidden = false
      trigger?.setAttribute('aria-expanded', 'true')
    } else {
      panel.hidden = true
      trigger?.setAttribute('aria-expanded', 'false')
    }
  })

  page.querySelector('#roles-more-panel')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tag-toggle]')
    if (!btn) return
    e.stopPropagation()
    const label = btn.dataset.tagToggle || ''
    const set = new Set(state.tagFilters || [])
    if (set.has(label)) set.delete(label)
    else set.add(label)
    state.tagFilters = [...set]
    renderMoreFiltersPanel(page, state)
    syncFilterControls(page, state)
    refreshList(page, state, { resetPage: true })
  })

  // 溢出进更多筛选的 select 在初始化时已绑定 change，节点移动后仍有效

  document.addEventListener(
    'click',
    (e) => {
      if (!page.isConnected) return
      const wrap = page.querySelector('.role-more-filters-wrap')
      const panel = page.querySelector('#roles-more-panel')
      if (!wrap || !panel || panel.hidden) return
      if (!wrap.contains(e.target)) {
        panel.hidden = true
        page.querySelector('#roles-more-trigger')?.setAttribute('aria-expanded', 'false')
      }
    },
    true,
  )

  const onClearFilters = (e) => {
    const btn = e.target.closest('[data-clear-filter]')
    if (!btn) return
    clearFilterKey(state, btn.dataset.clearFilter || '')
    syncFilterControls(page, state)
    refreshList(page, state, { resetPage: true })
  }
  page.querySelector('#roles-active-filters')?.addEventListener('click', onClearFilters)
  page.querySelector('#roles-market-active-filters')?.addEventListener('click', onClearFilters)

  page.querySelector('#btn-market-install')?.addEventListener('click', () => {
    openSkillHubInstallModal(() => reload())
  })

  page._goSkillHubMarket = () => setView(page, state, 'market')
  page._showCreateAgent = () => {
    void showCreateRoleDialog(page, state)
  }
  page._syncExpertNewAgent = () => {
    const expertNew = page.closest('.expert-page')?.querySelector('#expert-primary-action, #expert-new-agent')
    if (expertNew) expertNew.hidden = state.view === 'market'
  }
  page._syncExpertPrimaryAction = page._syncExpertNewAgent
  page._bindExpertHeader = () => {
    const expertNew = page.closest('.expert-page')?.querySelector('#expert-primary-action, #expert-new-agent')
    if (!expertNew) return
    expertNew.onclick = () => {
      void showCreateRoleDialog(page, state)
    }
    expertNew.hidden = state.view === 'market'
  }

  const ro = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => layoutMineFilters(page))
    : null
  const mineToolbar = page.querySelector('#roles-mine-toolbar')
  if (ro && mineToolbar) ro.observe(mineToolbar)

  attachRoleEvents(page, state)
  await preloadRoleToolsMeta(state)
  updateChromeForView(page, state, state.view)
  syncFilterControls(page, state)
  await reload()
  try {
    if (sessionStorage.getItem('evopanel_pending_agent_create') === '1') {
      sessionStorage.removeItem('evopanel_pending_agent_create')
      void showCreateRoleDialog(page, state)
    }
  } catch {
    /* ignore */
  }
  return page
}
