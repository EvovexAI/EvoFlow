import { useState } from 'react'
import { evalApi } from '../api/evalApi'
import { useAsync } from '../hooks/useAsync'

type Tab = 'scenarios' | 'tasks' | 'tools' | 'knowledge' | 'intervention'

export function BusinessPage() {
  const [tab, setTab] = useState<Tab>('scenarios')
  const scenarios = useAsync(() => evalApi.businessScenarios(), [])
  const tasks = useAsync(() => evalApi.businessTasks(7), [])
  const tools = useAsync(() => evalApi.businessTools(7), [])
  const knowledge = useAsync(() => evalApi.businessKnowledge(7), [])
  const intervention = useAsync(() => evalApi.businessIntervention(7), [])

  const tabs: { id: Tab; label: string }[] = [
    { id: 'scenarios', label: '业务场景' },
    { id: 'tasks', label: '任务质量' },
    { id: 'tools', label: '工具可靠性' },
    { id: 'knowledge', label: '知识库' },
    { id: 'intervention', label: '人工介入' },
  ]

  return (
    <>
      <header className="eval-topbar">
        <div>
          <h1>业务质量</h1>
          <p>场景回归结果与观测指标</p>
        </div>
      </header>

      <div className="eval-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`eval-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'scenarios' && (
        <div className="eval-card">
          <h3>
            场景通过率{' '}
            {scenarios.data?.pass_rate != null
              ? `${(Number(scenarios.data.pass_rate) * 100).toFixed(0)}%`
              : '—'}
          </h3>
          {scenarios.error ? <div className="eval-error">{scenarios.error}</div> : null}
          <p className="eval-muted" style={{ marginBottom: 10 }}>
            这里是<strong>最近一次场景 run 的执行结果</strong>（不是用例定义）。
            要看全部案例清单请打开左侧「用例库」；要看断言证据请打开「评测历史 → 详情」。
            {scenarios.data?.run_id ? (
              <>
                {' '}
                当前结果来自 <code>{scenarios.data.run_id}</code>
              </>
            ) : null}
          </p>
          {(scenarios.data?.results || []).length === 0 ? (
            <p className="eval-muted">尚无场景结果。请在总览页执行「一键评测」，或到「用例库」确认 Gateway 已连上。</p>
          ) : (
            <table className="eval-table">
              <thead>
                <tr>
                  <th>场景</th>
                  <th>状态</th>
                  <th>分数</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                {(scenarios.data?.results || []).map((r: any) => (
                  <tr key={r.case_id}>
                    <td>{r.case_name || r.case_id}</td>
                    <td>
                      <span className={`eval-badge ${r.status === 'passed' ? 'ok' : 'fail'}`}>{r.status}</span>
                    </td>
                    <td>{r.score ?? '—'}</td>
                    <td>
                      <div className="eval-assert">{r.detail || ''}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'tasks' && (
        <div className="eval-card">
          {tasks.error ? <div className="eval-error">{tasks.error}</div> : null}
          <pre className="eval-muted" style={{ whiteSpace: 'pre-wrap' }}>
            {JSON.stringify(tasks.data, null, 2)}
          </pre>
        </div>
      )}
      {tab === 'tools' && (
        <div className="eval-card">
          {tools.error ? <div className="eval-error">{tools.error}</div> : null}
          <pre className="eval-muted" style={{ whiteSpace: 'pre-wrap' }}>
            {JSON.stringify(tools.data, null, 2)}
          </pre>
        </div>
      )}
      {tab === 'knowledge' && (
        <div className="eval-card">
          {knowledge.error ? <div className="eval-error">{knowledge.error}</div> : null}
          <pre className="eval-muted" style={{ whiteSpace: 'pre-wrap' }}>
            {JSON.stringify(knowledge.data, null, 2)}
          </pre>
        </div>
      )}
      {tab === 'intervention' && (
        <div className="eval-card">
          {intervention.error ? <div className="eval-error">{intervention.error}</div> : null}
          <pre className="eval-muted" style={{ whiteSpace: 'pre-wrap' }}>
            {JSON.stringify(intervention.data, null, 2)}
          </pre>
        </div>
      )}
    </>
  )
}
