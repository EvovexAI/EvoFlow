import { api } from '../../../lib/tauri-api.js'
import type { ObsDashboardBundle, ObsModelDetail, ObsStatusFilter, ObsTimeRangeKey } from './obs-types'
import { OBS_TIME_RANGE_OPTIONS } from './obs-types'

const STORAGE_KEY = 'evopanel_obs_time_range'

export type ObsQuery = {
  timeRange?: ObsTimeRangeKey
  agentFilter?: string
  modelFilter?: string
  providerFilter?: string
  toolNameFilter?: string
  statusFilter?: ObsStatusFilter
  search?: string
  threadId?: string
  page?: number
  pageSize?: number
}

export function getObsTimeRange(): ObsTimeRangeKey {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && OBS_TIME_RANGE_OPTIONS.some((o) => o.key === saved)) {
      return saved as ObsTimeRangeKey
    }
  } catch {
    /* ignore */
  }
  return '7d'
}

export function setObsTimeRange(key: ObsTimeRangeKey) {
  try {
    localStorage.setItem(STORAGE_KEY, key)
  } catch {
    /* ignore */
  }
}

export function sinceHoursForRange(key: ObsTimeRangeKey): string | undefined {
  const opt = OBS_TIME_RANGE_OPTIONS.find((o) => o.key === key)
  if (!opt?.sinceHours) return undefined
  return String(opt.sinceHours)
}

function buildQuery(q: ObsQuery = {}): Record<string, string> {
  const out: Record<string, string> = {}
  const timeRange = q.timeRange ?? getObsTimeRange()
  const since = sinceHoursForRange(timeRange)
  if (since) out.since_hours = since
  const agent = q.agentFilter ?? 'all'
  if (agent && agent !== 'all') out.agent_filter = agent
  if (q.modelFilter && q.modelFilter !== 'all') out.model = q.modelFilter
  if (q.providerFilter && q.providerFilter !== 'all') out.provider = q.providerFilter
  if (q.toolNameFilter?.trim()) out.tool_name = q.toolNameFilter.trim()
  if (q.statusFilter && q.statusFilter !== 'all') out.status = q.statusFilter
  if (q.search?.trim()) out.q = q.search.trim()
  if (q.threadId?.trim()) out.thread_id = q.threadId.trim()
  if (q.page) out.page = String(q.page)
  if (q.pageSize) out.page_size = String(q.pageSize)
  return out
}

export async function fetchObsDashboard(q: ObsQuery = {}): Promise<ObsDashboardBundle> {
  const query = buildQuery(q)
  if (!query.agent_filter) query.agent_filter = q.agentFilter || 'all'
  return (await api.observabilityDashboard(query, { timeoutMs: 30000 })) as ObsDashboardBundle
}

export async function fetchObsModels(q: ObsQuery = {}) {
  const query = buildQuery(q)
  if (q.agentFilter && q.agentFilter !== 'all') query.invocation_kind = q.agentFilter
  return api.observabilityModels(query)
}

export async function fetchObsModelDetail(id: string): Promise<ObsModelDetail> {
  return (await api.observabilityModelDetail(id)) as ObsModelDetail
}

export async function fetchObsAgentsSummary(q: ObsQuery = {}) {
  return api.observabilityAgentsSummary(buildQuery(q))
}

export async function fetchObsModelsSummary(q: ObsQuery = {}) {
  return api.observabilityModelsSummary(buildQuery(q), { silent: true })
}

export async function fetchObsProvidersSummary(q: ObsQuery = {}) {
  return api.observabilityProvidersSummary(buildQuery(q))
}

export async function fetchObsToolsSummary(q: ObsQuery = {}) {
  return api.observabilityToolsSummary(buildQuery(q))
}

export async function fetchObsGatewayRoutesSummary(q: ObsQuery = {}) {
  return api.observabilityGatewayRoutesSummary(buildQuery(q))
}

export async function fetchObsThreadsSummary(q: ObsQuery = {}) {
  return api.observabilityThreadsSummary(buildQuery(q))
}

export async function fetchObsThreadTimeline(threadId: string, limit = 200) {
  return api.observabilityThreadTimeline(threadId, limit)
}

export async function fetchObsAnalyticsSummary(q: ObsQuery = {}) {
  return api.observabilityAnalyticsSummary(buildQuery(q))
}

export async function fetchObsGatewayRequestSummary(q: ObsQuery = {}) {
  return api.observabilityGatewayRequestSummary(buildQuery(q))
}

export async function fetchObsInsights(q: ObsQuery = {}) {
  return api.observabilityInsights(buildQuery(q))
}

export async function fetchObsErrorsSummary(q: ObsQuery = {}) {
  return api.observabilityErrorsSummary(buildQuery(q))
}

export async function fetchObsRuntimeStatus() {
  return api.observabilityRuntimeStatus({ silent: true, timeoutMs: 15000 })
}

export async function fetchObsStatus() {
  return api.observabilityStatus({ timeoutMs: 8000 })
}

export async function fetchObsMcpStatus() {
  return api.observabilityMcpStatus()
}

export async function fetchAgents(): Promise<{ id?: string; name?: string; display_name?: string }[]> {
  const res = (await api.listAgentsDetailed()) as { agents?: unknown[]; items?: unknown[] }
  const list = (res?.agents ?? res?.items ?? []) as { id?: string; name?: string; display_name?: string }[]
  return Array.isArray(list) ? list : []
}

export async function checkObsEnabled(): Promise<boolean> {
  try {
    const st = (await api.observabilityStatus()) as { enabled?: boolean }
    // Strict: missing/failed status must not look "enabled" (debug tab / 小V 调试).
    return st?.enabled === true
  } catch {
    return false
  }
}
