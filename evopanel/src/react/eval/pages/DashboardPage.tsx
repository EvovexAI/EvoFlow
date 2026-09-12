import { useState } from 'react'
import { evalApi, pollRunUntilDone } from '../api/evalApi'
import { useAsync } from '../hooks/useAsync'

function Metric({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint?: string
  tone?: 'primary' | 'green' | 'accent'
}) {
  return (
    <div className="eval-metric">
      <div className="label">{label}</div>
      <div className={`value ${tone || ''}`}>{value}</div>
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  )
}

export function DashboardPage({ onNavigate }: { onNavigate?: (k: string) => void }) {
  const summary = useAsync(() => evalApi.dashboardSummary(7), [])
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [runMsg, setRunMsg] = useState('')

  const s = summary.data || {}
  const dim = s.dimensionScores || s.dimension_scores || {}
  const scenarioRate = s.scenarioPassRate ?? s.scenario_pass_rate
  const health = s.healthScore ?? s.health_score ?? 0
  const completion = s.taskCompletionRate ?? s.task_completion_rate ?? 0
  const toolOk = s.toolSuccessRate ?? s.tool_success_rate ?? 0
  const sec = s.securityScore ?? s.security_score ?? 0
  const latency = s.avgResponseLatencyMs ?? s.avg_response_latency_ms ?? 0
  const agents = s.activeAgents ?? s.active_agents ?? 0
  const alerts = s.alerts || []
  const ranking = s.agentsRanking || s.agents_ranking || []
  const recent = s.recentEvaluations || s.recent_evaluations || []
  const obs = s.observability || {}

  async function runSmoke() {
    setRunning(true)
    setProgress(0)
    setRunMsg('启动 smoke 评测…')
    try {
      const started = await evalApi.startRun({
        name: '一键评测 smoke',
        mode: 'smoke',
        async_mode: true,
      })
      const runId = started.run_id || started.runId
      if (!runId) throw new Error('未返回 run_id')
      const detail = await pollRunUntilDone(runId, (p) => {
        setProgress(Number(p.progress || 0))
        setRunMsg(`评测中 ${p.passed_cases || 0}/${p.total_cases || '?'} 通过`)
      })
      const st = detail?.run?.status || detail?.status || 'done'
      setRunMsg(`完成：${st}`)
      summary.reload()
      onNavigate?.('history')
    } catch (e: any) {
      setRunMsg(String(e?.message || e))
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <div className="eval-hero">
        <div>
          <h2>健康总览</h2>
          <p>先跑评测 → 再看「测什么 / 结果详情」三块信息</p>
        </div>
        <div className="eval-actions">
          <button type="button" className="eval-btn outline" onClick={() => summary.reload()} disabled={running}>
            刷新
          </button>
          <button type="button" className="eval-btn primary" onClick={runSmoke} disabled={running}>
            {running ? '评测中…' : '一键评测'}
          </button>
        </div>
      </div>

      <div className="eval-guide-row">
        <button type="button" className="eval-guide-card" onClick={() => onNavigate?.('employees')}>
          <strong>智能体员工评测</strong>
          <span>雇佣 / 派发 / 审批门 / L3 wake — 独立模块页</span>
        </button>
        <button type="button" className="eval-guide-card" onClick={() => onNavigate?.('workflow')}>
          <strong>工作流评测</strong>
          <span>DAG / 步骤绑定 / outcome / L3 真跑 — 独立模块页</span>
        </button>
        <button type="button" className="eval-guide-card" onClick={() => onNavigate?.('history')}>
          <strong>结果详情</strong>
          <span>展开入参 / 预期 / 实际 / API 步骤</span>
        </button>
      </div>

      {summary.error ? <div className="eval-error">{summary.error}</div> : null}
      {runMsg ? <div className="eval-muted" style={{ marginBottom: 8 }}>{runMsg}</div> : null}
      {progress !== null ? (
        <div className="eval-progress">
          <i style={{ width: `${progress}%` }} />
        </div>
      ) : null}

      {summary.loading && !summary.data ? (
        <p className="eval-muted">加载中…</p>
      ) : (
        <>
          <div className="eval-metrics">
            <Metric label="综合健康分" value={`${Math.round(Number(health))}/100`} tone="primary" />
            <Metric
              label="场景通过率"
              value={scenarioRate == null ? '—' : `${(Number(scenarioRate) * 100).toFixed(0)}%`}
              hint="最近 scenario run"
              tone="green"
            />
            <Metric label="任务完成率" value={`${(Number(completion) * 100).toFixed(1)}%`} />
            <Metric label="安全评分" value={`${Math.round(Number(sec))}/100`} />
            <Metric label="工具成功率" value={`${(Number(toolOk) * 100).toFixed(1)}%`} tone="green" />
            <Metric label="平均延迟" value={`${(Number(latency) / 1000).toFixed(1)}s`} />
            <Metric label="活跃 Agent" value={String(agents)} tone="primary" />
            <Metric
              label="Obs 线程健康"
              value={obs.thread_health != null ? String(Math.round(Number(obs.thread_health))) : '—'}
              hint={obs.invalid_tool_rate != null ? `invalid tool ${obs.invalid_tool_rate}` : undefined}
            />
          </div>

          <div className="eval-grid-2">
            <div className="eval-card">
              <h3>维度得分</h3>
              <table className="eval-table">
                <tbody>
                  {Object.entries(dim).map(([k, v]) => (
                    <tr key={k}>
                      <td>{k}</td>
                      <td>{Math.round(Number(v))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="eval-card">
              <h3>关键告警</h3>
              {alerts.length === 0 ? (
                <p className="eval-muted">暂无告警</p>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {alerts.map((a: any, i: number) => (
                    <li key={i} style={{ marginBottom: 6 }}>
                      <span className={`eval-badge ${a.level === 'error' ? 'fail' : 'warn'}`}>{a.level}</span>{' '}
                      {a.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="eval-grid-2">
            <div className="eval-card">
              <h3>Agent 排行</h3>
              {ranking.length === 0 ? (
                <p className="eval-muted">暂无排行数据</p>
              ) : (
                <table className="eval-table">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>任务</th>
                      <th>完成率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ranking.map((r: any) => (
                      <tr key={r.agent}>
                        <td>{r.agent}</td>
                        <td>{r.tasks}</td>
                        <td>{((r.completion_rate ?? r.completionRate ?? 0) * 100).toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="eval-card">
              <h3>最近评测</h3>
              {recent.length === 0 ? (
                <p className="eval-muted">尚无评测记录，点「一键评测」开始</p>
              ) : (
                <table className="eval-table">
                  <thead>
                    <tr>
                      <th>名称</th>
                      <th>分数</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((r: any) => (
                      <tr key={r.id}>
                        <td>{r.name || r.dimension}</td>
                        <td>{r.score}</td>
                        <td>
                          <span className={`eval-badge ${String(r.status).includes('fail') ? 'fail' : 'ok'}`}>
                            {r.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </>
  )
}
