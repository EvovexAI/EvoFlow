/**
 * 角色卡片、编辑/详情弹窗 — 供智能体列表页使用
 */
import { api } from '../lib/tauri-api.js'
import { toast } from '../components/toast.js'
import { showConfirm } from '../components/modal.js'
import { navigate } from '../router.js'
import { startFeishuEmployeeScan, hireAndBindFeishu, feishuBindingOf } from '../lib/feishu-employee-bind.js'
import {
  BUILTIN_AGENT_TAGS,
  agentCapabilityTags,
  agentDeployKindOf,
  agentRunStatusOf,
  agentTypeLabelOf,
  escapeHtml,
  escapeAttr,
  filterAgentsList,
  normalizeAgentTags,
  parseTagsInput,
  runStatusClass,
  runStatusLabel,
  sortAgentsList,
  tagMetaForLabel,
} from './agents-shared.js'
import { mountAgentAvatar, mountAgentAvatarPicker } from '../lib/mount-agent-ui.js'
import { getGatewayBaseUrl } from '../lib/tauri-api.js'
import { filterChatModels } from '../lib/model-classification.js'
import {
  loadWorkspacePaths,
  renderWorkspaceFieldOnly,
  bindWorkspaceSelect,
  readWorkspacePath,
} from '../lib/workspace-field-ui.js'
import { createSchedulePanel } from '../lib/schedule-panel.js'
import {
  bindListPager,
  renderListPagerHtml,
  writeStoredPageSize,
} from '../components/list-pager.js'

const AGENTS_PAGE_SIZE_KEY = 'evopanel_agents_page_size'

/** @typedef {{ name: string, display: string }} AgentModelOption */

/**
 * Load chat models + primary for agent default-model picker.
 * @returns {Promise<{ models: AgentModelOption[], primary: string }>}
 */
async function loadAgentDefaultModelOptions() {
  let primary = ''
  try {
    const info = await api.getPrimaryModel()
    primary = String(info?.primary_model || '').trim()
  } catch {
    /* ignore */
  }
  const models = []
  const seen = new Set()
  try {
    const data = await api.listModels()
    const rows = Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : []
    for (const m of filterChatModels(rows)) {
      const name = String(m?.name || '').trim()
      if (!name || seen.has(name)) continue
      seen.add(name)
      const display = String(m?.display_name || name).trim() || name
      models.push({ name, display })
    }
  } catch {
    /* ignore */
  }
  if (primary && !seen.has(primary)) {
    models.unshift({ name: primary, display: primary })
  }
  return { models, primary }
}

/**
 * @param {string | null | undefined} agentModel
 * @param {string} primary
 */
function formatAgentModelFollowLabel(agentModel, primary) {
  const m = String(agentModel || '').trim()
  if (m) return m
  const p = String(primary || '').trim()
  return p ? `跟随全局默认（${p}）` : '跟随全局默认'
}

/**
 * @param {{ selected?: string, models?: AgentModelOption[], primary?: string, disabled?: boolean }} opts
 */
function renderAgentDefaultModelField(opts = {}) {
  const selected = String(opts.selected || '').trim()
  const models = Array.isArray(opts.models) ? opts.models : []
  const primary = String(opts.primary || '').trim()
  const disabled = !!opts.disabled
  const followLabel = primary ? `跟随全局默认（${primary}）` : '跟随全局默认'
  const orphan =
    selected && !models.some((m) => m.name === selected)
      ? `<option value="${escapeAttr(selected)}" selected>${escapeHtml(selected)}（当前，未在目录中）</option>`
      : ''
  const options = models
    .map((m) => {
      const on = m.name === selected ? ' selected' : ''
      const label = m.display && m.display !== m.name ? `${m.display}（${m.name}）` : m.display || m.name
      return `<option value="${escapeAttr(m.name)}"${on}>${escapeHtml(label)}</option>`
    })
    .join('')
  return `
    <div class="form-group">
      <label class="form-label">默认模型</label>
      <select class="form-input re-field-model" ${disabled ? 'disabled' : ''}>
        <option value="" ${selected ? '' : 'selected'}>${escapeHtml(followLabel)}</option>
        ${orphan}
        ${options}
      </select>
      <div class="form-hint">新对话与「跟随智能体」的会话使用此模型；单次对话可在聊天里临时更换，不会改这里的设置。</div>
    </div>`
}

/** @param {ParentNode | null | undefined} root */
function readAgentDefaultModel(root) {
  const el = root?.querySelector?.('.re-field-model')
  if (!el || el.disabled) return undefined
  return String(el.value || '').trim()
}

let _gatewayBaseCache = ''
async function gatewayBaseForAvatars() {
  if (!_gatewayBaseCache) {
    try { _gatewayBaseCache = await getGatewayBaseUrl() } catch { _gatewayBaseCache = '' }
  }
  return _gatewayBaseCache
}

function mountRoleCardAvatars(container, agents, size = 44) {
  if (!container) return
  void gatewayBaseForAvatars().then((baseUrl) => {
    container.querySelectorAll('[data-avatar-agent]').forEach((el) => {
      const code = el.getAttribute('data-avatar-agent')
      const agent = agents.find((a) => a.agent_code === code)
      if (!code) return
      mountAgentAvatar(el, { agent: agent || { agent_code: code }, agentCode: code, size, baseUrl })
    })
  })
}

function capabilityStatLabels(agent, state) {
  if (agentUsesExternalCli(agent)) {
    return [
      { label: '外部 CLI', tip: '能力由本机运行时提供' },
      { label: '工具/技能由 CLI' },
    ]
  }
  const toolsTag = formatAgentToolsCardTag(agent, state?.toolsMeta)
  const mcpCount = Array.isArray(agent.mcp_servers) ? agent.mcp_servers.length : null
  const skillsCount = Array.isArray(agent.skills) ? agent.skills.length : 0
  const out = []
  if (toolsTag) out.push({ label: toolsTag.text, tip: '内置工具' })
  out.push({
    label: mcpCount === null ? '全 MCP' : `${mcpCount} MCP`,
    tip: 'MCP 服务',
  })
  out.push({
    label: skillsCount > 0 ? `${skillsCount} 技能` : '无技能',
    tip: '技能模块',
  })
  return out
}

function renderAgentSheetHero(agent, id, { hired = false, stats = [] } = {}) {
  const name = agent.agent_name || id
  const desc = agent.description || '暂无描述'
  return `
    <div class="agent-sheet-hero">
      <div class="agent-sheet-hero-avatar role-avatar-mount" data-avatar-agent="${escapeAttr(id)}"></div>
      <div class="agent-sheet-hero-text">
        <p class="agent-sheet-kicker">智能体${hired ? ' · 在岗员工' : ''}</p>
        <h2 class="agent-sheet-title">${escapeHtml(name)}</h2>
        <p class="agent-sheet-code"><code>${escapeHtml(id)}</code>${(() => {
          const badges = formatAgentTypeBadgesHtml(agent, id)
          return badges ? ` · ${badges}` : ''
        })()}</p>
        <p class="agent-sheet-desc">${escapeHtml(desc)}</p>
        ${
          stats.length
            ? `<div class="agent-sheet-stats">${stats
                .map(
                  (s) =>
                    `<span class="agent-sheet-stat" title="${escapeAttr(s.tip || '')}">${escapeHtml(s.label)}</span>`,
                )
                .join('')}</div>`
            : ''
        }
      </div>
    </div>
  `
}

// 工具元数据缓存（从后端动态加载）
let _toolsMetadata = null

/**
 * 根据技能名称关键词匹配图标 emoji
 * 技能目录没有自带 icon 字段，所以用关键词映射
 */
const SKILL_ICON_MAP = [
  [/pdf|docx|word|document/i, '📄'],
  [/xlsx|excel|sheet|spreadsheet/i, '📊'],
  [/pptx|powerpoint|slide|presentation/i, '📽️'],
  [/image|img|photo|picture|pic|draw|paint|canvas|svg|design/i, '🎨'],
  [/video|remotion|movie|film|media/i, '🎬'],
  [/audio|sound|music|tts|voice|whisper|speech/i, '🎵'],
  [/git|github|commit|repo|code|coding|dev/i, '💻'],
  [/search|web|scrape|crawl|fetch|browse/i, '🔍'],
  [/chat|agent|bot|ai|gpt|claude|gemini|openai/i, '🤖'],
  [/mail|email|imap|smtp|outlook/i, '📧'],
  [/weather|forecast/i, '🌤️'],
  [/map|location|geo|place/i, '🗺️'],
  [/file|upload|download|drive|storage|cloud/i, '☁️'],
  [/translate|lang|i18n|locale/i, '🌐'],
  [/stock|finance|trade|money|price/i, '💰'],
  [/game|play|gaming/i, '🎮'],
  [/note|notion|obsidian|write|doc|wiki|md|markdown/i, '📝'],
  [/calendar|schedule|meeting|event|date|time/i, '📅'],
  [/security|auth|pass|key|secret|encrypt|1password/i, '🔐'],
  [/deploy|server|host|docker|vercel|infra/i, '🚀'],
  [/data|analysis|analytics|report|chart|graph/i, '📈'],
  [/skill|creator|architect|manager|lint|vetter/i, '🧩'],
  [/test|qa|quality|check|health|monitor/i, '✅'],
  [/social|weixin|wechat|weibo|twitter|xhs|redbook|douyin|bilibili|tiktok|discord|slack/i, '📱'],
  [/feishu|wecom|dingtalk|lark/i, '💼'],
  [/travel|flight|hotel|trip|ctrip/i, '✈️'],
  [/food|recipe|cook|restaurant|dine|meal/i, '🍽️'],
]

/** 默认技能图标 */
const DEFAULT_SKILL_ICON = '⚡'

function getSkillIcon(name) {
  if (!name) return DEFAULT_SKILL_ICON
  for (const [regex, icon] of SKILL_ICON_MAP) {
    if (regex.test(name)) return icon
  }
  return DEFAULT_SKILL_ICON
}

/** Same ``name`` can appear under ``public/x`` and ``public/mbb-skills/x``; keep one row for checklists. */
function dedupeSkillMetaRows(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return rows || []
  const seen = new Set()
  const out = []
  for (const r of rows) {
    const v = String(r?.value ?? '').trim()
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(r)
  }
  return out
}

/** 角色编辑器可配置 tier（与后端 ``ROLE_EDITOR_CONFIGURABLE_TOOL_TIERS`` 一致） */
const ROLE_EDITOR_CONFIGURABLE_TIERS = new Set(['workspace', 'optional'])

function filterRoleEditorTools(tools) {
  return (tools || []).filter((t) => ROLE_EDITOR_CONFIGURABLE_TIERS.has(t.tier || 'optional'))
}

function intersectRoleEditorToolValues(selectedValues, configurableTools) {
  const allowed = new Set((configurableTools || []).map((t) => t.value))
  return (selectedValues || []).filter((v) => allowed.has(v))
}

function isXiaomiFrontDesk(agent) {
  const code = String(agent?.agent_code || agent?.name || '').trim().toLowerCase()
  return code === 'xiaomi'
}

/** 与卡片 / 详情 / 编辑器共用的可配置工具计数 */
function resolveAgentConfigurableTools(agent, metaTools) {
  const catalog = metaTools || []
  // 小V：系统前台，不挂角色可配置工具（运行时另挂 xiaomi_*）
  if (isXiaomiFrontDesk(agent)) {
    return { selected: [], isAll: false, total: catalog.length, frontDesk: true }
  }
  if (!Array.isArray(agent?.tools)) {
    const all = catalog.map((t) => t.value)
    return { selected: all, isAll: true, total: catalog.length }
  }
  const selected = intersectRoleEditorToolValues(agent.tools, catalog)
  return {
    selected,
    isAll: selected.length === catalog.length && catalog.length > 0,
    total: catalog.length,
  }
}

function formatAgentToolsCardTag(agent, metaTools) {
  if (isXiaomiFrontDesk(agent)) {
    return { text: '前台工具', dim: true }
  }
  const { selected, isAll, total } = resolveAgentConfigurableTools(agent, metaTools)
  if (!total) {
    if (!Array.isArray(agent?.tools)) return { text: '全工具', dim: true }
    return { text: `${selected.length} 工具`, dim: false }
  }
  if (isAll) return { text: `${total} 工具`, dim: true }
  return { text: `${selected.length} 工具`, dim: false }
}

/** 预加载角色卡片用的可配置工具元数据 */
export async function preloadRoleToolsMeta(state) {
  try {
    const meta = await getToolsMetadata()
    state.toolsMeta = filterRoleEditorTools((meta.tools || []).map(mapApiToolMeta))
  } catch (_) {
    state.toolsMeta = []
  }
  return state.toolsMeta
}

/** 角色编辑器分组（workspace → Agent，与后端 ``role_editor_tier_label_zh`` 一致） */
const ROLE_EDITOR_TIER_ORDER = ['workspace', 'optional']

const ROLE_EDITOR_TIER_LABELS = {
  workspace: 'Agent',
  optional: '扩展可选',
}

/** 与后端 ``tool_catalog.py`` / ``/tools/metadata`` 一致（DB / 工具页） */
const TOOL_TIER_ORDER = ['runtime', 'core', 'workspace', 'plan', 'goal', 'optional']

const TOOL_TIER_LABEL_FALLBACK = {
  runtime: '系统核心',
  core: '日常常驻',
  workspace: '工作区',
  plan: '规划协作',
  goal: '目标模式',
  optional: '扩展可选',
  retired: '已退役',
}

const TOOL_SEARCH_ALIASES = {
  panel_set: 'panel set 右侧面板 非 mode_set 资讯 网页内嵌 web-embed 热榜 写入 write',
  mode_set: 'mode set 模式切换 ask agent plan 非 panel_set 场景',
  scenario: 'mode set 模式切换 旧名',
  session_workspace: '工作空间 workspace 目录',
}

function mapApiToolMeta(t) {
  const tier = t?.tool_type || 'optional'
  const aliases = TOOL_SEARCH_ALIASES[t?.name || ''] || ''
  return {
    value: t.name,
    label: t.label || t.name,
    icon: t.icon || '',
    desc: t.description || '',
    tier,
    typeLabel: t.role_editor_type_label || ROLE_EDITOR_TIER_LABELS[tier] || t.tool_type_label || TOOL_TIER_LABEL_FALLBACK[tier] || '',
    searchAliases: aliases,
  }
}

function groupRoleEditorToolsByTier(tools) {
  const buckets = new Map()
  for (const t of tools || []) {
    const tier = t.tier || 'optional'
    if (!buckets.has(tier)) buckets.set(tier, [])
    buckets.get(tier).push(t)
  }
  return ROLE_EDITOR_TIER_ORDER.filter((k) => buckets.has(k)).map((tier) => ({
    tier,
    label: ROLE_EDITOR_TIER_LABELS[tier] || tier,
    tools: buckets.get(tier),
  }))
}

function renderToolTypeBadge(t) {
  if (!t?.typeLabel) return ''
  return `<span class="re-tool-type" title="工具类型">${escapeHtml(t.typeLabel)}</span>`
}

function renderToolCheckRow(t, { checked = false, readonly = false } = {}) {
  const badge = renderToolTypeBadge(t)
  const searchKey = `${t.value} ${t.label} ${t.desc || ''} ${t.typeLabel || ''} ${t.searchAliases || ''}`.toLowerCase()
  if (readonly) {
    return `<div class="re-check" data-search="${escapeAttr(searchKey)}">
      <span class="re-ci-icon">${t.icon || '⚙'}</span>
      <span class="re-ci-text"><strong>${escapeHtml(t.label)}</strong>${t.desc ? `<small>${escapeHtml(t.desc)}</small>` : ''}</span>
      ${badge}
      <span class="re-check-ok">✓</span>
    </div>`
  }
  return `<label class="re-check" data-search="${escapeAttr(searchKey)}">
    <input type="checkbox" name="tools" value="${escapeAttr(t.value)}" ${checked ? 'checked' : ''}>
    <span class="re-ci-icon">${t.icon || '⚙'}</span>
    <span class="re-ci-text">
      <strong>${escapeHtml(t.label)}</strong>
      ${t.desc ? `<small>${escapeHtml(t.desc)}</small>` : ''}
    </span>
    ${badge}
  </label>`
}

function renderToolsEditorGrid(tools, selectedValues) {
  const selected = new Set(selectedValues || [])
  const groups = groupRoleEditorToolsByTier(tools)
  if (!groups.length) return '<div class="re-empty">暂无可用工具</div>'
  return groups
    .map(
      (g) => `
    <div class="re-tool-tier">
      <div class="re-tool-tier-head">${escapeHtml(g.label)} <span class="re-tool-tier-count">${g.tools.length}</span></div>
      ${g.tools.map((t) => renderToolCheckRow(t, { checked: selected.has(t.value) })).join('')}
    </div>`,
    )
    .join('')
}

function renderToolsDetailGrid(tools, activeValues, isAll) {
  const active = new Set(activeValues || [])
  const list = isAll ? tools : tools.filter((t) => active.has(t.value))
  const groups = groupRoleEditorToolsByTier(list)
  if (!groups.length) {
    if (!isAll && active.size === 0) return '<div class="re-empty">未配置具体工具（使用默认工具集）</div>'
    return '<div class="re-empty">暂无可用工具</div>'
  }
  return groups
    .map(
      (g) => `
    <div class="re-tool-tier">
      <div class="re-tool-tier-head">${escapeHtml(g.label)}</div>
      ${g.tools.map((t) => renderToolCheckRow(t, { readonly: true })).join('')}
    </div>`,
    )
    .join('')
}

/**
 * 获取工具/MCP/技能元数据（带缓存）
 */
async function getToolsMetadata() {
  if (_toolsMetadata) return _toolsMetadata
  try {
    const data = await api.getToolsMetadata()
    _toolsMetadata = data
    console.log('[角色] 工具元数据:', data.tools?.length, '个工具,', data.mcp_servers?.length, '个MCP,', data.skills?.length, '个技能')
    return data
  } catch (e) {
    console.warn('[角色] 获取工具元数据失败，使用 fallback:', e)
    return { tools: [], mcp_servers: [], skills: [] }
  }
}

/** Claude Code 等外部 CLI：工具/MCP/技能由本机运行时提供，不在面板里配置 */
export function agentUsesExternalCli(agent) {
  return agent?.requires_external_cli === true
}

export function renderRoleSkeleton(container) {
  container.innerHTML = Array.from({ length: 4 }, () => `
    <div class="role-card skeleton-card">
      <div class="role-card-top">
        <div class="skeleton-avatar"></div>
        <div class="skeleton-lines">
          <div class="skeleton-line w50"></div>
          <div class="skeleton-line w70"></div>
        </div>
      </div>
      <div class="role-card-tags">
        <div class="skeleton-tag"></div>
        <div class="skeleton-tag short"></div>
      </div>
      <div class="role-card-bottom">
        <div class="skeleton-btn"></div>
        <div class="skeleton-btn"></div>
        <div class="skeleton-btn"></div>
      </div>
    </div>
  `).join('')
}

function agentCtx(state) {
  return {
    hiredCodes: state.hiredCodes,
    hiredRolesByCode: state.hiredRolesByCode,
    appAgentCodes: state.appAgentCodes,
    automationAgentCodes: state.automationAgentCodes,
  }
}

function toolsCountLabel(agent, state) {
  if (agentUsesExternalCli(agent)) return null
  const tag = formatAgentToolsCardTag(agent, state.toolsMeta)
  return tag?.text || null
}

function mcpStatusLabel(agent) {
  if (agentUsesExternalCli(agent) || isXiaomiFrontDesk(agent)) return 'MCP —'
  if (!Array.isArray(agent.mcp_servers)) return 'MCP 全部'
  if (agent.mcp_servers.length === 0) return 'MCP 未连接'
  return 'MCP 已连接'
}

/**
 * 主操作：按状态优先级
 * 配置异常 > 离线 > 默认助手 > 员工 > 应用 > 自动化/未部署
 */
export function resolvePrimaryAction(agent, state) {
  const code = String(agent?.agent_code || '').trim()
  const ctx = agentCtx(state)
  const run = agentRunStatusOf(agent, ctx)
  const deploy = agentDeployKindOf(agent, ctx)
  const isDefault = code === 'main' || agent?.isDefault

  if (run === 'error') {
    return { action: 'fix-config', label: '修复配置', className: 'role-btn--primary' }
  }
  if (run === 'offline') {
    return { action: 'start-runtime', label: '启动', className: 'role-btn--primary' }
  }
  if (isDefault) {
    return { action: 'start-chat', label: '开始对话', className: 'role-btn--primary' }
  }
  if (deploy === 'employee') {
    return { action: 'open-duty', label: '打开值班台', className: 'role-btn--hired' }
  }
  if (deploy === 'app') {
    return { action: 'open-app', label: '打开工作流', className: 'role-btn--primary' }
  }
  if (deploy === 'automation') {
    return { action: 'open-automation', label: '打开自动化', className: 'role-btn--primary' }
  }
  return { action: 'hire', label: '部署', className: 'role-btn--hire' }
}

// ========== 渲染角色卡片 ==========
export function renderRoleCards(page, state, _tagFilter) {
  const container = page.querySelector('#roles-list')
  const pagerWrap = page.querySelector('#roles-list-pager')
  const countEl = page.querySelector('#roles-count')
  if (!container) return

  const ctx = agentCtx(state)
  const filtered = filterAgentsList(state.agents || [], state, ctx)
  const list = sortAgentsList(filtered, state.sortKey || 'recent')

  if (countEl) countEl.textContent = `共 ${list.length} 个智能体`

  if (!list.length) {
    const emptyHint =
      state.view === 'market'
        ? '暂无模板，可从 SkillHub 安装专家包'
        : state.view === 'deployed'
          ? '暂无已部署智能体'
          : state.filter || state.statusFilter || state.purposeFilter || state.sourceFilter || state.deployFilter || (state.tagFilters || []).length
            ? '没有匹配的智能体'
            : '暂无智能体'
    container.innerHTML = `<div class="role-empty"><span>${escapeHtml(emptyHint)}</span></div>`
    if (pagerWrap) pagerWrap.innerHTML = ''
    return
  }

  const pageSize = Math.max(1, Number(state.pageSize) || 20)
  let pageNo = Math.max(1, Number(state.page) || 1)
  const pageCount = Math.max(1, Math.ceil(list.length / pageSize) || 1)
  if (pageNo > pageCount) {
    pageNo = pageCount
    state.page = pageNo
  }
  const start = (pageNo - 1) * pageSize
  const pageList = list.slice(start, start + pageSize)

  const selectedId = String(state.selectedId || '').trim()

  container.innerHTML = pageList
    .map((a) => {
      const code = String(a.agent_code || '').trim()
      const isDefault = a.isDefault || code === 'main'
      const hired = ctx.hiredRolesByCode?.get(code)
      // 已上岗：签名用岗位显示名；否则用智能体中文名
      const name =
        String(hired?.role_name || a.agent_name || code || '-')
          .trim() || '-'
      const desc = a.description || '暂无描述'
      const run = agentRunStatusOf(a, ctx)
      const typeLabel = agentTypeLabelOf(a)
      const caps = agentCapabilityTags(a, 3)
      const toolsLabel = toolsCountLabel(a, state)
      const skillsCount = Array.isArray(a.skills) ? a.skills.length : 0
      const mcpLabel = mcpStatusLabel(a)
      const primary = resolvePrimaryAction(a, state)
      const cliMissing = a.requires_external_cli === true && a.external_cli_available === false
      const selected = selectedId && selectedId === code

      const resourceParts = []
      if (toolsLabel) resourceParts.push(escapeHtml(toolsLabel))
      resourceParts.push(skillsCount > 0 ? `${skillsCount} 个技能` : '无技能')
      resourceParts.push(escapeHtml(mcpLabel))

      return `
      <article
        class="role-card${cliMissing ? ' role-card--unavailable' : ''}${selected ? ' role-card--selected' : ''}"
        data-id="${escapeAttr(code)}"
        id="role-card-${escapeAttr(code)}"
        data-action="open-drawer"
        tabindex="0"
      >
        <header class="role-card-header">
          <div class="role-avatar-mount" data-avatar-agent="${escapeAttr(code)}"></div>
          <div class="role-card-heading">
            <div class="role-name-row">
              <span class="role-name">${escapeHtml(name)}</span>
              <button
                type="button"
                class="role-status ${runStatusClass(run)}"
                data-action="show-status"
                data-id="${escapeAttr(code)}"
                title="查看运行状态"
              >${escapeHtml(runStatusLabel(run))}</button>
            </div>
            ${
              typeLabel
                ? `<div class="role-card-sub"><span class="role-type-label">${escapeHtml(typeLabel)}</span></div>`
                : ''
            }
          </div>
        </header>

        <p class="role-desc-text">${escapeHtml(desc)}</p>

        <div class="role-cap-row">
          ${caps.shown
            .map((label) => {
              const meta = tagMetaForLabel(label)
              return `<button type="button" class="role-cap-chip" data-action="filter-capability" data-tag="${escapeAttr(label)}" style="--tag-color:${meta.color}">${escapeHtml(label)}</button>`
            })
            .join('')}
          ${caps.extra > 0 ? `<span class="role-cap-more">+${caps.extra}</span>` : ''}
        </div>

        <div class="role-card-foot">
          <div class="role-resource-line">${resourceParts.join(' · ')}</div>
          <div class="role-card-foot-end">
            <button type="button" class="role-btn ${primary.className}" data-action="${escapeAttr(primary.action)}" data-id="${escapeAttr(code)}">${escapeHtml(primary.label)}</button>
            <div class="role-more-wrap">
              <button type="button" class="role-more-btn" data-action="toggle-more" data-id="${escapeAttr(code)}" aria-label="更多操作" title="更多">…</button>
              <div class="role-more-menu" hidden data-more-menu="${escapeAttr(code)}">
                <button type="button" data-action="detail" data-id="${escapeAttr(code)}">详情</button>
                <button type="button" data-action="edit" data-id="${escapeAttr(code)}">编辑</button>
                ${
                  !isDefault
                    ? `<button type="button" data-action="feishu-connect" data-id="${escapeAttr(code)}">接到飞书</button>`
                    : ''
                }
                <button type="button" data-action="copy" data-id="${escapeAttr(code)}">复制</button>
                <button type="button" data-action="export" data-id="${escapeAttr(code)}">导出</button>
                ${!isDefault ? `<button type="button" class="is-danger" data-action="delete" data-id="${escapeAttr(code)}">删除</button>` : ''}
              </div>
            </div>
          </div>
        </div>
      </article>`
    })
    .join('')

  mountRoleCardAvatars(container, pageList)

  if (pagerWrap) {
    const from = start + 1
    const to = start + pageList.length
    pagerWrap.innerHTML = renderListPagerHtml({
      total: list.length,
      page: pageNo,
      pageCount,
      pageSize,
      from,
      to,
      unit: '个',
    })
    bindListPager(pagerWrap, {
      page: pageNo,
      pageCount,
      onPage: (next) => {
        state.page = next
        renderRoleCards(page, state)
      },
      onPageSize: (nextSize) => {
        state.pageSize = nextSize
        state.page = 1
        writeStoredPageSize(AGENTS_PAGE_SIZE_KEY, nextSize)
        renderRoleCards(page, state)
      },
    })
  }
}

export function closeAgentDetailDrawer(page) {
  const root = page?.querySelector('#roleDrawer')
  if (!root) return
  root.hidden = true
  const body = page.querySelector('#roleDrawerBody')
  const foot = page.querySelector('#roleDrawerFoot')
  if (body) body.innerHTML = ''
  if (foot) foot.innerHTML = ''
}

async function openAgentDetailDrawer(page, state, id) {
  const root = page.querySelector('#roleDrawer')
  const titleEl = page.querySelector('#roleDrawerTitle')
  const subEl = page.querySelector('#roleDrawerSubtitle')
  const body = page.querySelector('#roleDrawerBody')
  const foot = page.querySelector('#roleDrawerFoot')
  if (!root || !body || !foot) {
    await showRoleDetailDialog(id, page, state)
    return
  }

  state.selectedId = id
  page.querySelectorAll('.role-card').forEach((el) => {
    el.classList.toggle('role-card--selected', el.dataset.id === id)
  })

  root.hidden = false
  if (titleEl) titleEl.textContent = '加载中…'
  if (subEl) subEl.textContent = ''
  body.innerHTML = '<div class="role-drawer-loading">加载详情…</div>'
  foot.innerHTML = ''

  try {
    const agent = await api.getAgent(id)
    let primaryModel = ''
    try {
      const info = await api.getPrimaryModel()
      primaryModel = String(info?.primary_model || '').trim()
    } catch {
      /* ignore */
    }
    const ctx = agentCtx(state)
    const run = agentRunStatusOf(agent, ctx)
    const deploy = agentDeployKindOf(agent, ctx)
    const role = state.hiredRolesByCode?.get(id)
    const appMeta = state.appAgentCodes instanceof Map ? state.appAgentCodes.get(id) : null
    const name = String(role?.role_name || agent.agent_name || id).trim() || id
    const toolsTag = agentUsesExternalCli(agent) ? null : formatAgentToolsCardTag(agent, state.toolsMeta)
    const skills = Array.isArray(agent.skills) ? agent.skills : []
    const mcps = Array.isArray(agent.mcp_servers) ? agent.mcp_servers : null
    const caps = agentCapabilityTags(agent, 8)
    const primary = resolvePrimaryAction(agent, state)

    if (titleEl) titleEl.textContent = name
    if (subEl) {
      const typeLabel = agentTypeLabelOf(agent)
      subEl.innerHTML = typeLabel
        ? `<span class="role-type-label">${escapeHtml(typeLabel)}</span> · <span class="role-status ${runStatusClass(run)}">${escapeHtml(runStatusLabel(run))}</span>`
        : `<span class="role-status ${runStatusClass(run)}">${escapeHtml(runStatusLabel(run))}</span>`
    }
    const markEl = root.querySelector('.ef-side-drawer__mark')
    if (markEl) markEl.textContent = String(name || '员').trim().slice(0, 1) || '员'

    const deployText =
      deploy === 'employee'
        ? `员工岗位：${role?.role_name || id}`
        : deploy === 'app'
          ? `工作流：${appMeta?.appName || appMeta?.appId || '已关联工作流'}`
          : deploy === 'automation'
            ? '已用于自动化规则'
            : '未部署'

    body.innerHTML = `
      <section class="ef-side-drawer__section role-drawer-section">
        <h4>基本信息</h4>
        <dl class="role-drawer-dl">
          <div><dt>标识</dt><dd><code>${escapeHtml(id)}</code></dd></div>
          <div><dt>类型</dt><dd>${escapeHtml(agentTypeLabelOf(agent) || '—')}</dd></div>
          <div><dt>运行状态</dt><dd>${escapeHtml(runStatusLabel(run))}</dd></div>
          <div><dt>来源</dt><dd>${escapeHtml(
            normalizeAgentTags(agent.tags).some((t) => /skillhub/i.test(t))
              ? 'SkillHub'
              : agent.agent_type === 'subagent' || id === 'main'
                ? '系统'
                : '—',
          )}</dd></div>
        </dl>
      </section>
      <section class="ef-side-drawer__section role-drawer-section">
        <h4>主要职责</h4>
        <p>${escapeHtml(agent.description || '暂无描述')}</p>
      </section>
      <section class="ef-side-drawer__section role-drawer-section">
        <h4>模型与参数</h4>
        <dl class="role-drawer-dl">
          <div><dt>默认模型</dt><dd>${escapeHtml(formatAgentModelFollowLabel(agent.model, primaryModel))}</dd></div>
        </dl>
        ${agent.system_prompt ? `<pre class="role-drawer-pre">${escapeHtml(agent.system_prompt)}</pre>` : ''}
      </section>
      <section class="ef-side-drawer__section role-drawer-section">
        <h4>工具与技能</h4>
        <p>${escapeHtml(toolsTag?.text || (agentUsesExternalCli(agent) ? '由外部 CLI 提供' : '—'))} · ${skills.length} 个技能</p>
        ${
          caps.all.length
            ? `<div class="role-drawer-tags">${caps.all
                .map((t) => `<span class="role-cap-chip role-cap-chip--static">${escapeHtml(t)}</span>`)
                .join('')}</div>`
            : ''
        }
        ${
          skills.length
            ? `<ul class="role-drawer-list">${skills
                .slice(0, 12)
                .map((s) => `<li>${escapeHtml(s)}</li>`)
                .join('')}${skills.length > 12 ? `<li>…另有 ${skills.length - 12} 个</li>` : ''}</ul>`
            : ''
        }
      </section>
      <section class="ef-side-drawer__section role-drawer-section">
        <h4>连接器</h4>
        <p>${
          mcps === null
            ? '可使用全部已配置 MCP'
            : mcps.length
              ? mcps.map((m) => escapeHtml(m)).join('、')
              : '未连接 MCP'
        }</p>
      </section>
      <section class="ef-side-drawer__section role-drawer-section">
        <h4>部署位置</h4>
        <p>${escapeHtml(deployText)}</p>
      </section>
      <section class="ef-side-drawer__section role-drawer-section">
        <h4>最近运行</h4>
        <p class="role-drawer-muted">${
          role?.last_active_at || role?.updated_at
            ? escapeHtml(String(role.last_active_at || role.updated_at))
            : '暂无运行记录'
        }</p>
      </section>
      <section class="ef-side-drawer__section role-drawer-section">
        <h4>版本记录</h4>
        <p class="role-drawer-muted">配置变更历史将在后续版本提供</p>
      </section>
    `

    const feishuBound = role ? feishuBindingOf(role).bound : false
    const isDefaultAgent = id === 'main' || agent?.isDefault
    const feishuBtn =
      isDefaultAgent
        ? ''
        : feishuBound
          ? `<button type="button" class="btn btn-secondary" data-action="feishu-connect" data-id="${escapeAttr(id)}" title="已绑定；可再绑其他岗位">飞书已绑</button>`
          : `<button type="button" class="btn btn-secondary" data-action="feishu-connect" data-id="${escapeAttr(id)}">接到飞书</button>`

    foot.innerHTML = `
      <div class="ef-side-drawer__actions">
        <button type="button" class="btn btn-secondary" data-action="edit" data-id="${escapeAttr(id)}">编辑配置</button>
        ${feishuBtn}
        <button type="button" class="btn btn-primary" data-action="${escapeAttr(primary.action)}" data-id="${escapeAttr(id)}">${escapeHtml(
          primary.action === 'hire' ? '部署为员工' : primary.label,
        )}</button>
      </div>
    `

    mountRoleCardAvatars(body, [agent], 40)
  } catch (e) {
    body.innerHTML = `<div class="role-drawer-error">加载失败：${escapeHtml(e?.message || e)}</div>`
  }
}

function closeAllMoreMenus(page) {
  page.querySelectorAll('.role-more-menu').forEach((m) => {
    m.hidden = true
  })
}

async function copyAgentCode(id) {
  try {
    await navigator.clipboard.writeText(String(id || ''))
    toast(`已复制标识 ${id}`, 'success')
  } catch {
    toast('复制失败', 'error')
  }
}

async function exportAgentConfig(id) {
  try {
    const agent = await api.getAgent(id)
    const blob = new Blob([JSON.stringify(agent, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${id || 'agent'}.json`
    a.click()
    URL.revokeObjectURL(url)
    toast('已导出配置', 'success')
  } catch (e) {
    toast('导出失败: ' + (e?.message || e), 'error')
  }
}

function startChatWithAgent(id) {
  try {
    sessionStorage.setItem('evopanel_pending_new_session', '1')
    if (id && id !== 'main') sessionStorage.setItem('evopanel_pending_agent_switch', id)
  } catch {
    /* ignore */
  }
  navigate('/chat')
}

async function connectAgentToFeishu(page, state, id) {
  const code = String(id || '').trim()
  if (!code || code === 'main') {
    toast('默认助手请用消息渠道页配置全局主机器人', 'info')
    return
  }
  const agent = (state.agents || []).find((a) => a.agent_code === code)
  const name = String(agent?.agent_name || state.hiredRolesByCode?.get(code)?.role_name || code).trim()
  const hired = state.hiredCodes?.has?.(code) || state.hiredRolesByCode?.has?.(code)
  const role = state.hiredRolesByCode?.get(code)
  const refresh = async () => {
    if (typeof state.onRefresh === 'function') await state.onRefresh()
    else renderRoleCards(page, state)
  }
  if (hired && role && feishuBindingOf(role).bound) {
    toast('已绑定飞书。把该机器人拉进同事所在群即可协作；也可在消息渠道页继续绑其他岗位。', 'info')
    return
  }
  if (hired) {
    void startFeishuEmployeeScan(code, {
      roleName: name,
      onBound: () => void refresh(),
    })
    return
  }
  const ok = await showConfirm(
    `「${name}」尚未部署为员工。\n\n部署并扫码绑定飞书后，把机器人拉进同事群即可协作。是否继续？`,
  )
  if (!ok) return
  await hireAndBindFeishu(code, {
    roleName: name,
    onBound: () => void refresh(),
  })
}

async function handlePrimaryOrMenuAction(action, id, page, state) {
  if (action === 'detail') {
    await openAgentDetailDrawer(page, state, id)
    return
  }
  if (action === 'edit' || action === 'fix-config') {
    closeAgentDetailDrawer(page)
    showEditRoleDialog(page, state, id)
    return
  }
  if (action === 'delete') {
    await deleteRole(page, state, id)
    return
  }
  if (action === 'hire') {
    void showHireAsEmployeeDialog(page, state, id)
    return
  }
  if (action === 'feishu-connect') {
    await connectAgentToFeishu(page, state, id)
    return
  }
  if (action === 'open-duty') {
    navigate('/proactive')
    return
  }
  if (action === 'open-app') {
    const meta = state.appAgentCodes instanceof Map ? state.appAgentCodes.get(id) : null
    if (meta?.appId) navigate(`/apps/${encodeURIComponent(meta.appId)}`)
    else navigate('/apps')
    return
  }
  if (action === 'open-automation') {
    navigate('/automation')
    return
  }
  if (action === 'start-chat') {
    startChatWithAgent(id)
    return
  }
  if (action === 'start-runtime') {
    toast('该智能体依赖外部运行时，请安装对应 CLI 后刷新页面', 'info')
    await openAgentDetailDrawer(page, state, id)
    return
  }
  if (action === 'copy') {
    await copyAgentCode(id)
    return
  }
  if (action === 'export') {
    await exportAgentConfig(id)
    return
  }
  if (action === 'show-status') {
    const agent = (state.agents || []).find((a) => a.agent_code === id)
    if (!agent) return
    const run = agentRunStatusOf(agent, agentCtx(state))
    toast(`${agent.agent_name || id}：${runStatusLabel(run)}`, 'info')
    return
  }
  if (action === 'filter-capability') {
    return
  }
}

// ========== 事件绑定 ==========
export function attachRoleEvents(page, state) {
  const container = page.querySelector('#roles-list')
  if (container && container.dataset.eventsBound !== '1') {
    container.dataset.eventsBound = '1'
    container.addEventListener('click', async (e) => {
      const moreToggle = e.target.closest('[data-action="toggle-more"]')
      if (moreToggle) {
        e.stopPropagation()
        const id = moreToggle.dataset.id
        const menu = page.querySelector(`[data-more-menu="${String(id || '').replace(/"/g, '')}"]`)
        const wasOpen = menu && !menu.hidden
        closeAllMoreMenus(page)
        if (menu && !wasOpen) menu.hidden = false
        return
      }

      const capBtn = e.target.closest('[data-action="filter-capability"]')
      if (capBtn) {
        e.stopPropagation()
        const tag = capBtn.dataset.tag || ''
        if (!tag) return
        const set = new Set(state.tagFilters || [])
        set.add(tag)
        state.tagFilters = [...set]
        if (typeof state.onFiltersChange === 'function') state.onFiltersChange()
        else renderRoleCards(page, state)
        return
      }

      const btn = e.target.closest('[data-action]')
      if (btn && btn.dataset.action !== 'open-drawer') {
        e.stopPropagation()
        closeAllMoreMenus(page)
        const action = btn.dataset.action
        const id = btn.dataset.id
        await handlePrimaryOrMenuAction(action, id, page, state)
        return
      }

      const card = e.target.closest('.role-card[data-action="open-drawer"]')
      if (card) {
        closeAllMoreMenus(page)
        await openAgentDetailDrawer(page, state, card.dataset.id)
      }
    })

    container.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      const card = e.target.closest('.role-card[data-action="open-drawer"]')
      if (!card || e.target !== card) return
      e.preventDefault()
      void openAgentDetailDrawer(page, state, card.dataset.id)
    })
  }

  const drawer = page.querySelector('#roleDrawer')
  if (drawer && drawer.dataset.eventsBound !== '1') {
    drawer.dataset.eventsBound = '1'
    drawer.addEventListener('click', async (e) => {
      const closeBtn = e.target.closest('[data-action="close-drawer"]')
      if (closeBtn) {
        state.selectedId = null
        page.querySelectorAll('.role-card--selected').forEach((el) => el.classList.remove('role-card--selected'))
        closeAgentDetailDrawer(page)
        return
      }
      const btn = e.target.closest('[data-action]')
      if (!btn) return
      const action = btn.dataset.action
      const id = btn.dataset.id
      if (action === 'close-drawer') return
      await handlePrimaryOrMenuAction(action, id, page, state)
    })
  }

  if (page.dataset.moreOutsideBound !== '1') {
    page.dataset.moreOutsideBound = '1'
    document.addEventListener(
      'click',
      (e) => {
        if (!page.isConnected) return
        if (!page.contains(e.target)) return
        if (e.target.closest('.role-more-wrap')) return
        closeAllMoreMenus(page)
      },
      true,
    )
  }
}

async function showHireAsEmployeeDialog(page, state, agentCode) {
  const agent = (state.agents || []).find((a) => a.agent_code === agentCode)
  if (!agent) {
    toast('找不到该智能体', 'error')
    return
  }
  const code = String(agent.agent_code || '').trim()
  const defaultName = String(agent.agent_name || code).trim()
  const initials = /[\u4e00-\u9fff]/.test(defaultName)
    ? defaultName.slice(0, 2)
    : defaultName.slice(0, 2).toUpperCase()

  const workspacePaths = await loadWorkspacePaths()
  const workspaceField = renderWorkspaceFieldOnly(workspacePaths, '')
  const hireScheduleCtrl = createSchedulePanel({
    schedule: '0 9-19/2 * * *',
    idPrefix: 'agentHireSched',
    compact: true,
  })

  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay hire-overlay'
  overlay.innerHTML = `
    <div class="hire-sheet" role="dialog" aria-labelledby="hire-sheet-title">
      <header class="hire-sheet-head">
        <div>
          <p class="hire-sheet-kicker">智能体员工</p>
          <h2 id="hire-sheet-title" class="hire-sheet-title">部署为员工</h2>
        </div>
        <button type="button" class="hire-sheet-close" data-act="close" aria-label="关闭">&times;</button>
      </header>

      <div class="hire-agent-card">
        <div class="hire-agent-avatar" aria-hidden="true">${escapeHtml(initials)}</div>
        <div class="hire-agent-meta">
          <div class="hire-agent-name">${escapeHtml(defaultName)}</div>
          <div class="hire-agent-code">${escapeHtml(code)}</div>
        </div>
        <span class="hire-agent-pill">将加定时岗位</span>
      </div>

      <div class="hire-sheet-body">
        <div class="hire-field-row">
          <label class="hire-field">
            <span>岗位名称</span>
            <input class="hire-input" data-name="role_name" value="" placeholder="岗位显示名，例如：前端架构负责人">
          </label>
          <label class="hire-field">
            <span>部门</span>
            <input class="hire-input" data-name="department" value="" placeholder="可选">
          </label>
        </div>

        <label class="hire-field">
          <span>职责</span>
          <textarea class="hire-input hire-textarea" data-name="responsibilities" rows="3" placeholder="每行一条，例如：&#10;代码质量保障&#10;架构演进"></textarea>
        </label>

        <div class="hire-field">
          <span>转交审批策略</span>
          <div class="hire-chip-row" data-name="autonomy_level" role="radiogroup">
            <button type="button" class="hire-chip" data-value="full_auto">全自动</button>
            <button type="button" class="hire-chip is-on" data-value="approval_for_risky">平衡型</button>
            <button type="button" class="hire-chip" data-value="approval_for_all">谨慎型</button>
          </div>
          <p class="hire-chip-hint" data-autonomy-hint>本岗结案并指定下游后：中风险及以上须你审核才派发；低风险自动派下游。是否挂审由你在此配置，不由员工自行决定。</p>
        </div>

        <div class="hire-field">
          <span>自动上班</span>
          ${hireScheduleCtrl.html}
        </div>

        <details class="hire-advanced">
          <summary>更多设置（工作空间可选）</summary>
          <div class="hire-advanced-body">
            ${workspaceField}
          </div>
        </details>
      </div>

      <footer class="hire-sheet-foot">
        <button type="button" class="btn btn-secondary btn-sm" data-act="close">取消</button>
        <button type="button" class="btn btn-sm hire-confirm" data-act="confirm">确认部署</button>
      </footer>
    </div>
  `
  document.body.appendChild(overlay)
  hireScheduleCtrl.initEvents(overlay)

  const autonomyHints = {
    full_auto:
      '本岗结案并指定下游后：仅「极高风险」须你审核才派发；低/中/高风险自动派下游。是否挂审由你在此配置，不由员工自行决定。',
    approval_for_risky:
      '本岗结案并指定下游后：中风险及以上须你审核才派发；低风险自动派下游。是否挂审由你在此配置，不由员工自行决定。',
    approval_for_all:
      '本岗结案并指定下游后：一律须你审核才派发。是否挂审由你在此配置，不由员工自行决定。',
  }

  const close = () => overlay.remove()
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })
  overlay.querySelectorAll('[data-act="close"]').forEach((el) => el.addEventListener('click', close))

  bindWorkspaceSelect(overlay)

  overlay.querySelectorAll('.hire-chip-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      const chip = e.target.closest('.hire-chip')
      if (!chip) return
      row.querySelectorAll('.hire-chip').forEach((c) => c.classList.toggle('is-on', c === chip))
      if (row.dataset.name === 'autonomy_level') {
        const hint = overlay.querySelector('[data-autonomy-hint]')
        if (hint) hint.textContent = autonomyHints[chip.dataset.value] || ''
      }
    })
  })

  overlay.querySelector('[data-act="confirm"]')?.addEventListener('click', async () => {
    const role_name = (overlay.querySelector('[data-name="role_name"]')?.value || '').trim()
    if (!role_name || role_name === code) {
      toast('请填写岗位名称（不要用智能体名或英文编码）', 'warning')
      overlay.querySelector('[data-name="role_name"]')?.focus()
      return
    }
    const department = (overlay.querySelector('[data-name="department"]')?.value || '').trim()
    const responsibilities = String(overlay.querySelector('[data-name="responsibilities"]')?.value || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    const workspace_path = readWorkspacePath(overlay)
    const autonomy_level =
      overlay.querySelector('[data-name="autonomy_level"] .hire-chip.is-on')?.dataset.value ||
      'approval_for_risky'
    const heartbeat_schedule =
      hireScheduleCtrl.getSchedule().cronExpr || '0 9-19/2 * * *'

    const btn = overlay.querySelector('[data-act="confirm"]')
    if (btn) {
      btn.disabled = true
      btn.textContent = '部署中…'
    }
    try {
      await api.proactiveCreateRole({
        agent_code: code,
        role_name,
        department,
        responsibilities,
        workspace_path,
        autonomy_level,
        heartbeat_schedule,
        approval_channels: ['desktop', 'feishu'],
        think_mode: 'agent_loop',
      })
      toast(`已部署「${role_name}」为员工`, 'success')
      state.hiredCodes?.add?.(code)
      close()
      const bindFeishu = await showConfirm(
        `「${role_name}」已上岗。\n\n是否现在扫码绑定飞书，方便和同事在飞书里协作？`,
      )
      if (bindFeishu) {
        void startFeishuEmployeeScan(code, {
          roleName: role_name,
          onBound: () => {
            if (typeof state.onRefresh === 'function') void state.onRefresh()
          },
        })
      }
      if (typeof state.onRefresh === 'function') await state.onRefresh()
      else renderRoleCards(page, state)
    } catch (_e) {
      toast('部署失败: ' + (_e?.message || _e), 'error')
      if (btn) {
        btn.disabled = false
        btn.textContent = '确认部署'
      }
    }
  })

  overlay.querySelector('[data-name="role_name"]')?.focus()
}

function renderTagEditorHtml(selectedTags) {
  const selected = new Set(normalizeAgentTags(selectedTags))
  const chips = BUILTIN_AGENT_TAGS.map((t) => {
    const on = selected.has(t.label)
    return `<button type="button" class="agent-tag-chip agent-tag-chip--toggle${on ? ' agent-tag-chip--active' : ''}" data-tag-label="${escapeAttr(t.label)}" style="--tag-color:${t.color}">${escapeHtml(t.icon || '🏷️')} ${escapeHtml(t.label)}</button>`
  }).join('')
  const custom = [...selected].filter((l) => !BUILTIN_AGENT_TAGS.some((t) => t.label === l))
  return `
    <div class="form-group">
      <label class="form-label">标签</label>
      <div class="agent-tag-editor-chips">${chips}</div>
      <input class="form-input re-field-tags-custom" value="${escapeHtml(custom.join(', '))}" placeholder="其他标签，逗号分隔">
      <p class="form-hint" style="margin-top:8px">点击上方标签切换；也可在下方输入自定义标签。</p>
    </div>`
}

function readTagsFromEditor(overlay) {
  const selected = new Set()
  overlay.querySelectorAll('.agent-tag-chip--toggle.agent-tag-chip--active').forEach((el) => {
    const label = String(el.dataset.tagLabel || '').trim()
    if (label) selected.add(label)
  })
  for (const label of parseTagsInput(overlay.querySelector('.re-field-tags-custom')?.value || '')) {
    selected.add(label)
  }
  return [...selected]
}

function bindTagEditor(overlay) {
  overlay.querySelectorAll('.agent-tag-chip--toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      btn.classList.toggle('agent-tag-chip--active')
    })
  })
}

// ========== 详情弹窗（和编辑页同款 UI，只读） ==========
/** 详情弹窗「类型」一行：主智能体 / 自定义 / 子智能体 / ACP / 外部 CLI */
function formatAgentTypeBadgesHtml(agent, id) {
  if (id === 'main') return '<span class="re-badge re-badge--default">主智能体</span>'
  const missing =
    agent.requires_external_cli === true && agent.external_cli_available === false
  const parts = []
  if (missing) {
    parts.push('<span class="re-badge" style="background:#fecaca;color:#b91c1c">本机未检测到运行时</span>')
  } else if (agent.requires_external_cli) {
    parts.push('<span class="re-badge" style="background:#fef3c7;color:#b45309">外部 CLI</span>')
  }
  if (agent.agent_type === 'subagent') parts.push('<span class="re-badge" style="background:#e0e7ff;color:#4338ca">子智能体</span>')
  else if (agent.agent_type === 'acp') parts.push('<span class="re-badge" style="background:#fce7f3;color:#be185d">ACP</span>')
  // 普通自建岗：不展示「自定义角色」徽章（签名区已去掉该标注）
  if (!parts.length) return ''
  return parts.join(' ')
}

const DETAIL_TABS = [
  { id: 'basic', label: '基本信息', icon: '✦' },
  { id: 'tools', label: '内置工具', icon: '⚙' },
  { id: 'mcp', label: 'MCP 服务', icon: '◈' },
  { id: 'skills', label: '技能模块', icon: '✧' },
  { id: 'soul', label: '人格 SOUL', icon: '◎' },
]

async function showRoleDetailDialog(id, page, state) {
  try {
    const agent = await api.getAgent(id)
    const extCli = agentUsesExternalCli(agent)
    const frontDesk = isXiaomiFrontDesk(agent)
    let detailPrimaryModel = ''
    try {
      const info = await api.getPrimaryModel()
      detailPrimaryModel = String(info?.primary_model || '').trim()
    } catch {
      /* ignore */
    }

    // 获取元数据用于展示工具/MCP/技能的图标和标签（外部 CLI / 系统前台不展示这些，跳过请求）
    let metaTools = [], metaMcpServers = [], metaSkills = []
    if (!extCli && !frontDesk) {
      try {
        const mcpConfig = await api.getMCPConfig()
        if (mcpConfig?.mcp_servers) {
          for (const [name, cfg] of Object.entries(mcpConfig.mcp_servers)) {
            if (cfg.enabled !== false) metaMcpServers.push({ value: name, label: cfg.description || name, icon: '🔌' })
          }
        }
      } catch { /* ignore */ }
      if (!metaMcpServers.length) {
        try {
          const meta = await getToolsMetadata()
          metaMcpServers = (meta.mcp_servers || []).filter(s => s.enabled !== false).map(s => ({ value: s.value || s.name, label: s.label || s.name, icon: s.icon || '🔌' }))
        } catch { /* ignore */ }
      }
      try {
        const meta = await getToolsMetadata()
        metaTools = filterRoleEditorTools((meta.tools || []).map(mapApiToolMeta))
        if (!metaSkills.length && meta.skills?.length) {
          metaSkills = meta.skills.map(s => ({ value: s.name, label: s.label || s.name, icon: s.icon || getSkillIcon(s.name), desc: s.description || '' }))
        }
      } catch { /* ignore */ }
      if (!metaSkills.length) {
        try { const sd = await api.loadSkills(); metaSkills = sd.filter(s => s.enabled !== false).map(s => ({ value: s.name, label: s.name, icon: getSkillIcon(s.name), desc: s.description || '' })) } catch {}
      }
      metaSkills = dedupeSkillMetaRows(metaSkills)
    }

    // 解析当前选中项
    const toolsSummary = (extCli || frontDesk) ? null : resolveAgentConfigurableTools(agent, metaTools)
    const activeTools = (extCli || frontDesk) ? [] : (toolsSummary?.selected || [])
    const activeMcp = (extCli || frontDesk) ? [] : (Array.isArray(agent.mcp_servers) ? agent.mcp_servers : (metaMcpServers.map(s => s.value)))
    const activeSkills = (extCli || frontDesk) ? [] : (Array.isArray(agent.skills) ? agent.skills : [])
    const isAllTools = !extCli && !frontDesk && Boolean(toolsSummary?.isAll)
    const isAllMcp = !extCli && !frontDesk && activeMcp.length === metaMcpServers.length && metaMcpServers.length > 0
    const isAllSkills = !extCli && !frontDesk && activeSkills.length === metaSkills.length && metaSkills.length > 0

    const detailTabs = (extCli || frontDesk)
      ? DETAIL_TABS.filter((t) => t.id === 'basic' || t.id === 'soul')
      : DETAIL_TABS

    const detailToolsMcpSkillsHtml = (extCli || frontDesk) ? '' : `
              <!-- 内置工具（只显示已选中的） -->
              <section class="re-panel" data-panel="tools" hidden>
                <p class="re-hint">系统工具（询问、场景切换、查找/激活工具、Plan 协作、Goal 目标模式等）由运行时自动挂载，不在此列出。</p>
                <div class="re-bar">
                  <span class="re-count">${isAllTools ? '<em style="color:#10b981">全部可用 (' + metaTools.length + ')</em>' : `<em class="re-num">${activeTools.length}</em> 个工具`}</span>
                </div>
                <div class="re-grid detail-list">
                  ${renderToolsDetailGrid(metaTools, activeTools, isAllTools)}
                </div>
              </section>

              <!-- MCP 服务（只显示已选中的） -->
              <section class="re-panel" data-panel="mcp" hidden>
                <div class="re-bar">
                  <span class="re-count">${isAllMcp ? '<em style="color:#10b981">全部已连接 (' + metaMcpServers.length + ')</em>' : `<em class="re-num">${activeMcp.length}</em> 个MCP`}</span>
                </div>
                <div class="re-grid detail-list">
                  ${isAllMcp ? metaMcpServers.map(s => `
                    <div class="re-check" data-search="${escapeAttr((s.value + ' ' + s.label).toLowerCase())}">
                      <span class="re-ci-icon">${s.icon}</span>
                      <span class="re-ci-text"><strong>${escapeHtml(s.label)}</strong></span>
                      <span class="re-check-ok">✓</span>
                    </div>`).join('') : metaMcpServers.filter(s => activeMcp.includes(s.value)).map(s => `
                    <div class="re-check" data-search="${escapeAttr((s.value + ' ' + s.label).toLowerCase())}">
                      <span class="re-ci-icon">${s.icon}</span>
                      <span class="re-ci-text"><strong>${escapeHtml(s.label)}</strong></span>
                      <span class="re-check-ok">✓</span>
                    </div>`).join('')}
                  ${(!isAllMcp && activeMcp.length === 0) ? '<div class="re-empty">未配置 MCP 服务器</div>' : ''}
                  ${metaMcpServers.length === 0 ? '<div class="re-empty">暂无 MCP 服务器</div>' : ''}
                </div>
              </section>

              <!-- 技能模块（只显示已选中的） -->
              <section class="re-panel" data-panel="skills" hidden>
                <div class="re-bar">
                  <span class="re-count">${isAllSkills ? '<em style="color:#10b981">全部可用 (' + metaSkills.length + ')</em>' : `<em class="re-num">${activeSkills.length}</em> 个技能`}</span>
                </div>
                <div class="re-grid detail-list skill-card-list">
                  ${isAllSkills ? metaSkills.map(s => `
                    <div class="skill-card" data-search="${escapeAttr(s.value.toLowerCase())} ${escapeAttr((s.label||'').toLowerCase())} ${escapeAttr((s.desc||'').toLowerCase())}">
                      <div class="skill-card-head">
                        <span class="skill-card-icon">${s.icon}</span>
                        <strong class="skill-card-name">${escapeHtml(s.label)}</strong>
                      </div>
                      <p class="skill-card-desc">${s.desc ? escapeHtml(s.desc) : '<em style="color:var(--text-tertiary)">暂无描述</em>'}</p>
                    </div>`).join('') : metaSkills.filter(s => activeSkills.includes(s.value)).map(s => `
                    <div class="skill-card" data-search="${escapeAttr(s.value.toLowerCase())} ${escapeAttr((s.label||'').toLowerCase())} ${escapeAttr((s.desc||'').toLowerCase())}">
                      <div class="skill-card-head">
                        <span class="skill-card-icon">${s.icon}</span>
                        <strong class="skill-card-name">${escapeHtml(s.label)}</strong>
                      </div>
                      <p class="skill-card-desc">${s.desc ? escapeHtml(s.desc) : '<em style="color:var(--text-tertiary)">暂无描述</em>'}</p>
                    </div>`).join('')}
                  ${(!isAllSkills && activeSkills.length === 0) ? '<div class="re-empty">未配置技能</div>' : ''}
                  ${metaSkills.length === 0 ? '<div class="re-empty">暂无已安装技能</div>' : ''}
                </div>
              </section>
`

    // 创建 overlay
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay role-editor-overlay'

    const hired = (state.hiredCodes instanceof Set ? state.hiredCodes : new Set()).has(String(id || '').trim())
    const overviewStats = []
    if (frontDesk) {
      overviewStats.push({ label: '前台工具', tip: '名册 / 看板 / 员工下钻 / 任务汇报 / 派发 / 催办 / 知识检索' })
      overviewStats.push({ label: '无 MCP', tip: '系统前台不挂 MCP' })
      overviewStats.push({ label: '无技能', tip: '系统前台不挂普通技能' })
    } else if (!extCli) {
      overviewStats.push({
        label: isAllTools ? `工具 全部 ${metaTools.length}` : `工具 ${activeTools.length}/${metaTools.length || '—'}`,
        tip: '内置工具',
      })
      overviewStats.push({
        label: isAllMcp ? `MCP 全部 ${metaMcpServers.length}` : `MCP ${activeMcp.length}`,
        tip: 'MCP 服务',
      })
      overviewStats.push({
        label: isAllSkills ? `技能 全部 ${metaSkills.length}` : `技能 ${activeSkills.length}`,
        tip: '技能模块',
      })
    } else {
      overviewStats.push({ label: '外部 CLI', tip: '能力由本机运行时提供' })
    }
    if (agent.soul) overviewStats.push({ label: '已配置 SOUL', tip: '人格' })

    const navHtml = detailTabs.map((tab, i) => `
      <button type="button" class="re-nav-item${i === 0 ? ' re-nav-item--active' : ''}" data-detail-tab="${tab.id}">
        <span class="re-nav-ico">${tab.icon}</span><span>${tab.label}</span>
      </button>
    `).join('')

    overlay.innerHTML = `
      <div class="role-editor-modal role-editor-modal--wide">
        <header class="re-header">
          <div class="re-header-left">
            <span class="re-header-dot" style="background:#0f766e"></span>
            <strong>智能体详情</strong>
          </div>
          <button type="button" class="re-close" data-action="close" aria-label="关闭">&times;</button>
        </header>
        ${renderAgentSheetHero(agent, id, { hired, stats: overviewStats })}
        <div class="re-body">
          <nav class="re-nav">${navHtml}</nav>
          <main class="re-main">
            <div class="re-panel-head">
              <h3 id="detail-panel-title">基本信息</h3>
              <p id="detail-panel-desc">一眼看清它是谁、能做什么</p>
            </div>
            <div class="re-panels">

              <!-- 基本信息 -->
              <section class="re-panel" data-panel="basic">
                <div class="detail-grid">
                  <div class="detail-field">
                    <label class="detail-label">角色标识</label>
                    <div class="detail-value"><code>${escapeHtml(agent.agent_code || '-')}</code></div>
                  </div>
                  <div class="detail-field">
                    <label class="detail-label">中文名称</label>
                    <div class="detail-value">${escapeHtml(agent.agent_name || '-')}</div>
                  </div>
                  <div class="detail-field" style="grid-column: 1 / -1">
                    <label class="detail-label">它能干嘛</label>
                    <div class="detail-value detail-value--lead">${escapeHtml(agent.description || '暂无描述')}</div>
                  </div>
                  <div class="detail-field">
                    <label class="detail-label">类型</label>
                    <div class="detail-value">${formatAgentTypeBadgesHtml(agent, id) || '—'}</div>
                  </div>
                  <div class="detail-field">
                    <label class="detail-label">默认模型</label>
                    <div class="detail-value">${escapeHtml(formatAgentModelFollowLabel(agent.model, detailPrimaryModel))}</div>
                  </div>
                  ${agent.requires_external_cli ? `
                  <div class="detail-field" style="grid-column: 1 / -1">
                    <label class="detail-label">运行依赖</label>
                    <div class="detail-value" style="font-size:13px;color:var(--text-secondary, #64748b)">${agent.external_cli_available === false
    ? '网关在本机未检测到 <code>claude_agent_sdk</code>（Python 包）且 PATH 上无 <code>claude</code> 命令，当前无法委派该角色。安装 Claude Code / Anthropic CLI 或在与网关相同的 Python 环境中安装 <code>claude-agent-sdk</code> 后重试。'
    : '该角色通过外部 CLI / SDK 执行；目标机器需具备对应运行时（如 Claude Code），否则无法委派。'}</div>
                  </div>
                  <div class="detail-field" style="grid-column: 1 / -1">
                    <label class="detail-label">面板配置范围</label>
                    <div class="detail-value" style="font-size:13px;color:var(--text-secondary, #64748b)">此处仅可编辑名称、描述、系统提示词与人格 SOUL。内置工具、MCP 与技能模块由外部 CLI 提供，无法在面板中勾选或限制。</div>
                  </div>
                  ` : ''}
                  ${agent.system_prompt ? `
                  <div class="detail-field" style="grid-column: 1 / -1">
                    <label class="detail-label">系统提示词</label>
                    <pre class="detail-soul detail-soul--scroll">${escapeHtml(agent.system_prompt)}</pre>
                  </div>
                  ` : ''}
                </div>
              </section>

              ${detailToolsMcpSkillsHtml}

              <!-- SOUL 人格 -->
              <section class="re-panel" data-panel="soul" hidden>
                <div class="detail-soul-wrap">
                  <pre class="detail-soul">${escapeHtml(agent.soul || '(空 — 尚未配置人格)')}</pre>
                </div>
              </section>

            </div>
          </main>
        </div>
        <footer class="re-footer">
          <button class="btn btn-secondary" data-action="close">关闭</button>
          ${hired
            ? '<button class="btn btn-secondary" data-action="open-duty">查看值班台</button>'
            : '<button class="btn btn-primary" data-action="hire" style="background:linear-gradient(135deg,#0f766e,#14b8a6);border:none">部署为员工</button>'}
          <button class="btn btn-primary" data-action="edit">编辑此角色</button>
        </footer>
      </div>
    `

    document.body.appendChild(overlay)
    mountRoleCardAvatars(overlay, [agent], 56)

    const closeFn = () => overlay.remove()
    // header × 与 footer「关闭」同为 data-action=close，须全部绑定（querySelector 只会命中第一个）
    overlay.querySelectorAll('[data-action="close"]').forEach((el) => el.addEventListener('click', closeFn))
    overlay.addEventListener('click', e => { if (e.target === overlay) closeFn() })

    // 编辑按钮 → 关闭详情，打开编辑器
    overlay.querySelector('[data-action=edit]')?.addEventListener('click', () => {
      closeFn()
      // 触发编辑：通过 dispatchEvent 模拟点击编辑按钮
      const page = document.querySelector('.role-page')
      if (page) showEditRoleDialog(page, window._roleState || state || { agents: [] }, id)
    })
    overlay.querySelector('[data-action=hire]')?.addEventListener('click', () => {
      closeFn()
      const page = document.querySelector('.role-page')
      if (page) void showHireAsEmployeeDialog(page, window._roleState || state || { agents: [] }, id)
    })
    overlay.querySelector('[data-action=open-duty]')?.addEventListener('click', () => {
      closeFn()
      navigate('/proactive')
    })

    // Tab 切换
    const tabMeta = Object.fromEntries(detailTabs.map(t => [t.id, t]))
    overlay.addEventListener('click', e => {
      const tabBtn = e.target.closest('[data-detail-tab]')
      if (tabBtn) {
        const tid = tabBtn.dataset.detailTab
        overlay.querySelectorAll('.re-nav-item').forEach(b => b.classList.toggle('re-nav-item--active', b.dataset.detailTab === tid))
        overlay.querySelectorAll('.re-panel').forEach(p => p.toggleAttribute('hidden', p.dataset.panel !== tid))
        const m = tabMeta[tid]
        if (m) {
          overlay.querySelector('#detail-panel-title').textContent = m.label
          overlay.querySelector('#detail-panel-desc').textContent = _getDetailPanelDesc(tid)
        }
      }
    })

    // 搜索过滤（只影响显示，不影响数据）
    overlay.querySelectorAll('.re-search').forEach(input => {
      input.addEventListener('input', () => {
        const kw = input.value.trim().toLowerCase()
        input.closest('.re-panel').querySelectorAll('.re-check').forEach(item => {
          item.style.display = (!kw || (item.dataset.search || '').includes(kw)) ? '' : 'none'
        })
      })
    })

    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { closeFn(); document.removeEventListener('keydown', onKey) }
    })
  } catch (e) {
    toast('获取详情失败: ' + e, 'error')
  }
}

function _getDetailPanelDesc(tabId) {
  return { basic: '角色的基本配置信息', tools: '该角色可使用的内置工具列表', mcp: '该角色可连接的 MCP 服务器', skills: '该角色可调用的技能模块', soul: 'AI 角色的核心人格与行为边界' }[tabId] || ''
}

// ========== 编辑弹窗：左右分栏 ==========
const EDITOR_TABS = [
  { id: 'basic', label: '基本信息', icon: '✦' },
  { id: 'tools', label: '内置工具', icon: '⚙' },
  { id: 'mcp', label: 'MCP 服务', icon: '◈' },
  { id: 'skills', label: '技能模块', icon: '✧' },
  { id: 'soul', label: '人格 SOUL', icon: '◎' },
]

/**
 * 新建自定义智能体（与编辑弹层同结构，标识可填）
 */
export async function showCreateRoleDialog(page, state) {
  let metaTools = []
  let metaMcpServers = []
  let metaSkills = []
  try {
    const meta = await getToolsMetadata()
    metaTools = filterRoleEditorTools((meta.tools || []).map(mapApiToolMeta))
    metaSkills = (meta.skills || []).map((s) => ({
      value: s.name,
      label: s.label || s.name,
      icon: s.icon || getSkillIcon(s.name),
      desc: s.description || '',
    }))
  } catch {
    /* ignore */
  }
  try {
    const mcpConfig = await api.getMCPConfig()
    if (mcpConfig?.mcp_servers) {
      for (const [name, cfg] of Object.entries(mcpConfig.mcp_servers)) {
        if (cfg.enabled !== false) metaMcpServers.push({ value: name, label: cfg.description || name, icon: '🔌' })
      }
    }
  } catch {
    /* ignore */
  }
  if (!metaMcpServers.length) {
    try {
      const meta = await getToolsMetadata()
      metaMcpServers = (meta.mcp_servers || [])
        .filter((s) => s.enabled !== false)
        .map((s) => ({ value: s.value || s.name, label: s.label || s.name, icon: s.icon || '🔌' }))
    } catch {
      /* ignore */
    }
  }
  if (!metaSkills.length) {
    try {
      const skillsData = await api.loadSkills()
      metaSkills = skillsData
        .filter((s) => s.enabled !== false)
        .map((s) => ({ value: s.name, label: s.name, icon: getSkillIcon(s.name), desc: s.description || '' }))
    } catch {
      /* ignore */
    }
  }
  metaSkills = dedupeSkillMetaRows(metaSkills)

  const { models: modelOptions, primary: primaryModel } = await loadAgentDefaultModelOptions()

  const createState = {
    pendingUpload: null,
  }

  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay role-editor-overlay'

  const navHtml = EDITOR_TABS.map(
    (tab, i) => `
    <button type="button" class="re-nav-item${i === 0 ? ' re-nav-item--active' : ''}" data-editor-tab="${tab.id}">
      <span class="re-nav-ico">${tab.icon}</span><span>${tab.label}</span>
    </button>
  `,
  ).join('')

  const defaultTools = metaTools.map((t) => t.value)
  const defaultMcp = metaMcpServers.map((s) => s.value)

  overlay.innerHTML = `
    <div class="role-editor-modal role-editor-modal--wide">
      <header class="re-header">
        <div class="re-header-left">
          <span class="re-header-dot" style="background:#0f766e"></span>
          <strong>新建智能体</strong>
        </div>
        <button type="button" class="re-close" data-action="close" aria-label="关闭">&times;</button>
      </header>
      <div class="re-body">
        <nav class="re-nav">${navHtml}</nav>
        <main class="re-main">
          <div class="re-panel-head">
            <h3 id="editor-panel-title">基本信息</h3>
            <p id="editor-panel-desc">填写标识与名称，可选系统默认头像；左侧可切换工具与人格</p>
          </div>
          <div class="re-panels">
            <section class="re-panel" data-panel="basic">
              <div class="form-group">
                <label class="form-label">角色头像</label>
                <div id="role-avatar-picker-mount" data-agent-id="new-agent"></div>
              </div>
              <div class="form-group">
                <label class="form-label">角色标识 <span style="color:var(--error,#dc2626)">*</span></label>
                <input class="form-input re-field-id" value="" placeholder="例如：my-research-bot（字母、数字、连字符）" autocomplete="off" spellcheck="false" style="font-family:var(--font-mono)">
                <div class="form-hint re-field-id-hint">创建后不可改；将作为 API / 雇佣岗位的唯一编码</div>
              </div>
              <div class="form-group">
                <label class="form-label">中文名称</label>
                <input class="form-input re-field-name" value="" placeholder="例如：调研助手">
              </div>
              <div class="form-group">
                <label class="form-label">角色描述</label>
                <input class="form-input re-field-desc" value="" placeholder="例如：负责竞品与资料检索">
              </div>
              ${renderAgentDefaultModelField({ selected: '', models: modelOptions, primary: primaryModel })}
              ${renderTagEditorHtml([])}
              <div class="form-group">
                <label class="form-label">系统提示词</label>
                <textarea class="form-input re-field-system-prompt" placeholder="定义该角色的核心指令和行为规范" rows="8" style="font-family:var(--font-mono);font-size:13px;line-height:1.6;resize:vertical;"></textarea>
              </div>
            </section>

            <section class="re-panel" data-panel="tools" hidden>
              <input class="re-search" placeholder="搜索内置工具..." data-filter="tools">
              <div class="re-bar">
                <span class="re-count"><em class="re-num tools-count">${defaultTools.length}</em> / ${metaTools.length}</span>
                <div class="re-bar-btns">
                  <button type="button" class="btn btn-sm btn-secondary re-sel-all-tools">全选</button>
                  <button type="button" class="btn btn-sm btn-secondary re-clr-tools">清空</button>
                </div>
              </div>
              <div class="re-grid editor-tool-list">
                ${renderToolsEditorGrid(metaTools, defaultTools)}
              </div>
            </section>

            <section class="re-panel" data-panel="mcp" hidden>
              <input class="re-search" placeholder="搜索 MCP 服务器..." data-filter="mcp_servers">
              <div class="re-bar">
                <span class="re-count"><em class="re-num mcp-count">${defaultMcp.length}</em> / ${metaMcpServers.length}</span>
                <div class="re-bar-btns">
                  <button type="button" class="btn btn-sm btn-secondary re-sel-all-mcp">全选</button>
                  <button type="button" class="btn btn-sm btn-secondary re-clr-mcp">清空</button>
                </div>
              </div>
              <div class="re-grid editor-mcp-list">
                ${metaMcpServers
                  .map((s) => {
                    const checked = defaultMcp.includes(s.value) ? 'checked' : ''
                    return `<label class="re-check" data-search="${escapeAttr(s.value.toLowerCase())} ${escapeAttr(s.label.toLowerCase())}">
                    <input type="checkbox" name="mcp_servers" value="${escapeAttr(s.value)}" ${checked}>
                    <span class="re-ci-icon">${s.icon}</span>
                    <span class="re-ci-text"><strong>${escapeHtml(s.label)}</strong></span>
                  </label>`
                  })
                  .join('')}
                ${metaMcpServers.length === 0 ? '<div class="re-empty">暂无 MCP 服务器</div>' : ''}
              </div>
            </section>

            <section class="re-panel" data-panel="skills" hidden>
              <input class="re-search" placeholder="搜索技能..." data-filter="skills">
              <div class="re-bar">
                <span class="re-count"><em class="re-num skills-count">0</em> / ${metaSkills.length}</span>
                <div class="re-bar-btns">
                  <button type="button" class="btn btn-sm btn-secondary re-sel-all-skills">全选</button>
                  <button type="button" class="btn btn-sm btn-secondary re-clr-skills">清空</button>
                </div>
              </div>
              <div class="re-grid editor-skill-list skill-card-list">
                ${metaSkills
                  .map(
                    (s) => `<label class="skill-card skill-card--editable" data-search="${escapeAttr(s.value.toLowerCase())} ${escapeAttr((s.label || '').toLowerCase())} ${escapeAttr((s.desc || '').toLowerCase())}">
                    <input type="checkbox" name="skills" value="${escapeAttr(s.value)}">
                    <div class="skill-card-head">
                      <span class="skill-card-icon">${s.icon}</span>
                      <strong class="skill-card-name">${escapeHtml(s.label)}</strong>
                    </div>
                    <p class="skill-card-desc">${s.desc ? escapeHtml(s.desc) : '<em style="color:var(--text-tertiary)">暂无描述</em>'}</p>
                  </label>`,
                  )
                  .join('')}
                ${metaSkills.length === 0 ? '<div class="re-empty">暂无已安装技能</div>' : ''}
              </div>
            </section>

            <section class="re-panel" data-panel="soul" hidden>
              <div class="form-group" style="margin-bottom:0">
                <textarea class="form-input re-field-soul" placeholder="定义角色的个性、行为约束、输出风格等。" rows="16" style="font-family:var(--font-mono);font-size:13px;line-height:1.75;resize:vertical;border-radius:var(--radius-lg);border-color:var(--border-primary)"></textarea>
                <div class="form-hint">SOUL 定义了 AI 角色的核心人格与行为边界</div>
              </div>
            </section>
          </div>
        </main>
      </div>
      <footer class="re-footer">
        <button type="button" class="btn btn-secondary" data-action="cancel">取消</button>
        <button type="button" class="btn btn-primary" data-action="save">创建智能体</button>
      </footer>
    </div>
  `

  document.body.appendChild(overlay)
  bindTagEditor(overlay)

  const avatarPickerState = { avatar: null, avatar_meta: null, previewUrl: null }
  const pickerMount = overlay.querySelector('#role-avatar-picker-mount')
  const mountPicker = (agentCode) => {
    void gatewayBaseForAvatars().then((baseUrl) => {
      mountAgentAvatarPicker(pickerMount, {
        agentCode: agentCode || 'new-agent',
        agentName: overlay.querySelector('.re-field-name')?.value || '',
        baseUrl,
        value: avatarPickerState,
        onChange: (next) => {
          avatarPickerState.avatar = next.avatar
          avatarPickerState.avatar_meta = next.avatar_meta
          avatarPickerState.previewUrl = next.previewUrl
          if (next.avatar !== 'image') createState.pendingUpload = null
        },
        onUpload: async (blob, meta) => {
          createState.pendingUpload = { blob, meta }
          avatarPickerState.avatar = 'image'
          avatarPickerState.avatar_meta = meta
        },
      })
    })
  }
  mountPicker('new-agent')

  const closeFn = () => overlay.remove()
  overlay.querySelector('[data-action=close]')?.addEventListener('click', closeFn)
  overlay.querySelector('[data-action=cancel]')?.addEventListener('click', closeFn)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeFn()
  })

  const tabMeta = Object.fromEntries(EDITOR_TABS.map((t) => [t.id, t]))
  overlay.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('[data-editor-tab]')
    if (!tabBtn) return
    const tid = tabBtn.dataset.editorTab
    overlay.querySelectorAll('.re-nav-item').forEach((b) => b.classList.toggle('re-nav-item--active', b.dataset.editorTab === tid))
    overlay.querySelectorAll('.re-panel').forEach((p) => p.toggleAttribute('hidden', p.dataset.panel !== tid))
    const meta = tabMeta[tid]
    if (meta) {
      overlay.querySelector('#editor-panel-title').textContent = meta.label
      overlay.querySelector('#editor-panel-desc').textContent = _getPanelDesc(tid)
    }
  })

  overlay.querySelectorAll('.re-search').forEach((input) => {
    input.addEventListener('input', () => {
      const kw = input.value.trim().toLowerCase()
      input.closest('.re-panel').querySelectorAll('.re-check, .skill-card').forEach((item) => {
        item.style.display = !kw || (item.dataset.search || '').includes(kw) ? '' : 'none'
      })
    })
  })

  const bindSelClr = (selCls, clrCls, listName, fieldName) => {
    overlay.querySelector(selCls)?.addEventListener('click', () => {
      overlay.querySelectorAll(`.${listName} input`).forEach((cb) => {
        cb.checked = true
      })
      updateCount(overlay, fieldName)
    })
    overlay.querySelector(clrCls)?.addEventListener('click', () => {
      overlay.querySelectorAll(`.${listName} input`).forEach((cb) => {
        cb.checked = false
      })
      updateCount(overlay, fieldName)
    })
  }
  bindSelClr('.re-sel-all-tools', '.re-clr-tools', 'editor-tool-list', 'tools')
  bindSelClr('.re-sel-all-mcp', '.re-clr-mcp', 'editor-mcp-list', 'mcp_servers')
  bindSelClr('.re-sel-all-skills', '.re-clr-skills', 'editor-skill-list', 'skills')
  overlay.querySelectorAll('.editor-tool-list input').forEach((cb) => cb.addEventListener('change', () => updateCount(overlay, 'tools')))
  overlay.querySelectorAll('.editor-mcp-list input').forEach((cb) => cb.addEventListener('change', () => updateCount(overlay, 'mcp_servers')))
  overlay.querySelectorAll('.editor-skill-list input').forEach((cb) => cb.addEventListener('change', () => updateCount(overlay, 'skills')))

  const idInput = overlay.querySelector('.re-field-id')
  const idHint = overlay.querySelector('.re-field-id-hint')
  idInput?.addEventListener('change', () => {
    const code = String(idInput.value || '').trim().toLowerCase()
    if (code) mountPicker(code)
  })

  overlay.querySelector('[data-action=save]')?.addEventListener('click', async () => {
    const agent_code = String(idInput?.value || '')
      .trim()
      .toLowerCase()
    const agent_name = overlay.querySelector('.re-field-name')?.value?.trim() || null
    const description = overlay.querySelector('.re-field-desc')?.value?.trim() || ''
    const soul = overlay.querySelector('.re-field-soul')?.value?.trim() || ''
    const system_prompt = overlay.querySelector('.re-field-system-prompt')?.value?.trim() || null
    const modelRaw = readAgentDefaultModel(overlay)
    const model = modelRaw === undefined ? null : modelRaw || null
    const tags = readTagsFromEditor(overlay)
    const tools = [...overlay.querySelectorAll('.editor-tool-list input:checked')].map((el) => el.value)
    const mcp_servers = [...overlay.querySelectorAll('.editor-mcp-list input:checked')].map((el) => el.value)
    const skills = [...overlay.querySelectorAll('.editor-skill-list input:checked')].map((el) => el.value)

    if (!/^[a-z0-9-]+$/i.test(agent_code)) {
      toast('角色标识仅支持字母、数字与连字符', 'warning')
      idInput?.focus()
      return
    }
    try {
      const check = await api.checkAgentName(agent_code)
      if (check && check.available === false) {
        toast(`标识「${agent_code}」已被占用`, 'warning')
        if (idHint) idHint.textContent = '该标识已存在，请换一个'
        idInput?.focus()
        return
      }
    } catch {
      /* create will 409 if taken */
    }

    const saveBtn = overlay.querySelector('[data-action=save]')
    if (saveBtn) {
      saveBtn.disabled = true
      saveBtn.textContent = '创建中…'
    }
    try {
      let avatar = avatarPickerState.avatar
      let avatar_meta = avatarPickerState.avatar_meta
      const willUpload = !!createState.pendingUpload?.blob
      if (willUpload) {
        avatar = null
        avatar_meta = null
      }
      await api.createAgent({
        agent_code,
        agent_name,
        description,
        model,
        tools: tools.length === metaTools.length ? null : tools,
        mcp_servers: mcp_servers.length === metaMcpServers.length ? null : mcp_servers,
        skills,
        soul,
        system_prompt,
        tags,
        avatar,
        avatar_meta,
      })
      if (willUpload) {
        await api.uploadAgentAvatar(agent_code, createState.pendingUpload.blob)
        await api.updateAgent(agent_code, {
          avatar: 'image',
          avatar_meta: createState.pendingUpload.meta,
        })
      }
      toast(`已创建「${agent_name || agent_code}」`, 'success')
      closeFn()
      if (typeof state.onRefresh === 'function') await state.onRefresh()
    } catch (e) {
      toast('创建失败: ' + (e?.message || e), 'error')
      if (saveBtn) {
        saveBtn.disabled = false
        saveBtn.textContent = '创建智能体'
      }
    }
  })

  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') {
      closeFn()
      document.removeEventListener('keydown', onKey)
    }
  })
  idInput?.focus()
}

/**
 * 打开角色编辑器弹窗
 */
export async function showEditRoleDialog(page, state, id) {
  let agent = state.agents.find(a => a.agent_code === id)
  if (!agent) {
    try {
      agent = await api.getAgent(id)
    } catch (e) {
      console.warn('[角色编辑] 获取角色失败:', e)
      return
    }
  }
  // 列表 GET /agents 不返回 soul（体积与隐私）；编辑前拉取单条，否则重启后编辑框会误以为 SOUL 未持久化
  try {
    const full = await api.getAgent(id)
    agent = { ...agent, ...full }
  } catch (e) {
    console.warn('[角色编辑] 获取完整角色失败，使用列表数据:', e)
  }
  const extCli = agentUsesExternalCli(agent)
  const frontDesk = isXiaomiFrontDesk(agent)

  // 从后端获取工具元数据（外部 CLI / 系统前台不展示对应 Tab，跳过）
  let metaTools = []
  let metaMcpServers = []
  let metaSkills = []
  if (!extCli && !frontDesk) {
    try {
      const meta = await getToolsMetadata()
      metaTools = filterRoleEditorTools((meta.tools || []).map(mapApiToolMeta))
      metaSkills = (meta.skills || []).map(s => ({ value: s.name, label: s.label || s.name, icon: s.icon || getSkillIcon(s.name), desc: s.description || '' }))
    } catch { /* ignore */ }

    try {
      const mcpConfig = await api.getMCPConfig()
      if (mcpConfig?.mcp_servers) {
        for (const [name, cfg] of Object.entries(mcpConfig.mcp_servers)) {
          if (cfg.enabled !== false) metaMcpServers.push({ value: name, label: cfg.description || name, icon: '🔌' })
        }
      }
    } catch { /* ignore */ }
    if (!metaMcpServers.length) {
      try {
        const meta = await getToolsMetadata()
        metaMcpServers = (meta.mcp_servers || []).filter(s => s.enabled !== false).map(s => ({ value: s.value || s.name, label: s.label || s.name, icon: s.icon || '🔌' }))
      } catch { /* ignore */ }
    }

    if (!metaSkills.length) {
      try {
        const skillsData = await api.loadSkills()
        metaSkills = skillsData.filter(s => s.enabled !== false).map(s => ({ value: s.name, label: s.name, icon: getSkillIcon(s.name), desc: s.description || '' }))
      } catch { /* ignore */ }
    }
    metaSkills = dedupeSkillMetaRows(metaSkills)
  }

  const { models: modelOptions, primary: primaryModel } = await loadAgentDefaultModelOptions()
  const hideModelField = extCli || frontDesk

  // editState 初始化：
  //   tools/mcp：未配置时默认全选（与后端 None=全量一致）；skills 未配置时默认不选任何技能
  //   小V：固定空能力面，不可编辑
  const editState = {
    description: agent.description || '',
    tags: normalizeAgentTags(agent.tags),
    avatar: agent.avatar || null,
    avatar_meta: agent.avatar_meta || null,
    tools: (extCli || frontDesk) ? [] : resolveAgentConfigurableTools(agent, metaTools).selected,
    mcp_servers: (extCli || frontDesk) ? [] : (Array.isArray(agent.mcp_servers) ? agent.mcp_servers : metaMcpServers.map(s => s.value)),
    skills: (extCli || frontDesk) ? [] : (Array.isArray(agent.skills) ? agent.skills : []),
    soul: agent.soul || '',
    system_prompt: agent.system_prompt || '',
    model: String(agent.model || '').trim(),
  }

  const editorTabs = (extCli || frontDesk)
    ? EDITOR_TABS.filter((t) => t.id === 'basic' || t.id === 'soul')
    : EDITOR_TABS

  const editorToolsMcpSkillsHtml = (extCli || frontDesk) ? '' : `
            <!-- 工具面板 -->
            <section class="re-panel" data-panel="tools" hidden>
              <input class="re-search" placeholder="搜索内置工具..." data-filter="tools">
              <div class="re-bar">
                <span class="re-count"><em class="re-num tools-count">${editState.tools.length}</em> / ${metaTools.length}</span>
                <div class="re-bar-btns">
                  <button class="btn btn-sm btn-secondary re-sel-all-tools">全选</button>
                  <button class="btn btn-sm btn-secondary re-clr-tools">清空</button>
                </div>
              </div>
              <div class="re-grid editor-tool-list">
                ${renderToolsEditorGrid(metaTools, editState.tools)}
              </div>
            </section>

            <!-- MCP 面板 -->
            <section class="re-panel" data-panel="mcp" hidden>
              <input class="re-search" placeholder="搜索 MCP 服务器..." data-filter="mcp_servers">
              <div class="re-bar">
                <span class="re-count"><em class="re-num mcp-count">${editState.mcp_servers.length}</em> / ${metaMcpServers.length}</span>
                <div class="re-bar-btns">
                  <button class="btn btn-sm btn-secondary re-sel-all-mcp">全选</button>
                  <button class="btn btn-sm btn-secondary re-clr-mcp">清空</button>
                </div>
              </div>
              <div class="re-grid editor-mcp-list">
                ${metaMcpServers.map(s => {
                  const checked = editState.mcp_servers.includes(s.value) ? 'checked' : ''
                  return `<label class="re-check" data-search="${escapeAttr(s.value.toLowerCase())} ${escapeAttr(s.label.toLowerCase())}">
                    <input type="checkbox" name="mcp_servers" value="${escapeAttr(s.value)}" ${checked}>
                    <span class="re-ci-icon">${s.icon}</span>
                    <span class="re-ci-text"><strong>${escapeHtml(s.label)}</strong></span>
                  </label>`
                }).join('')}
                ${metaMcpServers.length === 0 ? '<div class="re-empty">暂无 MCP 服务器</div>' : ''}
              </div>
            </section>

            <!-- 技能面板 -->
            <section class="re-panel" data-panel="skills" hidden>
              <input class="re-search" placeholder="搜索技能..." data-filter="skills">
              <div class="re-bar">
                <span class="re-count"><em class="re-num skills-count">${editState.skills.length}</em> / ${metaSkills.length}</span>
                <div class="re-bar-btns">
                  <button class="btn btn-sm btn-secondary re-sel-all-skills">全选</button>
                  <button class="btn btn-sm btn-secondary re-clr-skills">清空</button>
                </div>
              </div>
              <div class="re-grid editor-skill-list skill-card-list">
                ${metaSkills.map(s => {
                  const checked = editState.skills.includes(s.value) ? 'checked' : ''
                  return `<label class="skill-card skill-card--editable" data-search="${escapeAttr(s.value.toLowerCase())} ${escapeAttr((s.label||'').toLowerCase())} ${escapeAttr((s.desc||'').toLowerCase())}">
                    <input type="checkbox" name="skills" value="${escapeAttr(s.value)}" ${checked}>
                    <div class="skill-card-head">
                      <span class="skill-card-icon">${s.icon}</span>
                      <strong class="skill-card-name">${escapeHtml(s.label)}</strong>
                    </div>
                    <p class="skill-card-desc">${s.desc ? escapeHtml(s.desc) : '<em style="color:var(--text-tertiary)">暂无描述</em>'}</p>
                  </label>`
                }).join('')}
                ${metaSkills.length === 0 ? '<div class="re-empty">暂无已安装技能</div>' : ''}
              </div>
            </section>
`
  
  // 创建 overlay
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay role-editor-overlay'

  const navHtml = editorTabs.map((tab, i) => `
    <button type="button" class="re-nav-item${i === 0 ? ' re-nav-item--active' : ''}" data-editor-tab="${tab.id}">
      <span class="re-nav-ico">${tab.icon}</span><span>${tab.label}</span>
    </button>
  `).join('')

  overlay.innerHTML = `
    <div class="role-editor-modal role-editor-modal--wide">
      <header class="re-header">
        <div class="re-header-left">
          <span class="re-header-dot" style="background:#0f766e"></span>
          <strong>编辑智能体</strong>
        </div>
        <button type="button" class="re-close" data-action="close" aria-label="关闭">&times;</button>
      </header>
      ${renderAgentSheetHero(agent, id, {
        hired: (state.hiredCodes instanceof Set ? state.hiredCodes : new Set()).has(String(id || '').trim()),
        stats: capabilityStatLabels(agent, state),
      })}
      <div class="re-body">
        <nav class="re-nav">${navHtml}</nav>
        <main class="re-main">
          <div class="re-panel-head">
            <h3 id="editor-panel-title">基本信息</h3>
            <p id="editor-panel-desc">配置名称、描述、工具、MCP 与技能，左侧可切换</p>
          </div>
          <div class="re-panels">

            <!-- 基本信息面板 -->
            <section class="re-panel" data-panel="basic">
              <div class="form-group">
                <label class="form-label">角色头像</label>
                <div id="role-avatar-picker-mount" data-agent-id="${escapeAttr(id)}"></div>
              </div>
              <div class="form-group">
                <label class="form-label">角色标识</label>
                <input class="form-input re-field-id" value="${escapeHtml(id)}" readonly style="opacity:.55;cursor:not-allowed;font-family:var(--font-mono)">
              </div>
              <div class="form-group">
                <label class="form-label">中文名称</label>
                <input class="form-input re-field-name" value="${escapeHtml(agent.agent_name || '')}" placeholder="例如：在线搜索同学">
              </div>
              <div class="form-group">
                <label class="form-label">角色描述</label>
                <input class="form-input re-field-desc" value="${escapeHtml(editState.description)}" placeholder="例如：翻译助手、代码审查助手">
              </div>
              ${
                hideModelField
                  ? ''
                  : renderAgentDefaultModelField({
                      selected: editState.model,
                      models: modelOptions,
                      primary: primaryModel,
                    })
              }
              ${id === 'main' ? '' : renderTagEditorHtml(editState.tags)}
              <div class="form-group">
                <label class="form-label">系统提示词</label>
                <textarea class="form-input re-field-system-prompt" placeholder="定义该角色的核心指令和行为规范&#10;&#10;示例：&#10;- 你是专业的在线搜索助手&#10;- 擅长查找最新资讯和信息&#10;- 回答要简洁准确" rows="8" style="font-family:var(--font-mono);font-size:13px;line-height:1.6;resize:vertical;">${escapeHtml(editState.system_prompt)}</textarea>
              </div>
              ${extCli ? `<div class="form-group"><p class="form-hint" style="margin:0;line-height:1.55;color:var(--text-secondary)">外部 CLI 角色：可编辑本页与「人格 SOUL」。内置工具、MCP 与技能由本机运行时提供；保存时不会修改这些配置。</p></div>` : ''}
            </section>

            ${editorToolsMcpSkillsHtml}

            <!-- SOUL 面板 -->
            <section class="re-panel" data-panel="soul" hidden>
              <div class="form-group" style="margin-bottom:0">
                <textarea class="form-input re-field-soul" placeholder="定义角色的个性、行为约束、输出风格等。&#10;&#10;示例：&#10;- 你是一个专业的翻译助手&#10;- 翻译要准确且自然流畅&#10;- 不确定时主动询问用户" rows="16" style="font-family:var(--font-mono);font-size:13px;line-height:1.75;resize:vertical;border-radius:var(--radius-lg);border-color:var(--border-primary)">${escapeHtml(editState.soul)}</textarea>
                <div class="form-hint">SOUL 定义了 AI 角色的核心人格与行为边界</div>
              </div>
            </section>

          </div>
        </main>
      </div>
      <footer class="re-footer">
        <button class="btn btn-secondary" data-action="cancel">取消</button>
        <button class="btn btn-primary" data-action="save">保存更改</button>
      </footer>
    </div>
  `

  document.body.appendChild(overlay)
  mountRoleCardAvatars(overlay, [agent], 56)
  bindTagEditor(overlay)

  const avatarPickerState = {
    avatar: editState.avatar,
    avatar_meta: editState.avatar_meta,
    previewUrl: null,
  }

  const pickerMount = overlay.querySelector('#role-avatar-picker-mount')
  void gatewayBaseForAvatars().then((baseUrl) => {
    mountAgentAvatarPicker(pickerMount, {
      agentCode: id,
      agentName: agent.agent_name,
      baseUrl,
      value: avatarPickerState,
      onChange: (next) => {
        avatarPickerState.avatar = next.avatar
        avatarPickerState.avatar_meta = next.avatar_meta
        avatarPickerState.previewUrl = next.previewUrl
      },
      onUpload: async (blob, meta) => {
        await api.uploadAgentAvatar(id, blob)
        await api.updateAgent(id, { avatar: 'image', avatar_meta: meta })
        avatarPickerState.avatar = 'image'
        avatarPickerState.avatar_meta = meta
      },
    })
  })

  // ---- 事件 ----
  const closeFn = () => overlay.remove()
  overlay.querySelector('[data-action=close]')?.addEventListener('click', closeFn)
  overlay.querySelector('[data-action=cancel]')?.addEventListener('click', closeFn)
  overlay.addEventListener('click', e => { if (e.target === overlay) closeFn() })

  // Tab 切换
  const tabMeta = Object.fromEntries(editorTabs.map(t => [t.id, t]))
  overlay.addEventListener('click', e => {
    const tabBtn = e.target.closest('[data-editor-tab]')
    if (tabBtn) {
      const tid = tabBtn.dataset.editorTab
      overlay.querySelectorAll('.re-nav-item').forEach(b => b.classList.toggle('re-nav-item--active', b.dataset.editorTab === tid))
      overlay.querySelectorAll('.re-panel').forEach(p => p.toggleAttribute('hidden', p.dataset.panel !== tid))
      const meta = tabMeta[tid]
      if (meta) {
        overlay.querySelector('#editor-panel-title').textContent = meta.label
        overlay.querySelector('#editor-panel-desc').textContent = _getPanelDesc(tid)
      }
    }
  })

  // 搜索过滤
  overlay.querySelectorAll('.re-search').forEach(input => {
    input.addEventListener('input', () => {
      const kw = input.value.trim().toLowerCase()
      input.closest('.re-panel').querySelectorAll('.re-check, .skill-card').forEach(item => {
        item.style.display = (!kw || (item.dataset.search || '').includes(kw)) ? '' : 'none'
      })
    })
  })

  // 全选 / 清空
  const bindSelClr = (selCls, clrCls, listName, fieldName) => {
    overlay.querySelector(selCls)?.addEventListener('click', () => {
      overlay.querySelectorAll(`.${listName} input`).forEach(cb => cb.checked = true)
      updateCount(overlay, fieldName)
    })
    overlay.querySelector(clrCls)?.addEventListener('click', () => {
      overlay.querySelectorAll(`.${listName} input`).forEach(cb => cb.checked = false)
      updateCount(overlay, fieldName)
    })
  }
  bindSelClr('.re-sel-all-tools', '.re-clr-tools', 'editor-tool-list', 'tools')
  bindSelClr('.re-sel-all-mcp', '.re-clr-mcp', 'editor-mcp-list', 'mcp_servers')
  bindSelClr('.re-sel-all-skills', '.re-clr-skills', 'editor-skill-list', 'skills')

  // checkbox 计数更新
  overlay.querySelectorAll('.editor-tool-list input').forEach(cb => cb.addEventListener('change', () => updateCount(overlay, 'tools')))
  overlay.querySelectorAll('.editor-mcp-list input').forEach(cb => cb.addEventListener('change', () => updateCount(overlay, 'mcp_servers')))
  overlay.querySelectorAll('.editor-skill-list input').forEach(cb => cb.addEventListener('change', () => updateCount(overlay, 'skills')))

  // 保存
  overlay.querySelector('[data-action=save]')?.addEventListener('click', async () => {
    const agent_name = overlay.querySelector('.re-field-name')?.value?.trim() || null
    const description = overlay.querySelector('.re-field-desc').value.trim()
    const soul = overlay.querySelector('.re-field-soul')?.value?.trim() || ''
    const system_prompt = overlay.querySelector('.re-field-system-prompt')?.value?.trim() || null
    const modelRaw = readAgentDefaultModel(overlay)
    const tags = id === 'main' ? [] : readTagsFromEditor(overlay)
    const tools = [...overlay.querySelectorAll('.editor-tool-list input:checked')].map(el => el.value)
    const mcp_servers = [...overlay.querySelectorAll('.editor-mcp-list input:checked')].map(el => el.value)
    const skills = [...overlay.querySelectorAll('.editor-skill-list input:checked')].map(el => el.value)

    try {
      if (agentUsesExternalCli(agent) || isXiaomiFrontDesk(agent)) {
        const requestData = {
          agent_name,
          description,
          soul: soul || null,
          system_prompt,
          tags,
          avatar: avatarPickerState.avatar,
          avatar_meta: avatarPickerState.avatar_meta,
        }
        if (isXiaomiFrontDesk(agent)) {
          requestData.tools = []
          requestData.mcp_servers = []
          requestData.skills = []
        }
        await api.updateAgent(id, requestData)
        agent.agent_name = agent_name
        agent.description = description
        agent.soul = soul || null
        agent.system_prompt = system_prompt
        agent.tags = tags
        agent.avatar = avatarPickerState.avatar
        agent.avatar_meta = avatarPickerState.avatar_meta
        if (isXiaomiFrontDesk(agent)) {
          agent.tools = []
          agent.mcp_servers = []
          agent.skills = []
        }
        if (avatarPickerState.avatar === 'image') agent.has_avatar_file = true
        else if (avatarPickerState.avatar !== 'image') agent.has_avatar_file = false
      } else {
        const isAllTools = tools.length === metaTools.length &&
                           tools.every(v => metaTools.some(t => t.value === v))
        const isAllMcp = mcp_servers.length === metaMcpServers.length &&
                         mcp_servers.every(v => metaMcpServers.some(t => t.value === v))
        const model = modelRaw === undefined ? undefined : modelRaw || null
        const requestData = {
          agent_name,
          description,
          tools: isAllTools ? null : tools,
          mcp_servers: isAllMcp ? null : mcp_servers,
          skills,
          soul: soul || null,
          system_prompt,
          tags,
          avatar: avatarPickerState.avatar,
          avatar_meta: avatarPickerState.avatar_meta,
        }
        if (model !== undefined) {
          requestData.model = model
        }

        await api.updateAgent(id, requestData)
        agent.agent_name = agent_name
        agent.description = description
        if (model !== undefined) agent.model = model
        agent.tools = isAllTools ? null : tools
        agent.mcp_servers = isAllMcp ? null : mcp_servers
        agent.skills = skills
        agent.soul = soul || null
        agent.system_prompt = system_prompt
        agent.tags = tags
        agent.avatar = avatarPickerState.avatar
        agent.avatar_meta = avatarPickerState.avatar_meta
        if (avatarPickerState.avatar === 'image') agent.has_avatar_file = true
        else if (avatarPickerState.avatar !== 'image') agent.has_avatar_file = false
      }
      if (typeof state.onRefresh === 'function') await state.onRefresh()
      closeFn()
      toast(`角色「${id}」已更新`, 'success')
    } catch (e) {
      console.error('[角色编辑] 保存失败:', e)
      toast('保存失败: ' + e, 'error')
    }
  })

  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { closeFn(); document.removeEventListener('keydown', onKey) }
  })
}

function _getPanelDesc(tabId) {
  return { basic: '配置角色的名称、描述、默认模型与系统提示词', tools: '选择该角色可使用的内置工具', mcp: '选择该角色可连接的 MCP 服务器', skills: '选择该角色可调用的技能模块', soul: '定义角色的个性、行为约束与输出风格' }[tabId] || ''
}

function updateCount(overlay, fieldName) {
  const map = { tools: 'tool', mcp_servers: 'mcp', skills: 'skill' }
  const cls = map[fieldName] || fieldName
  const el = overlay.querySelector(`.${fieldName}-count .re-num`)
  if (el) el.textContent = overlay.querySelectorAll(`.editor-${cls}list input:checked`).length
}

// ========== 删除 ==========
async function deleteRole(page, state, id) {
  const yes = await showConfirm(`确定删除角色「${id}」？\n\n此操作将永久删除该角色的所有数据和会话记录。`)
  if (!yes) return
  try {
    await api.deleteAgent(id)
    toast('已删除', 'success')
    if (typeof state.onRefresh === 'function') await state.onRefresh()
  } catch (e) {
    toast('删除失败: ' + e, 'error')
  }
}
