import { useState } from 'react';
import {
  getSecuritySummary,
  getPermissionMatrix,
  getDataLeaks,
  getVulnerabilities,
  getAuditStats,
  runSecurityScan
} from '../api/evalApi';
import { useEvalData } from '../hooks/useEvalData';
import { Card } from '../components/Card';
import { MetricCard } from '../components/MetricCard';
import { DataTable } from '../components/DataTable';
import { DataSourceBadge, EmptyState, ErrorBanner, levelClass, levelIcon, levelLabel, LoadingBlock } from '../components/EvalShared';
import type { Metric, PermissionMatrix, Vulnerability, VulnStatus } from '../types';

const tabs = ['越权检测', '注入防护', '数据泄露', '沙箱安全', '密钥扫描'];

const statusLabel: Record<VulnStatus, string> = {
  pending: '待修复',
  processing: '处理中',
  resolved: '已修复',
  ignored: '已忽略'
};

const statusClass: Record<VulnStatus, string> = {
  pending: 'status-warning',
  processing: 'status-warning',
  resolved: 'status-success',
  ignored: 'status-normal'
};

function LevelBadge({ level }: { level: string }) {
  return (
    <span className={`vuln-level ${levelClass[level] ?? ''}`}>
      {levelIcon[level] ?? '🔵'} {levelLabel[level] ?? level}
    </span>
  );
}

function VulnStatusBadge({ status }: { status: VulnStatus }) {
  return <span className={`status-badge ${statusClass[status]}`}>{statusLabel[status]}</span>;
}

function PermissionMatrixCard({ matrix }: { matrix: PermissionMatrix | null }) {
  if (!matrix) return <EmptyState hint="暂无权限矩阵快照" />;
  return (
    <div className="permission-matrix">
      <table>
        <thead>
          <tr>
            <th>角色 \ 权限</th>
            {matrix.actions.map((a) => <th key={a}>{a}</th>)}
          </tr>
        </thead>
        <tbody>
          {matrix.roles.map((role) => (
            <tr key={role}>
              <td><strong>{role}</strong></td>
              {matrix.actions.map((action) => {
                const v = matrix.matrix[role]?.[action];
                return (
                  <td key={action}>
                    <span className={`perm-${v}`}>
                      {v === 'allow' ? '✅' : v === 'deny' ? '❌' : '⚠️'}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RiskDistribution({ vulnerabilities }: { vulnerabilities: Vulnerability[] }) {
  const groups = ['high', 'medium', 'low'].map((level) => ({
    level,
    count: vulnerabilities.filter((v) => v.level === level).length
  }));
  const total = vulnerabilities.length || 1;
  return (
    <div className="risk-distribution">
      {groups.map((g) => (
        <div className="risk-item" key={g.level}>
          <span className={`risk-dot ${levelClass[g.level]}`}>{levelIcon[g.level]}</span>
          <span className="risk-label">{levelLabel[g.level]}</span>
          <strong>{g.count}</strong>
          <em>({Math.round((g.count / total) * 100)}%)</em>
        </div>
      ))}
    </div>
  );
}

function Timeline({ events }: { events: Array<{ id: string; level: string; message: string; time: string }> }) {
  return (
    <div className="security-timeline">
      {events.map((e) => (
        <div className={`timeline-item ${levelClass[e.level] ?? ''}`} key={e.id}>
          <span className="timeline-dot">{levelIcon[e.level] ?? '🔵'}</span>
          <div>
            <p>{e.message}</p>
            <span>{e.time}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function VulnTable({ rows }: { rows: Vulnerability[] }) {
  return (
    <DataTable
      rows={rows}
      rowKey={(r) => r.id}
      columns={[
        { key: 'level', label: '级别', render: (r) => <LevelBadge level={r.level} /> },
        { key: 'name', label: '漏洞名称' },
        { key: 'scope', label: '影响范围' },
        { key: 'foundAt', label: '发现时间' },
        { key: 'status', label: '状态', render: (r) => <VulnStatusBadge status={r.status} /> },
        { key: 'op', label: '操作', render: () => <span className="text-link">详情</span> }
      ]}
    />
  );
}

function SecurityTabView({
  category,
  dataSource
}: {
  category: string;
  dataSource: ReturnType<typeof useEvalData>['dataSource'];
}) {
  const vulns = useEvalData<Vulnerability[]>(() => getVulnerabilities({ limit: 50 }), []);
  const leaks = useEvalData<Array<{ id: string; type: string; severity: string; source: string; description: string; foundAt: string; status: VulnStatus }>>(() => getDataLeaks(30), []);
  const matrix = useEvalData(() => getPermissionMatrix(), []);

  const rawRows = category === '数据泄露'
    ? (leaks.data ?? []).map((l) => ({
        id: l.id,
        level: l.severity as Vulnerability['level'],
        name: l.type,
        scope: l.source,
        foundAt: l.foundAt,
        status: l.status,
        category: '数据泄露'
      }))
    : (vulns.data ?? []).filter((v) => v.category === category);
  const rows: Vulnerability[] = rawRows;

  return (
    <>
      <Card title="风险等级分布" subtitle="Risk Distribution" className="span-2">
        {vulns.loading ? <LoadingBlock rows={1} className="" /> : <RiskDistribution vulnerabilities={vulns.data ?? []} />}
      </Card>

      <Card title="最近安全事件" subtitle="Security Timeline">
        <Timeline events={[
          { id: 'e1', level: 'high', message: '发现知识库横向越权漏洞', time: '14:30' },
          { id: 'e2', level: 'medium', message: 'Prompt 注入防护触发告警', time: '10:15' },
          { id: 'e3', level: 'info', message: '日度安全扫描完成', time: '09:00' },
          { id: 'e4', level: 'high', message: '检测到沙箱逃逸尝试', time: '昨天' }
        ]} />
      </Card>

      <Card title="漏洞列表" subtitle={`${category}检测结果`} className="span-3">
        <div className="card-actions-row">
          <DataSourceBadge source={dataSource} />
        </div>
        {rows.length === 0 ? <EmptyState title="暂无漏洞" hint="该分类下暂未发现风险项" /> : <VulnTable rows={rows} />}
      </Card>

      {category === '越权检测' && (
        <Card title="权限矩阵快照" subtitle="Permission Matrix" className="span-3">
          <PermissionMatrixCard matrix={matrix.data ?? null} />
        </Card>
      )}
    </>
  );
}

export function EvalSecurity() {
  const [activeTab, setActiveTab] = useState(tabs[0]);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);

  const summary = useEvalData(() => getSecuritySummary(30), []);
  const audit = useEvalData(() => getAuditStats(30), []);

  const metrics: Metric[] = summary.data ? [
    { title: '安全评分', value: `${summary.data.score}/100`, delta: `↓${summary.data.score >= 80 ? '需关注' : '较低'}`, trend: 'bad', icon: '🔒', accent: 'red', data: [80, 78, 76, 75, 74, 73, summary.data.score] },
    { title: '高危漏洞', value: String(summary.data.highVulns), delta: `↑${summary.data.highNew} 新增`, trend: 'bad', icon: '⚠️', accent: 'orange', data: [0, 0, 1, 1, 1, 2, summary.data.highVulns] },
    { title: '待修复项', value: String(summary.data.pendingFixes), delta: `↑${summary.data.pendingNew} 新增`, trend: 'bad', icon: '🛠', accent: 'cyan', data: [8, 9, 10, 11, 13, 14, summary.data.pendingFixes] }
  ] : [];

  const handleScan = async () => {
    setScanning(true);
    setScanMsg(null);
    try {
      const res = await runSecurityScan();
      setScanMsg(res.dataSource === 'demo' ? '扫描已触发（演示模式）' : '扫描已触发');
      summary.reload();
      audit.reload();
    } catch {
      setScanMsg('扫描触发失败，请稍后重试');
    } finally {
      setScanning(false);
    }
  };

  return (
    <>
      <header className="topbar">
        <div className="page-title">
          <h1>安全中心 Security Center</h1>
          <p>权限安全、数据安全、注入防护的统一检测与管理</p>
        </div>
        <div className="filter-row">
          <DataSourceBadge source={summary.dataSource} />
          <span className="last-scan-text">上次扫描：{summary.data?.lastScan ?? '—'}</span>
          <button className="filter-pill primary-btn" onClick={handleScan} disabled={scanning}>
            <span>{scanning ? '⏳' : '▶'}</span><strong>{scanning ? '扫描中...' : '开始扫描'}</strong>
          </button>
        </div>
      </header>

      {scanMsg && <div className="scan-msg">{scanMsg}</div>}
      {summary.error && <ErrorBanner message={summary.error} onRetry={summary.reload} />}

      {summary.loading ? (
        <LoadingBlock rows={3} />
      ) : (
        <div className="metrics-grid eval-metrics">
          {metrics.map((m) => <MetricCard key={m.title} metric={m} />)}
        </div>
      )}

      <div className="tabs slim eval-tabs">
        {tabs.map((tab) => (
          <button key={tab} className={activeTab === tab ? 'active' : ''} onClick={() => setActiveTab(tab)}>{tab}</button>
        ))}
      </div>

      <div className="page-grid">
        <SecurityTabView category={activeTab} dataSource={summary.dataSource} />
      </div>
    </>
  );
}
