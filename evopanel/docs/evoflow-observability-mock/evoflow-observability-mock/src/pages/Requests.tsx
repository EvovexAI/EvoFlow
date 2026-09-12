import { useState } from 'react';
import { recentRequests } from '../data/mock';
import type { RequestRecord } from '../types';
import { Card } from '../components/Card';
import { DataTable } from '../components/DataTable';
import { RequestDetailDrawer } from '../components/RequestDetailDrawer';
import { StatusBadge } from '../components/StatusBadge';
import { TopFilterBar } from '../components/TopFilterBar';

export function Requests() {
  const [selected, setSelected] = useState<RequestRecord | null>(null);
  return (
    <>
      <TopFilterBar title="请求日志 Requests" subtitle="全量模型请求记录、筛选、搜索、导出和详情查看" />
      <div className="page-grid with-drawer-space">
        <Card title="搜索与筛选" subtitle="Search by request_id / thread_id / run_id / agent / model" className="span-3">
          <div className="filter-panel">
            <input placeholder="搜索 request_id / thread_id / run_id / agent / model" />
            <button>状态：全部⌄</button>
            <button>耗时：全部⌄</button>
            <button>Token：全部⌄</button>
            <button className="primary">导出 CSV</button>
          </div>
        </Card>
        <Card title="请求记录" subtitle="Request Records" className="span-3">
          <DataTable<RequestRecord>
            rows={recentRequests}
            rowKey={(row) => row.id}
            onRowClick={setSelected}
            columns={[
              { key: 'status', label: 'Status', render: (row) => <StatusBadge status={row.status} /> },
              { key: 'time', label: 'Time' },
              { key: 'agent', label: 'Agent' },
              { key: 'model', label: 'Model' },
              { key: 'provider', label: 'Provider' },
              { key: 'latency', label: 'Latency', render: (row) => <span className={row.status === 'failed' ? 'text-danger' : ''}>{row.latency}</span> },
              { key: 'tokens', label: 'Tokens', render: (row) => row.tokens.toLocaleString() },
              { key: 'cost', label: 'Cost', render: (row) => `$${row.cost.toFixed(4)}` },
              { key: 'threadId', label: 'Thread' },
              { key: 'stage', label: 'Stage' },
              { key: 'error', label: 'Error', render: (row) => row.error ?? '—' }
            ]}
          />
        </Card>
      </div>
      <RequestDetailDrawer request={selected} onClose={() => setSelected(null)} />
    </>
  );
}
