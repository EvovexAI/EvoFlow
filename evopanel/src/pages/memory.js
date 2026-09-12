/**
 * 记忆管理 — 三命名空间中枢：助手记忆 / 工作区记忆 / 员工记忆。
 * 员工完整自传仍以成长 Tab 为主；本页可只读浏览并跳转。
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { showConfirm } from '../components/modal.js'
import { mountMemoryGraphPanel, unmountMemoryGraphPanel } from '../lib/mount-memory-graph.js'

const CATEGORIES = ['workContext', 'personalContext', 'topOfMind']
const HISTORY_CATEGORIES = ['recentMonths', 'earlierContext', 'longTermBackground']

const SCOPE_HINTS = {
  agent: '关于用户 / 该助手槽的记忆；对话默认注入这里。',
  workspace: '仅本工作区生效的项目约定；也可在聊天工作区侧栏编辑。',
  person: '员工自己的人生（日记 / 本事）。完整视图在员工「成长」Tab；此处只读浏览。',
}

/**
 * 展示名来自 ``GET /api/agents`` 的 agent_name（与角色管理、聊天一致）。
 *
 * @param {{ id?: string | null, display_name?: string } | null | undefined} agent
 */
function agentDisplayLabel(agent) {
  if (!agent || agent.id == null) return agent.display_name || '全局'
  const dn = (agent.display_name || '').trim()
  return dn || agent.id
}

/**
 * 记忆分栏选项：全局 + ``listAgents()`` 与角色管理同一数据源。
 * @param {Array<{ agent_code?: string, agent_name?: string, description?: string }>} roles
 * @returns {Array<{ id: string | null, display_name: string, description: string, has_memory_file: boolean }>}
 */
function buildMemoryAgentSlotsFromRoles(roles) {
  const slots = [
    {
      id: null,
      display_name: '全局',
      description: '未指定自定义 Agent 时的默认记忆',
      has_memory_file: false,
    },
  ]
  for (const r of roles) {
    const code = String(r?.agent_code || '').trim()
    if (!code) continue
    slots.push({
      id: code,
      display_name: (r.agent_name && String(r.agent_name).trim()) || code,
      description: (r.description && String(r.description).slice(0, 240)) || '',
      has_memory_file: false,
    })
  }
  return slots
}

/** @param {unknown} sec */
function normalizeContextSection(sec) {
  if (!sec || typeof sec !== 'object') return { summary: '', updatedAt: '' }
  const o = /** @type {Record<string, unknown>} */ (sec)
  const summary = o.summary != null ? String(o.summary) : ''
  const updatedAt = o.updatedAt != null ? String(o.updatedAt) : o.updated_at != null ? String(o.updated_at) : ''
  return { summary, updatedAt }
}

/** 统一 Gateway 与磁盘 JSON 的字段差异，避免摘要/事实解析不到而整块空白 */
function normalizeMemoryPayload(raw) {
  if (!raw || typeof raw !== 'object') return raw
  const o = /** @type {Record<string, unknown>} */ (raw)
  const userRaw = o.user || o.User
  const histRaw = o.history || o.History
  const userObj = userRaw && typeof userRaw === 'object' ? /** @type {Record<string, unknown>} */ (userRaw) : {}
  const histObj = histRaw && typeof histRaw === 'object' ? /** @type {Record<string, unknown>} */ (histRaw) : {}

  /** @type {Record<string, { summary: string, updatedAt: string }>} */
  const user = {}
  for (const cat of CATEGORIES) {
    user[cat] = normalizeContextSection(userObj[cat])
  }
  /** @type {Record<string, { summary: string, updatedAt: string }>} */
  const history = {}
  for (const cat of HISTORY_CATEGORIES) {
    history[cat] = normalizeContextSection(histObj[cat])
  }

  const factsRaw = Array.isArray(o.facts) ? o.facts : Array.isArray(o.Facts) ? o.Facts : []
  const facts = factsRaw.map((f) => {
    if (!f || typeof f !== 'object') return null
    const fr = /** @type {Record<string, unknown>} */ (f)
    return {
      id: fr.id != null ? String(fr.id) : '',
      content: fr.content != null ? String(fr.content) : '',
      category: fr.category != null ? String(fr.category) : 'context',
      confidence: typeof fr.confidence === 'number' && Number.isFinite(fr.confidence) ? fr.confidence : 0.5,
      createdAt: fr.createdAt != null ? String(fr.createdAt) : fr.created_at != null ? String(fr.created_at) : '',
      source: fr.source != null ? String(fr.source) : 'unknown',
    }
  }).filter(Boolean)

  return {
    version: o.version != null ? String(o.version) : '1.0',
    lastUpdated:
      o.lastUpdated != null ? String(o.lastUpdated) : o.last_updated != null ? String(o.last_updated) : '',
    user,
    history,
    facts,
  }
}

/**
 * @param {{ settingsModal?: boolean }} state
 * @param {Array<{ id?: string | null, display_name?: string, description?: string, has_memory_file?: boolean }>} agents
 */
function normalizeAgentsList(agents) {
  return [...agents].sort((a, b) => {
    if (a.id == null) return -1
    if (b.id == null) return 1
    if (a.id === 'main') return -1
    if (b.id === 'main') return 1
    return String(a.id ?? '').localeCompare(String(b.id ?? ''))
  })
}

/**
 * @param {{ settingsModal?: boolean, agents: Array<{ id?: string | null }>, agentId: string | null }} state
 */
function ensureSelectedAgent(state) {
  const idSet = new Set(state.agents.map((a) => a.id))
  if (state.agentId != null && idSet.has(state.agentId)) return
  if (state.agentId == null && idSet.has(null)) return

  if (state.settingsModal) {
    if (idSet.has('main')) state.agentId = 'main'
    else if (state.agents.length) state.agentId = state.agents[0].id
    else state.agentId = 'main'
    return
  }

  if (state.agentId != null && !idSet.has(state.agentId)) {
    state.agentId = null
  }
}

function formatTimeAgo(timestamp) {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  const now = new Date()
  const diff = (now - date) / 1000
  if (diff < 60) return '刚刚'
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前'
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前'
  if (diff < 604800) return Math.floor(diff / 86400) + ' 天前'
  return date.toLocaleDateString('zh-CN')
}

function confidenceToLevel(confidence) {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return { key: 'unknown', value: null }
  const value = Math.min(1, Math.max(0, confidence))
  if (value >= 0.85) return { key: 'veryHigh', value }
  if (value >= 0.65) return { key: 'high', value }
  return { key: 'normal', value }
}

function escapeHtml(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function filterTabsHtml(scopeKind = 'agent') {
  const agentOnly =
    scopeKind === 'agent'
      ? `
      <button type="button" class="tab" data-filter="summaries" role="tab">摘要</button>
      <button type="button" class="tab" data-filter="facts" role="tab">事实</button>`
      : ''
  return `
    <div class="tab-bar memory-filter-tabs" role="tablist">
      <button type="button" class="tab active" data-filter="all" role="tab">全部</button>
      ${agentOnly}
      <button type="button" class="tab" data-filter="atoms" role="tab">原子</button>
      <button type="button" class="tab" data-filter="graph" role="tab">图谱</button>
      <button type="button" class="tab" data-filter="recall" role="tab">试召回</button>
    </div>
  `
}

function scopeTabsHtml(active = 'agent') {
  const mk = (kind, label) =>
    `<button type="button" class="tab memory-scope-tab${active === kind ? ' active' : ''}" data-scope-kind="${kind}" role="tab">${label}</button>`
  return `
    <div class="tab-bar memory-scope-tabs" role="tablist" aria-label="记忆模块">
      ${mk('agent', '助手记忆')}
      ${mk('workspace', '工作区记忆')}
      ${mk('person', '员工记忆')}
    </div>
  `
}

function currentNamespace(state) {
  if (state.scopeKind === 'workspace') {
    const ws = (state.workspaces || []).find((w) => w.id === state.workspaceId || w.path === state.workspacePath)
    return ws?.namespace || state.namespace || ''
  }
  if (state.scopeKind === 'person') {
    const p = (state.persons || []).find((x) => x.id === state.personId)
    return p?.namespace || state.namespace || ''
  }
  const a = (state.agents || []).find((x) => x.id === state.agentId)
  if (a?.namespace) return a.namespace
  // fallback — server resolves agent key
  return state.namespace || ''
}

function selectedScopeLabel(state) {
  if (state.scopeKind === 'workspace') {
    const ws = (state.workspaces || []).find((w) => w.id === state.workspaceId || w.path === state.workspacePath)
    return ws?.label || ws?.path || '工作区'
  }
  if (state.scopeKind === 'person') {
    const p = (state.persons || []).find((x) => x.id === state.personId)
    return p?.label || state.personId || '员工'
  }
  return selectedAgentLabel(state)
}

/**
 * @param {boolean} settingsModal
 */
function createMemoryRoot(settingsModal) {
  const page = document.createElement('div')
  if (settingsModal) {
    page.className = 'settings-modal-pane settings-modal-pane--memory'
    page.innerHTML = `
      <div class="settings-modal-pane-body settings-modal-pane-body--memory">
        <div id="memory-loading" class="settings-modal-pane-loading" role="status"><span>加载中…</span></div>
        <div id="memory-main" class="settings-modal-pane-fill memory-pane-fill" hidden>
          <div class="memory-scope-row">${scopeTabsHtml('agent')}</div>
          <p class="memory-scope-hint-line" id="memory-scope-hint">${escapeHtml(SCOPE_HINTS.agent)}</p>
          <div class="memory-subtoolbar memory-subtoolbar--settings-modal memory-subtoolbar--settings-single-row">
            <div class="memory-toolbar-agent-wrap" id="memory-settings-agent-row">
              <div class="memory-agent-dropdown" id="memory-agent-dropdown">
                <button type="button" class="memory-agent-dropdown-trigger" id="memory-agent-dropdown-trigger" aria-expanded="false" aria-haspopup="listbox" aria-controls="memory-agent-dropdown-list">
                  <span class="memory-agent-dropdown-value" id="memory-agent-dropdown-value">—</span>
                </button>
                <div class="memory-agent-dropdown-panel" id="memory-agent-dropdown-panel" hidden role="presentation">
                  <ul class="memory-agent-dropdown-list" id="memory-agent-dropdown-list" role="listbox" aria-labelledby="memory-agent-dropdown-trigger"></ul>
                </div>
              </div>
            </div>
            <div class="memory-subtoolbar-controls">
              <select class="form-input memory-scope-select" id="memory-workspace-select" hidden aria-label="工作区"></select>
              <select class="form-input memory-scope-select" id="memory-person-select" hidden aria-label="员工"></select>
              <input class="form-input memory-search memory-search--settings-modal" type="search" id="memory-search" placeholder="搜索记忆…" autocomplete="off">
            </div>
            <div id="memory-filter-tabs-host" class="memory-filter-tabs-host">${filterTabsHtml('agent')}</div>
            <div class="memory-subtoolbar-actions">
              <button type="button" class="btn btn-sm btn-secondary" id="btn-reload">刷新</button>
              <button type="button" class="btn btn-sm btn-danger" id="btn-clear-all">清空当前</button>
            </div>
          </div>
          <div id="memory-content" class="memory-content-area"></div>
        </div>
        <div id="memory-error" class="settings-modal-pane-fill settings-modal-pane-error" hidden></div>
      </div>
    `
    return page
  }

  page.className = 'page memory-page'
  page.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">记忆</h1>
        <p class="page-desc">三套命名空间：助手（用户）· 工作区 · 员工。文档资料请到知识库。</p>
      </div>
      <div class="page-actions">
        <button type="button" class="btn btn-sm btn-secondary" id="btn-reload">刷新</button>
        <button type="button" class="btn btn-sm btn-danger" id="btn-clear-all">清空当前</button>
      </div>
    </div>
    <div class="page-content memory-page-content">
      <div id="memory-loading" class="memory-phase-loading" role="status">加载中…</div>
      <div id="memory-main" class="memory-main-layout" style="display:none">
        <div class="memory-scope-row">${scopeTabsHtml('agent')}</div>
        <p class="memory-scope-hint-line" id="memory-scope-hint">${escapeHtml(SCOPE_HINTS.agent)}</p>
        <div id="memory-agent-bar" class="memory-agent-bar" hidden></div>
        <div class="memory-subtoolbar memory-subtoolbar--page">
          <div class="memory-subtoolbar-controls">
            <select class="form-input memory-scope-select" id="memory-workspace-select" hidden aria-label="工作区"></select>
            <select class="form-input memory-scope-select" id="memory-person-select" hidden aria-label="员工"></select>
            <input class="form-input memory-search" type="search" id="memory-search" placeholder="搜索记忆…" autocomplete="off">
          </div>
          <div id="memory-filter-tabs-host" class="memory-filter-tabs-host">${filterTabsHtml('agent')}</div>
        </div>
        <div id="memory-content" class="memory-content-area"></div>
      </div>
      <div id="memory-error" class="memory-phase-error" style="display:none"></div>
    </div>
  `
  return page
}

function setMemoryPhase(page, phase) {
  const loadingEl = page.querySelector('#memory-loading')
  const mainEl = page.querySelector('#memory-main')
  const errorEl = page.querySelector('#memory-error')
  const modal = !!page.querySelector('.settings-modal-pane-body--memory')
  if (modal) {
    if (phase === 'loading') {
      loadingEl?.removeAttribute('hidden')
      mainEl?.setAttribute('hidden', '')
      errorEl?.setAttribute('hidden', '')
    } else if (phase === 'content') {
      loadingEl?.setAttribute('hidden', '')
      mainEl?.removeAttribute('hidden')
      errorEl?.setAttribute('hidden', '')
    } else if (phase === 'error') {
      loadingEl?.setAttribute('hidden', '')
      mainEl?.setAttribute('hidden', '')
      errorEl?.removeAttribute('hidden')
    }
    return
  }
  if (loadingEl) loadingEl.style.display = phase === 'loading' ? 'block' : 'none'
  if (mainEl) mainEl.style.display = phase === 'content' ? 'flex' : 'none'
  if (errorEl) errorEl.style.display = phase === 'error' ? 'block' : 'none'
}

function selectedAgentLabel(state) {
  const row = state.agents?.find((a) => (a.id == null && state.agentId == null) || a.id === state.agentId)
  return agentDisplayLabel(row || { id: state.agentId, display_name: state.agentId || '' })
}

function renderAgentBar(page, state) {
  if (state.settingsModal) return

  const bar = page.querySelector('#memory-agent-bar')
  if (!bar || !state.agents?.length) return

  if ((state.scopeKind || 'agent') !== 'agent') {
    bar.setAttribute('hidden', '')
    return
  }

  const multi = state.agents.length > 1
  bar.hidden = !multi
  if (!multi) {
    bar.innerHTML = ''
    return
  }

  const showIdChip = !state.settingsModal

  const chips = state.agents
    .map((a) => {
      const id = a.id
      const active = (id == null && state.agentId == null) || id === state.agentId
      const key = id == null ? '' : escapeHtml(id)
      const hint = a.description ? escapeHtml(a.description) : ''
      const newBadge = a.has_memory_file ? '' : '<span class="memory-agent-chip-badge">未落盘</span>'
      const label = escapeHtml(agentDisplayLabel(a))
      return `
        <button type="button" class="memory-agent-chip${active ? ' is-active' : ''}"
          data-agent="${key}"
          title="${hint}"
          aria-pressed="${active ? 'true' : 'false'}">
          <span class="memory-agent-chip-name">${label}</span>
          ${id != null && showIdChip ? `<code class="memory-agent-chip-id">${escapeHtml(id)}</code>` : ''}
          ${newBadge}
        </button>
      `
    })
    .join('')

  bar.innerHTML = chips

  bar.querySelectorAll('.memory-agent-chip').forEach((btn) => {
    btn.onclick = () => {
      const raw = btn.getAttribute('data-agent') || ''
      state.agentId = raw === '' ? null : raw
      bar.querySelectorAll('.memory-agent-chip').forEach((b) => {
        const d = b.getAttribute('data-agent') || ''
        const on = state.agentId == null ? d === '' : d === state.agentId
        b.classList.toggle('is-active', on)
        b.setAttribute('aria-pressed', on ? 'true' : 'false')
      })
      syncMemoryAgentSelect(page, state)
      void loadMemoryPage(page, state, { refreshAgents: false })
    }
  })
}

function closeMemoryAgentDropdown(page) {
  const panel = page.querySelector('#memory-agent-dropdown-panel')
  const trigger = page.querySelector('#memory-agent-dropdown-trigger')
  if (panel) panel.setAttribute('hidden', '')
  if (trigger) trigger.setAttribute('aria-expanded', 'false')
}

/**
 * 同步设置内自定义智能体下拉的展示与选中态（全页芯片切换时也会调用）
 * @param {HTMLElement | null} page
 * @param {{ settingsModal?: boolean, agentId: string | null }} state
 */
function syncMemoryAgentDropdown(page, state) {
  if (!state.settingsModal) return
  const valSpan = page.querySelector('#memory-agent-dropdown-value')
  if (valSpan) valSpan.textContent = selectedAgentLabel(state)
  const list = page.querySelector('#memory-agent-dropdown-list')
  if (!list) return
  list.querySelectorAll('.memory-agent-dropdown-item').forEach((btn) => {
    const raw = btn.getAttribute('data-agent') || ''
    const active = state.agentId == null ? raw === '' : raw === state.agentId
    btn.classList.toggle('is-active', active)
    btn.setAttribute('aria-selected', active ? 'true' : 'false')
  })
}

/**
 * 设置弹窗：document 层关闭下拉（pointerdown 捕获）
 * @param {HTMLElement} page
 * @param {{ settingsModal?: boolean, _memDdDocBound?: boolean }} state
 */
function bindMemoryAgentDropdownDocumentClose(page, state) {
  if (!state.settingsModal || state._memDdDocBound) return
  state._memDdDocBound = true
  const onPointerDown = (ev) => {
    if (!page.isConnected) return
    const root = page.querySelector('#memory-agent-dropdown')
    const panel = page.querySelector('#memory-agent-dropdown-panel')
    if (!root || !panel || panel.hasAttribute('hidden')) return
    const t = ev.target
    if (t instanceof Node && root.contains(t)) return
    closeMemoryAgentDropdown(page)
  }
  const onKey = (ev) => {
    if (ev.key !== 'Escape') return
    if (!page.isConnected) return
    const panel = page.querySelector('#memory-agent-dropdown-panel')
    if (!panel || panel.hasAttribute('hidden')) return
    closeMemoryAgentDropdown(page)
  }
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('keydown', onKey, true)
}

/**
 * 设置弹窗：与 state.agentId 同步（保留函数名供全页芯片路径调用）
 * @param {HTMLElement | null} page
 * @param {{ settingsModal?: boolean, agentId: string | null }} state
 */
function syncMemoryAgentSelect(page, state) {
  syncMemoryAgentDropdown(page, state)
}

/**
 * 设置弹窗：自定义智能体下拉（选项可完全样式化）
 * @param {HTMLElement} page
 * @param {{ settingsModal?: boolean, agents: Array<{ id?: string | null, display_name?: string, description?: string, has_memory_file?: boolean }>, agentId: string | null }} state
 */
function renderAgentSelect(page, state) {
  const row = page.querySelector('#memory-settings-agent-row')
  const trigger = page.querySelector('#memory-agent-dropdown-trigger')
  const panel = page.querySelector('#memory-agent-dropdown-panel')
  const list = page.querySelector('#memory-agent-dropdown-list')
  if (!row || !trigger || !panel || !list || !state.settingsModal) return

  if (!state.agents?.length) {
    row.hidden = true
    list.innerHTML = ''
    return
  }

  row.hidden = false
  const items = state.agents
    .map((a) => {
      const val = a.id == null ? '' : String(a.id)
      const label = escapeHtml(agentDisplayLabel(a))
      const active = (a.id == null && state.agentId == null) || a.id === state.agentId
      const hint = a.description ? escapeHtml(a.description) : ''
      const badge = a.has_memory_file ? '' : '<span class="memory-agent-dropdown-badge">未落盘</span>'
      return `<li role="none">
        <button type="button" class="memory-agent-dropdown-item${active ? ' is-active' : ''}" role="option" aria-selected="${active ? 'true' : 'false'}" data-agent="${escapeHtml(val)}" title="${hint}">
          <span class="memory-agent-dropdown-item-label">${label}</span>${badge}
        </button>
      </li>`
    })
    .join('')
  list.innerHTML = items

  syncMemoryAgentDropdown(page, state)

  trigger.onclick = (e) => {
    e.preventDefault()
    e.stopPropagation()
    const collapsed = panel.hasAttribute('hidden')
    if (collapsed) {
      panel.removeAttribute('hidden')
      trigger.setAttribute('aria-expanded', 'true')
    } else {
      panel.setAttribute('hidden', '')
      trigger.setAttribute('aria-expanded', 'false')
    }
  }

  list.querySelectorAll('.memory-agent-dropdown-item').forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault()
      e.stopPropagation()
      const raw = btn.getAttribute('data-agent') || ''
      state.agentId = raw === '' ? null : raw
      closeMemoryAgentDropdown(page)
      syncMemoryAgentDropdown(page, state)
      void loadMemoryPage(page, state, { refreshAgents: false })
    }
  })
}

function renderMemoryContent(page, state) {
  const contentEl = page.querySelector('#memory-content')
  const { memory, filter, query } = state

  if (!contentEl) return
  const scopeKind = state.scopeKind || 'agent'
  const isAgentScope = scopeKind === 'agent'
  if (isAgentScope && !memory) return

  const normalizedQuery = query.trim().toLowerCase()
  const showSummaries = isAgentScope && (filter === 'all' || filter === 'summaries')
  const showFacts = isAgentScope && (filter === 'all' || filter === 'facts')
  const showAtoms = filter === 'all' || filter === 'atoms'
  const showRecall = filter === 'recall'
  const showGraph = filter === 'graph'

  // Unmount React graph when leaving tab
  const prevHost = contentEl.querySelector('[data-memory-graph-host]')
  if (prevHost && !showGraph) {
    unmountMemoryGraphPanel(prevHost)
  }

  if (showGraph) {
    renderGraphPanel(contentEl, state)
    return
  }

  if (showRecall) {
    renderRecallPanel(contentEl, page, state)
    return
  }

  const summarySections = []

  if (isAgentScope && memory) {
  const userContextTitle = '用户上下文'
  for (const cat of CATEGORIES) {
    const section = memory.user?.[cat]
    if (section) {
      const label = cat === 'workContext' ? '工作' : cat === 'personalContext' ? '个人' : '最重要的事'
      if (!normalizedQuery || `${label} ${section.summary}`.toLowerCase().includes(normalizedQuery)) {
        summarySections.push({
          group: userContextTitle,
          label,
          summary: section.summary,
          updatedAt: section.updatedAt,
        })
      }
    }
  }

  const historyTitle = '历史背景'
  for (const cat of HISTORY_CATEGORIES) {
    const section = memory.history?.[cat]
    if (section) {
      const label = cat === 'recentMonths' ? '最近几个月' : cat === 'earlierContext' ? '更早的上下文' : '长期背景'
      if (!normalizedQuery || `${label} ${section.summary}`.toLowerCase().includes(normalizedQuery)) {
        summarySections.push({
          group: historyTitle,
          label,
          summary: section.summary,
          updatedAt: section.updatedAt,
        })
      }
    }
  }
  }

  const filteredFacts = isAgentScope
    ? (memory?.facts || []).filter((fact) => {
        if (!normalizedQuery) return true
        return `${fact.content} ${fact.category}`.toLowerCase().includes(normalizedQuery)
      })
    : []

  const atoms = Array.isArray(state.atoms) ? state.atoms : []
  const filteredAtoms = atoms.filter((a) => {
    if (!normalizedQuery) return true
    return `${a.content || ''} ${a.layer || ''} ${a.kind || ''}`.toLowerCase().includes(normalizedQuery)
  })

  const hasSummary = summarySections.some((s) => s.summary && s.summary.trim())
  const hasFacts = filteredFacts.length > 0
  const hasAtoms = filteredAtoms.length > 0
  const anythingVisible =
    (showSummaries && hasSummary) || (showFacts && hasFacts) || (showAtoms && hasAtoms)

  let html = ''

  const timeAgo = memory?.lastUpdated ? formatTimeAgo(memory.lastUpdated) : '—'
  const ns = currentNamespace(state)
  let scopeHint = `<p class="memory-scope-hint">模块：<strong>${escapeHtml(selectedScopeLabel(state))}</strong> · <code>${escapeHtml(ns || '—')}</code>`
  if (isAgentScope && memory?.lastUpdated) scopeHint += ` · 更新 ${escapeHtml(timeAgo)}`
  scopeHint += `</p>`
  if (scopeKind === 'person') {
    const p = (state.persons || []).find((x) => x.id === state.personId)
    const href = p?.href || (state.personId ? `#/proactive/${encodeURIComponent(state.personId)}` : '')
    if (href) {
      scopeHint += `<p class="memory-scope-hint"><a href="${escapeHtml(href)}">打开员工成长页</a>（时间线 / 本事 / 身份）</p>`
    }
  }

  if (!anythingVisible) {
    const emptyHint = SCOPE_HINTS[scopeKind] || '可切换模块、调整筛选或清空搜索后重试。'
    contentEl.innerHTML = `
      <div class="memory-inline-empty">
        ${scopeHint}
        <p class="memory-inline-empty-title">暂无匹配内容</p>
        <p class="memory-inline-empty-desc">${escapeHtml(emptyHint)}</p>
      </div>
    `
    return
  }

  html += scopeHint

  if (showSummaries && hasSummary) {
    html += `
      <section class="memory-block" aria-label="记忆摘要">
        <div class="memory-block-head">
          <h3 class="memory-block-title">摘要</h3>
        </div>
    `

    const grouped = {}
    for (const s of summarySections) {
      if (!grouped[s.group]) grouped[s.group] = []
      grouped[s.group].push(s)
    }

    for (const [groupTitle, sections] of Object.entries(grouped)) {
      html += `<div class="memory-group">`
      html += `<h4 class="memory-group-title">${escapeHtml(groupTitle)}</h4>`
      for (const s of sections) {
        html += `
          <article class="memory-summary-card">
            <div class="memory-summary-card-head">
              <span class="memory-summary-card-label">${escapeHtml(s.label)}</span>
              ${s.updatedAt ? `<time class="memory-summary-card-time">更新于 ${escapeHtml(formatTimeAgo(s.updatedAt))}</time>` : ''}
            </div>
            <div class="memory-summary-card-body">
              ${s.summary ? escapeHtml(s.summary) : '<span class="memory-muted">暂无内容</span>'}
            </div>
          </article>
        `
      }
      html += `</div>`
    }

    html += `</section>`
  }

  if (showFacts && hasFacts) {
    html += `
      <section class="memory-block" aria-label="记忆事实">
        <div class="memory-block-head">
          <h3 class="memory-block-title">事实</h3>
        </div>
        <ul class="memory-fact-list">
    `

    for (const fact of filteredFacts) {
      const { key } = confidenceToLevel(fact.confidence)
      const confidenceLabel = key === 'veryHigh' ? '非常高' : key === 'high' ? '高' : '一般'
      const categoryLabel =
        fact.category === 'context'
          ? '上下文'
          : fact.category === 'preference'
            ? '偏好'
            : fact.category === 'fact'
              ? '事实'
              : escapeHtml(fact.category)

      html += `
        <li class="memory-fact-card">
          <div class="memory-fact-main">
            <div class="memory-fact-meta">
              <span class="memory-fact-tag">${categoryLabel}</span>
              <span class="memory-fact-meta-item">置信 ${confidenceLabel}</span>
              ${fact.createdAt ? `<span class="memory-fact-meta-item">${escapeHtml(formatTimeAgo(fact.createdAt))}</span>` : ''}
            </div>
            <p class="memory-fact-text">${escapeHtml(fact.content)}</p>
          </div>
          <button type="button" class="btn btn-sm btn-danger memory-fact-delete" data-action="delete-fact" data-id="${escapeHtml(fact.id)}">删除</button>
        </li>
      `
    }

    html += `</ul></section>`
  }

  if (showAtoms && hasAtoms) {
    html += `
      <section class="memory-block" aria-label="记忆原子">
        <div class="memory-block-head">
          <h3 class="memory-block-title">原子（L2/L3/L4）</h3>
        </div>
        <ul class="memory-fact-list">
    `
    const personReadOnly = scopeKind === 'person'
    for (const atom of filteredAtoms) {
      const layerLabel =
        atom.layer === 'episodic' ? '情景' : atom.layer === 'procedural' ? '本事' : '语义'
      const pin = atom.pin ? '★' : '☆'
      const actions = personReadOnly
        ? `<span class="memory-muted">${pin} 只读</span>`
        : `<div class="memory-fact-actions">
            <button type="button" class="btn btn-sm btn-secondary" data-action="pin-atom" data-id="${escapeHtml(atom.id)}" data-pin="${atom.pin ? '0' : '1'}">${pin} Pin</button>
            <button type="button" class="btn btn-sm btn-danger" data-action="delete-atom" data-id="${escapeHtml(atom.id)}">删除</button>
          </div>`
      html += `
        <li class="memory-fact-card">
          <div class="memory-fact-main">
            <div class="memory-fact-meta">
              <span class="memory-fact-tag">${escapeHtml(layerLabel)}</span>
              <span class="memory-fact-meta-item">${escapeHtml(atom.kind || '')}</span>
              ${atom.updated_at ? `<time class="memory-fact-meta-item">${escapeHtml(formatTimeAgo(atom.updated_at))}</time>` : ''}
            </div>
            <p class="memory-fact-text">${escapeHtml(atom.content || '')}</p>
          </div>
          ${actions}
        </li>
      `
    }
    html += `</ul></section>`
  }

  contentEl.innerHTML = html

  contentEl.querySelectorAll('[data-action="delete-fact"]').forEach((btn) => {
    btn.onclick = async () => {
      const factId = btn.dataset.id
      const yes = await showConfirm('确定删除这条记忆事实？此操作无法撤销。')
      if (!yes) return
      try {
        await api.deleteMemoryFact(factId, state.agentId)
        toast('已删除', 'success')
        await loadMemoryPage(page, state)
      } catch (e) {
        toast('删除失败: ' + e, 'error')
      }
    }
  })

  contentEl.querySelectorAll('[data-action="pin-atom"]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id
      const pin = btn.dataset.pin === '1'
      try {
        await api.patchMemoryAtom(id, { pin })
        toast(pin ? '已 Pin' : '已取消 Pin', 'success')
        await loadMemoryPage(page, state, { refreshAgents: false })
      } catch (e) {
        toast('操作失败: ' + e, 'error')
      }
    }
  })

  contentEl.querySelectorAll('[data-action="delete-atom"]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id
      const yes = await showConfirm('确定删除这条记忆原子？')
      if (!yes) return
      try {
        await api.deleteMemoryAtom(id)
        toast('已删除', 'success')
        await loadMemoryPage(page, state, { refreshAgents: false })
      } catch (e) {
        toast('删除失败: ' + e, 'error')
      }
    }
  })
}

function renderGraphPanel(contentEl, state) {
  contentEl.innerHTML = `
    <div class="memory-block memory-block--graph">
      <div class="memory-block-head">
        <h3 class="memory-block-title">记忆图谱</h3>
      </div>
      <div data-memory-graph-host class="memory-graph-host"></div>
    </div>
  `
  const host = contentEl.querySelector('[data-memory-graph-host]')
  mountMemoryGraphPanel(host, {
    agentId: state.scopeKind === 'agent' ? state.agentId : null,
    namespace: currentNamespace(state) || null,
  })
}

function renderRecallPanel(contentEl, page, state) {
  const hits = Array.isArray(state.recallHits) ? state.recallHits : []
  let html = `
    <div class="memory-block">
      <div class="memory-block-head"><h3 class="memory-block-title">试召回</h3></div>
      <div class="memory-subtoolbar" style="gap:8px;margin-bottom:12px">
        <input class="form-input memory-search" type="search" id="memory-recall-q" placeholder="输入一句话，看会召回哪些原子…" value="${escapeHtml(state.recallQuery || '')}">
        <button type="button" class="btn btn-sm btn-primary" id="btn-memory-recall">召回</button>
      </div>
  `
  if (!hits.length) {
    html += `<p class="memory-muted">输入查询后点召回，结果不会写入记忆。</p>`
  } else {
    html += `<ul class="memory-fact-list">`
    for (const atom of hits) {
      html += `
        <li class="memory-fact-card">
          <div class="memory-fact-meta">
            <span class="memory-fact-tag">${escapeHtml(atom.layer || '')}</span>
            <span class="memory-fact-meta-item">${escapeHtml(atom.kind || '')}</span>
          </div>
          <p class="memory-fact-text">${escapeHtml(atom.content || '')}</p>
        </li>`
    }
    html += `</ul>`
  }
  html += `</div>`
  contentEl.innerHTML = html
  const run = async () => {
    const input = contentEl.querySelector('#memory-recall-q')
    const q = (input?.value || '').trim()
    if (!q) {
      toast('请输入查询', 'error')
      return
    }
    state.recallQuery = q
    try {
      const ns = currentNamespace(state)
      const res = await api.recallMemory(
        { query: q, top_k: 8 },
        state.scopeKind === 'agent' ? state.agentId : null,
        ns ? { namespace: ns } : {},
      )
      state.recallHits = Array.isArray(res?.hits) ? res.hits : []
      renderRecallPanel(contentEl, page, state)
    } catch (e) {
      toast('召回失败: ' + e, 'error')
    }
  }
  contentEl.querySelector('#btn-memory-recall')?.addEventListener('click', () => void run())
  contentEl.querySelector('#memory-recall-q')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void run()
  })
}

async function loadNamespaceCatalog(page, state) {
  try {
    const data = await api.getMemoryNamespaces()
    state.namespaceHints = data?.hints || SCOPE_HINTS
    const agentsFromApi = Array.isArray(data?.agents) ? data.agents : []
    if (agentsFromApi.length) {
      state.agents = normalizeAgentsList(
        agentsFromApi.map((a) => ({
          id: a.id == null || a.id === '' ? null : String(a.id),
          display_name: a.label || a.id || '全局',
          description: a.description || '',
          has_memory_file: Number(a.atom_count || 0) > 0,
          namespace: a.namespace || '',
          atom_count: Number(a.atom_count || 0),
        })),
      )
    } else {
      await loadAgentsFallback(page, state)
    }
    state.workspaces = Array.isArray(data?.workspaces) ? data.workspaces : []
    state.persons = Array.isArray(data?.persons) ? data.persons : []
  } catch {
    await loadAgentsFallback(page, state)
    state.workspaces = []
    state.persons = []
  }
  ensureSelectedAgent(state)
  ensureSelectedWorkspace(state)
  ensureSelectedPerson(state)
  renderAgentBar(page, state)
  renderAgentSelect(page, state)
  syncScopeChrome(page, state)
}

async function loadAgentsFallback(page, state) {
  try {
    const roles = await api.listAgents()
    state.agents = normalizeAgentsList(buildMemoryAgentSlotsFromRoles(roles))
  } catch {
    state.agents = normalizeAgentsList([
      { id: null, display_name: '全局', description: '', has_memory_file: false },
      { id: 'main', display_name: '主智能体', description: '', has_memory_file: false },
    ])
  }
}

function ensureSelectedWorkspace(state) {
  const list = state.workspaces || []
  if (!list.length) {
    state.workspaceId = null
    state.workspacePath = ''
    return
  }
  const ok = list.some((w) => w.id === state.workspaceId || w.path === state.workspacePath)
  if (ok) return
  state.workspaceId = list[0].id || null
  state.workspacePath = list[0].path || ''
  state.namespace = list[0].namespace || ''
}

function ensureSelectedPerson(state) {
  const list = state.persons || []
  if (!list.length) {
    state.personId = null
    return
  }
  if (list.some((p) => p.id === state.personId)) return
  state.personId = list[0].id || null
  state.namespace = list[0].namespace || ''
}

function syncScopeChrome(page, state) {
  const kind = state.scopeKind || 'agent'
  const hintEl = page.querySelector('#memory-scope-hint')
  if (hintEl) {
    const hints = state.namespaceHints || SCOPE_HINTS
    hintEl.textContent = hints[kind] || SCOPE_HINTS[kind] || ''
  }
  page.querySelectorAll('.memory-scope-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-scope-kind') === kind)
  })

  const agentRow = page.querySelector('#memory-settings-agent-row')
  const agentBar = page.querySelector('#memory-agent-bar')
  const wsSelect = page.querySelector('#memory-workspace-select')
  const personSelect = page.querySelector('#memory-person-select')
  const clearBtn = page.querySelector('#btn-clear-all')

  if (agentRow) agentRow.hidden = kind !== 'agent'
  if (agentBar) {
    if (kind === 'agent') agentBar.removeAttribute('hidden')
    else agentBar.setAttribute('hidden', '')
  }
  if (wsSelect) {
    wsSelect.hidden = kind !== 'workspace'
    if (kind === 'workspace') {
      wsSelect.innerHTML = (state.workspaces || [])
        .map((w) => {
          const val = escapeHtml(w.path || w.id || '')
          const selected =
            (state.workspacePath && w.path === state.workspacePath) ||
            (state.workspaceId && w.id === state.workspaceId)
              ? ' selected'
              : ''
          return `<option value="${val}" data-id="${escapeHtml(w.id || '')}" data-ns="${escapeHtml(w.namespace || '')}"${selected}>${escapeHtml(w.label || w.path || w.id || '')} (${Number(w.atom_count || 0)})</option>`
        })
        .join('')
      if (!(state.workspaces || []).length) {
        wsSelect.innerHTML = `<option value="">暂无工作区历史</option>`
      }
    }
  }
  if (personSelect) {
    personSelect.hidden = kind !== 'person'
    if (kind === 'person') {
      personSelect.innerHTML = (state.persons || [])
        .map((p) => {
          const selected = p.id === state.personId ? ' selected' : ''
          return `<option value="${escapeHtml(p.id || '')}" data-ns="${escapeHtml(p.namespace || '')}" data-href="${escapeHtml(p.href || '')}"${selected}>${escapeHtml(p.label || p.id || '')} (${Number(p.atom_count || 0)})</option>`
        })
        .join('')
      if (!(state.persons || []).length) {
        personSelect.innerHTML = `<option value="">暂无智能体员工</option>`
      }
    }
  }
  if (clearBtn) {
    clearBtn.disabled = kind === 'person'
    clearBtn.title = kind === 'person' ? '员工记忆请在成长页管理（本页只读）' : '清空当前命名空间'
  }

  const host = page.querySelector('#memory-filter-tabs-host')
  if (host) {
    const prev = state.filter
    host.innerHTML = filterTabsHtml(kind)
    bindFilterTabs(page, state)
    const want = prev === 'summaries' || prev === 'facts' ? (kind === 'agent' ? prev : 'atoms') : prev || 'all'
    state.filter = want
    host.querySelectorAll('.tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.filter === want)
    })
  }
}

/**
 * @param {{ refreshAgents?: boolean }} [opts]
 */
async function loadMemoryPage(page, state, opts = {}) {
  const refreshAgents = opts.refreshAgents !== false
  const errorEl = page.querySelector('#memory-error')

  setMemoryPhase(page, 'loading')

  try {
    if (refreshAgents) {
      await loadNamespaceCatalog(page, state)
    } else {
      syncScopeChrome(page, state)
    }

    const kind = state.scopeKind || 'agent'
    if (kind === 'agent') {
      const memory = normalizeMemoryPayload(await api.getMemory(state.agentId))
      state.memory = memory
      const atomsPayload = await api.listMemoryAtoms(state.agentId, { limit: 200 })
      state.atoms = Array.isArray(atomsPayload?.atoms) ? atomsPayload.atoms : []
      state.namespace = atomsPayload?.namespace || currentNamespace(state)
    } else if (kind === 'workspace') {
      state.memory = normalizeMemoryPayload({})
      const ws = (state.workspaces || []).find(
        (w) => w.id === state.workspaceId || w.path === state.workspacePath,
      )
      const ns = ws?.namespace || ''
      state.namespace = ns
      if (ws?.path) {
        try {
          const payload = await api.getWorkspaceProjectMemory(ws.path, { limit: 200 })
          state.atoms = Array.isArray(payload?.atoms) ? payload.atoms : []
          state.namespace = payload?.namespace || ns
        } catch {
          const atomsPayload = await api.listMemoryAtoms(null, { namespace: ns, limit: 200 })
          state.atoms = Array.isArray(atomsPayload?.atoms) ? atomsPayload.atoms : []
        }
      } else if (ns) {
        const atomsPayload = await api.listMemoryAtoms(null, { namespace: ns, limit: 200 })
        state.atoms = Array.isArray(atomsPayload?.atoms) ? atomsPayload.atoms : []
      } else {
        state.atoms = []
      }
    } else {
      // person — read-only atoms
      state.memory = normalizeMemoryPayload({})
      const p = (state.persons || []).find((x) => x.id === state.personId)
      const ns = p?.namespace || ''
      state.namespace = ns
      if (ns) {
        const atomsPayload = await api.listMemoryAtoms(null, { namespace: ns, limit: 200 })
        state.atoms = Array.isArray(atomsPayload?.atoms) ? atomsPayload.atoms : []
      } else {
        state.atoms = []
      }
    }

    state.loading = false
    setMemoryPhase(page, 'content')
    syncMemoryAgentSelect(page, state)
    renderMemoryContent(page, state)
  } catch (e) {
    setMemoryPhase(page, 'error')
    if (errorEl) errorEl.textContent = '加载失败: ' + e
    toast('加载记忆失败: ' + e, 'error')
  }
}

function bindFilterTabs(page, state) {
  page.querySelectorAll('.memory-filter-tabs .tab').forEach((tab) => {
    tab.onclick = () => {
      page.querySelectorAll('.memory-filter-tabs .tab').forEach((t) => t.classList.remove('active'))
      tab.classList.add('active')
      state.filter = tab.dataset.filter
      renderMemoryContent(page, state)
    }
  })
}

function bindScopeControls(page, state) {
  page.querySelectorAll('.memory-scope-tab').forEach((tab) => {
    tab.onclick = () => {
      const kind = tab.getAttribute('data-scope-kind') || 'agent'
      if (state.scopeKind === kind) return
      state.scopeKind = kind
      state.filter = kind === 'agent' ? 'all' : 'atoms'
      state.recallHits = []
      void loadMemoryPage(page, state, { refreshAgents: false })
    }
  })

  const wsSelect = page.querySelector('#memory-workspace-select')
  if (wsSelect && wsSelect.dataset.bound !== '1') {
    wsSelect.dataset.bound = '1'
    wsSelect.onchange = () => {
      const opt = wsSelect.selectedOptions?.[0]
      state.workspacePath = wsSelect.value || ''
      state.workspaceId = opt?.getAttribute('data-id') || null
      state.namespace = opt?.getAttribute('data-ns') || ''
      void loadMemoryPage(page, state, { refreshAgents: false })
    }
  }

  const personSelect = page.querySelector('#memory-person-select')
  if (personSelect && personSelect.dataset.bound !== '1') {
    personSelect.dataset.bound = '1'
    personSelect.onchange = () => {
      const opt = personSelect.selectedOptions?.[0]
      state.personId = personSelect.value || null
      state.namespace = opt?.getAttribute('data-ns') || ''
      void loadMemoryPage(page, state, { refreshAgents: false })
    }
  }
}

function bindMemoryPage(page, state) {
  page.querySelector('#btn-reload').onclick = () => loadMemoryPage(page, state)

  page.querySelector('#btn-clear-all').onclick = async () => {
    const kind = state.scopeKind || 'agent'
    if (kind === 'person') {
      toast('员工记忆请在成长页管理', 'info')
      return
    }
    const name = selectedScopeLabel(state)
    const ns = currentNamespace(state)
    const yes = await showConfirm(
      kind === 'workspace'
        ? `确定清空工作区「${name}」的项目记忆？此操作无法撤销。`
        : state.agentId == null
          ? `确定清空「全局」的全部记忆？未选择自定义助手时的主对话将失去长期记忆。`
          : `确定清空助手「${name}」的全部记忆？此操作无法撤销。`,
    )
    if (!yes) return
    try {
      if (kind === 'workspace') {
        if (!ns) throw new Error('缺少 namespace')
        await api.clearMemoryNamespace(ns)
      } else {
        await api.clearMemory(state.agentId)
      }
      toast('已清空当前命名空间', 'success')
      await loadMemoryPage(page, state)
    } catch (e) {
      toast('清空失败: ' + e, 'error')
    }
  }

  const search = page.querySelector('#memory-search')
  if (search) {
    search.oninput = (e) => {
      state.query = e.target.value
      renderMemoryContent(page, state)
    }
  }

  bindFilterTabs(page, state)
  bindScopeControls(page, state)
  bindMemoryAgentDropdownDocumentClose(page, state)
}

function createInitialState(settingsModal) {
  return {
    settingsModal: !!settingsModal,
    scopeKind: 'agent',
    agents: [],
    agentId: settingsModal ? 'main' : null,
    workspaces: [],
    workspaceId: null,
    workspacePath: '',
    persons: [],
    personId: null,
    namespace: '',
    namespaceHints: SCOPE_HINTS,
    memory: null,
    atoms: [],
    filter: 'all',
    query: '',
    recallHits: [],
    recallQuery: '',
    loading: true,
  }
}

export async function render() {
  const page = createMemoryRoot(false)
  const state = createInitialState(false)
  bindMemoryPage(page, state)
  await loadMemoryPage(page, state)
  return page
}

export function mountMemoryForSettingsModal(container) {
  const page = createMemoryRoot(true)
  const state = createInitialState(true)
  container.replaceChildren(page)
  bindMemoryPage(page, state)
  void loadMemoryPage(page, state)
}
