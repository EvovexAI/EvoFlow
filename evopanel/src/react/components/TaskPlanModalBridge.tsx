import { useCallback, useEffect, useState } from 'react'
import { loadBoundPlanFromApi, structuredPlanFromApiTask } from '../../lib/plan-from-api.js'
import { tasksAPI } from '../../lib/api-client.js'
import { PlanDetailModal } from './PlanDetailModal.js'
import type { StructuredPlanInput } from './PlanDetailView.js'

function planInputFromTask(task: Record<string, unknown> | null): StructuredPlanInput | null {
  if (!task) return null
  return structuredPlanFromApiTask(task)
}

export type TaskPlanModalBridgeProps = {
  taskId: string
  onPlanModalReady?: (open: (opts?: { task?: Record<string, unknown> }) => void) => void
}

/** 任务详情页：仅挂载「查看计划」弹窗（与主对话同款）。 */
export function TaskPlanModalBridge({ taskId, onPlanModalReady }: TaskPlanModalBridgeProps) {
  const tid = String(taskId || '').trim()
  const [task, setTask] = useState<Record<string, unknown> | null>(null)
  const [planModalOpen, setPlanModalOpen] = useState(false)
  const [planModalData, setPlanModalData] = useState<StructuredPlanInput | null>(null)
  const [planModalLoading, setPlanModalLoading] = useState(false)
  const [planModalError, setPlanModalError] = useState('')

  useEffect(() => {
    if (!tid) return
    void tasksAPI.getTask(tid).then((row) => {
      setTask(row && typeof row === 'object' ? (row as Record<string, unknown>) : null)
    }).catch(() => setTask(null))
  }, [tid])

  const closePlanModal = useCallback(() => {
    setPlanModalOpen(false)
    setPlanModalData(null)
    setPlanModalLoading(false)
    setPlanModalError('')
  }, [])

  const openPlanDetailModal = useCallback(
    async (overrideTask?: Record<string, unknown>) => {
      const row = overrideTask || task
      const fallback = planInputFromTask(row)
      setPlanModalOpen(true)
      setPlanModalError('')
      if (fallback?.goal) {
        setPlanModalData(fallback)
      } else {
        setPlanModalData(null)
      }
      setPlanModalLoading(true)
      try {
        const { plan } = await loadBoundPlanFromApi({
          hintTaskId: tid,
          fallback: fallback ?? null,
        })
        if (plan) {
          setPlanModalData(plan)
          setPlanModalError('')
        } else if (!fallback?.goal) {
          setPlanModalError('暂无计划数据')
        }
      } catch (e) {
        setPlanModalError(String((e as Error).message || e) || '加载计划失败')
        if (fallback?.goal) setPlanModalData(fallback)
      } finally {
        setPlanModalLoading(false)
      }
    },
    [task, tid],
  )

  useEffect(() => {
    onPlanModalReady?.((opts) => {
      void openPlanDetailModal(opts?.task)
    })
  }, [onPlanModalReady, openPlanDetailModal])

  if (!tid) return null

  return (
    <PlanDetailModal
      open={planModalOpen}
      loading={planModalLoading && !planModalData?.goal}
      error={planModalError && !planModalData?.goal ? planModalError : ''}
      plan={planModalData}
      onClose={closePlanModal}
    />
  )
}
