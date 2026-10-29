import { useMemo, useState } from 'react'
import { apiMediaEventToRecord } from '../data/adapter'
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
import { TopFilterBar } from '../components/TopFilterBar'
import { ThreadLabel, useRegisterThreadIds } from '../components/ThreadLabel'
import { CustomSelect } from '../components/CustomSelect'
import { fetchMediaGenerationEvents } from '../lib/obs-api'
import { OBS_TIME_RANGE_OPTIONS } from '../lib/obs-types'
import { useObsContext } from '../hooks/ObsContext'
import { useObsCachedFetch } from '../hooks/useObsCachedFetch'
import type { MediaGenerationRecord } from '../types'

const PAGE_SIZE = 50

type PageData = {
  rows: MediaGenerationRecord[]
  total: number
  pages: number
  page: number
  pageSize: number
}

export function MediaGeneration() {
  const obs = useObsContext()
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState<'all' | 'image' | 'video'>('all')
  const [status, setStatus] = useState<'all' | 'succeeded' | 'failed' | 'processing'>('all')
  const [page, setPage] = useState(1)

  const { data, loading, error } = useObsCachedFetch<PageData>({
    scope: 'media-generation-list',
    params: {
      page,
      search: search || '',
      kind,
      status,
      timeRange: obs.timeRange,
      pageSize: PAGE_SIZE,
    },
    fetcher: async () => {
      const res = (await fetchMediaGenerationEvents({
        page,
        pageSize: PAGE_SIZE,
        search: search || undefined,
        subcategory: kind,
        status,
        timeRange: obs.timeRange,
      })) as {
        items?: Record<string, unknown>[]
        total?: number
        pages?: number
        page?: number
        page_size?: number
      }
      const items = Array.isArray(res?.items) ? res.items : []
      return {
        rows: items.map((row) => apiMediaEventToRecord(row)),
        total: Number(res?.total ?? items.length),
        pages: Number(res?.pages ?? 1),
        page: Number(res?.page ?? page),
        pageSize: Number(res?.page_size ?? PAGE_SIZE),
      }
    },
  })

  const rows = data?.rows ?? []
  const total = data?.total ?? 0
  const totalPages = data?.pages ?? 0
  const pageSize = data?.pageSize ?? PAGE_SIZE

  useRegisterThreadIds(rows.map((r) => r.threadId).filter(Boolean))

  const stats = useMemo(() => {
    const images = rows.filter((r) => r.mediaKind === 'image').length
    const videos = rows.filter((r) => r.mediaKind === 'video').length
    const failed = rows.filter((r) => r.status === 'failed').length
    const cost = rows.reduce((sum, r) => sum + (Number.isFinite(r.amount) ? r.amount : 0), 0)
    return { images, videos, failed, cost }
  }, [rows])

  const timeLabel = OBS_TIME_RANGE_OPTIONS.find((o) => o.key === obs.timeRange)?.label ?? obs.timeRange

  return (
    <>
      <TopFilterBar title="生图生视频记录" subtitle="时间、操作者、模型、费用、产物与渠道 · 支持分页">
        <input
          className="filter-search-input"
          placeholder="模型 / 线程 / prompt / task"
          value={search}
          onChange={(e) => {
            setPage(1)
            setSearch(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setPage(1)
          }}
        />
        <CustomSelect
          className="compact-select-wrap"
          value={obs.timeRange}
          onChange={(v) => {
            setPage(1)
            obs.setTimeRange(v as typeof obs.timeRange)
          }}
          options={OBS_TIME_RANGE_OPTIONS.map((o) => ({ value: o.key, label: o.label }))}
        >
          <span>{timeLabel}</span>
        </CustomSelect>
        <button type="button" className="primary" onClick={() => setPage(1)}>
          搜索
        </button>
      </TopFilterBar>

      {loading && !data && <ObsBanner>加载生图生视频记录…</ObsBanner>}
      {error && !loading && <ObsBanner tone="error">{error}</ObsBanner>}

      <ObsPage>
        <ObsStatStrip>
          <ObsStatItem label="总记录" value={total.toLocaleString()} hint="符合筛选" variant="accent" />
          <ObsStatItem label="本页生图" value={stats.images} hint={`第 ${page} 页`} />
          <ObsStatItem label="本页生视频" value={stats.videos} />
          <ObsStatItem label="本页失败" value={stats.failed} hint="需关注" variant="danger" />
          <ObsStatItem
            label="本页费用"
            value={stats.cost > 0 ? (stats.cost < 0.01 ? '<$0.01' : `$${stats.cost.toFixed(2)}`) : '—'}
            hint="ledger 金额"
          />
        </ObsStatStrip>

        <div className="compact-filter-bar span-3">
          <ObsSegmentTabs
            value={kind}
            options={[
              { value: 'all' as const, label: '全部' },
              { value: 'image' as const, label: '生图' },
              { value: 'video' as const, label: '生视频' },
            ]}
            onChange={(v) => {
              setPage(1)
              setKind(v)
            }}
          />
          <ObsSegmentTabs
            value={status}
            options={[
              { value: 'all' as const, label: '全部状态' },
              { value: 'succeeded' as const, label: '成功' },
              { value: 'processing' as const, label: '进行中' },
              { value: 'failed' as const, label: '失败' },
            ]}
            onChange={(v) => {
              setPage(1)
              setStatus(v)
            }}
          />
        </div>

        <ObsTablePanel
          title="生成明细"
          className="span-3"
          rows={rows}
          rowKey={(row) => row.id}
          emptyText="暂无生图 / 生视频记录"
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
            {
              key: 'status',
              label: '状态',
              render: (row) => (
                <span title={row.statusRaw}>
                  <StatusBadge status={row.status} />
                </span>
              ),
            },
            { key: 'time', label: '时间' },
            { key: 'mediaKindLabel', label: '类型' },
            { key: 'who', label: '谁' },
            { key: 'model', label: '模型' },
            { key: 'provider', label: '厂商' },
            { key: 'amountLabel', label: '费用' },
            { key: 'channel', label: '渠道' },
            {
              key: 'contentPreview',
              label: '内容',
              render: (row) => {
                const url = row.resultUrl
                const preview = row.contentPreview || '—'
                if (url && /^https?:\/\//i.test(url)) {
                  return (
                    <a href={url} target="_blank" rel="noreferrer" title={preview} onClick={(e) => e.stopPropagation()}>
                      {preview.length > 40 ? `${preview.slice(0, 40)}…` : preview}
                    </a>
                  )
                }
                return (
                  <span title={preview} style={{ maxWidth: 240, display: 'inline-block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {preview}
                  </span>
                )
              },
            },
            {
              key: 'threadId',
              label: '会话',
              render: (row) => (row.threadId ? <ThreadLabel threadId={row.threadId} /> : '—'),
            },
          ]}
        />
      </ObsPage>
    </>
  )
}
