import { useEffect, useState } from 'react'
import { Layers, Minimize2, Settings2 } from 'lucide-react'
import {
  WorkflowDrawer,
  type AppParamSlot,
  type WorkflowDrawerPanelRole,
} from './WorkflowDrawer.tsx'
import type { AppWorkflowStep, StepNodeData } from '../../lib/app-workflow-plan.ts'
import { ANSWER_NODE_ID, START_NODE_ID } from '../../lib/app-workflow-flow.ts'

export type StudioFloatTab = WorkflowDrawerPanelRole

type Props = {
  selectedId: string | null
  selectedStep: StepNodeData | null
  workflowGoal: string
  onWorkflowGoalChange: (goal: string) => void
  onStepChange: (patch: Partial<AppWorkflowStep>) => void
  onAddStep: () => void
  onAddStepWithAgent?: (agentCode: string) => void
  onAddTemplateStep?: () => void
  onAddAnswer?: () => void
  onDeleteSelected: () => void
  hasSelection: boolean
  onOpenAppSettings?: () => void
  answerSourceRef?: string
  appParameters?: AppParamSlot[]
  workflowProjectPath?: string
  onWorkflowProjectPathChange?: (path: string) => void
  /** 外部要求展开（如顶栏「节点库」） */
  forceOpenToken?: number
  /** 外部指定要打开的 tab */
  forceTab?: StudioFloatTab | null
  onCollapsedChange?: (collapsed: boolean) => void
}

/**
 * 工作流右上悬浮卡：节点库 / 配置 Tab + 收起气泡（对齐摘要面板形态）。
 */
export function WorkflowStudioFloat({
  selectedId,
  forceOpenToken = 0,
  forceTab = null,
  onCollapsedChange,
  ...drawerProps
}: Props) {
  const hasSelection = Boolean(selectedId)
  const [tab, setTab] = useState<StudioFloatTab>('library')
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    onCollapsedChange?.(collapsed)
  }, [collapsed, onCollapsedChange])

  // 选中节点 → 展开并切到配置
  useEffect(() => {
    if (!selectedId) return
    queueMicrotask(() => {
      setTab('config')
      setCollapsed(false)
    })
  }, [selectedId])

  // 顶栏等外部强制展开
  useEffect(() => {
    if (!forceOpenToken) return
    queueMicrotask(() => {
      if (forceTab) setTab(forceTab)
      setCollapsed(false)
    })
  }, [forceOpenToken, forceTab])

  const configLabel =
    selectedId === START_NODE_ID
      ? '入口'
      : selectedId === ANSWER_NODE_ID
        ? '最终答案'
        : '配置'

  if (collapsed) {
    return (
      <aside className="wf-studio-float is-bubble" aria-label="工作流面板">
        <button
          type="button"
          className="wf-studio-float-bubble"
          aria-label="展开工作流面板"
          title="展开节点库 / 配置"
          onClick={() => setCollapsed(false)}
        >
          <span className="wf-studio-float-bubble-icons" aria-hidden>
            <Layers size={15} />
            <Settings2 size={15} />
          </span>
          <span className="wf-studio-float-bubble-label">面板</span>
        </button>
      </aside>
    )
  }

  return (
    <aside className="wf-studio-float is-open" aria-label="工作流面板">
      <div className="wf-studio-float-panel">
        <div className="wf-studio-float-head">
          <div className="wf-studio-float-tabs" role="tablist" aria-label="工作流面板">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'library'}
              className={`wf-studio-float-tab${tab === 'library' ? ' is-active' : ''}`}
              onClick={() => setTab('library')}
            >
              节点库
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'config'}
              className={`wf-studio-float-tab${tab === 'config' ? ' is-active' : ''}`}
              onClick={() => setTab('config')}
            >
              {configLabel}
            </button>
          </div>
          <button
            type="button"
            className="wf-studio-float-icon-btn"
            aria-label="收起"
            title="收起为气泡"
            onClick={() => setCollapsed(true)}
          >
            <Minimize2 size={14} />
          </button>
        </div>
        <div className="wf-studio-float-scroll">
          <WorkflowDrawer
            panelRole={tab}
            open
            embedded
            onToggle={() => setCollapsed(true)}
            selectedId={selectedId}
            {...drawerProps}
            hasSelection={hasSelection || drawerProps.hasSelection}
          />
        </div>
      </div>
    </aside>
  )
}
