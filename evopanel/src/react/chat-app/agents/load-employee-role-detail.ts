// @ts-nocheck — mechanical P110 extract.
/**
 * Load proactive employee role detail for the info rail. Extracted (P110).
 *
 * Orphan keys like ``proactive:employee_a`` (role deleted / renamed) must not
 * throw Uncaught — soft-fail and optionally retry with session.agentId.
 */
export type LoadEmployeeRoleDetailCtx = Record<string, any>

function mapRoleDetail(role: any, fallbackCode: string) {
  const cfg = role.config && typeof role.config === 'object' ? role.config : {}
  const think = String(cfg.think_mode || '').trim()
  const thinkingRaw = cfg.thinking_enabled
  const visionRaw = cfg.vision_enabled
  return {
    agentCode: String(role.agent_code || fallbackCode).trim(),
    roleName: String(role.role_name || role.agent_code || fallbackCode).trim(),
    department: String(role.department || '').trim(),
    status: String(role.status || '').trim(),
    responsibilities: Array.isArray(cfg.responsibilities)
      ? cfg.responsibilities.map((x: unknown) => String(x || '').trim()).filter(Boolean)
      : [],
    workspacePath: String(cfg.workspace_path || '').trim(),
    modelName: String(cfg.model_name || '').trim(),
    autonomyLabel: String(cfg.autonomy_level || '').trim(),
    thinkModeLabel: think === 'prompt_only' ? '轻量工作' : think ? '深度工作' : '',
    thinkingEnabled:
      thinkingRaw === true || thinkingRaw === false ? thinkingRaw : null,
    visionEnabled: visionRaw === true || visionRaw === false ? visionRaw : null,
    knowledgeVaultIds: Array.isArray(cfg.knowledge_vault_ids)
      ? cfg.knowledge_vault_ids.map((x: unknown) => String(x || '').trim()).filter(Boolean)
      : [],
  }
}

async function fetchRole(api: any, code: string) {
  const c = String(code || '').trim()
  if (!c) return null
  try {
    const res = await api.proactiveGetRole(c, { silent: true, skipRetry: true })
    const role = res?.role || res
    if (!role || typeof role !== 'object') return null
    return mapRoleDetail(role, c)
  } catch (err: any) {
    // 404 / missing role: expected for orphan proactive: keys — not a hard failure.
    if (Number(err?.status) === 404) return null
    throw err
  }
}

export function runLoadEmployeeRoleDetailEffect(
  ctx: LoadEmployeeRoleDetailCtx,
): () => void {
  let cancelled = false
  const primary = String(ctx.employeeSessionAgentCode || '').trim()
  const fallback = String(ctx.fallbackAgentCode || '').trim()
  if (!primary && !fallback) {
    ctx.setEmployeeRoleDetail(null)
    return () => {
      cancelled = true
    }
  }
  void import('../../../lib/tauri-api.js')
    .then(async ({ api }) => {
      let detail = primary ? await fetchRole(api, primary) : null
      if (
        !detail &&
        fallback &&
        fallback.toLowerCase() !== primary.toLowerCase() &&
        fallback.toLowerCase() !== 'main'
      ) {
        detail = await fetchRole(api, fallback)
      }
      return detail
    })
    .then(async (detail: any) => {
      if (cancelled) return
      ctx.setEmployeeRoleDetail(detail || null)
      // 岗位偏好灌进当前员工会话，发图 / 思考门控与状态面板一致
      const sk = String(ctx.selectedSessionKey || '').trim()
      if (!sk || !detail) return
      try {
        const { wsClient } = await import('../../../lib/ws-client.js')
        const { api } = await import('../../../lib/tauri-api.js')
        const patch: Record<string, unknown> = {}
        if (detail.thinkingEnabled === true || detail.thinkingEnabled === false) {
          patch.thinking_enabled = detail.thinkingEnabled
          patch.thinking_type = 'manual'
          patch.reasoning_effort = detail.thinkingEnabled ? 'medium' : 'minimum'
        }
        if (detail.visionEnabled === true || detail.visionEnabled === false) {
          patch.vision_enabled = detail.visionEnabled
        }
        if (!Object.keys(patch).length) return
        wsClient.updateSessionContext(sk, patch)
        await api.chatUpdateContext(sk, patch).catch(() => {})
      } catch {
        /* ignore */
      }
    })
    .catch(() => {
      if (!cancelled) ctx.setEmployeeRoleDetail(null)
    })
  return () => {
    cancelled = true
  }
}
