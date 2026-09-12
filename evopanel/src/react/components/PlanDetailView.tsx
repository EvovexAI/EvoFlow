import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { getAgentsDisplayCache } from '../../lib/agents-display-cache.js'
import { planViewFromStructuredInput } from '../../lib/plan-from-task.js'
import { resolveSubtaskAgentDisplayLabel } from '../../lib/tool-display.js'
import type { ParsedPlan, ParsedPlanStep, PlanStepField } from '../lib/parse-plan-markdown.js'
import { resolvePlanFlowchartMermaid } from '../lib/parse-plan-markdown.js'
import { PlanFlowchart } from './PlanFlowchart.js'
import { AssignedAgentAvatar } from './AssignedAgentAvatar.js'

function stepAssigneeLabel(step: ParsedPlanStep): string {
  const code = String(step.assignee || '').trim()
  const hint = String(step.assigneeDisplay || '').trim()
  if (!code && !hint) return ''
  return resolveSubtaskAgentDisplayLabel(code, hint, getAgentsDisplayCache()) || code || hint
}

function PlanStepNavLabel({ step }: { step: ParsedPlanStep }) {
  const agent = stepAssigneeLabel(step)
  const agentCode = String(step.assignee || '').trim()
  const task = step.shortName || `步骤 ${step.ref}`
  if (!agent) {
    return <span className="plan-detail-step-nav-label">{task}</span>
  }
  return (
    <span className="plan-detail-step-nav-label">
      <span className="react-chat-subtask-agent-ico" aria-hidden="true">
        <AssignedAgentAvatar agentCode={agentCode} agents={getAgentsDisplayCache()} size={16} />
      </span>
      <span className="plan-detail-step-nav-agent">{agent}</span>
      <span className="react-chat-subtask-head-sep" aria-hidden="true">
        ·
      </span>
      <span className="plan-detail-step-nav-task">{task}</span>
    </span>
  )
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <span className="plan-detail-icon" aria-hidden="true">
      {children}
    </span>
  )
}

function IconGoal() {
  return (
    <Icon>
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="10" cy="10" r="7" />
        <circle cx="10" cy="10" r="3" fill="currentColor" stroke="none" />
      </svg>
    </Icon>
  )
}

function IconFlow() {
  return (
    <Icon>
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M4 6h4v4H4zM12 10h4v4h-4z" />
        <path d="M8 8l4 2" strokeLinecap="round" />
      </svg>
    </Icon>
  )
}

function IconSteps() {
  return (
    <Icon>
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M5 5h10M5 10h7M5 15h10" strokeLinecap="round" />
      </svg>
    </Icon>
  )
}

function IconCheck() {
  return (
    <Icon>
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M6 10l3 3 5-6" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="3" y="3" width="14" height="14" rx="2" />
      </svg>
    </Icon>
  )
}

function IconQuestion() {
  return (
    <Icon>
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="10" cy="10" r="7" />
        <path d="M10 7.2v.01M9.2 10.2a.8.8 0 101.6 0 .8.8 0 00-1.6 0z" strokeLinecap="round" />
      </svg>
    </Icon>
  )
}

function fieldIcon(key: string) {
  const common = { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }
  switch (key) {
    case 'goal':
      return (
        <svg {...common}>
          <path d="M8 3v10M5 6l3-3 3 3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'description':
      return (
        <svg {...common}>
          <path d="M3 4h10M3 8h10M3 12h6" strokeLinecap="round" />
        </svg>
      )
    case 'inputs':
      return (
        <svg {...common}>
          <path d="M3 8h10M8 3v10" strokeLinecap="round" />
        </svg>
      )
    case 'outputs':
      return (
        <svg {...common}>
          <path d="M3 8h7l3 3V5l-3 3H3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'acceptance':
      return (
        <svg {...common}>
          <path d="M4 8l3 3 5-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'failure':
      return (
        <svg {...common}>
          <path d="M8 4v5M8 11v1" strokeLinecap="round" />
          <circle cx="8" cy="8" r="6" />
        </svg>
      )
    case 'instruction':
      return (
        <svg {...common}>
          <path d="M4 4h8v8H4z" strokeLinejoin="round" />
          <path d="M6 7h4M6 9.5h3" strokeLinecap="round" />
        </svg>
      )
    case 'tools':
    case 'skills':
      return (
        <svg {...common}>
          <path d="M4 6h8M4 10h5" strokeLinecap="round" />
        </svg>
      )
    case 'model':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5" />
          <path d="M5.5 8h5" strokeLinecap="round" />
        </svg>
      )
    case 'project_path':
      return (
        <svg {...common}>
          <path d="M3 5h4l1 1h5v7H3z" strokeLinejoin="round" />
        </svg>
      )
    case 'work_checklist':
      return (
        <svg {...common}>
          <path d="M4 5h8M4 8h8M4 11h5" strokeLinecap="round" />
          <path d="M11 11l1 1 2-2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'assignee':
      return (
        <svg {...common}>
          <circle cx="8" cy="5.5" r="2.5" />
          <path d="M3 13c0-2.2 2.2-4 5-4s5 1.8 5 4" strokeLinecap="round" />
        </svg>
      )
    case 'depends':
      return (
        <svg {...common}>
          <path d="M4 6h4v4H4zM9 9h3v3H9z" strokeLinejoin="round" />
          <path d="M8 8h1" strokeLinecap="round" />
        </svg>
      )
    default:
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="2" />
        </svg>
      )
  }
}

function PlanSection({
  icon,
  title,
  badge,
  children,
}: {
  icon: ReactNode
  title: string
  badge?: string
  children: ReactNode
}) {
  return (
    <section className="plan-detail-section">
      <header className="plan-detail-section-head">
        {icon}
        <h3 className="plan-detail-section-title">{title}</h3>
        {badge ? <span className="plan-detail-section-badge">{badge}</span> : null}
      </header>
      <div className="plan-detail-section-body">{children}</div>
    </section>
  )
}

function PlanFieldRow({ field }: { field: PlanStepField }) {
  const lines = field.value.split('\n').map((l) => l.trim()).filter(Boolean)
  return (
    <div className={`plan-detail-field plan-detail-field--${field.key}`}>
      <div className="plan-detail-field-label">
        <span className="plan-detail-field-icon" aria-hidden="true">
          {fieldIcon(field.key)}
        </span>
        <span className="plan-detail-field-label-text">{field.label}</span>
      </div>
      <div className="plan-detail-field-value">
        {lines.length > 1 ? (
          <ul className="plan-detail-field-list">
            {lines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        ) : (
          <p>{lines[0] || field.value}</p>
        )}
      </div>
    </div>
  )
}

function stepDetailFields(step: ParsedPlanStep): PlanStepField[] {
  const rows: PlanStepField[] = step.fields.filter((f) => f.key !== 'assignee')
  if (step.dependsOn.length > 0) {
    rows.unshift({
      key: 'depends',
      label: '依赖步骤',
      value: step.dependsOn.map((d) => `Step ${d}`).join(', '),
    })
  }
  return rows
}

function PlanStepDetailPanel({ step }: { step: ParsedPlanStep }) {
  const fields = stepDetailFields(step)
  return (
    <article className="plan-detail-step-panel plan-detail-step-panel--detail-only">
      <div className="plan-detail-step-fields">
        {fields.length ? (
          fields.map((f) => <PlanFieldRow key={f.key} field={f} />)
        ) : (
          <p className="plan-detail-empty plan-detail-empty--in-panel">（该步骤未填写详细字段）</p>
        )}
      </div>
    </article>
  )
}

function PlanStepsMasterDetail({ steps }: { steps: ParsedPlanStep[] }) {
  const sorted = useMemo(
    () =>
      [...steps].sort((a, b) => {
        const ra = parseInt(String(a.ref).replace(/\D/g, ''), 10)
        const rb = parseInt(String(b.ref).replace(/\D/g, ''), 10)
        if (Number.isFinite(ra) && Number.isFinite(rb) && ra !== rb) return ra - rb
        return String(a.ref).localeCompare(String(b.ref), undefined, { numeric: true })
      }),
    [steps],
  )
  const [activeRef, setActiveRef] = useState(() => String(sorted[0]?.ref || ''))
  useEffect(() => {
    if (!sorted.length) return
    const exists = sorted.some((s) => String(s.ref) === activeRef)
    if (!exists) queueMicrotask(() => setActiveRef(String(sorted[0].ref)))
  }, [sorted, activeRef])
  const active = sorted.find((s) => String(s.ref) === activeRef) || sorted[0]

  if (!sorted.length) {
    return <p className="plan-detail-empty">（未解析到步骤）</p>
  }

  return (
    <div className="plan-detail-steps-layout">
      <nav className="plan-detail-steps-nav" aria-label="计划步骤">
        {sorted.map((s) => {
          const isActive = String(s.ref) === String(active?.ref || '')
          const agent = stepAssigneeLabel(s)
          const task = s.shortName || `步骤 ${s.ref}`
          return (
            <button
              key={String(s.ref)}
              type="button"
              className={`plan-detail-step-nav-item${isActive ? ' is-active' : ''}`}
              title={agent ? `${agent} · ${task}` : task}
              onClick={() => setActiveRef(String(s.ref))}
            >
              <span className="plan-detail-step-nav-num">{s.ref}</span>
              <PlanStepNavLabel step={s} />
            </button>
          )
        })}
      </nav>
      <div className="plan-detail-steps-panel">{active ? <PlanStepDetailPanel step={active} /> : null}</div>
    </div>
  )
}

export type StructuredPlanInput = {
  goal?: string
  flowchartMermaid?: string
  steps?: Array<Record<string, unknown>>
  validation?: string[]
  openQuestions?: string
}

export function PlanDetailView({ plan: planProp }: { plan?: StructuredPlanInput | null }) {
  const plan: ParsedPlan = useMemo(() => {
    const fromInput = planViewFromStructuredInput(
      planProp ? (planProp as Record<string, unknown>) : null,
    )
    return (
      fromInput || {
        goal: '',
        flowchartMermaid: '',
        steps: [],
        validation: [],
        openQuestions: '无',
      }
    )
  }, [planProp])
  const hasStructure = Boolean(plan.goal || plan.steps.length)
  const flowchart = useMemo(
    () => resolvePlanFlowchartMermaid(plan.flowchartMermaid, plan.steps),
    [plan.flowchartMermaid, plan.steps],
  )

  if (!hasStructure) {
    return (
      <div className="plan-detail-doc plan-detail-doc--fallback">
        <p className="plan-detail-empty">（无计划内容）</p>
      </div>
    )
  }

  return (
    <div className="plan-detail-doc">
      <PlanSection icon={<IconGoal />} title="目标">
        <p className="plan-detail-goal-text">{plan.goal || '（未填写）'}</p>
      </PlanSection>

      {flowchart.code || plan.steps.length > 0 ? (
        <PlanSection icon={<IconFlow />} title="任务分析图">
          <p className="plan-detail-analysis-intro">
            计划阶段对任务对象的分析结果（步骤依赖与数据流），供后续执行时对照。
          </p>
          <PlanFlowchart code={flowchart.code} synthesized={flowchart.synthesized} />
        </PlanSection>
      ) : null}

      <PlanSection
        icon={<IconSteps />}
        title="执行步骤"
        badge={plan.steps.length ? `${plan.steps.length} 项` : undefined}
      >
        <PlanStepsMasterDetail steps={plan.steps} />
      </PlanSection>

      {plan.validation.length > 0 ? (
        <PlanSection icon={<IconCheck />} title="整体验收">
          <ul className="plan-detail-list">
            {plan.validation.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </PlanSection>
      ) : null}

      <PlanSection icon={<IconQuestion />} title="待确认事项">
        <p className="plan-detail-open-q">{plan.openQuestions || '无'}</p>
      </PlanSection>
    </div>
  )
}
