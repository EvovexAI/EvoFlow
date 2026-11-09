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
import { agentKindLabel, fmtTok } from '../lib/obs-formatters'
import { useObsCachedFetch } from '../hooks/useObsCachedFetch'
import type { TimePoint } from '../types'

type KindTokenRow = {
  label: string
  value: number
  sub: string
}

type OverheadRow = {
  label: string
  value: number
  sub: string
}

type AnalyticsData = {
  trend: TimePoint[]
  modelRows: Array<{ label: string; provider: string; value: number; requests: string; tokens: string; cost: string }>
  providerBars: Array<{ label: string; value: number; sub: string }>
  kindTokenBars: KindTokenRow[]
  overheadBars: OverheadRow[]
  agentBars: Array<{ label: string; value: number; sub: string }>
  stats: { totalTokens: number; modelCalls: number }
}

function pctOf(part: number, total: number): string {
  if (!total || total <= 0) return '—'
  return `${((part / total) * 100).toFixed(1)}%`
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
      const totalTokens = Number(payload.total_tokens || 0)
      const kindRows = Array.isArray(payload.token_by_kind)
        ? (payload.token_by_kind as Array<Record<string, unknown>>)
        : []
      const overheadRaw =
        payload.prompt_overhead_totals && typeof payload.prompt_overhead_totals === 'object'
          ? (payload.prompt_overhead_totals as Record<string, unknown>)
          : {}
      const overheadSamples = Number(overheadRaw.samples || 0)

      const kindTokenBars: KindTokenRow[] = kindRows
        .map((row) => {
          const tokens = Number(row.total_tokens || 0)
          const calls = Number(row.invocations || 0)
          const kind = String(row.invocation_kind || 'main')
          return {
            label: agentKindLabel(kind),
            value: tokens,
            sub: `${calls.toLocaleString()} 次 · ${pctOf(tokens, totalTokens)}`,
          }
        })
        .filter((row) => row.value > 0)
        .sort((a, b) => b.value - a.value)

      const overheadDefs: Array<{ key: string; label: string }> = [
        { key: 'system_tokens', label: '系统提示' },
        { key: 'tools_tokens', label: '工具 Schema' },
        { key: 'system_skills_tokens', label: 'Skills 注入' },
        { key: 'system_assets_tokens', label: 'Memory Assets' },
        { key: 'system_memory_tokens', label: 'Memory 块' },
      ]
      const overheadBars: OverheadRow[] =
        overheadSamples > 0
          ? overheadDefs
              .map((d) => {
                const value = Number(overheadRaw[d.key] || 0)
                return {
                  label: d.label,
                  value,
                  sub: `累计估算 · ${overheadSamples} 次采样`,
                }
              })
              .filter((row) => row.value > 0)
              .sort((a, b) => b.value - a.value)
          : []

      return {
        stats: {
          totalTokens,
          modelCalls: Number(payload.model_invocations || 0),
        },
        trend: trendsToTimePoints((payload.trends as Record<string, unknown>) ?? null),
        modelRows: models.map((model) => ({
          label: model.model,
          provider: model.provider,
          value: model.tokensNum,
          requests: model.requests.toLocaleString(),
          tokens: model.tokens,
          cost: model.cost > 0 ? `$${model.cost.toFixed(2)}` : '—',
        })),
        providerBars: providers.map((p) => ({
          label: String(p.name || '—'),
          value: Number(p.requests || 0),
          sub: '—',
        })),
        kindTokenBars,
        overheadBars,
        agentBars: agents.map((agent) => {
          // tokens is already formatted; re-parse for bar length from raw agents payload order
          const rawTok = Number(
            String(agent.tokens || '0').replace(/,/g, ''),
          )
          return {
            label: agentKindLabel(agent.name),
            value: Number.isFinite(rawTok) ? rawTok : 0,
            sub: `${agent.requests.toLocaleString()} 次 · ${agent.mainModel}`,
          }
        }),
      }
    },
  })

  const trend = data?.trend ?? []
  const modelRows = data?.modelRows ?? []
  const providerBars = data?.providerBars ?? []
  const kindTokenBars = data?.kindTokenBars ?? []
  const overheadBars = data?.overheadBars ?? []
  const agentBars = data?.agentBars ?? []
  const stats = data?.stats ?? { totalTokens: 0, modelCalls: 0 }

  const avgTokensPerReq = useMemo(
    () => (stats.modelCalls > 0 ? Math.round(stats.totalTokens / stats.modelCalls) : 0),
    [stats.modelCalls, stats.totalTokens],
  )

  return (
    <>
      <TopFilterBar title="成本与趋势" subtitle="按调用类型看 Token 消耗，便于定位可优化模块" />
      {loading && !data && <ObsBanner>加载分析数据…</ObsBanner>}
      {error && !loading && <ObsBanner tone="error">{error}</ObsBanner>}

      <ObsPage>
        <ObsStatStrip>
          <ObsStatItem label="总成本" value="—" hint="待接入定价" />
          <ObsStatItem label="总 Token" value={fmtTok(stats.totalTokens)} hint="窗口内" variant="accent" />
          <ObsStatItem label="模型调用" value={stats.modelCalls.toLocaleString()} hint="窗口内" />
          <ObsStatItem label="平均每请求 Token" value={avgTokensPerReq} hint="估算" />
        </ObsStatStrip>

        <ObsSection
          title="调用类型 Token 消耗"
          className="span-2"
          isEmpty={kindTokenBars.length === 0}
          empty={<ObsEmpty>暂无分类型用量（需启用观测并产生模型调用）</ObsEmpty>}
        >
          <SmallBars rows={kindTokenBars} />
        </ObsSection>

        <ObsSection
          title="主对话 Prompt 分节（估算累计）"
          isEmpty={overheadBars.length === 0}
          empty={<ObsEmpty>新调用会写入 system / skills / memory 等估算；旧数据暂无</ObsEmpty>}
        >
          <SmallBars rows={overheadBars} barColor="rgba(34, 211, 238, .85)" />
        </ObsSection>

        <ObsSection title="请求趋势" className="span-2" isEmpty={trend.length === 0} empty={<ObsEmpty>暂无趋势数据</ObsEmpty>}>
          <TokenStackChart data={trend} />
        </ObsSection>

        <ObsSection title="厂商请求排名" isEmpty={providerBars.length === 0} empty={<ObsEmpty>暂无数据</ObsEmpty>}>
          <SmallBars rows={providerBars} />
        </ObsSection>

        <ObsSection title="模型 Token 排名" className="span-2" isEmpty={modelRows.length === 0} empty={<ObsEmpty>暂无数据</ObsEmpty>}>
          <BarRanking rows={modelRows} valueKey="tokens" />
        </ObsSection>

        <ObsSection title="调用类型明细（按 Token）" isEmpty={agentBars.length === 0} empty="暂无数据">
          <SmallBars rows={agentBars} />
        </ObsSection>
      </ObsPage>
    </>
  )
}
