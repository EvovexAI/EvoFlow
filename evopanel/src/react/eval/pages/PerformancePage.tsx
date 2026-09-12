import { evalApi } from '../api/evalApi'
import { useAsync } from '../hooks/useAsync'

export function PerformancePage() {
  const summary = useAsync(() => evalApi.performanceSummary(7), [])
  const latency = useAsync(() => evalApi.performanceLatency(7), [])
  const errors = useAsync(() => evalApi.performanceErrors(7), [])

  return (
    <>
      <header className="eval-topbar">
        <div>
          <h1>性能基准</h1>
          <p>延迟分布与错误率（压测引擎未接入）</p>
        </div>
      </header>
      {summary.error ? <div className="eval-error">{summary.error}</div> : null}
      <div className="eval-card">
        <h3>性能摘要</h3>
        <pre className="eval-muted" style={{ whiteSpace: 'pre-wrap' }}>
          {JSON.stringify(summary.data, null, 2)}
        </pre>
      </div>
      <div className="eval-grid-2">
        <div className="eval-card">
          <h3>延迟分布</h3>
          <pre className="eval-muted" style={{ whiteSpace: 'pre-wrap' }}>
            {JSON.stringify(latency.data, null, 2)}
          </pre>
        </div>
        <div className="eval-card">
          <h3>错误统计</h3>
          <pre className="eval-muted" style={{ whiteSpace: 'pre-wrap' }}>
            {JSON.stringify(errors.data, null, 2)}
          </pre>
        </div>
      </div>
    </>
  )
}
