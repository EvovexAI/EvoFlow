import { useMemo } from 'react'
import { apiToolsToRecords } from '../data/adapter'
import {
  ObsBanner,
  ObsEmpty,
  ObsPage,
  ObsSection,
  ObsStatItem,
  ObsStatStrip,
  ObsTablePanel,
} from '../components/ObsLayout'
import { SmallBars } from '../components/Charts'
import { TopFilterBar } from '../components/TopFilterBar'
import { fetchObsToolsSummary } from '../lib/obs-api'
import { useObsCachedFetch } from '../hooks/useObsCachedFetch'
import type { ToolRecord } from '../types'

export function Tools({ onNavigate }: { onNavigate?: (key: string) => void }) {
  const { data: tools, loading, error } = useObsCachedFetch<ToolRecord[]>({
    scope: 'tools-summary',
    fetcher: async (query) => {
      const res = await fetchObsToolsSummary(query)
      if (res?.enabled === false) throw new Error('观测数据未启用')
      const items = (res as { items?: unknown[] })?.items
      return Array.isArray(items) ? apiToolsToRecords(items) : []
    },
  })

  const safeTools = tools ?? []

  const stats = useMemo(() => {
    const total = safeTools.reduce((sum, tool) => sum + tool.requests, 0)
    const avgSuccess =
      safeTools.length > 0 ? (safeTools.reduce((sum, t) => sum + t.successRate, 0) / safeTools.length).toFixed(1) : '—'
    const totalFailures = safeTools.reduce((sum, t) => sum + Math.round(t.requests * t.failureRate), 0)
    return { total, avgSuccess, count: safeTools.length, totalFailures }
  }, [safeTools])

  const topTools = safeTools.slice().sort((a, b) => b.requests - a.requests).slice(0, 10)

  return (
    <>
      <TopFilterBar title="工具调用" subtitle="工具频率、耗时与失败率" />
      {loading && <ObsBanner>加载工具数据…</ObsBanner>}
      {error && !loading && <ObsBanner tone="error">{error}</ObsBanner>}

      <ObsPage>
        <ObsStatStrip>
          <ObsStatItem label="调用总数" value={stats.total.toLocaleString()} hint="窗口内" variant="accent" />
          <ObsStatItem label="成功率" value={`${stats.avgSuccess}%`} hint="加权平均" />
          <ObsStatItem label="工具种类" value={stats.count} hint="已观测" />
          <ObsStatItem label="失败次数" value={stats.totalFailures.toLocaleString()} hint="需排查" variant="savings" />
        </ObsStatStrip>

        <div className="obs-panel-pair span-3">
          <ObsSection title="使用频率 Top 10" isEmpty={topTools.length === 0} empty={<ObsEmpty>暂无工具调用</ObsEmpty>}>
            <SmallBars
              barColor="linear-gradient(90deg, #0084ff, #32ade6)"
              rows={topTools.map((tool) => ({ label: tool.name, value: tool.requests }))}
            />
          </ObsSection>

          <ObsSection title="失败统计">
            <div className="failure-summary-card">
              <div className="failure-count">
                <span className="count">{stats.totalFailures}</span>
                <span className="label">总失败次数</span>
              </div>
              <div className="failure-list">
                {safeTools
                  .filter((t) => t.failureRate > 0)
                  .sort((a, b) => b.failureRate - a.failureRate)
                  .slice(0, 5)
                  .map((t) => (
                    <div key={t.name} className="failure-item">
                      <span className="name">{t.name}</span>
                      <span className="rate">{(t.failureRate * 100).toFixed(1)}%</span>
                    </div>
                  ))}
                {safeTools.filter((t) => t.failureRate > 0).length === 0 && (
                  <div className="no-failures">暂无失败记录</div>
                )}
              </div>
            </div>
          </ObsSection>
        </div>

        <ObsSection title="性能分析" className="span-3" isEmpty={safeTools.length === 0} empty={<ObsEmpty>暂无数据</ObsEmpty>}>
          <div className="analysis-sections">
            <div className="analysis-section">
              <h4 className="analysis-section-title">耗时 Top 10</h4>
              <SmallBars
                rows={safeTools
                  .slice()
                  .sort((a, b) => (parseInt(b.avgLatency) || 0) - (parseInt(a.avgLatency) || 0))
                  .slice(0, 10)
                  .map((tool) => ({
                    label: tool.name,
                    value: parseInt(tool.avgLatency) || 0,
                    sub: `P95 ${tool.p95Latency}`,
                  }))}
              />
            </div>
          </div>
        </ObsSection>

        <ObsSection className="span-3">
          <div className="action-panel">
            <div className="action-info">
              <h3>查看完整调用记录</h3>
              <p>浏览所有工具调用的输入、输出、耗时与错误详情</p>
            </div>
            <button type="button" className="primary action-button" onClick={() => onNavigate?.('tool-calls')}>
              进入调用记录 →
            </button>
          </div>
        </ObsSection>

        <ObsTablePanel
          title="工具明细"
          className="span-3"
          rows={safeTools}
          rowKey={(row) => row.name}
          emptyText="暂无工具数据"
          columns={[
            { key: 'name', label: '工具' },
            { key: 'category', label: '分类' },
            { key: 'requests', label: '调用数', render: (row) => row.requests.toLocaleString() },
            { key: 'successRate', label: '成功率', render: (row) => `${row.successRate}%` },
            { key: 'failureRate', label: '失败率', render: (row) => `${(row.failureRate * 100).toFixed(1)}%` },
            { key: 'avgLatency', label: '平均耗时' },
            { key: 'p95Latency', label: 'P95' },
          ]}
        />
      </ObsPage>
    </>
  )
}
