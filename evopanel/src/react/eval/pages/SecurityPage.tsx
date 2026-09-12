import { evalApi } from '../api/evalApi'
import { useAsync } from '../hooks/useAsync'

export function SecurityPage() {
  const summary = useAsync(() => evalApi.securitySummary(7), [])
  const vulns = useAsync(() => evalApi.securityVulns(), [])
  const leaks = useAsync(() => evalApi.securityLeaks(7), [])

  return (
    <>
      <header className="eval-topbar">
        <div>
          <h1>安全中心</h1>
          <p>配置漏洞、泄露扫描与权限审计</p>
        </div>
        <div className="eval-actions">
          <button
            type="button"
            className="eval-btn primary"
            onClick={async () => {
              await evalApi.securityScan()
              summary.reload()
              vulns.reload()
              leaks.reload()
            }}
          >
            立即扫描
          </button>
        </div>
      </header>
      {summary.error ? <div className="eval-error">{summary.error}</div> : null}
      <div className="eval-card">
        <h3>安全摘要</h3>
        <pre className="eval-muted" style={{ whiteSpace: 'pre-wrap' }}>
          {JSON.stringify(summary.data, null, 2)}
        </pre>
      </div>
      <div className="eval-grid-2">
        <div className="eval-card">
          <h3>漏洞</h3>
          <pre className="eval-muted" style={{ whiteSpace: 'pre-wrap' }}>
            {JSON.stringify(vulns.data, null, 2)}
          </pre>
        </div>
        <div className="eval-card">
          <h3>数据泄露</h3>
          <pre className="eval-muted" style={{ whiteSpace: 'pre-wrap' }}>
            {JSON.stringify(leaks.data, null, 2)}
          </pre>
        </div>
      </div>
    </>
  )
}
