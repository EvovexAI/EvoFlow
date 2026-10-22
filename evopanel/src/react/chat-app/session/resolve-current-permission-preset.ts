/**
 * Resolve effective permission preset for the selected session (row + wsClient).
 * Extracted from ChatApp.tsx (P57).
 */
import { resolvePermissionPreset } from '../../../lib/permission-tier.js'
import type { ChatSessionRow } from '../../chat-types.js'

export function resolveCurrentPermissionPresetId(args: {
  selectedSessionKey: string
  sessions: ChatSessionRow[]
  getSessionContext: (sk: string) => Record<string, unknown> | null | undefined
}): string {
  const row = args.selectedSessionKey
    ? args.sessions.find((s) => String(s.sessionKey || '') === args.selectedSessionKey) ?? null
    : null
  const base: Record<string, unknown> =
    row?.context && typeof row.context === 'object' ? { ...row.context } : {}
  try {
    const wsCtx = args.getSessionContext(args.selectedSessionKey) as
      | Record<string, unknown>
      | null
    for (const k of [
      'effective_permission_preset',
      'permission_preset',
      'effective_tool_approval_policy',
      'tool_approval_policy',
    ]) {
      const v = wsCtx ? wsCtx[k] : undefined
      if (v != null && String(v).trim()) base[k] = v
    }
  } catch {
    /* ignore */
  }
  return resolvePermissionPreset(base)
}
