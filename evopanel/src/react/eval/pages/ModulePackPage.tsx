/**
 * Shared pack page for one eval module (employees / workflow / …).
 * Lists cases, runs selected case_ids, shows filtered run results.
 */
import { useMemo, useState } from 'react'
import { evalApi, pollRunUntilDone } from '../api/evalApi'
import { useAsync } from '../hooks/useAsync'

const FLOW_LABELS: Record<string, string> = {
  happy: '基本流',
  alt: '备选流',
  negative: '异常流',
  boundary: '边界值',
  state_machine: '状态机',
}

const COVERAGE_LABELS: Record<string, string> = {
  implemented: '已覆盖',
  partial: '部分',
  planned: '规划中',
}

const DIM_LABELS: Record<string, string> = {
  flow: '流转',
  state: '状态',
  retry: '重试',
  safety: '安全',
  isolation: '隔离',
  outcome: '产出',
}

function caseModule(c: any): string {
  return c.module || c.params?.module || ''
}

function caseDesign(c: any): any {
  return c.design || c.params?.design || {}
}

function isRunnable(c: any): boolean {
  return Boolean(c?.handler) && c.enabled !== false
}

export type ModulePackPageProps = {
  moduleKey: string
  title: string
  subtitle: string
  onNavigate?: (k: string) => void
}

export function ModulePackPage({ moduleKey, title, subtitle, onNavigate }: ModulePackPageProps) {
  const casesQ = useAsync(() => evalApi.cases('scenario'), [])
  const archQ = useAsync(() => evalApi.architecture(moduleKey), [moduleKey])
  const runsQ = useAsync(() => evalApi.runs(12), [])
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [level, setLevel] = useState<'all' | 'L1' | 'L2' | 'L3'>('all')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [runMsg, setRunMsg] = useState('')
  const [lastResults, setLastResults] = useState<any[] | null>(null)

  const packCases = useMemo(() => {
    const raw = casesQ.data
    const all = (Array.isArray(raw) ? raw : raw?.cases || []) as any[]
    return all.filter((c) => caseModule(c) === moduleKey)
  }, [casesQ.data, moduleKey])

  const filtered = useMemo(() => {
    return packCases.filter((c) => {
      if (level === 'all') return true
      return String(c.level || 'L1').toUpperCase() === level
    })
  }, [packCases, level])

  const selectedIds = useMemo(() => {
    const ids = filtered.filter((c) => selected[c.id]).map((c) => c.id)
    if (ids.length) return ids
    return filtered.filter(isRunnable).map((c) => c.id)
  }, [filtered, selected])

  const ledgerCount = filtered.filter((c) => String(c.level || '').toUpperCase() !== 'L3').length
  const liveCount = filtered.filter((c) => String(c.level || '').toUpperCase() === 'L3').length

  const arch = archQ.data && !Array.isArray(archQ.data?.packs) ? archQ.data : null
  const stages = (arch?.stages || []) as any[]
  const capabilities = (arch?.capabilities || []) as any[]
  const cov = arch?.coverage_counts || {}

  function toggle(id: string) {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  function selectRunnable(pred: (c: any) => boolean) {
    const next: Record<string, boolean> = {}
    for (const c of filtered) {
      if (isRunnable(c) && pred(c)) next[c.id] = true
    }
    setSelected(next)
  }

  function selectByCaseIds(ids: string[]) {
    const set = new Set(ids)
    const next: Record<string, boolean> = {}
    for (const c of filtered) {
      if (isRunnable(c) && set.has(c.id)) next[c.id] = true
    }
    setSelected(next)
  }

  async function runPack(modeLabel: string, ids: string[]) {
    if (!ids.length) {
      setRunMsg('没有可跑用例（请确认 Gateway 已连上且用例已启用）')
      return
    }
    setRunning(true)
    setProgress(0)
    setRunMsg(`启动 ${modeLabel}（${ids.length} 条）…`)
    setLastResults(null)
    try {
      const started = await evalApi.startRun({
        name: `${title} · ${modeLabel}`,
        mode: 'scenario',
        type: 'scenario',
        case_ids: ids,
        async_mode: true,
        config: { mode: 'scenario', module: moduleKey },
      })
      const runId = started.run_id || started.runId
      if (!runId) throw new Error('未返回 run_id')
      const detail = await pollRunUntilDone(runId, (p) => {
        setProgress(Number(p.progress || 0))
        setRunMsg(`评测中 ${p.passed_cases || 0}/${p.total_cases || ids.length} 通过`)
      })
      const results = (detail?.results || detail?.run?.results || []) as any[]
      const mine = results.filter((r) => {
        const cid = String(r.case_id || r.id || '')
        return ids.includes(cid) || caseModule(r) === moduleKey
      })
      setLastResults(mine.length ? mine : results)
      const st = detail?.run?.status || detail?.status || 'done'
      setRunMsg(`完成：${st}`)
      runsQ.reload()
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
          <h2>{title}</h2>
          <p>{subtitle}</p>
          {arch?.principle ? <p className="eval-muted">{arch.principle}</p> : null}
        </div>
        <div className="eval-actions">
          <button type="button" className="eval-btn outline" onClick={() => { casesQ.reload(); archQ.reload() }} disabled={running}>
            刷新用例
          </button>
          <button
            type="button"
            className="eval-btn outline"
            disabled={running}
            onClick={() =>
              runPack(
                '账本包',
                filtered.filter((c) => isRunnable(c) && String(c.level || '').toUpperCase() !== 'L3').map((c) => c.id),
              )
            }
          >
            跑账本（无 LLM）
          </button>
          <button
            type="button"
            className="eval-btn primary"
            disabled={running}
            onClick={() => runPack('本模块选中', selectedIds)}
          >
            {running ? '评测中…' : `跑选中（${selectedIds.length}）`}
          </button>
        </div>
      </div>

      <div className="eval-metrics">
        <div className="eval-metric">
          <div className="label">本模块用例</div>
          <div className="value primary">{packCases.length}</div>
          <div className="hint">筛选后 {filtered.length}</div>
        </div>
        <div className="eval-metric">
          <div className="label">账本 / L1–L2</div>
          <div className="value">{ledgerCount}</div>
          <div className="hint">确定性对账</div>
        </div>
        <div className="eval-metric">
          <div className="label">L3 真跑</div>
          <div className="value accent">{liveCount}</div>
          <div className="hint">需 EVOFLOW_EVAL_LIVE_LLM=1</div>
        </div>
        <div className="eval-metric">
          <div className="label">体系能力</div>
          <div className="value">{cov.implemented ?? '—'}/{arch?.capability_total ?? '—'}</div>
          <div className="hint">
            已覆盖 · 部分 {cov.partial ?? 0} · 规划 {cov.planned ?? 0}
          </div>
        </div>
      </div>

      {casesQ.error ? <div className="eval-error">{casesQ.error}</div> : null}
      {archQ.error ? <div className="eval-error">体系矩阵：{archQ.error}</div> : null}
      {runMsg ? <div className="eval-muted" style={{ marginBottom: 8 }}>{runMsg}</div> : null}
      {progress !== null ? (
        <div className="eval-progress">
          <i style={{ width: `${progress}%` }} />
        </div>
      ) : null}

      {stages.length || capabilities.length ? (
        <div className="eval-card">
          <h3>评测体系 · 阶段与能力</h3>
          {stages.length ? (
            <div className="eval-tabs" style={{ flexWrap: 'wrap' }}>
              {stages.map((s: any) => (
                <span key={s.id} className="eval-badge run" title={s.summary || ''}>
                  {s.title}
                </span>
              ))}
            </div>
          ) : null}
          {capabilities.length ? (
            <table className="eval-table" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>能力</th>
                  <th>维度</th>
                  <th>阶段</th>
                  <th>覆盖</th>
                  <th>用例</th>
                </tr>
              </thead>
              <tbody>
                {capabilities.map((cap: any) => (
                  <tr key={cap.id}>
                    <td>
                      <strong>{cap.title}</strong>
                      <div className="eval-muted">{cap.description || cap.risk || ''}</div>
                    </td>
                    <td>
                      <span className="eval-badge">{DIM_LABELS[cap.dimension] || cap.dimension}</span>
                    </td>
                    <td className="eval-muted">{cap.stage}</td>
                    <td>
                      <span
                        className={`eval-badge ${
                          cap.coverage === 'implemented' ? 'ok' : cap.coverage === 'partial' ? 'run' : ''
                        }`}
                      >
                        {COVERAGE_LABELS[cap.coverage] || cap.coverage}
                      </span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="eval-btn outline"
                        disabled={running || !(cap.case_ids || []).length}
                        onClick={() => selectByCaseIds(cap.case_ids || [])}
                        title="选中该能力绑定的用例"
                      >
                        {(cap.case_ids || []).length} 条
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}

      <div className="eval-card">
        <h3>筛选与选择</h3>
        <div className="eval-tabs">
          {(['all', 'L1', 'L2', 'L3'] as const).map((id) => (
            <button
              key={id}
              type="button"
              className={`eval-tab ${level === id ? 'active' : ''}`}
              onClick={() => setLevel(id)}
            >
              {id === 'all' ? '全部层级' : id}
            </button>
          ))}
        </div>
        <div className="eval-actions" style={{ marginTop: 8 }}>
          <button type="button" className="eval-btn outline" onClick={() => selectRunnable(() => true)}>
            全选可跑
          </button>
          <button
            type="button"
            className="eval-btn outline"
            onClick={() => selectRunnable((c) => String(c.level || '').toUpperCase() !== 'L3')}
          >
            仅账本
          </button>
          <button
            type="button"
            className="eval-btn outline"
            onClick={() => selectRunnable((c) => String(c.level || '').toUpperCase() === 'L3')}
          >
            仅 L3
          </button>
          <button type="button" className="eval-btn outline" onClick={() => setSelected({})}>
            清空（默认跑全部可跑）
          </button>
          <button type="button" className="eval-btn outline" onClick={() => onNavigate?.('history')}>
            打开结果详情 →
          </button>
        </div>
      </div>

      <div className="eval-card">
        <h3>用例清单 · {filtered.length}</h3>
        {casesQ.loading && !filtered.length ? (
          <p className="eval-muted">加载中…</p>
        ) : !filtered.length ? (
          <p className="eval-muted">本模块暂无用例。确认 Gateway 已迁移到最新 schema。</p>
        ) : (
          <table className="eval-table">
            <thead>
              <tr>
                <th style={{ width: 36 }} />
                <th>用例</th>
                <th>层级</th>
                <th>流</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const d = caseDesign(c)
                const checked = Boolean(selected[c.id])
                const runnable = isRunnable(c)
                return (
                  <tr key={c.id} className={runnable ? undefined : 'eval-row-fail'}>
                    <td>
                      <input
                        type="checkbox"
                        disabled={!runnable || running}
                        checked={checked}
                        onChange={() => toggle(c.id)}
                        title={runnable ? '选中后「跑选中」只跑勾选项' : '无 handler / 未启用'}
                      />
                    </td>
                    <td>
                      <strong>{c.name}</strong>
                      <div className="eval-muted">
                        <code>{c.id}</code>
                      </div>
                    </td>
                    <td>
                      <span className="eval-badge">{c.level || 'L1'}</span>
                      {String(c.level || '').toUpperCase() === 'L3' ? (
                        <span className="eval-badge run">真 LLM</span>
                      ) : (
                        <span className="eval-badge">账本</span>
                      )}
                    </td>
                    <td>
                      <span className="eval-badge run">
                        {c.flow_label || FLOW_LABELS[d.flow] || d.flow || '—'}
                      </span>
                    </td>
                    <td>
                      <div className="eval-assert">{c.description || d.risk || '—'}</div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {lastResults ? (
        <div className="eval-card">
          <h3>本次结果 · {lastResults.length}</h3>
          <table className="eval-table">
            <thead>
              <tr>
                <th>用例</th>
                <th>状态</th>
                <th>分数</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {lastResults.map((r: any) => (
                <tr key={r.case_id || r.id}>
                  <td>{r.case_name || r.case_id || r.id}</td>
                  <td>
                    <span
                      className={`eval-badge ${
                        ['passed', 'success', 'ok'].includes(String(r.status || '').toLowerCase()) ||
                        Number(r.score) >= 80
                          ? 'ok'
                          : ['skipped', 'skip'].includes(String(r.status || '').toLowerCase())
                            ? 'run'
                            : 'fail'
                      }`}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td>{r.score ?? '—'}</td>
                  <td>
                    <div className="eval-assert">{r.detail || r.message || ''}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="eval-card">
        <h3>最近评测 run</h3>
        {runsQ.error ? <div className="eval-error">{runsQ.error}</div> : null}
        <table className="eval-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>状态</th>
              <th>时间</th>
            </tr>
          </thead>
          <tbody>
            {((runsQ.data?.runs || runsQ.data || []) as any[]).slice(0, 8).map((r: any) => (
              <tr key={r.id || r.run_id}>
                <td>{r.name || r.id || r.run_id}</td>
                <td>
                  <span className={`eval-badge ${String(r.status).includes('fail') ? 'fail' : 'ok'}`}>
                    {r.status}
                  </span>
                </td>
                <td className="eval-muted">{r.finished_at || r.created_at || r.started_at || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
