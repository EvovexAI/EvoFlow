import { Fragment, memo, useEffect, useMemo } from 'react'
import { resolveAssignedAgentDisplayName } from '../../lib/tool-display.js'
import { fetchSubtaskConversationHistory } from '../../lib/subtask-conversation-history.js'
import { resolveSubtaskLivePreview } from '../../lib/subtask-preview-text.js'
import { SubtaskLiveTicker } from './SubtaskLiveTicker.js'
import { HoverBubble } from './HoverBubble.js'
import { AssignedAgentAvatar } from './AssignedAgentAvatar.js'
import { formatPlanTaskStatusLabel, shouldShowCollabSubtaskSidebar } from '../../lib/plan-task-status.js'
import { formatTaskStatusZh, taskStatusBadgeClass } from '../../lib/task-status-label.js'
import { SubtaskDetailModal } from './SubtaskDetailModal.js'
import { SubtaskExecutionDrawer } from './SubtaskExecutionDrawer.js'
import { useSubtaskTranscriptModal } from '../hooks/useSubtaskTranscriptModal.js'
import {
  normalizeSubtaskStatus,
  isSubtaskRunning,
  isSubtaskCompleted,
  isTerminalSubtaskStatus,
  resolveSubtaskCardDisplayStatus,
} from '../../lib/subtask-transcript-display.js'
// clarification 渲染已迁移到 ClarificationConfirmDock（ChatApp 底部 Dock 区）
import type {
  SubagentStreamTask,
  ThreadPanelState,
  CollabSubtaskSnapshot,
  CollabTaskSnapshot,
  SupervisorStepSnapshot,
  ThreadTodo,
  SubtaskTranscriptModalPayload,
} from '../chat-types.js'
import {
  findSubagentTaskForCollabSubtask,
} from '../../lib/subtask-stream-bind.js'
import { collabDagDebug } from '../../lib/collab-dag-debug.js'
// @ts-ignore
import type { WorkChecklistItem } from '../chat-types.js'

export type { SubtaskTranscriptModalPayload } from '../chat-types.js'

interface SessionSidebarProps {
  state: ThreadPanelState
  taskHistory?: CollabTaskSnapshot[]
  selectedTaskId?: string | null
  activeTaskSubtasks?: CollabSubtaskSnapshot[]
  activeTaskSteps?: SupervisorStepSnapshot[]
  isOpen: boolean
  /** `/api/agents` 列表，用于将子任务 assignedAgent（agent_code）显示为 agent_name（中文） */
  agents?: unknown[]
  /** 会话事件 SSE 连接状态（会话/任务统一流） */
  sessionStreamConnected?: boolean
  onSubmitClarification?: (answerText: string) => void
  /** 由 ChatApp 提升：子任务详情弹窗（任务列表里点子任务与侧栏进度一致） */
  subtaskTranscriptModal: SubtaskTranscriptModalPayload | null
  onSubtaskTranscriptModalChange: (next: SubtaskTranscriptModalPayload | null) => void
  /** 当前 LangGraph thread_id（非 sessionKey）；侧栏子任务不再单独轮询 /tasks */
  chatThreadId?: string | null
  /** ChatApp 统一拉取的 GET /tasks → subtasks（与 CollabExecutionPanel 共用） */
  apiSubtasks?: CollabSubtaskSnapshot[] | null
  /** 底部「开始执行」确认条展示中：隐藏侧栏子任务进度，避免挤占确认操作 */
  execConfirmPending?: boolean
  /** 为 true 时不展示对话上方的子任务网格（统一用右侧协作执行面板） */
  hideCollabSubtaskList?: boolean
  /** 子任务弹窗内点击产出路径 / 附件 */
  onOpenMessageFile?: (rawPath: string, displayName?: string) => void
}

function getStatusClass(status?: string): string {
  return taskStatusBadgeClass(status)
}

// @ts-ignore
function mainTaskLifecycleLabel(task?: CollabTaskSnapshot | null, _phase?: string): string {
  if (task?.status) return formatPlanTaskStatusLabel(task)
  return subtaskStatusZh(task?.status)
}

function subtaskStatusZh(status?: string): string {
  return formatTaskStatusZh(status, { fallback: '待处理' })
}

function toProgress(progress?: number): number | null {
  if (typeof progress !== 'number' || Number.isNaN(progress)) return null
  return Math.min(100, Math.max(0, Math.round(progress)))
}

/** 主任务未开始执行时不展示进度；与主任务表 progress 字段一致（规划阶段为 0）。 */
// @ts-ignore
function mainTaskProgressForDisplay(
  task?: CollabTaskSnapshot | null,
  _phase?: string,
): number | null {
  const status = normalizeSubtaskStatus(task?.status)
  if (
    status === 'planning' ||
    status === 'planned' ||
    status === 'pending' ||
    (!status && !task?.executionAuthorized)
  ) {
    return null
  }
  return toProgress(task?.progress)
}

// NOTE: 进度优化/融合逻辑已移除：进度以服务端快照值为准。

function buildSubtaskMarkdown(s: CollabSubtaskSnapshot, previewText: string): string {
  const normalizedPreview = String(previewText || '').trim()
  if (normalizedPreview) return normalizedPreview
  const report = String((s as any).taskReport || s.result || '').trim()
  if (report) return report
  return ''
}

// latestLiveSegment removed (unused)

// SubtaskWorkChecklistTable removed (unused)

function PlanTodosTable({ todos }: { todos: ThreadTodo[] }) {
  if (!todos.length) return null
  return (
    <table className="react-chat-work-checklist-table react-chat-plan-todos-table">
      <thead>
        <tr>
          <th>#</th>
          <th>状态</th>
          <th>事项</th>
          <th>结果</th>
        </tr>
      </thead>
      <tbody>
        {todos.map((todo, i) => (
          <tr key={`${todo.status || 'pending'}-${i}`}>
            <td>{i + 1}</td>
            <td>{subtaskStatusZh(todo.status)}</td>
            <td>{String(todo.content ?? '').trim()}</td>
            <td>{String((todo as ThreadTodo).result ?? '').trim() || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function SubtaskCard({
  s,
  subagentTasks,
  mainTaskStatus,
  mainTaskId,
  leadThreadId,
  agentsFromApi,
  onOpen,
}: {
  s: CollabSubtaskSnapshot
  subagentTasks?: Record<string, SubagentStreamTask>
  mainTaskStatus?: string
  mainTaskId?: string
  leadThreadId?: string | null
  agentsFromApi?: unknown[]
  onOpen: (payload: SubtaskTranscriptModalPayload) => void
}) {
  const contentText = useMemo(() => {
    const raw = (s.name || s.description || s.subtaskId || '').trim() || '子任务'
    // 如果是长 ID（如 Subtask_20260417055511_035676），截断显示
    if (raw.startsWith('Subtask_') || raw.startsWith('Task_')) {
      const parts = raw.split('_')
      if (parts.length >= 3) {
        const shortId = parts[parts.length - 1].slice(0, 6)
        return `子任务 #${shortId}`
      }
    }
    return raw
  }, [s.name, s.description, s.subtaskId])
  const streamTask = useMemo(() => {
    const ct = (s.name || s.description || s.subtaskId || '').trim() || '子任务'
    return findSubagentTaskForCollabSubtask(subagentTasks, s.subtaskId, ct)
  }, [subagentTasks, s.subtaskId, s.name, s.description])
  const displayStatus = useMemo(
    () => resolveSubtaskCardDisplayStatus(s.status, streamTask, mainTaskStatus),
    [s.status, streamTask, mainTaskStatus],
  )
  useEffect(() => {
    collabDagDebug('subtask_card', {
      subtaskId: s.subtaskId,
      apiStatus: s.status,
      mainTaskStatus,
      streamPhase: streamTask?.phase,
      streamTaskId: streamTask?.taskId,
      displayStatus,
      liveLen: String(streamTask?.liveOutput || '').length,
    })
  }, [s.subtaskId, s.status, mainTaskStatus, streamTask, displayStatus])
  const code = (s.assignedAgent || '').trim()
  const fromSnap = String(s.assignedAgentDisplay || '').trim()
  const agentName = fromSnap || (code ? resolveAssignedAgentDisplayName(code, agentsFromApi) : '') || '未分配'
  const running = isSubtaskRunning(displayStatus)
  const done = isSubtaskCompleted(displayStatus)
  const terminal =
    isTerminalSubtaskStatus(displayStatus) || String(displayStatus || '').trim().toLowerCase() === 'timed_out'
  const fullTitle = `${agentName} · ${contentText}`
  const statusHint = String(
    (s as { currentStep?: string }).currentStep || (s as { current_step?: string }).current_step || '',
  ).trim()
  const terminalFallback = String((s as any).taskReport || s.result || '').trim()
  const livePreview = useMemo(
    () =>
      resolveSubtaskLivePreview({
        subtaskId: String(s.subtaskId || ''),
        fallbackTitle: contentText,
        running,
        terminal,
        subagentTasks,
        statusHint,
        terminalFallback,
      }),
    [s.subtaskId, contentText, running, terminal, subagentTasks, statusHint, terminalFallback],
  )
  const previewText = livePreview.previewText
  const modalMd = useMemo(
    () => buildSubtaskMarkdown(s, previewText),
    [s, previewText],
  )
  const status = useMemo(() => String(displayStatus || '').trim() || 'pending', [displayStatus])
  const progress = useMemo(() => {
    const p = toProgress(s.progress)
    if (isSubtaskCompleted(displayStatus) && p === null) return 100
    return p
  }, [displayStatus, s.progress])
  const a11yStatus = subtaskStatusZh(displayStatus)
  const showLiveRow = Boolean(String(previewText || '').trim())
  return (
    <div
      className={`react-chat-subtask-card react-chat-subtask-card--compact ${showLiveRow ? 'react-chat-subtask-card--live' : ''} ${getStatusClass(displayStatus)}`}
      onClick={() => {
        const fallbackText = modalMd || ''
        const mid = String(mainTaskId || s.parentTaskId || '').trim()
        const sid = String(s.subtaskId || '').trim()
        const lead = String(leadThreadId || '').trim()
        if (!mid || !sid) {
            onOpen({ subtaskId: s.subtaskId, mainTaskId: mid, leadThreadId: lead, title: fullTitle, status, progress, initialText: fallbackText, rows: [] })
          return
        }
        void fetchSubtaskConversationHistory({
          mainTaskId: mid,
          subtaskId: sid,
          leadThreadId: lead,
          subtaskSnapshot: s,
        })
          .then((resp) => {
            const emptyConversation = resp.emptyConversation
            onOpen({
              subtaskId: s.subtaskId,
              mainTaskId: mid,
              leadThreadId: lead,
              title: fullTitle,
              status,
              progress,
              initialText: emptyConversation ? '' : resp.rows.length ? '' : fallbackText,
              rows: resp.rows,
              emptyConversation,
              outcome: resp.outcome,
            })
          })
          .catch(() => {
            // Fallback to current live text when conversation history unavailable.
            onOpen({
              subtaskId: s.subtaskId,
              mainTaskId: mid,
              leadThreadId: lead,
              title: fullTitle,
              status,
              progress,
              initialText: fallbackText,
              rows: [],
              emptyConversation: false,
            })
          })
      }}
      role="button"
      tabIndex={0}
      aria-label={`${fullTitle}，${a11yStatus}`}
    >
      <div className="react-chat-subtask-card-row">
        <span className="react-chat-subtask-card-icon-slot" aria-hidden>
          {running ? (
            <span className="react-chat-subtask-spinner" />
          ) : done ? (
            <span className="react-chat-subtask-check">✓</span>
          ) : (
            <span className="react-chat-subtask-dot" />
          )}
        </span>
        <HoverBubble text={fullTitle} side="bottom" align="start" maxWidth={420}>
          <div className="react-chat-subtask-card-main">
            <div className="react-chat-subtask-card-headline">
              <span className="react-chat-subtask-agent-ico" aria-hidden>
                <AssignedAgentAvatar agentCode={code} agents={agentsFromApi} size={16} busy={running} />
              </span>
              <span className="react-chat-subtask-agent-name">{agentName}</span>
              <span className="react-chat-subtask-head-sep" aria-hidden>
                ·
              </span>
              <span className="react-chat-subtask-card-title">{contentText}</span>
              <HoverBubble text={`状态：${a11yStatus}`} side="top" align="end" maxWidth={200}>
                <span
                  className={`react-chat-subtask-status-badge react-chat-subtask-status-badge--inline ${getStatusClass(displayStatus)}`}
                >
                  {a11yStatus}
                </span>
              </HoverBubble>
            </div>
          </div>
        </HoverBubble>
      </div>
      {showLiveRow ? (
        <div className="react-chat-subtask-live-ticker">
          <SubtaskLiveTicker text={previewText} title={fullTitle ? `${fullTitle}\n${previewText}` : previewText} />
        </div>
      ) : null}
    </div>
  )
}

function SessionSidebarInner({
  state,
  taskHistory,
  selectedTaskId,
  activeTaskSubtasks: _activeTaskSubtasks,
  // activeTaskSteps, // 主任务行/步骤区已隐藏
  agents,
  sessionStreamConnected,
  subtaskTranscriptModal,
  onSubtaskTranscriptModalChange,
  chatThreadId,
  apiSubtasks: apiSubtasksFromParent = null,
  execConfirmPending = false,
  hideCollabSubtaskList = true,
  onOpenMessageFile,
}: SessionSidebarProps) {
  // @ts-ignore
  const phase = String(state.collabPhase || '').trim().toLowerCase()
  // clarification 已迁移到 ClarificationConfirmDock（ChatApp 底部 Dock 区）
  const hasTodos = Array.isArray(state.todos) && state.todos.length > 0
  const history = (taskHistory || []).filter((t) => !!(t.taskId || '').trim())
  const collabFromHistory =
    history.find((t) => (t.taskId || '').trim() === (selectedTaskId || '').trim()) ||
    history.find((t) => (t.taskId || '').trim() === (selectedTaskId || '').trim()) ||
    history[0] ||
    null
  const collab = collabFromHistory || state.collabTask
  const latestTaskId = String(collab?.taskId || selectedTaskId || state.boundTaskId || '').trim()
  const planFormulatedSidebarOpts = {
    hasPlanBody: !!(
      collab?.boundPlanReady ||
      state.planInputFallback?.goal ||
      collab?.planGoal ||
      collab?.boundPlanPreview
    ),
    boundPlanReady: collab?.boundPlanReady,
  }
  const showSidebarSubtaskList =
    !hideCollabSubtaskList &&
    shouldShowCollabSubtaskSidebar(collab, {
      ...planFormulatedSidebarOpts,
      execConfirmPending,
    })
  /** 子任务列表以 ChatApp 统一 GET /tasks 为准 */
  const subtasks = apiSubtasksFromParent ?? []
  const subtasksForModal = subtasks
  // const collabProgressPct = toProgress(collab?.progress) // 进度展示已下线
  // NOTE: 主任务进度条/百分比已隐藏，仅保留状态徽标。

  const showTaskProgress = !hideCollabSubtaskList
    ? showSidebarSubtaskList || (!execConfirmPending && hasTodos)
    : !execConfirmPending && hasTodos
  const sidebarBodyVisible = showTaskProgress
  const hasAnythingToShow = !!subtaskTranscriptModal || sidebarBodyVisible

  const modalSubtask = useMemo(
    () =>
      subtaskTranscriptModal
        ? subtasksForModal.find((s) => s.subtaskId === subtaskTranscriptModal.subtaskId) || null
        : null,
    [subtaskTranscriptModal, subtasksForModal],
  )
  const modalStreamTask = useMemo(() => {
    if (!subtaskTranscriptModal) return null
    const fallbackText = (modalSubtask?.name || modalSubtask?.description || subtaskTranscriptModal.title || '').trim()
    return findSubagentTaskForCollabSubtask(
      state.subagentTasks,
      subtaskTranscriptModal.subtaskId,
      fallbackText,
    ) || null
  }, [subtaskTranscriptModal, modalSubtask, state.subagentTasks])

  const transcript = useSubtaskTranscriptModal({
    payload: subtaskTranscriptModal,
    onPayloadChange: (next) => onSubtaskTranscriptModalChange(next),
    modalSubtask,
    modalStreamTask,
    agents,
    mainTaskId: latestTaskId,
    leadThreadId: chatThreadId || '',
  })

  // 无子任务/待办/澄清内容时不渲染侧栏，避免出现空 div
  if (!hasAnythingToShow) return null

  const asideClass = `react-chat-thread-panel react-chat-task-sidebar`
  const showAside = sidebarBodyVisible
  const threadPanelWillRender = false

  const modalNode = subtaskTranscriptModal ? (
    <SubtaskExecutionDrawer
      open
      mode="modal"
      subtaskId={subtaskTranscriptModal.subtaskId}
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
      onClose={() => onSubtaskTranscriptModalChange(null)}
      onOpenDetail={() => transcript.setDetailOpen(true)}
      onComposeTextChange={transcript.setComposeText}
      onSend={() => void transcript.handleSend()}
      onOpenMessageFile={onOpenMessageFile}
    />
  ) : null

  return (
    <Fragment>
      {showAside ? (
      <aside className={asideClass}>
        {sessionStreamConnected === false ? (
          <div className="react-chat-stream-health-banner react-chat-stream-health-banner--disconnected">
            <span className="react-chat-stream-health-icon" aria-hidden>!</span>
            <span>连接已断开，正在重连…</span>
          </div>
        ) : state.activityKind === 'compacting' ? (
          <div className="react-chat-stream-health-banner react-chat-stream-health-banner--silent">
            <span className="react-chat-stream-health-icon" aria-hidden>~</span>
            <span>正在压缩上下文，请稍候…</span>
          </div>
        ) : null}
        <div
          className={`react-chat-task-sidebar-content${
            !threadPanelWillRender ? ' react-chat-task-sidebar-content--no-top-panel' : ''
          }`}
        >
          {/* clarification 已迁移到 ClarificationConfirmDock；主任务行已隐藏：侧栏仅展示子任务 TODO / 计划待办 */}

          {showSidebarSubtaskList && (
            <div className="react-chat-task-section" role="group" aria-label="子任务">
              <div className="react-chat-task-section-label">
                子任务
                <span className="react-chat-task-count">{subtasks.length}</span>
              </div>
              <div className="react-chat-task-subgrid">
                {subtasks === null ? (
                  <div className="react-chat-task-subgrid-empty">加载子任务…</div>
                ) : subtasks.length === 0 ? (
                  <div className="react-chat-task-subgrid-empty">暂无子任务</div>
                ) : (
                  subtasks.map((s) => (
                    <SubtaskCard
                      key={s.subtaskId}
                      s={s}
                      subagentTasks={state.subagentTasks}
                      mainTaskStatus={collab?.status}
                      mainTaskId={latestTaskId}
                      leadThreadId={chatThreadId}
                      agentsFromApi={agents}
                      onOpen={(payload) => onSubtaskTranscriptModalChange(payload)}
                    />
                  ))
                )}
              </div>
            </div>
          )}

          {!execConfirmPending && hasTodos ? (
            <div className="react-chat-task-section">
              <div className="react-chat-task-section-label">
                计划待办
                <span className="react-chat-task-count">
                  {state.todos.filter((t) => t.status === 'completed').length} / {state.todos.length}
                </span>
              </div>
              <PlanTodosTable todos={state.todos} />
            </div>
          ) : null}
        </div>
      </aside>
      ) : null}
      {modalNode}
      <SubtaskDetailModal
        open={!!subtaskTranscriptModal && transcript.detailOpen}
        title={transcript.modalShortTitle}
        subtask={modalSubtask}
        outcome={subtaskTranscriptModal?.outcome}
        onClose={() => transcript.setDetailOpen(false)}
      />
    </Fragment>
  )
}

export const SessionSidebar = memo(SessionSidebarInner)