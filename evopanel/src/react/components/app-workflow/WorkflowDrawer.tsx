import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import {
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Layers,
  MessageSquareText,
  Play,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  Workflow,
} from 'lucide-react'
import {
  STEP_FIELD_MAP,
  type AppWorkflowStep,
  type StepNodeData,
} from '../../lib/app-workflow-plan.ts'
import { ANSWER_NODE_ID, START_NODE_ID } from '../../lib/app-workflow-flow.ts'
import { parseCsvField, joinCsvField } from '../../lib/workflow-step-csv.ts'
import {
  agentCapabilitySummary,
  normalizeAgentTags,
  tagMetaForLabel,
  type AgentPickerRow,
} from '../../lib/agent-tags.ts'
import { labelSkills, resolveAgentToolsDisplay } from '../../lib/agent-caps-display.ts'
import { useWorkflowResources } from '../../hooks/useWorkflowResources.ts'
import { type SkillSelection } from '../SkillPickerModal.tsx'
import { AgentPickerModal } from './AgentPickerModal.tsx'
import { CapabilityPickerModal } from './CapabilityPickerModal.tsx'
import InsertChipBar from './InsertChipBar.tsx'
import { SlashVarTextarea, type SlashVarItem } from './SlashVarTextarea.tsx'
import { WorkspaceFolderInput } from './WorkspaceFolderInput.tsx'
import { RunVarsPanel } from './RunVarsPanel.tsx'
import AssignedAgentAvatar from '../AssignedAgentAvatar.tsx'
import WorkflowNodeAvatar from './WorkflowNodeAvatar.tsx'
import { resolveWorkflowAgent } from './WorkflowStepAgentHead.tsx'

type TabId = 'library' | 'config'
/** library = 左侧节点库；config = 右侧上下文配置（无 Tab） */
export type WorkflowDrawerPanelRole = 'library' | 'config'

export type AppParamSlot = {
  name: string
  label?: string
  type?: string
  required?: boolean
}

export type UpstreamStepRef = {
  ref: string
  name: string
}

type Props = {
  open: boolean
  onToggle: () => void
  /** @deprecated 使用 panelRole；保留以兼容旧调用 */
  tab?: TabId
  onTabChange?: (tab: TabId) => void
  /** 固定面板角色：左侧库 / 右侧配置 */
  panelRole?: WorkflowDrawerPanelRole
  selectedId: string | null
  selectedStep: StepNodeData | null
  workflowGoal: string
  onWorkflowGoalChange: (goal: string) => void
  onStepChange: (patch: Partial<AppWorkflowStep>) => void
  onAddStep: () => void
  onAddStepWithAgent?: (agentCode: string) => void
  onAddAnswer?: () => void
  onDeleteSelected: () => void
  hasSelection: boolean
  onOpenAppSettings?: () => void
  /** HTML5 DnD mime type for dragging Agent step onto canvas */
  dndType?: string
  /** Step ref currently wired into the answer node (if any) */
  answerSourceRef?: string
  /** App-level run parameters (filled on 运行页 / OpenAPI variables) */
  appParameters?: AppParamSlot[]
  /** Direct upstream steps for the selected node */
  upstreamSteps?: UpstreamStepRef[]
}

function appendBlock(current: string | undefined, insert: string): string {
  const cur = String(current || '')
  const piece = String(insert || '').trim()
  if (!piece) return cur
  if (!cur.trim()) return piece
  const needsGap = !/\s$/.test(cur)
  return `${cur}${needsGap ? '\n' : ''}${piece}`
}

function appendInline(current: string | undefined, insert: string): string {
  const cur = String(current || '')
  const piece = String(insert || '').trim()
  if (!piece) return cur
  if (!cur.trim()) return piece
  return `${cur}${/\s$/.test(cur) ? '' : ' '}${piece}`
}

function hasText(v?: string | null) {
  return !!(v && String(v).trim())
}

function DrawerPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="wf-drawer-panel">
      <h4 className="wf-drawer-panel-title">{title}</h4>
      {children}
    </section>
  )
}

function FieldBadge({ kind }: { kind: 'suggest' | 'optional' }) {
  return (
    <span className={`wf-field-badge wf-field-badge--${kind}`}>
      {kind === 'suggest' ? '建议填' : '可选'}
    </span>
  )
}

function FoldSection({
  title,
  subtitle,
  open,
  onToggle,
  children,
}: {
  title: string
  subtitle?: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <section className="wf-drawer-panel wf-drawer-panel--fold">
      <button
        type="button"
        className="wf-drawer-fold-head"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className="wf-drawer-fold-title-wrap">
          <span>{title}</span>
          {subtitle ? <small className="wf-drawer-fold-sub">{subtitle}</small> : null}
        </span>
        <ChevronRight size={14} className={`wf-drawer-fold-icon${open ? ' is-open' : ''}`} />
      </button>
      {open ? <div className="wf-drawer-fold-body">{children}</div> : null}
    </section>
  )
}

function ResourceRow({
  icon,
  label,
  summary,
  badge,
  onClick,
}: {
  icon: ReactNode
  label: string
  summary: string
  badge?: 'suggest' | 'optional'
  onClick: () => void
}) {
  return (
    <button type="button" className="wf-drawer-resource" onClick={onClick}>
      <span className="wf-drawer-resource-icon">{icon}</span>
      <span className="wf-drawer-resource-copy">
        <strong>
          {label}
          {badge ? <FieldBadge kind={badge} /> : null}
        </strong>
        <small>{summary}</small>
      </span>
      <ChevronRight size={14} className="wf-drawer-resource-arrow" />
    </button>
  )
}

/** 高级设置字段（新手基本不用，默认收起） */
const ADVANCED_DETAIL_KEYS = [
  'instruction',
  'inputs',
  'outputs',
  'acceptance',
  'failure',
  'description',
  'model',
  'project_path',
] as const

export function WorkflowDrawer({
  open,
  onToggle,
  tab: tabProp,
  onTabChange: _onTabChange,
  panelRole,
  selectedId,
  selectedStep,
  workflowGoal,
  onWorkflowGoalChange,
  onStepChange,
  onAddStep,
  onAddStepWithAgent,
  onAddAnswer,
  onDeleteSelected,
  hasSelection,
  onOpenAppSettings,
  dndType = 'application/evoflow-wf-node',
  answerSourceRef = '',
  appParameters = [],
  upstreamSteps = [],
}: Props) {
  const role: WorkflowDrawerPanelRole = panelRole || tabProp || 'library'
  const tab: TabId = role
  const { agents, skills, tools, mcpServers, loading } = useWorkflowResources(open)
  const [agentOpen, setAgentOpen] = useState(false)
  const [capOpen, setCapOpen] = useState(false)
  const [libSearch, setLibSearch] = useState('')
  const [agentSearch, setAgentSearch] = useState('')
  /** 本智能体自带能力区域折叠 */
  const [capsFold, setCapsFold] = useState(true)
  /** 能力配置折叠区（默认展开，相对常用） */
  const [capSectionOpen, setCapSectionOpen] = useState(true)
  /** 高级设置折叠区（默认收起，新手基本不用） */
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const agentSummary = useMemo(() => {
    if (!selectedStep?.assigned_agent) return '未选 · 点此选择谁执行本步'
    return resolveWorkflowAgent(agents, selectedStep.assigned_agent).label
  }, [agents, selectedStep])

  const selectedAgentRow = useMemo(() => {
    const code = String(selectedStep?.assigned_agent || '').trim()
    if (!code) return null
    return agents.find((a) => String(a.agent_code || '') === code) || null
  }, [agents, selectedStep])

  const selectedAgentCaps = useMemo(
    () => agentCapabilitySummary(selectedAgentRow, 24),
    [selectedAgentRow],
  )

  const skillTags = useMemo(
    () => labelSkills(selectedAgentCaps.skills, skills),
    [selectedAgentCaps.skills, skills],
  )
  const toolDisplay = useMemo(
    () => resolveAgentToolsDisplay(selectedAgentRow, tools, 24),
    [selectedAgentRow, tools],
  )

  const paramChips = useMemo(
    () =>
      (appParameters || [])
        .map((p) => {
          const name = String(p?.name || '').trim()
          if (!name) return null
          const label = String(p?.label || name).trim() || name
          return {
            id: name,
            label,
            insert: `{{${name}}}`,
            title: `插入 {{${name}}}（运行页由用户填写）`,
          }
        })
        .filter(Boolean) as { id: string; label: string; insert: string; title: string }[],
    [appParameters],
  )

  const slashVarItems = useMemo(() => {
    const vars: SlashVarItem[] = paramChips.map((c) => ({
      id: `var:${c.id}`,
      label: c.label,
      insert: c.insert,
      group: '用户输入',
      hint: c.id,
    }))
    for (const u of upstreamSteps || []) {
      const ref = String(u.ref || '').trim()
      if (!ref) continue
      const name = String(u.name || '').trim() || `步骤 ${ref}`
      vars.push({
        id: `up:${ref}`,
        label: name,
        insert: `请基于前置步骤 ${ref}（${name}）的产出继续完成当前任务。`,
        group: '前置步骤',
        hint: `步骤 ${ref}`,
      })
    }
    return vars
  }, [paramChips, upstreamSteps])

  const runVars = useMemo(
    () =>
      (appParameters || [])
        .map((p) => {
          const name = String(p?.name || '').trim()
          if (!name) return null
          return {
            name,
            label: String(p?.label || name).trim() || name,
            type: String(p?.type || 'text'),
            required: p?.required !== false,
          }
        })
        .filter(Boolean) as {
        name: string
        label: string
        type: string
        required: boolean
      }[],
    [appParameters],
  )

  const upstreamChips = useMemo(
    () =>
      (upstreamSteps || []).map((u) => {
        const ref = String(u.ref || '').trim()
        const name = String(u.name || '').trim() || `步骤 ${ref}`
        return {
          id: ref,
          label: name,
          insert: `请基于前置步骤 ${ref}（${name}）的产出继续完成当前任务。`,
          title: `引用前置步骤 ${ref}`,
        }
      }),
    [upstreamSteps],
  )

  const skillSelected = useMemo<SkillSelection[]>(() => {
    if (!selectedStep) return []
    return parseCsvField(selectedStep.skills).map((name) => {
      const hit = skills.find((s) => s.name === name)
      return { name, label: hit?.label || name, icon: hit?.icon || '🧩' }
    })
  }, [selectedStep, skills])
  const toolSelected = useMemo(() => parseCsvField(selectedStep?.tools), [selectedStep?.tools])
  const mcpSelected = useMemo(() => parseCsvField(selectedStep?.mcp_servers), [selectedStep?.mcp_servers])

  const taskText = selectedStep?.goal || selectedStep?.description || ''
  const hasAgent = hasText(selectedStep?.assigned_agent)
  const capCount = skillSelected.length + toolSelected.length + mcpSelected.length
  useEffect(() => {
    // 换节点时：能力配置区默认展开，高级设置区默认收起
    // 已有挂载能力时能力配置区展开，否则也收起保持界面简洁
    if (!selectedStep) {
      queueMicrotask(() => {
        setCapSectionOpen(false)
        setAdvancedOpen(false)
      })
      return
    }
    const caps =
      parseCsvField(selectedStep.skills).length +
      parseCsvField(selectedStep.tools).length +
      parseCsvField(selectedStep.mcp_servers).length
    // 延迟到微任务末尾，等 DOM 尺寸稳定后再切换折叠状态
    queueMicrotask(() => {
      setCapSectionOpen(caps > 0)
      setAdvancedOpen(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  const libNodes = useMemo(() => {
    const q = libSearch.trim().toLowerCase()
    const items = [
      {
        id: 'start',
        title: '流程开始',
        desc: '固定触发节点',
        tone: 'trigger' as const,
        icon: <Play size={16} />,
        static: true,
      },
      {
        id: 'answer',
        title: '最终答案',
        desc: '指定哪一步结果给用户看',
        tone: 'trigger' as const,
        icon: <MessageSquareText size={16} />,
        onClick: onAddAnswer,
        draggable: true,
        dragKind: 'answer',
      },
      {
        id: 'agent',
        title: '智能体步骤',
        desc: '选智能体并写本步要做什么',
        tone: 'action' as const,
        icon: <Workflow size={16} />,
        onClick: onAddStep,
        draggable: true,
        dragKind: 'agent-step',
      },
    ]
    return q ? items.filter((i) => i.title.toLowerCase().includes(q) || i.desc.toLowerCase().includes(q)) : items
  }, [libSearch, onAddStep, onAddAnswer])

  const filteredAgents = useMemo<AgentPickerRow[]>(() => {
    const q = (agentSearch || libSearch).trim().toLowerCase()
    if (!q) return agents
    return agents.filter((a) => {
      const code = String(a.agent_code || '').toLowerCase()
      const name = String(a.agent_name || '').toLowerCase()
      const desc = String(a.description || '').toLowerCase()
      const tagText = normalizeAgentTags(a.tags).join(' ').toLowerCase()
      return code.includes(q) || name.includes(q) || desc.includes(q) || tagText.includes(q)
    })
  }, [agents, agentSearch, libSearch])

  const isStart = selectedId === START_NODE_ID
  const isAnswer = selectedId === ANSWER_NODE_ID
  const isStep = !!selectedStep && !isStart && !isAnswer
  const isConfigPanel = role === 'config'
  const isLibraryPanel = role === 'library'

  const skillSummary =
    skillSelected.length > 0
      ? skillSelected.map((s) => s.label).join('、')
      : ''
  const toolLabelByName = useMemo(() => {
    const map = new Map<string, string>()
    for (const t of tools) map.set(t.value, t.label || t.value)
    return map
  }, [tools])
  const toolSummary =
    toolSelected.length > 0
      ? toolSelected.map((n) => toolLabelByName.get(n) || n).join('、')
      : ''
  const capSummary =
    skillSelected.length || toolSelected.length
      ? [
          skillSelected.length ? `技能 ${skillSelected.length}` : '',
          toolSelected.length ? `工具 ${toolSelected.length}` : '',
        ]
          .filter(Boolean)
          .join(' · ') +
        (skillSummary || toolSummary
          ? `（${[skillSummary, toolSummary].filter(Boolean).join('；')}）`
          : '')
      : '不选也能跑 · 点此挂载技能 / 工具'

  const body = open ? (
    <>
      <div className="wf-drawer-body">
        {tab === 'library' ? (
          <>
            <div className="wf-drawer-search-wrap">
              <Search size={15} className="wf-drawer-search-icon" aria-hidden />
              <input
                className="wf-drawer-search"
                placeholder="搜索节点或智能体…"
                value={libSearch}
                onChange={(e) => setLibSearch(e.target.value)}
              />
            </div>

            <div className="wf-drawer-section">
              <div className="wf-drawer-section-head">
                <span className="wf-drawer-section-title">系统节点</span>
                <span className="wf-drawer-section-badge">
                  {libNodes.filter((n) => n.tone === 'trigger').length}
                </span>
              </div>
              {libNodes
                .filter((n) => n.tone === 'trigger')
                .map((n) =>
                  n.static ? (
                    <div key={n.id} className="wf-drawer-lib-card wf-drawer-lib-row wf-drawer-lib-card--static">
                      <WorkflowNodeAvatar tone={n.tone} size="md">
                        {n.icon}
                      </WorkflowNodeAvatar>
                      <div className="wf-drawer-lib-copy">
                        <span className="wf-drawer-lib-name">{n.title}</span>
                        <span className="wf-drawer-lib-desc">{n.desc}</span>
                      </div>
                      <span className="wf-drawer-lib-tag">固定</span>
                    </div>
                  ) : (
                    <button
                      key={n.id}
                      type="button"
                      className="wf-drawer-lib-card wf-drawer-lib-row"
                      draggable={!!n.draggable}
                      onDragStart={(e) => {
                        if (!n.dragKind) return
                        e.dataTransfer.setData(dndType, n.dragKind)
                        e.dataTransfer.effectAllowed = 'copy'
                      }}
                      onClick={n.onClick}
                    >
                      <WorkflowNodeAvatar tone={n.tone} size="md">
                        {n.icon}
                      </WorkflowNodeAvatar>
                      <div className="wf-drawer-lib-copy">
                        <span className="wf-drawer-lib-name">{n.title}</span>
                        <span className="wf-drawer-lib-desc">{n.desc}</span>
                      </div>
                      <span className="wf-drawer-lib-add" aria-hidden>
                        <Plus size={14} />
                      </span>
                    </button>
                  ),
                )}
            </div>

            <div className="wf-drawer-section">
              <div className="wf-drawer-section-head">
                <span className="wf-drawer-section-title">可执行步骤</span>
                <span className="wf-drawer-section-badge">
                  {libNodes.filter((n) => n.tone === 'action').length}
                </span>
              </div>
              {libNodes
                .filter((n) => n.tone === 'action')
                .map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    className="wf-drawer-lib-card wf-drawer-lib-row"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(dndType, 'agent-step')
                      e.dataTransfer.effectAllowed = 'copy'
                    }}
                    onClick={n.onClick}
                  >
                    <WorkflowNodeAvatar tone={n.tone} size="md">
                      {n.icon}
                    </WorkflowNodeAvatar>
                    <div className="wf-drawer-lib-copy">
                      <span className="wf-drawer-lib-name">{n.title}</span>
                      <span className="wf-drawer-lib-desc">{n.desc}</span>
                    </div>
                    <span className="wf-drawer-lib-add" aria-hidden>
                      <Plus size={14} />
                    </span>
                  </button>
                ))}
            </div>

            <div className="wf-drawer-section wf-drawer-section--agents">
              <div className="wf-drawer-section-head">
                <span className="wf-drawer-section-title">智能体</span>
                <span className="wf-drawer-section-badge">
                  {filteredAgents.length}
                </span>
              </div>
              <p className="wf-drawer-section-hint">拖到画布直接创建对应智能体的步骤</p>
              <div className="wf-drawer-agent-search-wrap">
                <Search size={13} className="wf-drawer-agent-search-icon" aria-hidden />
                <input
                  className="wf-drawer-agent-search"
                  placeholder="搜索智能体…"
                  value={agentSearch}
                  onChange={(e) => setAgentSearch(e.target.value)}
                  aria-label="搜索智能体"
                />
              </div>
              {loading ? (
                <div className="wf-drawer-lib-empty">智能体加载中…</div>
              ) : filteredAgents.length === 0 ? (
                <div className="wf-drawer-lib-empty">
                  {agentSearch.trim() ? `未找到「${agentSearch.trim()}」` : '没有匹配的智能体'}
                </div>
              ) : (
                <div className="wf-drawer-agent-list">
                  {filteredAgents.map((a) => {
                    const code = String(a.agent_code || '')
                    const name = String(a.agent_name || code)
                    const caps = agentCapabilitySummary(a, 3)
                    const tags = normalizeAgentTags(a.tags).slice(0, 1)
                    return (
                      <button
                        key={code}
                        type="button"
                        className="wf-drawer-lib-card wf-drawer-lib-row wf-drawer-agent-item"
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData(dndType, `agent:${code}`)
                          e.dataTransfer.effectAllowed = 'copy'
                        }}
                        onClick={() => {
                          if (onAddStepWithAgent) {
                            onAddStepWithAgent(code)
                          } else {
                            onAddStep()
                            requestAnimationFrame(() => {
                              onStepChange({ assigned_agent: code })
                            })
                          }
                        }}
                        title={name}
                      >
                        <span className="wf-drawer-agent-avatar" aria-hidden>
                          <AssignedAgentAvatar agentCode={code} agents={agents} size={32} />
                        </span>
                        <div className="wf-drawer-lib-copy">
                          <div className="wf-drawer-lib-title-row">
                            <span className="wf-drawer-lib-name" title={name}>
                              {name}
                            </span>
                            {tags.length > 0 ? (
                              <span className="react-chat-skill-item-tags wf-drawer-lib-tags">
                                {tags.map((label) => {
                                  const meta = tagMetaForLabel(label)
                                  return (
                                    <span
                                      key={label}
                                      className="react-chat-skill-item-tag"
                                      style={
                                        {
                                          ['--tag-color' as string]: meta.color || '#64748b',
                                        } as CSSProperties
                                      }
                                      title={label}
                                    >
                                      {meta.icon ? `${meta.icon} ` : ''}
                                      {label}
                                    </span>
                                  )
                                })}
                              </span>
                            ) : null}
                          </div>
                          <span className="wf-drawer-lib-desc">
                            {caps.description || code}
                          </span>
                        </div>
                        <span className="wf-drawer-lib-add" aria-hidden>
                          <Plus size={14} />
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </>
        ) : null}

        {tab === 'config' ? (
          <>
            {!selectedId ? (
              <div className="wf-drawer-empty">
                <div className="wf-drawer-empty-icon">
                  <Sparkles size={20} />
                </div>
                <p>在画布点选一个节点进行配置</p>
                <span>智能体步骤：谁来做、做什么</span>
              </div>
            ) : null}

            {(isStart || !selectedId) && (
              <DrawerPanel title="工作流">
                <label className="wf-drawer-label" htmlFor="wf-drawer-goal">
                  整体目标
                </label>
                <textarea
                  id="wf-drawer-goal"
                  className="wf-drawer-control wf-drawer-control--area"
                  rows={3}
                  value={workflowGoal}
                  placeholder="描述工作流要达成的总体目标…"
                  onChange={(e) => onWorkflowGoalChange(e.target.value)}
                />
              </DrawerPanel>
            )}

            {(isStart || !selectedId) && (
              <DrawerPanel title="用户输入项">
                <RunVarsPanel vars={runVars} onManage={onOpenAppSettings} />
              </DrawerPanel>
            )}

            {isStart ? (
              <p className="wf-drawer-tip">从「流程开始」连到第一个智能体步骤。步骤说明里输入 / 可插入上面的用户输入项。</p>
            ) : null}

            {isAnswer ? (
              <DrawerPanel title="最终答案">
                <p className="wf-drawer-tip" style={{ margin: 0 }}>
                  把某一个 <strong>智能体步骤</strong> 的输出连到本节点。运行页与对外接口返回的答案都会取该步结果。
                </p>
                <p className="wf-drawer-tip" style={{ marginTop: 10 }}>
                  {answerSourceRef
                    ? `当前取自步骤 ${answerSourceRef}`
                    : '尚未连入步骤 — 从步骤右侧拖线到「最终答案」'}
                </p>
              </DrawerPanel>
            ) : null}

            {isStep && selectedStep ? (
              <>
                {upstreamSteps.length > 0 ? (
                  <div className="wf-drawer-upstream-banner" role="note">
                    前置步骤完成后会自动把结果传给本步。点下方芯片可快速写入「请基于上一步…」的说明。
                  </div>
                ) : null}

                <DrawerPanel title="基础信息">
                  <ResourceRow
                    icon={<Bot size={15} />}
                    label="1. 谁来做"
                    summary={agentSummary}
                    badge="suggest"
                    onClick={() => setAgentOpen(true)}
                  />
                  {hasAgent ? (
                    <div className="wf-drawer-agent-caps wf-drawer-agent-caps--panel">
                      <div
                        className="wf-drawer-agent-caps-head"
                        onClick={() => setCapsFold((v) => !v)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCapsFold((v) => !v) } }}
                        style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                      >
                        <span>本智能体自带能力</span>
                        {capsFold ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                      </div>
                      {!capsFold && (<>
                      {selectedAgentCaps.description ? (
                        <p className="wf-drawer-agent-caps-desc">
                          {selectedAgentCaps.description}
                        </p>
                      ) : (
                        <p className="wf-drawer-agent-caps-desc is-muted">暂无文字描述</p>
                      )}
                      <div className="wf-drawer-cap-block">
                        <div className="wf-drawer-cap-block-label">
                          技能
                          {selectedAgentCaps.skillTotal
                            ? ` · ${selectedAgentCaps.skillTotal}`
                            : ''}
                        </div>
                        {skillTags.length ? (
                          <div className="wf-drawer-cap-tags">
                            {skillTags.map((s) => (
                              <span key={s.id} className="wf-drawer-cap-tag" title={s.id}>
                                {s.label}
                              </span>
                            ))}
                            {selectedAgentCaps.skillsMore > 0 ? (
                              <span className="wf-drawer-cap-tag is-more">
                                +{selectedAgentCaps.skillsMore}
                              </span>
                            ) : null}
                          </div>
                        ) : (
                          <p className="wf-drawer-tip" style={{ margin: 0 }}>
                            未单独配置技能
                          </p>
                        )}
                      </div>
                      <div className="wf-drawer-cap-block">
                        <div className="wf-drawer-cap-block-label">
                          工具
                          {toolDisplay.total ? ` · ${toolDisplay.total}` : ''}
                          {toolDisplay.mode === 'default' ? ' · 默认包' : ''}
                        </div>
                        {toolDisplay.tags.length ? (
                          <div className="wf-drawer-cap-tags">
                            {toolDisplay.tags.map((t) => (
                              <span key={t.id} className="wf-drawer-cap-tag" title={t.id}>
                                {t.label}
                              </span>
                            ))}
                            {toolDisplay.more > 0 ? (
                              <span className="wf-drawer-cap-tag is-more">+{toolDisplay.more}</span>
                            ) : null}
                          </div>
                        ) : (
                          <p className="wf-drawer-tip" style={{ margin: 0 }}>
                            工具列表加载中…
                          </p>
                        )}
                        {toolDisplay.mode === 'default' ? (
                          <p className="wf-drawer-tip" style={{ margin: '6px 0 0' }}>
                            未单独限制工具，显示系统默认可用工具。
                          </p>
                        ) : null}
                      </div>
                      </>
                      )}
                      <button
                        type="button"
                        className="wf-drawer-text-btn"
                        onClick={() => setAgentOpen(true)}
                      >
                        更换智能体 / 查看完整列表
                      </button>
                      <p className="wf-drawer-tip" style={{ margin: '6px 0 0' }}>
                        「可选」里另挂的技能/工具是本步额外覆盖，不会替换上面的默认能力。
                      </p>
                    </div>
                  ) : (
                    <p className="wf-drawer-tip" style={{ marginTop: 8 }}>
                      先点上方选一个智能体，即可在此查看自带技能与工具。
                    </p>
                  )}

                  <div className="wf-drawer-field" style={{ marginTop: 14 }}>
                    <label className="wf-drawer-label" htmlFor="wf-drawer-task">
                      2. 做什么
                      <FieldBadge kind="suggest" />
                    </label>
                    <SlashVarTextarea
                      id="wf-drawer-task"
                      className="wf-drawer-control wf-drawer-control--area wf-drawer-control--task"
                      rows={7}
                      value={taskText}
                      placeholder="用白话写本步目标… 输入 / 引用变量（同 FastGPT）"
                      items={slashVarItems}
                      onChange={(next) => onStepChange({ goal: next })}
                    />
                    <InsertChipBar
                      label="运行变量"
                      hint="也可点选插入 · 或输入 /"
                      chips={paramChips}
                      onInsert={(text) =>
                        onStepChange({ goal: appendInline(selectedStep.goal || taskText, text) })
                      }
                      emptyText="还没有用户输入项"
                      emptyActionLabel="去添加"
                      onEmptyAction={onOpenAppSettings}
                    />
                    {upstreamChips.length ? (
                      <InsertChipBar
                        label="引用前置步骤"
                        hint="写入步骤说明"
                        chips={upstreamChips}
                        showToken={false}
                        onInsert={(text) =>
                          onStepChange({ goal: appendBlock(selectedStep.goal || taskText, text) })
                        }
                      />
                    ) : null}
                  </div>
                </DrawerPanel>

                <FoldSection
                  title="能力配置"
                  subtitle={
                    capCount > 0 ? `已挂载 ${capCount} 项` : '技能 · 工具 · 外部服务'
                  }
                  open={capSectionOpen}
                  onToggle={() => setCapSectionOpen((v) => !v)}
                >
                  <p className="wf-drawer-tip" style={{ marginTop: 0 }}>
                    留空则使用智能体的默认能力。这里配置的是本步<strong>额外</strong>挂载的能力。
                  </p>
                  <ResourceRow
                    icon={<Sparkles size={15} />}
                    label="技能与工具"
                    summary={capSummary}
                    badge="optional"
                    onClick={() => setCapOpen(true)}
                  />
                  {mcpServers.length > 0 ? (
                    <div className="wf-drawer-field wf-drawer-field--mcp">
                      <label className="wf-drawer-label">
                        MCP 外部服务
                        <FieldBadge kind="optional" />
                      </label>
                      <div className="wf-drawer-mcp-grid">
                        {mcpServers.map((m) => {
                          const checked = mcpSelected.includes(m.name)
                          return (
                            <button
                              key={m.name}
                              type="button"
                              className={`wf-drawer-mcp-pill${checked ? ' is-on' : ''}`}
                              title={m.description || m.name}
                              onClick={() => {
                                const next = checked
                                  ? mcpSelected.filter((n) => n !== m.name)
                                  : [...mcpSelected, m.name]
                                onStepChange({ mcp_servers: joinCsvField(next) })
                              }}
                            >
                              {m.name}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ) : null}
                </FoldSection>

                <FoldSection
                  title="高级设置"
                  subtitle="指令 · 输入输出 · 模型 · 工作目录"
                  open={advancedOpen}
                  onToggle={() => setAdvancedOpen((v) => !v)}
                >
                  <p className="wf-drawer-tip" style={{ marginTop: 0 }}>
                    大多数场景不需要填写。输入/产出只是给智能体的说明；连线后前置步骤的结果会自动传过来。
                  </p>
                  {ADVANCED_DETAIL_KEYS.map((key) => {
                    const field = STEP_FIELD_MAP[key]
                    if (!field) return null
                    const labels: Record<(typeof ADVANCED_DETAIL_KEYS)[number], string> = {
                      description: '步骤简介',
                      instruction: '补充指令',
                      inputs: '输入说明',
                      outputs: '期望产出',
                      acceptance: '验收标准',
                      failure: '失败处理方式',
                      model: '指定模型',
                      project_path: '工作目录',
                    }
                    const multiline = key !== 'model' && key !== 'project_path'
                    return (
                      <div key={key} className="wf-drawer-field">
                        <label className="wf-drawer-label" htmlFor={`wf-drawer-opt-${key}`}>
                          {labels[key]}
                          <FieldBadge kind="optional" />
                        </label>
                        {key === 'instruction' ? (
                          <>
                            <SlashVarTextarea
                              id={`wf-drawer-opt-${key}`}
                              className="wf-drawer-control wf-drawer-control--area"
                              rows={3}
                              value={String(selectedStep.instruction ?? '')}
                              placeholder="补充指令… 输入 / 引用变量"
                              items={slashVarItems.filter((i) => i.group === '用户输入')}
                              onChange={(next) => onStepChange({ instruction: next })}
                            />
                            <InsertChipBar
                              label="用户输入"
                              chips={paramChips}
                              onInsert={(text) =>
                                onStepChange({
                                  instruction: appendInline(selectedStep.instruction, text),
                                })
                              }
                            />
                          </>
                        ) : multiline ? (
                          <textarea
                            id={`wf-drawer-opt-${key}`}
                            className="wf-drawer-control wf-drawer-control--area"
                            rows={2}
                            value={String(selectedStep[key] ?? '')}
                            placeholder={field.placeholder || '可不填'}
                            onChange={(e) => onStepChange({ [key]: e.target.value })}
                          />
                        ) : key === 'project_path' ? (
                          <WorkspaceFolderInput
                            id={`wf-drawer-opt-${key}`}
                            className="wf-drawer-control"
                            value={String(selectedStep[key] ?? '')}
                            placeholder={field.placeholder || '可不填'}
                            onChange={(next) => onStepChange({ [key]: next })}
                          />
                        ) : (
                          <input
                            id={`wf-drawer-opt-${key}`}
                            className="wf-drawer-control"
                            value={String(selectedStep[key] ?? '')}
                            placeholder={field.placeholder || '可不填'}
                            onChange={(e) => onStepChange({ [key]: e.target.value })}
                          />
                        )}
                      </div>
                    )
                  })}
                </FoldSection>
              </>
            ) : null}
          </>
        ) : null}
      </div>

      {tab === 'library' ? (
        <div className="wf-drawer-foot">
          <button
            type="button"
            className="wf-drawer-foot-btn"
            disabled={!hasSelection}
            onClick={onDeleteSelected}
          >
            <Trash2 size={14} />
            删除选中节点
          </button>
        </div>
      ) : isStep ? (
        <div className="wf-drawer-foot">
          <button type="button" className="wf-drawer-foot-btn" onClick={onDeleteSelected}>
            <Trash2 size={14} />
            删除此节点
          </button>
        </div>
      ) : null}

      <AgentPickerModal
        open={agentOpen}
        onClose={() => setAgentOpen(false)}
        agents={agents}
        tools={tools}
        skills={skills}
        loading={loading}
        selected={selectedStep?.assigned_agent}
        onConfirm={(code) => {
          onStepChange({ assigned_agent: code })
          setAgentOpen(false)
        }}
      />
      <CapabilityPickerModal
        open={capOpen}
        onClose={() => setCapOpen(false)}
        skills={skills}
        tools={tools}
        loading={loading}
        selectedSkills={skillSelected}
        selectedTools={toolSelected}
        onConfirm={(next) => {
          onStepChange({
            skills: joinCsvField(next.skills.map((s) => s.name)),
            tools: joinCsvField(next.tools),
          })
          setCapOpen(false)
        }}
      />
    </>
  ) : null

  return (
    <>
      <aside
        className={`wf-drawer${open ? ' is-open' : ''}${
          isConfigPanel ? ' is-config wf-drawer--config' : ' wf-drawer--library'
        }`}
      >
        <div className="wf-drawer-top">
          {isLibraryPanel ? (
            <>
              <div className="wf-drawer-panel-heading">
                <Layers size={15} />
                <span>节点库</span>
              </div>
              <button
                type="button"
                className="wf-drawer-collapse"
                onClick={onToggle}
                title="收起节点库"
              >
                <ChevronLeft size={16} />
              </button>
            </>
          ) : (
            <div className="wf-drawer-panel-heading">
              <Settings2 size={15} />
              <span>
                {isStart
                  ? '开始节点'
                  : isAnswer
                    ? '输出节点'
                    : isStep
                      ? '节点配置'
                      : '节点配置'}
              </span>
            </div>
          )}
        </div>
        {body}
      </aside>
      {isLibraryPanel && !open ? (
        <button type="button" className="wf-drawer-expand" onClick={onToggle} title="展开节点库">
          <ChevronRight size={16} />
        </button>
      ) : null}
    </>
  )
}
