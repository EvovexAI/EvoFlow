/** Tag grouping for chat role picker and #/expert agents tab (aligned with agents-shared.js). */

export type AgentTag = {
  key: string
  label: string
  icon?: string
  color?: string
}

export type AgentPickerRow = {
  agent_code?: string
  agent_name?: string
  tags?: string[] | null
  agent_type?: string
  /** Default chat model from agent config (empty = follow global primary). */
  model?: string | null
  /** Short bio from agent config (list API already returns it). */
  description?: string | null
  /** Default skill names on the agent (optional step overlay still can add more). */
  skills?: string[] | null
  /** Default builtin tool names on the agent. `null` = unrestricted. */
  tools?: string[] | null
  /**
   * MCP servers bound to the agent.
   * `null` / omitted = unrestricted (all enabled MCP); `[]` = none; otherwise whitelist.
   */
  mcp_servers?: string[] | null
  /** Bound knowledge vault / owned KB ids (empty = none). */
  knowledge_vault_ids?: string[] | null
}

/** Normalize skill/tool list fields from list/detail agent payloads. */
export function normalizeAgentNameList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const name = String(item || '').trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

export function agentCapabilitySummary(agent: AgentPickerRow | null | undefined, max = 4): {
  skills: string[]
  tools: string[]
  skillsMore: number
  toolsMore: number
  description: string
  skillTotal: number
  toolTotal: number
} {
  const skillsAll = normalizeAgentNameList(agent?.skills)
  const toolsAll = normalizeAgentNameList(agent?.tools)
  return {
    skills: skillsAll.slice(0, max),
    tools: toolsAll.slice(0, max),
    skillsMore: Math.max(0, skillsAll.length - max),
    toolsMore: Math.max(0, toolsAll.length - max),
    description: String(agent?.description || '').trim(),
    skillTotal: skillsAll.length,
    toolTotal: toolsAll.length,
  }
}

/** Built-in tag catalog (mirrors backend ``BUILTIN_AGENT_TAGS``). */
export const BUILTIN_AGENT_TAGS: AgentTag[] = [
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

const TAG_BY_LABEL = new Map(BUILTIN_AGENT_TAGS.map((t) => [t.label, t]))

export function tagMetaForLabel(label: string): AgentTag {
  const key = String(label || '').trim()
  return TAG_BY_LABEL.get(key) || { key: key, label: key, icon: '🏷️', color: '#64748b' }
}

export function normalizeAgentTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const label = String(item || '').trim()
    if (!label || seen.has(label)) continue
    seen.add(label)
    out.push(label)
  }
  return out
}

export function agentHasTag(agent: AgentPickerRow, tagLabel: string): boolean {
  const wanted = String(tagLabel || '').trim()
  if (!wanted) return true
  const tags = normalizeAgentTags(agent?.tags)
  return tags.some((t) => t.includes(wanted) || wanted.includes(t))
}

export function collectTagsFromAgents(agents: AgentPickerRow[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const label of BUILTIN_AGENT_TAGS.map((t) => t.label)) {
    seen.add(label)
    out.push(label)
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

export function countAgentsWithTag(agents: AgentPickerRow[], tagLabel: string): number {
  return (agents || []).filter((a) => agentHasTag(a, tagLabel)).length
}

export function filterAgentsByTag(agents: AgentPickerRow[], tagLabel: string | null): AgentPickerRow[] {
  const wanted = String(tagLabel || '').trim()
  if (!wanted) return sortAgentsForPicker(agents)
  return sortAgentsForPicker((agents || []).filter((a) => agentHasTag(a, wanted)))
}

export function sortAgentsForPicker(agents: AgentPickerRow[]): AgentPickerRow[] {
  return [...(agents || [])].sort((a, b) => {
    const ca = String(a?.agent_code || '')
    const cb = String(b?.agent_code || '')
    if (ca === 'main') return -1
    if (cb === 'main') return 1
    return ca.localeCompare(cb)
  })
}

export type TagPickerEntry = AgentTag & { agent_count: number }

/** Tags for role dropdown filter chips (skip empty buckets). */
export function buildTagPickerEntries(agents: AgentPickerRow[]): TagPickerEntry[] {
  return collectTagsFromAgents(agents)
    .map((label) => {
      const meta = tagMetaForLabel(label)
      return {
        ...meta,
        agent_count: countAgentsWithTag(agents, label),
      }
    })
    .filter((t) => t.agent_count > 0)
}
