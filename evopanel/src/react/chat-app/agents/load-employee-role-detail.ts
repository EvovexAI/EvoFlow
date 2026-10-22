// @ts-nocheck — mechanical P110 extract.
/**
 * Load proactive employee role detail for the info rail. Extracted (P110).
 */
export type LoadEmployeeRoleDetailCtx = Record<string, any>

export function runLoadEmployeeRoleDetailEffect(
  ctx: LoadEmployeeRoleDetailCtx,
): () => void {
  let cancelled = false
  if (!ctx.employeeSessionAgentCode) {
    ctx.setEmployeeRoleDetail(null)
    return () => {
      cancelled = true
    }
  }
  void import('../../../lib/tauri-api.js')
    .then(({ api }) => api.proactiveGetRole(ctx.employeeSessionAgentCode))
    .then((res: any) => {
      if (cancelled) return
      const role = res?.role || res
      if (!role || typeof role !== 'object') {
        ctx.setEmployeeRoleDetail(null)
        return
      }
      const cfg = role.config && typeof role.config === 'object' ? role.config : {}
      const think = String(cfg.think_mode || '').trim()
      ctx.setEmployeeRoleDetail({
        agentCode: String(role.agent_code || ctx.employeeSessionAgentCode).trim(),
        roleName: String(role.role_name || role.agent_code || ctx.employeeSessionAgentCode).trim(),
        department: String(role.department || '').trim(),
        status: String(role.status || '').trim(),
        responsibilities: Array.isArray(cfg.responsibilities)
          ? cfg.responsibilities.map((x: unknown) => String(x || '').trim()).filter(Boolean)
          : [],
        workspacePath: String(cfg.workspace_path || '').trim(),
        modelName: String(cfg.model_name || '').trim(),
        autonomyLabel: String(cfg.autonomy_level || '').trim(),
        thinkModeLabel: think === 'prompt_only' ? '轻量工作' : think ? '深度工作' : '',
        knowledgeVaultIds: Array.isArray(cfg.knowledge_vault_ids)
          ? cfg.knowledge_vault_ids.map((x: unknown) => String(x || '').trim()).filter(Boolean)
          : [],
      })
    })
    .catch(() => {
      if (!cancelled) ctx.setEmployeeRoleDetail(null)
    })
  return () => {
    cancelled = true
  }
}
