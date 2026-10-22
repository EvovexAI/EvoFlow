/**
 * Patch skills/tools/mcp/knowledge bindings for the current agent or employee role.
 * Extracted from ChatApp.tsx (P36).
 */
import { toast } from '../../../components/toast.js'

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
      await api.updateAgent(code, agentPatch)
      await ctx.refreshAgentsList()
    }
    toast('已更新能力绑定', 'success')
  } catch (e) {
    toast(`更新失败：${(e as Error)?.message || e}`, 'error')
    throw e
  } finally {
    ctx.setCapabilityPatchBusy(false)
  }
}
