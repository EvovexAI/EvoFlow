import type { TimePoint } from '../types';
import { numberCompact } from '../utils/format';

function scalePoints(data: number[], width: number, height: number, padding = 10) {
  const min = Math.min(0, ...data);
  const max = Math.max(...data);
  const range = Math.max(max - min, 1);
  return data.map((value, index) => {
    const x = padding + (index / Math.max(data.length - 1, 1)) * (width - padding * 2);
    const y = height - padding - ((value - min) / range) * (height - padding * 2);
    return { x, y, value };
  });
}

function toPolyline(points: Array<{ x: number; y: number }>) {
  return points.map((p) => `${p.x},${p.y}`).join(' ');
}

export function MultiLineAreaChart({ data }: { data: TimePoint[] }) {
  const width = 800;
  const height = 260;
  const total = scalePoints(data.map((d) => d.total), width, height, 24);
  const success = scalePoints(data.map((d) => d.success), width, height, 24);
  const failed = scalePoints(data.map((d) => d.failed), width, height, 24);
  const area = `24,${height - 24} ${toPolyline(total)} ${width - 24},${height - 24}`;
  const yTicks = [0, 5000, 10000, 15000, 20000, 25000];

  return (
    <div className="chart-wrap">
      <svg className="big-chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="blueFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="rgba(52, 117, 255, .38)" />
            <stop offset="1" stopColor="rgba(52, 117, 255, 0)" />
          </linearGradient>
        </defs>
        {yTicks.map((_, index) => (
          <line key={index} x1="24" x2={width - 24} y1={24 + index * 38} y2={24 + index * 38} className="grid-line" />
        ))}
        <polygon points={area} fill="url(#blueFill)" />
        <polyline points={toPolyline(total)} className="line line-blue" />
        <polyline points={toPolyline(success)} className="line line-green" />
        <polyline points={toPolyline(failed)} className="line line-red dashed" />
      </svg>
      <div className="axis x-axis">{data.map((d) => <span key={d.label}>{d.label}</span>)}</div>
      <div className="axis y-axis">{yTicks.slice().reverse().map((tick) => <span key={tick}>{numberCompact(tick)}</span>)}</div>
    </div>
  );
}

export function TokenStackChart({ data }: { data: TimePoint[] }) {
  const width = 560;
  const height = 250;
  const prompt = data.map((d) => d.prompt ?? 0);
  const completion = data.map((d) => (d.prompt ?? 0) + (d.completion ?? 0));
  const promptPts = scalePoints(prompt, width, height, 22);
  const completionPts = scalePoints(completion, width, height, 22);
  const promptArea = `22,${height - 22} ${toPolyline(promptPts)} ${width - 22},${height - 22}`;
  const completionArea = `22,${height - 22} ${toPolyline(completionPts)} ${width - 22},${height - 22}`;

  return (
    <div className="token-chart">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="promptFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="rgba(43, 112, 255, .44)" />
            <stop offset="1" stopColor="rgba(43, 112, 255, 0)" />
          </linearGradient>
          <linearGradient id="completionFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="rgba(156, 70, 255, .46)" />
            <stop offset="1" stopColor="rgba(156, 70, 255, 0)" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3, 4].map((line) => <line key={line} x1="22" x2={width - 22} y1={28 + line * 42} y2={28 + line * 42} className="grid-line" />)}
        <polygon points={completionArea} fill="url(#completionFill)" />
        <polygon points={promptArea} fill="url(#promptFill)" />
        <polyline points={toPolyline(completionPts)} className="line line-purple" />
        <polyline points={toPolyline(promptPts)} className="line line-blue" />
      </svg>
      <div className="axis x-axis">{data.map((d) => <span key={d.label}>{d.label}</span>)}</div>
    </div>
  );
}

export function DonutChart({
  segments,
  centerValue,
  centerLabel
}: {
  segments?: Array<{ label: string; value: number; percent: number; color: string; dot: string }>;
  centerValue?: string;
  centerLabel?: string;
}) {
  const defaultSegments = [
    { label: 'Normal', value: 132, percent: 82, color: 'var(--green)', dot: 'success' },
    { label: 'Warning', value: 18, percent: 11, color: 'var(--warning)', dot: 'warning' },
    { label: 'Error', value: 7, percent: 6, color: 'var(--red)', dot: 'failed' }
  ];
  const segs = segments ?? defaultSegments;
  const value = centerValue ?? '95%';
  const label = centerLabel ?? 'Healthy';
  const conic = segs.map((s, index) => {
    const start = segs.slice(0, index).reduce((sum, prev) => sum + prev.percent, 0);
    return `${s.color} ${start}% ${start + s.percent}%`;
  }).join(', ');

  return (
    <div className="donut-block">
      <div className="donut" style={{ background: `conic-gradient(${conic})` }} aria-label={`${label} ${value}`}>
        <div className="donut-center"><strong>{value}</strong><span>{label}</span></div>
      </div>
      <div className="donut-legend">
        {segs.map((segment) => (
          <span key={segment.label}><i className={`dot ${segment.dot}`} />{segment.label} <strong>{segment.value}</strong> <em>({segment.percent}%)</em></span>
        ))}
      </div>
    </div>
  );
}

export function BarRanking({
  rows,
  valueKey = 'tokens'
}: {
  rows: Array<{ label: string; provider?: string; requests?: string | number; tokens?: string | number; cost?: string | number; value: number }>;
  valueKey?: 'tokens' | 'requests' | 'cost';
}) {
  const max = Math.max(...rows.map((row) => row.value));
  return (
    <div className="ranking-table">
      <div className="ranking-head"><span>排名</span><span>Requests</span><span>Tokens</span><span>Cost</span></div>
      {rows.map((row, index) => (
        <div className="ranking-row" key={row.label}>
          <div className="ranking-name"><b>{index + 1}</b><span>{row.label}</span><em>{row.provider}</em></div>
          <div className="bar-cell"><i style={{ width: `${Math.max((row.value / max) * 100, 8)}%` }} /></div>
          <span>{row.requests}</span>
          <span>{row.tokens}</span>
          <span>{row.cost}</span>
        </div>
      ))}
    </div>
  );
}

export function SmallBars({ rows }: { rows: Array<{ label: string; value: number; sub?: string }> }) {
  const max = Math.max(...rows.map((r) => r.value));
  return (
    <div className="small-bars">
      {rows.map((row) => (
        <div className="small-bar-row" key={row.label}>
          <div><strong>{row.label}</strong>{row.sub && <span>{row.sub}</span>}</div>
          <div className="small-bar"><i style={{ width: `${(row.value / max) * 100}%` }} /></div>
          <b>{row.value.toLocaleString()}</b>
        </div>
      ))}
    </div>
  );
}
