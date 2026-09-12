import { useState } from 'react'
import { evalApi } from '../api/evalApi'
import { useAsync } from '../hooks/useAsync'

export function AlertPage() {
  const rules = useAsync(() => evalApi.alertRules(), [])
  const alerts = useAsync(() => evalApi.alerts(50), [])
  const [name, setName] = useState('场景通过率过低')
  const ruleList = Array.isArray(rules.data) ? rules.data : rules.data?.rules || []
  const alertList = alerts.data?.alerts || []

  return (
    <>
      <header className="eval-topbar">
        <div>
          <h1>告警配置</h1>
          <p>规则匹配后写入面板告警历史（本轮无飞书通道）</p>
        </div>
      </header>
      <div className="eval-card">
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ flex: 1, padding: 8, borderRadius: 8, border: '1px solid #2a3340', background: '#0f1419', color: '#fff' }}
          />
          <button
            type="button"
            className="eval-btn primary"
            onClick={async () => {
              await evalApi.createAlertRule({
                name,
                dimension: 'scenario',
                metric: 'scenario_pass_rate',
                operator: 'lt',
                threshold: 80,
                level: 'warn',
                channel: 'panel',
              })
              rules.reload()
            }}
          >
            新建规则
          </button>
        </div>
        <table className="eval-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>指标</th>
              <th>条件</th>
              <th>启用</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {ruleList.map((r: any) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>{r.metric}</td>
                <td>
                  {r.operator} {r.threshold}
                </td>
                <td>{r.enabled ? '是' : '否'}</td>
                <td>
                  <button
                    type="button"
                    className="eval-btn"
                    onClick={async () => {
                      await evalApi.toggleAlertRule(r.id)
                      rules.reload()
                    }}
                  >
                    切换
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="eval-card">
        <h3>告警历史</h3>
        {alertList.length === 0 ? (
          <p className="eval-muted">暂无触发记录</p>
        ) : (
          <table className="eval-table">
            <thead>
              <tr>
                <th>级别</th>
                <th>消息</th>
                <th>run</th>
              </tr>
            </thead>
            <tbody>
              {alertList.map((a: any) => (
                <tr key={a.id}>
                  <td>
                    <span className="eval-badge warn">{a.level}</span>
                  </td>
                  <td>{a.message}</td>
                  <td>{a.run_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
