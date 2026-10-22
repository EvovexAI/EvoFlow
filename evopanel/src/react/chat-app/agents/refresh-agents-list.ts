/**
 * Reload agent picker rows from the backend and refresh display cache.
 * Extracted from ChatApp.tsx (P70).
 */
import type { Dispatch, SetStateAction } from 'react'
import { setAgentsDisplayCache } from '../../../lib/agents-display-cache.js'
import type { AgentPickerRow } from '../../lib/agent-tags.js'
import { mapAgentPickerRows } from './map-agent-picker-rows.js'

export type RefreshAgentsListCtx = {
  getApi: () => Promise<{
    listAgents: () => Promise<AgentPickerRow[] | { agents?: AgentPickerRow[] }>
  }>
  setAgents: Dispatch<SetStateAction<AgentPickerRow[]>>
  setRoleUiNonce: Dispatch<SetStateAction<number>>
}

export async function refreshAgentsList(ctx: RefreshAgentsListCtx): Promise<void> {
  try {
    const api = await ctx.getApi()
    const agentResult = await api.listAgents()
    const list = Array.isArray(agentResult) ? agentResult : agentResult?.agents || []
    const mapped = mapAgentPickerRows(list)
    ctx.setAgents(mapped)
    setAgentsDisplayCache(list)
    ctx.setRoleUiNonce((n) => n + 1)
  } catch {
    /* keep previous agents */
  }
}
