// @ts-nocheck — mechanical P126 extract.
/**
 * Merge role agent skills with session-selected skills for the capabilities panel.
 * Extracted from ChatApp.tsx (P126).
 */
export type ResolveCurrentAgentCapabilitiesCtx = Record<string, any>

export function resolveCurrentAgentCapabilities(ctx: ResolveCurrentAgentCapabilitiesCtx) {
  const summary = ctx.agentCapabilitySummary(ctx.currentRoleAgent, Number.MAX_SAFE_INTEGER)
  const selectedNames = ctx.selectedSkills
    .map((s) => String(s.name || s.label || '').trim())
    .filter(Boolean)
  // Agent 配置技能 ∪ 本会话勾选技能
  const allSkills = Array.from(
    new Set([
      ...(Array.isArray(ctx.currentRoleAgent?.skills)
        ? ctx.currentRoleAgent.skills.map((s) => String(s || '').trim()).filter(Boolean)
        : []),
      ...selectedNames,
    ]),
  )
  const rawMcp = ctx.currentRoleAgent?.mcp_servers
  const mcpServers: string[] | null = Array.isArray(rawMcp)
    ? rawMcp.map((s) => String(s || '').trim()).filter(Boolean)
    : null
  const rawTools = ctx.currentRoleAgent?.tools
  const toolNames: string[] | null = Array.isArray(rawTools)
    ? rawTools.map((t) => String(t || '').trim()).filter(Boolean)
    : null
  const knowledgeVaultIds = Array.isArray(ctx.currentRoleAgent?.knowledge_vault_ids)
    ? ctx.currentRoleAgent.knowledge_vault_ids.map((k) => String(k || '').trim()).filter(Boolean)
    : []
  return {
    skillCount: allSkills.length,
    toolCount: toolNames?.length ?? summary.toolTotal,
    skillNames: allSkills,
    toolNames,
    mcpServers,
    knowledgeVaultIds,
  }
}
