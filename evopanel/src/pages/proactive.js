/**
 * Proactive AI（智能体员工）管理面板
 *
 * 页面结构：
 *  1. 值班台 - 整体值班状态启停
 *  2. 员工名册 - 岗位卡片，支持请假/上班/手动触发上班
 *  3. 工作事项 - AI 发起的事项时间线
 *  4. 待审批 - 需人决策的事项，一键同意/拒绝
 */
import { api, getGatewayBaseUrl } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { navigate } from '../router.js'
import { notifyDesktopCompletion } from '../lib/desktop-notification.js'
import { showConfirm } from '../components/modal.js'
import { mountProactiveLiveProcess } from '../components/proactive-live-process.js'
import { filterChatModels } from '../lib/model-classification.js'
import { mountAgentAvatar } from '../lib/mount-agent-ui.js'
import {
  showEditRoleModal as openEditRoleModal,
  loadKnowledgeVaults,
  readKnowledgeVaultIds,
  renderKnowledgeVaultField,
} from '../lib/proactive-role-edit.js'
import {
  createSchedulePanel,
  roleScheduleSummary,
} from '../lib/schedule-panel.js'
import {
  FEISHU_COLLAB_HOWTO_SHORT,
  feishuBindingOf,
  feishuBoundChipHtml,
  listUnboundFeishuRoles,
  startFeishuEmployeeScan,
  unbindFeishuEmployee,
} from '../lib/feishu-employee-bind.js'
import { renderOutputItemCardsHtml, filterDeliverableOutputs } from '../lib/task-summary.js'
import { bindTaskOutputCardActions } from '../lib/task-output-preview.js'
import { HIRE_TEMPLATES, hireTemplateById } from '../lib/proactive-hire-templates.js'
import { diagnoseRole, renderRoleDiagnosisHtml } from '../lib/proactive-role-diagnosis.js'
import {
  loadWorkspacePaths,
  renderWorkspaceField,
  bindWorkspaceSelect,
  readWorkspacePath,
  pathBasename,
} from '../lib/workspace-field-ui.js'
import {
  bindListPager,
  paginateItems,
  readStoredPageSize,
  renderListPagerHtml,
  writeStoredPageSize,
} from '../components/list-pager.js'

const ROLES_PAGE_SIZE_KEY = 'evopanel_proactive_roles_page_size'
const ARCHIVED_PAGE_SIZE_KEY = 'evopanel_proactive_archived_page_size'

// ── helpers ──────────────────────────────────────────────

function esc(s) {
  if (s == null) return ''
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function fmtClock(d) {
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Relative label for past or future ISO times (下次自动上班 is future). */
function fmtTime(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return String(iso)
    const now = new Date()
    const diffSec = Math.round((d.getTime() - now.getTime()) / 1000)
    // Future → 「X 后」
    if (diffSec > 45) {
      if (diffSec < 3600) return Math.max(1, Math.floor(diffSec / 60)) + ' 分钟后'
      if (diffSec < 86400) return Math.floor(diffSec / 3600) + ' 小时后'
      if (diffSec < 86400 * 7) return Math.floor(diffSec / 86400) + ' 天后'
      return fmtClock(d)
    }
    // Past / near-now → 「刚刚 / X 前」
    const ago = -diffSec
    if (ago < 60) return '刚刚'
    if (ago < 3600) return Math.floor(ago / 60) + ' 分钟前'
    if (ago < 86400) return Math.floor(ago / 3600) + ' 小时前'
    return fmtClock(d)
  } catch {
    return String(iso)
  }
}

/** agent_code → agent row（头像继承智能体，岗位不再单独配图） */
let _agentsByCode = new Map()
let _gatewayBaseCache = ''

async function gatewayBaseForAvatars() {
  if (!_gatewayBaseCache) {
    try {
      _gatewayBaseCache = await getGatewayBaseUrl()
    } catch {
      _gatewayBaseCache = ''
    }
  }
  return _gatewayBaseCache
}

async function refreshAgentsAvatarIndex() {
  try {
    const { takeNavWarm } = await import('../lib/nav-panel-prefetch.js')
    let agents = takeNavWarm('proactive:agents')
    if (!agents) {
      agents = await api.listAgents()
    }
    const map = new Map()
    for (const a of agents || []) {
      const code = String(a?.agent_code || a?.name || '').trim().toLowerCase()
      if (code) map.set(code, a)
    }
    _agentsByCode = map
  } catch {
    /* keep previous index */
  }
}

function _avatarSizeForEl(el, fallback = 44) {
  const raw = parseInt(String(el.getAttribute('data-avatar-size') || ''), 10)
  if (raw > 0) return raw
  if (el.classList.contains('dd-org-avatar--lg')) return 56
  if (el.classList.contains('dd-org-avatar--sm')) return 28
  if (el.closest('.dd-org-mini')) return 40
  if (el.classList.contains('dd-org-avatar')) return 28
  if (el.classList.contains('pro-role-avatar')) return fallback
  return fallback
}

function mountProactiveAvatars(root, defaultSize = 44) {
  if (!root) return
  void gatewayBaseForAvatars().then(async (baseUrl) => {
    await refreshAgentsAvatarIndex()
    root.querySelectorAll('[data-avatar-agent]').forEach((el) => {
      const code = String(el.getAttribute('data-avatar-agent') || '').trim()
      if (!code) return
      const size = _avatarSizeForEl(el, defaultSize)
      const agent = _agentsByCode.get(code.toLowerCase()) || { agent_code: code }
      mountAgentAvatar(el, { agent, agentCode: code, size, baseUrl })
    })
  })
}

const RISK_BADGE = {
  low:      { label: '低风险', cls: 'pro-risk--low' },
  medium:   { label: '中风险', cls: 'pro-risk--med' },
  high:     { label: '高风险', cls: 'pro-risk--high' },
  critical: { label: '极高',   cls: 'pro-risk--crit' },
}

const ROLE_STATUS_LABEL = {
  active: '在岗',
  paused: '已停',
  archived: '已停',
  draft: '已停',
}

/** @type {boolean | null} global auto-duty engine; null = unknown */
let _engineRunning = null

let _refreshTimer = null
let _busyPollTimer = null
let _currentTab = 'roles' // roles | approvals | health | archived | org
/** Org tab UI state (DingTalk-style master-detail). */
let _orgUi = {
  forest: [],
  flat: [],
  selected: '',
  /** @type {Set<string>} */
  expanded: new Set(['__root__']),
}
/** True when URL explicitly picked a tab / highlight (don't auto-steal focus). */
let _tabPinnedByHash = false
let _archivedRolesData = []
let _rolesPage = 1
let _rolesPageSize = readStoredPageSize(ROLES_PAGE_SIZE_KEY)
let _archivedPage = 1
let _archivedPageSize = readStoredPageSize(ARCHIVED_PAGE_SIZE_KEY)

function readProactiveHashQuery() {
  const raw = String(window.location.hash || '').replace(/^#/, '')
  const q = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : ''
  try {
    return new URLSearchParams(q)
  } catch {
    return new URLSearchParams()
  }
}

let _highlightApprovalId = ''
let _highlightInitiativeId = ''

function applyProactiveHashQuery() {
  const qs = readProactiveHashQuery()
  const tab = String(qs.get('tab') || '').trim()
  _tabPinnedByHash = false
  if (tab === 'approvals' || tab === 'roles' || tab === 'health' || tab === 'archived') {
    _currentTab = tab
    _tabPinnedByHash = true
  }
  _highlightApprovalId = String(qs.get('highlight') || '').trim()
  _highlightInitiativeId = String(qs.get('highlight_init') || '').trim()
  if (_highlightApprovalId || _highlightInitiativeId) {
    _currentTab = 'approvals'
    _tabPinnedByHash = true
  }
}

const CHANNEL_LABEL = {
  desktop: '桌面通知',
  feishu: '飞书',
}

const ACTION_TYPE_LABEL = {
  code_change: '代码变更',
  analysis: '分析',
  report: '报告',
  task_delegation: '任务委派',
  alert: '告警',
  optimization: '优化',
}

function sanitizeRoleLabel(value, fallback = '') {
  const text = String(value ?? '').trim()
  if (!text || /^(none|null|undefined)$/i.test(text)) return fallback
  return text
}

function roleDisplayName(code) {
  const c = String(code || '')
  const role = _rolesData.find((r) => String(r.agent_code) === c)
  return roleCardTitle(role || { agent_code: c }) || c || '—'
}

function roleCardTitle(role) {
  const code = sanitizeRoleLabel(role?.agent_code, '')
  const roleName = sanitizeRoleLabel(role?.role_name, '')
  // 只显示岗位名；禁止 agent_name / 英文 agent_code
  if (roleName && roleName !== code) return roleName
  return '未命名岗位'
}

function roleDutyFallback(role) {
  const dept = sanitizeRoleLabel(role?.department || role?.config?.department, '')
  if (dept) return `<p class="pro-role-duty">${esc(dept)}</p>`
  const desc = sanitizeRoleLabel(
    role?.config?.extra_context?.agent_description || role?.agent_description,
    '',
  )
  if (desc) return `<p class="pro-role-duty">${esc(previewLine(desc, 72))}</p>`
  return `<p class="pro-role-duty pro-role-duty--empty" aria-hidden="true">—</p>`
}

function approvalAgeMinutes(iso) {
  if (!iso) return 0
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 0
  return Math.max(0, (Date.now() - t) / 60000)
}

function approvalUrgency(appr) {
  const age = approvalAgeMinutes(appr.created_at)
  const limit = Math.max(5, Number(appr.approval_timeout_minutes) || 30)
  const ratio = age / limit
  if (ratio >= 1) return { key: 'overdue', label: '已超时', cls: 'pro-urgency--overdue' }
  if (ratio >= 0.5 || Number(appr.escalation_level) > 0) {
    return { key: 'soon', label: '即将超时', cls: 'pro-urgency--soon' }
  }
  return { key: 'ok', label: '', cls: '' }
}

// ── page shell ────────────────────────────────────────────

export async function render() {
  applyProactiveHashQuery()
  const page = document.createElement('div')
  page.className = 'page proactive-page'
  page.innerHTML = `
    <div class="pro-hero">
      <div class="pro-hero-main">
        <p class="pro-hero-kicker">数字员工</p>
        <h1 class="page-title">智能体员工</h1>
        <p class="page-desc">有事项等你拍板时优先处理；员工近况看「员工」，进度全貌看「工作项」</p>
      </div>
      <div class="page-actions">
        <div class="pro-feishu-toolbar" id="pro-feishu-toolbar" hidden>
          <span class="pro-feishu-toolbar-label" id="pro-feishu-toolbar-label" title=""></span>
          <button type="button" class="btn btn-sm btn-primary" id="pro-feishu-bind-next">扫码绑定</button>
        </div>
        <button type="button" class="btn btn-primary btn-sm" id="pro-hire">雇佣员工</button>
        <button type="button" class="btn btn-secondary btn-sm" id="pro-refresh">刷新</button>
      </div>
    </div>

    <div class="pro-duty-card" id="pro-switch-card">
      <div class="pro-duty-left">
        <div class="pro-duty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
          </svg>
        </div>
        <div class="pro-switch-info">
          <div class="pro-switch-status">
            <span class="pro-switch-dot" id="pro-switch-dot"></span>
            <span id="pro-switch-text">加载中…</span>
          </div>
          <div class="pro-switch-meta" id="pro-switch-meta"></div>
        </div>
      </div>
      <button type="button" class="btn btn-sm" id="pro-switch-btn" disabled>—</button>
    </div>

    <div class="pro-decide-strip" id="pro-decide-strip" hidden></div>

    <div class="pro-tabs" role="tablist" aria-label="智能体员工">
      <button type="button" class="pro-tab ${_currentTab === 'approvals' ? 'pro-tab--active' : ''}" data-tab="approvals" role="tab">
        待审批 <span class="pro-tab-count" id="pro-tab-count-apprs"></span>
      </button>
      <button type="button" class="pro-tab ${_currentTab === 'roles' ? 'pro-tab--active' : ''}" data-tab="roles" role="tab">
        员工 <span class="pro-tab-count" id="pro-tab-count-roles"></span>
      </button>
      <button type="button" class="pro-tab" data-tab="board" role="tab" title="按状态看全员岗位工作项">
        工作项
      </button>
      <button type="button" class="pro-tab ${_currentTab === 'org' ? 'pro-tab--active' : ''}" data-tab="org" role="tab">
        组织架构
      </button>
      <button type="button" class="pro-tab ${_currentTab === 'health' ? 'pro-tab--active' : ''}" data-tab="health" role="tab">
        健康
      </button>
      <button type="button" class="pro-tab ${_currentTab === 'archived' ? 'pro-tab--active' : ''}" data-tab="archived" role="tab">
        归档 <span class="pro-tab-count" id="pro-tab-count-archived"></span>
      </button>
    </div>

    <div class="pro-tab-content" id="pro-tab-content">
      <div class="pro-loading">加载中…</div>
    </div>
  `

  bindHeader(page)
  // Return shell immediately (tab shows「加载中」); data fills in — don't block router paint.
  void loadAll(page).then(() => {
    try {
      if (sessionStorage.getItem('evopanel_pending_hire') === '1') {
        sessionStorage.removeItem('evopanel_pending_hire')
        void showHireModal(page)
      }
    } catch {
      /* ignore */
    }
  })
  // 小V 右侧栏写操作后：实时刷新员工列表
  void import('../lib/page-live-refresh.js').then(({ subscribePageLiveRefresh }) => {
    const unsub = subscribePageLiveRefresh(
      () => {
        void loadAll(page)
      },
      { domains: ['employees', 'agents', 'approvals'] },
    )
    page._xmLiveUnsub = unsub
  })
  return page
}

function bindHeader(page) {
  page.querySelector('#pro-refresh')?.addEventListener('click', () => loadAll(page))
  page.querySelector('#pro-hire')?.addEventListener('click', () => void showHireModal(page))
  page.querySelector('#pro-feishu-bind-next')?.addEventListener('click', () => {
    const btn = page.querySelector('#pro-feishu-bind-next')
    const code = String(btn?.dataset?.code || '').trim()
    const name = String(btn?.dataset?.name || code).trim()
    if (!code) return
    void startFeishuEmployeeScan(code, {
      roleName: name,
      onBound: () => {
        void loadAll(page)
      },
    })
  })
  page.querySelectorAll('.pro-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      // 「工作项」是全员看板页，不占本页 tab 内容区
      if (tab.dataset.tab === 'board') {
        navigate('/proactive/board')
        return
      }
      _currentTab = tab.dataset.tab
      _tabPinnedByHash = true // user explicit choice for this session
      page.querySelectorAll('.pro-tab').forEach(t => t.classList.toggle('pro-tab--active', t === tab))
      updateDecideStrip(page)
      if (_currentTab === 'health' && !_dashboardData) {
        page.querySelector('#pro-tab-content').innerHTML = `<div class="pro-loading">加载健康数据…</div>`
        void api
          .proactiveDashboard()
          .then((dashRes) => {
            _dashboardData = dashRes && dashRes.ok !== false ? dashRes : null
            if (page.isConnected && _currentTab === 'health') renderTabContent(page)
          })
          .catch(() => {
            _dashboardData = null
            if (page.isConnected && _currentTab === 'health') renderTabContent(page)
          })
        return
      }
      renderTabContent(page)
    })
  })
}

const AUTONOMY_HINTS = {
  full_auto:
    '有下游交工时：仅「极高风险」须你点「同意派发」；其余自动叫醒下级。新开任务默认直接跑。',
  approval_for_risky:
    '有下游交工时：中风险及以上须你点「同意派发」；低风险自动派。新开任务默认直接跑。',
  approval_for_all:
    '有下游交工时：几乎都要你点「同意派发」才叫醒下级。单岗无下游时通常碰不到此闸。',
}

function parseLines(text) {
  return String(text || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

function renderHireDdOptions(items, selectedValue) {
  return items
    .map((it) => {
      const value = String(it.value || '')
      const name = String(it.name || value)
      const sub = String(it.sub || '')
      const on = value === selectedValue
      return `
        <li role="option" class="hire-dd-option${on ? ' is-on' : ''}" data-value="${esc(value)}" data-name="${esc(name)}" aria-selected="${on ? 'true' : 'false'}">
          <span class="hire-dd-option-name">${esc(name)}</span>
          ${sub ? `<span class="hire-dd-option-path">${esc(sub)}</span>` : ''}
        </li>`
    })
    .join('')
}

function bindHireDropdown(overlay, { role, onPick, labelFor } = {}) {
  const dd = overlay.querySelector(`[data-role="${role}"]`)
  if (!dd) return
  const trigger = dd.querySelector('[data-act="dd-toggle"]')
  const menu = dd.querySelector('.hire-dd-menu')
  const hidden = dd.querySelector('input[type="hidden"]')
  const labelEl = dd.querySelector('[data-role="dd-label"]')
  if (!trigger || !menu || !hidden) return

  const close = () => {
    menu.hidden = true
    dd.classList.remove('is-open')
    menu.classList.remove('is-fixed')
    trigger.setAttribute('aria-expanded', 'false')
  }
  const open = () => {
    const r = trigger.getBoundingClientRect()
    menu.style.top = `${Math.round(r.bottom + 6)}px`
    menu.style.left = `${Math.round(r.left)}px`
    menu.style.width = `${Math.round(r.width)}px`
    menu.classList.add('is-fixed')
    menu.hidden = false
    dd.classList.add('is-open')
    trigger.setAttribute('aria-expanded', 'true')
  }
  const pick = (opt) => {
    const value = opt?.dataset.value || ''
    const name = opt?.dataset.name || value
    hidden.value = value
    if (labelEl) labelEl.textContent = typeof labelFor === 'function' ? labelFor(value, name) : name
    menu.querySelectorAll('.hire-dd-option').forEach((el) => {
      const on = el.dataset.value === value
      el.classList.toggle('is-on', on)
      el.setAttribute('aria-selected', on ? 'true' : 'false')
    })
    close()
    if (typeof onPick === 'function') onPick(value, name, opt)
  }

  trigger.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (menu.hidden) open()
    else close()
  })
  menu.addEventListener('click', (e) => {
    const opt = e.target.closest('.hire-dd-option')
    if (!opt) return
    e.preventDefault()
    pick(opt)
  })
  overlay.addEventListener('click', (e) => {
    if (!dd.contains(e.target)) close()
  })
}

async function loadChatModels() {
  try {
    const data = await api.listModels()
    const rows = Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : []
    const seen = new Set()
    const out = []
    for (const m of filterChatModels(rows)) {
      const name = String(m?.name || '').trim()
      if (!name || seen.has(name)) continue
      seen.add(name)
      const display = String(m?.display_name || name).trim() || name
      out.push({ name, display })
    }
    return out
  } catch {
    return []
  }
}

function renderModelField(models, selected = '') {
  const cur = String(selected || '').trim()
  const items = [
    { value: '', name: '跟随智能体默认', sub: '未配置时用 agent / 系统默认模型' },
    ...models.map((m) => ({
      value: m.name,
      name: m.display || m.name,
      sub: m.display && m.display !== m.name ? m.name : '',
    })),
  ]
  if (cur && !items.some((i) => i.value === cur)) {
    items.splice(1, 0, { value: cur, name: cur, sub: '当前配置（未在模型列表中）' })
  }
  const picked = items.find((i) => i.value === cur) || items[0]
  const label = picked?.name || '跟随智能体默认'
  return `
    <div class="hire-field">
      <span>工作 / 执行模型</span>
      <div class="hire-dd" data-role="model-dd">
        <button type="button" class="hire-dd-trigger" data-act="dd-toggle" aria-haspopup="listbox" aria-expanded="false">
          <span class="hire-dd-label" data-role="dd-label">${esc(label)}</span>
          <span class="hire-dd-chevron" aria-hidden="true"></span>
        </button>
        <ul class="hire-dd-menu" role="listbox" hidden>
          ${renderHireDdOptions(items, cur)}
        </ul>
        <input type="hidden" data-name="model_name" value="${esc(cur)}">
      </div>
      <p class="hire-chip-hint">仅作用于该岗位的自动上班与执行；留空则跟随绑定智能体的默认模型</p>
    </div>`
}

function bindModelSelect(overlay) {
  bindHireDropdown(overlay, { role: 'model-dd' })
}

function readModelName(overlay) {
  return (overlay.querySelector('input[data-name="model_name"]')?.value || '').trim()
}

function renderAgentPickField(available, selectedCode) {
  const cur = available.find((a) => a.code === selectedCode) || available[0]
  const value = cur?.code || ''
  const label = cur?.name && cur.name !== cur.code ? cur.name : value
  const items = available.map((a) => ({
    value: a.code,
    name: a.name && a.name !== a.code ? a.name : a.code,
    sub: a.code,
  }))
  return `
    <div class="hire-field">
      <span>选择智能体</span>
      <div class="hire-dd" data-role="agent-dd">
        <button type="button" class="hire-dd-trigger" data-act="dd-toggle" aria-haspopup="listbox" aria-expanded="false">
          <span class="hire-dd-label" data-role="dd-label">${esc(label || '请选择智能体')}</span>
          <span class="hire-dd-chevron" aria-hidden="true"></span>
        </button>
        <ul class="hire-dd-menu" role="listbox" hidden>
          ${renderHireDdOptions(items, value)}
        </ul>
        <input type="hidden" data-name="agent_code" value="${esc(value)}">
      </div>
    </div>`
}

function bindHireChipRows(overlay) {
  overlay.querySelectorAll('.hire-chip-row[data-name]').forEach((row) => {
    row.addEventListener('click', (e) => {
      const chip = e.target.closest('.hire-chip')
      if (!chip) return
      row.querySelectorAll('.hire-chip').forEach((c) => c.classList.toggle('is-on', c === chip))
      if (row.dataset.name === 'autonomy_level') {
        const hint = overlay.querySelector('[data-autonomy-hint]')
        if (hint) hint.textContent = AUTONOMY_HINTS[chip.dataset.value] || ''
      }
    })
  })
}

async function loadHireableAgents() {
  const hired = new Set(_rolesData.map((r) => String(r.agent_code || '').trim()).filter(Boolean))
  let agents
  try {
    agents = await api.listAgents()
  } catch (e) {
    toast('加载智能体列表失败: ' + (e?.message || e), 'error')
    return []
  }
  return (agents || [])
    .map((a) => ({
      code: String(a.agent_code || a.name || '').trim(),
      name: String(a.agent_name || a.name || a.agent_code || '').trim(),
      description: String(a.description || '').trim(),
      model: String(a.model || '').trim(),
      avatar: a.avatar || null,
      avatar_meta: a.avatar_meta || null,
      has_avatar_file: a.has_avatar_file,
      agent_code: String(a.agent_code || a.name || '').trim(),
      agent_name: String(a.agent_name || a.name || a.agent_code || '').trim(),
    }))
    .filter((a) => a.code && !hired.has(a.code))
}

async function showHireModal(page) {
  const available = await loadHireableAgents()
  if (!available.length) {
    const hasAgents = _rolesData.length > 0
    toast(
      hasAgents
        ? '所有智能体都已雇佣。请先到「智能体」页新建智能体，再回来雇佣。'
        : '还没有可雇佣的智能体。请先到「智能体」页创建智能体，再回来雇佣员工。',
      'warning',
    )
    return
  }

  const [workspacePaths, chatModels, knowledgeVaults] = await Promise.all([
    loadWorkspacePaths(),
    loadChatModels(),
    loadKnowledgeVaults(),
  ])
  if (!chatModels.length) {
    const go = await showConfirm(
      '还没有可用的对话模型。请先到「模型」页配置，否则员工无法执行。\n\n现在去配置模型？',
    )
    if (go) {
      navigate('/models')
      return
    }
    toast('未配置模型时可以先保存草稿，确认上班前请先配好模型', 'warning')
  }
  let selected = available[0]
  const hireScheduleCtrl = createSchedulePanel({
    schedule: '0 9-19/2 * * *',
    idPrefix: 'hireSched',
    compact: true,
  })
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay hire-overlay'

  const renderAgentCard = () => {
    return `
      <div class="hire-agent-card" data-role="agent-card">
        <div class="hire-agent-avatar" data-avatar-agent="${esc(selected.code)}" aria-hidden="true"></div>
        <div class="hire-agent-meta">
          <div class="hire-agent-name">${esc(selected.name || selected.code)}</div>
          <div class="hire-agent-code">${esc(selected.code)}</div>
        </div>
        <span class="hire-agent-pill">将加定时岗位</span>
      </div>`
  }

  const templateChips = HIRE_TEMPLATES.map(
    (t) =>
      `<button type="button" class="hire-chip hire-template-chip" data-template="${esc(t.id)}" title="${esc(t.blurb)}">${esc(t.label)}</button>`,
  ).join('')

  overlay.innerHTML = `
    <div class="hire-sheet" role="dialog" aria-labelledby="hire-sheet-title">
      <header class="hire-sheet-head">
        <div>
          <p class="hire-sheet-kicker">智能体员工</p>
          <h2 id="hire-sheet-title" class="hire-sheet-title">雇佣员工</h2>
        </div>
        <button type="button" class="hire-sheet-close" data-act="close" aria-label="关闭">&times;</button>
      </header>

      <div class="hire-sheet-body" style="padding-top:12px">
        <p class="hire-chip-hint">两步即可：选人 → 写职责。工作空间可选，不选则用默认。</p>
        <div class="hire-field">
          <span>从模板开始（可选）</span>
          <div class="hire-chip-row hire-template-row" data-role="hire-templates">
            ${templateChips}
            <button type="button" class="hire-chip hire-template-chip" data-template="" title="清空模板预填，自行填写">自定义</button>
          </div>
          <p class="hire-chip-hint" data-role="template-hint">点模板会预填岗位名、职责、审批策略与上班频率，仍可再改。</p>
        </div>
        ${renderAgentPickField(available, selected.code)}
        ${renderAgentCard()}

        <label class="hire-field">
          <span>岗位名称</span>
          <input class="hire-input" data-name="role_name" value="" placeholder="岗位显示名，例如：前端架构负责人">
        </label>

        <label class="hire-field">
          <span>职责</span>
          <textarea class="hire-input hire-textarea" data-name="responsibilities" rows="3" placeholder="每行一条，写清要主动推进的事，例如：&#10;盯紧 evopanel 前端质量与构建&#10;发现可修问题就提出事项并跟进"></textarea>
        </label>

        ${renderKnowledgeVaultField(knowledgeVaults, [])}

        <details class="hire-advanced">
          <summary>更多设置（工作空间 / 部门 / 转交审批策略 / 节奏 / 模型）</summary>
          <div class="hire-advanced-body">
            ${renderWorkspaceField(workspacePaths, '', '')}
            <label class="hire-field">
              <span>部门</span>
              <input class="hire-input" data-name="department" value="" placeholder="可选">
            </label>
            <label class="hire-field">
              <span>直属上级（可选）</span>
              <select class="hire-input" data-name="reports_to">
                <option value="">（无上级 · 顶层）</option>
                ${(_rolesData || [])
                  .filter((r) => String(r.agent_code || '').trim())
                  .map((r) => {
                    const c = String(r.agent_code || '').trim()
                    const n = String(r.role_name || c).trim()
                    return `<option value="${esc(c)}">${esc(n)} · ${esc(c)}</option>`
                  })
                  .join('')}
              </select>
              <p class="hire-chip-hint">也可稍后在「组织架构」页拖调上下级</p>
            </label>
            ${renderModelField(chatModels, '')}
            <div class="hire-field">
              <span>转交审批策略</span>
              <div class="hire-chip-row" data-name="autonomy_level" role="radiogroup">
                <button type="button" class="hire-chip" data-value="full_auto">全自动</button>
                <button type="button" class="hire-chip" data-value="approval_for_risky">平衡型</button>
                <button type="button" class="hire-chip is-on" data-value="approval_for_all">谨慎型</button>
              </div>
              <p class="hire-chip-hint" data-autonomy-hint>${AUTONOMY_HINTS.approval_for_all}</p>
            </div>
            <div class="hire-field">
              <span>自动上班</span>
              ${hireScheduleCtrl.html}
              <p class="hire-chip-hint">与「自动化」任务同一套调度；手动「现在开始工作」不受限制。</p>
            </div>
          </div>
        </details>
      </div>

      <footer class="hire-sheet-foot">
        <button type="button" class="btn btn-secondary btn-sm" data-act="close">取消</button>
        <button type="button" class="btn btn-ghost btn-sm" data-act="draft">保存草稿</button>
        <button type="button" class="btn btn-sm hire-confirm" data-act="confirm">确认上班</button>
      </footer>
    </div>
  `
  document.body.appendChild(overlay)
  // Hireable rows already carry avatar fields; seed index for mount.
  for (const a of available) {
    if (a.code) _agentsByCode.set(String(a.code).toLowerCase(), a)
  }
  mountProactiveAvatars(overlay, 48)

  const close = () => overlay.remove()
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })
  overlay.querySelectorAll('[data-act="close"]').forEach((el) => el.addEventListener('click', close))

  const nameEl = overlay.querySelector('[data-name="role_name"]')
  const respEl = overlay.querySelector('[data-name="responsibilities"]')
  const domainEl = overlay.querySelector('[data-name="domain_scope"]')
  const templateHint = overlay.querySelector('[data-role="template-hint"]')
  let lastPrefill = nameEl?.value || ''

  const setAutonomyChip = (value) => {
    const row = overlay.querySelector('[data-name="autonomy_level"]')
    if (!row) return
    row.querySelectorAll('.hire-chip').forEach((c) => {
      c.classList.toggle('is-on', c.dataset.value === value)
    })
    const hint = overlay.querySelector('[data-autonomy-hint]')
    if (hint) hint.textContent = AUTONOMY_HINTS[value] || ''
  }
  const setHireSchedule = (cronExpr) => {
    hireScheduleCtrl.setSchedule(cronExpr || '0 9-19/2 * * *')
  }

  const applyHireTemplate = (id) => {
    overlay.querySelectorAll('[data-role="hire-templates"] .hire-template-chip').forEach((c) => {
      c.classList.toggle('is-on', (c.dataset.template || '') === String(id || ''))
    })
    if (!id) {
      if (templateHint) templateHint.textContent = '已切回自定义，请自行填写职责。'
      return
    }
    const tpl = hireTemplateById(id)
    if (!tpl) return
    if (nameEl) {
      nameEl.value = tpl.role_name
      lastPrefill = tpl.role_name
    }
    if (respEl) respEl.value = (tpl.responsibilities || []).join('\n')
    if (domainEl && Array.isArray(tpl.domain_scope)) {
      domainEl.value = tpl.domain_scope.join('\n')
    }
    setAutonomyChip(tpl.autonomy_level || 'approval_for_all')
    setHireSchedule(tpl.heartbeat_schedule || tpl.heartbeat_rrule || '0 9-19/2 * * *')
    const adv = overlay.querySelector('details.hire-advanced')
    if (adv) adv.open = true
    if (templateHint) templateHint.textContent = `已套用「${tpl.label}」：${tpl.blurb}`
  }

  overlay.querySelector('[data-role="hire-templates"]')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-template]')
    if (!btn) return
    applyHireTemplate(btn.getAttribute('data-template') || '')
  })

  const syncAgentCard = () => {
    const card = overlay.querySelector('[data-role="agent-card"]')
    if (!card) return
    const wrap = document.createElement('div')
    wrap.innerHTML = renderAgentCard().trim()
    card.replaceWith(wrap.firstElementChild)
    mountProactiveAvatars(overlay, 48)
    if (nameEl && (!nameEl.value.trim() || nameEl.value === lastPrefill)) {
      // 换人时不要用智能体名/英文 code 冒充岗位名；模板预填的岗位名可保留
      if (nameEl.value === lastPrefill && lastPrefill) {
        /* keep template title */
      } else if (!nameEl.value.trim()) {
        nameEl.value = ''
        lastPrefill = ''
      }
    }
  }

  bindHireDropdown(overlay, {
    role: 'agent-dd',
    onPick: (code) => {
      const next = available.find((a) => a.code === code)
      if (!next) return
      selected = next
      syncAgentCard()
    },
  })
  bindHireChipRows(overlay)
  bindModelSelect(overlay)
  bindWorkspaceSelect(overlay)
  hireScheduleCtrl.initEvents()

  const submitHire = async (status) => {
    if (status === 'active' && !chatModels.length) {
      const go = await showConfirm(
        '当前没有可用对话模型，确认上班后员工无法执行。\n\n先去「模型」页配置？',
      )
      if (go) {
        close()
        navigate('/models')
      }
      return
    }
    const agent_code =
      (overlay.querySelector('input[data-name="agent_code"]')?.value || '').trim() || selected.code
    const role_name = (nameEl?.value || '').trim()
    if (!role_name || role_name === agent_code) {
      toast('请填写岗位名称（不要用智能体名或英文编码）', 'warning')
      nameEl?.focus()
      return
    }
    const department = (overlay.querySelector('[data-name="department"]')?.value || '').trim()
    const reports_to = (overlay.querySelector('[data-name="reports_to"]')?.value || '').trim()
    const responsibilities = parseLines(overlay.querySelector('[data-name="responsibilities"]')?.value)
    const workspace_path = readWorkspacePath(overlay)
    const domain_scope = parseLines(overlay.querySelector('[data-name="domain_scope"]')?.value)
    const model_name = readModelName(overlay)
    if (status === 'active' && !responsibilities.length) {
      toast('请填写至少一条职责，或先选上方模板预填', 'warning')
      return
    }
    const autonomy_level =
      overlay.querySelector('[data-name="autonomy_level"] .hire-chip.is-on')?.dataset.value ||
      'approval_for_all'
    const heartbeat_schedule =
      hireScheduleCtrl.getSchedule().cronExpr || '0 9-19/2 * * *'

    const confirmBtn = overlay.querySelector('[data-act="confirm"]')
    const draftBtn = overlay.querySelector('[data-act="draft"]')
    const busyLabel = status === 'draft' ? '保存中…' : '处理中…'
    ;[confirmBtn, draftBtn].forEach((b) => {
      if (b) b.disabled = true
    })
    if (status === 'draft' && draftBtn) draftBtn.textContent = busyLabel
    if (status === 'active' && confirmBtn) confirmBtn.textContent = busyLabel
    try {
      if (status === 'active') {
        const overlap = await api.proactiveCheckOverlap({
          agent_code,
          responsibilities,
          domain_scope,
          role_name,
        }).catch(() => null)
        if (overlap?.has_overlap && overlap.warning) {
          const cont = await showConfirm(`${overlap.warning}\n\n仍要继续雇佣？`)
          if (!cont) {
            ;[confirmBtn, draftBtn].forEach((b) => {
              if (b) b.disabled = false
            })
            if (confirmBtn) confirmBtn.textContent = '确认上班'
            if (draftBtn) draftBtn.textContent = '保存草稿'
            return
          }
        }
      }
      await api.proactiveCreateRole({
        role_name,
        agent_code,
        department,
        reports_to,
        responsibilities,
        workspace_path,
        domain_scope,
        knowledge_vault_ids: readKnowledgeVaultIds(overlay),
        autonomy_level,
        heartbeat_schedule,
        approval_channels: ['desktop', 'feishu'],
        think_mode: 'agent_loop',
        model_name,
        status,
        approval_timeout_by_type: {
          analysis: 120,
          report: 120,
          code_change: 1440,
          optimization: 1440,
          alert: 60,
          task_delegation: 240,
        },
      })
      toast(status === 'draft' ? `已保存草稿「${role_name}」` : `已雇佣「${role_name}」`, 'success')
      close()
      _currentTab = 'roles'
      _tabPinnedByHash = true
      page.querySelectorAll('.pro-tab').forEach((t) =>
        t.classList.toggle('pro-tab--active', t.dataset.tab === 'roles'),
      )
      await loadAll(page)
    } catch (e) {
      toast((status === 'draft' ? '保存草稿失败: ' : '雇佣失败: ') + (e?.message || e), 'error')
      ;[confirmBtn, draftBtn].forEach((b) => {
        if (b) b.disabled = false
      })
      if (confirmBtn) confirmBtn.textContent = '确认上班'
      if (draftBtn) draftBtn.textContent = '保存草稿'
    }
  }

  overlay.querySelector('[data-act="confirm"]')?.addEventListener('click', () => void submitHire('active'))
  overlay.querySelector('[data-act="draft"]')?.addEventListener('click', () => void submitHire('draft'))

  nameEl?.focus()
}

async function showEditRoleModal(page, role) {
  if (!role) return
  await openEditRoleModal(role, { onSaved: () => loadAll(page) })
}

// ── dispatch task modal ───────────────────────────────────

async function showDispatchModal(page, role) {
  if (!role) return
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay hire-overlay'
  overlay.innerHTML = `
    <div class="hire-sheet" role="dialog" aria-labelledby="dispatch-title">
      <header class="hire-sheet-head">
        <div>
          <p class="hire-sheet-kicker">派发任务</p>
          <h2 id="dispatch-title" class="hire-sheet-title">派发给「${esc(role.role_name || role.agent_code)}」</h2>
        </div>
        <button type="button" class="hire-sheet-close" data-act="close" aria-label="关闭">&times;</button>
      </header>

      <div class="hire-agent-card">
        <div class="hire-agent-avatar" data-avatar-agent="${esc(role.agent_code)}" aria-hidden="true"></div>
        <div class="hire-agent-meta">
          <div class="hire-agent-name">${esc(role.role_name || role.agent_code)}</div>
          <div class="hire-agent-code">${esc(role.agent_code)}</div>
        </div>
        <span class="hire-agent-pill">员工将围绕任务工作</span>
      </div>

      <div class="hire-sheet-body">
        <p class="hire-chip-hint">描述要派发的任务目标，员工会立即开始处理并记录工作结果。</p>
        <label class="hire-field">
          <span>任务目标</span>
          <textarea class="hire-input hire-textarea" data-name="goal" rows="4" placeholder="例如：检查 login 页面的 console 报错并修复；或：分析 src/components 下未做懒加载的组件"></textarea>
        </label>
        <label class="hire-field">
          <span>补充说明（可选）</span>
          <textarea class="hire-input hire-textarea" data-name="description" rows="2" placeholder="额外上下文、约束或期望结果"></textarea>
        </label>
        <div class="hire-field">
          <span>优先级</span>
          <div class="hire-chip-row" data-name="priority" role="radiogroup">
            <button type="button" class="hire-chip" data-value="low">低</button>
            <button type="button" class="hire-chip is-on" data-value="normal">普通</button>
            <button type="button" class="hire-chip" data-value="high">高</button>
            <button type="button" class="hire-chip" data-value="urgent">紧急</button>
          </div>
        </div>
      </div>

      <footer class="hire-sheet-foot">
        <button type="button" class="btn btn-secondary btn-sm" data-act="close">取消</button>
        <button type="button" class="btn btn-sm hire-confirm" data-act="confirm">派发任务</button>
      </footer>
    </div>
  `
  document.body.appendChild(overlay)
  mountProactiveAvatars(overlay, 48)

  const close = () => overlay.remove()
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
  overlay.querySelectorAll('[data-act="close"]').forEach((el) => el.addEventListener('click', close))
  bindHireChipRows(overlay)

  overlay.querySelector('[data-act="confirm"]')?.addEventListener('click', async () => {
    const goal = (overlay.querySelector('[data-name="goal"]')?.value || '').trim()
    if (!goal) {
      toast('请填写任务目标', 'warning')
      return
    }
    const description = (overlay.querySelector('[data-name="description"]')?.value || '').trim()
    const priority = overlay.querySelector('[data-name="priority"] .hire-chip.is-on')?.dataset.value || 'normal'
    const btn = overlay.querySelector('[data-act="confirm"]')
    if (btn) { btn.disabled = true; btn.textContent = '派发中…' }
    try {
      await api.proactiveDispatchTask(role.agent_code, { goal, description, priority, source: 'employee_page' })
      toast(`已派发给「${role.role_name || role.agent_code}」，正在打开工作过程`, 'success')
      close()
      navigate(
        `/proactive/${encodeURIComponent(role.agent_code)}?live=1&goal=${encodeURIComponent(goal.slice(0, 120))}`,
      )
    } catch (e) {
      const msg = String(e?.message || e || '')
      if (/already running|正在巡检|正在工作|busy|执行任务/i.test(msg)) {
        toast(msg || `「${role.role_name || role.agent_code}」正在执行任务`, 'warning')
        close()
        navigate(`/proactive/${encodeURIComponent(role.agent_code)}?live=1`)
      } else {
        toast(`派发失败: ${msg}`, 'error')
      }
      if (btn) { btn.disabled = false; btn.textContent = '派发任务' }
    }
  })

  overlay.querySelector('[data-name="goal"]')?.focus()
}

// ── data loading ──────────────────────────────────────────

async function loadAll(page) {
  // Status + roster in parallel; re-render once so busy badges match status.
  await Promise.all([loadStatus(page), loadTabData(page)])
  if (page.isConnected) renderTabContent(page)
  if (_refreshTimer) clearInterval(_refreshTimer)
  if (_busyPollTimer) clearInterval(_busyPollTimer)
  // Pending approvals: poll faster so the duty desk stays responsive
  const intervalMs = (_approvalsData?.length || 0) > 0 ? 15000 : 60000
  _refreshTimer = setInterval(() => {
    if (!page.isConnected) {
      clearInterval(_refreshTimer)
      _refreshTimer = null
      return
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    const expandedDetail = page.querySelector('.pro-initiative-detail[style*="display: block"]')
    if (expandedDetail) return
    if (_rosterLiveMount?.isOpen?.()) {
      void loadStatus(page)
      return
    }
    void Promise.all([loadStatus(page), loadTabData(page)]).then(() => {
      if (page.isConnected) renderTabContent(page)
    })
  }, intervalMs)
  // Busy/running badge must stay fresh even when full tab refresh is slow
  _busyPollTimer = setInterval(() => {
    if (!page.isConnected) {
      clearInterval(_busyPollTimer)
      _busyPollTimer = null
      return
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    void loadStatus(page)
  }, 12_000)
}

async function loadStatus(page) {
  const card = page.querySelector('#pro-switch-card')
  const dot = page.querySelector('#pro-switch-dot')
  const text = page.querySelector('#pro-switch-text')
  const meta = page.querySelector('#pro-switch-meta')
  const btn = page.querySelector('#pro-switch-btn')

  try {
    let st = null
    try {
      const { takeNavWarm } = await import('../lib/nav-panel-prefetch.js')
      st = takeNavWarm('proactive:status')
      if (!st) {
        st = await api.proactiveStatus()
      }
    } catch {
      st = await api.proactiveStatus()
    }
    const running = st.running
    _engineRunning = !!running
    syncBusyCodes(st)
    // Keep open live panel status in sync without remounting
    const liveCode = _rosterLiveMount?.currentCode?.() || ''
    if (liveCode) {
      const isBusy = _busyCodes.has(liveCode)
      if (isBusy && typeof _rosterLiveMount.update === 'function') {
        void api
          .proactiveRoleBusy(liveCode)
          .then((bst) => {
            if (_rosterLiveMount?.currentCode?.() !== liveCode) return
            const liveRid = String(bst?.current_round_id || '').trim()
            const openRid = String(_rosterLiveMount.currentRoundId?.() || '').trim()
            if (liveRid && liveRid !== openRid) {
              const at = String(bst?.started_at || liveRid).trim()
              const clock = _fmtTrailClock(at)
              _rosterLiveMount.update({
                busy: true,
                roundId: liveRid,
                title: clock ? `${clock} · 工作过程 · 工作中` : '工作过程 · 工作中',
              })
            } else {
              _rosterLiveMount.setBusy(!!bst?.busy)
            }
          })
          .catch(() => _rosterLiveMount?.setBusy?.(isBusy))
      } else {
        _rosterLiveMount?.setBusy?.(isBusy)
      }
    }

    card?.classList.toggle('pro-duty-card--on', !!running)
    card?.classList.toggle('pro-duty-card--off', !running)
    dot.className = 'pro-switch-dot' + (running ? ' pro-switch-dot--on' : ' pro-switch-dot--off')
    text.textContent = running ? '自动上班已开启' : '自动上班已关闭'

    const parts = []
    if (st.active_roles != null) parts.push(`${st.active_roles} 人在岗`)
    if (_busyCodes.size) parts.push(`${_busyCodes.size} 人工作中`)
    const pendingN = Number(st.pending_approvals || 0)
    if (pendingN > 0) {
      parts.push(
        `<button type="button" class="pro-meta-link" data-act="goto-approvals">${pendingN} 项待批</button>`,
      )
    } else if (st.pending_approvals != null) {
      parts.push(`0 项待批`)
    }
    meta.innerHTML = parts.join(' · ')
    meta.querySelector('[data-act="goto-approvals"]')?.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      switchToApprovalsTab(page)
    })

    btn.disabled = false
    btn.textContent = running ? '关闭自动上班' : '开启自动上班'
    btn.className = 'btn btn-sm ' + (running ? 'btn-danger' : 'btn-primary')
    btn.onclick = () => toggleEngine(page, running)

    // Always refresh busy/running badge without remounting cards
    if (_currentTab === 'roles') patchRoleBusyUi(page)
  } catch (_e) {
    card?.classList.remove('pro-duty-card--on')
    card?.classList.add('pro-duty-card--off')
    dot.className = 'pro-switch-dot pro-switch-dot--off'
    text.textContent = '无法连接员工服务'
    meta.textContent = '请确认后端已启动'
    btn.disabled = true
    btn.textContent = '—'
  }
}

async function toggleEngine(page, currentlyRunning) {
  const btn = page.querySelector('#pro-switch-btn')
  btn.disabled = true
  btn.textContent = '处理中…'
  try {
    if (currentlyRunning) {
      await api.proactiveDisable()
      toast('自动上班已关闭：到期巡检不会再跑，进行中的也会停掉', 'info')
    } else {
      await api.proactiveEnable()
      toast('自动上班已开启', 'success')
    }
  } catch (e) {
    toast('操作失败: ' + (e?.message || e), 'error')
  }
  await loadStatus(page)
  await loadTabData(page)
}

// ── tab data ──────────────────────────────────────────────

let _rolesData = []
let _initiativesData = []
let _approvalsData = []
let _dashboardData = null
let _prevApprovalCount = -1
/** @type {Set<string>} */
let _busyCodes = new Set()
/** @type {ReturnType<typeof mountProactiveLiveProcess> | null} */
let _rosterLiveMount = null

function syncBusyCodes(st) {
  const next = new Set()
  for (const row of st?.busy_roles || []) {
    const code = String(row?.agent_code || row || '').trim()
    if (code) next.add(code)
  }
  _busyCodes = next
}

/**
 * @param {HTMLElement} page
 * @param {{ agent_code: string, role_name?: string, status?: string }} role
 */
function _fmtTrailClock(iso) {
  try {
    if (!iso) return ''
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) {
      const m = String(iso).match(/^round:(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)/i)
      if (!m) return ''
      const d2 = new Date(m[1])
      if (Number.isNaN(d2.getTime())) return ''
      return d2.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    }
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function openRosterLive(page, role) {
  const code = String(role.agent_code || '').trim()
  if (!code) return

  if (!_rosterLiveMount) {
    _rosterLiveMount = mountProactiveLiveProcess(page)
  }
  const busy = _busyCodes.has(code)
  const roleInits = (_initiativesData || []).filter((i) => String(i.role_agent_code || '') === code)
  let roundId = ''
  let at = ''
  for (const init of roleInits) {
    const rid = String(init.round_id || '').trim()
    if (!rid) continue
    const ts = String(init.created_at || '')
    if (!roundId || ts > at) {
      roundId = rid
      at = ts || rid
    }
  }
  void (async () => {
    let liveRound = ''
    let liveAt = ''
    let liveBusy = busy
    try {
      const st = await api.proactiveRoleBusy(code)
      liveBusy = !!st?.busy
      liveRound = String(st?.current_round_id || '').trim()
      liveAt = String(st?.started_at || liveRound || '').trim()
    } catch {
      /* ignore */
    }
    // While working, always follow current_round_id — never an older initiative/task round.
    if (liveBusy && liveRound) {
      roundId = liveRound
      at = liveAt || liveRound
    } else if (liveBusy) {
      roundId = ''
      at = liveAt
    }
    const clock = _fmtTrailClock(at || roundId)
    const base = liveBusy ? '工作过程 · 工作中' : '工作过程'
    _rosterLiveMount.open({
      agentCode: code,
      roleName: role.role_name || code,
      busy: liveBusy,
      roundId: roundId || undefined,
      title: clock ? `${clock} · ${base}` : base,
      onClosed: () => {
        page.querySelectorAll('.pro-role-card--live-open').forEach((el) => el.classList.remove('pro-role-card--live-open'))
      },
    })
  })()
  page.querySelectorAll('.pro-role-card--live-open').forEach((el) => el.classList.remove('pro-role-card--live-open'))
  page.querySelectorAll('.pro-role-card[data-code]').forEach((el) => {
    if (String(el.dataset.code) === code) el.classList.add('pro-role-card--live-open')
  })
}

async function loadTabData(page) {
  try {
    const { takeNavWarm } = await import('../lib/nav-panel-prefetch.js')
    const takeOr = async (key, fetcher) => {
      const hit = takeNavWarm(key)
      if (hit != null) return hit
      return fetcher()
    }

    // Dashboard is O(roles×queries) — only fetch when Health tab is open.
    const needDash = _currentTab === 'health'
    const [rolesRes, initsRes, apprsRes, dashRes] = await Promise.all([
      takeOr('proactive:roles', () => api.proactiveListRoles().catch(() => ({ roles: [] }))),
      takeOr('proactive:initiatives', () =>
        api.proactiveListInitiatives({ limit: 50 }).catch(() => ({ initiatives: [] })),
      ),
      takeOr('proactive:approvals', () =>
        api.proactiveListApprovals('pending').catch(() => ({ approvals: [] })),
      ),
      needDash
        ? api.proactiveDashboard().catch(() => null)
        : Promise.resolve(_dashboardData),
      refreshAgentsAvatarIndex(),
    ])
    // One roles list covers roster + archived (no second archived round-trip).
    const allRoles = rolesRes?.roles || []
    _rolesData = allRoles.filter((r) => r.status !== 'archived')
    _archivedRolesData = allRoles.filter((r) => r.status === 'archived')
    _initiativesData = initsRes?.initiatives || []
    _approvalsData = apprsRes?.approvals || []
    if (needDash) {
      _dashboardData = dashRes && dashRes.ok !== false ? dashRes : null
    }

    // Desktop notification for new approvals — jump to 待审批 and highlight
    const currentCount = _approvalsData.length
    if (_prevApprovalCount >= 0 && currentCount > _prevApprovalCount) {
      const newCount = currentCount - _prevApprovalCount
      const first = _approvalsData[0]
      const roleName =
        first?.role_name || roleDisplayName(first?.role_agent_code) || first?.role_agent_code || ''
      const titleHint = first?.initiative_title || first?.initiative_id || ''
      const highlightId = String(first?.id || '').trim()
      const highlightInit = String(first?.initiative_id || '').trim()
      if (highlightId) {
        _highlightApprovalId = highlightId
        _highlightInitiativeId = ''
      } else if (highlightInit) {
        _highlightApprovalId = ''
        _highlightInitiativeId = highlightInit
      }
      notifyDesktopCompletion({
        title: `${newCount} 条待审批 · 同意后才执行`,
        body: roleName
          ? `「${roleName}」：${titleHint || '需要你拍板'}。打开 智能体员工 → 待审批`
          : '打开 智能体员工 → 待审批 拍板',
        tag: 'proactive-approval',
        extra: {
          hash: highlightId
            ? `#/proactive?tab=approvals&highlight=${encodeURIComponent(highlightId)}`
            : highlightInit
              ? `#/proactive?tab=approvals&highlight_init=${encodeURIComponent(highlightInit)}`
              : '#/proactive?tab=approvals',
        },
      })
      focusApprovalsTab(page, { updateHash: true })
    }
    _prevApprovalCount = currentCount


    const rolesActive = _rolesData.filter(r => r.status === 'active' || r.status === 'draft').length
    page.querySelector('#pro-tab-count-roles').textContent = rolesActive || ''
    updateFeishuToolbar(page)
    const apprCountEl = page.querySelector('#pro-tab-count-apprs')
    if (apprCountEl) {
      apprCountEl.textContent = _approvalsData.length || ''
      apprCountEl.classList.toggle('pro-tab-count--urgent', _approvalsData.length > 0)
    }
    const archEl = page.querySelector('#pro-tab-count-archived')
    if (archEl) archEl.textContent = _archivedRolesData.length || ''

    if (_currentTab === 'initiatives') _currentTab = 'roles'

    // Soft entry: pending approvals take priority over roster (unless URL/user pinned a tab)
    if (
      !page._proTabAutoDone &&
      !_tabPinnedByHash &&
      _approvalsData.length > 0 &&
      _currentTab !== 'approvals'
    ) {
      _currentTab = 'approvals'
      page.querySelectorAll('.pro-tab').forEach((t) =>
        t.classList.toggle('pro-tab--active', t.dataset.tab === 'approvals'),
      )
      try {
        const next = '#/proactive?tab=approvals'
        if (String(window.location.hash || '') !== next) {
          window.history.replaceState(null, '', next)
        }
      } catch {
        /* ignore */
      }
    }
    page._proTabAutoDone = true

    updateDecideStrip(page)
    renderTabContent(page)
  } catch (e) {
    page.querySelector('#pro-tab-content').innerHTML = `<div class="pro-error">加载失败: ${esc(String(e))}</div>`
  }
}

/** Roster badge — only 3: 工作中 / 在岗 / 已停 */
function roleDutyBadge(role, busy = false) {
  if (busy) return { label: '工作中', cls: 'pro-badge--run', tip: '正在执行本轮任务' }
  const st = String(role?.status || '')
  const suspended = !!(role?.auto_patrol_suspended || role?.config?.auto_patrol_suspended)
  const stopped =
    st === 'paused' ||
    st === 'archived' ||
    st === 'draft' ||
    (st === 'active' && (_engineRunning === false || suspended))

  if (stopped) {
    let tip = '不会自动巡检'
    if (st === 'draft') tip = '草稿未确认，确认后才会排班'
    else if (st === 'paused') tip = '请假中，不会自动巡检'
    else if (st === 'archived') tip = '已归档，不会自动巡检'
    else if (suspended) tip = '该员工自动巡检已关；菜单「上班」可恢复'
    else if (_engineRunning === false) tip = '总开关已关闭，到期也不会跑'
    return { label: '已停', cls: 'pro-badge--muted', tip }
  }

  if (st === 'active') {
    const tipNext = role?.next_heartbeat_at
      ? `下次自动巡检 ${fmtTime(role.next_heartbeat_at)}`
      : '按计划自动巡检'
    const dash = roleDash(role?.agent_code)
    const noopN = Number(dash?.consecutive_noop_count || 0)
    const idle =
      !!dash?.idle_suspected ||
      noopN >= 3 ||
      Number(dash?.no_op_pct || 0) >= 40
    return { label: '在岗', cls: 'pro-badge--ok', tip: tipNext, idle }
  }
  return { label: '已停', cls: 'pro-badge--muted', tip: st || '—' }
}

function patchRoleBusyUi(page) {
  page.querySelectorAll('.pro-role-card[data-code]').forEach((card) => {
    const code = card.dataset.code || ''
    const busy = _busyCodes.has(code)
    const role = _rolesData.find((r) => String(r.agent_code) === String(code))
    const badge = roleDutyBadge(role, busy)
    card.classList.toggle('pro-role-card--busy', busy)
    card.classList.toggle('pro-role-card--idle', !!badge.idle && !busy)
    const statusEl = card.querySelector('[data-role-status]')
    if (statusEl && role) {
      statusEl.textContent = badge.label
      statusEl.className = `pro-badge ${badge.cls}`
      if (badge.tip) statusEl.title = badge.tip
      else statusEl.removeAttribute('title')
    }
  })
}

function reRenderRolesTab(page) {
  const container = page?.querySelector('#pro-tab-content')
  if (!container || _currentTab !== 'roles') return
  container.innerHTML = renderRoles(_rolesData)
  bindRoles(container)
  mountProactiveAvatars(container, 44)
  updateDecideStrip(page)
}

function reRenderArchivedTab(page) {
  const container = page?.querySelector('#pro-tab-content')
  if (!container || _currentTab !== 'archived') return
  container.innerHTML = renderArchivedRoles(_archivedRolesData)
  bindArchivedRoles(container)
  mountProactiveAvatars(container, 44)
  updateDecideStrip(page)
}

function renderTabContent(page) {
  const container = page.querySelector('#pro-tab-content')
  if (_currentTab === 'approvals') {
    container.innerHTML = renderApprovals(_approvalsData, _initiativesData)
    bindApprovals(container)
  } else if (_currentTab === 'health') {
    container.innerHTML = renderHealthDashboard(_dashboardData, _rolesData)
    bindHealth(container)
  } else if (_currentTab === 'archived') {
    container.innerHTML = renderArchivedRoles(_archivedRolesData)
    bindArchivedRoles(container)
    mountProactiveAvatars(container, 44)
  } else if (_currentTab === 'org') {
    container.innerHTML = `<div class="pro-loading">加载组织架构…</div>`
    void loadAndRenderOrg(page)
  } else {
    _currentTab = 'roles'
    container.innerHTML = renderRoles(_rolesData)
    bindRoles(container)
    mountProactiveAvatars(container, 44)
  }
  updateDecideStrip(page)
}

function _reportsToOf(role) {
  return String(role?.reports_to || role?.config?.reports_to || '').trim()
}

function _countOrgDescendants(node) {
  const kids = Array.isArray(node?.children) ? node.children : []
  return kids.reduce((n, c) => n + 1 + _countOrgDescendants(c), 0)
}

function _findOrgNode(nodes, code) {
  const target = String(code || '').trim()
  if (!target) return null
  for (const n of nodes || []) {
    if (String(n.agent_code || '').trim() === target) return n
    const hit = _findOrgNode(n.children || [], target)
    if (hit) return hit
  }
  return null
}

function _collectExpandableCodes(nodes, out = []) {
  for (const n of nodes || []) {
    const kids = Array.isArray(n.children) ? n.children : []
    if (kids.length) {
      out.push(String(n.agent_code || '').trim())
      _collectExpandableCodes(kids, out)
    }
  }
  return out
}

function _expandOrgPathTo(code, nodes, expanded) {
  const target = String(code || '').trim()
  if (!target) return false
  for (const n of nodes || []) {
    const c = String(n.agent_code || '').trim()
    if (c === target) {
      expanded.add('__root__')
      return true
    }
    if (_expandOrgPathTo(target, n.children || [], expanded)) {
      if (c) expanded.add(c)
      expanded.add('__root__')
      return true
    }
  }
  return false
}

function _expandOrgDefaults(trees, flat) {
  const expanded = new Set(['__root__'])
  for (const n of trees || []) {
    const code = String(n.agent_code || '').trim()
    if ((n.children || []).length) expanded.add(code)
  }
  return expanded
}

function _orgStatusLabel(status) {
  const s = String(status || '').trim()
  if (s === 'paused') return '已请假'
  if (s === 'archived') return '已归档'
  if (s && s !== 'active') return s
  return ''
}

function _orgManagerOptions(code, flatRoles, currentMgr) {
  return [
    `<option value="">无上级 · 升为顶层</option>`,
    ...flatRoles
      .filter((r) => {
        const c = String(r.agent_code || '').trim()
        return c && c !== code
      })
      .map((r) => {
        const c = String(r.agent_code || '').trim()
        const n = String(r.role_name || c).trim()
        const st = _orgStatusLabel(r.status)
        const label = st ? `${n}（${st}）` : n
        const sel = c === currentMgr ? ' selected' : ''
        return `<option value="${esc(c)}"${sel}>${esc(label)}</option>`
      }),
  ].join('')
}

/** DingTalk-style left tree row (expand + avatar + name). */
function renderOrgTreeRow(node, flatRoles, depth, isLast) {
  const code = String(node.agent_code || '').trim()
  const flat = flatRoles.find((r) => String(r.agent_code || '').trim() === code) || node || {}
  const name = String(flat.role_name || node.role_name || code).trim()
  const dept = String(flat.department || node.department || '').trim()
  const status = String(flat.status || node.status || '').trim()
  // 组织树固定：请假/草稿仍占位；仅 API 标记的桥接节点才灰显（显式按状态过滤时）
  const isBridge = Boolean(flat.is_bridge)
  // 在岗不打标，避免整树刷屏；请假/归档等才显示状态
  const statusLabel = _orgStatusLabel(status)
  const kids = Array.isArray(node.children) ? node.children : []
  const hasKids = kids.length > 0
  const expanded = hasKids && _orgUi.expanded.has(code)
  const selected = _orgUi.selected === code
  const directN = kids.length
  const subtreeN = hasKids ? _countOrgDescendants(node) : 0

  const childHtml =
    hasKids && expanded
      ? `<ul class="dd-org-children">${kids
          .map((c, i) => renderOrgTreeRow(c, flatRoles, depth + 1, i === kids.length - 1))
          .join('')}</ul>`
      : ''

  return `
    <li class="dd-org-node${isLast ? ' is-last' : ''}${hasKids ? ' has-kids' : ''}${expanded ? ' is-open' : ' is-collapsed'}${isBridge ? ' is-bridge' : ''}" data-depth="${depth}">
      <div class="dd-org-row${selected ? ' is-selected' : ''}${hasKids ? ' has-kids' : ''}${isBridge ? ' is-bridge' : ''}" data-act="org-select" data-code="${esc(code)}" role="treeitem" aria-selected="${selected ? 'true' : 'false'}"${hasKids ? ` aria-expanded="${expanded ? 'true' : 'false'}"` : ''}>
        <button type="button" class="dd-org-twist${hasKids ? (expanded ? ' is-open' : '') : ' is-leaf'}" data-act="org-toggle" data-code="${esc(code)}" aria-label="${hasKids ? (expanded ? '收起下级' : '展开下级') : '无下级'}" title="${hasKids ? (expanded ? '收起下级' : '展开下级') : ''}" ${hasKids ? '' : 'tabindex="-1"'}>
          <span class="dd-org-twist-icon" aria-hidden="true"></span>
        </button>
        <div class="dd-org-avatar" data-avatar-agent="${esc(code)}" data-avatar-size="28" aria-hidden="true"></div>
        <div class="dd-org-text">
          <span class="dd-org-name">${esc(name)}</span>
          ${dept ? `<span class="dd-org-dept">${esc(dept)}</span>` : ''}
          ${statusLabel ? `<span class="dd-org-badge">${esc(statusLabel)}</span>` : ''}
        </div>
        ${hasKids ? `<span class="dd-org-count" title="${expanded ? '直属下级' : `含下级 ${subtreeN} 人`}">${expanded ? directN : subtreeN}</span>` : ''}
      </div>
      ${childHtml}
    </li>`
}

function _sortOrgForest(nodes) {
  const list = Array.isArray(nodes) ? [...nodes] : []
  list.sort((a, b) => {
    const an = String(a.role_name || a.agent_code || '')
    const bn = String(b.role_name || b.agent_code || '')
    return an.localeCompare(bn, 'zh-CN')
  })
  for (const n of list) {
    if (Array.isArray(n.children) && n.children.length) {
      n.children = _sortOrgForest(n.children)
    }
  }
  return list
}

function _orgMiniCard(roleOrNode, { focus = false } = {}) {
  const code = String(roleOrNode?.agent_code || '').trim()
  const name = String(roleOrNode?.role_name || code).trim()
  if (!code) return ''
  return `
    <button type="button" class="dd-org-mini${focus ? ' is-focus' : ''}" data-act="org-select" data-code="${esc(code)}">
      <span class="dd-org-avatar dd-org-avatar--sm" data-avatar-agent="${esc(code)}" data-avatar-size="40" aria-hidden="true"></span>
      <span class="dd-org-mini-name">${esc(name)}</span>
    </button>`
}

/** DingTalk 架构图：上级在上、本岗居中、直属下级横向排开 */
function renderOrgChartPreview(flatRoles, forest, code) {
  const selfCode = String(code || '').trim()
  if (!selfCode) return ''
  const node = _findOrgNode(forest, selfCode)
  const flat = flatRoles.find((r) => String(r.agent_code || '').trim() === selfCode) || node || {}
  const currentMgr = String(flat.reports_to || node?.reports_to || '').trim()
  const mgrRole = currentMgr
    ? flatRoles.find((r) => String(r.agent_code || '').trim() === currentMgr)
    : null
  const kids = Array.isArray(node?.children) ? node.children : []

  const upTier = mgrRole
    ? `<div class="dd-org-diagram-tier">${_orgMiniCard(mgrRole)}</div>
       <div class="dd-org-diagram-vline" aria-hidden="true"></div>`
    : ''

  const downTier = kids.length
    ? `<div class="dd-org-diagram-vline" aria-hidden="true"></div>
       <div class="dd-org-diagram-hbar" aria-hidden="true"></div>
       <div class="dd-org-diagram-tier dd-org-diagram-tier--kids">
         ${kids.map((c) => `<div class="dd-org-diagram-branch">${_orgMiniCard(c)}</div>`).join('')}
       </div>`
    : ''

  return `
    <div class="dd-org-section dd-org-section--diagram">
      <h4>架构图预览</h4>
      <div class="dd-org-diagram" role="img" aria-label="上下级关系示意">
        ${upTier}
        <div class="dd-org-diagram-tier dd-org-diagram-tier--self">${_orgMiniCard(flat, { focus: true })}</div>
        ${downTier}
      </div>
    </div>`
}

function renderOrgDetail(flatRoles, forest) {
  const code = String(_orgUi.selected || '').trim()
  if (!code) {
    return `
      <div class="dd-org-detail-empty">
        <p>在左侧选择一位员工</p>
        <p class="dd-org-detail-hint">像钉钉通讯录一样：左侧是架构树，右侧改汇报关系。</p>
      </div>`
  }
  const node = _findOrgNode(forest, code)
  const flat = flatRoles.find((r) => String(r.agent_code || '').trim() === code) || node || {}
  const name = String(flat.role_name || code).trim()
  const dept = String(flat.department || '').trim()
  const currentMgr = String(flat.reports_to || node?.reports_to || '').trim()
  const kids = Array.isArray(node?.children) ? node.children : []
  const mgrRole = currentMgr
    ? flatRoles.find((r) => String(r.agent_code || '').trim() === currentMgr)
    : null
  const mgrStatus = _orgStatusLabel(mgrRole?.status)
  const mgrLabel = mgrRole
    ? `${String(mgrRole.role_name || mgrRole.agent_code || currentMgr).trim()}${mgrStatus ? `（${mgrStatus}）` : ''}`
    : currentMgr || '（无 · 顶层）'
  const selfStatus = _orgStatusLabel(flat.status)
  const dutyLabel =
    String(flat.status || '') === 'active'
      ? '在岗'
      : selfStatus || String(flat.status || '') || '—'
  const bridgeHint = flat.is_bridge
    ? `<p class="dd-org-bridge-hint">此岗为桥接节点（按状态过滤时保留汇报线）。日常组织图里在岗/请假都会正常占位。</p>`
    : ''

  const reportsHtml = kids.length
    ? `<ul class="dd-org-reports">${kids
        .map((c) => {
          const cc = String(c.agent_code || '').trim()
          const nn = String(c.role_name || cc).trim()
          return `<li>
            <button type="button" class="dd-org-report-item" data-act="org-select" data-code="${esc(cc)}">
              <span class="dd-org-avatar dd-org-avatar--sm" data-avatar-agent="${esc(cc)}" data-avatar-size="28" aria-hidden="true"></span>
              <span>${esc(nn)}</span>
            </button>
          </li>`
        })
        .join('')}</ul>`
    : `<p class="dd-org-muted">暂无直属下级</p>`

  return `
    <div class="dd-org-detail">
      <div class="dd-org-detail-head">
        <div class="dd-org-avatar dd-org-avatar--lg" data-avatar-agent="${esc(code)}" data-avatar-size="56" aria-hidden="true"></div>
        <div>
          <h3 class="dd-org-detail-name">${esc(name)}${selfStatus ? ` <span class="dd-org-badge">${esc(selfStatus)}</span>` : ''}</h3>
          <p class="dd-org-detail-meta"><code>${esc(code)}</code>${dept ? ` · ${esc(dept)}` : ''} · ${esc(dutyLabel)}</p>
        </div>
      </div>
      ${bridgeHint}
      <dl class="dd-org-facts">
        <div>
          <dt>在岗状态</dt>
          <dd>${esc(dutyLabel)}</dd>
        </div>
        <div>
          <dt>当前上级</dt>
          <dd>${esc(mgrLabel)}</dd>
        </div>
        <div>
          <dt>直属下级</dt>
          <dd>${kids.length} 人${_countOrgDescendants(node || {}) > kids.length ? `（含间接 ${_countOrgDescendants(node || {})}）` : ''}</dd>
        </div>
      </dl>
      ${renderOrgChartPreview(flatRoles, forest, code)}
      <label class="dd-org-field">
        <span>调整上级（立即保存）</span>
        <select class="pro-org-select" data-act="set-reports-to" data-code="${esc(code)}">
          ${_orgManagerOptions(code, flatRoles, currentMgr)}
        </select>
      </label>
      <div class="dd-org-section">
        <h4>直属下级</h4>
        ${reportsHtml}
      </div>
      <div class="dd-org-detail-actions">
        <button type="button" class="btn btn-sm btn-outline" data-act="open-role" data-code="${esc(code)}">打开工作过程</button>
      </div>
    </div>`
}

function renderOrgTree(forest, flatRoles) {
  const trees = Array.isArray(forest) ? forest : []
  if (!trees.length) {
    return `
      <div class="pro-empty">
        <p class="pro-empty-title">暂无组织节点</p>
        <p class="pro-empty-desc">先雇佣员工，再在左侧选择并设置上级</p>
      </div>`
  }
  const people = flatRoles.filter((r) => !r.is_bridge).length
  const linked = flatRoles.filter((r) => !r.is_bridge && String(r.reports_to || '').trim()).length
  const bridgeN = flatRoles.filter((r) => r.is_bridge).length
  const onDuty = flatRoles.filter((r) => !r.is_bridge && String(r.status || '') === 'active').length
  const offDuty = people - onDuty
  const flatHint =
    people > 1 && linked === 0
      ? `<div class="pro-org-hint">还没有汇报线。在左侧点选员工，右侧选择上级后，树会立刻变成钉钉式层级。</div>`
      : bridgeN
        ? `<div class="pro-org-hint">含 ${bridgeN} 个桥接节点（灰显），用于在按状态过滤时保留汇报层级。</div>`
        : `<div class="pro-org-hint">组织架构按汇报关系固定展示；在岗 / 请假只影响状态标记，不改变上下级。</div>`

  const rootOpen = _orgUi.expanded.has('__root__')
  const rootKids = rootOpen
    ? `<ul class="dd-org-children dd-org-children--root">${trees
        .map((n, i) => renderOrgTreeRow(n, flatRoles, 0, i === trees.length - 1))
        .join('')}</ul>`
    : ''

  return `
    <div class="pro-org-panel">
      <header class="pro-org-head">
        <div>
          <h2 class="pro-org-title">组织架构</h2>
        </div>
        <div class="pro-org-head-aside">
          <span class="pro-org-stat">${people} 个岗位 · ${onDuty} 在岗 · ${offDuty} 请假/其他 · ${trees.length} 个顶层 · ${linked} 条汇报线${bridgeN ? ` · ${bridgeN} 桥接` : ''}</span>
          <button type="button" class="btn btn-sm btn-outline" data-act="org-expand-all">全部展开</button>
          <button type="button" class="btn btn-sm btn-outline" data-act="org-collapse-all">全部收起</button>
          <button type="button" class="btn btn-sm btn-outline" data-act="org-refresh">刷新</button>
        </div>
      </header>
      ${flatHint}
      <div class="dd-org-layout">
        <aside class="dd-org-tree-pane" aria-label="组织树">
          <div class="dd-org-company${rootOpen ? ' is-open' : ''}" data-act="org-toggle" data-code="__root__" role="treeitem" aria-expanded="${rootOpen ? 'true' : 'false'}">
            <button type="button" class="dd-org-twist${rootOpen ? ' is-open' : ''}" data-act="org-toggle" data-code="__root__" aria-label="${rootOpen ? '收起组织树' : '展开组织树'}" title="${rootOpen ? '收起组织树' : '展开组织树'}">
              <span class="dd-org-twist-icon" aria-hidden="true"></span>
            </button>
            <strong>智能体组织</strong>
            <span class="dd-org-count">${people}</span>
          </div>
          ${rootKids}
        </aside>
        <section class="dd-org-detail-pane" aria-label="岗位详情">
          ${renderOrgDetail(flatRoles, trees)}
        </section>
      </div>
    </div>`
}

function _buildForestFromFlat(flat) {
  const byCode = new Map(flat.map((r) => [String(r.agent_code || '').trim(), { ...r, children: [] }]))
  const roots = []
  for (const r of byCode.values()) {
    const mgr = String(r.reports_to || '').trim()
    if (mgr && byCode.has(mgr) && mgr !== r.agent_code) {
      byCode.get(mgr).children.push(r)
    } else {
      roots.push(r)
    }
  }
  return _sortOrgForest(roots)
}

async function loadAndRenderOrg(page, { keepSelection = true } = {}) {
  const container = page.querySelector('#pro-tab-content')
  if (!container || _currentTab !== 'org') return
  try {
    // 固定组织图：不按 active 过滤；请假岗位仍在树上，只带状态标记
    const res = await api.proactiveOrgTree().catch(() => null)
    const forest = res?.forest || []
    const flat = Array.isArray(res?.roles) && res.roles.length
      ? res.roles
      : (_rolesData || []).map((r) => ({
          agent_code: r.agent_code,
          role_name: r.role_name,
          department: r.department,
          reports_to: _reportsToOf(r),
          status: r.status,
        }))
    let trees = forest.length ? _sortOrgForest(forest) : []
    if (!trees.length && flat.length) trees = _buildForestFromFlat(flat)

    _orgUi.forest = trees
    _orgUi.flat = flat
    if (!keepSelection || _orgUi.expanded.size <= 1) {
      _orgUi.expanded = _expandOrgDefaults(trees, flat)
    } else {
      _orgUi.expanded.add('__root__')
    }
    if (_orgUi.selected) {
      _expandOrgPathTo(_orgUi.selected, trees, _orgUi.expanded)
    }
    if (keepSelection && _orgUi.selected && !_findOrgNode(trees, _orgUi.selected)) {
      _orgUi.selected = ''
    }
    if (!_orgUi.selected && flat.length) {
      _orgUi.selected = String(flat[0].agent_code || '').trim()
    }

    if (_currentTab !== 'org') return
    container.innerHTML = renderOrgTree(trees, flat)
    await refreshAgentsAvatarIndex()
    mountProactiveAvatars(container)
    bindOrgPanel(page, container)
  } catch (e) {
    if (_currentTab === 'org' && container) {
      container.innerHTML = `<div class="pro-error">组织架构加载失败: ${esc(String(e?.message || e))}</div>`
    }
  }
}

function _rerenderOrg(page) {
  const container = page.querySelector('#pro-tab-content')
  if (!container || _currentTab !== 'org') return
  container.innerHTML = renderOrgTree(_orgUi.forest, _orgUi.flat)
  void refreshAgentsAvatarIndex().then(() => mountProactiveAvatars(container))
  bindOrgPanel(page, container)
}

function bindOrgPanel(page, container) {
  const orgClickState = { code: '', t: 0 }

  container.querySelector('[data-act="org-refresh"]')?.addEventListener('click', () => {
    void loadAndRenderOrg(page)
  })
  container.querySelector('[data-act="org-expand-all"]')?.addEventListener('click', () => {
    _orgUi.expanded = new Set(['__root__', ..._collectExpandableCodes(_orgUi.forest)])
    _rerenderOrg(page)
  })
  container.querySelector('[data-act="org-collapse-all"]')?.addEventListener('click', () => {
    _orgUi.expanded = new Set(['__root__'])
    _rerenderOrg(page)
  })
  container.querySelectorAll('[data-act="org-toggle"]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const code = String(el.getAttribute('data-code') || '').trim()
      if (!code) return
      if (_orgUi.expanded.has(code)) _orgUi.expanded.delete(code)
      else _orgUi.expanded.add(code)
      _rerenderOrg(page)
    })
  })
  container.querySelectorAll('[data-act="org-select"]').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="org-toggle"]')) return
      const code = String(el.getAttribute('data-code') || '').trim()
      if (!code || code === '__root__') return
      const now = Date.now()
      const isDbl = orgClickState.code === code && now - orgClickState.t < 360
      orgClickState.code = code
      orgClickState.t = now

      _orgUi.selected = code
      _expandOrgPathTo(code, _orgUi.forest, _orgUi.expanded)

      const node = _findOrgNode(_orgUi.forest, code)
      const hasKids = (node?.children || []).length > 0
      if (isDbl && hasKids) {
        if (_orgUi.expanded.has(code)) _orgUi.expanded.delete(code)
        else _orgUi.expanded.add(code)
      } else if (hasKids && !_orgUi.expanded.has(code)) {
        _orgUi.expanded.add(code)
      }

      _rerenderOrg(page)
      void import('../lib/page-activity.js')
        .then(({ emitPageActivity }) => {
          emitPageActivity({
            type: 'select_employee',
            module: 'employees',
            entityId: code,
            label: String(node?.role_name || node?.name || code),
          })
        })
        .catch(() => {})
    })
  })
  container.querySelectorAll('[data-act="open-role"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const code = String(btn.getAttribute('data-code') || '').trim()
      if (code) navigate(`/proactive/${encodeURIComponent(code)}`)
    })
  })
  container.querySelectorAll('[data-act="set-reports-to"]').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const code = String(sel.getAttribute('data-code') || '').trim()
      const mgr = String(sel.value || '').trim()
      if (!code) return
      sel.disabled = true
      try {
        await api.proactiveUpdateRole(code, { reports_to: mgr })
        const mgrName = mgr
          ? String(
              (_orgUi.flat || []).find((r) => String(r.agent_code) === mgr)?.role_name || mgr,
            )
          : ''
        toast(mgr ? `已改为向「${mgrName}」汇报` : '已升为顶层（无上级）', 'success')
        try {
          const rolesRes = await api.proactiveListRoles().catch(() => null)
          if (rolesRes?.roles) {
            _rolesData = (rolesRes.roles || []).filter((r) => r.status !== 'archived')
          }
        } catch {
          /* ignore */
        }
        _orgUi.selected = code
        if (mgr) _orgUi.expanded.add(mgr)
        void loadAndRenderOrg(page)
      } catch (e) {
        toast(`更新失败: ${e?.message || e}`, 'error')
        sel.disabled = false
        void loadAndRenderOrg(page)
      }
    })
  })
}

function renderArchivedRoles(roles) {
  const toolbar = `<div class="pro-archived-toolbar">
    <p class="pro-archived-hint">已归档员工不会自动上班、不出现在名册；历史事项保留。可重新上班或彻底删除。</p>
    <button type="button" class="btn btn-sm btn-outline" data-act="archive-legacy">清理演示种子岗</button>
  </div>`
  if (!roles.length) {
    return `${toolbar}<div class="pro-empty">
      <p class="pro-empty-title">暂无归档员工</p>
      <p class="pro-empty-desc">名册里对员工选「归档」后会出现在这里；演示种子岗可用上方按钮一键归档</p>
    </div>`
  }
  const paged = paginateItems(roles, _archivedPage, _archivedPageSize)
  _archivedPage = paged.page
  _archivedPageSize = paged.pageSize
  return (
    toolbar +
    '<div class="pro-role-grid">' +
    paged.items
      .map((r) => {
        const resp = Array.isArray(r.config?.responsibilities)
          ? r.config.responsibilities.filter(Boolean)
          : []
        const dutyHtml = renderRoleDutyText(resp, {
          empty: `<p class="pro-role-duty">${esc(previewLine(r.department || '已归档', 56))}</p>`,
        })
        return `
    <article class="pro-role-card pro-role-card--slim pro-role-card--archived" data-code="${esc(r.agent_code)}">
      <div class="pro-role-header">
        <div class="pro-role-avatar" data-avatar-agent="${esc(r.agent_code)}" aria-hidden="true"></div>
        <div class="pro-role-heading">
          <div class="pro-role-title">
            <span class="pro-role-name">${esc(roleCardTitle(r))}</span>
            <span class="pro-badge pro-badge--muted">已归档</span>
          </div>
          ${dutyHtml}
        </div>
        <div class="pro-role-more">
          <button type="button" class="pro-role-more-btn" data-action="more" data-code="${esc(r.agent_code)}" aria-label="更多操作" aria-haspopup="menu" aria-expanded="false">⋯</button>
          <div class="pro-role-more-menu" role="menu" hidden>
            <button type="button" class="pro-role-more-item" role="menuitem" data-action="worklog" data-code="${esc(r.agent_code)}">工作日志</button>
            <button type="button" class="pro-role-more-item" role="menuitem" data-action="resume" data-code="${esc(r.agent_code)}">重新上班</button>
            <div class="pro-role-more-sep" role="separator"></div>
            <button type="button" class="pro-role-more-item pro-role-more-item--danger" role="menuitem" data-action="delete" data-code="${esc(r.agent_code)}">删除岗位</button>
          </div>
        </div>
      </div>
      <div class="pro-role-body">
        <div class="pro-role-meta pro-role-meta--compact">
          <span class="pro-meta-chip">已归档</span>
        </div>
        <button type="button" class="pro-work-summary pro-work-summary--slim" data-action="worklog" data-code="${esc(r.agent_code)}">
          <span class="pro-work-summary-label">近况</span>
          <span class="pro-work-summary-last">查看历史工作日志</span>
          <span class="pro-work-summary-meta">${esc(r.agent_code)}</span>
        </button>
      </div>
    </article>`
      })
      .join('') +
    '</div>' +
    `<div class="pro-list-pager-wrap">${renderListPagerHtml({
      total: paged.total,
      page: paged.page,
      pageCount: paged.pageCount,
      pageSize: paged.pageSize,
      from: paged.from,
      to: paged.to,
      unit: '位',
    })}</div>`
  )
}

function bindArchivedRoles(container) {
  const page = container.closest('.proactive-page')
  const archivedPaged = paginateItems(_archivedRolesData, _archivedPage, _archivedPageSize)
  bindListPager(container, {
    page: archivedPaged.page,
    pageCount: archivedPaged.pageCount,
    onPage: (next) => {
      _archivedPage = next
      if (page) reRenderArchivedTab(page)
    },
    onPageSize: (nextSize) => {
      _archivedPageSize = nextSize
      _archivedPage = 1
      writeStoredPageSize(ARCHIVED_PAGE_SIZE_KEY, nextSize)
      if (page) reRenderArchivedTab(page)
    },
  })
  container.querySelector('[data-act="archive-legacy"]')?.addEventListener('click', async () => {
    const ok = await showConfirm(
      '将演示种子岗（前端架构 / 后端工程 / 运维）归档？\n\n已归档的会跳过；名册中仍在岗的同名岗也会被归档。',
    )
    if (!ok) return
    try {
      const res = await api.proactiveArchiveLegacy()
      const n = (res?.archived || []).length
      toast(n ? `已归档 ${n} 个种子岗` : '没有需要归档的种子岗', n ? 'success' : 'info')
      if (page) await loadAll(page)
    } catch (e) {
      toast(`清理失败: ${e?.message || e}`, 'error')
    }
  })
  container.querySelectorAll('.pro-role-card[data-code]').forEach((card) => {
    card.addEventListener('click', (e) => {
      const t = e.target
      if (!(t instanceof Element)) return
      if (t.closest('[data-action], button, a, input, textarea, select, .pro-role-more')) return
      const code = card.dataset.code
      if (code) navigate(`/proactive/${encodeURIComponent(code)}`)
    })
  })
  container.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const action = btn.dataset.action
      const code = btn.dataset.code
      if (action === 'more') {
        const wrap = btn.closest('.pro-role-more')
        const menu = wrap?.querySelector('.pro-role-more-menu')
        if (!wrap || !menu) return
        const willOpen = menu.hidden
        closeAllRoleMoreMenus(container)
        if (willOpen) {
          wrap.classList.add('is-open')
          btn.setAttribute('aria-expanded', 'true')
          positionRoleMoreMenu(btn, menu)
        }
        return
      }
      closeAllRoleMoreMenus(container)
      if (action === 'worklog') {
        navigate(`/proactive/${encodeURIComponent(code)}`)
        return
      }
      if (action === 'resume') {
        const role = _archivedRolesData.find((r) => String(r.agent_code) === String(code))
        const name = role?.role_name || code
        const ok = await showConfirm(`将「${name}」重新上班？\n\n恢复后会按节奏自动上班。`)
        if (!ok) return
        try {
          await api.proactiveResumeRole(code)
          toast(`已雇佣 ${name}`, 'success')
          _currentTab = 'roles'
          _tabPinnedByHash = true
          page?.querySelectorAll('.pro-tab').forEach((t) =>
            t.classList.toggle('pro-tab--active', t.dataset.tab === 'roles'),
          )
          if (page) await loadAll(page)
        } catch (err) {
          toast(`雇佣失败: ${err?.message || err}`, 'error')
        }
        return
      }
      if (action === 'delete') {
        const role = _archivedRolesData.find((r) => String(r.agent_code) === String(code))
        const name = role?.role_name || code
        const ok = await showConfirm(`确定删除岗位「${name}」？\n\n会移除岗位雇佣，不删除底层智能体。`)
        if (!ok) return
        try {
          await api.proactiveDeleteRole(code)
          toast(`已删除 ${name}`, 'info')
          if (page) await loadAll(page)
        } catch (err) {
          toast(`删除失败: ${err?.message || err}`, 'error')
        }
      }
    })
  })
}

function previewLine(text, max = 72) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 名册卡片：职责纯文本，固定最多 3 行，超出第三行省略 */
function renderRoleDutyText(items, { empty = '' } = {}) {
  const resp = Array.isArray(items) ? items.filter(Boolean) : []
  if (!resp.length) return empty
  const full = resp.join('\n')
  return `<p class="pro-role-duty" title="${esc(full)}">${esc(full)}</p>`
}

function updateDecideStrip(page) {
  const strip = page?.querySelector('#pro-decide-strip')
  if (!strip) return
  const pending = (_approvalsData || []).filter((a) => a.status === 'pending')
  // Hide when already on approvals tab or nothing to decide
  if (!pending.length || _currentTab === 'approvals') {
    strip.hidden = true
    strip.innerHTML = ''
    return
  }
  const top = pending.slice(0, 3)
  const more = pending.length - top.length
  strip.hidden = false
  strip.innerHTML = `
    <div class="pro-decide-strip-main">
      <div class="pro-decide-strip-copy">
        <strong>待你拍板 · ${pending.length} 项</strong>
        <ul class="pro-decide-strip-list">
          ${top
            .map((a) => {
              const title = previewLine(a.initiative_title || a.initiative_id || '事项', 48)
              const role = a.role_name || roleDisplayName(a.role_agent_code)
              return `<li><em>${esc(role)}</em> ${esc(title)}</li>`
            })
            .join('')}
          ${more > 0 ? `<li class="pro-decide-more">另有 ${more} 项…</li>` : ''}
        </ul>
      </div>
      <button type="button" class="btn btn-sm btn-primary" data-act="goto-approvals">去处理</button>
    </div>`
  strip.querySelector('[data-act="goto-approvals"]')?.addEventListener('click', () => {
    switchToApprovalsTab(page)
  })
}

function fmtUsd(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return '$0'
  if (v < 0.01) return `$${v.toFixed(4)}`
  return `$${v.toFixed(2)}`
}

function roleDash(code) {
  const list = _dashboardData?.roles || []
  return list.find((r) => String(r.agent_code) === String(code)) || null
}

function renderHealthDashboard(dash, roles) {
  if (!dash) {
    return `<div class="pro-empty">
      <p class="pro-empty-title">健康数据暂不可用</p>
      <p class="pro-empty-desc">确认后端已启动后点刷新；成本与审批超时率会显示在这里</p>
    </div>`
  }
  const g = dash.global || {}
  const rows = (dash.roles || []).filter((r) => r.status !== 'archived')
  const alertList = Array.isArray(dash.alerts) ? dash.alerts : []
  const alertBanner = alertList.length
    ? `<div class="pro-health-alerts">${alertList
        .slice(0, 8)
        .map(
          (a) =>
            `<div class="pro-health-alert pro-health-alert--${esc(a.level === 'error' ? 'error' : 'warn')}">${esc(a.message || a.kind || '')}</div>`,
        )
        .join('')}</div>`
    : ''
  const cards = `
    <div class="pro-health-kpis">
      <div class="pro-health-kpi"><em>今日成本</em><strong>${esc(fmtUsd(g.total_today_cost_usd))}</strong></div>
      <div class="pro-health-kpi"><em>在岗员工</em><strong>${esc(String(g.active_roles ?? 0))}</strong></div>
      <div class="pro-health-kpi${g.total_zombie_executing ? ' pro-health-kpi--warn' : ''}"><em>卡住执行</em><strong>${esc(String(g.total_zombie_executing ?? 0))}</strong></div>
      <div class="pro-health-kpi${g.alert_count ? ' pro-health-kpi--warn' : ''}"><em>告警</em><strong>${esc(String(g.alert_count ?? alertList.length))}</strong></div>
    </div>`

  if (!rows.length) {
    return alertBanner + cards + `<div class="pro-empty"><p class="pro-empty-title">还没有员工数据</p></div>`
  }

  return (
    alertBanner +
    cards +
    `<div class="pro-health-list">` +
    rows
      .map((r) => {
        const ap = r.approval_stats || {}
        const timeoutRate = Number(ap.timeout_rate || 0)
        const noOp = Number(r.no_op_pct || 0)
        const zombie = Number(r.zombie_executing_count || 0)
        const idle = !!r.idle_suspected
        const pendingN = (_approvalsData || []).filter(
          (a) =>
            a.status === 'pending' && String(a.role_agent_code) === String(r.agent_code),
        ).length
        const roleRow = (roles || []).find((x) => String(x.agent_code) === String(r.agent_code))
        const noWorkspace =
          !roleRow?.config?.workspace_path &&
          !(roleRow?.system_front_desk || String(r.agent_code) === 'xiaomi')
        const mine = (_initiativesData || []).filter(
          (i) => String(i.role_agent_code) === String(r.agent_code),
        )
        const diags = diagnoseRole({
          agentCode: r.agent_code,
          dash: r,
          pendingApprovalCount: pendingN,
          initiatives: mine,
          noWorkspace,
          isDraft: r.status === 'draft',
          isPaused: r.status === 'paused',
        })
        const diagHtml = renderRoleDiagnosisHtml(diags, { esc, code: r.agent_code, compact: true })
        const dayRows = Array.isArray(r.cost_7d_days) ? [...r.cost_7d_days].reverse() : []
        const maxC = Math.max(0.000001, ...dayRows.map((d) => Number(d.cost_usd) || 0))
        const bars = dayRows.length
          ? `<div class="pro-cost-bars pro-cost-bars--health" aria-hidden="true">${dayRows
              .map((d) => {
                const v = Number(d.cost_usd) || 0
                const h = Math.max(6, Math.round((v / maxC) * 28))
                return `<span class="pro-cost-bar" title="${esc(d.date)} · $${v.toFixed(4)}" style="height:${h}px"></span>`
              })
              .join('')}</div>`
          : ''
        return `
      <article class="pro-health-card${idle ? ' pro-health-card--idle' : ''}${zombie > 5 ? ' pro-health-card--alert' : ''}" data-code="${esc(r.agent_code)}">
        <div class="pro-health-card-head">
          <div>
            <strong>${esc(r.role_name || r.agent_code)}</strong>
            <span class="pro-meta-chip">${esc(r.status === 'active' ? '在岗' : r.status === 'paused' ? '请假' : r.status)}</span>
            ${idle ? `<span class="pro-meta-chip pro-meta-chip--warn">疑似空转×${esc(String(r.consecutive_noop_count || 0))}</span>` : ''}
            ${r.budget_warn ? '<span class="pro-meta-chip pro-meta-chip--warn">预算告警</span>' : ''}
          </div>
          <button type="button" class="btn btn-sm btn-ghost" data-act="open-role" data-code="${esc(r.agent_code)}">工作日志</button>
        </div>
        <div class="pro-health-metrics">
          <span>今日 ${esc(fmtUsd(r.today_cost_usd))} · ${esc(String(r.today_tokens || 0))} tok</span>
          <span>7 日 ${esc(fmtUsd(r.cost_7d_total_usd))}</span>
          <span class="${timeoutRate >= 40 ? 'pro-patrol-warn' : ''}">审批超时 ${esc(String(timeoutRate))}%</span>
          <span class="${noOp >= 40 ? 'pro-patrol-warn' : ''}">空转 ${esc(String(noOp))}%</span>
          ${zombie ? `<span class="pro-patrol-warn">卡住 ${zombie}</span>` : ''}
        </div>
        ${bars}
        ${diagHtml}
        <div class="pro-health-approvals">
          审批 ${ap.total || 0} · 通过 ${ap.approved || 0} · 驳回 ${ap.rejected || 0} · 超时 ${ap.timeout || 0}
          ${r.daily_budget_usd > 0 ? ` · 日预算 ${fmtUsd(r.daily_budget_usd)}` : ''}
        </div>
      </article>`
      })
      .join('') +
    `</div>`
  )
}

function bindHealth(container) {
  const page = container.closest('.proactive-page')
  container.querySelectorAll('[data-act="open-role"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const code = btn.dataset.code
      if (code) navigate(`/proactive/${encodeURIComponent(code)}`)
    })
  })
  container.querySelectorAll('[data-diag-act]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const code = btn.dataset.code
      const act = btn.dataset.diagAct
      const role = _rolesData.find((r) => String(r.agent_code) === String(code))
      if (act === 'approvals') {
        if (page) switchToApprovalsTab(page)
        return
      }
      if (act === 'patrol') {
        navigate(`/proactive/${encodeURIComponent(code)}?patrol=1`)
        return
      }
      if (act === 'live') {
        if (page && role) {
          openRosterLive(page, role)
          toast('已打开工作过程', 'info')
        }
        return
      }
      if (act === 'worklog') {
        navigate(`/proactive/${encodeURIComponent(code)}`)
        return
      }
      if (act === 'edit') {
        if (page && role) void showEditRoleModal(page, role)
        return
      }
      if (act === 'tasks') {
        const roleName = String(role?.role_name || '').trim()
        const agent = roleName ? `role:${roleName}` : code ? `agent:${code}` : ''
        const qs = new URLSearchParams()
        qs.set('source', 'role')
        if (agent) qs.set('agent', agent)
        navigate(`/tasks?${qs.toString()}`)
      }
    })
  })
}

// ── roles tab ─────────────────────────────────────────────

function updateFeishuToolbar(page) {
  const bar = page?.querySelector('#pro-feishu-toolbar')
  const label = page?.querySelector('#pro-feishu-toolbar-label')
  const btn = page?.querySelector('#pro-feishu-bind-next')
  if (!bar || !label || !btn) return
  const unbound = listUnboundFeishuRoles(_rolesData || [])
  if (!unbound.length) {
    bar.setAttribute('hidden', '')
    btn.dataset.code = ''
    btn.dataset.name = ''
    return
  }
  const first = unbound[0]
  const name = String(first.role_name || first.agent_code || '').trim()
  label.textContent = `飞书未绑 ${unbound.length}`
  label.title = `${FEISHU_COLLAB_HOWTO_SHORT}\n下一位：${name}`
  btn.dataset.code = String(first.agent_code || '').trim()
  btn.dataset.name = name
  btn.title = `为「${name}」扫码绑定专属机器人`
  bar.removeAttribute('hidden')
}

function renderRoles(roles) {
  if (!roles.length) {
    return `<div class="pro-empty">
      <div class="pro-empty-ico" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
        </svg>
      </div>
      <p class="pro-empty-title">还没有智能体员工</p>
      <p class="pro-empty-desc">先在「智能体」页准备好智能体，再点「雇佣员工」：选人、写职责、绑工作区即可确认上班</p>
      <button type="button" class="btn btn-primary btn-sm" id="pro-empty-hire" style="margin-top:14px">雇佣第一位员工</button>
    </div>`
  }

  const draftN = roles.filter((r) => r.status === 'draft').length
  const draftBanner =
    draftN > 0
      ? `<div class="pro-draft-banner pro-draft-banner--compact">
          <strong>${draftN} 位草稿未确认</strong>
          <span>编辑后点卡片菜单「确认上班」</span>
        </div>`
      : ''

  const paged = paginateItems(roles, _rolesPage, _rolesPageSize)
  _rolesPage = paged.page
  _rolesPageSize = paged.pageSize

  return (
    draftBanner +
    '<div class="pro-role-grid">' +
    paged.items
      .map((r) => {
    const isPaused = r.status === 'paused'
    const isDraft = r.status === 'draft'
    const isArchived = r.status === 'archived'
    const isBusy = _busyCodes.has(String(r.agent_code))
    const dash = roleDash(r.agent_code)
    const dutyBadge = roleDutyBadge(r, isBusy)
    const statusLabel = dutyBadge.label
    const statusCls = dutyBadge.cls
    const isIdle = !!dutyBadge.idle && !isBusy
    const resp = Array.isArray(r.config?.responsibilities)
      ? r.config.responsibilities.filter(Boolean)
      : []
    const dutyHtml = renderRoleDutyText(resp, {
      empty: roleDutyFallback(r),
    })
    const mine = _initiativesData.filter((i) => String(i.role_agent_code) === String(r.agent_code))
    const lastInit = mine[0]
    const pendingN = (_approvalsData || []).filter(
      (a) =>
        a.status === 'pending' && String(a.role_agent_code) === String(r.agent_code),
    ).length
    const isSuspended = !!(r?.auto_patrol_suspended || r?.config?.auto_patrol_suspended)
    let oneLiner = '暂无近况'
    if (isDraft) oneLiner = '草稿未确认 · 确认后才开始自动上班'
    else if (isPaused) oneLiner = '请假中 · 不会自动巡检'
    else if (isSuspended) oneLiner = '自动巡检已关 · 菜单「上班」可恢复'
    else if (_engineRunning === false && !isArchived) oneLiner = '总开关已关 · 到期不会自动跑'
    else if (pendingN) oneLiner = `${pendingN} 项待你拍板`
    else if (isBusy) oneLiner = '工作中 · 正在干活…'
    else if (isIdle) {
      const n = Number(dash?.consecutive_noop_count || 0)
      oneLiner = n ? `近期没干活 · 连续 ${n} 轮没什么产出` : '近期没干活 · 没什么实质产出'
    } else if (lastInit?.title) oneLiner = previewLine(lastInit.title, 64)
    else if (r.last_heartbeat_at) oneLiner = `上次上班 ${fmtTime(r.last_heartbeat_at)}`

    const isSystemFrontDesk = !!r.system_front_desk || String(r.agent_code || '') === 'xiaomi'
    const noWorkspace = !r.config?.workspace_path && !isSystemFrontDesk
    const diags = diagnoseRole({
      agentCode: r.agent_code,
      dash,
      pendingApprovalCount: pendingN,
      initiatives: mine,
      noWorkspace,
      isDraft,
      isPaused,
    })
    const diagHtml = renderRoleDiagnosisHtml(diags, { esc, code: r.agent_code, compact: true })

    const scheduleLabel = roleScheduleSummary(r)
    // 底栏：上班时间 / 飞书 / 工作区 / 花费
    const metaChips = [
      `<span class="pro-meta-chip" title="自动上班">${esc(scheduleLabel)}</span>`,
      feishuBoundChipHtml(r),
    ]
    if (r.config?.workspace_path) {
      metaChips.push(
        `<span class="pro-meta-chip" title="${esc(r.config.workspace_path)}">${esc(pathBasename(r.config.workspace_path))}</span>`,
      )
    } else if (isSystemFrontDesk) {
      metaChips.push('<span class="pro-meta-chip" title="不绑仓库，催办全局任务">全局</span>')
    } else {
      metaChips.push('<span class="pro-meta-chip" title="未指定管辖目录，使用系统默认工作空间">默认工作区</span>')
    }
    if (dash?.today_cost_usd > 0) {
      metaChips.push(
        `<span class="pro-meta-chip" title="今日成本">今日 ${esc(fmtUsd(dash.today_cost_usd))}</span>`,
      )
    }

    const dutyMenu = isDraft
      ? `<button type="button" class="pro-role-more-item" role="menuitem" data-action="resume" data-code="${esc(r.agent_code)}">确认上班</button>`
      : isPaused
        ? `<button type="button" class="pro-role-more-item" role="menuitem" data-action="resume" data-code="${esc(r.agent_code)}">上班</button>`
        : `<button type="button" class="pro-role-more-item" role="menuitem" data-action="pause" data-code="${esc(r.agent_code)}">请假</button>
           <button type="button" class="pro-role-more-item" role="menuitem" data-action="dispatch" data-code="${esc(r.agent_code)}">派发任务</button>
           <button type="button" class="pro-role-more-item" role="menuitem" data-action="heartbeat" data-code="${esc(r.agent_code)}">现在开始工作</button>`

    const feishuBound = feishuBindingOf(r).bound
    const feishuMenu = feishuBound
      ? `<button type="button" class="pro-role-more-item" role="menuitem" data-action="feishu-unbind" data-code="${esc(r.agent_code)}">解绑飞书</button>`
      : `<button type="button" class="pro-role-more-item" role="menuitem" data-action="feishu-bind" data-code="${esc(r.agent_code)}">扫码绑定飞书</button>`

    return `
    <article class="pro-role-card pro-role-card--slim ${isPaused || isDraft ? 'pro-role-card--paused' : ''} ${isArchived ? 'pro-role-card--archived' : ''} ${!isPaused && !isArchived && !isDraft ? 'pro-role-card--active' : ''} ${isBusy ? 'pro-role-card--busy' : ''} ${isIdle ? 'pro-role-card--idle' : ''} ${pendingN ? 'pro-role-card--needs-you' : ''}" data-code="${esc(r.agent_code)}">
      <div class="pro-role-header">
        <div class="pro-role-avatar" data-avatar-agent="${esc(r.agent_code)}" aria-hidden="true"></div>
        <div class="pro-role-heading">
          <div class="pro-role-title">
            <span class="pro-role-name">${esc(roleCardTitle(r))}</span>
            <span class="pro-badge ${statusCls}" data-role-status title="${esc(dutyBadge.tip || '')}">${esc(statusLabel)}</span>
            ${isSystemFrontDesk ? '<span class="pro-badge pro-badge--muted" title="安装自带，催办全局待办">系统前台</span>' : ''}
            ${pendingN ? `<span class="pro-badge pro-badge--urgent">${pendingN} 待批</span>` : ''}
          </div>
          ${dutyHtml}
        </div>
        <div class="pro-role-more">
          <button type="button" class="pro-role-more-btn" data-action="more" data-code="${esc(r.agent_code)}" aria-label="更多操作" title="编辑、删除、归档等" aria-haspopup="menu" aria-expanded="false">⋯</button>
          <div class="pro-role-more-menu" role="menu" hidden>
            <button type="button" class="pro-role-more-item" role="menuitem" data-action="live" data-code="${esc(r.agent_code)}">工作过程</button>
            <button type="button" class="pro-role-more-item" role="menuitem" data-action="edit" data-code="${esc(r.agent_code)}">编辑岗位</button>
            ${feishuMenu}
            ${dutyMenu}
            ${
              isSystemFrontDesk
                ? ''
                : `<div class="pro-role-more-sep" role="separator"></div>
            <button type="button" class="pro-role-more-item" role="menuitem" data-action="archive" data-code="${esc(r.agent_code)}">归档</button>
            <button type="button" class="pro-role-more-item pro-role-more-item--danger" role="menuitem" data-action="delete" data-code="${esc(r.agent_code)}">删除岗位</button>`
            }
          </div>
        </div>
      </div>
      <div class="pro-role-body">
        <div class="pro-role-meta pro-role-meta--compact">${metaChips.join('')}</div>
        <button type="button" class="pro-work-summary pro-work-summary--slim" data-action="worklog" data-code="${esc(r.agent_code)}">
          <span class="pro-work-summary-label">近况</span>
          <span class="pro-work-summary-last">${esc(oneLiner)}</span>
          <span class="pro-work-summary-meta">${
            isDraft
              ? '编辑完善后点「确认上班」'
              : `上次 ${fmtTime(r.last_heartbeat_at)} · 下次 ${fmtTime(r.next_heartbeat_at)}`
          }</span>
        </button>
        ${diagHtml}
      </div>
    </article>`
      })
      .join('') +
    '</div>' +
    `<div class="pro-list-pager-wrap">${renderListPagerHtml({
      total: paged.total,
      page: paged.page,
      pageCount: paged.pageCount,
      pageSize: paged.pageSize,
      from: paged.from,
      to: paged.to,
      unit: '位',
    })}</div>`
  )
}

function prettyRrule(rrule) {
  return roleScheduleSummary({ heartbeat_schedule: rrule, schedule_summary: '' }) || '未设周期'
}

function positionRoleMoreMenu(btn, menu) {
  if (!btn || !menu) return
  const r = btn.getBoundingClientRect()
  // Portal to body so sibling cards (backdrop-filter / opacity stacking) cannot cover it.
  if (menu.parentElement !== document.body) {
    menu.dataset.proMoreHost = '1'
    menu._proMoreHost = menu.parentElement
    document.body.appendChild(menu)
  }
  menu.classList.add('is-fixed')
  menu.style.position = 'fixed'
  menu.style.top = `${Math.round(r.bottom + 4)}px`
  menu.style.right = 'auto'
  menu.hidden = false
  const w = menu.offsetWidth || 148
  let left = Math.round(r.right - w)
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
  menu.style.left = `${left}px`
  const mh = menu.offsetHeight || 0
  if (r.bottom + 4 + mh > window.innerHeight - 8 && r.top - 4 - mh > 8) {
    menu.style.top = `${Math.round(r.top - 4 - mh)}px`
  }
}

function closeAllRoleMoreMenus(root = document) {
  // Menus may be portaled to document.body; always scan open wraps globally,
  // but only act on wraps under `root` (or all when root === document).
  document.querySelectorAll('.pro-role-more.is-open').forEach((wrap) => {
    if (root !== document && !root.contains(wrap)) return
    wrap.classList.remove('is-open')
    const btn = wrap.querySelector('.pro-role-more-btn')
    let menu = wrap.querySelector('.pro-role-more-menu')
    if (!menu) {
      menu = [...document.body.querySelectorAll('.pro-role-more-menu.is-fixed')].find(
        (m) => m._proMoreHost === wrap,
      )
    }
    if (btn) btn.setAttribute('aria-expanded', 'false')
    if (menu) {
      menu.hidden = true
      menu.classList.remove('is-fixed')
      menu.style.position = ''
      menu.style.top = ''
      menu.style.left = ''
      menu.style.right = ''
      const host = menu._proMoreHost
      if (host && menu.parentElement === document.body) {
        host.appendChild(menu)
      }
      menu._proMoreHost = null
      delete menu.dataset.proMoreHost
    }
  })
}

function bindRoles(container) {
  const page = container.closest('.proactive-page')
  const rolesPaged = paginateItems(_rolesData, _rolesPage, _rolesPageSize)
  bindListPager(container, {
    page: rolesPaged.page,
    pageCount: rolesPaged.pageCount,
    onPage: (next) => {
      _rolesPage = next
      if (page) reRenderRolesTab(page)
    },
    onPageSize: (nextSize) => {
      _rolesPageSize = nextSize
      _rolesPage = 1
      writeStoredPageSize(ROLES_PAGE_SIZE_KEY, nextSize)
      if (page) reRenderRolesTab(page)
    },
  })
  container.querySelector('#pro-empty-hire')?.addEventListener('click', () => {
    if (page) void showHireModal(page)
  })
  container.querySelectorAll('.pro-role-card[data-code]').forEach((card) => {
    card.addEventListener('click', (e) => {
      const t = e.target
      if (!(t instanceof Element)) return
      if (t.closest('[data-action], button, a, input, textarea, select, .pro-role-more, .pro-role-task-stats')) return
      const code = card.dataset.code
      if (code) navigate(`/proactive/${encodeURIComponent(code)}`)
    })
  })
  container.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const action = btn.dataset.action
      const code = btn.dataset.code
      const page = container.closest('.proactive-page')

      if (action === 'more') {
        const wrap = btn.closest('.pro-role-more')
        const menu = wrap?.querySelector('.pro-role-more-menu')
        if (!wrap || !menu) return
        const willOpen = menu.hidden
        closeAllRoleMoreMenus(container)
        if (willOpen) {
          wrap.classList.add('is-open')
          btn.setAttribute('aria-expanded', 'true')
          positionRoleMoreMenu(btn, menu)
        }
        return
      }

      closeAllRoleMoreMenus(container)

      const diagAct = btn.dataset.diagAct
      if (action === 'diag' || diagAct) {
        const role = _rolesData.find((r) => String(r.agent_code) === String(code))
        const act = diagAct || ''
        if (act === 'approvals') {
          if (page) switchToApprovalsTab(page)
          return
        }
        if (act === 'patrol') {
          navigate(`/proactive/${encodeURIComponent(code)}?patrol=1`)
          return
        }
        if (act === 'live') {
          if (page && role) {
            openRosterLive(page, role)
            toast('已打开工作过程', 'info')
          }
          return
        }
        if (act === 'worklog') {
          navigate(`/proactive/${encodeURIComponent(code)}`)
          return
        }
        if (act === 'edit') {
          if (page && role) void showEditRoleModal(page, role)
          return
        }
        if (act === 'tasks') {
          const roleName = String(role?.role_name || '').trim()
          const agent = roleName
            ? `role:${roleName}`
            : code
              ? `agent:${code}`
              : ''
          const qs = new URLSearchParams()
          qs.set('source', 'role')
          if (agent) qs.set('agent', agent)
          navigate(`/tasks?${qs.toString()}`)
          return
        }
        return
      }

      if (action === 'edit') {
        const role = _rolesData.find((r) => String(r.agent_code) === String(code))
        if (page && role) void showEditRoleModal(page, role)
        return
      }
      if (action === 'feishu-bind') {
        const role = _rolesData.find((r) => String(r.agent_code) === String(code))
        void startFeishuEmployeeScan(code, {
          roleName: role?.role_name || code,
          onBound: () => {
            if (page) void loadAll(page)
          },
        })
        return
      }
      if (action === 'feishu-unbind') {
        const role = _rolesData.find((r) => String(r.agent_code) === String(code))
        const name = role?.role_name || code
        const ok = await showConfirm(
          `确定解除「${name}」的飞书机器人绑定？\n\n解绑后飞书侧将无法再对话到此员工。`,
        )
        if (!ok) return
        await unbindFeishuEmployee(code, {
          onUnbound: () => {
            if (page) void loadAll(page)
          },
        })
        return
      }
      if (action === 'worklog') {
        navigate(`/proactive/${encodeURIComponent(code)}`)
        return
      }
      if (action === 'live') {
        const role = _rolesData.find((r) => String(r.agent_code) === String(code))
        if (page && role) {
          openRosterLive(page, role)
          toast(_busyCodes.has(code) ? '已打开工作过程（工作中）' : '已打开工作过程', 'info')
        }
        return
      }
      if (action === 'dispatch') {
        const role = _rolesData.find((r) => String(r.agent_code) === String(code))
        if (page && role) void showDispatchModal(page, role)
        return
      }
      if (action === 'heartbeat') {
        navigate(`/proactive/${encodeURIComponent(code)}?patrol=1`)
        return
      }
      if (action === 'pause') {
        closeAllRoleMoreMenus(container)
        const role = _rolesData.find((r) => String(r.agent_code) === String(code))
        const name = roleCardTitle(role) || code
        const wasBusy = _busyCodes.has(code)
        if (role) role.status = 'paused'
        _busyCodes.delete(code)
        if (page) {
          renderTabContent(page)
          toast(
            wasBusy ? `已请假 ${name}，正在中止本轮工作` : `已请假 ${name}`,
            'info',
          )
        }
        void api
          .proactivePauseRole(code)
          .then(() => {
            if (page) void loadStatus(page)
          })
          .catch((err) => {
            toast(`请假失败: ${err?.message || err}`, 'error')
            if (page) void loadTabData(page)
          })
        return
      }
      if (action === 'delete') {
        const role = _rolesData.find((r) => String(r.agent_code) === String(code))
        const name = role?.role_name || code
        const ok = await showConfirm(`确定删除岗位「${name}」？\n\n会移除岗位雇佣，不删除底层智能体。`)
        if (!ok) return
        try {
          await api.proactiveDeleteRole(code)
          toast(`已删除岗位 ${name}`, 'info')
          if (page) await loadAll(page)
        } catch (err) {
          toast(`删除失败: ${err?.message || err}`, 'error')
        }
        return
      }
      if (action === 'archive') {
        const role = _rolesData.find((r) => String(r.agent_code) === String(code))
        const name = role?.role_name || code
        const ok = await showConfirm(
          `将「${name}」归档？\n\n名册不再显示，历史事项保留；需要彻底移除可再删除。`,
        )
        if (!ok) return
        try {
          await api.proactiveArchiveRole(code)
          toast(`已归档 ${name}`, 'info')
          if (page) await loadAll(page)
        } catch (err) {
          toast(`归档失败: ${err?.message || err}`, 'error')
        }
        return
      }

      btn.disabled = true
      const prev = btn.textContent
      btn.textContent = '…'
      try {
        if (action === 'resume') {
          const role = _rolesData.find((r) => String(r.agent_code) === String(code))
          const wasDraft = role?.status === 'draft'
          const label = roleCardTitle(role) || code
          if (role) role.status = 'active'
          await api.proactiveResumeRole(code)
          toast(wasDraft ? `已确认上班 ${label}` : `已上班 ${label}`, 'success')
        }
      } catch (err) {
        toast(`操作失败: ${err?.message || err}`, 'error')
        btn.disabled = false
        btn.textContent = prev
      }
      if (page) {
        renderTabContent(page)
        void loadTabData(page)
      }
    })
  })

  if (!container._proMoreOutsideBound) {
    container._proMoreOutsideBound = true
    document.addEventListener('click', (e) => {
      if (!(e.target instanceof Element)) return
      if (e.target.closest('.pro-role-more')) return
      closeAllRoleMoreMenus(container)
    })
  }
}

function focusApprovalsTab(page, { updateHash = false } = {}) {
  _currentTab = 'approvals'
  page?.querySelectorAll('.pro-tab').forEach((t) =>
    t.classList.toggle('pro-tab--active', t.dataset.tab === 'approvals'),
  )
  if (updateHash) {
    const parts = ['tab=approvals']
    if (_highlightApprovalId) parts.push(`highlight=${encodeURIComponent(_highlightApprovalId)}`)
    else if (_highlightInitiativeId) {
      parts.push(`highlight_init=${encodeURIComponent(_highlightInitiativeId)}`)
    }
    try {
      const next = `#/proactive?${parts.join('&')}`
      if (String(window.location.hash || '') !== next) {
        window.history.replaceState(null, '', next)
      }
    } catch {
      /* ignore */
    }
  }
  if (page) renderTabContent(page)
}

function switchToApprovalsTab(page) {
  _tabPinnedByHash = true
  focusApprovalsTab(page, { updateHash: true })
}

// ── approvals tab ─────────────────────────────────────────

function renderApprovals(approvals, initiatives) {
  const pending = approvals.filter((a) => a.status === 'pending')
  const timedOutN = (initiatives || []).filter((i) => i.status === 'timeout_rejected').length
  const soonN = pending.filter((a) => {
    const u = approvalUrgency(a)
    return u.key === 'soon' || u.key === 'overdue'
  }).length

  if (!pending.length) {
    return `<div class="pro-empty">
      <p class="pro-empty-title">没有待你处理的审批</p>
      <p class="pro-empty-desc">新开员工任务默认会直接跑。这里常见的是交工后的<strong>转交审批</strong>（点「同意派发」叫醒下游），少数是事项「同意」。单岗多数时候这里是空的——属正常。也可在员工工作项详情里处理。${
        timedOutN
          ? `<br><span class="pro-approval-timeout-note">近段有 ${timedOutN} 项因超时未批已被自动拒绝，可在对应员工日志中查看</span>`
          : ''
      }</p>
    </div>`
  }

  const banner = `<div class="pro-approval-banner">
    <div>
      <strong>${pending.length} 项等待你审批</strong>
      <span>同意后才会派下一岗或执行；驳回请写明原因</span>
      <span class="pro-approval-keys">快捷键：<kbd>Y</kbd> 同意 · <kbd>N</kbd> 驳回 · <kbd>J</kbd> 下一条</span>
    </div>
    <div class="pro-approval-banner-stats">
      ${soonN ? `<span class="pro-urgency pro-urgency--soon">${soonN} 项临近/已超时</span>` : ''}
      ${timedOutN ? `<span class="pro-approval-timeout-note">历史超时拒 ${timedOutN}</span>` : ''}
    </div>
  </div>`

  return (
    banner +
    '<div class="pro-approval-list">' +
    pending
      .map((appr) => {
        const init = initiatives.find((i) => i.id === appr.initiative_id) || {}
        const kind = String(appr.kind || (appr.task_id ? 'handoff' : 'initiative')).toLowerCase()
        const isHandoff = kind === 'handoff' || kind === 'task'
        const isOrphan = Boolean(appr.orphan) || kind === 'orphan'
        const title =
          appr.initiative_title || init.title || appr.initiative_id
        const summary = String(appr.summary || '').trim()
        const desc = String(
          summary || appr.initiative_description || init.description || '',
        ).trim()
        const riskKey = appr.risk_level || init.risk_level || ''
        const risk = RISK_BADGE[riskKey] || { label: riskKey || '—', cls: 'pro-risk--low' }
        const code = appr.role_agent_code || init.role_agent_code || ''
        const roleName = appr.role_name || roleDisplayName(code)
        const channel = CHANNEL_LABEL[appr.channel] || appr.channel || '—'
        const actionKey = appr.action_type || init.action_type || ''
        const actionLabel = ACTION_TYPE_LABEL[actionKey] || actionKey || ''
        const urgency = approvalUrgency(appr)
        const ageMin = Math.round(approvalAgeMinutes(appr.created_at))
        const limit = Number(appr.approval_timeout_minutes) || Number(init.approval_timeout_minutes) || 30
        const ageLabel =
          ageMin < 60 ? `已等 ${ageMin} 分钟` : `已等 ${Math.round(ageMin / 60)} 小时`
        const isHighlight =
          (_highlightApprovalId && String(appr.id) === _highlightApprovalId) ||
          (_highlightInitiativeId && String(appr.initiative_id) === _highlightInitiativeId)
        const cardCls = [
          'pro-approval-card',
          isHandoff ? 'pro-approval-card--handoff' : '',
          isOrphan ? 'pro-approval-card--orphan' : '',
          urgency.key === 'soon' || urgency.key === 'overdue' ? 'pro-approval-card--urgent' : '',
          isHighlight ? 'pro-approval-card--highlight' : '',
        ]
          .filter(Boolean)
          .join(' ')
        const handlers = Array.isArray(appr.handlers) ? appr.handlers : []
        const nextLine = handlers
          .map((h) => {
            const ac = String(h?.agent_code || h?.assigned_to || '').trim()
            const label =
              String(h?.role || h?.role_name || h?.assigned_role || '').trim() ||
              roleDisplayName(ac) ||
              ac
            return label || ''
          })
          .filter(Boolean)
          .join('、')
        const outputs = filterDeliverableOutputs(
          Array.isArray(appr.outputs) ? appr.outputs : [],
        )
        const outputsHtml = outputs.length
          ? `<div class="pro-approval-outputs">
              <div class="pro-approval-outputs-title">交付产物</div>
              ${renderOutputItemCardsHtml(outputs, esc, { enablePreview: true })}
            </div>`
          : ''
        const approveLabel = isOrphan ? '关闭无效项' : isHandoff ? '同意派发' : '同意'
        const rejectLabel = isOrphan ? '丢弃' : '驳回'
        const kindChip = isOrphan
          ? '<span class="pro-meta-chip pro-meta-chip--warn">任务已删</span>'
          : isHandoff
            ? '<span class="pro-meta-chip pro-meta-chip--handoff">转交审批</span>'
            : '<span class="pro-meta-chip">事项审批</span>'
        return `
    <div class="${cardCls}" data-initiative-id="${esc(appr.initiative_id)}" data-approval-id="${esc(appr.id || '')}" data-kind="${esc(kind)}" data-approve-label="${esc(approveLabel)}" data-agent-code="${esc(code)}">
      <div class="pro-approval-head">
        <span class="pro-approval-title">${esc(title)}</span>
        <span class="pro-risk ${risk.cls}">${esc(risk.label)}</span>
        ${urgency.label ? `<span class="pro-urgency ${urgency.cls}">${esc(urgency.label)}</span>` : ''}
      </div>
      <div class="pro-approval-meta">
        ${kindChip}
        <span class="pro-meta-chip pro-meta-chip--role">${esc(roleName)}</span>
        ${actionLabel ? `<span class="pro-meta-chip">${esc(actionLabel)}</span>` : ''}
        <span>${esc(channel)}</span>
        <span>${esc(ageLabel)} · 时限 ${limit} 分钟</span>
        <span>${fmtTime(appr.created_at)}</span>
      </div>
      ${nextLine ? `<p class="pro-approval-next"><em>下一岗</em>${esc(nextLine)}</p>` : ''}
      ${desc ? `<p class="pro-approval-desc">${esc(desc)}</p>` : ''}
      ${outputsHtml}
      <div class="pro-approval-actions">
        ${
          code && !isOrphan
            ? `<button type="button" class="btn btn-sm btn-ghost" data-action="detail" data-id="${esc(appr.initiative_id)}" data-code="${esc(code)}" data-task="${esc(appr.task_id || '')}">查看详情</button>`
            : ''
        }
        ${
          isOrphan
            ? `<button type="button" class="btn btn-sm btn-danger" data-action="reject" data-id="${esc(appr.initiative_id)}">${esc(rejectLabel)}</button>`
            : `<button type="button" class="btn btn-sm btn-primary" data-action="approve" data-id="${esc(appr.initiative_id)}">${esc(approveLabel)}</button>
        <button type="button" class="btn btn-sm btn-danger" data-action="reject" data-id="${esc(appr.initiative_id)}">${esc(rejectLabel)}</button>`
        }
      </div>
      <div class="pro-reject-panel" hidden>
        <label class="pro-reject-label">${isOrphan ? '关闭说明（可改）' : '驳回原因（必填）'}</label>
        <textarea class="pro-reject-input" rows="2" placeholder="${isOrphan ? '任务已删除，关闭无效审批' : '例如：范围过大 / 风险低估 / 应先更新旧事项'}">${isOrphan ? '任务已删除，关闭无效审批' : ''}</textarea>
        <div class="pro-reject-actions">
          <button type="button" class="btn btn-sm btn-danger" data-action="reject-confirm" data-id="${esc(appr.initiative_id)}">确认${isOrphan ? '关闭' : '驳回'}</button>
          <button type="button" class="btn btn-sm btn-ghost" data-action="reject-cancel">取消</button>
        </div>
      </div>
    </div>`
      })
      .join('') +
    '</div>'
  )
}

function bindApprovals(container) {
  const page = container.closest('.proactive-page')

  const cards = [...container.querySelectorAll('.pro-approval-card')]
  let focusIdx = Math.max(
    0,
    cards.findIndex((c) => c.classList.contains('pro-approval-card--highlight')),
  )
  const setFocus = (idx) => {
    if (!cards.length) return
    focusIdx = ((idx % cards.length) + cards.length) % cards.length
    cards.forEach((c, i) => c.classList.toggle('pro-approval-card--kb-focus', i === focusIdx))
    cards[focusIdx]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }
  if (cards.length) setFocus(focusIdx >= 0 ? focusIdx : 0)

  const highlighted = container.querySelector('.pro-approval-card--highlight')
  if (highlighted) {
    requestAnimationFrame(() => {
      highlighted.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }

  const approveCard = async (card) => {
    const initId = card?.dataset?.initiativeId
    const btn = card?.querySelector('[data-action="approve"]')
    const approveLabel = card?.dataset?.approveLabel || '同意'
    if (!initId || !btn || btn.disabled) return
    btn.disabled = true
    btn.textContent = '…'
    try {
      await api.proactiveApprove(initId, 'approved', 'user', '')
      const kind = String(card?.dataset?.kind || '')
      toast(kind === 'handoff' || kind === 'task' ? '已同意派发' : '已同意', 'success')
      card.remove()
      if (page) await loadTabData(page)
    } catch (e) {
      toast(`审批失败: ${e}`, 'error')
      btn.disabled = false
      btn.textContent = approveLabel
    }
  }

  const openReject = (card) => {
    const panel = card?.querySelector('.pro-reject-panel')
    if (panel) panel.hidden = false
    panel?.querySelector('.pro-reject-input')?.focus()
  }

  if (!page?._proApprovalKeysBound) {
    page._proApprovalKeysBound = true
    // Listen on document: the page shell rarely holds focus.
    const onKey = (e) => {
      if (!page.isConnected || _currentTab !== 'approvals') return
      const tag = (e.target && e.target.tagName) || ''
      if (tag === 'TEXTAREA' || tag === 'INPUT' || e.target?.isContentEditable) {
        if (e.key === 'Escape') {
          const panel = e.target.closest?.('.pro-reject-panel')
          if (panel) {
            panel.hidden = true
            e.preventDefault()
          }
        }
        return
      }
      const liveCards = [...page.querySelectorAll('.pro-approval-card')]
      if (!liveCards.length) return
      const focused =
        liveCards.find((c) => c.classList.contains('pro-approval-card--kb-focus')) ||
        liveCards.find((c) => c.classList.contains('pro-approval-card--highlight')) ||
        liveCards[0]
      const idx = Math.max(0, liveCards.indexOf(focused))
      const key = String(e.key || '').toLowerCase()
      if (key === 'y') {
        e.preventDefault()
        void approveCard(focused)
      } else if (key === 'n') {
        e.preventDefault()
        openReject(focused)
      } else if (key === 'j') {
        e.preventDefault()
        const next = liveCards[(idx + 1) % liveCards.length]
        liveCards.forEach((c) => c.classList.remove('pro-approval-card--kb-focus'))
        next?.classList.add('pro-approval-card--kb-focus')
        next?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }
    }
    document.addEventListener('keydown', onKey)
    page._proApprovalKeyHandler = onKey
  }

  container.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action
      const initId = btn.dataset.id
      const card = btn.closest('.pro-approval-card')

      if (action === 'detail') {
        const code = btn.dataset.code
        const taskId = String(btn.dataset.task || '').trim()
        if (taskId) {
          navigate(`/task/${encodeURIComponent(taskId)}`)
          return
        }
        if (code && initId) {
          navigate(`/proactive/${encodeURIComponent(code)}/item/${encodeURIComponent(initId)}`)
        }
        return
      }

      if (action === 'reject') {
        openReject(card)
        return
      }

      if (action === 'reject-cancel') {
        const panel = card?.querySelector('.pro-reject-panel')
        if (panel) {
          panel.hidden = true
          const ta = panel.querySelector('.pro-reject-input')
          if (ta) ta.value = ''
        }
        return
      }

      if (action === 'reject-confirm') {
        const panel = card?.querySelector('.pro-reject-panel')
        const reason = String(panel?.querySelector('.pro-reject-input')?.value || '').trim()
        if (!reason) {
          toast('请填写驳回原因', 'warning')
          panel?.querySelector('.pro-reject-input')?.focus()
          return
        }
        btn.disabled = true
        btn.textContent = '…'
        try {
          await api.proactiveApprove(initId, 'rejected', 'user', reason, reason)
          toast('已驳回', 'info')
          if (card) card.remove()
          if (page) await loadTabData(page)
        } catch (e) {
          toast(`审批失败: ${e}`, 'error')
          btn.disabled = false
          btn.textContent = '确认驳回'
        }
        return
      }

      if (action === 'approve') {
        await approveCard(card)
      }
    })
  })

  bindTaskOutputCardActions(container, {})
}

export function cleanup() {
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null }
  if (_busyPollTimer) { clearInterval(_busyPollTimer); _busyPollTimer = null }
  if (_rosterLiveMount) {
    try { _rosterLiveMount.destroy() } catch { /* ignore */ }
    _rosterLiveMount = null
  }
  try {
    const page = document.querySelector('.pro-page, .page')
    page?._xmLiveUnsub?.()
  } catch {
    /* ignore */
  }
}
