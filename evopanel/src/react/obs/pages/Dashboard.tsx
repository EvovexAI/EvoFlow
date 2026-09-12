import { useMemo, useState } from 'react'
import { BarRanking, ModelTrendChart } from '../components/Charts'
import {
  ObsBanner,
  ObsEmpty,
  ObsPage,
  ObsSection,
  ObsSegmentTabs,
  ObsStatItem,
  ObsStatStrip,
  ObsTablePanel,
} from '../components/ObsLayout'
import { MetricCard } from '../components/MetricCard'
import { StatusBadge } from '../components/StatusBadge'
import { RequestDetailDrawer } from '../components/RequestDetailDrawer'
import { TopFilterBar } from '../components/TopFilterBar'
import { RuntimeStatusPanel } from '../components/RuntimeStatusPanel'
import { TokenCostPanel } from '../components/TokenCostPanel'
import { useObsContext } from '../hooks/ObsContext'
import type { RequestRecord } from '../types'
import { fmtNum, fmtRelativeTime, fmtCacheHitTok, fmtTok, fmtUsageTok, requestTokenTitle } from '../lib/obs-formatters'

export function Dashboard() {
  const obs = useObsContext()
  const [selected, setSelected] = useState<RequestRecord | null>(null)

  const modelBars = useMemo(
    () =>
      obs.modelRankingRows.slice(0, 5).map((row) => ({
        label: row.label,
        provider: row.provider,
        value: row.value,
        requests: row.requests,
        tokens: row.tokens,
        cacheRead: row.cacheRead,
        cacheHitRate: row.cacheHitRate,
        cost: row.cost,
      })),
    [obs.modelRankingRows],
  )

  const top5CacheRead = useMemo(
    () => obs.modelRankingRows.slice(0, 5).reduce((sum, row) => sum + row.cacheReadTokens, 0),
    [obs.modelRankingRows],
  )

  return (
    <>
      <TopFilterBar title="观测总览" />

      {!obs.enabled && (
        <ObsBanner tone="error">
          {obs.error || '观测数据不可用，请确认 Gateway 已启动后重试'}
          <button type="button" className="mini-btn" onClick={() => obs.reload()} style={{ marginLeft: 12 }}>
            重试
          </button>
        </ObsBanner>
      )}
      {obs.enabled && obs.error && (
        <ObsBanner tone="error">
          {obs.error}
          <button type="button" className="mini-btn" onClick={() => obs.reload()} style={{ marginLeft: 12 }}>
            重试
          </button>
        </ObsBanner>
      )}
      {obs.loading && <ObsBanner>加载观测数据…</ObsBanner>}

      <ObsPage className="dashboard-grid dashboard-v2 with-drawer-space">
        <RuntimeStatusPanel variant="hero" />

        <div className="metrics-grid metrics-grid-3">
          {obs.metrics.map((metric) => (
            <MetricCard key={metric.title} metric={metric} />
          ))}
        </div>

        {obs.enabled && (
          <>
            <TokenCostPanel summary={obs.tokenCostSummary} />
            <ObsStatStrip>
              <ObsStatItem label="工具调用" value={fmtNum(obs.toolCalls)} />
              <ObsStatItem
                label="工具错误"
                value={fmtNum(obs.toolErrors)}
                variant={obs.toolErrors > 0 ? 'danger' : 'default'}
              />
            </ObsStatStrip>
          </>
        )}

        <div className="dashboard-row dashboard-row-trend">
          <ObsSection
            title="模型调用趋势"
            className="span-2"
            actions={
              <ObsSegmentTabs
                value={obs.timeRange}
                onChange={obs.setTimeRange}
                options={[
                  { value: '24h', label: '24h' },
                  { value: '7d', label: '7d' },
                  { value: '30d', label: '30d' },
                  { value: '90d', label: '90d' },
                  { value: 'all', label: '全部' },
                ]}
              />
            }
            isEmpty={obs.requestTrend.length === 0}
            empty={<ObsEmpty>当前时间范围内暂无模型调用</ObsEmpty>}
          >
            <>
              <div className="legend">
                <span className="blue-dot">调用量</span>
                <span className="green-dot">成功</span>
                <span className="red-dot">失败</span>
                <span className="cyan-dot">缓存命中</span>
              </div>
              <ModelTrendChart data={obs.requestTrend} />
            </>
          </ObsSection>

          <ObsSection
            title="模型 Token Top5"
            subtitle={top5CacheRead > 0 ? `缓存命中 ${fmtTok(top5CacheRead)}` : undefined}
            isEmpty={modelBars.length === 0}
            empty={<ObsEmpty>暂无模型调用</ObsEmpty>}
          >
            <BarRanking rows={modelBars} valueKey="tokens" />
          </ObsSection>
        </div>

        <div className="obs-panel-pair">
          <ObsTablePanel
            title="Agent 分类统计"
            rows={obs.agentTopRows}
            rowKey={(row) => String(row.rank)}
            emptyText="暂无 Agent 分类数据"
            columns={[
              { key: 'name', label: 'Agent' },
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
              { key: 'avgLatency', label: '延迟' },
              { key: 'mainModel', label: '主模型' },
              {
                key: 'status',
                label: '状态',
                render: (row) => (
                  <span className={`status-tag ${row.status === '正常' ? 'success' : row.status === '注意' ? 'warning' : 'error'}`}>
                    {row.status}
                  </span>
                ),
              },
            ]}
          />

          <ObsSection title="最近工具错误" isEmpty={obs.recentToolErrors.length === 0} empty={<ObsEmpty>窗口内无工具错误</ObsEmpty>}>
            <div className="alert-list compact">
              {obs.recentToolErrors.map((row, idx) => (
                <div key={idx} className="alert-item error">
                  <div className="alert-content">
                    <div className="alert-title">{row.tool_name || '工具'}</div>
                    <div className="alert-desc">{row.error_message || row.error_type || '—'}</div>
                  </div>
                  <span className="alert-time">{fmtRelativeTime(row.ended_at)}</span>
                </div>
              ))}
            </div>
          </ObsSection>
        </div>

        <ObsSection title="最近模型调用" className="span-3" isEmpty={obs.recentRequests.length === 0} empty={<ObsEmpty>暂无模型调用记录</ObsEmpty>}>
          <div className="activity-list">
            <div className="activity-head">
              <span>状态</span>
              <span>Agent</span>
              <span>Model</span>
              <span>Provider</span>
              <span>延迟</span>
              <span>输入</span>
              <span>输出</span>
              <span>缓存</span>
              <span>时间</span>
              <span />
            </div>
            {obs.recentRequests.slice(0, 5).map((row) => (
              <button
                type="button"
                className={`activity-row ${selected?.id === row.id ? 'selected' : ''}`}
                key={row.id}
                onClick={() => setSelected(row)}
                title={requestTokenTitle(row)}
              >
                <StatusBadge status={row.status} />
                <span>{row.agent}</span>
                <span>{row.model}</span>
                <span>{row.provider}</span>
                <span className={row.status === 'failed' ? 'text-danger' : ''}>{row.latency}</span>
                <span title={requestTokenTitle(row)}>{fmtUsageTok(row.promptTokens)}</span>
                <span title={requestTokenTitle(row)}>{fmtUsageTok(row.completionTokens)}</span>
                <span title={requestTokenTitle(row)}>{fmtCacheHitTok(row.cacheReadTokens, row.cacheMissTokens)}</span>
                <span title={row.time}>{row.relativeTime}</span>
                <span>›</span>
              </button>
            ))}
          </div>
        </ObsSection>
      </ObsPage>

      <RequestDetailDrawer request={selected} onClose={() => setSelected(null)} />
    </>
  )
}
