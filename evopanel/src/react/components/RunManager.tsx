import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { fetchCollabSubtasksForMainTask } from '../../lib/collab-subtasks-from-api.js'
import { tasksAPI } from '../../lib/api-client.js'
import { formatTaskStatusZh, taskStatusBadgeClass } from '../../lib/task-status-label.js'
import type { SubagentStreamTask } from '../chat-types.js'
import { SubtaskCard, type SubtaskTranscriptModalPayload } from './SessionSidebar.js'

interface RunInfo {
  run_id: string
  thread_id: string
  assistant_id: string
  status: 'pending' | 'running' | 'success' | 'failed'
  created_at: string
  updated_at: string | null
  model_name: string | null
  is_plan_mode: boolean | null
  subagent_enabled: boolean | null
}

interface RunsResponse {
  runs: RunInfo[]
  total: number
  pending: number
  running: number
}

interface SubtaskInfo {
  subtaskId: string
  name?: string
  description?: string
  status?: string
  assignedAgent?: string
  assignedAgentDisplay?: string
}

interface RunManagerProps {
  isOpen: boolean
  taskNames?: Array<{ taskId: string; name: string; status?: string; updatedAt?: number }>
  selectedTaskId?: string | null
  onSelectTaskId?: (taskId: string) => void
  onClose: () => void
  /** `/api/agents` 列表，用于将子任务 assignedAgent（agent_code）显示为 agent_name（中文） */
  agents?: unknown[]
  /** 与 SessionSidebar 子任务弹窗一致：子智能体流聚合 */
  subagentTasks?: Record<string, SubagentStreamTask>
  onSubtaskTranscriptOpen: (payload: SubtaskTranscriptModalPayload) => void
}

function formatTime(dateStr: string | number): string {
  const date = typeof dateStr === 'number' ? new Date(dateStr) : new Date(dateStr)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  if (hours < 24) return `${hours}小时前`
  return date.toLocaleDateString('zh-CN')
}

function getTaskStatusText(status?: string): string {
  return formatTaskStatusZh(status, { fallback: '待执行' })
}

function getTaskStatusClass(status?: string): string {
  return taskStatusBadgeClass(status)
}

function getStatusText(status: string): string {
  switch (status) {
    case 'pending':
      return '等待中'
    case 'running':
      return '运行中'
    case 'success':
      return '已完成'
    case 'failed':
      return '失败'
    default:
      return status
  }
}

function getStatusClass(status: string): string {
  switch (status) {
    case 'pending':
      return 'run-status-pending'
    case 'running':
      return 'run-status-running'
    case 'success':
      return 'run-status-success'
    case 'failed':
      return 'run-status-failed'
    default:
      return ''
  }
}

export function RunManager({
  isOpen,
  taskNames,
  selectedTaskId,
  onSelectTaskId,
  onClose,
  agents,
  subagentTasks,
  onSubtaskTranscriptOpen,
}: RunManagerProps) {
  const [runs, setRuns] = useState<RunInfo[]>([])
  const [taskNameFallback, setTaskNameFallback] = useState<Array<{ taskId: string; name: string; status?: string; updatedAt?: string }>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [subtasks, setSubtasks] = useState<SubtaskInfo[]>([])
  const [subtasksLoading, setSubtasksLoading] = useState(false)

  // Task output state
  const [taskOutput, setTaskOutput] = useState<any[]>([])
  const [taskOutputLoading, setTaskOutputLoading] = useState(false)
  const [taskOutputError, setTaskOutputError] = useState<string | null>(null)
  const [showOutputPanel, setShowOutputPanel] = useState(false)
  const [outputOffset, setOutputOffset] = useState(0)
  const [hasMoreOutput, setHasMoreOutput] = useState(false)
  const outputPollIntervalRef = useRef<number | null>(null)
  const lastTimestampRef = useRef<string | null>(null)

  const fetchSubtasks = async () => {
    if (!selectedTaskId) {
      setSubtasks([])
      return
    }
    try {
      setSubtasksLoading(true)
      const mapped = await fetchCollabSubtasksForMainTask(selectedTaskId)
      setSubtasks(
        mapped.map((s) => ({
          subtaskId: String(s.subtaskId || ''),
          name: s.name,
          description: s.description,
          status: s.status,
          assignedAgent: s.assignedAgent,
          assignedAgentDisplay: s.assignedAgentDisplay,
        })).filter((s) => s.subtaskId),
      )
    } catch {
      setSubtasks([])
    } finally {
      setSubtasksLoading(false)
    }
  }

  const fetchRuns = async () => {
    try {
      setLoading(true)
      const { gatewayJson } = await import('../../lib/gateway-json.js')
      const data = (await gatewayJson('GET', '/api/langgraph/runs/')) as RunsResponse
      setRuns(data.runs)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '未知错误')
    } finally {
      setLoading(false)
    }
  }

  // 已移除 /api/events/tasks/{id}/stream 订阅：改为轮询刷新（Run 列表本身已每 5 秒 fetchRuns）

  // Load task output history
  const loadTaskOutput = useCallback(async (taskId: string, offset: number = 0, fromTimestamp?: string | null) => {
    if (!taskId) return
    
    try {
      setTaskOutputLoading(true)
      setTaskOutputError(null)
      
      const options: any = { offset, limit: 50 }
      if (fromTimestamp) {
        options.from_timestamp = fromTimestamp
      }
      
      const data: any = await tasksAPI.getTaskOutput(taskId, options)
      
      if (offset === 0) {
        // Initial load - replace all
        setTaskOutput(data.entries || [])
      } else {
        // Append new entries
        setTaskOutput(prev => [...prev, ...(data.entries || [])])
      }
      
      setHasMoreOutput(data.pagination?.has_more || false)
      setOutputOffset(offset + (data.entries?.length || 0))
      
      // Update last timestamp for polling
      if (data.entries && data.entries.length > 0) {
        const lastEntry = data.entries[data.entries.length - 1]
        lastTimestampRef.current = lastEntry._timestamp || lastEntry.timestamp
      }
    } catch (err) {
      console.error('Error loading task output:', err)
      setTaskOutputError(err instanceof Error ? err.message : '加载输出失败')
    } finally {
      setTaskOutputLoading(false)
    }
  }, [])

  // Start polling for new output
  const startOutputPolling = useCallback((taskId: string) => {
    // Clear existing interval
    if (outputPollIntervalRef.current != null) {
      window.clearInterval(outputPollIntervalRef.current)
    }

    // Initial load
    loadTaskOutput(taskId, 0)

    // Poll every 2 seconds for new output（必须用 window.*，避免全局 setInterval 解析成 NodeJS.Timeout）
    outputPollIntervalRef.current = window.setInterval(() => {
      loadTaskOutput(taskId, 0, lastTimestampRef.current)
    }, 2000)
  }, [loadTaskOutput])

  // Stop polling
  const stopOutputPolling = useCallback(() => {
    if (outputPollIntervalRef.current != null) {
      window.clearInterval(outputPollIntervalRef.current)
      outputPollIntervalRef.current = null
    }
  }, [])

  // Cleanup on unmount or task change
  useEffect(() => {
    return () => {
      stopOutputPolling()
    }
  }, [stopOutputPolling])

  // Handle view output button click
  const handleViewOutput = () => {
    if (!selectedTaskId) return
    setShowOutputPanel(true)
    loadTaskOutput(selectedTaskId, 0)
    startOutputPolling(selectedTaskId)
  }

  // Handle close output panel
  const handleCloseOutput = () => {
    setShowOutputPanel(false)
    stopOutputPolling()
  }

  // Load more output (pagination)
  const handleLoadMoreOutput = () => {
    if (!selectedTaskId || taskOutputLoading) return
    loadTaskOutput(selectedTaskId, outputOffset)
  }

  const fetchTaskNamesFallback = async () => {
    try {
      const data = await tasksAPI.listTasks()
      const rows = Array.isArray(data) ? data : []
      const next = rows
        .map((r: any) => {
          const taskId = String(r?.id || r?.task_id || '').trim()
          if (!taskId) return null
          const name = String(r?.name || r?.title || taskId).trim() || taskId
          const status = String(r?.status || '').trim() || undefined
          const updatedAt = r?.updated_at || r?.created_at
          return { taskId, name, status, updatedAt }
        })
        .filter(Boolean) as Array<{ taskId: string; name: string; status?: string; updatedAt?: string }>
      setTaskNameFallback(next)
    } catch {
      // 兜底也失败时静默，不覆盖主错误展示
    }
  }

  useEffect(() => {
    if (!isOpen) return
    // Defer initial fetch to avoid cascading renders
    requestAnimationFrame(() => {
      fetchRuns()
      fetchTaskNamesFallback()
    })
    // 每 5 秒刷新一次
    const interval = window.setInterval(fetchRuns, 5000)
    return () => window.clearInterval(interval)
  }, [isOpen])

  // Compute display task names - must be before any conditional returns
  const displayTaskNames =
    taskNames && taskNames.length > 0
      ? taskNames
      : taskNameFallback

  /** 默认按更新时间倒序（原筛选栏默认排序） */
  const sortedTaskNames = useMemo(() => {
    const result = [...displayTaskNames]
    result.sort((a, b) => {
      const aTime = a.updatedAt || 0
      const bTime = b.updatedAt || 0
      const aMs = typeof aTime === 'number' ? aTime : new Date(aTime as string | number).getTime()
      const bMs = typeof bTime === 'number' ? bTime : new Date(bTime as string | number).getTime()
      return bMs - aMs
    })
    return result
  }, [displayTaskNames])

  const selectedMainTaskStatus = useMemo(() => {
    const tid = String(selectedTaskId || '').trim()
    if (!tid) return undefined
    const row = sortedTaskNames.find((t) => t.taskId === tid)
    return row?.status
  }, [selectedTaskId, sortedTaskNames])

  useEffect(() => {
    if (!isOpen || !selectedTaskId) {
      // Defer state update to avoid cascading renders
      requestAnimationFrame(() => {
        setSubtasks([])
      })
      return
    }
    let cancelled = false
    const run = () => {
      if (!cancelled) void fetchSubtasks()
    }
    // Defer initial fetch to avoid cascading renders
    requestAnimationFrame(() => {
      if (!cancelled) run()
    })
    const st = String(selectedMainTaskStatus || '').trim().toLowerCase()
    const shouldPoll = ['executing', 'running', 'paused', 'in_progress', 'verifying', 'reflecting'].includes(st)
    if (!shouldPoll) {
      return () => {
        cancelled = true
      }
    }
    const timer = window.setInterval(run, 8000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [selectedTaskId, isOpen, selectedMainTaskStatus])

  // Conditional return must be after all hooks
  if (!isOpen) return null

  return (
    <aside className="react-chat-run-manager">
      <div className="react-chat-run-manager-header">
        <h3 className="react-chat-run-manager-title">任务列表</h3>
        <button
          type="button"
          className="react-chat-run-manager-close"
          onClick={onClose}
          title="关闭"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="react-chat-run-manager-content">
        {sortedTaskNames.length > 0 ? (
          <div className="react-chat-run-task-names">
            <ul className="react-chat-run-task-names-list">
              {sortedTaskNames.map((t) => {
                const statusText = getTaskStatusText(t.status)
                const statusClass = getTaskStatusClass(t.status)
                const timeText = t.updatedAt ? formatTime(t.updatedAt) : ''
                return (
                  <li key={t.taskId}>
                    <button
                      type="button"
                      className={`react-chat-run-task-name-item${
                        selectedTaskId && selectedTaskId === t.taskId ? ' active' : ''
                      }`}
                      onClick={() => onSelectTaskId?.(t.taskId)}
                      title={t.name}
                    >
                      <span className="react-chat-run-task-name-text">{t.name}</span>
                      {timeText && <span className="react-chat-run-task-time">{timeText}</span>}
                      <span className={`react-chat-run-task-status-badge ${statusClass}`}>
                        {statusText}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        ) : (
          <div className="react-chat-run-empty">
            <p>暂无任务</p>
          </div>
        )}

        {/* 子任务列表 */}
        {selectedTaskId && (
          <div className="react-chat-run-subtasks">
            <div className="react-chat-run-subtasks-actions">
              <button
                type="button"
                className="react-chat-run-output-btn"
                onClick={handleViewOutput}
                disabled={!selectedTaskId}
                title="查看执行输出"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                  <polyline points="10 9 9 9 8 9" />
                </svg>
                <span>查看输出</span>
              </button>
            </div>
            <div className="react-chat-run-subtasks-header">
              <span className="react-chat-run-subtasks-title">子任务</span>
              <span className="react-chat-run-subtasks-count">
                {subtasksLoading ? '加载中...' : `${subtasks.length} 个`}
              </span>
            </div>
            {subtasksLoading ? (
              <div className="react-chat-run-subtasks-loading">加载中...</div>
            ) : subtasks.length === 0 ? (
              <div className="react-chat-run-subtasks-empty">暂无子任务</div>
            ) : (
              <div className="react-chat-run-manager-subtasks-grid">
                {subtasks.map((sub) => (
                  <SubtaskCard
                    key={sub.subtaskId}
                    s={{
                      subtaskId: sub.subtaskId,
                      parentTaskId: selectedTaskId,
                      name: sub.name,
                      description: sub.description,
                      status: sub.status,
                      assignedAgent: sub.assignedAgent,
                      assignedAgentDisplay: sub.assignedAgentDisplay,
                    }}
                    subagentTasks={subagentTasks}
                    mainTaskId={selectedTaskId}
                    mainTaskStatus={selectedMainTaskStatus}
                    agentsFromApi={agents}
                    onOpen={onSubtaskTranscriptOpen}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* 任务输出面板 */}
        {showOutputPanel && selectedTaskId && (
          <div className="react-chat-run-output-panel">
            <div className="react-chat-run-output-header">
              <span className="react-chat-run-output-title">执行输出</span>
              <button
                type="button"
                className="react-chat-run-output-close"
                onClick={handleCloseOutput}
                title="关闭"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="react-chat-run-output-content">
              {taskOutputLoading && taskOutput.length === 0 ? (
                <div className="react-chat-run-output-loading">加载中...</div>
              ) : taskOutputError ? (
                <div className="react-chat-run-output-error">{taskOutputError}</div>
              ) : taskOutput.length === 0 ? (
                <div className="react-chat-run-output-empty">暂无输出</div>
              ) : (
                <>
                  <div className="react-chat-run-output-entries">
                    {taskOutput.map((entry, index) => (
                      <div
                        key={index}
                        className={`react-chat-run-output-entry react-chat-run-output-${entry.type}`}
                      >
                        {entry.type === 'task_started' && (
                          <div className="output-task-started">
                            <span className="output-icon">▶️</span>
                            <span className="output-text">任务开始: {entry.description}</span>
                          </div>
                        )}
                        {entry.type === 'task_running' && entry.message && (
                          <div className="output-task-running">
                            {typeof entry.message === 'string' ? (
                              <span className="output-text">{entry.message}</span>
                            ) : (
                              <pre className="output-json">{JSON.stringify(entry.message, null, 2)}</pre>
                            )}
                          </div>
                        )}
                        {entry.type === 'task_completed' && (
                          <div className="output-task-completed">
                            <span className="output-icon">✅</span>
                            <span className="output-text">任务完成</span>
                            {entry.result && (
                              <pre className="output-result">{entry.result}</pre>
                            )}
                          </div>
                        )}
                        {entry.type === 'task_failed' && (
                          <div className="output-task-failed">
                            <span className="output-icon">❌</span>
                            <span className="output-text">任务失败: {entry.error}</span>
                          </div>
                        )}
                        {entry.type === 'task_timed_out' && (
                          <div className="output-task-timed-out">
                            <span className="output-icon">⏱️</span>
                            <span className="output-text">任务超时</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  {hasMoreOutput && (
                    <button
                      type="button"
                      className="react-chat-run-output-load-more"
                      onClick={handleLoadMoreOutput}
                      disabled={taskOutputLoading}
                    >
                      {taskOutputLoading ? '加载中...' : '加载更多'}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* 任务列表 */}
        {loading ? (
          <div className="react-chat-run-loading">加载中...</div>
        ) : error ? (
          <div className="react-chat-run-error">{error}</div>
        ) : (
          <ul className="react-chat-run-list">
            {runs.map(run => (
              <li key={run.run_id} className={`react-chat-run-item ${getStatusClass(run.status)}`}>
                <div className="react-chat-run-item-header">
                  <span className="react-chat-run-status-badge">
                    {getStatusText(run.status)}
                  </span>
                  <span className="react-chat-run-time" title={new Date(run.created_at).toLocaleString()}>
                    {formatTime(run.created_at)}
                  </span>
                </div>
                <div className="react-chat-run-item-body">
                  <div className="react-chat-run-field">
                    <span className="react-chat-run-label">线程 ID:</span>
                    <span className="react-chat-run-value">{run.thread_id.slice(0, 8)}...</span>
                  </div>
                  <div className="react-chat-run-field">
                    <span className="react-chat-run-label">智能体:</span>
                    <span className="react-chat-run-value">{run.assistant_id}</span>
                  </div>
                  {run.model_name && (
                    <div className="react-chat-run-field">
                      <span className="react-chat-run-label">模型:</span>
                      <span className="react-chat-run-value">{run.model_name}</span>
                    </div>
                  )}
                  <div className="react-chat-run-field">
                    <span className="react-chat-run-label">计划模式:</span>
                    <span className="react-chat-run-value">{run.is_plan_mode ? '是' : '否'}</span>
                  </div>
                  {run.updated_at && (
                    <div className="react-chat-run-field">
                      <span className="react-chat-run-label">更新:</span>
                      <span className="react-chat-run-value">{formatTime(run.updated_at)}</span>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}
