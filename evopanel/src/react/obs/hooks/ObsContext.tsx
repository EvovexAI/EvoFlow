import { createContext, useContext, useMemo, type ReactNode } from 'react'
import {
  bundleAgentsToTopRows,
  bundleRecentToolErrors,
  bundleToHealth,
  bundleToMetrics,
  bundleToModelRanking,
  bundleToRecentRequests,
  bundleToRequestTrend,
  useLiveData,
  type AgentTopRow,
  type HealthSegment,
  type ModelRankingRow,
} from '../data/adapter'
import type { ObsDashboardKpis, ObsStatusFilter, ObsTimeRangeKey, ObsToolErrorRow } from '../lib/obs-types'
import { fmtCnyEstimate, fmtDeltaPct, fmtHitPct } from '../lib/obs-formatters'
import type { Metric, RequestRecord, TimePoint } from '../types'
import { obsFetchCacheInvalidate } from './obs-fetch-cache'
import { useObsDashboard } from './useObsDashboard'
import { buildTokenCostSummary, type TokenCostSummary } from '../components/TokenCostPanel'

export type ObsContextValue = {
  loading: boolean
  error: string | null
  enabled: boolean
  live: boolean
  timeRange: ObsTimeRangeKey
  setTimeRange: (key: ObsTimeRangeKey) => void
  agentFilter: string
  setAgentFilter: (value: string) => void
  modelFilter: string
  setModelFilter: (value: string) => void
  providerFilter: string
  setProviderFilter: (value: string) => void
  statusFilter: ObsStatusFilter
  setStatusFilter: (value: ObsStatusFilter) => void
  agents: ReturnType<typeof useObsDashboard>['agents']
  reload: () => void
  metrics: Metric[]
  requestTrend: TimePoint[]
  recentRequests: RequestRecord[]
  healthyPct: number
  healthSegments: HealthSegment[]
  modelRankingRows: ModelRankingRow[]
  tokenCostUsd: string
  tokenCostSummary: TokenCostSummary
  kpis: ObsDashboardKpis | null
  agentTopRows: AgentTopRow[]
  recentToolErrors: ObsToolErrorRow[]
  toolCalls: number
  toolErrors: number
  cacheReadTokens: number
  cacheHitRatePct: string
  estimatedCacheSavingsCny: string
  cachePricingNote: string | null
}

const ObsContext = createContext<ObsContextValue | null>(null)

export function ObsProvider({ children }: { children: ReactNode }) {
  const obs = useObsDashboard()
  const enabled = obs.data?.enabled === true
  const live = useLiveData(obs.data)

  // @ts-ignore
  const value = useMemo<ObsContextValue>(() => {
    const tokenCostUsd =
      obs.data?.summary?.token_cost_usd != null
        ? `$${obs.data.summary.token_cost_usd.toFixed(2)}`
        : '—'
    const health = bundleToHealth(obs.data, enabled)
    const kpis = obs.data?.kpis ?? null
    const summary = obs.data?.summary
    const tokensDeltaPct = kpis?.deltas?.total_tokens_pct
    const tokenCostSummary = buildTokenCostSummary({
      totalTokens: Number(kpis?.total_tokens ?? 0),
      totalTokensDelta:
        tokensDeltaPct != null && Number.isFinite(tokensDeltaPct)
          ? `${fmtDeltaPct(tokensDeltaPct)} vs 上期`
          : '—',
      cacheReadTokens: Number(summary?.cache_read_tokens ?? 0),
      cacheHitRatePct: summary?.cache_hit_rate_pct,
      estimatedFullPriceCny: summary?.estimated_full_price_cny,
      estimatedTotalCostCny: summary?.estimated_total_cost_cny,
      estimatedSavingsCny: summary?.estimated_savings_cny,
      pricingNote: summary?.pricing_note,
    })

    return {
      loading: obs.loading,
      error: obs.error,
      enabled,
      live,
      timeRange: obs.timeRange,
      setTimeRange: obs.setTimeRange,
      agentFilter: obs.agentFilter,
      setAgentFilter: obs.setAgentFilter,
      modelFilter: obs.modelFilter,
      setModelFilter: obs.setModelFilter,
      providerFilter: obs.providerFilter,
      setProviderFilter: obs.setProviderFilter,
      statusFilter: obs.statusFilter,
      setStatusFilter: obs.setStatusFilter,
      agents: obs.agents,
      reload: () => {
        obsFetchCacheInvalidate()
        void obs.reload(true)
      },
      metrics: bundleToMetrics(obs.data, obs.timeRange, enabled),
      requestTrend: bundleToRequestTrend(obs.data, enabled),
      recentRequests: bundleToRecentRequests(obs.data, enabled),
      healthyPct: health.healthyPct,
      healthSegments: health.segments,
      modelRankingRows: bundleToModelRanking(obs.data, enabled),
      tokenCostUsd,
      tokenCostSummary,
      kpis,
      agentTopRows: bundleAgentsToTopRows(obs.data, enabled),
      recentToolErrors: bundleRecentToolErrors(obs.data, enabled),
      toolCalls: Number(obs.data?.summary?.tool_calls ?? obs.data?.kpis?.tool_calls ?? 0),
      toolErrors: Number(obs.data?.summary?.tool_errors ?? obs.data?.kpis?.tool_errors ?? 0),
      cacheReadTokens: Number(obs.data?.summary?.cache_read_tokens ?? 0),
      cacheHitRatePct: fmtHitPct(obs.data?.summary?.cache_hit_rate_pct ?? null),
      estimatedCacheSavingsCny: fmtCnyEstimate(obs.data?.summary?.estimated_savings_cny ?? null),
      cachePricingNote: obs.data?.summary?.pricing_note ?? null,
    }
  }, [enabled, live, obs])

  return <ObsContext.Provider value={value}>{children}</ObsContext.Provider>
}

export function useObsContext(): ObsContextValue {
  const ctx = useContext(ObsContext)
  if (!ctx) throw new Error('useObsContext must be used within ObsProvider')
  return ctx
}

export function useObsQuery() {
  const obs = useObsContext()
  return {
    timeRange: obs.timeRange,
    agentFilter: obs.agentFilter,
    modelFilter: obs.modelFilter,
    providerFilter: obs.providerFilter,
    statusFilter: obs.statusFilter,
  }
}