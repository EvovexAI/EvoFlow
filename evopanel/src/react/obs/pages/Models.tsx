import { useMemo, useState } from 'react'
import { apiModelsToRecords, apiProvidersToRecords } from '../data/adapter'
import {
  ObsBanner,
  ObsEmpty,
  ObsGroup,
  ObsListRow,
  ObsPage,
  ObsSection,
  ObsSegmentTabs,
  ObsStatItem,
  ObsStatStrip,
  ObsTablePanel,
} from '../components/ObsLayout'
import { BarRanking, SmallBars } from '../components/Charts'
import { StatusBadge } from '../components/StatusBadge'
import { TopFilterBar } from '../components/TopFilterBar'
import { fetchObsModelsSummary, fetchObsProvidersSummary } from '../lib/obs-api'
import { agentKindLabel, fmtCnyEstimate, fmtHitPct, fmtTok } from '../lib/obs-formatters'
import { useObsCachedFetch } from '../hooks/useObsCachedFetch'
import type { ModelRecord, ProviderRecord } from '../types'

type RankKey = 'tokens' | 'requests' | 'cache'

type ModelsPageData = { models: ModelRecord[]; providers: ProviderRecord[] }

export function Models() {
  const [rankBy, setRankBy] = useState<RankKey>('tokens')

  const { data, loading, error } = useObsCachedFetch<ModelsPageData>({
    scope: 'models-summary',
    fetcher: async (query) => {
      const [modelsRes, providersRes] = await Promise.all([
        fetchObsModelsSummary(query),
        fetchObsProvidersSummary(query),
      ])
      if (modelsRes?.enabled === false || providersRes?.enabled === false) {
        throw new Error('观测数据未启用')
      }
      const modelItems = (modelsRes as { items?: unknown[] })?.items
      const providerItems = (providersRes as { items?: unknown[] })?.items
      return {
        models: Array.isArray(modelItems) ? apiModelsToRecords(modelItems) : [],
        providers: Array.isArray(providerItems) ? apiProvidersToRecords(providerItems) : [],
      }
    },
  })

  const models = data?.models ?? []
  const providers = data?.providers ?? []

  const totals = useMemo(() => {
    const cacheRead = models.reduce((sum, row) => sum + row.cacheReadNum, 0)
    const withHit = models.filter((row) => row.cacheReadNum > 0)
    const weightedHit =
      withHit.length > 0
        ? withHit.reduce((sum, row) => {
            const pct = parseFloat(row.cacheHitRate)
            return sum + (Number.isFinite(pct) ? pct : 0)
          }, 0) / withHit.length
        : null
    const savings = models.reduce((sum, row) => {
      const raw = row.estimatedSavingsCny.replace(/[^0-9.]/g, '')
      const n = parseFloat(raw)
      return sum + (Number.isFinite(n) ? n : 0)
    }, 0)
    return {
      modelCount: models.length,
      providerCount: providers.length,
      totalRequests: models.reduce((sum, row) => sum + row.requests, 0),
      cacheRead,
      avgHitRate: weightedHit,
      savings,
    }
  }, [models, providers.length])

  const rankedModels = useMemo(() => {
    const sorted = [...models].sort((a, b) => {
      if (rankBy === 'requests') return b.requests - a.requests
      if (rankBy === 'cache') return b.cacheReadNum - a.cacheReadNum
      return b.tokensNum - a.tokensNum
    })
    return sorted.slice(0, 8)
  }, [models, rankBy])

  const rankingRows = rankedModels.map((model) => ({
    label: model.model,
    provider: model.provider,
    value: rankBy === 'requests' ? model.requests : rankBy === 'cache' ? model.cacheReadNum : model.tokensNum,
    requests: model.requests.toLocaleString(),
    tokens: model.tokens,
    cacheRead: model.cacheReadTokens,
    cacheHitRate: model.cacheHitRate,
    cost: model.estimatedSavingsCny !== '—' ? model.estimatedSavingsCny : '—',
  }))

  const rankLabel = rankBy === 'requests' ? '调用数' : rankBy === 'cache' ? '缓存命中' : 'Token 量'

  return (
    <>
      <TopFilterBar title="模型与厂商" subtitle="调用量、延迟、缓存命中与预估省钱" />
      {loading && <ObsBanner>加载模型数据…</ObsBanner>}
      {error && !loading && <ObsBanner tone="error">{error}</ObsBanner>}

      <ObsPage>
        <ObsStatStrip>
          <ObsStatItem label="模型数" value={totals.modelCount} hint="当前窗口" />
          <ObsStatItem label="厂商数" value={totals.providerCount} hint="已识别" />
          <ObsStatItem label="总调用" value={totals.totalRequests.toLocaleString()} hint="模型请求" variant="accent" />
          <ObsStatItem label="缓存命中" value={fmtTok(totals.cacheRead)} hint={fmtHitPct(totals.avgHitRate)} variant="accent" />
          <ObsStatItem
            label="预估省钱"
            value={fmtCnyEstimate(totals.savings > 0 ? totals.savings : null)}
            hint="百炼 / 火山官网价"
            variant="savings"
          />
        </ObsStatStrip>

        <ObsGroup title="厂商概览" className="span-3">
          {providers.length === 0 && !loading ? (
            <ObsEmpty>当前时间范围内暂无厂商数据</ObsEmpty>
          ) : (
            providers.map((provider) => (
              <ObsListRow
                key={provider.name}
                title={provider.name}
                badge={<StatusBadge status={provider.status} />}
                metrics={[
                  { label: '调用数', value: provider.requests.toLocaleString() },
                  { label: '成功率', value: `${provider.successRate}%`, tone: 'highlight' },
                  { label: '平均延迟', value: provider.avgLatency },
                  { label: 'Token', value: provider.tokens },
                  { label: '缓存命中', value: provider.cacheReadTokens, tone: 'highlight' },
                  { label: '命中率', value: provider.cacheHitRate, tone: 'highlight' },
                  { label: '预估省钱', value: provider.estimatedSavingsCny, tone: 'savings' },
                  { label: '错误', value: provider.errors },
                ]}
              />
            ))
          )}
        </ObsGroup>

        <ObsSection
          title="模型消耗排名"
          subtitle={`按${rankLabel} · Top ${rankingRows.length || 0}`}
          className="span-2"
          actions={
            <ObsSegmentTabs
              value={rankBy}
              onChange={setRankBy}
              options={[
                { value: 'tokens', label: 'Token' },
                { value: 'requests', label: '调用数' },
                { value: 'cache', label: '缓存命中' },
              ]}
            />
          }
          isEmpty={rankingRows.length === 0}
          empty={<ObsEmpty>暂无模型调用</ObsEmpty>}
        >
          <BarRanking rows={rankingRows} />
        </ObsSection>

        <ObsSection title="厂商请求分布" isEmpty={providers.length === 0} empty={<ObsEmpty>暂无数据</ObsEmpty>}>
          <SmallBars
            barColor="linear-gradient(90deg, #0084ff, #32ade6)"
            rows={providers.map((provider) => ({
              label: provider.name,
              value: provider.requests,
              sub: provider.cacheReadTokens !== '—' ? `命中 ${provider.cacheReadTokens}` : undefined,
            }))}
          />
        </ObsSection>

        <ObsTablePanel
          title="模型明细"
          className="span-3"
          rows={models}
          rowKey={(row) => row.model}
          emptyText="暂无模型调用记录"
          columns={[
            { key: 'model', label: '模型' },
            { key: 'provider', label: '厂商' },
            { key: 'requests', label: '调用数', render: (row) => row.requests.toLocaleString() },
            {
              key: 'successRate',
              label: '成功率',
              render: (row) => (
                <span className={row.successRate >= 95 ? 'text-success' : row.successRate >= 85 ? 'text-warning' : 'text-danger'}>
                  {row.successRate}%
                </span>
              ),
            },
            { key: 'avgLatency', label: '平均延迟' },
            { key: 'p95Latency', label: 'P95' },
            { key: 'promptTokens', label: '输入' },
            { key: 'completionTokens', label: '输出' },
            { key: 'tokens', label: '总 Token' },
            { key: 'cacheReadTokens', label: '缓存命中' },
            { key: 'cacheHitRate', label: '命中率' },
            { key: 'estimatedSavingsCny', label: '预估省钱' },
            {
              key: 'errorRate',
              label: '错误率',
              render: (row) => <span className={row.errorRate > 5 ? 'text-danger' : ''}>{row.errorRate}%</span>,
            },
            {
              key: 'mainAgents',
              label: '主要 Agent',
              render: (row) => row.mainAgents.map((name) => agentKindLabel(name)).join('、') || '—',
            },
          ]}
        />
      </ObsPage>
    </>
  )
}
