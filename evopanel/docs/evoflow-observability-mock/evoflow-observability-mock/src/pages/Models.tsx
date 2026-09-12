import { models, providers } from '../data/mock';
import { Card } from '../components/Card';
import { BarRanking, SmallBars } from '../components/Charts';
import { DataTable } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { TopFilterBar } from '../components/TopFilterBar';

export function Models() {
  const rankingRows = models.map((model) => ({
    label: model.model,
    provider: model.provider,
    value: model.cost,
    requests: model.requests.toLocaleString(),
    tokens: model.tokens,
    cost: `$${model.cost.toFixed(2)}`
  }));
  return (
    <>
      <TopFilterBar title="模型与厂商 Models" subtitle="模型使用量、Provider 表现、成本、错误率和延迟分析" />
      <div className="page-grid">
        {providers.map((provider) => (
          <Card key={provider.name} className="provider-card">
            <div className="provider-head"><h3>{provider.name}</h3><StatusBadge status={provider.status} /></div>
            <div className="provider-grid">
              <span>Requests <strong>{provider.requests.toLocaleString()}</strong></span>
              <span>Success <strong>{provider.successRate}%</strong></span>
              <span>Latency <strong>{provider.avgLatency}</strong></span>
              <span>Tokens <strong>{provider.tokens}</strong></span>
              <span>Cost <strong>${provider.cost.toFixed(2)}</strong></span>
              <span>Errors <strong>{provider.errors}</strong></span>
            </div>
          </Card>
        ))}

        <Card title="模型消耗排名" subtitle="按成本 / Token / 请求数排序" actions={<div className="tabs"><button>Token</button><button>Requests</button><button className="active">Cost</button></div>} className="span-2">
          <BarRanking rows={rankingRows} />
        </Card>
        <Card title="Provider 请求分布" subtitle="Requests by provider">
          <SmallBars rows={providers.map((provider) => ({ label: provider.name, value: provider.requests, sub: `$${provider.cost.toFixed(2)}` }))} />
        </Card>
        <Card title="模型明细表" subtitle="Model Detail Table" className="span-3">
          <DataTable
            rows={models}
            rowKey={(row) => row.model}
            columns={[
              { key: 'model', label: 'Model' },
              { key: 'provider', label: 'Provider' },
              { key: 'requests', label: 'Requests', render: (row) => row.requests.toLocaleString() },
              { key: 'successRate', label: 'Success', render: (row) => `${row.successRate}%` },
              { key: 'avgLatency', label: 'Avg Latency' },
              { key: 'p95Latency', label: 'P95' },
              { key: 'promptTokens', label: 'Prompt' },
              { key: 'completionTokens', label: 'Completion' },
              { key: 'tokens', label: 'Total Tokens' },
              { key: 'cost', label: 'Cost', render: (row) => `$${row.cost.toFixed(2)}` },
              { key: 'errorRate', label: 'Error Rate', render: (row) => `${row.errorRate}%` },
              { key: 'mainAgents', label: 'Main Agents', render: (row) => row.mainAgents.join(', ') }
            ]}
          />
        </Card>
      </div>
    </>
  );
}
