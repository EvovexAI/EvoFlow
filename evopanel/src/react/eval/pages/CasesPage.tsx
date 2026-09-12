import { useMemo, useState } from 'react'
import { evalApi } from '../api/evalApi'
import { useAsync } from '../hooks/useAsync'

const MODULES: { key: string; label: string }[] = [
  { key: 'all', label: '全部模块' },
  { key: 'knowledge', label: '知识库' },
  { key: 'agents', label: '智能体' },
  { key: 'employees', label: '智能体员工' },
  { key: 'skills', label: '技能' },
  { key: 'mcp', label: 'MCP' },
  { key: 'workflow', label: '工作流' },
  { key: 'tasks', label: '任务中心' },
  { key: 'items', label: '待办事项' },
  { key: 'platform', label: '平台门禁' },
  { key: 'cross', label: '跨模块' },
  { key: 'obs_business', label: '观测·业务' },
  { key: 'obs_security', label: '观测·安全' },
  { key: 'obs_performance', label: '观测·性能' },
]

const MODULE_ORDER = MODULES.filter((m) => m.key !== 'all').map((m) => m.key)

const FLOW_LABELS: Record<string, string> = {
  happy: '基本流',
  alt: '备选流',
  negative: '异常流',
  boundary: '边界值',
  state_machine: '状态机',
}

function caseModule(c: any): string {
  return c.module || c.params?.module || 'other'
}

function caseModuleLabel(c: any): string {
  return c.module_label || MODULES.find((m) => m.key === caseModule(c))?.label || caseModule(c)
}

function caseDesign(c: any): any {
  return c.design || c.params?.design || {}
}

function CaseCard({ c }: { c: any }) {
  const [open, setOpen] = useState(false)
  const d = caseDesign(c)
  const flow = c.flow || d.flow || ''
  const priority = c.priority || d.priority || ''
  const steps = Array.isArray(d.steps) ? d.steps : []
  const preconditions = Array.isArray(d.preconditions) ? d.preconditions : []
  const expected = Array.isArray(d.expected) ? d.expected : []
  const enabled = c.enabled !== false
  const planned = String(c.level || '').toUpperCase() === 'L3' || !c.handler

  return (
    <article className={`eval-case-card ${planned ? 'is-planned' : ''} ${enabled ? '' : 'is-disabled'}`}>
      <button type="button" className="eval-case-card-head" onClick={() => setOpen((v) => !v)}>
        <span className={`eval-badge ${priority === 'P0' ? 'ok' : 'run'}`}>{priority || '—'}</span>
        <span className="eval-badge run">{c.flow_label || FLOW_LABELS[flow] || flow || '—'}</span>
        <span className="eval-badge">{c.level || 'L1'}</span>
        {planned ? <span className="eval-badge warn">规划</span> : null}
        {!enabled && !planned ? <span className="eval-badge warn">未启用</span> : null}
        <strong>{c.name}</strong>
        <span className="eval-muted eval-case-toggle">{open ? '收起' : '展开设计'}</span>
      </button>
      <p className="eval-case-card-desc">{c.description || d.risk || '—'}</p>
      {open ? (
        <div className="eval-case-card-body">
          <div className="eval-design-grid">
            <div>
              <h5>角色</h5>
              <p>{d.persona || '—'}</p>
            </div>
            <div>
              <h5>风险</h5>
              <p>{d.risk || '—'}</p>
            </div>
            <div>
              <h5>清理</h5>
              <p>{d.cleanup || '—'}</p>
            </div>
          </div>
          <h5>前置条件</h5>
          {preconditions.length ? (
            <ul className="eval-design-list">
              {preconditions.map((x: string, i: number) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          ) : (
            <p className="eval-muted">—</p>
          )}
          <h5>步骤</h5>
          {steps.length ? (
            <ol className="eval-design-list">
              {steps.map((x: string, i: number) => (
                <li key={i}>{x}</li>
              ))}
            </ol>
          ) : (
            <p className="eval-muted">—</p>
          )}
          <h5>预期</h5>
          {expected.length ? (
            <ul className="eval-design-list">
              {expected.map((x: string, i: number) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          ) : (
            <p className="eval-muted">—</p>
          )}
          <details className="eval-raw-json">
            <summary>技术信息</summary>
            <div className="eval-evidence-meta">
              <div>
                <span className="label">用例 id</span>
                <code>{c.id}</code>
              </div>
              <div>
                <span className="label">handler</span>
                <code>{c.handler || '（无，规划项）'}</code>
              </div>
              <div>
                <span className="label">technique</span>
                <code>{d.technique || '—'}</code>
              </div>
            </div>
          </details>
        </div>
      ) : null}
    </article>
  )
}

export function CasesPage() {
  const cases = useAsync(() => evalApi.cases(), [])
  const [module, setModule] = useState('all')
  const [level, setLevel] = useState<'all' | 'L0' | 'L1' | 'L2' | 'L3'>('all')
  const [flow, setFlow] = useState<'all' | string>('all')
  const [q, setQ] = useState('')

  const all = useMemo(() => {
    const raw = cases.data
    return (Array.isArray(raw) ? raw : raw?.cases || []) as any[]
  }, [cases.data])

  const moduleCounts = useMemo(() => {
    const out: Record<string, number> = { all: all.length }
    for (const c of all) {
      const k = caseModule(c)
      out[k] = (out[k] || 0) + 1
    }
    return out
  }, [all])

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase()
    return all.filter((c) => {
      if (module !== 'all' && caseModule(c) !== module) return false
      const lv = String(c.level || 'L1').toUpperCase()
      if (level !== 'all' && lv !== level) return false
      const fl = String(c.flow || caseDesign(c).flow || '')
      if (flow !== 'all' && fl !== flow) return false
      if (!qq) return true
      const blob = `${c.id} ${c.name} ${c.handler} ${c.description} ${caseModuleLabel(c)} ${JSON.stringify(caseDesign(c))}`.toLowerCase()
      return blob.includes(qq)
    })
  }, [all, module, level, flow, q])

  const grouped = useMemo(() => {
    const map = new Map<string, any[]>()
    for (const c of filtered) {
      const k = caseModule(c)
      if (!map.has(k)) map.set(k, [])
      map.get(k)!.push(c)
    }
    const keys = [
      ...MODULE_ORDER.filter((k) => map.has(k)),
      ...[...map.keys()].filter((k) => !MODULE_ORDER.includes(k)),
    ]
    return keys.map((k) => ({
      key: k,
      label: MODULES.find((m) => m.key === k)?.label || k,
      items: map.get(k) || [],
    }))
  }, [filtered])

  return (
    <>
      <div className="eval-hero">
        <div>
          <h2>用例库</h2>
          <p>按业界场景法：优先级 · 流类型 · 前置 / 步骤 / 预期（不只是 handler 一行）</p>
        </div>
      </div>

      <div className="eval-card">
        <h3>
          筛选 · 共 {moduleCounts.all || 0} 条设计
        </h3>
        <div className="eval-tabs">
          {MODULES.map((m) => (
            <button
              key={m.key}
              type="button"
              className={`eval-tab ${module === m.key ? 'active' : ''}`}
              onClick={() => setModule(m.key)}
            >
              {m.label} ({m.key === 'all' ? moduleCounts.all || 0 : moduleCounts[m.key] || 0})
            </button>
          ))}
        </div>
        <div className="eval-tabs">
          {(['all', 'L0', 'L1', 'L2', 'L3'] as const).map((id) => (
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
        <div className="eval-tabs">
          {(['all', 'happy', 'alt', 'negative', 'boundary', 'state_machine'] as const).map((id) => (
            <button
              key={id}
              type="button"
              className={`eval-tab ${flow === id ? 'active' : ''}`}
              onClick={() => setFlow(id)}
            >
              {id === 'all' ? '全部流' : FLOW_LABELS[id] || id}
            </button>
          ))}
        </div>
        <p className="eval-muted" style={{ marginBottom: 10 }}>
          L0 组件校验 · L1 模块集成 · L2 业务场景 · L3 真 LLM（需 live 门控）。
          智能体员工 / 工作流请用左侧独立页跑包。
          smoke 只跑 P0。
        </p>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索 id / 名称 / 步骤 / 风险…"
          style={{
            width: '100%',
            maxWidth: 420,
            padding: '10px 14px',
            border: '1.5px solid #e5e7eb',
            borderRadius: 12,
            fontSize: 14,
            fontFamily: 'inherit',
          }}
        />
      </div>

      {cases.loading && !all.length ? (
        <p className="eval-muted">加载中…</p>
      ) : !grouped.length ? (
        <div className="eval-card">
          <p className="eval-muted">没有匹配的用例。确认 Gateway 已启动且完成 v108 设计目录迁移。</p>
        </div>
      ) : (
        grouped.map((g) => (
          <div className="eval-card" key={g.key}>
            <h3>
              <span className="eval-badge run">{g.label}</span> {g.items.length} 条
            </h3>
            {g.items.map((c) => (
              <CaseCard key={c.id} c={c} />
            ))}
          </div>
        ))
      )}
    </>
  )
}
