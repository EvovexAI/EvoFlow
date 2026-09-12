import { toolCalls, tools } from '../data/mock';
import { Card } from '../components/Card';
import { SmallBars } from '../components/Charts';
import { DataTable } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { TopFilterBar } from '../components/TopFilterBar';

export function Tools() {
  const total = tools.reduce((sum, tool) => sum + tool.requests, 0);
  return (
    <>
      <TopFilterBar title="工具调用 Tools" subtitle="工具调用记录追踪、频率统计、耗时分析和失败率监控" />
      <div className="page-grid">
        <Card className="mini-stat"><span>工具调用总数</span><strong>{total.toLocaleString()}</strong><em>7d</em></Card>
        <Card className="mini-stat"><span>成功率</span><strong>97.8%</strong><em>加权平均</em></Card>
        <Card className="mini-stat"><span>平均耗时</span><strong>783ms</strong><em>全部工具</em></Card>
        <Card className="mini-stat"><span>最慢工具</span><strong>code_interpreter</strong><em>P95 7.1s</em></Card>

        <Card title="工具使用频率 Top" subtitle="Tool Usage Frequency" className="span-2">
          <SmallBars rows={tools.map((tool) => ({ label: tool.name, value: tool.requests, sub: tool.category }))} />
        </Card>
        <Card title="工具失败率" subtitle="Failure Rate">
          <SmallBars rows={tools.map((tool) => ({ label: tool.name, value: Math.round(tool.failureRate * 100), sub: `${tool.failureRate}%` }))} />
        </Card>

        <Card title="工具调用记录" subtitle="Tool Call Records" className="span-3">
          <DataTable
            rows={toolCalls}
            rowKey={(row) => row.id}
            columns={[
              { key: 'time', label: 'Time' },
              { key: 'toolName', label: 'Tool' },
              { key: 'agent', label: 'Agent' },
              { key: 'requestId', label: 'Request ID' },
              { key: 'traceId', label: 'Trace ID' },
              { key: 'status', label: 'Status', render: (row) => <StatusBadge status={row.status} /> },
              { key: 'latency', label: 'Latency' },
              { key: 'input', label: 'Input' },
              { key: 'output', label: 'Output' },
              { key: 'error', label: 'Error', render: (row) => row.error ?? '—' }
            ]}
          />
        </Card>
      </div>
    </>
  );
}
