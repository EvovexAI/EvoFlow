import { useState } from 'react'
import { apiGatewayRoutesToRecords, trendsToTimePoints } from '../data/adapter'
import {
  ObsBanner,
  ObsPage,
  ObsPagination,
  ObsSection,
  ObsStatItem,
  ObsStatStrip,
  ObsTablePanel,
} from '../components/ObsLayout'
import { MultiLineAreaChart, SmallBars } from '../components/Charts'
import { TopFilterBar } from '../components/TopFilterBar'
import { fetchObsAnalyticsSummary, fetchObsGatewayRoutesSummary } from '../lib/obs-api'
import { useObsCachedFetch } from '../hooks/useObsCachedFetch'
import type { GatewayRoute, TimePoint } from '../types'

const PAGE_SIZE = 50

type GatewayData = {
  routes: GatewayRoute[]
  trend: TimePoint[]
  summary: { total: number; total4xx: number; total5xx: number; totalLimit: number }
  routeTotal: number
  pages: number
  pageSize: number
}

export function Gateway() {
  const [page, setPage] = useState(1)

  const { data, loading, error } = useObsCachedFetch<GatewayData>({
    scope: 'gateway-summary',
    params: { page, pageSize: PAGE_SIZE },
    fetcher: async (query) => {
      const [routesRes, analyticsRes] = await Promise.all([
        fetchObsGatewayRoutesSummary({ ...query, page, pageSize: PAGE_SIZE }),
        fetchObsAnalyticsSummary(query),
      ])
      if ((routesRes as { enabled?: boolean })?.enabled === false) {
        throw new Error('观测数据未启用')
      }
      const payload = routesRes as {
        items?: unknown[]
        summary?: Record<string, number>
        total?: number
        pages?: number
        page_size?: number
      }
      const items = payload.items
      const sum = payload.summary
      const trends = (analyticsRes as { trends?: Record<string, unknown> })?.trends ?? null
      const routeList = Array.isArray(items) ? apiGatewayRoutesToRecords(items) : []
      const routeTotal = Number(payload.total ?? routeList.length)
      const pages = Number(payload.pages ?? (routeTotal > 0 ? Math.max(1, Math.ceil(routeTotal / PAGE_SIZE)) : 0))
      return {
        routes: routeList,
        trend: trendsToTimePoints(trends),
        summary: {
          total: Number(sum?.total || 0),
          total4xx: Number(sum?.total4xx || 0),
          total5xx: Number(sum?.total5xx || 0),
          totalLimit: Number(sum?.total_limit || 0),
        },
        routeTotal,
        pages,
        pageSize: Number(payload.page_size ?? PAGE_SIZE),
      }
    },
  })

  const routes = data?.routes ?? []
  const trend = data?.trend ?? []
  const summary = data?.summary ?? { total: 0, total4xx: 0, total5xx: 0, totalLimit: 0 }
  const routeTotal = data?.routeTotal ?? 0
  const totalPages = data?.pages ?? 0
  const pageSize = data?.pageSize ?? PAGE_SIZE

  return (
    <>
      <TopFilterBar title="网关日志" subtitle="API 路由、错误码与性能指标" />
      {loading && !data && <ObsBanner>加载网关数据…</ObsBanner>}
      {error && !loading && <ObsBanner tone="error">{error}</ObsBanner>}

      <ObsPage>
        <ObsStatStrip>
          <ObsStatItem label="总请求" value={summary.total.toLocaleString()} hint="窗口内" variant="accent" />
          <ObsStatItem label="路由数" value={routeTotal.toLocaleString()} hint="去重 method+path" />
          <ObsStatItem label="4xx" value={summary.total4xx.toLocaleString()} hint="客户端错误" variant="danger" />
          <ObsStatItem label="5xx" value={summary.total5xx.toLocaleString()} hint="服务端错误" variant="danger" />
        </ObsStatStrip>

        <ObsSection title="API 请求趋势" className="span-2" isEmpty={trend.length === 0} empty="暂无趋势数据">
          <MultiLineAreaChart data={trend} />
        </ObsSection>

        <ObsSection title="错误码分布">
          <SmallBars
            rows={[
              { label: '2xx', value: routes.reduce((s, r) => s + r.status2xx, 0), sub: '成功' },
              { label: '4xx', value: summary.total4xx, sub: '客户端错误' },
              { label: '5xx', value: summary.total5xx, sub: '服务端错误' },
              { label: '429', value: summary.totalLimit, sub: '限流' },
            ]}
          />
        </ObsSection>

        <ObsTablePanel
          title="路由明细"
          className="span-3"
          rows={routes}
          rowKey={(row) => `${row.method}-${row.route}`}
          emptyText="暂无路由数据"
          footer={
            <ObsPagination
              page={page}
              pageSize={pageSize}
              total={routeTotal}
              totalPages={totalPages}
              onPageChange={setPage}
            />
          }
          columns={[
            { key: 'method', label: '方法' },
            { key: 'route', label: '路由' },
            { key: 'requests', label: '请求数', render: (row) => row.requests.toLocaleString() },
            { key: 'avgLatency', label: '平均延迟' },
            { key: 'p95Latency', label: 'P95' },
            { key: 'status2xx', label: '2xx', render: (row) => row.status2xx.toLocaleString() },
            { key: 'status4xx', label: '4xx', render: (row) => row.status4xx.toLocaleString() },
            { key: 'status5xx', label: '5xx', render: (row) => row.status5xx.toLocaleString() },
            { key: 'rateLimited', label: '限流', render: (row) => row.rateLimited.toLocaleString() },
            { key: 'upstream', label: '上游' },
          ]}
        />
      </ObsPage>
    </>
  )
}
