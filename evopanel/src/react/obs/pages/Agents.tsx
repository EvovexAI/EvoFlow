import { useMemo } from 'react'
import { apiAgentsToRecords } from '../data/adapter'
import {
  ObsBanner,
  ObsEmpty,
  ObsGroup,
  ObsListRow,
  ObsPage,
  ObsStatItem,
  ObsStatStrip,
  ObsTablePanel,
} from '../components/ObsLayout'
import { StatusBadge } from '../components/StatusBadge'
import { TopFilterBar } from '../components/TopFilterBar'
import { fetchObsAgentsSummary } from '../lib/obs-api'
import { agentKindLabel } from '../lib/obs-formatters'
import { useObsCachedFetch } from '../hooks/useObsCachedFetch'
import type { AgentRecord } from '../types'

export function Agents() {
  const { data: rows, loading, error } = useObsCachedFetch<AgentRecord[]>({
    scope: 'agents-summary',
    fetcher: async (query) => {
      const res = await fetchObsAgentsSummary(query)
      if (res?.enabled === false) throw new Error('观测数据未启用')
      const items = (res as { items?: unknown[] })?.items
      return Array.isArray(items) ? apiAgentsToRecords(items) : []
    },
  })
  const safeRows = rows ?? []

  const stats = useMemo(() => {
    const activeAgents = safeRows.filter((a) => a.status !== 'error').length
    const avgSuccess =
      safeRows.length > 0 ? (safeRows.reduce((sum, row) => sum + row.successRate, 0) / safeRows.length).toFixed(1) : '—'
    return {
      total: safeRows.length,
      active: activeAgents,
      error: safeRows.length - activeAgents,
      avgSuccess,
    }
  }, [safeRows])

  return (
    <>
      <TopFilterBar title="Agent 管理" subtitle="各 Agent 类型的调用量、成功率与主模型" />
      {loading && <ObsBanner>加载 Agent 数据…</ObsBanner>}
      {error && !loading && <ObsBanner tone="error">{error}</ObsBanner>}

      <ObsPage>
        <ObsStatStrip>
          <ObsStatItem label="Agent 总数" value={stats.total} hint="当前窗口" />
          <ObsStatItem label="活跃" value={stats.active} hint="状态正常" variant="accent" />
          <ObsStatItem label="异常" value={stats.error} hint="需关注" variant="danger" />
          <ObsStatItem label="平均成功率" value={`${stats.avgSuccess}%`} hint="加权平均" variant="accent" />
        </ObsStatStrip>

        <ObsGroup title="Agent 概览" className="span-3">
          {safeRows.length === 0 && !loading ? (
            <ObsEmpty>暂无 Agent 数据</ObsEmpty>
          ) : (
            safeRows.map((agent) => (
              <ObsListRow
                key={agent.name}
                title={agentKindLabel(agent.name)}
                badge={<StatusBadge status={agent.status} />}
                metrics={[
                  { label: '调用数', value: agent.requests.toLocaleString() },
                  { label: '成功率', value: `${agent.successRate}%`, tone: 'highlight' },
                  { label: '平均延迟', value: agent.avgLatency },
                  { label: 'Token', value: agent.tokens },
                  { label: '主模型', value: agent.mainModel },
                  { label: '工具调用', value: agent.tools.toLocaleString() },
                ]}
              />
            ))
          )}
        </ObsGroup>

        <ObsTablePanel
          title="Agent 明细"
          className="span-3"
          rows={safeRows}
          rowKey={(row) => row.name}
          emptyText="暂无数据"
          columns={[
            { key: 'name', label: 'Agent', render: (row) => agentKindLabel(row.name) },
            { key: 'status', label: '状态', render: (row) => <StatusBadge status={row.status} /> },
            { key: 'requests', label: '调用数', render: (row) => row.requests.toLocaleString() },
            { key: 'successRate', label: '成功率', render: (row) => `${row.successRate}%` },
            { key: 'avgLatency', label: '平均延迟' },
            { key: 'tokens', label: 'Token' },
            { key: 'mainModel', label: '主模型' },
            { key: 'tools', label: '工具', render: (row) => row.tools.toLocaleString() },
          ]}
        />
      </ObsPage>
    </>
  )
}
