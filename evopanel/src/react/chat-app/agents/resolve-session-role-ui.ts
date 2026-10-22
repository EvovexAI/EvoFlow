// @ts-nocheck — mechanical P149 extract.
/**
 * Resolve current role code / assistant label / role label / agent default model for UI.
 * Extracted from ChatApp.tsx (P149).
 */
export type ResolveSessionRoleUiCtx = Record<string, any>

export function resolveSelectedSessionAgentId(ctx: ResolveSessionRoleUiCtx): string {
  const sk = String(ctx.selectedSessionKey || '').trim()
  if (!sk) return ''
  const row = ctx.sessions.find((s) => String(s?.sessionKey || '').trim() === sk)
  const fromRow = String(row?.agentId || '').trim().toLowerCase()
  if (fromRow) return fromRow
  const ctxAid = String(
    (row?.context as { agent_id?: string } | undefined)?.agent_id || '',
  )
    .trim()
    .toLowerCase()
  return ctxAid
}

export function resolveCurrentRoleCodeForUi(ctx: ResolveSessionRoleUiCtx): string {
  if (!ctx.selectedSessionKey) return 'main'
  // 员工会话：sessionKey 内 agent_code 优先于列表里可能过期的 agentId（常误为 main）。
  if (ctx.isProactiveSessionKey(ctx.selectedSessionKey)) {
    const code = String(ctx.parseProactiveSessionKey(ctx.selectedSessionKey).agentCode || '')
      .trim()
      .toLowerCase()
    if (code) return code
  }
  // DB/list agentId wins over stale local agent_name / sessionKey embedding.
  if (ctx.selectedSessionAgentId) return ctx.selectedSessionAgentId
  return ctx.resolveSessionAgentCodeForUi(ctx.selectedSessionKey)
}

export function resolveAssistantReplyLabel(ctx: ResolveSessionRoleUiCtx): string {
  const code = ctx.currentRoleCodeForUi
  const row = ctx.agents.find((a) => String(a?.agent_code || '').trim().toLowerCase() === code)
  const name = String(row?.agent_name || '').trim()
  if (name) return name
  if (code === 'main') return 'EvoFlow'
  if (code === 'claude-code') return '代码助手'
  return code || 'EvoFlow · Agent'
}

export function resolveCurrentRoleLabel(ctx: ResolveSessionRoleUiCtx): string {
  const code = ctx.currentRoleCodeForUi
  const row = ctx.agents.find((a) => String(a?.agent_code || '').trim().toLowerCase() === code)
  const dn = row && String(row.agent_name || '').trim()
  const roleName =
    dn || (code === 'main' ? 'EvoFlow' : code === 'claude-code' ? '代码助手' : code)
  // Skip meta source tags like「自定义 / 核心 / SkillHub」— they clutter the rail signature.
  const META_PREFIX = new Set(['自定义', '核心', 'SkillHub', 'skillhub'])
  const tagLabels = ctx.normalizeAgentTags(row?.tags).filter((t) => !META_PREFIX.has(t))
  if (tagLabels.length > 0 && code !== 'main') {
    return `${tagLabels[0]} · ${roleName}`
  }
  return roleName
}

export function resolveAgentDefaultModelName(ctx: ResolveSessionRoleUiCtx): string {
  const code = String(ctx.currentRoleCodeForUi || '').trim().toLowerCase()
  if (!code) return ''
  const row = ctx.agents.find((a) => String(a?.agent_code || '').trim().toLowerCase() === code)
  return String(row?.model || '').trim()
}
