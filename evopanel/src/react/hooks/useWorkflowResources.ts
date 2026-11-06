import { useCallback, useEffect, useState } from 'react'
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
  return list.map((a) => ({
    ...a,
    agent_code: String(a?.agent_code || '').trim(),
    agent_name: a?.agent_name != null ? String(a.agent_name) : a?.agent_name,
    description: a?.description != null ? String(a.description) : '',
    skills: Array.isArray(a?.skills) ? a.skills.map((s) => String(s || '').trim()).filter(Boolean) : [],
    tools: Array.isArray(a?.tools) ? a.tools.map((t) => String(t || '').trim()).filter(Boolean) : [],
  }))
}

/** 工作流只用通用 Agent 列表；员工岗位留给值班/自动化任务，不混进编排。 */
function tagGenericAgents(agents: AgentPickerRow[]): AgentPickerRow[] {
  return agents.map((a) => ({
    ...a,
    tags: Array.from(new Set([...(Array.isArray(a.tags) ? a.tags.map(String) : []), '通用'])),
  }))
}

async function waitGatewayIfNeeded() {
  const { isGatewayWarming, waitForBackendReady } = await import('../../lib/tauri-api.js')
  if (typeof isGatewayWarming === 'function' && isGatewayWarming()) {
    await waitForBackendReady?.(90_000).catch(() => {})
  }
}

export function useWorkflowResources(enabled: boolean) {
  const [agents, setAgents] = useState<AgentPickerRow[]>([])
  const [skills, setSkills] = useState<SkillPickerItem[]>([])
  const [tools, setTools] = useState<WorkflowToolItem[]>([])
  const [mcpServers, setMcpServers] = useState<WorkflowMcpItem[]>([])
  const [loading, setLoading] = useState(Boolean(enabled))
  const [error, setError] = useState<string | null>(null)

  const loadAll = useCallback(async () => {
    try {
      setLoading(true)
      await waitGatewayIfNeeded()
      const [agentRes, meta] = await Promise.all([
        api.listAgents(),
        api.getToolsMetadata().catch((err) => {
          console.warn('[useWorkflowResources] getToolsMetadata failed:', err)
          return null
        }),
      ])
      setAgents(tagGenericAgents(normalizeAgentList(agentRes)))
      const rawTools = (meta?.tools || meta?.data?.tools || []) as Record<string, unknown>[]
      setTools(rawTools.map(mapTool).filter((t) => t.value))

      let mcpList: WorkflowMcpItem[] = []
      const fromMeta = meta?.mcp_servers || meta?.data?.mcp_servers
      if (fromMeta && typeof fromMeta === 'object') {
        mcpList = Object.entries(
          fromMeta as Record<string, { enabled?: boolean; description?: string }>,
        ).map(([name, cfg]) => ({
          name,
          description: String(cfg?.description || ''),
          enabled: cfg?.enabled !== false,
        }))
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
      return true
    } catch (err) {
      console.warn('[useWorkflowResources] load failed:', err)
      setError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setLoading(false)
    }
  }, [])

  const reloadAgents = useCallback(async () => {
    if (!enabled) return
    try {
      await waitGatewayIfNeeded()
      const agentRes = await api.listAgents()
      setAgents(tagGenericAgents(normalizeAgentList(agentRes)))
    } catch (err) {
      console.warn('[useWorkflowResources] reloadAgents failed:', err)
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    let cancelled = false
    ;(async () => {
      if (cancelled) return
      await loadAll()
    })()
    return () => {
      cancelled = true
    }
  }, [enabled, loadAll])

  // 冷启动第一次可能撞 warming timeout；网关就绪后补拉（对齐 useProactiveRoles）
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let unsub: (() => void) | undefined
    void import('../../lib/tauri-api.js').then((mod) => {
      if (cancelled) return
      if (typeof mod.onBackendReadyChange === 'function') {
        unsub = mod.onBackendReadyChange((ready: boolean) => {
          if (ready) void loadAll()
        })
      }
    })
    return () => {
      cancelled = true
      try {
        unsub?.()
      } catch {
        /* ignore */
      }
    }
  }, [enabled, loadAll])

  useEffect(() => {
    if (!enabled) return
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
    const unsub = subscribeSkillCatalog(
      (
        list: Array<{
          name: string
          label?: string
          description?: string
          icon?: string
          enabled?: boolean
        }>,
      ) => {
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
      },
    )
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [enabled])

  return { agents, skills, tools, mcpServers, loading, error, reloadAgents }
}
