// @ts-nocheck — mechanical P148 extract.
/**
 * Map proactive roles to display names from the agents catalog.
 * Extracted from ChatApp.tsx (P148).
 */
export type ResolveProactiveRolesDisplayCtx = Record<string, any>

export function resolveProactiveRolesDisplay(ctx: ResolveProactiveRolesDisplayCtx) {
  if (!ctx.proactiveRoles.length) return ctx.proactiveRoles
  return ctx.proactiveRoles.map((r) => {
    const code = String(r.agent_code || '').trim()
    const fromAgents = ctx.resolveAssignedAgentDisplayName(code, ctx.agents)
    const agentName =
      fromAgents && fromAgents !== code ? fromAgents : String(r.agent_name || '').trim()
    if (!agentName) return r
    // role_name 同步为智能体名，供 @员工 菜单沿用；另保留 agent_name 字段供侧栏专用
    return {
      ...r,
      agent_name: agentName,
      role_name: agentName !== r.role_name ? agentName : r.role_name,
    }
  })
}
