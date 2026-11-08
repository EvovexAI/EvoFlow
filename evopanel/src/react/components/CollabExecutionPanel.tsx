import { memo, useCallback, useMemo, useState } from 'react'
import type { AgentInfo, CollabSubtaskSnapshot, CollabTaskSnapshot, SubagentStreamTaskMap, SubtaskTranscriptModalPayload } from '../chat-types.js'
import { formatPlanTaskStatusLabel } from '../../lib/plan-task-status.js'
import { taskStatusBadgeClass } from '../../lib/task-status-label.js'
import {
  disableWorkflowNodeLog,
  enableWorkflowNodeLog,
  isWorkflowNodeLogEnabled,
} from '../../lib/workflow-node-log.js'
import { CollabWorkflowCanvas } from './CollabWorkflowCanvas.js'

export interface CollabExecutionPanelProps {
  isOpen: boolean
  mainTaskId: string | null
  collabTask: CollabTaskSnapshot | null
  collabPhase?: string
  chatThreadId: string | null
  /** GET /tasks → 主任务行（progress/status 以存储为准） */
  apiMainTask?: CollabTaskSnapshot | null
  /** GET /tasks → subtasks（与 SessionSidebar 共用；工作流面板以该数据为主绘制 DAG） */
  apiSubtasks?: CollabSubtaskSnapshot[] | null
  /** 流式/本地子任务快照：与 API 合并，用于实时进度与状态（API 轮询间隙） */
  liveSubtasks?: CollabSubtaskSnapshot[]
  subagentTasks?: SubagentStreamTaskMap
  agents?: AgentInfo[]
  /** 独立工作流页：隐藏顶栏状态灯（避免重复展示「已完成」等） */
  hideHeaderStatus?: boolean
  /** 工作流页：画布缩放以适应容器 */
  canvasFillContainer?: boolean
  /** 工作流页：隐藏面板标题栏，腾出画布空间 */
  hidePanelHeader?: boolean
  onClose: () => void
  onSubtaskTranscriptOpen: (payload: SubtaskTranscriptModalPayload) => void
  subtaskObservability?: Record<string, Record<string, unknown>>
}

function stripTaskTitlePrefix(name: string): string {
  return String(name || '')
    .replace(/^任务\s*[：:]\s*/u, '')
    .trim()
}

function normalizeTaskStatus(status?: string): string {
  return String(status || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')
}

function statusRank(status?: string): number {
  const s = normalizeTaskStatus(status)
  if (s === 'completed' || s === 'done') return 4
  if (s === 'failed') return 3
  if (s === 'cancelled' || s === 'canceled' || s === 'timed_out') return 2
  if (s === 'in_progress' || s === 'running' || s === 'executing' || s === 'active') return 1
  return 0
}

/** API 子任务为主，流式/本地状态覆盖同 id 节点（进度更高或状态更前则采用） */
function mergeApiAndLiveSubtasks(
  api: CollabSubtaskSnapshot[] | null | undefined,
  live: CollabSubtaskSnapshot[] | null | undefined,
): CollabSubtaskSnapshot[] | null {
  if (api == null && (!live || live.length === 0)) return null
  const byId = new Map<string, CollabSubtaskSnapshot>()
  for (const row of api || []) {
    const id = String(row?.subtaskId || '').trim()
    if (id) byId.set(id, row)
  }
  for (const row of live || []) {
    const id = String(row?.subtaskId || '').trim()
    if (!id) continue
    const prev = byId.get(id)
    if (!prev) {
      byId.set(id, row)
      continue
    }
    const keepLiveStatus = statusRank(row.status) >= statusRank(prev.status)
    const liveProg = typeof row.progress === 'number' ? row.progress : null
    const prevProg = typeof prev.progress === 'number' ? prev.progress : null
    const progress =
      liveProg != null && (prevProg == null || liveProg >= prevProg) ? liveProg : prevProg
    byId.set(id, {
      ...prev,
      ...row,
      status: keepLiveStatus ? row.status : prev.status,
      ...(progress != null ? { progress } : {}),
    })
  }
  if (!byId.size) return api ?? []
  // 保持 API 顺序；仅 live 有的节点追加在末尾
  const ordered: CollabSubtaskSnapshot[] = []
  const seen = new Set<string>()
  for (const row of api || []) {
    const id = String(row?.subtaskId || '').trim()
    if (!id || seen.has(id)) continue
    const merged = byId.get(id)
    if (merged) {
      ordered.push(merged)
      seen.add(id)
    }
  }
  for (const [id, row] of byId) {
    if (seen.has(id)) continue
    ordered.push(row)
  }
  return ordered
}

function persistedProgress(task: CollabTaskSnapshot | null | undefined): number | null {
  if (typeof task?.progress !== 'number' || Number.isNaN(task.progress)) return null
  return Math.min(100, Math.max(0, Math.round(task.progress)))
}

/** 工作流顶栏：优先 GET /tasks 主任务行，加载前回退 collab 快照 */
function resolvePersistedMainTask(
  apiMainTask: CollabTaskSnapshot | null | undefined,
  collabTask: CollabTaskSnapshot | null,
): CollabTaskSnapshot | null {
  if (apiMainTask && String(apiMainTask.taskId || '').trim()) return apiMainTask
  return collabTask
}

function CollabExecutionPanelInner({
  isOpen,
  mainTaskId,
  collabTask,
  collabPhase: _collabPhase,
  chatThreadId,
  apiMainTask = null,
  apiSubtasks = null,
  liveSubtasks = [],
  subagentTasks,
  agents,
  onSubtaskTranscriptOpen,
  subtaskObservability,
  hideHeaderStatus = false,
  canvasFillContainer = false,
  hidePanelHeader = false,
}: CollabExecutionPanelProps) {
  const tid = String(mainTaskId || collabTask?.taskId || '').trim()
  /** 节点状态日志开关（排查用） */
  const [nodeLogOn, setNodeLogOn] = useState(() => isWorkflowNodeLogEnabled())
  const toggleNodeLog = useCallback(() => {
    setNodeLogOn((prev) => {
      if (prev) {
        disableWorkflowNodeLog()
        return false
      }
      enableWorkflowNodeLog()
      return true
    })
  }, [])
  const mergedSubtasks = useMemo(
    () => mergeApiAndLiveSubtasks(apiSubtasks, liveSubtasks),
    [apiSubtasks, liveSubtasks],
  )
  const subtasks = mergedSubtasks ?? []

  const persistedMainTask = useMemo(
    () => resolvePersistedMainTask(apiMainTask, collabTask),
    [apiMainTask, collabTask],
  )

  const taskTitle = useMemo(() => {
    const name = stripTaskTitlePrefix(String(persistedMainTask?.name || collabTask?.name || ''))
    return name || '任务执行'
  }, [persistedMainTask?.name, collabTask?.name])

  const panelProgress = useMemo(() => persistedProgress(persistedMainTask), [persistedMainTask])

  const isRunning = useMemo(() => {
    const s = normalizeTaskStatus(persistedMainTask?.status)
    return s === 'in_progress' || s === 'running' || s === 'executing' || s === 'active'
  }, [persistedMainTask?.status])

  /** 节点统计：总数 / 运行中 / 已完成 —— 让顶栏一眼看出「跑到哪了」 */
  const stepStats = useMemo(() => {
    let total = 0
    let running = 0
    let done = 0
    for (const s of subtasks) {
      total += 1
      const st = normalizeTaskStatus(s.status)
      if (st === 'in_progress' || st === 'running' || st === 'executing' || st === 'active') {
        running += 1
      } else if (st === 'completed' || st === 'done') {
        done += 1
      }
    }
    return { total, running, done }
  }, [subtasks])

  if (!isOpen) return null

  const statusLabel = formatPlanTaskStatusLabel(persistedMainTask)
  const statusClass = taskStatusBadgeClass(persistedMainTask?.status)

  return (
    <aside
      className={`react-chat-collab-exec-panel${canvasFillContainer ? ' is-canvas-fill' : ''}`}
      role="region"
      aria-label={taskTitle}
    >
      {!hidePanelHeader ? (
        <header className="react-chat-collab-exec-panel-header">
          <div className="react-chat-collab-exec-panel-title-wrap">
            <div className="react-chat-collab-exec-panel-title-row">
              {!hideHeaderStatus ? (
                <span
                  className={`react-chat-subtask-status-light ${statusClass}`}
                  title={statusLabel}
                  aria-label={`状态：${statusLabel}`}
                />
              ) : null}
              <span className="react-chat-collab-exec-panel-title" title={taskTitle}>
                {taskTitle}
              </span>
              {/* 运行中：转圈（不再写「运行中」文字） */}
              {isRunning ? (
                <span className="react-chat-collab-exec-panel-running-chip" title="任务正在运行">
                  <span className="react-chat-collab-exec-panel-running-dot" aria-hidden />
                </span>
              ) : null}
              {/* 百分比提到顶部同一行 */}
              {panelProgress != null ? (
                <span
                  className="react-chat-collab-exec-panel-progress-pct"
                  title={`任务进度 ${panelProgress}%`}
                  role="progressbar"
                  aria-valuenow={panelProgress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="任务进度"
                >
                  {panelProgress}%
                </span>
              ) : null}
              {stepStats.total > 0 ? (
                <span
                  className="react-chat-collab-exec-panel-step-chip"
                  title={`共 ${stepStats.total} 个节点：运行中 ${stepStats.running}，已完成 ${stepStats.done}`}
                >
                  {stepStats.done}/{stepStats.total}
                </span>
              ) : null}
              {/* 任务 ID：与标题同行（一行放完），日志/排查时能对上具体是哪个任务 */}
              {tid ? (
                <span className="react-chat-collab-exec-panel-task-id" title={`任务 ID：${tid}`}>
                  {tid}
                </span>
              ) : null}
              {/* 日志开关：打开后每个节点的状态变化都会打进控制台 */}
              <button
                type="button"
                className={`react-chat-collab-exec-panel-log-toggle${nodeLogOn ? ' is-on' : ''}`}
                onClick={toggleNodeLog}
                title={
                  nodeLogOn
                    ? '节点状态日志已开启：控制台会打印每个节点显示的内容（[wf-node] 前缀）。点击关闭'
                    : '开启节点状态日志：控制台会打印每个节点显示的内容（[wf-node] 前缀）'
                }
                aria-label={nodeLogOn ? '关闭节点状态日志' : '开启节点状态日志'}
              >
                日志
              </button>
            </div>
          </div>
        </header>
      ) : null}
      <div className="react-chat-collab-exec-panel-body collab-wf-panel-body">
        {mergedSubtasks === null ? (
          <div className="collab-exec-dag-empty">加载工作流…</div>
        ) : subtasks.length === 0 ? (
          <div className="collab-exec-dag-empty">暂无子任务节点</div>
        ) : (
          <CollabWorkflowCanvas
            subtasks={subtasks}
            mainTaskId={tid}
            taskName={taskTitle}
            leadThreadId={chatThreadId}
            subagentTasks={subagentTasks}
            agents={agents}
            onSubtaskTranscriptOpen={onSubtaskTranscriptOpen}
            subtaskObservability={subtaskObservability}
            fillContainer={canvasFillContainer}
          />
        )}
      </div>
    </aside>
  )
}

export const CollabExecutionPanel = memo(CollabExecutionPanelInner)
