import { getDashboardSummary, getDashboardTrend } from '../api/evalApi';
import { useEvalData } from '../hooks/useEvalData';
import { Card } from '../components/Card';
import { MetricCard } from '../components/MetricCard';
import { DonutChart, SmallBars } from '../components/Charts';
import { DataSourceBadge, EmptyState, ErrorBanner, levelClass, levelIcon, LoadingBlock } from '../components/EvalShared';
import type { Metric } from '../types';

const levelLabel: Record<string, string> = { high: '高危', medium: '中危', low: '低危' };

function AlertRow({ alert }: { alert: { level: string; message: string; timestamp: string } }) {
  return (
    <div className="alert-row">
      <span className={`alert-level ${levelClass[alert.level] ?? ''}`}>{levelIcon[alert.level] ?? '⚪'}</span>
      <div className="alert-body">
        <strong>{alert.message}</strong>
        <span>{levelLabel[alert.level] ?? alert.level}</span>
      </div>
      <span className="alert-time">{alert.timestamp}</span>
    </div>
  );
}

function EvalHistoryRow({ item }: { item: { id: string; dimension: string; score: number; status: string; timestamp: string } }) {
  return (
    <div className="eval-history-row">
      <div className="eval-history-main">
        <strong>{item.dimension} · {item.score}分</strong>
        <span>{item.timestamp}</span>
      </div>
      <b>{item.score}</b>
      <span className={`status-badge ${item.status === 'ok' ? 'status-success' : 'status-warning'}`}>{item.status === 'ok' ? '通过' : '警告'}</span>
    </div>
  );
}

export function EvalDashboard() {
  const summary = useEvalData(() => getDashboardSummary(7), []);
  const trend = useEvalData(() => getDashboardTrend(7), []);

  const s = summary.data;
  const metrics: Metric[] = s ? [
    { title: '综合健康分', value: `${Math.round(s.healthScore)}/100`, delta: s.healthScore >= 80 ? '良好' : '需关注', trend: s.healthScore >= 80 ? 'up' : 'bad', icon: '❤', accent: 'blue', data: [72, 75, 78, 80, 82, 84, s.healthScore] },
    { title: '任务完成率', value: `${(s.taskCompletionRate * 100).toFixed(1)}%`, delta: '基于真实任务', trend: 'up', icon: '✓', accent: 'green', data: [76, 78, 80, 81, 83, 84, s.taskCompletionRate * 100] },
    { title: '安全评分', value: `${Math.round(s.securityScore)}/100`, delta: s.securityScore >= 80 ? '良好' : '需关注', trend: s.securityScore >= 80 ? 'up' : 'bad', icon: '🔒', accent: 'red', data: [82, 80, 79, 78, 76, 74, s.securityScore] },
    { title: '平均响应延迟', value: `${(s.avgLatencyMs / 1000).toFixed(1)}s`, delta: '全 Agent 平均', trend: 'up', icon: '◷', accent: 'cyan', data: [3.4, 3.3, 3.2, 3.1, 3.0, 2.9, s.avgLatencyMs / 1000] },
    { title: '工具成功率', value: `${(s.toolSuccessRate * 100).toFixed(1)}%`, delta: '全部工具', trend: 'up', icon: '⚒', accent: 'purple', data: [94, 95, 95, 96, 96, 96, s.toolSuccessRate * 100] },
    { title: '活跃 Agent', value: String(s.activeAgents), delta: '当前在线', trend: 'up', icon: '♙', accent: 'orange', data: [8, 9, 9, 10, 10, 11, s.activeAgents] }
  ] : [];

  const donutSegments = s ? [
    { label: '业务', value: Math.round(s.dimensionScores?.business ?? 0), percent: Math.round(s.dimensionScores?.business ?? 0), color: 'var(--green)', dot: 'success' },
    { label: '性能', value: Math.round(s.dimensionScores?.performance ?? 0), percent: Math.round(s.dimensionScores?.performance ?? 0), color: 'var(--blue)', dot: 'warning' },
    { label: '安全', value: Math.round(s.dimensionScores?.security ?? 0), percent: Math.round(s.dimensionScores?.security ?? 0), color: 'var(--red)', dot: 'failed' }
  ] : undefined;

  return (
    <>
      <header className="topbar">
        <div className="page-title">
          <h1>健康总览 Eval Dashboard</h1>
          <p>EvoFlow 整体健康度与核心指标总览</p>
        </div>
        <div className="filter-row">
          <DataSourceBadge source={summary.dataSource} />
        </div>
      </header>

      {summary.error && <ErrorBanner message={summary.error} onRetry={summary.reload} />}

      {summary.loading ? (
        <LoadingBlock rows={3} />
      ) : (
        <div className="dashboard-grid">
          <div className="metrics-grid eval-metrics">
            {metrics.map((metric) => <MetricCard key={metric.title} metric={metric} />)}
          </div>

          <Card title="健康度趋势" subtitle="各维度健康得分" className="span-2">
            {trend.loading ? <LoadingBlock rows={1} className="" /> : (
              <SmallBars rows={(trend.data?.series ?? []).slice(-4).map((p) => ({
                label: p.date,
                value: Math.round(p.healthScore),
                sub: `业务 ${Math.round(p.business)} · 性能 ${Math.round(p.performance)}`
              }))} />
            )}
          </Card>

          <Card title="维度得分分布" subtitle="Dimension Scores">
            <DonutChart
              centerValue={s ? String(Math.round(s.healthScore)) : '—'}
              centerLabel="健康分"
              segments={donutSegments}
            />
          </Card>

          <Card title="关键告警" subtitle="Critical Alerts" className="span-3">
            <div className="alert-list">
              {(s?.alerts ?? []).length === 0 ? <EmptyState title="暂无告警" hint="当前无关键告警" /> : (s?.alerts ?? []).map((alert) => <AlertRow key={`${alert.level}-${alert.message}`} alert={alert} />)}
            </div>
          </Card>

          <Card title="Agent 表现排行 TOP" subtitle="Agent Ranking">
            <div className="mini-ranking">
              {(s?.agentsRanking ?? []).map((agent, i) => (
                <div className="mini-ranking-row" key={agent.agent}>
                  <b>{i + 1}</b>
                  <span>{agent.agent}</span>
                  <div className="mini-ranking-bar"><i style={{ width: `${(agent.completionRate || 0) * 100}%` }} /></div>
                  <em>{((agent.completionRate || 0) * 100).toFixed(0)}%</em>
                </div>
              ))}
              {(s?.agentsRanking ?? []).length === 0 && <EmptyState title="暂无排行数据" />}
            </div>
          </Card>

          <Card title="最近评测记录" subtitle="Recent Evaluations">
            <div className="eval-history-list">
              {(s?.recentEvaluations ?? []).slice(0, 5).map((item) => <EvalHistoryRow key={item.id} item={item} />)}
              {(s?.recentEvaluations ?? []).length === 0 && <EmptyState title="暂无评测记录" />}
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
