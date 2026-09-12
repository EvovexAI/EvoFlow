import { gatewayRoutes, requestTrend } from '../data/mock';
import { Card } from '../components/Card';
import { MultiLineAreaChart, SmallBars } from '../components/Charts';
import { DataTable } from '../components/DataTable';
import { TopFilterBar } from '../components/TopFilterBar';

export function Gateway() {
  const total = gatewayRoutes.reduce((sum, route) => sum + route.requests, 0);
  const total4xx = gatewayRoutes.reduce((sum, route) => sum + route.status4xx, 0);
  const total5xx = gatewayRoutes.reduce((sum, route) => sum + route.status5xx, 0);
  const totalLimit = gatewayRoutes.reduce((sum, route) => sum + route.rateLimited, 0);
  return (
    <>
      <TopFilterBar title="网关日志 Gateway" subtitle="API Gateway 请求日志、路由分发、错误码和性能指标" />
      <div className="page-grid">
        <Card className="mini-stat"><span>总请求</span><strong>{total.toLocaleString()}</strong><em>7d</em></Card>
        <Card className="mini-stat"><span>4xx</span><strong>{total4xx.toLocaleString()}</strong><em>客户端错误</em></Card>
        <Card className="mini-stat"><span>5xx</span><strong>{total5xx.toLocaleString()}</strong><em>服务端错误</em></Card>
        <Card className="mini-stat"><span>限流数</span><strong>{totalLimit.toLocaleString()}</strong><em>rate limited</em></Card>

        <Card title="API 请求趋势" subtitle="Gateway Request Trend" className="span-2">
          <MultiLineAreaChart data={requestTrend} />
        </Card>
        <Card title="错误码分布" subtitle="Status Distribution">
          <SmallBars rows={[
            { label: '2xx', value: gatewayRoutes.reduce((s, r) => s + r.status2xx, 0), sub: 'Success' },
            { label: '4xx', value: total4xx, sub: 'Client Error' },
            { label: '5xx', value: total5xx, sub: 'Server Error' },
            { label: '429', value: totalLimit, sub: 'Rate Limited' }
          ]} />
        </Card>

        <Card title="路由明细" subtitle="Route Performance Table" className="span-3">
          <DataTable
            rows={gatewayRoutes}
            rowKey={(row) => `${row.method}-${row.route}`}
            columns={[
              { key: 'method', label: 'Method' },
              { key: 'route', label: 'Route' },
              { key: 'requests', label: 'Requests', render: (row) => row.requests.toLocaleString() },
              { key: 'avgLatency', label: 'Avg Latency' },
              { key: 'p95Latency', label: 'P95' },
              { key: 'status2xx', label: '2xx', render: (row) => row.status2xx.toLocaleString() },
              { key: 'status4xx', label: '4xx', render: (row) => row.status4xx.toLocaleString() },
              { key: 'status5xx', label: '5xx', render: (row) => row.status5xx.toLocaleString() },
              { key: 'rateLimited', label: 'Rate Limited', render: (row) => row.rateLimited.toLocaleString() },
              { key: 'upstream', label: 'Upstream' }
            ]}
          />
        </Card>
      </div>
    </>
  );
}
