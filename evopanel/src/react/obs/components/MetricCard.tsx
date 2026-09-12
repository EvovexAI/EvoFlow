import type { Metric } from '../types';
import { Sparkline } from './Sparkline';

export function MetricCard({ metric }: { metric: Metric }) {
  return (
    <div className={`metric-card accent-${metric.accent}`}>
      <div className="metric-top">
        <div className="metric-icon">{metric.icon}</div>
        <div>
          <div className="metric-title">{metric.title}</div>
          <div className="metric-value">{metric.value}</div>
        </div>
      </div>
      <div className={`metric-delta ${metric.trend === 'bad' ? 'bad' : metric.trend}`}>{metric.delta}</div>
      <Sparkline data={metric.data} accent={metric.accent} />
    </div>
  );
}
