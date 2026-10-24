/**
 * On ChatApp mount: adopt pending shell-aside session/thread/task from sessionStorage.
 * Extracted from ChatApp.tsx (P68).
 */
import { dispatchSessionTurnEvent } from '../../lib/session-runtime-store.js'
import { openCollabSubtaskInRightStage } from '../../../lib/right-stage/open-collab-subtask-stage.js'

export type ApplyPendingShellSessionCtx = {
  processedTaskIdRef: { current: string | null }
  sessionRef: { current: string }
  setBoundTaskId: (taskId: string) => void
  getApi: () => Promise<{
    chatSessionSetHidden: (sessionKey: string, hidden: boolean) => Promise<unknown>
  }>
  refreshSessions: (opts?: { skipAutoReselect?: boolean }) => void | Promise<unknown>
  bindSessionThread: (
    sessionKey: string,
    threadId: string,
    opts: { context: Record<string, unknown> },
  ) => Promise<unknown>
  reload: (opts?: { bypassCache?: boolean }) => Promise<unknown>
  openCollabExecPanel: (opts: { clearDismiss: boolean }) => void
}

export function applyPendingShellSession(ctx: ApplyPendingShellSessionCtx): void {
  try {
    const pendingSession = sessionStorage.getItem('evopanel_pending_shell_session')
    const pendingThread = sessionStorage.getItem('evopanel_pending_shell_thread')
    const pendingTaskId = sessionStorage.getItem('evopanel_pending_shell_task_id')

    // 🔧 关键修复：只要存在 pendingTaskId 且未处理过，就应该设置 boundTaskId
    if (pendingTaskId && ctx.processedTaskIdRef.current !== pendingTaskId) {
      ctx.processedTaskIdRef.current = pendingTaskId
      queueMicrotask(() => ctx.setBoundTaskId(pendingTaskId))
      // Session 会自动通过 wsClient.getSessionThreadId 获取 threadId 来订阅流
      // 🔧 标记这是从任务跳转过来的，防止 selectedSessionKey 变化时重置 boundTaskId
      if (pendingSession) {
        ctx.sessionRef.current = pendingSession
      }
    }

    const pendingOpenWorkflow =
      sessionStorage.getItem('evopanel_pending_open_collab_workflow') === '1'
    let pendingSubtask: {
      subtaskId?: string
      mainTaskId?: string
      leadThreadId?: string
      title?: string
      status?: string
      assignedAgent?: string
    } | null = null
    try {
      const raw = sessionStorage.getItem('evopanel_pending_collab_subtask')
      if (raw) pendingSubtask = JSON.parse(raw)
    } catch {
      pendingSubtask = null
    }

    if (pendingSession) {
      if (
        String(pendingSession).startsWith('automation:') ||
        String(pendingSession).includes(':duty:')
      ) {
        void ctx
          .getApi()
          .then((api) => api.chatSessionSetHidden(pendingSession, false))
          .then(() => ctx.refreshSessions({ skipAutoReselect: true }))
          .catch(() => {})
      }
      if (pendingThread) {
        void ctx
          .bindSessionThread(pendingSession, pendingThread, {
            context: {
              taskRelated: true,
              ...(pendingTaskId ? { collab_task_id: pendingTaskId } : {}),
            },
          })
          .then(() => {
            if (String(ctx.sessionRef.current || '').trim() === pendingSession) {
              void ctx.reload({ bypassCache: true })
            }
          })
          .catch((e: unknown) => {
            console.warn('[ChatApp] bindSessionThread failed:', e)
          })
      }

      if (pendingOpenWorkflow || pendingSubtask?.subtaskId) {
        ctx.openCollabExecPanel({ clearDismiss: true })
      }
      if (pendingSubtask?.subtaskId) {
        // 稍晚于工作流 tab，确保两侧栏都挂上：工作流 + 该节点独立进度
        window.setTimeout(() => {
          openCollabSubtaskInRightStage(
            {
              subtaskId: String(pendingSubtask?.subtaskId || ''),
              mainTaskId: String(pendingSubtask?.mainTaskId || pendingTaskId || ''),
              leadThreadId: String(pendingSubtask?.leadThreadId || pendingThread || ''),
              title: String(pendingSubtask?.title || ''),
              status: String(pendingSubtask?.status || ''),
              assignedAgent: String(pendingSubtask?.assignedAgent || ''),
            },
            { sessionKey: pendingSession },
          )
        }, 80)
      }

      // 注意：useState 初始化时已经优先返回了 pendingSession
      // 这里不需要再 setSelectedSessionKey，避免重复渲染
      // 🔧 延迟清理 sessionStorage，避免 StrictMode 双重渲染问题
      setTimeout(() => {
        sessionStorage.removeItem('evopanel_pending_shell_session')
        sessionStorage.removeItem('evopanel_pending_shell_thread')
        sessionStorage.removeItem('evopanel_pending_shell_task_id')
        sessionStorage.removeItem('evopanel_pending_open_collab_workflow')
        sessionStorage.removeItem('evopanel_pending_collab_subtask')
      }, 1000)
    }

    // 从“任务重新开始/开始执行”跳转到实时对话页时：run 可能尚未进入 running/pending。
    // 续流仅由用户刷新页面/侧栏刷新按钮触发，此处不再自动 poll attach。
    if (pendingSession && pendingThread && pendingTaskId) {
      void ctx.reload({ bypassCache: true }).catch(() => {
        dispatchSessionTurnEvent(pendingSession, {
          type: 'REATTACH_FAILED',
          threadId: pendingThread,
        })
      })
    }
  } catch (e) {
    console.error('[ChatApp] 处理 pending session 失败:', e)
  }
}
