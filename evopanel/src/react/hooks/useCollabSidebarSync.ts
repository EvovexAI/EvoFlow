/**
 * Collab sidebar task views + stream/API snapshot merge.
 * Extracted from ChatApp.tsx (P13).
 */
import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import { wsClient } from '../../lib/ws-client.js'
import { notifyDesktopCompletion } from '../../lib/desktop-notification.js'
import {
  fetchCollabSubtasksForMainTask,
  preferPersistedCollabSubtasks,
} from '../../lib/collab-subtasks-from-api.js'
import {
  finalizeCollabSubtasksList,
  mapSnapSupervisorSteps,
  mergeCollabSubtasksStable,
  trimStepsToLatestTask,
  type SidebarTaskView,
} from '../chat-app/collab/subtask-merge.js'
import type {
  ChatSessionRow,
  CollabSubtaskSnapshot,
  CollabTaskSnapshot,
  StreamState,
  SubagentStreamTask,
  SupervisorStepSnapshot,
  ThreadPanelState,
} from '../chat-types.js'

function mapSnapSubtasks(subsRaw: unknown): CollabSubtaskSnapshot[] {
  if (!Array.isArray(subsRaw)) return []
  return subsRaw
    .map((row) => {
      const r = row as Record<string, unknown>
      const sid = typeof r.subtaskId === 'string' ? r.subtaskId.trim() : ''
      if (!sid) return null
      const dn =
        typeof (r as any).assignedAgentDisplay === 'string' &&
        String((r as any).assignedAgentDisplay).trim()
          ? String((r as any).assignedAgentDisplay).trim()
          : typeof (r as any).assignedAgentName === 'string' && String((r as any).assignedAgentName).trim()
            ? String((r as any).assignedAgentName).trim()
            : typeof (r as any).assigned_agent_name === 'string' &&
                String((r as any).assigned_agent_name).trim()
              ? String((r as any).assigned_agent_name).trim()
              : ''
      const assignedCode =
        typeof r.assignedAgent === 'string' && r.assignedAgent.trim()
          ? r.assignedAgent.trim()
          : typeof (r as any).assigned_to === 'string' && String((r as any).assigned_to).trim()
            ? String((r as any).assigned_to).trim()
            : ''
      const out: CollabSubtaskSnapshot = {
        subtaskId: sid,
        ...(typeof r.parentTaskId === 'string' ? { parentTaskId: r.parentTaskId } : {}),
        ...(typeof r.name === 'string' ? { name: r.name } : {}),
        ...(typeof r.description === 'string' ? { description: r.description } : {}),
        ...(typeof r.status === 'string' ? { status: r.status } : {}),
        ...(typeof r.progress === 'number' ? { progress: r.progress } : {}),
        ...(assignedCode ? { assignedAgent: assignedCode } : {}),
        ...(dn ? { assignedAgentDisplay: dn } : {}),
        ...(typeof (r as any).currentStep === 'string'
          ? { currentStep: (r as any).currentStep }
          : typeof (r as any).current_step === 'string'
            ? { currentStep: (r as any).current_step }
            : {}),
        ...(Array.isArray((r as any).workChecklist)
          ? { workChecklist: (r as any).workChecklist }
          : Array.isArray((r as any).work_checklist)
            ? { workChecklist: (r as any).work_checklist }
            : []),
      }
      return out
    })
    .filter(Boolean) as CollabSubtaskSnapshot[]
}

export type { SidebarTaskView }

export function useCollabSidebarSync(opts: {
  selectedSessionKey: string
  sessionRef: MutableRefObject<string>
  sessionsRef: MutableRefObject<ChatSessionRow[]>
  streamRef: MutableRefObject<StreamState>
  setThreadPanelState: Dispatch<SetStateAction<ThreadPanelState>>
  bumpSubtasksApiRefresh: () => void
  setSubagentDockTasks: Dispatch<SetStateAction<Record<string, SubagentStreamTask>>>
  planAppliedForRef: MutableRefObject<string>
  planFromApiLoadedRef: MutableRefObject<string>
}) {
  const {
    selectedSessionKey,
    sessionRef,
    sessionsRef,
    streamRef,
    setThreadPanelState,
    bumpSubtasksApiRefresh,
    setSubagentDockTasks,
    planAppliedForRef,
    planFromApiLoadedRef,
  } = opts

  const [sidebarTaskViews, setSidebarTaskViews] = useState<Record<string, SidebarTaskView>>({})
  const [sidebarSelectedTaskId, setSidebarSelectedTaskId] = useState<string | null>(null)
  const parentTaskToSubtaskRef = useRef<Record<string, string>>({})
  const subtasksBackfillInFlightRef = useRef<Record<string, boolean>>({})
  const subtasksBackfillLastAtRef = useRef<Record<string, number>>({})
  const collabTaskStatusNotifyRef = useRef(new Map<string, string>())

  const upsertSidebarTaskView = useCallback(
    (
      task: CollabTaskSnapshot | null | undefined,
      subtasks?: CollabSubtaskSnapshot[],
      steps?: SupervisorStepSnapshot[],
    ) => {
      const taskId = (task?.taskId || '').trim()
      if (!taskId || !task) return
      const sessionKey = String(sessionRef.current || selectedSessionKey || '').trim()
      const normalizedSteps = trimStepsToLatestTask(steps)
      setSidebarTaskViews((prev) => {
        const cur = prev[taskId]
        const mergedSubtasks = preferPersistedCollabSubtasks(
          Array.isArray(subtasks)
            ? mergeCollabSubtasksStable(cur?.subtasks || [], subtasks)
            : cur?.subtasks || [],
        )
        return {
          ...prev,
          [taskId]: {
            task: { ...(cur?.task || {}), ...task },
            subtasks: mergedSubtasks,
            steps: normalizedSteps ?? cur?.steps ?? [],
            updatedAt: Date.now(),
            sessionKey: sessionKey || cur?.sessionKey,
          },
        }
      })
      setSidebarSelectedTaskId(taskId)
    },
    [selectedSessionKey, sessionRef],
  )

  const ensureSubtasksVisibleForTask = useCallback(
    async (taskId: string) => {
      const tid = String(taskId || '').trim()
      if (!tid) return
      const captureSk = String(sessionRef.current || selectedSessionKey || '').trim()
      const now = Date.now()
      const last = subtasksBackfillLastAtRef.current[tid] || 0
      if (now - last < 4000) return
      if (subtasksBackfillInFlightRef.current[tid]) return
      subtasksBackfillInFlightRef.current[tid] = true
      subtasksBackfillLastAtRef.current[tid] = now
      try {
        let threadId = captureSk ? wsClient.getSessionThreadId(captureSk) || '' : ''
        if (!threadId || threadId.startsWith('agent:')) {
          const rowHint = String(
            sessionsRef.current.find((s) => String(s.sessionKey || '') === captureSk)?.threadId || '',
          ).trim()
          threadId = rowHint && !rowHint.startsWith('agent:') ? rowHint : ''
        }
        const mapped = await fetchCollabSubtasksForMainTask(tid, {
          ...(threadId ? { threadId, preferTaskId: tid } : { preferTaskId: tid }),
        })
        if (String(sessionRef.current || '').trim() !== captureSk) return
        if (!mapped.length) return
        setThreadPanelState((prev) => {
          if (String(sessionRef.current || '').trim() !== captureSk) return prev
          const prevTaskId = String(prev.collabTask?.taskId || '').trim()
          if (prevTaskId && prevTaskId !== tid) return prev
          return {
            ...prev,
            collabSubtasks: finalizeCollabSubtasksList(
              mergeCollabSubtasksStable(prev.collabSubtasks || [], mapped),
              prev.subagentTasks,
            ),
          }
        })
        upsertSidebarTaskView({ taskId: tid }, mapped, undefined)
        bumpSubtasksApiRefresh()
      } catch {
        /* swallow */
      } finally {
        subtasksBackfillInFlightRef.current[tid] = false
      }
    },
    [
      upsertSidebarTaskView,
      selectedSessionKey,
      bumpSubtasksApiRefresh,
      sessionRef,
      sessionsRef,
      setThreadPanelState,
    ],
  )

  const clearSidebarBackfillCaches = useCallback(() => {
    subtasksBackfillLastAtRef.current = {}
    subtasksBackfillInFlightRef.current = {}
  }, [])

  const applyTaskProgressSnapshot = useCallback(
    (snap: Record<string, unknown> | null, opts?: { sessionKey?: string }) => {
      if (!snap) return
      const captureSk = String(opts?.sessionKey || sessionRef.current || selectedSessionKey || '').trim()
      const phase = typeof snap.collab_phase === 'string' ? snap.collab_phase : null
      const boundTaskId =
        typeof snap.bound_task_id === 'string' && snap.bound_task_id.trim()
          ? snap.bound_task_id.trim()
          : null
      const stepsFromSnap = mapSnapSupervisorSteps(snap.supervisor_steps)

      const mainRaw = snap.main_task
      if (!mainRaw || typeof mainRaw !== 'object') {
        if (String(sessionRef.current || '').trim() !== captureSk) return
        setThreadPanelState((prev) => ({
          ...prev,
          ...(phase != null ? { collabPhase: phase } : {}),
          ...(boundTaskId != null ? { boundTaskId } : {}),
          ...(stepsFromSnap.length ? { supervisorSteps: stepsFromSnap } : {}),
        }))
        return
      }
      const main = mainRaw as Record<string, unknown>
      const taskId = typeof main.taskId === 'string' ? main.taskId.trim() : ''
      if (!taskId) {
        if (String(sessionRef.current || '').trim() !== captureSk) return
        setThreadPanelState((prev) => ({
          ...prev,
          ...(phase != null ? { collabPhase: phase } : {}),
          ...(boundTaskId != null ? { boundTaskId } : {}),
          ...(stepsFromSnap.length ? { supervisorSteps: stepsFromSnap } : {}),
        }))
        return
      }
      const collabSubtasks = mapSnapSubtasks(snap.subtasks)

      const collabTask: CollabTaskSnapshot = {
        taskId,
        ...(typeof main.name === 'string' ? { name: main.name } : {}),
        ...(typeof main.status === 'string' ? { status: main.status } : {}),
        ...(typeof main.progress === 'number' ? { progress: main.progress } : {}),
        ...(typeof main.executionAuthorized === 'boolean'
          ? { executionAuthorized: main.executionAuthorized }
          : typeof (main as { execution_authorized?: boolean }).execution_authorized === 'boolean'
            ? { executionAuthorized: (main as { execution_authorized: boolean }).execution_authorized }
            : {}),
        ...(typeof main.lifecycleStage === 'string' ? { lifecycleStage: main.lifecycleStage } : {}),
        ...(typeof main.lifecycleLabel === 'string' ? { lifecycleLabel: main.lifecycleLabel } : {}),
        ...(typeof main.boundPlanPreview === 'string' ? { boundPlanPreview: main.boundPlanPreview } : {}),
      }

      const taskName = typeof collabTask.name === 'string' ? collabTask.name.trim() : ''
      const nextTaskSt = String(collabTask.status || '')
        .trim()
        .toLowerCase()
      const prevTaskSt = collabTaskStatusNotifyRef.current.get(taskId) || ''
      if (nextTaskSt && nextTaskSt !== prevTaskSt) {
        collabTaskStatusNotifyRef.current.set(taskId, nextTaskSt)
        if (nextTaskSt === 'completed' && prevTaskSt !== 'completed') {
          void notifyDesktopCompletion({
            title: 'EvoFlow · 任务完成',
            body: taskName ? `「${taskName}」已完成` : '协作任务已完成',
            tag: `task:${taskId}:completed`,
          })
        } else if (nextTaskSt === 'failed' && prevTaskSt !== 'failed') {
          void notifyDesktopCompletion({
            title: 'EvoFlow · 任务失败',
            body: taskName ? `「${taskName}」执行失败` : '协作任务执行失败',
            tag: `task:${taskId}:failed`,
          })
        }
      }

      setThreadPanelState((prev) => {
        if (String(sessionRef.current || '').trim() !== captureSk) return prev
        const prevTaskId = (prev.collabTask?.taskId || '').trim()
        const switchedTask = !!prevTaskId && prevTaskId !== taskId
        if (switchedTask) {
          streamRef.current.subagentTasks = {}
          streamRef.current.terminalStreams = {}
          setSubagentDockTasks({})
          parentTaskToSubtaskRef.current = {}
        }
        const nextSubtasks =
          collabSubtasks.length > 0
            ? finalizeCollabSubtasksList(collabSubtasks, prev.subagentTasks)
            : switchedTask
              ? []
              : preferPersistedCollabSubtasks(prev.collabSubtasks || [])
        const mergedCollabTask = switchedTask
          ? collabTask
          : {
              ...(prev.collabTask || {}),
              ...collabTask,
              ...(prev.collabTask?.status === 'planned' && !collabTask.status
                ? { status: 'planned' }
                : {}),
              ...(prev.collabTask?.boundPlanReady && !collabTask.boundPlanReady
                ? { boundPlanReady: true }
                : {}),
            }
        return {
          ...prev,
          collabPhase: phase ?? prev.collabPhase,
          boundTaskId: boundTaskId ?? prev.boundTaskId,
          collabTask: mergedCollabTask,
          collabSubtasks: nextSubtasks,
          supervisorSteps: stepsFromSnap.length ? stepsFromSnap : switchedTask ? [] : prev.supervisorSteps,
        }
      })
      upsertSidebarTaskView(collabTask, collabSubtasks.length > 0 ? collabSubtasks : undefined, stepsFromSnap)
      if (collabSubtasks.length > 0) bumpSubtasksApiRefresh()

      const planGoal = String(
        (main as { planGoal?: string }).planGoal || main.boundPlanPreview || '',
      ).trim()
      const boundReady =
        (main as { boundPlanReady?: boolean }).boundPlanReady === true ||
        String(main.status || '')
          .trim()
          .toLowerCase() === 'planned'
      if (planGoal || boundReady) {
        if (!captureSk) return
        const applyKey = `${captureSk}:${taskId}`
        if (planAppliedForRef.current === applyKey) return
        const loadKey = `${captureSk}:${taskId}:${planGoal.slice(0, 48)}`
        if (planFromApiLoadedRef.current === loadKey) return
      }
    },
    [
      upsertSidebarTaskView,
      selectedSessionKey,
      bumpSubtasksApiRefresh,
      sessionRef,
      streamRef,
      setThreadPanelState,
      setSubagentDockTasks,
      planAppliedForRef,
      planFromApiLoadedRef,
    ],
  )

  return {
    sidebarTaskViews,
    setSidebarTaskViews,
    sidebarSelectedTaskId,
    setSidebarSelectedTaskId,
    parentTaskToSubtaskRef,
    subtasksBackfillInFlightRef,
    subtasksBackfillLastAtRef,
    collabTaskStatusNotifyRef,
    upsertSidebarTaskView,
    ensureSubtasksVisibleForTask,
    clearSidebarBackfillCaches,
    applyTaskProgressSnapshot,
  }
}
