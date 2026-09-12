import { useEffect, useState } from 'react'
import { api } from '../../lib/tauri-api.js'
import { loadSkillCatalog, subscribeSkillCatalog } from '../../lib/skill-catalog.js'
import type { AgentPickerRow } from '../lib/agent-tags.ts'
import type { SkillPickerItem } from '../components/SkillPickerModal.tsx'

export type WorkflowToolItem = {
  value: string
  label: string
  icon: string
  desc: string
  tier: string
  typeLabel: string
}

export type WorkflowMcpItem = {
  name: string
  description: string
  enabled: boolean
}

const TOOL_TIER_LABEL_FALLBACK: Record<string, string> = {
  runtime: '系统核心',
  core: '日常常驻',
  workspace: '工作区',
  plan: '规划协作',
  goal: '目标模式',
  optional: '扩展可选',
  retired: '已退役',
}

function mapTool(t: Record<string, unknown>): WorkflowToolItem {
  const tier = String(t.tool_type || 'optional')
  return {
    value: String(t.name || ''),
    label: String(t.label || t.name || ''),
    icon: String(t.icon || '⚙'),
    desc: String(t.description || ''),
    tier,
    typeLabel:
      String(t.tool_type_label || t.role_editor_type_label || TOOL_TIER_LABEL_FALLBACK[tier] || tier),
  }
}

function normalizeAgentList(raw: unknown): AgentPickerRow[] {
  let list: AgentPickerRow[] = []
  if (Array.isArray(raw)) list = raw as AgentPickerRow[]
  else if (raw && typeof raw === 'object') {
    const obj = raw as { agents?: AgentPickerRow[]; data?: { agents?: AgentPickerRow[] } }
    list = obj.agents || obj.data?.agents || []
  }
  // Keep description / skills / tools from GET /agents (already on AgentResponse).
  return list.map((a) => ({
    ...a,
    agent_code: String(a?.agent_code || '').trim(),
    agent_name: a?.agent_name != null ? String(a.agent_name) : a?.agent_name,
    description: a?.description != null ? String(a.description) : '',
    skills: Array.isArray(a?.skills) ? a.skills.map((s) => String(s || '').trim()).filter(Boolean) : [],
    tools: Array.isArray(a?.tools) ? a.tools.map((t) => String(t || '').trim()).filter(Boolean) : [],
  }))
}

export function useWorkflowResources(_open: boolean) {
  const [agents, setAgents] = useState<AgentPickerRow[]>([])
  const [skills, setSkills] = useState<SkillPickerItem[]>([])
  const [tools, setTools] = useState<WorkflowToolItem[]>([])
  const [mcpServers, setMcpServers] = useState<WorkflowMcpItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Load immediately (not gated by `open`) so resources are ready when the
  // drawer / picker first opens — avoids the blank-first-render flash.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [agentRes, meta] = await Promise.all([
          api.listAgents(),
          api.getToolsMetadata().catch((err) => {
            console.warn('[useWorkflowResources] getToolsMetadata failed:', err)
            return null
          }),
        ])
        if (cancelled) return
        setAgents(normalizeAgentList(agentRes))
        const rawTools = (meta?.tools || meta?.data?.tools || []) as Record<string, unknown>[]
        setTools(rawTools.map(mapTool).filter((t) => t.value))

        let mcpList: WorkflowMcpItem[] = []
        const fromMeta = meta?.mcp_servers || meta?.data?.mcp_servers
        if (fromMeta && typeof fromMeta === 'object') {
          mcpList = Object.entries(fromMeta as Record<string, { enabled?: boolean; description?: string }>).map(
            ([name, cfg]) => ({
              name,
              description: String(cfg?.description || ''),
              enabled: cfg?.enabled !== false,
            }),
          )
        } else {
          const mcpCfg = await api.getMCPConfig().catch((err) => {
            console.warn('[useWorkflowResources] getMCPConfig failed:', err)
            return null
          })
          const servers = mcpCfg?.mcp_servers || {}
          mcpList = Object.entries(servers).map(([name, cfg]) => ({
            name,
            description: String((cfg as { description?: string })?.description || ''),
            enabled: (cfg as { enabled?: boolean })?.enabled !== false,
          }))
        }
        setMcpServers(mcpList.filter((s) => s.enabled))
        setError(null)
      } catch (err) {
        console.warn('[useWorkflowResources] load failed:', err)
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    loadSkillCatalog({ enabledOnly: true }).then((list) => {
      if (!cancelled) {
        setSkills(
          (list || []).map((s) => ({
            name: s.name,
            label: s.label || s.name,
            description: s.description || '',
            icon: s.icon || '🧩',
            enabled: s.enabled !== false,
          })),
        )
      }
    })
    const unsub = subscribeSkillCatalog((list: Array<{ name: string; label?: string; description?: string; icon?: string; enabled?: boolean }>) => {
      if (cancelled) return
      setSkills(
        (list || []).map((s) => ({
          name: s.name,
          label: s.label || s.name,
          description: s.description || '',
          icon: s.icon || '🧩',
          enabled: s.enabled !== false,
        })),
      )
    })
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [])

  return { agents, skills, tools, mcpServers, loading, error }
}
