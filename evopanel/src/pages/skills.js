/**
 * 技能页 — 已安装 / 市场
 */
import { api } from '../lib/tauri-api.js'
import { getSkillIcon, getSkillTags, getSkillTagMeta, SKILL_TAGS } from '../lib/skill-catalog.js'
import { toast } from '../components/toast.js'
import { showConfirm } from '../components/modal.js'
import { icon } from '../lib/icons.js'
import {
  buildSkillAppUsageMap,
  buildSkillUsageMap,
  closeDrawer,
  esc,
  openDrawer,
  renderModuleSubtabs,
  selectHtml,
  setBtnState,
} from './expert-center-shared.js'

let _loadSeq = 0
let _installedSlugs = new Set()
let _storeCursor = null
let _storeHasMore = false
let _isLoadingMore = false
let _storeObserver = null

const STATUS_OPTS = [
  { key: 'enabled', label: '全局启用' },
  { key: 'disabled', label: '全局停用' },
]
const SOURCE_OPTS = [
  { key: 'public', label: '系统' },
  { key: 'custom', label: '自定义' },
  { key: 'skillhub', label: 'SkillHub' },
]
const SORT_OPTS = [
  { key: 'name', label: '名称' },
  { key: 'usage', label: '使用量' },
  { key: 'status', label: '状态' },
]

function skillSourceOf(skill) {
  const cat = String(skill.category || '').toLowerCase()
  const name = String(skill.name || '').toLowerCase()
  if (cat === 'public') return 'public'
  if (/skillhub/i.test(skill.license || '') || name.includes('skillhub')) return 'skillhub'
  return cat === 'custom' ? 'custom' : 'custom'
}

function skillSourceLabel(src) {
  return SOURCE_OPTS.find((o) => o.key === src)?.label || '自定义'
}

function importLocalSkill(page) {
  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.accept = '.zip'
  fileInput.style.display = 'none'
  document.body.appendChild(fileInput)
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0]
    fileInput.remove()
    if (!file) return
    try {
      toast('正在导入…', 'info')
      const result = await api.uploadSkillFile(file)
      toast(`技能「${result.skill_name}」导入成功`, 'success')
      loadSkills(page, { force: true })
    } catch (e) {
      toast('导入失败: ' + (e?.message || e), 'error')
    }
  })
  fileInput.click()
}

export async function render() {
  const page = document.createElement('div')
  page.className = 'page ec-module-page ec-skills-page'
  page._skillState = {
    view: 'installed',
    skills: [],
    agentUsage: new Map(),
    appUsage: new Map(),
    filter: '',
    status: '',
    category: '',
    source: '',
    sort: 'name',
    tagFilters: [],
  }

  const categoryOpts = SKILL_TAGS.map((t) => ({ key: t.key || t.label, label: t.label }))

  page.innerHTML = `
    ${renderModuleSubtabs(
      [
        { id: 'installed', label: '已安装' },
        { id: 'market', label: '市场' },
      ],
      'installed',
    )}

    <div id="skills-tab-installed" class="ec-tab-panel">
      <div class="role-toolbar role-toolbar--agents ec-toolbar">
        <div class="role-filters-row">
          <div class="role-search-wrap">
            <svg class="role-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
            <input class="role-search-input" id="skill-filter-input" placeholder="搜索技能" autocomplete="off">
          </div>
          ${selectHtml('skill-filter-status', STATUS_OPTS, '状态：全部')}
          ${selectHtml('skill-filter-category', categoryOpts, '分类：全部')}
          ${selectHtml('skill-filter-source', SOURCE_OPTS, '来源：全部')}
          <div class="role-more-filters-wrap">
            <button type="button" class="role-filter-btn" id="skill-more-trigger">更多筛选</button>
            <div class="role-more-panel" id="skill-more-panel" hidden>
              <div class="role-more-panel-head">标签</div>
              <div class="role-more-panel-tags" id="skill-more-tags"></div>
            </div>
          </div>
          <select class="role-filter-select" id="skill-filter-sort" aria-label="排序">
            ${SORT_OPTS.map((o) => `<option value="${esc(o.key)}">${esc(o.label)}</option>`).join('')}
          </select>
        </div>
        <div class="role-toolbar-actions">
          <span class="role-total" id="skills-count"></span>
        </div>
      </div>
      <div class="role-active-filters" id="skill-active-filters" hidden></div>
      <div id="skills-installed-body"><div class="ec-loading">正在加载技能…</div></div>
    </div>

    <div id="skills-tab-market" class="ec-tab-panel" hidden>
      <div class="role-toolbar role-toolbar--agents ec-toolbar">
        <div class="role-filters-row">
          <div class="role-search-wrap">
            <svg class="role-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
            <input class="role-search-input" id="skill-install-search" placeholder="搜索技能市场" autocomplete="off">
          </div>
          <button type="button" class="btn btn-secondary btn-sm" id="btn-open-skillhub">打开 SkillHub</button>
        </div>
        <div class="role-toolbar-actions">
          <span class="role-total" id="skills-market-hint">应用内技能市场</span>
        </div>
      </div>
      <p class="ec-muted" style="margin:8px 0 0;font-size:12px;color:var(--text-tertiary,#888);line-height:1.5">第三方技能由 SkillHub 等来源提供，许可证与作者以技能声明为准；安装即表示你接受其条款。EvoFlow 不背书第三方内容。</p>
      <div id="install-source-results" class="ec-market-scroll">
        <div class="ec-loading">正在加载技能市场…</div>
      </div>
    </div>
  `

  bindPageEvents(page)
  page._bindExpertHeader = () => {
    const btn = page.closest('.expert-page')?.querySelector('#expert-primary-action')
    if (!btn) return
    btn.onclick = () => importLocalSkill(page)
    btn.hidden = false
  }
  page._syncExpertPrimaryAction = () => {
    const btn = page.closest('.expert-page')?.querySelector('#expert-primary-action')
    if (!btn) return
    btn.hidden = false
    btn.onclick = () => importLocalSkill(page)
  }

  void loadSkills(page)
  return page
}

export function cleanup() {
  if (_storeObserver) {
    _storeObserver.disconnect()
    _storeObserver = null
  }
}

function bindPageEvents(page) {
  page.querySelector('.ec-subtabs')?.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-main-tab]')
    if (!tab) return
    const id = tab.dataset.mainTab
    page._skillState.view = id
    page.querySelectorAll('.ec-subtabs .role-subtab').forEach((t) => {
      t.classList.toggle('role-subtab--active', t.dataset.mainTab === id)
    })
    page.querySelector('#skills-tab-installed').hidden = id !== 'installed'
    page.querySelector('#skills-tab-market').hidden = id !== 'market'
    if (id === 'market' && !page._storeLoaded) {
      page._storeLoaded = true
      void doSearchInstall(page)
    }
  })

  const st = page._skillState
  const refresh = () => renderInstalledList(page)

  page.querySelector('#skill-filter-input')?.addEventListener('input', (e) => {
    st.filter = String(e.target.value || '').trim().toLowerCase()
    refresh()
  })
  page.querySelector('#skill-filter-status')?.addEventListener('change', (e) => {
    st.status = e.target.value
    refresh()
  })
  page.querySelector('#skill-filter-category')?.addEventListener('change', (e) => {
    st.category = e.target.value
    refresh()
  })
  page.querySelector('#skill-filter-source')?.addEventListener('change', (e) => {
    st.source = e.target.value
    refresh()
  })
  page.querySelector('#skill-filter-sort')?.addEventListener('change', (e) => {
    st.sort = e.target.value || 'name'
    refresh()
  })

  page.querySelector('#skill-more-trigger')?.addEventListener('click', (e) => {
    e.stopPropagation()
    const panel = page.querySelector('#skill-more-panel')
    if (!panel) return
    if (panel.hidden) {
      renderTagPanel(page)
      panel.hidden = false
    } else panel.hidden = true
  })
  page.querySelector('#skill-more-panel')?.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-tag-toggle]')
    if (!chip) return
    const tag = chip.dataset.tagToggle
    const set = new Set(st.tagFilters)
    if (set.has(tag)) set.delete(tag)
    else set.add(tag)
    st.tagFilters = [...set]
    renderTagPanel(page)
    refresh()
  })
  document.addEventListener(
    'click',
    (e) => {
      if (!page.isConnected) return
      const wrap = page.querySelector('.role-more-filters-wrap')
      const panel = page.querySelector('#skill-more-panel')
      if (wrap && panel && !panel.hidden && !wrap.contains(e.target)) panel.hidden = true
    },
    true,
  )

  page.querySelector('#skill-active-filters')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-clear-filter]')
    if (!btn) return
    const key = btn.dataset.clearFilter
    if (key === 'all') {
      st.status = ''
      st.category = ''
      st.source = ''
      st.tagFilters = []
      page.querySelector('#skill-filter-status').value = ''
      page.querySelector('#skill-filter-category').value = ''
      page.querySelector('#skill-filter-source').value = ''
    } else if (key?.startsWith('tag:')) {
      st.tagFilters = st.tagFilters.filter((t) => t !== key.slice(4))
    } else if (key === 'status') {
      st.status = ''
      page.querySelector('#skill-filter-status').value = ''
    } else if (key === 'category') {
      st.category = ''
      page.querySelector('#skill-filter-category').value = ''
    } else if (key === 'source') {
      st.source = ''
      page.querySelector('#skill-filter-source').value = ''
    }
    refresh()
  })

  let debounce = null
  const marketSearch = page.querySelector('#skill-install-search')
  marketSearch?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void doSearchInstall(page)
  })
  marketSearch?.addEventListener('input', () => {
    clearTimeout(debounce)
    debounce = setTimeout(() => void doSearchInstall(page), 400)
  })
  page.querySelector('#btn-open-skillhub')?.addEventListener('click', () => void openSkillHubInBrowser())
}

function renderTagPanel(page) {
  const el = page.querySelector('#skill-more-tags')
  if (!el) return
  const selected = new Set(page._skillState.tagFilters)
  const tags = [...new Set((page._skillState.skills || []).flatMap((s) => getSkillTags(s.name)))]
  el.innerHTML = tags
    .map((t) => {
      const m = getSkillTagMeta(t)
      const on = selected.has(t)
      return `<button type="button" class="agent-tag-chip${on ? ' agent-tag-chip--active' : ''}" data-tag-toggle="${esc(t)}" style="--tag-color:${m?.color || '#64748b'}">${esc(m?.icon || '')} ${esc(m?.label || t)}</button>`
    })
    .join('')
}

async function loadSkills(page, { force = false } = {}) {
  const body = page.querySelector('#skills-installed-body')
  if (!body) return
  const seq = ++_loadSeq
  body.innerHTML = `<div class="ec-loading">正在加载技能…</div>`
  try {
    const [data, agents, apps] = await Promise.all([
      api.loadSkills(force ? { force: true } : undefined),
      api.listAgents().catch(() => []),
      api.listApps().catch(() => []),
    ])
    if (seq !== _loadSeq) return
    const skills = Array.isArray(data) ? data : data?.skills || []
    page._skillState.skills = skills
    page._skillState.agentUsage = buildSkillUsageMap(agents)
    page._skillState.appUsage = buildSkillAppUsageMap(apps)
    _installedSlugs = new Set(skills.map((s) => String(s.name || s.slug || '').toLowerCase()).filter(Boolean))
    renderInstalledList(page)
  } catch (e) {
    if (seq !== _loadSeq) return
    body.innerHTML = `<div class="ec-error">加载失败: ${esc(e?.message || e)} <button type="button" class="btn btn-secondary btn-sm" id="btn-skill-retry">重试</button></div>`
    body.querySelector('#btn-skill-retry').onclick = () => loadSkills(page, { force: true })
  }
}

function filterSkills(state) {
  let list = [...(state.skills || [])]
  const q = state.filter
  list = list.filter((s) => {
    const enabled = s.enabled !== false
    if (state.status === 'enabled' && !enabled) return false
    if (state.status === 'disabled' && enabled) return false
    const src = skillSourceOf(s)
    if (state.source && src !== state.source) return false
    const tags = getSkillTags(s.name)
    if (state.category) {
      const meta = SKILL_TAGS.find((t) => t.key === state.category || t.label === state.category)
      const want = meta?.label || state.category
      if (!tags.includes(want) && !tags.some((t) => t.includes(want))) return false
    }
    if (state.tagFilters?.length && !state.tagFilters.every((t) => tags.includes(t))) return false
    if (!q) return true
    const text = `${s.name} ${s.description || s.desc || ''}`.toLowerCase()
    return text.includes(q)
  })
  list.sort((a, b) => {
    if (state.sort === 'usage') {
      const ua = (state.agentUsage.get(String(a.name || '').toLowerCase()) || []).length
      const ub = (state.agentUsage.get(String(b.name || '').toLowerCase()) || []).length
      return ub - ua
    }
    if (state.sort === 'status') {
      return Number(b.enabled !== false) - Number(a.enabled !== false)
    }
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh')
  })
  return list
}

function renderActiveChips(page) {
  const row = page.querySelector('#skill-active-filters')
  const st = page._skillState
  const chips = []
  if (st.status) chips.push({ key: 'status', label: STATUS_OPTS.find((o) => o.key === st.status)?.label || st.status })
  if (st.category) {
    const m = SKILL_TAGS.find((t) => t.key === st.category || t.label === st.category)
    chips.push({ key: 'category', label: m?.label || st.category })
  }
  if (st.source) chips.push({ key: 'source', label: skillSourceLabel(st.source) })
  for (const t of st.tagFilters || []) chips.push({ key: `tag:${t}`, label: t })
  if (!chips.length) {
    row.hidden = true
    row.innerHTML = ''
    return
  }
  row.hidden = false
  row.innerHTML = `
    <span class="role-active-filters-label">当前筛选：</span>
    ${chips.map((c) => `<button type="button" class="role-active-chip" data-clear-filter="${esc(c.key)}">${esc(c.label)} ×</button>`).join('')}
    <button type="button" class="role-active-clear" data-clear-filter="all">清除全部</button>`
}

function renderInstalledList(page) {
  const body = page.querySelector('#skills-installed-body')
  const countEl = page.querySelector('#skills-count')
  const st = page._skillState
  const list = filterSkills(st)
  renderActiveChips(page)
  if (countEl) countEl.textContent = `共 ${list.length} 个技能`
  if (!list.length) {
    body.innerHTML = `<div class="ec-empty">没有匹配的技能</div>`
    return
  }
  body.innerHTML = `<div class="skills-list-grid">${list.map((s) => renderSkillCard(s, st)).join('')}</div>`
  bindInstalledCardEvents(page, body)
}

function renderSkillCard(skill, state) {
  const rawName = String(skill.name || '').trim()
  const name = esc(rawName)
  const desc = esc((skill.description || skill.desc || '').trim())
  const enabled = skill.enabled !== false
  const src = skillSourceOf(skill)
  const version = esc(skill.version || '—')
  const agents = state.agentUsage.get(rawName.toLowerCase()) || []
  const apps = state.appUsage.get(rawName.toLowerCase()) || []
  const perms = esc(skill.license || '跟随技能声明')
  const canDelete = String(skill.category || '').toLowerCase() !== 'public'
  const tags = getSkillTags(rawName)
  const tagsHtml = tags
    .slice(0, 3)
    .map((t) => {
      const m = getSkillTagMeta(t)
      return `<span class="skill-card-tag" style="--tag-color:${m?.color || ''}">${esc(m?.label || t)}</span>`
    })
    .join('')

  return `
    <article class="skill-card ec-skill-card" data-name="${name}" data-status="${enabled ? 'enabled' : 'disabled'}" tabindex="0">
      <div class="skill-card-main">
        <div class="skill-card-head">
          <span class="skill-card-icon">${getSkillIcon(rawName)}</span>
          <strong class="skill-card-name">${name}</strong>
        </div>
        <p class="skill-card-desc">${desc || '<em class="skill-card-desc-empty">暂无描述</em>'}</p>
        <div class="ec-card-meta">
          <span>版本 ${version}</span>
          <span>${esc(skillSourceLabel(src))}</span>
          <span>${agents.length} 个智能体</span>
          <span>${apps.length} 个工作流</span>
        </div>
        <div class="ec-card-meta ec-card-meta--muted">许可证：${perms}</div>
        ${tagsHtml ? `<div class="skill-card-tags">${tagsHtml}</div>` : ''}
      </div>
      <div class="skill-card-actions ec-card-actions">
        <label class="skill-toggle-wrap card-toggle" title="${enabled ? '全局启用' : '全局停用'}" data-stop="1">
          <span class="ec-toggle-label">${enabled ? '全局启用' : '全局停用'}</span>
          <span class="skill-toggle-switch">
            <input type="checkbox" class="skill-toggle" ${enabled ? 'checked' : ''} data-name="${name}">
            <span class="skill-toggle-slider"></span>
          </span>
        </label>
        ${canDelete ? `<button type="button" class="skill-delete-btn" data-skill-name="${name}" data-stop="1" title="删除">${icon('trash', 12)}</button>` : ''}
      </div>
    </article>`
}

function bindInstalledCardEvents(page, body) {
  body.querySelectorAll('.skill-card').forEach((card) => {
    const name = card.dataset.name
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-stop]')) return
      openSkillDetailDrawer(page, name)
    })
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        openSkillDetailDrawer(page, name)
      }
    })

    const toggle = card.querySelector('.skill-toggle')
    if (toggle) {
      toggle.addEventListener('click', (e) => e.stopPropagation())
      toggle.onchange = async () => {
        const enable = toggle.checked
        const agents = page._skillState.agentUsage.get(name.toLowerCase()) || []
        const apps = page._skillState.appUsage.get(name.toLowerCase()) || []
        if (!enable && (agents.length || apps.length)) {
          const tip = [
            agents.length ? `智能体：${agents.slice(0, 5).join('、')}${agents.length > 5 ? '…' : ''}` : '',
            apps.length ? `工作流：${apps.slice(0, 5).join('、')}${apps.length > 5 ? '…' : ''}` : '',
          ]
            .filter(Boolean)
            .join('\n')
          const yes = await showConfirm(
            `停用技能「${name}」将影响以下引用：\n\n${tip}\n\n确定全局停用？`,
          )
          if (!yes) {
            toggle.checked = true
            return
          }
        }
        try {
          await api.enableSkill(name, enable)
          toast(`技能「${name}」已${enable ? '全局启用' : '全局停用'}`, 'success')
          const skill = page._skillState.skills.find((s) => s.name === name)
          if (skill) skill.enabled = enable
          renderInstalledList(page)
        } catch (e) {
          toggle.checked = !enable
          toast('操作失败: ' + (e?.message || e), 'error')
        }
      }
    }

    const delBtn = card.querySelector('.skill-delete-btn')
    if (delBtn) {
      delBtn.onclick = async (e) => {
        e.stopPropagation()
        const yes = await showConfirm(`确定删除技能「${name}」？\n此操作不可恢复。`)
        if (!yes) return
        try {
          setBtnState(delBtn, 'loading', { loading: '…' })
          await api.skillsUninstall(name)
          toast(`技能「${name}」已删除`, 'success')
          page._skillState.skills = page._skillState.skills.filter((s) => s.name !== name)
          renderInstalledList(page)
        } catch (err) {
          toast('删除失败: ' + (err?.message || err), 'error')
          setBtnState(delBtn, 'idle', { idle: '' })
          delBtn.innerHTML = icon('trash', 12)
        }
      }
    }
  })
}

function openSkillDetailDrawer(page, name) {
  const skill = page._skillState.skills.find((s) => s.name === name)
  if (!skill) return
  const agents = page._skillState.agentUsage.get(name.toLowerCase()) || []
  const apps = page._skillState.appUsage.get(name.toLowerCase()) || []
  const src = skillSourceOf(skill)
  const enabled = skill.enabled !== false
  openDrawer(page, {
    title: skill.name,
    subtitle: `${esc(skillSourceLabel(src))} · ${enabled ? '全局启用' : '全局停用'}`,
    body: `
      <section class="role-drawer-section"><h4>描述</h4><p>${esc(skill.description || skill.desc || '暂无描述')}</p></section>
      <section class="role-drawer-section"><h4>版本</h4><p>${esc(skill.version || '—')}</p></section>
      <section class="role-drawer-section"><h4>许可证</h4><p>${esc(skill.license || '跟随技能声明')}</p></section>
      <section class="role-drawer-section"><h4>权限</h4><p>${esc(skill.permissions || '跟随技能声明 / 运行时权限')}</p></section>
      <section class="role-drawer-section"><h4>依赖</h4><p class="role-drawer-muted">依赖信息由技能包声明；当前接口未返回详细依赖列表。</p></section>
      <section class="role-drawer-section"><h4>使用位置</h4>
        <p>智能体（${agents.length}）：${agents.length ? esc(agents.join('、')) : '未被智能体引用'}</p>
        <p style="margin-top:8px">工作流（${apps.length}）：${apps.length ? esc(apps.join('、')) : '未被工作流引用'}</p>
      </section>
      <section class="role-drawer-section"><h4>更新记录</h4><p class="role-drawer-muted">暂无版本历史</p></section>
      <section class="role-drawer-section"><h4>安装路径</h4><p class="role-drawer-muted">${esc(skill.path || skill.location || (src === 'public' ? '系统技能目录' : '自定义技能目录'))}</p></section>
    `,
    foot: `
      <button type="button" class="btn btn-secondary" data-act="toggle">${enabled ? '全局停用' : '全局启用'}</button>
      <button type="button" class="btn btn-primary" data-act="close">关闭</button>
    `,
  })
  const root = page.querySelector('#ecDrawer')
  root.querySelector('[data-act="close"]')?.addEventListener('click', () => closeDrawer(page))
  root.querySelector('[data-act="toggle"]')?.addEventListener('click', async () => {
    const next = !enabled
    try {
      await api.enableSkill(name, next)
      toast(`已${next ? '启用' : '停用'}`, 'success')
      skill.enabled = next
      closeDrawer(page)
      renderInstalledList(page)
    } catch (e) {
      toast('操作失败: ' + (e?.message || e), 'error')
    }
  })
}

const SKILLHUB_WEB_URL = 'https://www.skillhub.cn/skills?sortBy=score'

async function openSkillHubInBrowser() {
  try {
    if (window.__TAURI_INTERNALS__) {
      const { open } = await import('@tauri-apps/plugin-shell')
      await open(SKILLHUB_WEB_URL)
      return
    }
  } catch (e) {
    console.warn('[skillhub] shell open failed', e)
  }
  const w = window.open(SKILLHUB_WEB_URL, '_blank', 'noopener,noreferrer')
  if (!w) toast('浏览器拦截了弹窗，请允许后重试', 'error')
}

async function doSearchInstall(page, append = false) {
  const query = (page.querySelector('#skill-install-search')?.value || '').trim()
  const resultsEl = page.querySelector('#install-source-results')
  if (!resultsEl) return

  if (!append) {
    _storeCursor = null
    _storeHasMore = false
    if (_storeObserver) {
      _storeObserver.disconnect()
      _storeObserver = null
    }
    resultsEl.innerHTML = `<div class="ec-loading">正在加载技能市场…</div>`
  }

  try {
    const result = await api.skillsSkillHubSearch(query, _storeCursor)
    const items = Array.isArray(result) ? result : result?.skills || []
    _storeHasMore = !!result?.hasMore
    _storeCursor = result?.cursor || null

    try {
      const localData = await api.loadSkills()
      const localSkills = Array.isArray(localData) ? localData : localData?.skills || []
      _installedSlugs = new Set(localSkills.map((s) => String(s.name || s.slug || '').toLowerCase()))
    } catch {
      /* keep cache */
    }

    if (!items.length && !append) {
      resultsEl.innerHTML = `<div class="ec-empty">${query ? `未找到「${esc(query)}」` : '暂无可用技能'}</div>`
      return
    }

    const cardsHtml = items.map((item) => renderStoreCard(item)).join('')
    if (append) {
      resultsEl.querySelector('.store-scroll-sentinel')?.remove()
      resultsEl.querySelector('.skills-list-grid')?.insertAdjacentHTML('beforeend', cardsHtml)
    } else {
      resultsEl.innerHTML = `<div class="skills-list-grid">${cardsHtml}</div>`
    }
    bindStoreEvents(resultsEl, page)
    if (_storeHasMore) {
      const grid = resultsEl.querySelector('.skills-list-grid') || resultsEl
      grid.insertAdjacentHTML('beforeend', '<div class="store-scroll-sentinel" style="height:1px"></div>')
      setupScrollObserver(resultsEl, page)
    }
  } catch (e) {
    if (!append) resultsEl.innerHTML = `<div class="ec-error">加载失败: ${esc(String(e))}</div>`
  }
}

function marketInstallState(item) {
  const slug = String(item.slug || item.id || '').toLowerCase()
  if (_installedSlugs.has(slug) || _installedSlugs.has(String(item.name || '').toLowerCase())) return 'installed'
  if (item.incompatible || item.compatible === false) return 'incompatible'
  if (item.updateAvailable || item.has_update) return 'update'
  return 'install'
}

function renderStoreCard(item) {
  const slug = String(item.slug || item.id || '')
  const owner = String(item.ownerHandle || item.owner_handle || item.author || '')
  const name = esc(item.name || item.displayName || item.title || slug || '未命名')
  const desc = esc(item.description || item.summary || item.desc || '暂无描述')
  const version = esc(item.version || item.versionId || '—')
  const updated = esc(item.updatedAt || item.updated_at || item.publishedAt || '—')
  const verified = item.verified || item.certified
  const risk = esc(item.risk || item.security || '常规')
  const perms = esc(item.permissions || item.license || '见技能声明')
  const state = marketInstallState(item)
  const btnMap = {
    install: '<button type="button" class="btn btn-sm btn-primary install-btn" data-action="install">安装</button>',
    installed: '<span class="install-badge-installed">已安装</span>',
    update: '<button type="button" class="btn btn-sm btn-primary install-btn" data-action="update">更新</button>',
    incompatible: '<span class="ec-badge-warn">不兼容</span>',
  }

  return `
    <article class="skill-card ec-skill-card" data-slug="${esc(slug)}" data-owner="${esc(owner)}" data-name="${name}">
      <div class="skill-card-main">
        <div class="skill-card-head">
          <span class="skill-card-icon">${getSkillIcon(item.name || slug)}</span>
          <strong class="skill-card-name">${name}</strong>
        </div>
        <p class="skill-card-desc">${desc}</p>
        <div class="ec-card-meta">
          <span>${owner ? `@${esc(owner)}` : '未知发布者'}</span>
          <span>${verified ? '已认证' : '未认证'}</span>
          <span>v${version}</span>
        </div>
        <div class="ec-card-meta ec-card-meta--muted">更新 ${updated} · 权限 ${perms} · 风险 ${risk}</div>
      </div>
      <div class="skill-card-actions">${btnMap[state]}</div>
    </article>`
}

function bindStoreEvents(container, page) {
  container.querySelectorAll('.skill-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.install-btn')) return
      openMarketInstallDrawer(page, card, { previewOnly: true })
    })
    const btn = card.querySelector('.install-btn')
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        openMarketInstallDrawer(page, card, { previewOnly: false })
      })
    }
  })
}

function openMarketInstallDrawer(page, card, { previewOnly }) {
  const slug = card.dataset.slug || ''
  const owner = card.dataset.owner || ''
  const name = card.dataset.name || slug
  openDrawer(page, {
    title: previewOnly ? name : `安装「${name}」`,
    subtitle: owner ? `@${esc(owner)}` : 'SkillHub',
    body: `
      <section class="role-drawer-section"><h4>权限说明</h4>
        <p>安装后技能将进入本机技能目录，并可被智能体引用。请确认来源可信。</p>
      </section>
      <section class="role-drawer-section"><h4>安装范围</h4>
        <p>全局技能库（所有工作区可用）。安装后默认为<strong>全局启用</strong>。</p>
      </section>
      <section class="role-drawer-section"><h4>标识</h4><p><code>${esc(slug)}</code></p></section>
    `,
    foot: previewOnly
      ? `<button type="button" class="btn btn-secondary" data-act="close">关闭</button>
         <button type="button" class="btn btn-primary" data-act="confirm">安装</button>`
      : `<button type="button" class="btn btn-secondary" data-act="close">取消</button>
         <button type="button" class="btn btn-primary" data-act="confirm">确认安装</button>`,
  })
  const root = page.querySelector('#ecDrawer')
  root.querySelector('[data-act="close"]')?.addEventListener('click', () => closeDrawer(page))
  root.querySelector('[data-act="confirm"]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget
    setBtnState(btn, 'loading', { loading: '安装中…', idle: '确认安装' })
    try {
      await api.skillsSkillHubInstall(slug, owner || null)
      _installedSlugs.add(slug.toLowerCase())
      setBtnState(btn, 'success', { success: '已安装' })
      toast(`技能「${name}」安装成功`, 'success')
      openDrawer(page, {
        title: '安装成功',
        subtitle: esc(name),
        body: `<p>技能已就绪。你可以把它添加到智能体，或返回查看详情。</p>`,
        foot: `
          <button type="button" class="btn btn-secondary" data-act="view">查看技能</button>
          <button type="button" class="btn btn-primary" data-act="assign">添加到智能体</button>`,
      })
      const r2 = page.querySelector('#ecDrawer')
      r2.querySelector('[data-act="view"]')?.addEventListener('click', () => {
        closeDrawer(page)
        page.querySelector('[data-main-tab="installed"]')?.click()
        void loadSkills(page, { force: true })
      })
      r2.querySelector('[data-act="assign"]')?.addEventListener('click', () => {
        closeDrawer(page)
        toast('请在智能体编辑页的「技能」中勾选该技能', 'info')
      })
      void doSearchInstall(page)
      void loadSkills(page, { force: true })
    } catch (err) {
      setBtnState(btn, 'error', { error: '安装失败，重试', idle: '确认安装' })
      toast('安装失败: ' + (err?.message || err), 'error')
    }
  })
}

function setupScrollObserver(resultsEl, page) {
  if (_storeObserver) _storeObserver.disconnect()
  const sentinel = resultsEl.querySelector('.store-scroll-sentinel')
  if (!sentinel) return
  _storeObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && _storeHasMore && !_isLoadingMore) {
          _isLoadingMore = true
          doSearchInstall(page, true).finally(() => {
            _isLoadingMore = false
          })
        }
      })
    },
    { root: resultsEl, rootMargin: '120px', threshold: 0 },
  )
  _storeObserver.observe(sentinel)
}
