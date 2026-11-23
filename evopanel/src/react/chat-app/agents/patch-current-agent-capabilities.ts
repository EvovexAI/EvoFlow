/**
 * Patch skills/tools/mcp/knowledge bindings for the current agent or employee role.
 * Extracted from ChatApp.tsx (P36).
 */
import type { Dispatch, SetStateAction } from 'react'
import { toast } from '../../../components/toast.js'
import type { AgentPickerRow } from '../../lib/agent-tags.js'
import { mapAgentPickerRows } from './map-agent-picker-rows.js'

export type PatchCurrentAgentCapabilitiesCtx = {
  currentRoleCodeForUi: string | null | undefined
  employeeSessionAgentCode: string | null | undefined
  isProactiveEmployeeSession: boolean
  getApi: () => Promise<{
    proactiveUpdateRole: (code: string, patch: Record<string, unknown>) => Promise<unknown>
    updateAgent: (code: string, patch: Record<string, unknown>) => Promise<unknown>
  }>
  setCapabilityPatchBusy: (busy: boolean) => void
  setRoleUiNonce: (fn: (n: number) => number) => void
  refreshAgentsList: () => Promise<void>
  /** Merge updateAgent response into local picker rows so MCP/tools UI updates immediately. */
  setAgents?: Dispatch<SetStateAction<AgentPickerRow[]>>
}

function upsertAgentRow(
  setAgents: Dispatch<SetStateAction<AgentPickerRow[]>> | undefined,
  code: string,
  updated: unknown,
  patch: {
    skills?: string[]
    tools?: string[] | null
    mcp_servers?: string[] | null
    knowledge_vault_ids?: string[]
  },
): void {
  if (!setAgents) return
  const want = String(code || '')
    .trim()
    .toLowerCase()
  if (!want) return
  const fromApi = updated && typeof updated === 'object' ? (updated as AgentPickerRow) : null
  const mapped = fromApi
    ? mapAgentPickerRows([
        {
          ...fromApi,
          agent_code: String(fromApi.agent_code || want).trim() || want,
        },
      ])[0]
    : null
  setAgents((prev) => {
    const list = Array.isArray(prev) ? prev : []
    const idx = list.findIndex(
      (a) => String(a?.agent_code || '').trim().toLowerCase() === want,
    )
    const base =
      idx >= 0
        ? list[idx]
        : ({ agent_code: want } as AgentPickerRow)
    const nextRow: AgentPickerRow = {
      ...base,
      ...(mapped || {}),
      agent_code: String(mapped?.agent_code || base.agent_code || want).trim() || want,
      skills:
        patch.skills !== undefined
          ? patch.skills
          : mapped?.skills !== undefined
            ? mapped.skills
            : base.skills,
      tools:
        patch.tools !== undefined
          ? patch.tools
          : mapped?.tools !== undefined
            ? mapped.tools
            : base.tools,
      mcp_servers:
        patch.mcp_servers !== undefined
          ? patch.mcp_servers
          : mapped?.mcp_servers !== undefined
            ? mapped.mcp_servers
            : base.mcp_servers,
      knowledge_vault_ids:
        patch.knowledge_vault_ids !== undefined
          ? patch.knowledge_vault_ids
          : mapped?.knowledge_vault_ids !== undefined
            ? mapped.knowledge_vault_ids
            : base.knowledge_vault_ids,
    }
    if (idx >= 0) {
      const copy = list.slice()
      copy[idx] = nextRow
      return copy
    }
    return [...list, nextRow]
  })
}

export async function patchCurrentAgentCapabilities(
  ctx: PatchCurrentAgentCapabilitiesCtx,
  patch: {
    skills?: string[]
    tools?: string[] | null
    mcp_servers?: string[] | null
    knowledge_vault_ids?: string[]
  },
): Promise<void> {
  const code = String(
    (ctx.isProactiveEmployeeSession ? ctx.employeeSessionAgentCode : '') ||
      ctx.currentRoleCodeForUi ||
      '',
  ).trim()
  if (!code) {
    toast('当前没有可编辑的智能体', 'warning')
    return
  }
  ctx.setCapabilityPatchBusy(true)
  try {
    const api = await ctx.getApi()
    const agentPatch: Record<string, unknown> = {}
    if (patch.skills !== undefined) agentPatch.skills = patch.skills
    if (patch.tools !== undefined) agentPatch.tools = patch.tools
    if (patch.mcp_servers !== undefined) agentPatch.mcp_servers = patch.mcp_servers

    if (patch.knowledge_vault_ids !== undefined) {
      if (ctx.isProactiveEmployeeSession) {
        await api.proactiveUpdateRole(code, {
          knowledge_vault_ids: patch.knowledge_vault_ids,
        })
        ctx.setRoleUiNonce((n) => n + 1)
      } else {
        agentPatch.knowledge_vault_ids = patch.knowledge_vault_ids
      }
    }

    if (Object.keys(agentPatch).length > 0) {
      const updated = await api.updateAgent(code, agentPatch)
      upsertAgentRow(ctx.setAgents, code, updated, patch)
      ctx.setRoleUiNonce((n) => n + 1)
      try {
        await ctx.refreshAgentsList()
      } catch {
        /* local upsert already applied */
      }
    }
    toast('已更新能力绑定', 'success')
  } catch (e) {
    toast(`更新失败：${(e as Error)?.message || e}`, 'error')
    throw e
  } finally {
    ctx.setCapabilityPatchBusy(false)
  }
}
