import { useEffect, useMemo, useState } from 'react'
import { evalApi } from '../api/evalApi'
import { useAsync } from '../hooks/useAsync'

/** 与后端 evoflow.eval.modules 对齐 */
const MODULE_LABELS: Record<string, string> = {
  knowledge: '知识库',
  agents: '智能体',
  employees: '智能体员工',
  skills: '技能',
  mcp: 'MCP',
  workflow: '工作流',
  tasks: '任务中心',
  items: '待办事项',
  platform: '平台门禁',
  cross: '跨模块',
  obs_business: '观测·业务',
  obs_security: '观测·安全',
  obs_performance: '观测·性能',
  other: '其他',
}

const FLOW_LABELS: Record<string, string> = {
  happy: '基本流',
  alt: '备选流',
  negative: '异常流',
  boundary: '边界值',
  state_machine: '状态机',
}

const MODULE_ORDER = Object.keys(MODULE_LABELS)

/** 常见断言名 → 中文，方便扫读 */
const ASSERT_LABELS: Record<string, string> = {
  knowledge_recall: '知识库召回命中',
  mcp_configured: 'MCP 配置写入',
  skill_ready: '技能可用',
  agent_bound: '智能体已绑技能/MCP',
  employee_hired_with_vault: '员工雇佣并挂知识库',
  platform_confirm_gate: '平台 confirm 门禁',
  item_dispatch_link: '待办派发联动任务',
  workflow_run_task: '工作流开跑产生任务',
  tasks_hub_sees_both: '任务中心可见两条任务',
  approval_ledger: '审批台账一致',
  vault_created: '知识库已创建',
  vault_listed: '知识库在列表中',
  note_remembered: '笔记已写入',
  note_listed: '笔记在列表中',
  note_get: '笔记可读',
  note_deleted: '笔记已删除',
  recall_hit: '全文召回命中',
  remember_ok: '笔记保存成功',
  item_created: '待办已创建',
  task_created: '任务已创建',
  linked_task_ids: '待办已关联任务',
  source_ref: '任务溯源正确',
  item_waiting: '待办进入等待态',
  definition_valid: '工作流定义合法',
  saved_and_listed: '工作流已保存可查',
  get_app: '工作流可读',
  run_creates_task: '开跑产生任务',
  config_saved: 'MCP 配置已保存',
  config_get: 'MCP 配置可读',
  agent_unbind: '智能体已解绑 MCP',
  config_cleared: 'MCP 配置已清空',
  no_process_spawn: '未拉起 MCP 进程',
  skills_listed: '技能列表非空',
  disable_skill: '技能可禁用',
  enabled_only_excludes: '启用列表排除禁用项',
  reenable_skill: '技能可重新启用',
  bind_to_agent: '技能已绑到智能体',
  hired: '员工已雇佣',
  paused: '员工已暂停',
  resumed: '员工已恢复',
  preview_pending: 'confirm=false 仅预览',
  preview_no_mutate: '预览不落库',
  confirm_ok: 'confirm=true 执行成功',
  confirm_mutates: '确认后落库',
  agent_created: '智能体已创建',
  wake_ready_prompt_snapshot: 'Wake 就绪提示词快照',
  tools_config_frozen: '工具配置已冻结',
  unknown_skill_rejected: '未知技能已拒绝',
  paused_status: '岗位已暂停',
  dispatch_while_paused_still_auditable: '暂停态派发可审计',
  resumed_status: '岗位已恢复',
  approve_path: '审批通过路径',
  reject_path: '审批拒绝路径',
  workflow_started: '工作流已开跑',
  execution_authorized: '主任务已授权执行',
  official_outcomes_applied: '官方 outcome 已写入',
  official_outcomes_ok: '官方 outcome 成功',
  reports_have_token: '子任务报告含约定 token',
  main_completed: '主任务已完结',
  has_rollup_subtask: '存在 rollup 子任务',
  rollup_applied: 'rollup 已应用',
  step1_official_failed: '步骤1官方失败',
  step2_not_fake_completed: '步骤2未假完成',
  main_not_completed: '主任务未伪绿完结',
  apply_ok: '官方 outcome 调用成功',
  step_omits_tools_in_profile_or_empty: '步骤未覆盖 tools',
  inherited_allowlist_has_agent_tools: '继承智能体工具集',
  topic_rendered_in_goal_or_instruction: '参数已渲染进文案',
  no_literal_placeholder: '无残留占位符',
  live_llm_evidence: '真 LLM 值班证据',
  live_worker_reports: '真 LLM 工人报告',
  dispatched_wake: '事项派发并唤醒',
  gateway_live_ready: 'Gateway 真跑就绪',
  gateway_http: 'Gateway HTTP 调用',
  app_created_published: '工作流已创建并发布',
  main_terminal_or_steps_done: '主任务终态或步骤已报',
}

function fmt(v: unknown): string {
  if (v === undefined || v === null || v === '') return '—'
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

function isFailed(status: unknown): boolean {
  const s = String(status || '')
  return s.includes('fail') || s === 'error'
}

function caseModule(c: any): string {
  return String(c.module || c.params?.module || 'other')
}

function caseModuleLabel(c: any): string {
  const k = caseModule(c)
  return c.module_label || MODULE_LABELS[k] || k
}

function assertLabel(name: string): string {
  return ASSERT_LABELS[name] || name
}

function statusLabel(status: unknown): string {
  if (isFailed(status)) return '失败'
  if (String(status || '') === 'passed' || String(status || '') === 'ok') return '通过'
  return String(status || '未知')
}

/** 后端已格式化 duration 字符串，或 duration_ms 数字 */
function formatDuration(r: any): string {
  if (r == null) return '—'
  if (typeof r === 'string' && r.trim()) {
    if (r === '0s' || r === '0') return '—'
    return r
  }
  const ms = Number(
    typeof r === 'object'
      ? r.duration_ms ?? r.durationMs ?? (typeof r.duration === 'number' ? r.duration : NaN)
      : r,
  )
  if (!Number.isFinite(ms) || ms <= 0) {
    if (typeof r === 'object' && typeof r.duration === 'string' && r.duration && r.duration !== '0s') {
      return r.duration
    }
    return '—'
  }
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}min`
}

function runDuration(r: any): string {
  if (!r) return '—'
  if (typeof r.duration === 'string' && r.duration && r.duration !== '0s') return r.duration
  return formatDuration(r)
}

function CaseEvidence({ c, defaultOpen }: { c: any; defaultOpen?: boolean }) {
  const failed = isFailed(c.status)
  const [open, setOpen] = useState(Boolean(defaultOpen ?? failed))
  const assertions = Array.isArray(c.assertions) ? c.assertions : []
  const steps = Array.isArray(c.steps) ? c.steps : []
  const prov = c.provenance || {}
  const passedAssert = assertions.filter((a: any) => a.ok).length
  const level = String(c.level || 'L1').toUpperCase()
  const design = c.design || c.params?.design || {}
  const designSteps = Array.isArray(design.steps) ? design.steps : []
  const caseDur = formatDuration(c)

  return (
    <div className={`eval-case-block ${failed ? 'is-fail' : 'is-ok'}`}>
      <button type="button" className="eval-case-head" onClick={() => setOpen((v) => !v)}>
        <span className={`eval-badge ${failed ? 'fail' : 'ok'}`}>{statusLabel(c.status)}</span>
        <span className="eval-badge run">{caseModuleLabel(c)}</span>
        {c.priority || design.priority ? (
          <span className="eval-badge">{c.priority || design.priority}</span>
        ) : null}
        {c.flow_label || design.flow ? (
          <span className="eval-badge run">{c.flow_label || FLOW_LABELS[design.flow] || design.flow}</span>
        ) : null}
        <span className="eval-badge">{level}</span>
        <strong>{c.name || c.case_name || c.id}</strong>
        <span className="eval-muted">
          耗时 {caseDur}
          {` · 得分 ${c.score ?? '—'}`}
          {assertions.length ? ` · 检查点 ${passedAssert}/${assertions.length}` : ''}
        </span>
        <span className="eval-muted eval-case-toggle">{open ? '收起' : '展开证据'}</span>
      </button>
      {open ? (
        <div className="eval-case-body">
          {designSteps.length ? (
            <>
              <h4>设计步骤（对照）</h4>
              <ol className="eval-design-list">
                {designSteps.map((s: string, i: number) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </>
          ) : null}
          {c.description ? (
            <p className="eval-case-desc">
              <strong>测什么：</strong>
              {c.description}
            </p>
          ) : null}
          {c.message || c.detail ? (
            <p className={`eval-assert ${failed ? 'is-fail-text' : ''}`}>
              <strong>结果说明：</strong>
              {c.message || c.detail}
            </p>
          ) : null}

          {(() => {
            const rc = (c.metrics && c.metrics.runtime_contract) || null
            const evalScope = c.metrics?.eval_scope || rc?.eval_scope
            if (!rc && !evalScope) return null
            const agents = (rc && rc.agents) || {}
            const timeline = (rc && rc.task_timeline) || []
            return (
              <div className="eval-runtime-contract">
                <h4>运行时合同（提示词 / 工具 / 任务时间线）</h4>
                {evalScope ? (
                  <p className="eval-muted">
                    eval_scope: <code>{String(evalScope)}</code>
                    {String(evalScope) === 'live_llm' ? (
                      <span className="eval-badge run" style={{ marginLeft: 8 }}>
                        真 LLM / Gateway
                      </span>
                    ) : null}
                    {String(evalScope) === 'config_and_official_outcome' ? (
                      <span className="eval-badge" style={{ marginLeft: 8 }}>
                        账本 / 无 LLM
                      </span>
                    ) : null}
                  </p>
                ) : null}
                {Object.keys(agents).length ? (
                  <ul className="eval-design-list">
                    {Object.entries(agents).map(([code, snap]: [string, any]) => (
                      <li key={code}>
                        <strong>{code}</strong>
                        <pre className="eval-mini-pre">
                          {fmt({
                            system_prompt_preview: snap?.system_prompt_preview,
                            tools_config: snap?.tools_config,
                            tools_resolved: (snap?.tools_resolved || []).slice?.(0, 16) || snap?.tools_resolved,
                            duty_brief_has_marker: snap?.duty_brief_has_marker,
                            duty_brief_preview: snap?.duty_brief_preview,
                          })}
                        </pre>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {timeline.length ? (
                  <>
                    <h5>任务状态时间线</h5>
                    <pre className="eval-mini-pre">{fmt(timeline)}</pre>
                  </>
                ) : null}
              </div>
            )
          })()}

          {steps.length ? (
            <>
              <h4>调用步骤</h4>
              <ol className="eval-steps">
                {steps.map((s: any, i: number) => (
                  <li key={i}>
                    {s.module ? <span className="eval-badge run">{MODULE_LABELS[s.module] || s.module}</span> : null}{' '}
                    <code>{s.api || `步骤 ${s.step || i + 1}`}</code>
                    {s.inputs !== undefined ? <pre className="eval-mini-pre">入参 {fmt(s.inputs)}</pre> : null}
                    {s.result !== undefined ? <pre className="eval-mini-pre">结果 {fmt(s.result)}</pre> : null}
                  </li>
                ))}
              </ol>
            </>
          ) : null}

          <h4>检查点（入参 / 预期 / 实际）</h4>
          {assertions.length ? (
            <table className="eval-table eval-assert-table">
              <thead>
                <tr>
                  <th>检查点</th>
                  <th>结果</th>
                  <th>调用的 API</th>
                  <th>入参</th>
                  <th>预期</th>
                  <th>实际</th>
                </tr>
              </thead>
              <tbody>
                {assertions.map((a: any, i: number) => (
                  <tr key={`${a.name}-${i}`} className={a.ok ? undefined : 'eval-row-fail'}>
                    <td>
                      <div className="eval-assert-name">{assertLabel(String(a.name || ''))}</div>
                      {ASSERT_LABELS[a.name] ? (
                        <code className="eval-assert-id">{a.name}</code>
                      ) : (
                        <code>{a.name}</code>
                      )}
                    </td>
                    <td>
                      <span className={`eval-badge ${a.ok ? 'ok' : 'fail'}`}>{a.ok ? '通过' : '失败'}</span>
                    </td>
                    <td>
                      <code>{a.api || '—'}</code>
                    </td>
                    <td>
                      <pre className="eval-mini-pre">{fmt(a.inputs)}</pre>
                    </td>
                    <td>
                      <pre className="eval-mini-pre">{fmt(a.expected)}</pre>
                    </td>
                    <td>
                      <pre className="eval-mini-pre">{fmt(a.actual)}</pre>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="eval-muted">本条无检查点明细（多为观测指标）。</p>
          )}

          <details className="eval-raw-json">
            <summary>技术信息（handler / 隔离 / 指标）</summary>
            <div className="eval-evidence-meta">
              <div>
                <span className="label">handler</span>
                <code>{c.handler || '—'}</code>
              </div>
              <div>
                <span className="label">用例 id</span>
                <code>{c.id || c.case_id || '—'}</code>
              </div>
              <div>
                <span className="label">Mock</span>
                <code>{String(Boolean(c.mock ?? prov.mock))}</code>
              </div>
              <div>
                <span className="label">隔离</span>
                <code>{prov.isolation || '—'}</code>
              </div>
            </div>
            {c.metrics && Object.keys(c.metrics).length ? (
              <pre className="eval-mini-pre">{fmt(c.metrics)}</pre>
            ) : null}
          </details>
        </div>
      ) : null}
    </div>
  )
}

export function HistoryPage() {
  const runs = useAsync(() => evalApi.runs(30), [])
  const [selected, setSelected] = useState<string[]>([])
  const [compare, setCompare] = useState<any>(null)
  const [detail, setDetail] = useState<any>(null)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [autoLoaded, setAutoLoaded] = useState(false)
  const [moduleFilter, setModuleFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'fail' | 'pass'>('all')

  const list = Array.isArray(runs.data) ? runs.data : runs.data?.runs || runs.data?.items || []

  useEffect(() => {
    if (autoLoaded || !list.length) return
    const first = list[0]
    const id = first?.run_id || first?.runId || first?.id
    if (!id) return
    setAutoLoaded(true)
    void openDetail(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, autoLoaded])

  function toggle(id: string) {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id)
      if (prev.length >= 2) return [prev[1], id]
      return [...prev, id]
    })
  }

  async function doCompare() {
    if (selected.length < 2) return
    const data = await evalApi.compare(selected)
    setCompare(data)
  }

  async function openDetail(id: string) {
    setLoadingId(id)
    setModuleFilter('all')
    setStatusFilter('all')
    try {
      setDetail(await evalApi.runDetail(id))
      setCompare(null)
    } finally {
      setLoadingId(null)
    }
  }

  const cases = useMemo(() => {
    const raw = detail?.cases || detail?.results || []
    return Array.isArray(raw) ? raw : []
  }, [detail])

  const moduleStats = useMemo(() => {
    const map = new Map<string, { total: number; passed: number; failed: number; label: string }>()
    for (const c of cases) {
      const k = caseModule(c)
      if (!map.has(k)) {
        map.set(k, { total: 0, passed: 0, failed: 0, label: caseModuleLabel(c) })
      }
      const row = map.get(k)!
      row.total += 1
      if (isFailed(c.status)) row.failed += 1
      else row.passed += 1
    }
    const keys = [...MODULE_ORDER.filter((k) => map.has(k)), ...[...map.keys()].filter((k) => !MODULE_ORDER.includes(k))]
    return keys.map((k) => ({ key: k, ...(map.get(k) as any) }))
  }, [cases])

  const filteredCases = useMemo(() => {
    return cases.filter((c: any) => {
      if (moduleFilter !== 'all' && caseModule(c) !== moduleFilter) return false
      if (statusFilter === 'fail' && !isFailed(c.status)) return false
      if (statusFilter === 'pass' && isFailed(c.status)) return false
      return true
    })
  }, [cases, moduleFilter, statusFilter])

  const grouped = useMemo(() => {
    const map = new Map<string, any[]>()
    for (const c of filteredCases) {
      const k = caseModule(c)
      if (!map.has(k)) map.set(k, [])
      map.get(k)!.push(c)
    }
    const keys = [
      ...MODULE_ORDER.filter((k) => map.has(k)),
      ...[...map.keys()].filter((k) => !MODULE_ORDER.includes(k)),
    ]
    return keys.map((k) => {
      const items = map.get(k) || []
      const failed = items.filter((c) => isFailed(c.status)).length
      return {
        key: k,
        label: MODULE_LABELS[k] || items[0]?.module_label || k,
        items,
        passed: items.length - failed,
        failed,
      }
    })
  }, [filteredCases])

  const totalFailed = cases.filter((c: any) => isFailed(c.status)).length
  const totalPassed = cases.length - totalFailed
  const activeId = detail?.run_id || detail?.id
  const activeRunMeta = list.find((r: any) => (r.run_id || r.runId || r.id) === activeId)
  const detailDuration = runDuration(detail) !== '—' ? runDuration(detail) : runDuration(activeRunMeta)

  const recordsTable = (
    <div className="eval-card eval-history-records">
      <h3>评测记录</h3>
      <p className="eval-muted">切换历史 run；勾选两条可对比。总耗时见「耗时」列。</p>
      {runs.loading && !list.length ? (
        <p className="eval-muted">加载中…</p>
      ) : !list.length ? (
        <p className="eval-muted">还没有评测记录。请先到「健康总览」点「一键评测」。</p>
      ) : (
        <table className="eval-table">
          <thead>
            <tr>
              <th />
              <th>名称</th>
              <th>模式</th>
              <th>通过</th>
              <th>耗时</th>
              <th>状态</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((r: any) => {
              const id = r.run_id || r.runId || r.id
              const active = id === activeId
              const modeLabel =
                r.type === 'smoke'
                  ? '冒烟 L1'
                  : r.type === 'scenario'
                    ? '全场景'
                    : r.type === 'full'
                      ? '全量'
                      : r.type
              return (
                <tr key={id} className={active ? 'eval-row-active' : undefined}>
                  <td>
                    <input type="checkbox" checked={selected.includes(id)} onChange={() => toggle(id)} />
                  </td>
                  <td>
                    {r.name}
                    <div className="eval-muted" style={{ fontSize: 11 }}>
                      {id}
                    </div>
                  </td>
                  <td>{modeLabel}</td>
                  <td>
                    {r.passed_cases ?? r.passedCases ?? 0}/{r.total_cases ?? r.totalCases ?? 0}
                  </td>
                  <td>{runDuration(r)}</td>
                  <td>
                    <span className={`eval-badge ${isFailed(r.status) ? 'fail' : 'ok'}`}>
                      {statusLabel(r.status)}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className={`eval-btn ${active ? 'primary' : ''}`}
                      disabled={loadingId === id}
                      onClick={() => openDetail(id)}
                    >
                      {loadingId === id ? '加载中…' : active ? '当前' : '查看'}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )

  return (
    <>
      <div className="eval-hero">
        <div>
          <h2>结果与详情</h2>
          <p>按模块看通过/失败与证据；历史记录在本页底部</p>
        </div>
        <div className="eval-actions">
          <button type="button" className="eval-btn outline" onClick={() => runs.reload()}>
            刷新列表
          </button>
          <button type="button" className="eval-btn primary" disabled={selected.length < 2} onClick={doCompare}>
            对比选中
          </button>
        </div>
      </div>

      {runs.error ? <div className="eval-error">{runs.error}</div> : null}

      {detail ? (
        <div className="eval-card">
          <h3>
            按模块看结果 · {detail.name || detail.run_id || detail.id}
          </h3>
          <p className="eval-muted">
            {statusLabel(detail.status)} · 合计通过 {totalPassed}/{cases.length}
            {totalFailed ? ` · 失败 ${totalFailed}` : ' · 全部通过'}
            {` · 本次总耗时 ${detailDuration}`}
          </p>

          {!cases.length ? (
            <p className="eval-muted">该 run 没有 case 明细（可能仍在跑，或 adapter 未透传）。</p>
          ) : (
            <>
              <div className="eval-module-summary">
                <button
                  type="button"
                  className={`eval-module-chip ${moduleFilter === 'all' ? 'active' : ''}`}
                  onClick={() => setModuleFilter('all')}
                >
                  <strong>全部模块</strong>
                  <span>
                    {totalPassed}/{cases.length} 通过
                  </span>
                </button>
                {moduleStats.map((m) => (
                  <button
                    type="button"
                    key={m.key}
                    className={`eval-module-chip ${moduleFilter === m.key ? 'active' : ''} ${
                      m.failed ? 'has-fail' : 'all-ok'
                    }`}
                    onClick={() => setModuleFilter(m.key)}
                  >
                    <strong>{m.label}</strong>
                    <span>
                      {m.passed}/{m.total} 通过
                      {m.failed ? ` · ${m.failed} 失败` : ''}
                    </span>
                  </button>
                ))}
              </div>

              <div className="eval-tabs">
                <button
                  type="button"
                  className={`eval-tab ${statusFilter === 'all' ? 'active' : ''}`}
                  onClick={() => setStatusFilter('all')}
                >
                  全部状态 ({filteredCases.length || cases.length})
                </button>
                <button
                  type="button"
                  className={`eval-tab ${statusFilter === 'fail' ? 'active' : ''}`}
                  onClick={() => setStatusFilter('fail')}
                >
                  仅失败 ({totalFailed})
                </button>
                <button
                  type="button"
                  className={`eval-tab ${statusFilter === 'pass' ? 'active' : ''}`}
                  onClick={() => setStatusFilter('pass')}
                >
                  仅通过 ({totalPassed})
                </button>
              </div>

              {!grouped.length ? (
                <p className="eval-muted">当前筛选下没有用例。</p>
              ) : (
                grouped.map((g) => (
                  <section key={g.key} className="eval-module-section">
                    <header className="eval-module-section-head">
                      <h4>
                        <span className="eval-badge run">{g.label}</span>
                        <span>
                          {g.passed}/{g.items.length} 通过
                          {g.failed ? (
                            <span className="eval-fail-count"> · {g.failed} 失败</span>
                          ) : (
                            <span className="eval-ok-count"> · 本组全过</span>
                          )}
                        </span>
                      </h4>
                    </header>
                    {g.items.map((c: any) => (
                      <CaseEvidence
                        key={c.id || c.case_id}
                        c={c}
                        defaultOpen={isFailed(c.status) || g.key === 'cross'}
                      />
                    ))}
                  </section>
                ))
              )}
            </>
          )}

          <details className="eval-raw-json">
            <summary>原始 JSON（完整）</summary>
            <pre className="eval-mini-pre">{JSON.stringify(detail, null, 2)}</pre>
          </details>
        </div>
      ) : (
        <div className="eval-card">
          <h3>按模块看结果</h3>
          <p className="eval-muted">
            {runs.loading ? '正在加载评测记录…' : '请到本页底部「评测记录」点「查看」。'}
          </p>
        </div>
      )}

      {compare ? (
        <div className="eval-card">
          <h3>对比结果</h3>
          <pre className="eval-mini-pre">{JSON.stringify(compare, null, 2)}</pre>
        </div>
      ) : null}

      {recordsTable}
    </>
  )
}
