import { useMemo, useState } from 'react'
import { apiModelListRowToRequestRecord } from '../data/adapter'
import { ObsBanner, ObsPage, ObsPagination, ObsStatItem, ObsStatStrip, ObsTablePanel } from '../components/ObsLayout'
import { RequestDetailDrawer } from '../components/RequestDetailDrawer'
import { StatusBadge } from '../components/StatusBadge'
import { ThreadLabel, useRegisterThreadIds } from '../components/ThreadLabel'
import { TopFilterBar } from '../components/TopFilterBar'
import { fetchObsModels } from '../lib/obs-api'
import { fmtCacheHitTok, fmtCnyEstimate, fmtMs, fmtUsageTok, requestTokenTitle } from '../lib/obs-formatters'
import { useObsCachedFetch } from '../hooks/useObsCachedFetch'
import type { RequestRecord } from '../types'

const PAGE_SIZE = 50

type RequestsPageData = {
  rows: RequestRecord[]
  total: number
  pages: number
  page: number
  pageSize: number
}

export function Requests() {
  const [selected, setSelected] = useState<RequestRecord | null>(null)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)

  const { data, loading, error } = useObsCachedFetch<RequestsPageData>({
    scope: 'requests-list',
    params: { page, search: search || '', pageSize: PAGE_SIZE },
    fetcher: async (query) => {
      const res = await fetchObsModels({ ...query, page, pageSize: PAGE_SIZE, search: search || undefined })
      if ((res as { enabled?: boolean })?.enabled === false) throw new Error('观测数据未启用')
      const payload = res as { items?: Record<string, unknown>[]; total?: number; pages?: number; page?: number; page_size?: number }
      const items = payload.items
      const rows = Array.isArray(items) ? items.map((row) => apiModelListRowToRequestRecord(row)) : []
      return {
        rows,
        total: Number(payload.total ?? rows.length),
        pages: Number(payload.pages ?? 1),
        page: Number(payload.page ?? page),
        pageSize: Number(payload.page_size ?? PAGE_SIZE),
      }
    },
  })

  const safeRows = data?.rows ?? []
  const total = data?.total ?? 0
  const totalPages = data?.pages ?? 0
  const pageSize = data?.pageSize ?? PAGE_SIZE

  useRegisterThreadIds(safeRows.map((row) => row.threadId))

  const stats = useMemo(() => {
    const success = safeRows.filter((r) => r.status === 'success').length
    const failed = safeRows.filter((r) => r.status === 'failed').length
    const cacheHits = safeRows.reduce((sum, r) => sum + (r.cacheReadTokens ?? 0), 0)
    return { total: safeRows.length, success, failed, cacheHits }
  }, [safeRows])

  return (
    <>
      <TopFilterBar title="调用记录" subtitle="模型请求筛选、搜索与详情">
        <input
          className="filter-search-input"
          placeholder="request_id / thread_id / agent / model"
          value={search}
          onChange={(e) => {
            setPage(1)
            setSearch(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setPage(1)
          }}
        />
        <button type="button" className="primary" onClick={() => setPage(1)}>
          搜索
        </button>
      </TopFilterBar>
      {loading && !data && <ObsBanner>加载请求记录…</ObsBanner>}
      {error && !loading && <ObsBanner tone="error">{error}</ObsBanner>}

      <ObsPage>
        <ObsStatStrip>
          <ObsStatItem label="总记录" value={total.toLocaleString()} hint="符合筛选" variant="accent" />
          <ObsStatItem label="本页成功" value={stats.success} hint={`第 ${page} 页`} />
          <ObsStatItem label="本页失败" value={stats.failed} hint="需关注" variant="danger" />
          <ObsStatItem label="本页缓存命中" value={stats.cacheHits.toLocaleString()} hint="Token" />
        </ObsStatStrip>

        <ObsTablePanel
          title="请求记录"
          className="span-3"
          rows={safeRows}
          rowKey={(row) => row.id}
          onRowClick={setSelected}
          emptyText="暂无请求记录"
          footer={
            <ObsPagination
              page={page}
              pageSize={pageSize}
              total={total}
              totalPages={totalPages}
              onPageChange={setPage}
            />
          }
          columns={[
            { key: 'status', label: '状态', render: (row) => <StatusBadge status={row.status} /> },
            { key: 'time', label: '时间' },
            { key: 'agent', label: 'Agent' },
            { key: 'model', label: '模型' },
            { key: 'thinkingLabel', label: '思考', render: (row) => row.thinkingLabel || '—' },
            {
              key: 'replyKind',
              label: '回复类型',
              render: (row) => {
                if (row.status === 'failed') return '失败'
                if (row.status === 'warning') return '警告'
                switch (row.replyKind) {
                  case 'tool_call':
                    return '工具调用'
                  case 'tools_and_content':
                    return '工具+文本'
                  case 'planning':
                    return '规划'
                  case 'reason':
                    return '推理'
                  default:
                    return '文本'
                }
              },
            },
            { key: 'modelCallSeq', label: '消息seq', render: (row) => (row.modelCallSeq != null ? `#${row.modelCallSeq}` : '—') },
            {
              key: 'payloadMessageCount',
              label: '消息',
              render: (row) => (row.payloadMessageCount != null ? `${row.payloadMessageCount} 条` : '—'),
            },
            {
              key: 'latency',
              label: '延迟',
              render: (row) => <span className={row.status === 'failed' ? 'text-danger' : ''}>{row.latency}</span>,
            },
            {
              key: 'totalCycle',
              label: '整轮耗时',
              render: (row) => {
                if (!row.totalCycleMs) return '—'
                const overhead = Math.max(0, row.totalCycleMs - row.latencyMs)
                return (
                  <span title={`模型推理 ${row.latency} + 系统开销 ${fmtMs(overhead)}`}>
                    {row.totalCycle}
                  </span>
                )
              },
            },
            { key: 'promptTokens', label: '输入', render: (row) => <span title={requestTokenTitle(row)}>{fmtUsageTok(row.promptTokens)}</span> },
            { key: 'completionTokens', label: '输出', render: (row) => <span title={requestTokenTitle(row)}>{fmtUsageTok(row.completionTokens)}</span> },
            {
              key: 'cacheReadTokens',
              label: '缓存',
              render: (row) => <span title={requestTokenTitle(row)}>{fmtCacheHitTok(row.cacheReadTokens, row.cacheMissTokens)}</span>,
            },
            { key: 'tokens', label: '合计', render: (row) => row.tokens.toLocaleString() },
            { key: 'cost', label: '费用', render: (row) => fmtCnyEstimate(row.estimatedCostCny) },
            { key: 'threadId', label: '会话', render: (row) => <ThreadLabel threadId={row.threadId} showId /> },
            { key: 'replyPreview', label: '回复摘要', render: (row) => row.replyPreview ?? '—' },
            { key: 'failureMessage', label: '失败原因', render: (row) => row.failureMessage ?? '—' },
          ]}
        />
      </ObsPage>

      <RequestDetailDrawer request={selected} onClose={() => setSelected(null)} />
    </>
  )
}
