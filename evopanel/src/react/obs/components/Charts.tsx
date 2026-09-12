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

export function ModelTrendChart({ data }: { data: TimePoint[] }) {
  const width = 800;
  const callsHeight = 168;
  const cacheHeight = 96;
  const height = callsHeight + cacheHeight;
  const padding = 24;
  const total = scalePoints(data.map((d) => d.total), width, callsHeight, padding);
  const success = scalePoints(data.map((d) => d.success), width, callsHeight, padding);
  const failed = scalePoints(data.map((d) => d.failed), width, callsHeight, padding);
  const area = `${padding},${callsHeight - padding} ${toPolyline(total)} ${width - padding},${callsHeight - padding}`;
  const callTicks = [0, 5000, 10000, 15000, 20000, 25000];

  const cacheReads = data.map((d) => d.cacheRead ?? 0);
  const cachePts = scalePoints(cacheReads, width, cacheHeight, padding);
  const cacheArea = `${padding},${height - padding} ${toPolyline(cachePts.map((p) => ({ x: p.x, y: callsHeight + p.y })))} ${width - padding},${height - padding}`;
  const cacheMax = Math.max(...cacheReads, 1);
  const cacheTicks = [0, cacheMax * 0.25, cacheMax * 0.5, cacheMax * 0.75, cacheMax].map((v) => Math.round(v));

  return (
    <div className="chart-wrap model-trend-chart">
      <svg className="big-chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="blueFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="rgba(52, 117, 255, .38)" />
            <stop offset="1" stopColor="rgba(52, 117, 255, 0)" />
          </linearGradient>
          <linearGradient id="cacheFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="rgba(34, 211, 238, .42)" />
            <stop offset="1" stopColor="rgba(34, 211, 238, 0)" />
          </linearGradient>
        </defs>
        {callTicks.map((_, index) => (
          <line key={`call-${index}`} x1={padding} x2={width - padding} y1={padding + index * 28} y2={padding + index * 28} className="grid-line" />
        ))}
        <polygon points={area} fill="url(#blueFill)" />
        <polyline points={toPolyline(total)} className="line line-blue" />
        <polyline points={toPolyline(success)} className="line line-green" />
        <polyline points={toPolyline(failed)} className="line line-red dashed" />
        <line x1={padding} x2={width - padding} y1={callsHeight} y2={callsHeight} className="grid-line chart-split" />
        {[0, 1, 2].map((index) => (
          <line
            key={`cache-${index}`}
            x1={padding}
            x2={width - padding}
            y1={callsHeight + padding + index * 22}
            y2={callsHeight + padding + index * 22}
            className="grid-line"
          />
        ))}
        <polygon points={cacheArea} fill="url(#cacheFill)" />
        <polyline
          points={toPolyline(cachePts.map((p) => ({ x: p.x, y: callsHeight + p.y })))}
          className="line line-cyan"
        />
      </svg>
      <div className="axis x-axis">{data.map((d) => <span key={d.label}>{d.label}</span>)}</div>
      <div className="axis y-axis y-axis-calls">{callTicks.slice().reverse().map((tick) => <span key={tick}>{numberCompact(tick)}</span>)}</div>
      <div className="axis y-axis y-axis-cache">
        {cacheTicks.slice().reverse().map((tick) => <span key={`c-${tick}`}>{numberCompact(tick)}</span>)}
      </div>
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

type DonutSegment = { label: string; value: number; percent: number; color: 'success' | 'warning' | 'failed' }

function donutGradient(segments: DonutSegment[]): string {
  let acc = 0
  const colorMap = { success: 'var(--green)', warning: 'var(--warning)', failed: 'var(--red)' }
  const stops = segments.map((segment) => {
    const start = acc
    acc += segment.percent
    return `${colorMap[segment.color]} ${start}% ${acc}%`
  })
  return `conic-gradient(${stops.join(', ')})`
}

export function DonutChart({ healthyPct, segments }: { healthyPct: number; segments: DonutSegment[] }) {
  return (
    <div className="donut-block">
      <div className="donut" style={{ background: donutGradient(segments) }} aria-label={`Agent 健康度 ${healthyPct}%`}>
        <div className="donut-center"><strong>{healthyPct}%</strong><span>Healthy</span></div>
      </div>
      <div className="donut-legend">
        {segments.map((segment) => (
          <span key={segment.label}>
            <i className={`dot ${segment.color === 'failed' ? 'failed' : segment.color}`} />
            {segment.label} <strong>{segment.value}</strong> <em>({segment.percent}%)</em>
          </span>
        ))}
      </div>
    </div>
  );
}

export function BarRanking({
  rows,
  // @ts-ignore
  valueKey = 'tokens'
}: {
  rows: Array<{
    label: string;
    provider?: string;
    requests?: string | number;
    tokens?: string | number;
    cacheRead?: string | number;
    cacheHitRate?: string | number;
    cost?: string | number;
    value: number;
  }>;
  valueKey?: 'tokens' | 'requests' | 'cost';
}) {
  const max = Math.max(...rows.map((row) => row.value));
  return (
    <div className="ranking-table">
      <div className="ranking-head"><span>排名</span><span /><span>调用数</span><span>Token</span><span>命中率</span><span>省钱</span></div>
      {rows.map((row, index) => (
        <div className="ranking-row" key={row.label}>
          <div className="ranking-name"><b>{index + 1}</b><span>{row.label}</span><em>{row.provider}</em></div>
          <div className="bar-cell"><i style={{ width: `${Math.max((row.value / max) * 100, 8)}%` }} /></div>
          <span>{row.requests}</span>
          <span>{row.tokens}</span>
          <span className="obs-cache-stat">{row.cacheHitRate ?? '—'}</span>
          <span>{row.cost}</span>
        </div>
      ))}
    </div>
  );
}

export function SmallBars({ rows, barColor }: { rows: Array<{ label: string; value: number; sub?: string }>; barColor?: string }) {
  const max = Math.max(...rows.map((r) => r.value));
  return (
    <div className="small-bars">
      {rows.map((row) => (
        <div className="small-bar-row" key={row.label}>
          <div><strong>{row.label}</strong>{row.sub && <span>{row.sub}</span>}</div>
          <div className="small-bar"><i style={{ width: `${(row.value / max) * 100}%`, background: barColor }} /></div>
          <b>{row.value.toLocaleString()}</b>
        </div>
      ))}
    </div>
  );
}

export function PaletteDonut({
  centerLabel,
  centerValue,
  segments,
}: {
  centerLabel: string
  centerValue: string
  segments: Array<{ label: string; value: number; percent: number; color: string }>
}) {
  if (!segments.length) {
    return <div className="obs-empty-state">暂无数据</div>
  }
  const stops = segments.reduce((acc, segment) => {
    const start = acc.offset
    acc.offset += segment.percent
    acc.stops.push(`${segment.color} ${start}% ${acc.offset}%`)
    return acc
  }, { offset: 0, stops: [] as string[] }).stops
  return (
    <div className="donut-layout">
      <div
        className="donut"
        style={{ background: `conic-gradient(${stops.join(', ')})` }}
        aria-label={`${centerLabel} ${centerValue}`}
      >
        <div className="donut-center">
          <strong>{centerValue}</strong>
          <span>{centerLabel}</span>
        </div>
      </div>
      <div className="donut-legend">
        {segments.map((segment) => (
          <div key={segment.label}>
            <span className="dot" style={{ background: segment.color }} />
            {segment.label} {segment.value.toLocaleString()} ({segment.percent}%)
          </div>
        ))}
      </div>
    </div>
  )
}