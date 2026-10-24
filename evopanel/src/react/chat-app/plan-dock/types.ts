import type { StructuredPlanInput } from '../../components/PlanDetailView.js'

/** 本轮已成功解析的 plan（避免历史工具合并 / stream 清空后 hit 变 none） */
export type PlanPanelHit = {
  planInput?: Record<string, unknown>
  boundPlanReady?: boolean
  taskId?: string
  planOutput?: Record<string, unknown>
  status?: string
  preview?: string
  boundPlanPersisted?: boolean
}

/** 计划确认条唯一展示态：仅 syncPlanPanelFromApi 写入 */
export type PlanDockApiView =
  | {
      show: false
      source: string
      reason: string
      taskId?: string
      taskStatus?: string
    }
  | {
      show: true
      source: string
      taskId: string
      taskName?: string
      taskStatus: string
      statusLabel: string
      showStartExecution: boolean
      planStructured: StructuredPlanInput
      subtaskCount: number
      toolCallId: string
    }

export type PlanStreamLatch = {
  planInput?: Record<string, unknown>
  boundPlanReady?: boolean
  taskId?: string
} | null
