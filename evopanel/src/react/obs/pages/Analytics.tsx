import { useMemo } from 'react'
import {
  apiAgentsToRecords,
  apiModelsToRecords,
  trendsToTimePoints,
} from '../data/adapter'
import {
  ObsBanner,
  ObsEmpty,
  ObsPage,
  ObsSection,
  ObsStatItem,
  ObsStatStrip,
} from '../components/ObsLayout'
import { BarRanking, SmallBars, TokenStackChart } from '../components/Charts'
import { TopFilterBar } from '../components/TopFilterBar'
import { fetchObsAnalyticsSummary } from '../lib/obs-api'
import { fmtTok } from '../lib/obs-formatters'
import { useObsCachedFetch } from '../hooks/useObsCachedFetch'
import type { TimePoint } from '../types'

type AnalyticsData = {
  trend: TimePoint[]
  modelRows: Array<{ label: string; provider: string; value: number; requests: string; tokens: string; cost: string }>
  providerBars: Array<{ label: string; value: number; sub: string }>
  agentBars: Array<{ label: string; value: number; sub: string }>
  stats: { totalTokens: number; modelCalls: number }
}

export function Analytics() {
  const { data, loading, error } = useObsCachedFetch<AnalyticsData>({
    scope: 'analytics-summary',
    fetcher: async (query) => {
      const res = await fetchObsAnalyticsSummary(query)
      const payload = res as Record<string, unknown>
      if (payload.enabled === false) throw new Error('观测数据未启用')

      const models = apiModelsToRecords((payload.models as unknown[]) || [])
      const providers = (payload.providers as Array<Record<string, unknown>>) || []
      const agents = apiAgentsToRecords((payload.agents as unknown[]) || [])

      return {
        stats: {
          totalTokens: Number(payload.total_tokens || 0),
          modelCalls: Number(payload.model_invocations || 0),
        },
        trend: trendsToTimePoints((payload.trends as Record<string, unknown>) ?? null),
        modelRows: models.map((model) => ({
          label: model.model,
          provider: model.provider,
          value: model.requests,
          requests: model.requests.toLocaleString(),
          tokens: model.tokens,
          cost: model.cost > 0 ? `$${model.cost.toFixed(2)}` : '—',
        })),
        providerBars: providers.map((p) => ({
          label: String(p.name || '—'),
          value: Number(p.requests || 0),
          sub: '—',
        })),
        agentBars: agents.map((agent) => ({
          label: agent.name,
          value: agent.requests,
          sub: agent.mainModel,
        })),
      }
    },
  })

  const trend = data?.trend ?? []
  const modelRows = data?.modelRows ?? []
  const providerBars = data?.providerBars ?? []
  const agentBars = data?.agentBars ?? []
  const stats = data?.stats ?? { totalTokens: 0, modelCalls: 0 }

  const avgTokensPerReq = useMemo(
    () => (stats.modelCalls > 0 ? Math.round(stats.totalTokens / stats.modelCalls) : 0),
    [stats.modelCalls, stats.totalTokens],
  )

  return (
    <>
      <TopFilterBar title="成本与趋势" subtitle="Token 消耗、请求趋势与排名" />
      {loading && !data && <ObsBanner>加载分析数据…</ObsBanner>}
      {error && !loading && <ObsBanner tone="error">{error}</ObsBanner>}

      <ObsPage>
        <ObsStatStrip>
          <ObsStatItem label="总成本" value="—" hint="待接入定价" />
          <ObsStatItem label="总 Token" value={fmtTok(stats.totalTokens)} hint="窗口内" variant="accent" />
          <ObsStatItem label="模型调用" value={stats.modelCalls.toLocaleString()} hint="窗口内" />
          <ObsStatItem label="平均每请求 Token" value={avgTokensPerReq} hint="估算" />
        </ObsStatStrip>

        <ObsSection title="请求趋势" className="span-2" isEmpty={trend.length === 0} empty={<ObsEmpty>暂无趋势数据</ObsEmpty>}>
          <TokenStackChart data={trend} />
        </ObsSection>

        <ObsSection title="厂商请求排名" isEmpty={providerBars.length === 0} empty={<ObsEmpty>暂无数据</ObsEmpty>}>
          <SmallBars rows={providerBars} />
        </ObsSection>

        <ObsSection title="模型请求排名" className="span-2" isEmpty={modelRows.length === 0} empty={<ObsEmpty>暂无数据</ObsEmpty>}>
          <BarRanking rows={modelRows} />
        </ObsSection>

        <ObsSection title="Agent 请求排名" isEmpty={agentBars.length === 0} empty="暂无数据">
          <SmallBars rows={agentBars} />
        </ObsSection>
      </ObsPage>
    </>
  )
}
