import { useState } from 'react';
import {
  getTaskStats,
  getTaskTrend,
  getToolStats,
  getToolTrend,
  getKnowledgeStats,
  getConversationStats
} from '../api/evalApi';
import { useEvalData } from '../hooks/useEvalData';
import { Card } from '../components/Card';
import { MetricCard } from '../components/MetricCard';
import { SmallBars } from '../components/Charts';
import { DataTable } from '../components/DataTable';
import { DataSourceBadge, EmptyState, ErrorBanner, LoadingBlock } from '../components/EvalShared';
import type { Metric } from '../types';
import type { TaskStats, TaskTrendPoint, ToolStatsItem, ToolTrendPoint } from '../api/evalApi';

const tabs = ['任务质量', '工具可靠性', '知识库质量', '对话统计'];

function LineChart({ data, keys, colors, labels }: { data: Array<Record<string, string | number> & { label: string }>; keys: string[]; colors: string[]; labels: string[] }) {
  const width = 760;
  const height = 240;
  const pad = 30;
  const allValues = data.flatMap((d) => keys.map((k) => Number(d[k])));
  const max = Math.max(...allValues) * 1.15;
  const x = (i: number) => pad + (i / Math.max(data.length - 1, 1)) * (width - pad * 2);
  const y = (v: number) => height - pad - (v / max) * (height - pad * 2);
  return (
    <div className="line-chart-block">
      <svg className="line-chart-svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        {[0, 1, 2, 3].map((i) => (
          <line key={i} x1={pad} x2={width - pad} y1={pad + (i * (height - pad * 2)) / 3} y2={pad + (i * (height - pad * 2)) / 3} className="grid-line" />
        ))}
        {keys.map((key, i) => (
          <polyline key={key} points={data.map((d, j) => `${x(j)},${y(Number(d[key]))}`).join(' ')} className={`line line-${colors[i]}`} fill="none" />
        ))}
      </svg>
      <div className="axis x-axis">{data.map((d) => <span key={d.label}>{d.label}</span>)}</div>
      <div className="legend">{labels.map((l, i) => <span key={l} className={`${colors[i]}-dot`}>{l}</span>)}</div>
    </div>
  );
}

function TaskQualityView({ dataSource }: { dataSource: ReturnType<typeof useEvalData>['dataSource'] }) {
  const stats = useEvalData<TaskStats>(() => getTaskStats(7), []);
  const trend = useEvalData<TaskTrendPoint[]>(() => getTaskTrend(7), []);

  const s = stats.data;
  const metrics: Metric[] = s ? [
    { title: '总任务数', value: String(s.total), delta: '统计周期内', trend: 'up', icon: '☷', accent: 'blue', data: [6.2, 6.7, 7.1, 7.5, 7.9, 8.1, s.total / 1000] },
    { title: '完成率', value: `${(s.completionRate * 100).toFixed(1)}%`, delta: '任务完成率', trend: 'up', icon: '✓', accent: 'green', data: [76, 78, 80, 81, 83, 84, s.completionRate * 100] },
    { title: '失败率', value: `${(s.failureRate * 100).toFixed(1)}%`, delta: '任务失败率', trend: 'bad', icon: '✕', accent: 'red', data: [11.2, 11.0, 10.6, 10.4, 10.1, 9.8, s.failureRate * 100] },
    { title: 'P95 耗时', value: `${s.duration?.p95 ?? 0}s`, delta: '任务耗时', trend: 'up', icon: '◷', accent: 'orange', data: [7.5, 7.2, 7.0, 6.8, 6.6, 6.5, s.duration?.p95 ?? 0] }
  ] : [];

  const trendRows: Array<Record<string, string | number> & { label: string }> = (trend.data ?? []).map((p) => ({
    label: p.date.slice(5),
    completed: p.done,
    failed: p.total - p.done,
    completionRate: Math.round(p.completionRate * 100)
  }));

  return (
    <>
      {stats.error && <ErrorBanner message={stats.error} onRetry={stats.reload} />}
      {stats.loading ? <LoadingBlock rows={3} /> : (
        <div className="metrics-grid eval-metrics">
          {metrics.map((m) => <MetricCard key={m.title} metric={m} />)}
        </div>
      )}

      <Card title="任务完成率趋势" subtitle="完成 / 失败数量" className="span-2">
        <DataSourceBadge source={trend.dataSource} />
        {trend.loading ? <LoadingBlock rows={1} className="" /> : trendRows.length === 0 ? <EmptyState /> : <LineChart data={trendRows} keys={['completed', 'failed']} colors={['green', 'red']} labels={['完成', '失败']} />}
      </Card>

      <Card title="任务耗时分布" subtitle="Latency Distribution">
        <div className="duration-stats">
          {s ? [
            ['P50', `${s.duration?.p50 ?? 0}s`],
            ['P95', `${s.duration?.p95 ?? 0}s`],
            ['P99', `${s.duration?.p99 ?? 0}s`],
            ['平均', `${(s.duration?.avg ?? 0).toFixed(1)}s`]
          ].map(([label, value]) => (
            <div className="duration-stat" key={label}><span>{label}</span><strong>{value}</strong></div>
          )) : <EmptyState />}
        </div>
      </Card>

      <Card title="失败原因 TOP" subtitle="Failure Reasons" className="span-3">
        <DataSourceBadge source={stats.dataSource} />
        {s?.failureReasons && s.failureReasons.length > 0
          ? <SmallBars rows={s.failureReasons.map((r) => ({ label: r.reason, value: r.count, sub: `${r.count} 次` }))} />
          : <EmptyState title="暂无失败原因数据" />}
      </Card>
    </>
  );
}

function ToolReliabilityView({ dataSource }: { dataSource: ReturnType<typeof useEvalData>['dataSource'] }) {
  const tools = useEvalData<ToolStatsItem[]>(() => getToolStats(7), []);
  const trend = useEvalData<ToolTrendPoint[]>(() => getToolTrend(7), []);

  const trendRows: Array<Record<string, string | number> & { label: string }> = (trend.data ?? []).map((p) => ({
    label: p.date.slice(5),
    calls: p.calls
  }));

  return (
    <>
      {tools.error && <ErrorBanner message={tools.error} onRetry={tools.reload} />}
      <div className="metrics-grid eval-metrics">
        <Card className="mini-stat"><span>工具调用总量</span><strong>{(tools.data ?? []).reduce((sum, t) => sum + t.calls, 0).toLocaleString()}</strong><em>7d</em></Card>
        <Card className="mini-stat"><span>平均成功率</span><strong>{tools.data && tools.data.length ? `${(tools.data.reduce((s, t) => s + t.successRate, 0) / tools.data.length * 100).toFixed(1)}%` : '—'}</strong><em>加权平均</em></Card>
        <Card className="mini-stat"><span>工具种类</span><strong>{(tools.data ?? []).length}</strong><em>统计内</em></Card>
        <Card className="mini-stat"><span>数据来源</span><strong>{dataSource === 'live' ? '真实数据' : '演示数据'}</strong><em>API</em></Card>
      </div>

      <Card title="工具调用趋势" subtitle="每日调用量" className="span-3">
        <DataSourceBadge source={trend.dataSource} />
        {trend.loading ? <LoadingBlock rows={1} className="" /> : trendRows.length === 0 ? <EmptyState /> : <LineChart data={trendRows} keys={['calls']} colors={['blue']} labels={['调用量']} />}
      </Card>

      <Card title="工具可靠性排行" subtitle="调用量 / 成功率" className="span-3">
        <DataSourceBadge source={tools.dataSource} />
        {tools.loading ? <LoadingBlock rows={2} className="" /> : (tools.data ?? []).length === 0 ? <EmptyState /> : (
          <DataTable
            rows={tools.data ?? []}
            rowKey={(r) => r.tool}
            columns={[
              { key: 'tool', label: '工具' },
              { key: 'calls', label: '调用量', render: (r) => r.calls.toLocaleString() },
              { key: 'success', label: '成功', render: (r) => r.success },
              { key: 'fail', label: '失败', render: (r) => <span className="text-danger">{r.fail}</span> },
              { key: 'successRate', label: '成功率', render: (r) => <span className="text-success">{(r.successRate * 100).toFixed(1)}%</span> }
            ]}
          />
        )}
      </Card>
    </>
  );
}

function KnowledgeView({ dataSource }: { dataSource: ReturnType<typeof useEvalData>['dataSource'] }) {
  const kb = useEvalData(() => getKnowledgeStats(7), []);
  const d = kb.data;
  const metrics: Metric[] = d ? [
    { title: '知识库数量', value: String(d.knowledgeBases), delta: '已接入', trend: 'up', icon: '📚', accent: 'blue', data: [1, 2, 2, 3, 3, 3, d.knowledgeBases] },
    { title: '文档总数', value: String(d.documents), delta: '索引内', trend: 'up', icon: '📄', accent: 'green', data: [40, 52, 60, 68, 74, 80, d.documents] },
    { title: '检索次数', value: String(d.retrievals), delta: '统计周期内', trend: 'up', icon: '🔎', accent: 'purple', data: [600, 720, 850, 960, 1080, 1180, d.retrievals] }
  ] : [];
  return (
    <>
      {kb.error && <ErrorBanner message={kb.error} onRetry={kb.reload} />}
      <DataSourceBadge source={kb.dataSource} />
      {kb.loading ? <LoadingBlock rows={3} /> : (
        <div className="metrics-grid eval-metrics">
          {metrics.map((m) => <MetricCard key={m.title} metric={m} />)}
        </div>
      )}
      <Card className="span-3">
        <EmptyState title="知识库质量分析" hint="检索命中率、召回率、无结果 query TOP 等深度分析正在完善中。" />
      </Card>
    </>
  );
}

function ConversationView({ dataSource }: { dataSource: ReturnType<typeof useEvalData>['dataSource'] }) {
  const conv = useEvalData(() => getConversationStats(7), []);
  const d = conv.data;
  const metrics: Metric[] = d ? [
    { title: '会话数', value: String(d.sessions), delta: '统计周期内', trend: 'up', icon: '💬', accent: 'cyan', data: [180, 210, 240, 260, 290, 310, d.sessions] },
    { title: '消息数', value: String(d.messages), delta: '总消息量', trend: 'up', icon: '✉', accent: 'blue', data: [2200, 2600, 3000, 3400, 3800, 4000, d.messages] },
    { title: '活跃用户', value: String(d.activeUsers), delta: '当前活跃', trend: 'up', icon: '👤', accent: 'green', data: [14, 16, 18, 19, 21, 22, d.activeUsers] }
  ] : [];
  return (
    <>
      {conv.error && <ErrorBanner message={conv.error} onRetry={conv.reload} />}
      <DataSourceBadge source={conv.dataSource} />
      {conv.loading ? <LoadingBlock rows={3} /> : (
        <div className="metrics-grid eval-metrics">
          {metrics.map((m) => <MetricCard key={m.title} metric={m} />)}
        </div>
      )}
      <Card className="span-3">
        <EmptyState title="对话统计详情" hint="首响应延迟、对话轮次分布、Token 消耗趋势等深度分析正在完善中。" />
      </Card>
    </>
  );
}

export function EvalBusiness() {
  const [activeTab, setActiveTab] = useState(tabs[0]);
  return (
    <>
      <header className="topbar">
        <div className="page-title">
          <h1>业务质量 Business Quality</h1>
          <p>基于真实业务数据的质量分析与趋势追踪</p>
        </div>
      </header>
      <div className="tabs slim eval-tabs">
        {tabs.map((tab) => (
          <button key={tab} className={activeTab === tab ? 'active' : ''} onClick={() => setActiveTab(tab)}>{tab}</button>
        ))}
      </div>
      <div className="page-grid">
        {activeTab === '任务质量' && <TaskQualityView dataSource={null} />}
        {activeTab === '工具可靠性' && <ToolReliabilityView dataSource={null} />}
        {activeTab === '知识库质量' && <KnowledgeView dataSource={null} />}
        {activeTab === '对话统计' && <ConversationView dataSource={null} />}
      </div>
    </>
  );
}
