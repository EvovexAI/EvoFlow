import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { apiChannelMessageToRecord } from '../data/adapter'
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
import { CustomSelect } from '../components/CustomSelect'
import { fetchChannelMessages } from '../lib/obs-api'
import { OBS_TIME_RANGE_OPTIONS } from '../lib/obs-types'
import { useObsContext } from '../hooks/ObsContext'
import { useObsCachedFetch } from '../hooks/useObsCachedFetch'
import type { ChannelMessageRecord } from '../types'

type AttachmentItem = ChannelMessageRecord['attachmentItems'][number]

function isImagePath(item: AttachmentItem): boolean {
  const mime = (item.mime || '').toLowerCase()
  if (mime.startsWith('image/')) return true
  return /\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(item.path || item.filename || '')
}

function AttachmentViewerModal({
  row,
  onClose,
}: {
  row: ChannelMessageRecord
  onClose: () => void
}) {
  const items =
    row.attachmentItems.length > 0
      ? row.attachmentItems
      : row.attachments.map((p) => ({
          filename: p.replace(/\\/g, '/').split('/').pop() || p,
          path: p,
          mime: '',
        }))
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({})
  const [actionHint, setActionHint] = useState('')

  useEffect(() => {
    let cancelled = false
    const snapshot = items
    ;(async () => {
      try {
        const { getGatewayBaseUrl } = await import('../../../lib/tauri-api.js')
        const base = String((await getGatewayBaseUrl()) || '').replace(/\/+$/, '')
        if (!base || cancelled) return
        const next: Record<string, string> = {}
        for (const it of snapshot) {
          const abs = String(it.path || '').trim()
          if (!abs || !isImagePath(it)) continue
          next[abs] = `${base}/api/workspaces/serve-file?path=${encodeURIComponent(abs)}`
        }
        if (!cancelled) setPreviewUrls(next)
      } catch {
        /* preview optional */
      }
    })()
    return () => {
      cancelled = true
    }
    // Intentionally key off the row id — item arrays are rebuilt each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  const openLocal = async (absPath: string) => {
    const path = String(absPath || '').trim()
    if (!path) return
    try {
      const { revealPathInFileManager } = await import('../../../lib/tauri-api.js')
      await revealPathInFileManager(path)
      setActionHint(`已请求打开：${path}`)
    } catch (err) {
      setActionHint(`无法打开本地路径：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const copyPath = async (absPath: string) => {
    try {
      await navigator.clipboard.writeText(absPath)
      setActionHint('路径已复制')
    } catch {
      setActionHint('复制失败')
    }
  }

  return createPortal(
    <div className="obs-json-modal" role="dialog" aria-modal="true" aria-label="查看附件">
      <div className="obs-json-modal-backdrop" onClick={onClose} />
      <div className="obs-json-modal-panel" style={{ width: 'min(960px, calc(100vw - 40px))', height: 'auto', maxHeight: 'min(90vh, 900px)' }}>
        <div className="json-viewer-head">
          <strong>查看附件 · {row.employeeName || row.agentCode || row.channelLabel}</strong>
          <div className="json-viewer-actions">
            <button type="button" className="obs-json-modal-close" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
        <div className="obs-json-modal-body" style={{ display: 'grid', gap: 16 }}>
          {actionHint ? <ObsBanner>{actionHint}</ObsBanner> : null}
          {items.length === 0 ? (
            <ObsBanner>没有可展示的附件路径</ObsBanner>
          ) : (
            items.map((it) => {
              const abs = it.path || it.filename
              const preview = previewUrls[abs]
              return (
                <div
                  key={`${abs}-${it.filename}`}
                  style={{
                    border: '1px solid var(--border-strong, #334155)',
                    borderRadius: 12,
                    padding: 12,
                    display: 'grid',
                    gap: 10,
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{it.filename || 'attachment'}</div>
                  <code style={{ fontSize: 12, wordBreak: 'break-all', opacity: 0.9 }}>{abs}</code>
                  {preview ? (
                    <img
                      src={preview}
                      alt={it.filename}
                      style={{ maxWidth: '100%', maxHeight: 360, objectFit: 'contain', borderRadius: 8 }}
                    />
                  ) : null}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button type="button" className="primary" onClick={() => void openLocal(abs)}>
                      打开本地位置
                    </button>
                    <button type="button" onClick={() => void copyPath(abs)}>
                      复制路径
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

const PAGE_SIZE = 50

type PageData = {
  rows: ChannelMessageRecord[]
  total: number
  pages: number
  page: number
  pageSize: number
}

export function ChannelMessages() {
  const obs = useObsContext()
  const [search, setSearch] = useState('')
  const [direction, setDirection] = useState<'all' | 'inbound' | 'outbound'>('all')
  const [status, setStatus] = useState<'all' | 'received' | 'replied' | 'failed' | 'pending'>('all')
  const [channel, setChannel] = useState('all')
  const [page, setPage] = useState(1)
  const [attachmentRow, setAttachmentRow] = useState<ChannelMessageRecord | null>(null)

  const { data, loading, error } = useObsCachedFetch<PageData>({
    scope: 'channel-messages-list',
    params: {
      page,
      search: search || '',
      direction,
      status,
      channel,
      timeRange: obs.timeRange,
      pageSize: PAGE_SIZE,
    },
    fetcher: async () => {
      const res = (await fetchChannelMessages({
        page,
        pageSize: PAGE_SIZE,
        search: search || undefined,
        direction,
        status,
        channel,
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
        rows: items.map((row) => apiChannelMessageToRecord(row)),
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

  const stats = useMemo(() => {
    const inbound = rows.filter((r) => r.direction === 'inbound').length
    const outbound = rows.filter((r) => r.direction === 'outbound').length
    const failed = rows.filter((r) => r.status === 'failed').length
    const withAtt = rows.filter((r) => r.attachmentCount > 0).length
    return { inbound, outbound, failed, withAtt }
  }, [rows])

  const channelOptions = useMemo(() => {
    const known = ['feishu', 'wecom', 'weixin', 'dingtalk', 'telegram', 'slack']
    const fromRows = rows.map((r) => r.channel).filter((c) => c && c !== '—')
    const set = new Set([...known, ...fromRows])
    return [
      { value: 'all', label: '全部渠道' },
      ...Array.from(set).map((c) => ({ value: c, label: c })),
    ]
  }, [rows])

  const timeLabel = OBS_TIME_RANGE_OPTIONS.find((o) => o.key === obs.timeRange)?.label ?? obs.timeRange

  return (
    <>
      <TopFilterBar title="渠道消息统计" subtitle="收发时间、状态、消息类型与附件 · 支持分页">
        <input
          className="filter-search-input"
          placeholder="内容 / 员工 code / 会话 / 渠道"
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
        <CustomSelect
          className="compact-select-wrap"
          value={channel}
          onChange={(v) => {
            setPage(1)
            setChannel(v)
          }}
          options={channelOptions}
        >
          <span>{channel === 'all' ? '全部渠道' : channel}</span>
        </CustomSelect>
        <button type="button" className="primary" onClick={() => setPage(1)}>
          搜索
        </button>
      </TopFilterBar>

      {loading && !data && <ObsBanner>加载渠道消息…</ObsBanner>}
      {error && !loading && <ObsBanner tone="error">{error}</ObsBanner>}

      <ObsPage>
        <ObsStatStrip>
          <ObsStatItem label="总记录" value={total.toLocaleString()} hint="符合筛选" variant="accent" />
          <ObsStatItem label="本页接收" value={stats.inbound} hint={`第 ${page} 页`} />
          <ObsStatItem label="本页回复" value={stats.outbound} />
          <ObsStatItem label="本页失败" value={stats.failed} hint="需关注" variant="danger" />
          <ObsStatItem label="含附件" value={stats.withAtt} />
        </ObsStatStrip>

        <div className="compact-filter-bar span-3">
          <ObsSegmentTabs
            value={direction}
            options={[
              { value: 'all' as const, label: '全部方向' },
              { value: 'inbound' as const, label: '接收' },
              { value: 'outbound' as const, label: '回复' },
            ]}
            onChange={(v) => {
              setPage(1)
              setDirection(v)
            }}
          />
          <ObsSegmentTabs
            value={status}
            options={[
              { value: 'all' as const, label: '全部状态' },
              { value: 'received' as const, label: '已接收' },
              { value: 'replied' as const, label: '已回复' },
              { value: 'failed' as const, label: '失败' },
              { value: 'pending' as const, label: '发送中' },
            ]}
            onChange={(v) => {
              setPage(1)
              setStatus(v)
            }}
          />
        </div>

        <ObsTablePanel
          title="消息明细"
          className="span-3"
          rows={rows}
          rowKey={(row) => row.id}
          emptyText="暂无渠道消息记录"
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
              key: 'displayStatus',
              label: '状态',
              render: (row) => (
                <span title={row.error || undefined}>
                  <StatusBadge status={row.status} />
                  <span style={{ marginLeft: 6 }}>{row.displayStatus}</span>
                </span>
              ),
            },
            { key: 'time', label: '时间' },
            {
              key: 'channelLabel',
              label: '渠道',
              render: (row) => <span title={row.channel}>{row.channelLabel || row.channel || '—'}</span>,
            },
            { key: 'directionLabel', label: '方向' },
            {
              key: 'employeeName',
              label: '员工',
              render: (row) => {
                const name = row.employeeName || '—'
                const tip = row.agentCode && row.agentCode !== name ? `${name}（${row.agentCode}）` : name
                return <span title={tip}>{name}</span>
              },
            },
            {
              key: 'botId',
              label: '机器人 ID',
              render: (row) => (
                <span
                  title={row.botId || undefined}
                  style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}
                >
                  {row.botId
                    ? row.botId.length > 16
                      ? `${row.botId.slice(0, 16)}…`
                      : row.botId
                    : '—'}
                </span>
              ),
            },
            { key: 'msgType', label: '消息类型' },
            { key: 'kindLabel', label: '种类' },
            {
              key: 'content',
              label: '内容',
              render: (row) => (
                <span title={row.content} style={{ maxWidth: 280, display: 'inline-block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {row.content || '—'}
                </span>
              ),
            },
            {
              key: 'attachmentCount',
              label: '附件',
              render: (row) =>
                row.attachmentCount > 0 ? (
                  <button
                    type="button"
                    title={(row.attachments.length ? row.attachments : row.attachmentItems.map((a) => a.path)).join('\n')}
                    onClick={(e) => {
                      e.stopPropagation()
                      setAttachmentRow(row)
                    }}
                    style={{
                      border: '1px solid var(--border-strong, #475569)',
                      background: 'transparent',
                      color: 'inherit',
                      borderRadius: 8,
                      padding: '2px 8px',
                      cursor: 'pointer',
                      fontSize: 12,
                    }}
                  >
                    查看附件 · {row.attachmentCount}
                  </button>
                ) : (
                  '—'
                ),
            },
            {
              key: 'receiveId',
              label: '会话',
              render: (row) => (
                <span title={row.receiveId} style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>
                  {row.receiveId ? `${row.receiveId.slice(0, 12)}${row.receiveId.length > 12 ? '…' : ''}` : '—'}
                </span>
              ),
            },
            {
              key: 'triggeredByLabel',
              label: '触发',
              render: (row) => <span title={row.triggeredBy}>{row.triggeredByLabel || row.triggeredBy || '—'}</span>,
            },
          ]}
        />
      </ObsPage>
      {attachmentRow ? (
        <AttachmentViewerModal row={attachmentRow} onClose={() => setAttachmentRow(null)} />
      ) : null}
    </>
  )
}
