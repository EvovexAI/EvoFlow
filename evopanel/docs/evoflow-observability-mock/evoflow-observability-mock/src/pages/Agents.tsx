import { agents } from '../data/mock';
import { Card } from '../components/Card';
import { DataTable } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { TopFilterBar } from '../components/TopFilterBar';

export function Agents() {
  const activeAgents = agents.filter((a) => a.status !== 'error').length;
  return (
    <>
      <TopFilterBar title="Agent 管理 Agents" subtitle="Agent 健康状态、请求表现、模型和工具使用情况" />
      <div className="page-grid">
        <Card className="mini-stat"><span>Agent 总数</span><strong>{agents.length}</strong><em>已注册</em></Card>
        <Card className="mini-stat"><span>活跃 Agent</span><strong>{activeAgents}</strong><em>最近 7 天</em></Card>
        <Card className="mini-stat"><span>异常 Agent</span><strong>{agents.length - activeAgents}</strong><em>需要处理</em></Card>
        <Card className="mini-stat"><span>平均成功率</span><strong>97.3%</strong><em>加权平均</em></Card>

        <div className="agent-cards span-3">
          {agents.map((agent) => (
            <Card key={agent.name} className="agent-card">
              <div className="agent-card-head"><h3>{agent.name}</h3><StatusBadge status={agent.status} /></div>
              <div className="agent-metrics">
                <span>请求数 <strong>{agent.requests.toLocaleString()}</strong></span>
                <span>成功率 <strong>{agent.successRate}%</strong></span>
                <span>平均耗时 <strong>{agent.avgLatency}</strong></span>
                <span>Token <strong>{agent.tokens}</strong></span>
                <span>主模型 <strong>{agent.mainModel}</strong></span>
                <span>工具调用 <strong>{agent.tools.toLocaleString()}</strong></span>
              </div>
              <div className="card-button-row"><button>查看请求</button><button>查看 Trace</button><button>查看工具</button></div>
            </Card>
          ))}
        </div>

        <Card title="Agent 明细" subtitle="Agent Performance Table" className="span-3">
          <DataTable
            rows={agents}
            rowKey={(row) => row.name}
            columns={[
              { key: 'name', label: 'Agent' },
              { key: 'status', label: 'Status', render: (row) => <StatusBadge status={row.status} /> },
              { key: 'requests', label: 'Requests', render: (row) => row.requests.toLocaleString() },
              { key: 'successRate', label: 'Success Rate', render: (row) => `${row.successRate}%` },
              { key: 'avgLatency', label: 'Avg Latency' },
              { key: 'tokens', label: 'Tokens' },
              { key: 'mainModel', label: 'Main Model' },
              { key: 'tools', label: 'Tools', render: (row) => row.tools.toLocaleString() },
              { key: 'owner', label: 'Owner' }
            ]}
          />
        </Card>
      </div>
    </>
  );
}
