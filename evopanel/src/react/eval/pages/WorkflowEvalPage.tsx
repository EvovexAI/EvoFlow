/**
 * 工作流评测 — 给人看的决策页（与智能体员工页同构）。
 * ① 规则/控制面 ② 真实跑任务；逐步打勾；结果留在本页。
 */
import { useMemo, useState } from 'react'
import { evalApi, pollRunUntilDone } from '../api/evalApi'
import { useAsync } from '../hooks/useAsync'

type StepStatus = 'idle' | 'running' | 'passed' | 'failed' | 'skipped'
type Verdict = 'unknown' | 'pass' | 'fail' | 'partial' | 'running'

type StepDef = { id: string; label: string }

type Question = {
  id: string
  title: string
  ask: string
  meaning: string
  steps: StepDef[]
  passHint: string
  failHint: string
}

const QUESTIONS: Question[] = [
  {
    id: 'rules',
    title: '① 工作流规则能不能挡住错误',
    ask: '非法图拦得住吗？失败会不会伪绿？取消/重试后账本对得上吗？',
    meaning: '下面每一步跑完立刻打勾或打叉，都是账本/控制面，不调真模型。',
    steps: [
      { id: 'sc_workflow_publish_rejects_cycle', label: '有环的图不能发布' },
      { id: 'sc_workflow_task_step_binding', label: '步骤绑定工人档案' },
      { id: 'sc_workflow_task_inherit_agent_tools', label: '省略工具时继承 Agent' },
      { id: 'sc_workflow_task_param_render', label: '参数渲染进指令' },
      { id: 'sc_workflow_task_step_fail_halts', label: '上游失败下游不伪绿' },
      { id: 'sc_workflow_task_cancel_run', label: '取消后运行停干净' },
      { id: 'sc_workflow_task_retry_unblocks_downstream', label: '重试成功后下游解阻' },
      { id: 'sc_workflow_task_official_outcome_rollup', label: '官方 outcome 能 rollup' },
    ],
    passHint: '可以：定义、绑定、失败、取消、重试、outcome 规则正常。',
    failHint: '有步骤失败：看下方打叉的那几步。',
  },
  {
    id: 'live',
    title: '② 真实跑任务能不能跑完',
    ask: '发布 → 开跑 → 工人真用模型写报告 → 主任务有终态？',
    meaning: '这一项走 Gateway HTTP，要开真模型；禁止 inject 冒充结果。',
    steps: [
      { id: 'sc_workflow_task_live_run', label: '真实开跑两条工人步骤（要 Gateway + 模型）' },
    ],
    passHint: '可以：真开跑且至少有工人产出报告，主任务到终态或两步都报了。',
    failHint: '真跑失败或超时：看模型/Gateway/工人是否卡住。',
  },
]

function caseModule(c: any): string {
  return c.module || c.params?.module || ''
}

function verdictLabel(v: Verdict): string {
  if (v === 'pass') return '可以'
  if (v === 'fail') return '不行'
  if (v === 'partial') return '部分可以'
  if (v === 'running') return '验证中…'
  return '尚未验证'
}

function stepMark(st: StepStatus): string {
  if (st === 'passed') return '✓'
  if (st === 'failed') return '✗'
  if (st === 'skipped') return '–'
  if (st === 'running') return '…'
  return '○'
}

function stepClass(st: StepStatus): string {
  if (st === 'passed') return 'ok'
  if (st === 'failed') return 'fail'
  if (st === 'running' || st === 'skipped') return 'run'
  return ''
}

export function WorkflowEvalPage(_props: { onNavigate?: (k: string) => void }) {
  const casesQ = useAsync(() => evalApi.cases('scenario'), [])
  const [busy, setBusy] = useState(false)
  const [activeQ, setActiveQ] = useState<string | null>(null)
  const [currentLabel, setCurrentLabel] = useState('')
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({})
  const [stepState, setStepState] = useState<Record<string, StepStatus>>({})
  const [stepDetail, setStepDetail] = useState<Record<string, string>>({})
  const [summary, setSummary] = useState('')

  const availableIds = useMemo(() => {
    const raw = casesQ.data
    const all = (Array.isArray(raw) ? raw : raw?.cases || []) as any[]
    return new Set(
      all
        .filter(
          (c) =>
            caseModule(c) === 'workflow' ||
            QUESTIONS.some((q) => q.steps.some((s) => s.id === c.id)),
        )
        .map((c) => c.id),
    )
  }, [casesQ.data])

  function setStep(id: string, st: StepStatus, detail = '') {
    setStepState((prev) => ({ ...prev, [id]: st }))
    if (detail) setStepDetail((prev) => ({ ...prev, [id]: detail }))
  }

  async function runOneCase(caseId: string, label: string): Promise<StepStatus> {
    setCurrentLabel(label)
    setStep(caseId, 'running')
    const started = await evalApi.startRun({
      name: `工作流验证 · ${label}`,
      mode: 'scenario',
      type: 'scenario',
      case_ids: [caseId],
      async_mode: true,
      config: { mode: 'scenario', module: 'workflow' },
    })
    const runId = started.run_id || started.runId || started.id
    if (!runId) {
      setStep(caseId, 'failed', '未返回 run_id')
      return 'failed'
    }
    const timeout = caseId.includes('live') ? 8 * 60 * 1000 : 3 * 60 * 1000
    const detail = await pollRunUntilDone(runId, undefined, timeout)
    const results = (detail?.results || detail?.cases || detail?.run?.results || []) as any[]
    const row =
      results.find((r) => String(r.case_id || r.id || '') === caseId) || results[0] || {}
    const st = String(row.status || '').toLowerCase()
    const score = Number(row.score)
    const runSt = String(detail?.run?.status || detail?.status || '').toLowerCase()
    const ok =
      st === 'passed' ||
      st === 'success' ||
      st === 'ok' ||
      (Number.isFinite(score) && score >= 80) ||
      ((runSt === 'completed' || runSt === 'success') &&
        results.length === 1 &&
        st !== 'failed' &&
        st !== 'error')
    if (ok) {
      setStep(caseId, 'passed', '通过')
      return 'passed'
    }
    if (st === 'skipped' || st === 'skip') {
      setStep(caseId, 'skipped', String(row.detail || row.message || '已跳过（例如未开真模型）'))
      return 'skipped'
    }
    setStep(
      caseId,
      'failed',
      String(row.detail || row.message || st || runSt || '失败').slice(0, 160),
    )
    return 'failed'
  }

  async function runQuestion(q: Question) {
    const steps = q.steps.filter((s) => availableIds.size === 0 || availableIds.has(s.id))
    if (!steps.length) {
      setSummary(`「${q.title}」没有可跑步骤。请确认 Gateway 已更新到最新评测目录。`)
      setVerdicts((v) => ({ ...v, [q.id]: 'fail' }))
      return
    }
    setBusy(true)
    setActiveQ(q.id)
    setVerdicts((v) => ({ ...v, [q.id]: 'running' }))
    setSummary(`正在验证：${q.title}`)
    for (const s of steps) setStep(s.id, 'idle')

    let passed = 0
    let failed = 0
    let skipped = 0
    try {
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i]
        setSummary(`${q.title} · 第 ${i + 1}/${steps.length} 步：${s.label}`)
        try {
          const st = await runOneCase(s.id, s.label)
          if (st === 'passed') passed += 1
          else if (st === 'skipped') skipped += 1
          else failed += 1
        } catch (e: any) {
          failed += 1
          setStep(s.id, 'failed', String(e?.message || e).slice(0, 160))
        }
      }
      let verdict: Verdict = 'unknown'
      if (failed === 0 && passed + skipped > 0) verdict = 'pass'
      else if (failed > 0 && passed + skipped > 0) verdict = 'partial'
      else if (failed > 0) verdict = 'fail'
      setVerdicts((v) => ({ ...v, [q.id]: verdict }))
      setSummary(
        verdict === 'pass'
          ? q.passHint
          : verdict === 'partial'
            ? `${q.title}：${passed} 通过，${failed} 失败，${skipped} 跳过。看下方打叉步骤。`
            : q.failHint,
      )
    } finally {
      setBusy(false)
      setActiveQ(null)
      setCurrentLabel('')
    }
  }

  async function runBoth() {
    for (const q of QUESTIONS) {
      await runQuestion(q)
    }
  }

  return (
    <>
      <div className="eval-hero">
        <div>
          <h2>工作流，能不能用？</h2>
          <p>两件事分开验。点开始后，下面会一步步显示干到哪了；结果留在本页。</p>
        </div>
        <div className="eval-actions">
          <button type="button" className="eval-btn primary" disabled={busy} onClick={() => runBoth()}>
            {busy ? '验证中…' : '从上到下验两件事'}
          </button>
        </div>
      </div>

      {summary ? <div className="eval-emp-status">{summary}</div> : null}
      {currentLabel ? (
        <div className="eval-emp-status is-live">正在跑：{currentLabel}</div>
      ) : null}
      {casesQ.error ? <div className="eval-error">{casesQ.error}</div> : null}

      <div className="eval-emp-stack">
        {QUESTIONS.map((q) => {
          const v = verdicts[q.id] || 'unknown'
          const runningHere = activeQ === q.id
          return (
            <section
              key={q.id}
              className={`eval-card eval-emp-q ${runningHere ? 'is-active' : ''}`}
            >
              <div className="eval-emp-q-head">
                <div>
                  <h3 style={{ margin: 0 }}>{q.title}</h3>
                  <p className="eval-muted" style={{ margin: '8px 0 0' }}>
                    <strong>要问：</strong>
                    {q.ask}
                  </p>
                  <p className="eval-muted" style={{ margin: '6px 0 0' }}>
                    {q.meaning}
                  </p>
                </div>
                <div className="eval-emp-verdict">
                  <span
                    className={`eval-badge ${v === 'pass' ? 'ok' : v === 'fail' ? 'fail' : v === 'partial' || v === 'running' ? 'run' : ''}`}
                  >
                    {verdictLabel(v)}
                  </span>
                  <button
                    type="button"
                    className="eval-btn outline"
                    style={{ marginTop: 10 }}
                    disabled={busy}
                    onClick={() => runQuestion(q)}
                  >
                    {runningHere ? '本项验证中…' : '只验这一项'}
                  </button>
                </div>
              </div>

              <ol className="eval-emp-steps">
                {q.steps.map((s, idx) => {
                  const st = stepState[s.id] || 'idle'
                  const missing = availableIds.size > 0 && !availableIds.has(s.id)
                  return (
                    <li key={s.id} className={`eval-emp-step is-${st}`}>
                      <span className={`eval-badge ${stepClass(st)}`} style={{ minWidth: 28 }}>
                        {missing ? '!' : stepMark(st)}
                      </span>
                      <div className="eval-emp-step-body">
                        <div>
                          <strong>
                            {idx + 1}. {s.label}
                          </strong>
                          {missing ? (
                            <span className="eval-muted"> · 目录里还没有这条，请升级 Gateway</span>
                          ) : null}
                        </div>
                        {stepDetail[s.id] ? (
                          <div className="eval-assert">{stepDetail[s.id]}</div>
                        ) : null}
                      </div>
                    </li>
                  )
                })}
              </ol>
            </section>
          )
        })}
      </div>

      <div className="eval-card">
        <h3>怎么读</h3>
        <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--eval-muted)', lineHeight: 1.7 }}>
          <li>
            <strong>可以</strong>：这项所有步骤都过了（跳过也算合理）。
          </li>
          <li>
            <strong>部分可以</strong>：常见是①账本过了，②「真实跑任务」因模型/网络挂了。
          </li>
          <li>
            <strong>不行</strong>：核心规则失败，先别当生产可用。
          </li>
          <li>结果和失败原因都在本页，不用跳到别的菜单。</li>
        </ul>
      </div>
    </>
  )
}
