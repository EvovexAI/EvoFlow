import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { tasksAPI } from '../../lib/api-client.js'
import { api } from '../../lib/tauri-api.js'
import type { AgentInfo, CollabSubtaskSnapshot, CollabTaskSnapshot, SubtaskTranscriptModalPayload } from '../chat-types.js'
import { useCollabSubtasksFromApi } from '../hooks/useCollabSubtasksFromApi.js'
import { useSubtaskTranscriptModal } from '../hooks/useSubtaskTranscriptModal.js'
import { CollabExecutionPanel } from './CollabExecutionPanel.js'
import { SubtaskDetailModal } from './SubtaskDetailModal.js'
import { SubtaskExecutionDrawer } from './SubtaskExecutionDrawer.js'
import { LeadConversationPanel } from './LeadConversationPanel.js'
import { subtaskObsMapFromResponse } from '../../lib/task-observability-format.js'
import { fetchSubtaskConversationHistory } from '../../lib/subtask-conversation-history.js'
import { normalizeTaskStatusKey, isTaskRunningStatus, isTaskPlanningStatus, toUnifiedTaskStatus } from '../../lib/task-status-label.js'

function mapTaskToCollabSnapshot(task: Record<string, unknown> | null): CollabTaskSnapshot | null {
  if (!task) return null
  const taskId = String(task.id || task.task_id || '').trim()
  if (!taskId) return null
  const goal = String(task.plan_goal || task.planGoal || '').trim()
  let steps = task.plan_steps || task.planSteps
  if (typeof steps === 'string' && String(steps).trim().startsWith('[')) {
    try {
      steps = JSON.parse(String(steps))
    } catch {
      steps = []
    }
  }
  const hasPlan = !!goal && Array.isArray(steps) && steps.length > 0
  return {
    taskId,
    name: String(task.name || ''),
    status: String(task.status || ''),
    progress: typeof task.progress === 'number' ? task.progress : undefined,
    executionAuthorized: !!(task.execution_authorized ?? task.executionAuthorized),
    boundPlanReady: hasPlan,
    boundPlanPreview: goal || undefined,
  }
}

export type TaskDetailWorkbenchProps = {
  taskId: string
  /** 工作流页顶栏「刷新」递增，触发重新拉取 */
  refreshToken?: number
  /** URL ?subtask= 预选节点 */
  initialSubtaskId?: string
  onBack?: () => void
  onRefresh?: () => void
}

/** 工具栏可切换的面板（详情由点击节点自动出现，不在此列） */
export type WorkflowManualPanelKey = 'lead' | 'workflow'

export type WorkflowVisiblePanelKey = WorkflowManualPanelKey | 'detail'

const MANUAL_PANEL_ORDER: WorkflowManualPanelKey[] = ['lead', 'workflow']

const MANUAL_PANEL_LABELS: Record<WorkflowManualPanelKey, string> = {
  lead: '主控',
  workflow: '工作流',
}

function normalizeManualPanels(panels: WorkflowManualPanelKey[]): WorkflowManualPanelKey[] {
  const uniq: WorkflowManualPanelKey[] = []
  for (const key of MANUAL_PANEL_ORDER) {
    if (panels.includes(key) && !uniq.includes(key)) uniq.push(key)
  }
  return uniq.length ? uniq.slice(0, 2) : ['workflow']
}

function toggleManualPanel(panels: WorkflowManualPanelKey[], key: WorkflowManualPanelKey): WorkflowManualPanelKey[] {
  if (panels.includes(key)) {
    const next = panels.filter((p) => p !== key)
    return next.length ? next : ['workflow']
  }
  if (panels.length < 2) return normalizeManualPanels([...panels, key])
  return normalizeManualPanels([panels[1], key])
}

/** 详情不占工具栏；与手动面板合并后仍最多 2 栏 */
function resolveVisiblePanels(
  manual: WorkflowManualPanelKey[],
  hasDetail: boolean,
): WorkflowVisiblePanelKey[] {
  const base = normalizeManualPanels(manual)
  if (!hasDetail) return base
  if (base.includes('workflow')) return ['workflow', 'detail']
  if (base.includes('lead')) return ['lead', 'detail']
  return ['workflow', 'detail']
}

/** 全屏工作流页：可切换单栏 / 双栏，同时最多展示 2 个面板。 */
export function TaskDetailWorkbench({
  taskId,
  refreshToken = 0,
  initialSubtaskId = '',
  onBack,
  onRefresh,
}: TaskDetailWorkbenchProps) {
  const tid = String(taskId || '').trim()
  const [task, setTask] = useState<Record<string, unknown> | null>(null)
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [refreshKey, setRefreshKey] = useState(0)
  const [subtaskModal, setSubtaskModal] = useState<SubtaskTranscriptModalPayload | null>(null)
  const [manualPanels, setManualPanels] = useState<WorkflowManualPanelKey[]>(['workflow'])
  const [observability, setObservability] = useState<Record<string, unknown> | null>(null)
  const initialSubtaskOpenedRef = useRef(false)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const loadTask = useCallback(async () => {
    if (!tid) return
    try {
      const row = await tasksAPI.getTask(tid)
      if (!aliveRef.current) return
      setTask(row && typeof row === 'object' ? (row as Record<string, unknown>) : null)
    } catch {
      if (aliveRef.current) setTask(null)
    }
  }, [tid])

  const loadRuntime = useCallback(async () => {
    if (!tid) return
    try {
      const runtime = await api.getTaskRuntime(tid)
      if (!aliveRef.current) return
      const list = Array.isArray(runtime?.agents) ? runtime.agents : []
      setAgents(list as AgentInfo[])
    } catch {
      if (aliveRef.current) setAgents([])
    }
  }, [tid])

  const loadObservability = useCallback(async () => {
    if (!tid) return
    try {
      const row = await api.getTaskObservability(tid)
      if (!aliveRef.current) return
      setObservability(row && typeof row === 'object' ? (row as Record<string, unknown>) : null)
    } catch {
      if (aliveRef.current) setObservability(null)
    }
  }, [tid])

  useEffect(() => {
    queueMicrotask(() => {
    void loadTask()
    void loadRuntime()
    void loadObservability()
  })
  }, [loadTask, loadRuntime, loadObservability, refreshKey, refreshToken])

  const status = normalizeTaskStatusKey(task?.status)
  const unified = toUnifiedTaskStatus(status)
  const shouldPoll =
    unified !== 'completed' && unified !== 'failed' && unified !== 'cancelled'
  const pollMs =
    isTaskRunningStatus(status) || isTaskPlanningStatus(status) ? 2000 : 4000
  useEffect(() => {
    if (!tid || !shouldPoll) return
    const timer = window.setInterval(() => {
      setRefreshKey((k) => k + 1)
    }, pollMs)
    return () => window.clearInterval(timer)
  }, [tid, shouldPoll, pollMs])

  // Lead chat thread only — never current_execution_thread_id (often SubThread_* for app/workflow runs)
  const threadId = String(task?.thread_id || '').trim()
  const { subtasks: apiSubtasks, mainTask: apiMainTask } = useCollabSubtasksFromApi({
    taskId: tid,
    threadId,
    enabled: !!tid,
    refreshKey: refreshKey + refreshToken,
    isStillActive: () => aliveRef.current,
  })

  const collabTask = useMemo(() => mapTaskToCollabSnapshot(task), [task])
  const subtaskObservability = useMemo(
    () => subtaskObsMapFromResponse(observability),
    [observability],
  )

  const modalSubtask = useMemo((): CollabSubtaskSnapshot | null => {
    if (!subtaskModal) return null
    const list = apiSubtasks || []
    return list.find((s) => s.subtaskId === subtaskModal.subtaskId) || null
  }, [subtaskModal, apiSubtasks])

  const transcript = useSubtaskTranscriptModal({
    payload: subtaskModal,
    onPayloadChange: setSubtaskModal,
    modalSubtask,
    modalStreamTask: null,
    agents,
    mainTaskId: tid,
    leadThreadId: threadId || '',
  })

  const modalTitle = useMemo(() => {
    const name = String(modalSubtask?.name || subtaskModal?.title || '').trim()
    return name || '子任务详情'
  }, [modalSubtask?.name, subtaskModal?.title])

  const handleSubtaskOpen = useCallback((payload: SubtaskTranscriptModalPayload) => {
    setSubtaskModal(payload)
    setManualPanels((prev) => {
      const base = normalizeManualPanels(prev)
      if (base.includes('workflow')) return base
      return ['workflow']
    })
  }, [])

  const handleSubtaskClose = useCallback(() => {
    setSubtaskModal(null)
  }, [])

  const visiblePanels = useMemo(
    () => resolveVisiblePanels(manualPanels, !!subtaskModal),
    [manualPanels, subtaskModal],
  )
  const showLead = visiblePanels.includes('lead')
  const showWorkflow = visiblePanels.includes('workflow')
  const showDetail = visiblePanels.includes('detail') && !!subtaskModal

  useEffect(() => {
    const sid = String(initialSubtaskId || '').trim()
    if (!sid || !tid || initialSubtaskOpenedRef.current || !apiSubtasks?.length) return
    const hit = apiSubtasks.find((s) => s.subtaskId === sid)
    if (!hit) return
    initialSubtaskOpenedRef.current = true
    void fetchSubtaskConversationHistory({
      mainTaskId: tid,
      subtaskId: sid,
      leadThreadId: threadId || '',
      subtaskSnapshot: hit,
    })
      .then((resp) => {
        setSubtaskModal({
          subtaskId: sid,
          mainTaskId: tid,
          leadThreadId: threadId || '',
          title: String(hit.name || hit.description || sid),
          status: String(hit.status || 'pending'),
          rows: resp.rows,
          emptyConversation: resp.emptyConversation,
          outcome: resp.outcome,
        })
        setManualPanels((prev) => {
          const base = normalizeManualPanels(prev)
          return base.includes('workflow') ? base : ['workflow']
        })
      })
      .catch(() => {
        setSubtaskModal({
          subtaskId: sid,
          mainTaskId: tid,
          title: String(hit.name || hit.description || sid),
          status: String(hit.status || 'pending'),
          rows: [],
        })
        setManualPanels(['workflow'])
      })
  }, [initialSubtaskId, tid, apiSubtasks])

  if (!tid) {
    return <div className="task-detail-workbench-empty">无效任务</div>
  }

  const layoutClassName = [
    'task-detail-workbench',
    'task-workflow-layout',
    `task-workflow-layout--count-${visiblePanels.length}`,
  ].join(' ')

  return (
    <div className={layoutClassName}>
      <nav className="workflow-layout-toolbar" aria-label="工作流工具栏">
        <div className="workflow-layout-toolbar-actions">
          {onBack ? (
            <button type="button" className="workflow-layout-icon-btn" onClick={onBack} title="返回任务详情" aria-label="返回任务详情">
              ←
            </button>
          ) : null}
          {onRefresh ? (
            <button type="button" className="workflow-layout-icon-btn" onClick={onRefresh} title="刷新" aria-label="刷新">
              ↻
            </button>
          ) : null}
        </div>
        <div className="workflow-layout-toolbar-chips" role="group" aria-label="选择要展示的面板，最多两个">
          {MANUAL_PANEL_ORDER.map((key) => {
            const active = manualPanels.includes(key)
            return (
              <button
                key={key}
                type="button"
                className={`workflow-layout-chip${active ? ' is-active' : ''}`}
                aria-pressed={active}
                onClick={() => setManualPanels((prev) => toggleManualPanel(prev, key))}
              >
                {MANUAL_PANEL_LABELS[key]}
              </button>
            )
          })}
        </div>
      </nav>

      <div className="task-workflow-panels">
        {showLead ? (
          <LeadConversationPanel threadId={threadId || null} refreshKey={refreshKey + refreshToken} />
        ) : null}

        {showWorkflow ? (
          <section className="task-detail-workflow-section task-workflow-panel" aria-label="工作流">
            <CollabExecutionPanel
              isOpen
              mainTaskId={tid}
              collabTask={collabTask}
              collabPhase={status === 'planning' ? 'planning' : isTaskRunningStatus(status) ? 'executing' : undefined}
              chatThreadId={threadId || null}
              apiMainTask={apiMainTask}
              apiSubtasks={apiSubtasks}
              agents={agents}
              onClose={() => {}}
              onSubtaskTranscriptOpen={handleSubtaskOpen}
              subtaskObservability={subtaskObservability}
              hideHeaderStatus
              hidePanelHeader
              canvasFillContainer
            />
            {!subtaskModal ? (
              <p className="workflow-inspector-canvas-hint">点击工作流节点查看对话与执行详情</p>
            ) : null}
          </section>
        ) : null}

        {showDetail && subtaskModal ? (
          <SubtaskExecutionDrawer
            open
            mode="drawer"
            subtaskId={subtaskModal.subtaskId}
            statusClass={transcript.statusClass}
            statusLabel={transcript.statusLabel}
            summaryAgent={transcript.modalSummaryAgent}
            shortTitle={transcript.modalShortTitle}
            rows={transcript.modalRowsForDisplay}
            streamActive={transcript.modalIsStreaming}
            sending={transcript.sending}
            canCompose={transcript.modalCanCompose}
            composeText={transcript.composeText}
            composeError={transcript.composeError}
            copyPlainText={transcript.modalCopyPlainText}
            onClose={handleSubtaskClose}
            onOpenDetail={() => transcript.setDetailOpen(true)}
            onComposeTextChange={transcript.setComposeText}
            onSend={() => void transcript.handleSend()}
          />
        ) : null}
      </div>

      <SubtaskDetailModal
        open={transcript.detailOpen}
        title={modalTitle}
        subtask={modalSubtask}
        outcome={subtaskModal?.outcome}
        onClose={() => transcript.setDetailOpen(false)}
      />
    </div>
  )
}
