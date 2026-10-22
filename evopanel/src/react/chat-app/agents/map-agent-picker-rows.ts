/**
 * Normalize listAgents payload rows for the composer agent picker.
 * Extracted from ChatApp.tsx (P29).
 */
import type { AgentPickerRow } from '../../lib/agent-tags.js'

export function mapAgentPickerRows(list: AgentPickerRow[]): AgentPickerRow[] {
  return list.map((a: AgentPickerRow) => ({
    ...a,
    agent_code: String(a?.agent_code || '').trim(),
    skills: Array.isArray(a?.skills)
      ? a.skills.map((s) => String(s || '').trim()).filter(Boolean)
      : [],
    tools: Array.isArray(a?.tools)
      ? a.tools.map((t) => String(t || '').trim()).filter(Boolean)
      : null,
    mcp_servers: Array.isArray(a?.mcp_servers)
      ? a.mcp_servers.map((m) => String(m || '').trim()).filter(Boolean)
      : null,
    knowledge_vault_ids: Array.isArray(a?.knowledge_vault_ids)
      ? a.knowledge_vault_ids.map((k) => String(k || '').trim()).filter(Boolean)
      : [],
  }))
}
