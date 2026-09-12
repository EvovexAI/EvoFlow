import { useState } from 'react';
import {
  getPerformanceSummary,
  getLatencyDistribution,
  getLatencyTrend,
  getModuleBreakdown,
  getVersionCompare,
  runLoadTest
} from '../api/evalApi';
import { useEvalData } from '../hooks/useEvalData';
import { Card } from '../components/Card';
import { MetricCard } from '../components/MetricCard';
import { DataSourceBadge, EmptyState, ErrorBanner, LoadingBlock, Modal } from '../components/EvalShared';
import type { LatencyBucket, LatencyTrendPoint, Metric, ModuleLatency, VersionCompareItem } from '../types';

const tabs = ['对话响应', '工具延迟', '知识库检索', '并发压测'];

/* 直方图 */
function Histogram({ buckets }: { buckets: LatencyBucket[] }) {
  const max = Math.max(...buckets.map((b) => b.count), 1);
  return (
    <div className="histogram">
      <div className="histogram-bars">
        {buckets.map((b) => (
          <div className="histogram-col" key={b.label} title={`${b.label}: ${b.count}`}>
            <div className="histogram-bar" style={{ height: `${(b.count / max) * 100}%` }} />
            <span>{b.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* 延迟趋势折线（P50/P95/P99 三条线） */
function LatencyLine({ data }: { data: LatencyTrendPoint[] }) {
  const width = 760;
  const height = 240;
  const pad = 30;
  const all = data.flatMap((d) => [d.p50, d.p95, d.p99]);
  const max = Math.max(...all) * 1.15;
  const x = (i: number) => pad + (i / Math.max(data.length - 1, 1)) * (width - pad * 2);
  const y = (v: number) => height - pad - (v / max) * (height - pad * 2);
  const line = (key: keyof LatencyTrendPoint, color: string) => (
    <polyline
      key={key}
      points={data.map((d, i) => `${x(i)},${y(Number(d[key]))}`).join(' ')}
      className={`line line-${color}`}
      fill="none"
    />
  );
  return (
    <div className="line-chart-block">
      <svg className="line-chart-svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        {[0, 1, 2, 3].map((i) => (
          <line key={i} x1={pad} x2={width - pad} y1={pad + (i * (height - pad * 2)) / 3} y2={pad + (i * (height - pad * 2)) / 3} className="grid-line" />
        ))}
        {line('p99', 'red')}
        {line('p95', 'purple')}
        {line('p50', 'blue')}
      </svg>
      <div className="axis x-axis">{data.map((d) => <span key={d.label}>{d.label}</span>)}</div>
      <div className="legend">
        <span className="blue-dot">P50</span>
        <span className="purple-dot">P95</span>
        <span className="red-dot">P99</span>
      </div>
    </div>
  );
}

/* 各模块延迟对比条形图 */
function ModuleBar({ modules }: { modules: ModuleLatency[] }) {
  const max = Math.max(...modules.map((m) => m.latency), 1);
  return (
    <div className="small-bars">
      {modules.map((m) => (
        <div className="small-bar-row" key={m.module}>
          <div><strong>{m.module}</strong><span>P95 {m.p95}s</span></div>
          <div className="small-bar"><i style={{ width: `${(m.latency / max) * 100}%` }} /></div>
          <b>{m.latency}s</b>
        </div>
      ))}
    </div>
  );
}

/* 版本性能对比卡片 */
function VersionCompare({ versions }: { versions: VersionCompareItem[] }) {
  return (
    <div className="version-compare">
      {versions.map((v) => (
        <div className={`version-row ${v.delta < 0 ? 'improved' : v.delta > 0 ? 'regressed' : ''}`} key={v.version}>
          <strong>{v.version}</strong>
          <span>P95: {v.p95}s</span>
          <em>{v.delta === 0 ? '基准' : v.delta < 0 ? `↓${Math.abs(v.delta)}s 优化` : `↑${v.delta}s 退化`}</em>
        </div>
      ))}
    </div>
  );
}

function LoadTestModal({ onClose, onStart }: { onClose: () => void; onStart: (config: Record<string, unknown>) => void }) {
  const [type, setType] = useState('真实流量回放');
  const [concurrency, setConcurrency] = useState(20);
  const [samples, setSamples] = useState(500);
  const [duration, setDuration] = useState('5 分钟');
  return (
    <Modal
      title="压测任务配置"
      onClose={onClose}
      footer={
        <>
          <button className="ghost-btn" onClick={onClose}>取消</button>
          <button className="primary-btn" onClick={() => onStart({ type, concurrency, samples, duration })}>开始压测 ▶</button>
        </>
      }
    >
      <div className="form-grid">
        <label>压测类型
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option>真实流量回放</option>
            <option>合成流量</option>
          </select>
        </label>
        <label>并发数
          <select value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))}>
            {[5, 10, 20, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label>样本量
          <select value={samples} onChange={(e) => setSamples(Number(e.target.value))}>
            {[100, 500, 1000, 5000].map((n) => <option key={n} value={n}>{n} 条</option>)}
          </select>
        </label>
        <label>压测时长
          <select value={duration} onChange={(e) => setDuration(e.target.value)}>
            <option>5 分钟</option>
            <option>15 分钟</option>
            <option>30 分钟</option>
          </select>
        </label>
      </div>
    </Modal>
  );
}

function PerformanceView({
  tab,
  dataSource,
  triggerReload
}: {
  tab: string;
  dataSource: ReturnType<typeof useEvalData>['dataSource'];
  triggerReload: () => void;
}) {
  const dist = useEvalData<LatencyBucket[]>(() => getLatencyDistribution(7), []);
  const trend = useEvalData<LatencyTrendPoint[]>(() => getLatencyTrend(7), []);
  const modules = useEvalData<ModuleLatency[]>(() => getModuleBreakdown(7), []);
  const versions = useEvalData<VersionCompareItem[]>(() => getVersionCompare(), []);

  if (tab !== '对话响应') {
    return (
      <Card className="span-3">
        <EmptyState title={`${tab} 模块`} hint="该模块的数据分析正在完善中，敬请期待。" />
      </Card>
    );
  }

  return (
    <>
      <Card title="响应延迟分布" subtitle="Latency Distribution (直方图)" className="span-2">
        <DataSourceBadge source={dist.dataSource} />
        {dist.loading ? <LoadingBlock rows={1} className="" /> : <Histogram buckets={dist.data ?? []} />}
      </Card>

      <Card title="版本性能对比" subtitle="Version Compare">
        {versions.loading ? <LoadingBlock rows={2} className="" /> : <VersionCompare versions={versions.data ?? []} />}
      </Card>

      <Card title="延迟趋势" subtitle="P50 / P95 / P99" className="span-3">
        <DataSourceBadge source={trend.dataSource} />
        {trend.loading ? <LoadingBlock rows={1} className="" /> : <LatencyLine data={trend.data ?? []} />}
      </Card>

      <Card title="各模块延迟对比" subtitle="Module Latency">
        {modules.loading ? <LoadingBlock rows={2} className="" /> : <ModuleBar modules={modules.data ?? []} />}
      </Card>

      <Card title="说明" subtitle="Benchmark Notes">
        <div className="benchmark-notes">
          <p>· 数据来自真实流量回放，P50/P95/P99 分别表示 50%/95%/99% 分位延迟。</p>
          <p>· 点击右上角「开始压测」可发起新的压测任务。</p>
          <p>· 版本对比展示最近三个版本的 P95 延迟变化。</p>
        </div>
      </Card>
    </>
  );
}

export function EvalPerformance() {
  const [activeTab, setActiveTab] = useState(tabs[0]);
  const [showLoadTest, setShowLoadTest] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  const summary = useEvalData(() => getPerformanceSummary(7), [reloadTick]);

  const metrics: Metric[] = summary.data ? [
    { title: 'P50 延迟', value: `${summary.data.p50}s`, delta: `${summary.data.p50Delta <= 0 ? '↓' : '↑'}${Math.abs(summary.data.p50Delta)}s`, trend: summary.data.p50Delta <= 0 ? 'up' : 'bad', icon: '◷', accent: 'blue', data: [1.6, 1.5, 1.4, 1.4, 1.3, 1.3, summary.data.p50] },
    { title: 'P95 延迟', value: `${summary.data.p95}s`, delta: `${summary.data.p95Delta <= 0 ? '↓' : '↑'}${Math.abs(summary.data.p95Delta)}s`, trend: summary.data.p95Delta <= 0 ? 'up' : 'bad', icon: '◷', accent: 'purple', data: [4.6, 4.4, 4.2, 4.1, 4.0, 3.9, summary.data.p95] },
    { title: 'P99 延迟', value: `${summary.data.p99}s`, delta: `${summary.data.p99Delta <= 0 ? '↓' : '↑'}${Math.abs(summary.data.p99Delta)}s`, trend: summary.data.p99Delta <= 0 ? 'up' : 'bad', icon: '◷', accent: 'orange', data: [10.2, 9.8, 9.5, 9.1, 8.9, 8.7, summary.data.p99] },
    { title: '峰值 QPS', value: String(summary.data.peakQps), delta: `↑${summary.data.qpsDelta}`, trend: 'up', icon: '⚡', accent: 'cyan', data: [30, 33, 35, 38, 40, 42, summary.data.peakQps] }
  ] : [];

  const handleStartLoadTest = async (config: Record<string, unknown>) => {
    await runLoadTest(config);
    setShowLoadTest(false);
    setReloadTick((t) => t + 1);
  };

  return (
    <>
      <header className="topbar">
        <div className="page-title">
          <h1>性能基准 Performance Benchmark</h1>
          <p>真实流量回放与性能基线对比</p>
        </div>
        <div className="filter-row">
          <DataSourceBadge source={summary.dataSource} />
          <span className="last-scan-text">最近测试：{summary.data?.lastTest ?? '—'}</span>
          <button className="filter-pill primary-btn" onClick={() => setShowLoadTest(true)}>
            <span>▶</span><strong>开始压测</strong>
          </button>
        </div>
      </header>

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
        <PerformanceView tab={activeTab} dataSource={summary.dataSource} triggerReload={() => setReloadTick((t) => t + 1)} />
      </div>

      {showLoadTest && <LoadTestModal onClose={() => setShowLoadTest(false)} onStart={handleStartLoadTest} />}
    </>
  );
}
