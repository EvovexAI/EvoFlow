/** Shared helpers for agent tags / roles pages. */

export const BUILTIN_AGENT_TAGS = [
  { key: 'core', label: '核心', icon: '⚙️', color: '#6366f1' },
  { key: 'project', label: '项目', icon: '📁', color: '#0ea5e9' },
  { key: 'media', label: '媒体', icon: '🎬', color: '#ec4899' },
  { key: 'video', label: '视频', icon: '🎥', color: '#f59e0b' },
  { key: 'animation', label: '动画', icon: '🎞️', color: '#f97316' },
  { key: 'code', label: '代码', icon: '💻', color: '#10b981' },
  { key: 'debug', label: '调试', icon: '🐞', color: '#ef4444' },
  { key: 'docs', label: '文档', icon: '📄', color: '#8b5cf6' },
  { key: 'marketing', label: '营销', icon: '📢', color: '#f97316' },
  { key: 'social', label: '社媒', icon: '📱', color: '#06b6d4' },
  { key: 'finance', label: '财务', icon: '💰', color: '#059669' },
  { key: 'custom', label: '自定义', icon: '✨', color: '#64748b' },
]

export function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function escapeAttr(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function normalizeAgentTags(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const item of raw) {
    const label = String(item || '').trim()
    if (!label || seen.has(label)) continue
    seen.add(label)
    out.push(label)
  }
  return out
}

export function tagMetaForLabel(label) {
  const key = String(label || '').trim()
  const found = BUILTIN_AGENT_TAGS.find((t) => t.label === key)
  return found || { key, label: key, icon: '🏷️', color: '#64748b' }
}

export function agentHasTag(agent, tagLabel) {
  const wanted = String(tagLabel || '').trim()
  if (!wanted) return true
  const tags = normalizeAgentTags(agent?.tags)
  return tags.some((t) => t.includes(wanted) || wanted.includes(t))
}

export function collectTagsFromAgents(agents) {
  const seen = new Set()
  const out = []
  for (const t of BUILTIN_AGENT_TAGS) {
    seen.add(t.label)
    out.push(t.label)
  }
  for (const agent of agents || []) {
    for (const label of normalizeAgentTags(agent?.tags)) {
      if (seen.has(label)) continue
      seen.add(label)
      out.push(label)
    }
  }
  return out
}

export function countAgentsWithTag(agents, tagLabel) {
  return (agents || []).filter((a) => agentHasTag(a, tagLabel)).length
}

export function sortAgents(agents) {
  return [...(agents || [])].sort((a, b) => {
    if (a.agent_code === 'main') return -1
    if (b.agent_code === 'main') return 1
    return String(a.agent_code || '').localeCompare(String(b.agent_code || ''))
  })
}

/** 外部 CLI 角色在本机不可运行时不展示（如未安装 Claude Code / Windows 子进程不可用）。 */
export function isAgentRuntimeAvailable(agent) {
  if (agent?.requires_external_cli === true && agent?.external_cli_available === false) {
    return false
  }
  return true
}

export function filterAgentsForDisplay(agents) {
  return (agents || []).filter(isAgentRuntimeAvailable)
}

export function parseTagsInput(raw) {
  if (Array.isArray(raw)) return normalizeAgentTags(raw)
  return normalizeAgentTags(String(raw || '').split(/[,，]/))
}

/** 用途筛选项（与标签库对齐，用于「用途」下拉） */
export const AGENT_PURPOSE_OPTIONS = [
  { key: 'code', label: '代码' },
  { key: 'project', label: '项目管理' },
  { key: 'media', label: '媒体' },
  { key: 'video', label: '视频' },
  { key: 'animation', label: '动画' },
  { key: 'docs', label: '文档' },
  { key: 'marketing', label: '营销' },
  { key: 'social', label: '社媒' },
  { key: 'content', label: '内容' },
]

export const AGENT_STATUS_OPTIONS = [
  { key: 'available', label: '可用' },
  { key: 'running', label: '运行中' },
  { key: 'offline', label: '离线' },
  { key: 'error', label: '配置异常' },
]

export const AGENT_SOURCE_OPTIONS = [
  { key: 'system', label: '系统' },
  { key: 'custom', label: '' },
  { key: 'skillhub', label: 'SkillHub' },
]

export const AGENT_DEPLOY_OPTIONS = [
  { key: 'none', label: '未部署' },
  { key: 'employee', label: '员工' },
  { key: 'app', label: '工作流' },
  { key: 'automation', label: '自动化' },
]

export const AGENT_SORT_OPTIONS = [
  { key: 'recent', label: '最近使用' },
  { key: 'name', label: '名称' },
  { key: 'code', label: '标识' },
]

const PURPOSE_LABEL_SET = new Set(AGENT_PURPOSE_OPTIONS.map((o) => o.label))
const META_TAG_LABELS = new Set(['核心', '自定义', 'SkillHub', 'skillhub'])

export function agentHasSkillHubTag(agent) {
  return normalizeAgentTags(agent?.tags).some((t) => /skillhub/i.test(t))
}

/** 来源：系统 / 自定义 / SkillHub */
export function agentSourceOf(agent) {
  if (agentHasSkillHubTag(agent)) return 'skillhub'
  const code = String(agent?.agent_code || '').trim().toLowerCase()
  const type = String(agent?.agent_type || '').trim().toLowerCase()
  if (code === 'main' || code === 'xiaomi' || type === 'subagent' || type === 'acp') return 'system'
  return 'custom'
}

/**
 * 运行状态：可用 / 运行中 / 离线 / 配置异常
 * @param {object} agent
 * @param {{ hiredRolesByCode?: Map<string, object> }} [ctx]
 */
export function agentRunStatusOf(agent, ctx = {}) {
  const code = String(agent?.agent_code || '').trim()
  if (agent?.requires_external_cli === true && agent?.external_cli_available === false) {
    return 'offline'
  }
  const role = ctx.hiredRolesByCode?.get(code)
  if (role) {
    const st = String(role.status || '').toLowerCase()
    if (st === 'active') return 'running'
    if (st === 'paused') return 'available'
  }
  // 无独立健康检查时，可运行即视为在线/可用
  return 'available'
}

/**
 * 部署情况：none | employee | app | automation
 * 优先级：员工 > 应用 > 自动化 > 未部署
 */
export function agentDeployKindOf(agent, ctx = {}) {
  const code = String(agent?.agent_code || '').trim()
  if (!code) return 'none'
  if (ctx.hiredCodes instanceof Set && ctx.hiredCodes.has(code)) return 'employee'
  if (ctx.appAgentCodes instanceof Map && ctx.appAgentCodes.has(code)) return 'app'
  if (ctx.appAgentCodes instanceof Set && ctx.appAgentCodes.has(code)) return 'app'
  if (ctx.automationAgentCodes instanceof Set && ctx.automationAgentCodes.has(code)) return 'automation'
  return 'none'
}

export function agentTypeLabelOf(agent) {
  const code = String(agent?.agent_code || '').trim().toLowerCase()
  if (code === 'main') return '默认助手'
  if (code === 'xiaomi') return '系统前台'
  if (agent?.requires_external_cli) return '外部 CLI'
  const type = String(agent?.agent_type || '').trim().toLowerCase()
  if (type === 'subagent') return '子智能体'
  if (type === 'acp') return 'ACP'
  // 普通自建岗：签名行只保留圆点分隔，不再标「自定义」
  return ''
}

/** 卡片核心能力：用途类标签优先，其余标签补齐，最多 max */
export function agentCapabilityTags(agent, max = 3) {
  const tags = normalizeAgentTags(agent?.tags).filter((t) => !META_TAG_LABELS.has(t))
  const purpose = tags.filter((t) => PURPOSE_LABEL_SET.has(t) || AGENT_PURPOSE_OPTIONS.some((o) => t.includes(o.label)))
  const rest = tags.filter((t) => !purpose.includes(t))
  const merged = [...purpose, ...rest]
  if (merged.length < max) {
    for (const s of Array.isArray(agent?.skills) ? agent.skills : []) {
      const label = String(s || '').trim()
      if (!label || merged.includes(label)) continue
      merged.push(label)
      if (merged.length >= max + 8) break
    }
  }
  return { shown: merged.slice(0, max), extra: Math.max(0, merged.length - max), all: merged }
}

export function agentMatchesPurpose(agent, purposeKey) {
  const key = String(purposeKey || '').trim()
  if (!key) return true
  const opt = AGENT_PURPOSE_OPTIONS.find((o) => o.key === key)
  const label = opt?.label || key
  if (agentHasTag(agent, label)) return true
  // 「内容」≈ 媒体/文档/营销 等
  if (key === 'content') {
    return ['媒体', '文档', '营销', '社媒', '视频'].some((t) => agentHasTag(agent, t))
  }
  if (key === 'project') {
    return agentHasTag(agent, '项目') || agentHasTag(agent, '项目管理')
  }
  return false
}

/**
 * 二级视图：mine | deployed | market
 * mine — 自建 / 安装（含 main、自定义、SkillHub）
 * deployed — 已投入运行
 * market — 系统模板 + SkillHub 来源
 */
export function agentMatchesView(agent, view, ctx = {}) {
  const v = String(view || 'mine').trim() || 'mine'
  const source = agentSourceOf(agent)
  const deploy = agentDeployKindOf(agent, ctx)
  if (v === 'deployed') return deploy !== 'none'
  if (v === 'market') return source === 'system' || source === 'skillhub'
  // mine: 自己创建和安装的（排除纯系统子智能体模板，除非已安装 SkillHub / 自定义 / 主助手）
  if (source === 'custom' || source === 'skillhub') return true
  const code = String(agent?.agent_code || '').trim().toLowerCase()
  if (code === 'main' || code === 'xiaomi') return true
  return false
}

export function filterAgentsList(agents, state, ctx = {}) {
  const view = state.view || 'mine'
  const q = String(state.filter || '').trim().toLowerCase()
  const status = String(state.statusFilter || '').trim()
  const purpose = String(state.purposeFilter || '').trim()
  const source = String(state.sourceFilter || '').trim()
  const deploy = String(state.deployFilter || '').trim()
  const tagLabels = Array.isArray(state.tagFilters) ? state.tagFilters : []

  return (agents || []).filter((a) => {
    if (!agentMatchesView(a, view, ctx)) return false
    if (status && agentRunStatusOf(a, ctx) !== status) return false
    if (purpose && !agentMatchesPurpose(a, purpose)) return false
    if (source && agentSourceOf(a) !== source) return false
    if (deploy && agentDeployKindOf(a, ctx) !== deploy) return false
    if (tagLabels.length && !tagLabels.every((t) => agentHasTag(a, t))) return false
    if (!q) return true
    const cliMissing = a.requires_external_cli === true && a.external_cli_available === false
    const text = [
      a.agent_code,
      a.agent_name,
      a.description,
      a.tool_groups?.join(','),
      a.tools?.join(','),
      a.mcp_servers?.join(','),
      a.skills?.join(','),
      a.agent_type,
      ...(normalizeAgentTags(a.tags) || []),
      a.requires_external_cli ? '外部cli' : '',
      cliMissing ? '未检测到运行时' : '',
    ]
      .map((v) => String(v || '').toLowerCase())
      .join(' ')
    return text.includes(q)
  })
}

export function sortAgentsList(agents, sortKey = 'code') {
  const key = String(sortKey || 'code')
  const list = [...(agents || [])]
  list.sort((a, b) => {
    if (a.agent_code === 'main') return -1
    if (b.agent_code === 'main') return 1
    if (key === 'name') {
      return String(a.agent_name || a.agent_code || '').localeCompare(
        String(b.agent_name || b.agent_code || ''),
        'zh',
      )
    }
    if (key === 'recent') {
      const ra = Number(a._recentAt || a.updated_at || 0)
      const rb = Number(b._recentAt || b.updated_at || 0)
      if (rb !== ra) return rb - ra
    }
    return String(a.agent_code || '').localeCompare(String(b.agent_code || ''))
  })
  return list
}

export function runStatusLabel(status) {
  const map = { available: '在线', running: '运行中', offline: '离线', error: '配置异常' }
  return map[status] || '在线'
}

export function runStatusClass(status) {
  const map = {
    available: 'role-status--online',
    running: 'role-status--running',
    offline: 'role-status--offline',
    error: 'role-status--error',
  }
  return map[status] || 'role-status--online'
}
