import { createContext, useContext, type ReactNode } from 'react'
import type { AppWorkflowStep } from '../../lib/app-workflow-plan.ts'
import type { AgentPickerRow } from '../../lib/agent-tags.ts'

/** 画布调试运行时节点态（对齐 FastGPT waiting/active/success/error） */
export type StepExecStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'paused'

export type WorkflowStudioContextValue = {
  selectedId: string | null
  updateStep: (nodeId: string, patch: Partial<AppWorkflowStep>) => void
  deleteNode: (nodeId: string) => void
  deleteEdge?: (edgeId: string) => void
  goal: string
  setGoal: (goal: string) => void
  onOpenAppSettings?: () => void
  drawerOpen: boolean
  setDrawerOpen: (open: boolean) => void
  onOpenConfig?: () => void
  openAgentPicker?: (nodeId: string) => void
  agents: AgentPickerRow[]
  /** App run parameters (global vars, FastGPT-style) */
  appParameters?: Array<{ name?: string; label?: string; type?: string; required?: boolean }>
  /** step.ref → 执行态 */
  execByRef?: Record<string, StepExecStatus>
}

const WorkflowStudioContext = createContext<WorkflowStudioContextValue | null>(null)

export function WorkflowStudioProvider({
  value,
  children,
}: {
  value: WorkflowStudioContextValue
  children: ReactNode
}) {
  return <WorkflowStudioContext.Provider value={value}>{children}</WorkflowStudioContext.Provider>
}

export function useWorkflowStudio() {
  const ctx = useContext(WorkflowStudioContext)
  if (!ctx) throw new Error('useWorkflowStudio must be used within WorkflowStudioProvider')
  return ctx
}

export function useWorkflowStudioOptional() {
  return useContext(WorkflowStudioContext)
}
