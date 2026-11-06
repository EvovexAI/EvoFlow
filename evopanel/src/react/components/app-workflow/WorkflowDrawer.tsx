import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  Layers,
  MessageSquareText,
  Minimize2,
  Plus,
  Settings2,
  Trash2,
} from 'lucide-react'
import {
  isMissingStepTaskName,
  workspaceDisplayName,
  type AppWorkflowStep,
  type StepNodeData,
} from '../../lib/app-workflow-plan.ts'
import { ANSWER_NODE_ID, START_NODE_ID } from '../../lib/app-workflow-flow.ts'
import { parseCsvField, joinCsvField } from '../../lib/workflow-step-csv.ts'
import {
  AgentCapabilityTabs,
  type AgentCapabilityPatch,
} from '../AgentCapabilityTabs.tsx'
import { ModelCatalogMenu } from '../ModelCatalogMenu.tsx'
import {
  defaultModelFromCatalog,
  modelDisplayLabel,
  normalizeModelCatalogRows,
  type ModelCatalogEntry,
} from '../../lib/model-catalog.ts'
import InsertChipBar from './InsertChipBar.tsx'
import { SlashVarTextarea, type SlashVarItem } from './SlashVarTextarea.tsx'
import { WorkspaceFolderInput } from './WorkspaceFolderInput.tsx'
import { RunVarsPanel } from './RunVarsPanel.tsx'
import WorkflowNodeAvatar from './WorkflowNodeAvatar.tsx'
import {
  startPalettePointerDrag,
  type PaletteDragKind,
} from './palette-dnd.ts'

type TabId = 'library' | 'config'
/** library = 左侧节点库；config = 右侧上下文配置（无 Tab） */
export type WorkflowDrawerPanelRole = 'library' | 'config'

export type AppParamSlot = {
  name: string
  label?: string
  type?: string
  required?: boolean
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
  /** 模板变换节点：确定性文本变换，不占 LLM worker（F-1）。 */
  onAddTemplateStep?: () => void
  onAddAnswer?: () => void
  onDeleteSelected: () => void
  hasSelection: boolean
  onOpenAppSettings?: () => void
  /** Step ref currently wired into the answer node (if any) */
  answerSourceRef?: string
  /** App-level run parameters (filled on 运行页 / OpenAPI variables) */
  appParameters?: AppParamSlot[]
  /** 工作流默认工作空间（各步可覆盖） */
  workflowProjectPath?: string
  onWorkflowProjectPathChange?: (path: string) => void
  /** 嵌入悬浮壳：只渲染内容，不带侧栏顶栏/外边框 */
  embedded?: boolean
}

function appendInline(current: string | undefined, insert: string): string {
  const cur = String(current || '')
  const piece = String(insert || '').trim()
  if (!piece) return cur
  if (!cur.trim()) return piece
  return `${cur}${/\s$/.test(cur) ? '' : ' '}${piece}`
}

function DrawerPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="wf-drawer-section-block">
      <h4 className="wf-drawer-section-block-title">{title}</h4>
      <div className="wf-drawer-section-block-body">{children}</div>
    </section>
  )
}

function FieldBadge({ kind }: { kind: 'required' | 'suggest' | 'optional' }) {
  return (
    <span className={`wf-field-badge wf-field-badge--${kind}`}>
      {kind === 'required' ? '必填' : kind === 'suggest' ? '建议填' : '可选'}
    </span>
  )
}

function StepThinkingToggle({
  on,
  onToggle,
}: {
  on: boolean
  onToggle: () => void
}) {
  return (
    <div className="chat-summary-role-pref-toggle" title="仅本步生效；关闭则不强制开启思考">
      <span className="chat-summary-role-pref-toggle-label">思考</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`思考${on ? '已开' : '已关'}`}
        className={`chat-summary-role-pref-switch${on ? ' is-on' : ''}`}
        onClick={onToggle}
      >
        <span className="chat-summary-role-pref-switch-knob" aria-hidden />
      </button>
    </div>
  )
}

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
  onAddStepWithAgent: _onAddStepWithAgent,
  onAddTemplateStep,
  onAddAnswer,
  onDeleteSelected,
  hasSelection,
  onOpenAppSettings,
  answerSourceRef = '',
  appParameters = [],
  workflowProjectPath = '',
  onWorkflowProjectPathChange,
  embedded = false,
}: Props) {
  const role: WorkflowDrawerPanelRole = panelRole || tabProp || 'library'
  const tab: TabId = role
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogEntry[]>([])
  const [primaryModelName, setPrimaryModelName] = useState('')
  const [modelsLoading, setModelsLoading] = useState(false)

  // 新建/选中缺任务名的步骤时，自动聚焦「任务名称」，逼着先起名
  useEffect(() => {
    if (tab !== 'config' || !selectedStep) return
    if (!isMissingStepTaskName(selectedStep.name)) return
    const t = window.setTimeout(() => {
      const el = document.getElementById('wf-drawer-step-name') as HTMLInputElement | null
      el?.focus()
      el?.select()
    }, 60)
    return () => window.clearTimeout(t)
  }, [tab, selectedStep?.ref, selectedStep?.name])

  // 本步模型下拉：拉聊天模型目录 + 系统默认模型
  useEffect(() => {
    if (!open || tab !== 'config' || !selectedStep) return
    let cancelled = false
    setModelsLoading(true)
    void (async () => {
      try {
        const { api } = await import('../../../lib/tauri-api.js')
        const [data, primaryInfo] = await Promise.all([
          api.listModels(),
          api.getPrimaryModel().catch(() => null),
        ])
        if (cancelled) return
        const rows = Array.isArray(data?.models)
          ? data.models
          : Array.isArray(data)
            ? data
            : []
        setModelCatalog(normalizeModelCatalogRows(rows))
        const primary =
          typeof primaryInfo?.primary_model === 'string'
            ? primaryInfo.primary_model.trim()
            : ''
        setPrimaryModelName(primary)
      } catch {
        if (!cancelled) {
          setModelCatalog([])
          setPrimaryModelName('')
        }
      } finally {
        if (!cancelled) setModelsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, tab, selectedStep?.ref])

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

  const slashVarItems = useMemo(
    () =>
      paramChips.map((c) => ({
        id: `var:${c.id}`,
        label: c.label,
        insert: c.insert,
        group: '用户输入',
        hint: c.id,
      })) as SlashVarItem[],
    [paramChips],
  )

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

  const skillSelected = useMemo(
    () => parseCsvField(selectedStep?.skills),
    [selectedStep?.skills],
  )
  const toolSelected = useMemo(() => parseCsvField(selectedStep?.tools), [selectedStep?.tools])
  const mcpSelected = useMemo(
    () => parseCsvField(selectedStep?.mcp_servers),
    [selectedStep?.mcp_servers],
  )
  const knowledgeSelected = useMemo(
    () => parseCsvField(selectedStep?.knowledge_vault_ids),
    [selectedStep?.knowledge_vault_ids],
  )
  const thinkingOn = selectedStep?.thinking_enabled === true
  const stepModel = String(selectedStep?.model || '').trim()
  const defaultModelName = useMemo(
    () =>
      defaultModelFromCatalog(modelCatalog, primaryModelName) ||
      String(primaryModelName || '').trim() ||
      String(modelCatalog[0]?.name || '').trim(),
    [modelCatalog, primaryModelName],
  )
  /** 空 = 用系统默认；展示/高亮都用实际默认名，不写「跟随默认」 */
  const effectiveStepModel = stepModel || defaultModelName
  const stepModelPill = useMemo(() => {
    if (modelsLoading && !modelCatalog.length) return '加载模型…'
    const name = effectiveStepModel
    if (!name) return '默认模型'
    const entry = modelCatalog.find((m) => m.name === name)
    return modelDisplayLabel(entry || { name }) || name
  }, [modelsLoading, modelCatalog, effectiveStepModel])

  // 本步目标：goal；兼容旧步把文案写在 instruction 的情况
  const taskText =
    selectedStep?.goal || selectedStep?.description || selectedStep?.instruction || ''

  const onPatchCapabilities = useCallback(
    async (patch: AgentCapabilityPatch) => {
      const next: Partial<AppWorkflowStep> = {}
      if (patch.skills !== undefined) next.skills = joinCsvField(patch.skills)
      if (patch.tools !== undefined) next.tools = joinCsvField(patch.tools || [])
      if (patch.mcp_servers !== undefined) {
        next.mcp_servers = joinCsvField(patch.mcp_servers || [])
      }
      if (patch.knowledge_vault_ids !== undefined) {
        next.knowledge_vault_ids = joinCsvField(patch.knowledge_vault_ids)
      }
      if (Object.keys(next).length) onStepChange(next)
    },
    [onStepChange],
  )

  const workflowWs = String(workflowProjectPath || '').trim()
  const stepWs = String(selectedStep?.project_path || '').trim()
  const effectiveWs = stepWs || workflowWs
  const effectiveWsName = workspaceDisplayName(effectiveWs)

  const libNodes = useMemo(
    () => [
      {
        id: 'agent',
        title: 'Agent 节点',
        desc: '拖到画布 · 右侧配技能/工具',
        tone: 'action' as const,
        icon: <Bot size={14} />,
        onClick: onAddStep,
        dragKind: 'agent-step',
      },
      {
        id: 'answer',
        title: '最终答案',
        desc: '拖到画布 · 指定哪一步给用户看',
        tone: 'trigger' as const,
        icon: <MessageSquareText size={14} />,
        onClick: onAddAnswer,
        dragKind: 'answer',
      },
    ],
    [onAddStep, onAddAnswer],
  )

  const isStart = selectedId === START_NODE_ID
  const isAnswer = selectedId === ANSWER_NODE_ID
  const isStep = !!selectedStep && !isStart && !isAnswer
  const isConfigPanel = role === 'config'
  const isLibraryPanel = role === 'library'

  const body = open ? (
    <>
      <div className="wf-drawer-body">
        {tab === 'library' ? (
          <div className="wf-drawer-section wf-drawer-section--basics">
            <p className="wf-drawer-section-hint">
              拖到画布或点一下添加。每步在右侧精细配置任务与技能/工具/知识库，勿留空指望默认能力。
            </p>
            {libNodes.map((n) => (
              <div
                key={n.id}
                role="button"
                tabIndex={0}
                className="wf-drawer-lib-card wf-drawer-lib-row"
                title="拖到画布，或点击添加"
                onPointerDown={(e) => {
                  // 仅主键。不用 HTML5 DnD——Tauri/WebView2 经常拖不动。
                  if (e.button !== 0) return
                  const kind = n.dragKind as PaletteDragKind
                  startPalettePointerDrag({
                    kind,
                    label: n.title,
                    pointerId: e.pointerId,
                    startX: e.clientX,
                    startY: e.clientY,
                    onTap: () => n.onClick?.(),
                  })
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    n.onClick?.()
                  }
                }}
              >
                <WorkflowNodeAvatar tone={n.tone} size="sm">
                  {n.icon}
                </WorkflowNodeAvatar>
                <div className="wf-drawer-lib-copy">
                  <span className="wf-drawer-lib-name">{n.title}</span>
                  <span className="wf-drawer-lib-desc">{n.desc}</span>
                </div>
                <span className="wf-drawer-lib-add" aria-hidden>
                  <Plus size={12} />
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {tab === 'config' ? (
          <>
            {!selectedId ? (
              <p className="wf-drawer-empty-hint">点选画布节点可配置本步</p>
            ) : null}

            {(isStart || !selectedId) && (
              <DrawerPanel title="工作流">
                <label className="wf-drawer-label" htmlFor="wf-drawer-goal">
                  描述
                </label>
                <textarea
                  id="wf-drawer-goal"
                  className="wf-drawer-control wf-drawer-control--area"
                  rows={7}
                  value={workflowGoal}
                  placeholder="这个工作流是做什么的…"
                  onChange={(e) => onWorkflowGoalChange(e.target.value)}
                />
                <div className="wf-drawer-field wf-drawer-workspace" style={{ marginTop: 14 }}>
                  <label className="wf-drawer-label" htmlFor="wf-drawer-workflow-ws">
                    工作空间
                    <FieldBadge kind="suggest" />
                  </label>
                  <WorkspaceFolderInput
                    id="wf-drawer-workflow-ws"
                    className="wf-drawer-control"
                    value={workflowWs}
                    placeholder="工作流默认运行目录（各步可覆盖）…"
                    pickTitle="选择工作流工作空间"
                    onChange={(next) => onWorkflowProjectPathChange?.(next)}
                  />
                  {workflowWs ? (
                    <p className="wf-drawer-workspace-path" title={workflowWs}>
                      {workflowWs}
                    </p>
                  ) : null}
                </div>
              </DrawerPanel>
            )}

            {(isStart || !selectedId) && (
              <DrawerPanel title="用户输入项">
                <RunVarsPanel vars={runVars} onManage={onOpenAppSettings} />
              </DrawerPanel>
            )}

            {isStart ? (
              <p className="wf-drawer-tip">
                「入口」只标触发与入参，不用当步骤添加。多个并行任务可同时从这里出发；要汇总结果时，再加一个任务步骤接两边，最后连到「最终答案」。
              </p>
            ) : null}

            {isAnswer ? (
              <DrawerPanel title="最终答案">
                <p className="wf-drawer-tip" style={{ margin: 0 }}>
                  只连<strong>一步</strong>作为用户看到的输出。并行两边若要汇总，先用任务步骤合并，再接到这里。
                </p>
                <p className="wf-drawer-tip" style={{ marginTop: 10 }}>
                  {answerSourceRef
                    ? `当前取自步骤 ${answerSourceRef}`
                    : '尚未连入 — 从步骤右侧拖线到「最终答案」'}
                </p>
              </DrawerPanel>
            ) : null}

            {isStep && selectedStep ? (
              <>
                <DrawerPanel title="基础信息">
                  <div className="wf-drawer-field">
                    <label className="wf-drawer-label" htmlFor="wf-drawer-step-name">
                      1. 任务名称
                      <FieldBadge kind="required" />
                    </label>
                    <input
                      id="wf-drawer-step-name"
                      className={`wf-drawer-control${
                        isMissingStepTaskName(selectedStep.name) ? ' is-invalid' : ''
                      }`}
                      type="text"
                      value={selectedStep.name || ''}
                      placeholder="短名，如「收集竞品资料」（画布节点标题）"
                      onChange={(e) => onStepChange({ name: e.target.value })}
                    />
                  </div>
                  <div className="wf-drawer-field" style={{ marginTop: 4 }}>
                    <label className="wf-drawer-label" htmlFor="wf-drawer-task">
                      2. 目标
                      <FieldBadge kind="optional" />
                    </label>
                    <SlashVarTextarea
                      id="wf-drawer-task"
                      className="wf-drawer-control wf-drawer-control--area wf-drawer-control--task"
                      rows={10}
                      value={taskText}
                      placeholder="可空；写本步要做什么。输入 / 引用变量"
                      items={slashVarItems}
                      onChange={(next) => onStepChange({ goal: next, instruction: '' })}
                    />
                    {paramChips.length ? (
                      <InsertChipBar
                        label="运行变量"
                        hint="也可点选插入 · 或输入 /"
                        chips={paramChips}
                        onInsert={(text) =>
                          onStepChange({
                            goal: appendInline(selectedStep.goal || taskText, text),
                            instruction: '',
                          })
                        }
                      />
                    ) : null}
                  </div>

                  <div className="wf-drawer-field wf-drawer-workspace" style={{ marginTop: 14 }}>
                    <label className="wf-drawer-label" htmlFor="wf-drawer-step-ws">
                      3. 工作空间
                      <FieldBadge kind="suggest" />
                      {effectiveWs ? (
                        <span
                          className="wf-drawer-workspace-inline"
                          title={effectiveWs}
                        >
                          {stepWs ? `本步 · ${effectiveWsName}` : `默认 · ${effectiveWsName}`}
                        </span>
                      ) : null}
                    </label>
                    <WorkspaceFolderInput
                      id="wf-drawer-step-ws"
                      className="wf-drawer-control"
                      value={stepWs}
                      placeholder={
                        workflowWs
                          ? `留空则用工作流默认：${workspaceDisplayName(workflowWs)}`
                          : '留空跟随工作流默认；可先在入口设默认目录'
                      }
                      pickTitle="选择本步工作空间"
                      onChange={(next) => onStepChange({ project_path: next })}
                    />
                  </div>
                </DrawerPanel>

                <DrawerPanel title="本步能力">
                  <div className="wf-drawer-field wf-drawer-model-row">
                    <div className="wf-drawer-model-label-row">
                      <span className="wf-drawer-label">模型</span>
                      <StepThinkingToggle
                        on={thinkingOn}
                        onToggle={() =>
                          onStepChange({
                            thinking_enabled: thinkingOn ? false : true,
                          })
                        }
                      />
                    </div>
                    <div className="wf-drawer-model-control-row">
                      {/* 与主对话输入区同一套 ModelCatalogMenu / bottom-pill */}
                      <ModelCatalogMenu
                        open={modelMenuOpen}
                        onOpenChange={setModelMenuOpen}
                        catalog={modelCatalog}
                        selectedModel={effectiveStepModel}
                        pillLabel={stepModelPill}
                        loading={modelsLoading}
                        placement="down"
                        portalFixed
                        className="wf-drawer-model-composer"
                        onSelect={(name) => {
                          const next = String(name || '').trim()
                          const hit = modelCatalog.find((m) => m.name === next)
                          // 点到当前系统默认 → 清空本步覆盖，继续跟默认
                          const patch: Partial<AppWorkflowStep> = {
                            model: next && next !== defaultModelName ? next : '',
                          }
                          if (hit && hit.supportsThinking === false) {
                            patch.thinking_enabled = false
                          }
                          onStepChange(patch)
                        }}
                      />
                      {stepModel ? (
                        <button
                          type="button"
                          className="wf-drawer-model-clear"
                          title={
                            defaultModelName
                              ? `恢复默认：${
                                  modelDisplayLabel(
                                    modelCatalog.find((m) => m.name === defaultModelName) || {
                                      name: defaultModelName,
                                    },
                                  ) || defaultModelName
                                }`
                              : '恢复默认模型'
                          }
                          onClick={() => onStepChange({ model: '' })}
                        >
                          默认
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <div className="wf-drawer-cap-tabs">
                    <AgentCapabilityTabs
                      key={`cap:${selectedStep.ref || 'step'}`}
                      skillNames={skillSelected}
                      toolNames={toolSelected}
                      mcpServers={mcpSelected}
                      knowledgeVaultIds={knowledgeSelected}
                      modelName={String(selectedStep.model || '')}
                      editable
                      compact
                      onPatch={onPatchCapabilities}
                    />
                  </div>
                </DrawerPanel>
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

    </>
  ) : null

  if (embedded) {
    if (!open) return null
    return (
      <div
        className={`wf-drawer-embed${
          isConfigPanel ? ' is-config' : ' is-library'
        }`}
      >
        {body}
      </div>
    )
  }

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
            <>
              <div className="wf-drawer-panel-heading">
                <Settings2 size={15} />
                <span>
                  {isStart
                    ? '入口'
                    : isAnswer
                      ? '最终答案'
                      : '节点配置'}
                </span>
              </div>
              <button
                type="button"
                className="wf-drawer-float-close"
                onClick={onToggle}
                title="收起配置"
                aria-label="收起配置"
              >
                <Minimize2 size={14} />
              </button>
            </>
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
