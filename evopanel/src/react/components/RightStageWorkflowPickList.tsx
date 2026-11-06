/**
 * 右栏「工作流」选择器：列出正在运行 + 最近任务，点选后由宿主 openCollabWorkflow。
 * 与员工对话选择器同壳（react-chat-stage-open-tab-*）。
 */
import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/tauri-api.js'
import { tasksFromListResponse } from '../../lib/proactive-role-tasks.js'
import {
  formatTaskStatusZh,
  isTaskPlanningStatus,
  isTaskQueuedStatus,
  isTaskRunningStatus,
  isTaskWaitingConfirmation,
} from '../../lib/task-status-label.js'

export type RightStageWorkflowPickOption = {
  taskId: string
  title: string
  status: string
  statusLabel: string
  leadThreadId?: string
  badge?: string
}

function taskTitle(row: Record<string, unknown>): string {
  return (
    String(row?.name || row?.title || row?.goal || row?.id || '未命名工作流').trim() ||
    '未命名工作流'
  )
}

function taskIdOf(row: Record<string, unknown>): string {
  return String(row?.id || row?.task_id || '').trim()
}

function leadThreadOf(row: Record<string, unknown>): string {
  return String(row?.thread_id || row?.lead_thread_id || row?.threadId || '').trim()
}

function isLiveStatus(status: string): boolean {
  return (
    isTaskRunningStatus(status) ||
    isTaskPlanningStatus(status) ||
    isTaskQueuedStatus(status) ||
    isTaskWaitingConfirmation(status)
  )
}

function rankTask(row: Record<string, unknown>, currentTaskId: string): number {
  const id = taskIdOf(row)
  const status = String(row?.status || '')
  if (currentTaskId && id === currentTaskId) return 0
  if (isTaskRunningStatus(status)) return 1
  if (isTaskPlanningStatus(status) || isTaskQueuedStatus(status)) return 2
  if (isTaskWaitingConfirmation(status)) return 3
  return 4
}

function updatedAtMs(row: Record<string, unknown>): number {
  const raw =
    row?.updated_at || row?.updatedAt || row?.created_at || row?.createdAt || row?.started_at || 0
  const n = typeof raw === 'number' ? raw : Date.parse(String(raw || ''))
  return Number.isFinite(n) ? n : 0
}

export function RightStageWorkflowPickList({
  currentTaskId = '',
  onPick,
}: {
  currentTaskId?: string
  onPick: (opt: RightStageWorkflowPickOption) => void
}) {
  const cur = String(currentTaskId || '').trim()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [rows, setRows] = useState<Record<string, unknown>[]>([])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    void (async () => {
      try {
        const res = await api.listAllTasks({ page: 1, page_size: 30, hide_noise: true })
        if (cancelled) return
        setRows(tasksFromListResponse(res) as Record<string, unknown>[])
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e || '加载失败'))
        setRows([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const options = useMemo(() => {
    const sorted = [...rows]
      .filter((r) => taskIdOf(r))
      .sort((a, b) => {
        const ra = rankTask(a, cur)
        const rb = rankTask(b, cur)
        if (ra !== rb) return ra - rb
        return updatedAtMs(b) - updatedAtMs(a)
      })
      .slice(0, 20)

    return sorted.map((row): RightStageWorkflowPickOption => {
      const id = taskIdOf(row)
      const status = String(row?.status || '')
      const statusLabel = formatTaskStatusZh(status, { fallback: '待处理' })
      let badge = ''
      if (cur && id === cur) badge = '当前会话'
      else if (isLiveStatus(status)) badge = statusLabel
      return {
        taskId: id,
        title: taskTitle(row),
        status,
        statusLabel,
        leadThreadId: leadThreadOf(row) || undefined,
        badge: badge || undefined,
      }
    })
  }, [rows, cur])

  if (loading) {
    return (
      <div className="px-3 py-6 text-center text-ui-sm text-foreground-subtlest">加载工作流…</div>
    )
  }
  if (error) {
    return (
      <div className="px-3 py-6 text-center text-ui-sm text-foreground-subtlest">
        加载失败：{error}
      </div>
    )
  }
  if (!options.length) {
    return (
      <div className="px-3 py-6 text-center text-ui-sm text-foreground-subtlest">
        暂无可用工作流。可先在对话里运行应用，或到任务中心查看历史。
      </div>
    )
  }

  return (
    <div className="react-chat-stage-open-tab-list" role="listbox" aria-label="选择工作流">
      {options.map((opt) => (
        <button
          key={opt.taskId}
          type="button"
          role="option"
          data-side-pane-workflow-pick={opt.taskId}
          className="react-chat-stage-open-tab-button"
          onClick={() => onPick(opt)}
        >
          <span className="min-w-0 flex-1 truncate text-left">
            <span className="block truncate">{opt.title}</span>
            <span className="block truncate text-[11px] text-foreground-subtlest">
              {opt.badge ? `${opt.badge} · ` : ''}
              {opt.statusLabel}
              {opt.taskId ? ` · ${opt.taskId.slice(0, 8)}` : ''}
            </span>
          </span>
        </button>
      ))}
    </div>
  )
}
