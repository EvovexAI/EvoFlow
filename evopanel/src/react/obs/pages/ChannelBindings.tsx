import { useMemo, useState } from 'react'
import { apiChannelBindingToRecord } from '../data/adapter'
import {
  ObsBanner,
  ObsPage,
  ObsStatItem,
  ObsStatStrip,
  ObsTablePanel,
} from '../components/ObsLayout'
import { StatusBadge } from '../components/StatusBadge'
import { TopFilterBar } from '../components/TopFilterBar'
import { CustomSelect } from '../components/CustomSelect'
import { fetchChannelBindings } from '../lib/obs-api'
import { useObsCachedFetch } from '../hooks/useObsCachedFetch'
import type { ChannelBindingRecord } from '../types'

type PageData = {
  rows: ChannelBindingRecord[]
  total: number
}

export function ChannelBindings() {
  const [search, setSearch] = useState('')
  const [channel, setChannel] = useState('all')

  const { data, loading, error } = useObsCachedFetch<PageData>({
    scope: 'channel-bindings-list',
    params: {
      search: search || '',
      channel,
    },
    fetcher: async () => {
      const res = (await fetchChannelBindings({
        search: search || undefined,
        channel,
      })) as {
        items?: Record<string, unknown>[]
        total?: number
      }
      const items = Array.isArray(res?.items) ? res.items : []
      return {
        rows: items.map((row) => apiChannelBindingToRecord(row)),
        total: Number(res?.total ?? items.length),
      }
    },
  })

  const rows = data?.rows ?? []
  const total = data?.total ?? 0

  const stats = useMemo(() => {
    const bound = rows.filter((r) => r.enabled).length
    const disabled = rows.filter((r) => !r.enabled).length
    const qr = rows.filter((r) => r.bindMethod === 'qr').length
    return { bound, disabled, qr }
  }, [rows])

  const channelOptions = useMemo(() => {
    const known = ['feishu', 'wecom', 'weixin', 'dingtalk']
    const fromRows = rows.map((r) => r.channel).filter(Boolean)
    const set = new Set([...known, ...fromRows])
    return [
      { value: 'all', label: '全部渠道' },
      ...Array.from(set).map((c) => ({ value: c, label: c })),
    ]
  }, [rows])

  return (
    <>
      <TopFilterBar title="渠道绑定" subtitle="绑定方式、状态、员工与时间">
        <input
          className="filter-search-input"
          placeholder="员工 / 机器人 ID / 渠道"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setSearch((s) => s.trim())
          }}
        />
        <CustomSelect
          className="compact-select-wrap"
          value={channel}
          onChange={setChannel}
          options={channelOptions}
        >
          <span>{channel === 'all' ? '全部渠道' : channel}</span>
        </CustomSelect>
        <button type="button" className="primary" onClick={() => setSearch((s) => s.trim())}>
          搜索
        </button>
      </TopFilterBar>

      {loading && !data && <ObsBanner>加载渠道绑定…</ObsBanner>}
      {error && !loading && <ObsBanner tone="error">{error}</ObsBanner>}

      <ObsPage>
        <ObsStatStrip>
          <ObsStatItem label="绑定总数" value={total.toLocaleString()} hint="符合筛选" variant="accent" />
          <ObsStatItem label="已绑定" value={stats.bound} />
          <ObsStatItem label="已停用" value={stats.disabled} hint="需关注" variant="danger" />
          <ObsStatItem label="扫码绑定" value={stats.qr} />
        </ObsStatStrip>

        <ObsTablePanel
          title="绑定明细"
          className="span-3"
          rows={rows}
          rowKey={(row) => row.id}
          emptyText="暂无渠道绑定记录"
          columns={[
            {
              key: 'statusLabel',
              label: '状态',
              render: (row) => (
                <span>
                  <StatusBadge status={row.status} />
                  <span style={{ marginLeft: 6 }}>{row.statusLabel}</span>
                </span>
              ),
            },
            { key: 'boundAtLabel', label: '绑定时间' },
            {
              key: 'channelLabel',
              label: '渠道',
              render: (row) => <span title={row.channel}>{row.channelLabel || row.channel || '—'}</span>,
            },
            { key: 'bindMethodLabel', label: '绑定方式' },
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
                    ? row.botId.length > 20
                      ? `${row.botId.slice(0, 20)}…`
                      : row.botId
                    : '—'}
                </span>
              ),
            },
            {
              key: 'peerOpenId',
              label: '扫码用户',
              render: (row) => (
                <span
                  title={row.peerOpenId || undefined}
                  style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}
                >
                  {row.peerOpenId
                    ? row.peerOpenId.length > 16
                      ? `${row.peerOpenId.slice(0, 16)}…`
                      : row.peerOpenId
                    : '—'}
                </span>
              ),
            },
          ]}
        />
      </ObsPage>
    </>
  )
}
