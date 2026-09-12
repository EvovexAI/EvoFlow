import { useState } from 'react'
import { apiToolCallsToRecords } from '../data/adapter'
import { fetchObsToolsSummary } from '../lib/obs-api'
import { OBS_TIME_RANGE_OPTIONS } from '../lib/obs-types'
import {
  ObsBanner,
  ObsPage,
  ObsPagination,
  ObsSegmentTabs,
  ObsStatItem,
  ObsStatStrip,
  ObsTablePanel,
} from '../components/ObsLayout'
import { StatusBadge } from '../components/StatusBadge'
import { ThreadLabel, useRegisterThreadIds } from '../components/ThreadLabel'
import { ToolCallDetailDrawer } from '../components/ToolCallDetailDrawer'
import { CustomSelect } from '../components/CustomSelect'
import { fmtShortDateTime } from '../lib/obs-formatters'
import { useObsContext } from '../hooks/ObsContext'
import { useObsCachedFetch } from '../hooks/useObsCachedFetch'
import type { ToolCallRecord } from '../types'

type ToolCallsData = { calls: ToolCallRecord[]; totalPages: number; total: number; pageSize: number }

export function ToolCallsTable({ onNavigate }: { onNavigate?: (key: string) => void }) {
  const obs = useObsContext()
  const [selected, setSelected] = useState<ToolCallRecord | null>(null)
  const [toolFilter, setToolFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'success' | 'failed'>('all')
  const [page, setPage] = useState(1)
  const pageSize = 50

  const { data, loading, error } = useObsCachedFetch<ToolCallsData>({
    scope: 'tool-calls-list',
    params: { page, toolFilter: toolFilter || '', agentFilter: obs.agentFilter, timeRange: obs.timeRange },
    fetcher: async (query) => {
      const res = await fetchObsToolsSummary({
        ...query,
        timeRange: obs.timeRange,
        agentFilter: obs.agentFilter,
        toolNameFilter: toolFilter || undefined,
        page,
        pageSize,
      })
      if ((res as { enabled?: boolean })?.enabled === false) throw new Error('观测数据未启用')
      const callItems = (res as { calls?: unknown[] })?.calls
      const pages = (res as { pages?: number })?.pages ?? 0
      const total = Number((res as { total?: number })?.total ?? 0)
      return {
        calls: Array.isArray(callItems) ? apiToolCallsToRecords(callItems) : [],
        totalPages: pages,
        total,
        pageSize,
      }
    },
  })

  const calls = data?.calls ?? []
  const totalPages = data?.totalPages ?? 0
  const total = data?.total ?? 0
  const listPageSize = data?.pageSize ?? pageSize

  useRegisterThreadIds(calls.map((row) => row.traceId))

  const filteredCalls = calls.filter((call) => {
    if (statusFilter === 'success' && call.status !== 'success') return false
    if (statusFilter === 'failed' && call.status === 'success') return false
    if (toolFilter && !call.toolName.toLowerCase().includes(toolFilter.toLowerCase())) return false
    return true
  })

  const successCount = filteredCalls.filter((c) => c.status === 'success').length
  const failedCount = filteredCalls.filter((c) => c.status === 'failed').length
  const avgLatency =
    filteredCalls.length > 0
      ? Math.round(filteredCalls.reduce((sum, c) => sum + (parseInt(c.latency) || 0), 0) / filteredCalls.length)
      : 0

  const timeLabel = OBS_TIME_RANGE_OPTIONS.find((o) => o.key === obs.timeRange)?.label ?? obs.timeRange

  return (
    <>
      {loading && !data && <ObsBanner>加载调用记录…</ObsBanner>}
      {error && !loading && <ObsBanner tone="error">{error}</ObsBanner>}

      <ObsPage>
        <div className="compact-filter-bar span-3">
          <button type="button" className="compact-back-btn" onClick={() => onNavigate?.('tools')}>
            ← 返回
          </button>
          <input
            placeholder="筛选工具名称"
            value={toolFilter}
            onChange={(e) => setToolFilter(e.target.value)}
            className="compact-input"
          />
          <ObsSegmentTabs
            value={statusFilter}
            options={[
              { value: 'all' as const, label: '全部' },
              { value: 'success' as const, label: '成功' },
              { value: 'failed' as const, label: '失败' },
            ]}
            onChange={setStatusFilter}
          />
          <CustomSelect
            className="compact-select-wrap"
            value={obs.timeRange}
            onChange={(v) => obs.setTimeRange(v as typeof obs.timeRange)}
            options={OBS_TIME_RANGE_OPTIONS.map((o) => ({ value: o.key, label: o.label }))}
          >
            <span>{timeLabel}</span>
          </CustomSelect>
          <CustomSelect
            className="compact-select-wrap"
            value={obs.agentFilter}
            onChange={(v) => obs.setAgentFilter(v)}
            options={[
              { value: 'all', label: '全部' },
              ...(obs.agents
                .map((agent) => {
                  const value = agent.id || agent.name || ''
                  if (!value) return null
                  return { value, label: agent.display_name || agent.name || value }
                })
                .filter(Boolean) as { value: string; label: string }[]),
              { value: 'main', label: 'main' },
            ]}
          >
            <span>Agent</span>
          </CustomSelect>
          <button type="button" className="compact-refresh" onClick={() => obs.reload()}>
            ↻ 刷新
          </button>
          {(toolFilter || statusFilter !== 'all') && (
            <button
              type="button"
              className="compact-clear"
              onClick={() => {
                setToolFilter('')
                setStatusFilter('all')
              }}
            >
              清除
            </button>
          )}
        </div>

        <ObsStatStrip>
          <ObsStatItem label="本页记录" value={filteredCalls.length} hint="当前筛选" variant="accent" />
          <ObsStatItem label="成功" value={successCount} hint="成功调用" />
          <ObsStatItem label="失败" value={failedCount} hint="需排查" variant="danger" />
          <ObsStatItem label="平均耗时" value={`${avgLatency}ms`} hint="本页均值" />
        </ObsStatStrip>

        <ObsTablePanel
          title="调用记录"
          className="span-3"
          rows={filteredCalls}
          rowKey={(row) => row.id}
          onRowClick={setSelected}
          emptyText="暂无工具调用记录"
          footer={
            <ObsPagination
              page={page}
              pageSize={listPageSize}
              total={total}
              totalPages={totalPages}
              onPageChange={setPage}
            />
          }
          columns={[
            { key: 'toolName', label: '工具名称' },
            { key: 'time', label: '时间', render: (row) => fmtShortDateTime(row.time) },
            { key: 'status', label: '状态', render: (row) => <StatusBadge status={row.status} /> },
            {
              key: 'input',
              label: '输入',
              render: (row) => (
                <span className="cell-truncate" title={row.input}>
                  {row.input.slice(0, 50)}
                  {row.input.length > 50 ? '…' : ''}
                </span>
              ),
            },
            {
              key: 'output',
              label: '输出',
              render: (row) => (
                <span className="cell-truncate" title={row.output}>
                  {row.output.slice(0, 50)}
                  {row.output.length > 50 ? '…' : ''}
                </span>
              ),
            },
            { key: 'agent', label: 'Agent' },
            { key: 'requestId', label: 'Request ID' },
            { key: 'latency', label: '耗时' },
            {
              key: 'error',
              label: '错误',
              render: (row) =>
                row.error ? (
                  <span className="text-danger" title={row.error}>
                    {row.error.slice(0, 30)}
                    {row.error.length > 30 ? '…' : ''}
                  </span>
                ) : (
                  '—'
                ),
            },
            {
              key: 'traceId',
              label: '会话',
              render: (row) => <ThreadLabel threadId={row.traceId} showId />,
            },
          ]}
        />
      </ObsPage>

      <ToolCallDetailDrawer record={selected} onClose={() => setSelected(null)} />
    </>
  )
}
