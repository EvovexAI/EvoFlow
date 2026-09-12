import { useState } from 'react';
import { agents, metrics, models, recentRequests, requestTrend } from '../data/mock';
import type { RequestRecord } from '../types';
import { Card } from '../components/Card';
import { MetricCard } from '../components/MetricCard';
import { BarRanking, DonutChart, MultiLineAreaChart, TokenStackChart } from '../components/Charts';
import { StatusBadge } from '../components/StatusBadge';
import { RequestDetailDrawer } from '../components/RequestDetailDrawer';
import { TopFilterBar } from '../components/TopFilterBar';

export function Dashboard() {
  const [selected, setSelected] = useState<RequestRecord | null>(recentRequests[0]);
  const rankingRows = models.map((model) => ({
    label: model.model,
    provider: model.provider,
    value: Number(model.tokens.replace('M', '')),
    requests: model.requests.toLocaleString(),
    tokens: model.tokens,
    cost: `$${model.cost.toFixed(2)}`
  }));

  return (
    <>
      <TopFilterBar title="观测总览 Dashboard" subtitle="AI Agent、模型厂商、请求链路和工具调用的统一监控视图" />
      <div className="dashboard-grid with-drawer-space">
        <div className="metrics-grid">
          {metrics.map((metric) => <MetricCard key={metric.title} metric={metric} />)}
        </div>

        <Card title="请求趋势" subtitle="Request Trend" actions={<div className="tabs"><button>24h</button><button className="active">7d</button><button>30d</button><button>90d</button><button>All</button></div>} className="span-2">
          <div className="legend"><span className="blue-dot">总请求数</span><span className="green-dot">成功请求</span><span className="red-dot">失败请求</span></div>
          <MultiLineAreaChart data={requestTrend} />
        </Card>

        <Card title="Agent 健康度" subtitle="Health Distribution">
          <DonutChart />
        </Card>

        <Card title="模型与厂商消耗排名" subtitle="Models & Providers" actions={<div className="tabs"><button className="active">Token</button><button>Requests</button><button>Cost</button></div>}>
          <BarRanking rows={rankingRows} />
        </Card>

        <Card title="Token 分析" subtitle="Token Consumption" actions={<button className="mini-select">7d⌄</button>}>
          <div className="token-layout">
            <div>
              <div className="legend"><span className="blue-dot">Prompt Tokens</span><span className="purple-dot">Completion Tokens</span></div>
              <TokenStackChart data={requestTrend} />
            </div>
            <div className="token-stats">
              <span>总 Token 成本</span>
              <strong>$112.47</strong>
              <em>↑ 21.2% vs 7d 前</em>
              <hr />
              <span>平均每请求 Token 数</span>
              <strong>334</strong>
              <em>↑ 12.6% vs 7d 前</em>
            </div>
          </div>
        </Card>

        <Card title="最近请求" subtitle="Recent Requests" actions={<button className="text-link">查看全部 →</button>} className="span-3">
          <div className="activity-table">
            <div className="activity-head"><span>状态</span><span>Agent</span><span>Model</span><span>Provider</span><span>延迟</span><span>Tokens</span><span>Cost</span><span>时间</span><span /></div>
            {recentRequests.slice(0, 5).map((row) => (
              <button className={`activity-row ${selected?.id === row.id ? 'selected' : ''}`} key={row.id} onClick={() => setSelected(row)}>
                <StatusBadge status={row.status} />
                <span>{row.agent}</span>
                <span>{row.model}</span>
                <span>{row.provider}</span>
                <span className={row.status === 'failed' ? 'text-danger' : ''}>{row.latency}</span>
                <span>{row.tokens.toLocaleString()}</span>
                <span>${row.cost.toFixed(4)}</span>
                <span>{row.relativeTime}</span>
                <span>›</span>
              </button>
            ))}
          </div>
        </Card>
      </div>
      <RequestDetailDrawer request={selected} onClose={() => setSelected(null)} />
    </>
  );
}
