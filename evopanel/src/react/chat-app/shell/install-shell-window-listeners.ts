// @ts-nocheck — mechanical extract.
/**
 * Shell window custom-event listeners. Extracted (P87).
 */
export type RunShellWindowListenersEffectCtx = Record<string, any>

export function runShellWindowListenersEffect(ctx: RunShellWindowListenersEffectCtx): void | (() => void) {
  const {
    cancelPendingStreamUiBumpsRef,
    handleNewSessionRef,
    handleOpenHomeRef,
    isChatOverlayDeferActive,
    openCollabExecPanel,
    reviveAllTurnBusyIfLivePostOpen,
    scheduleBumpRef,
    selectSessionFromShellRef,
    setChatSurfaceVisible,
    setMobileChatPane,
  } = ctx
    const onNew = () => {
      if (typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches) {
        setMobileChatPane('thread')
      }
      void handleNewSessionRef.current?.()
    }
    const onOpenHome = () => {
      if (typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches) {
        setMobileChatPane('list')
        return
      }
      void handleOpenHomeRef.current?.()
    }
    const onMobileChatList = () => {
      setMobileChatPane('list')
    }
    const onSettingsModalOpened = () => {
      cancelPendingStreamUiBumpsRef.current()
    }
    const onSettingsModalClosed = () => {
      if (!isChatOverlayDeferActive()) {
        scheduleBumpRef.current?.({ immediate: true })
      }
    }
    const onChatRouteShown = () => {
      // 从知识库/菜单返回：强制解开消息面 + 确保常驻宿主可见
      setChatSurfaceVisible(true)
      try {
        const host = document.getElementById('chat-persistent-host')
        if (host) {
          host.hidden = false
          host.style.display = 'flex'
        }
      } catch {
        /* ignore */
      }
      try {
        const pending = sessionStorage.getItem('evopanel_pending_shell_session')
        const pendingTaskId = sessionStorage.getItem('evopanel_pending_shell_task_id')
        const pendingThread = sessionStorage.getItem('evopanel_pending_shell_thread')
        const pendingOpenWorkflow =
          sessionStorage.getItem('evopanel_pending_open_collab_workflow') === '1'
        let pendingSubtask: Record<string, string> | null = null
        try {
          const raw = sessionStorage.getItem('evopanel_pending_collab_subtask')
          if (raw) pendingSubtask = JSON.parse(raw)
        } catch {
          pendingSubtask = null
        }
        if (pending) {
          sessionStorage.removeItem('evopanel_pending_shell_session')
          selectSessionFromShellRef.current(pending)
        }
        // ChatApp 已挂载时 mount effect 不会重跑：在此补开工作流 + 节点进度 tab
        if (pendingOpenWorkflow || pendingSubtask?.subtaskId) {
          sessionStorage.removeItem('evopanel_pending_open_collab_workflow')
          sessionStorage.removeItem('evopanel_pending_collab_subtask')
          try {
            openCollabExecPanel?.({ clearDismiss: true })
          } catch {
            /* ignore */
          }
          if (pendingSubtask?.subtaskId) {
            window.setTimeout(() => {
              void import('../../../lib/right-stage/open-collab-subtask-stage.js').then((m) => {
                m.openCollabSubtaskInRightStage(
                  {
                    subtaskId: String(pendingSubtask?.subtaskId || ''),
                    mainTaskId: String(pendingSubtask?.mainTaskId || pendingTaskId || ''),
                    leadThreadId: String(pendingSubtask?.leadThreadId || pendingThread || ''),
                    title: String(pendingSubtask?.title || ''),
                    status: String(pendingSubtask?.status || ''),
                    assignedAgent: String(pendingSubtask?.assignedAgent || ''),
                  },
                  { sessionKey: pending || undefined },
                )
              })
            }, 80)
          }
        }
        if (sessionStorage.getItem('evopanel_pending_mobile_chat_list') === '1') {
          sessionStorage.removeItem('evopanel_pending_mobile_chat_list')
          setMobileChatPane('list')
        }
      } catch {
        /* ignore */
      }
      // 任务中心等路由回来：恢复所有 live POST 仍开着却被误 idle 的会话
      reviveAllTurnBusyIfLivePostOpen()
    }
    const onShellSelectSession = (ev: Event) => {
      const key = String((ev as CustomEvent<{ sessionKey?: string }>).detail?.sessionKey || '').trim()
      if (!key) return
      selectSessionFromShellRef.current(key)
    }
    window.addEventListener('evopanel:shell-new-session', onNew)
    window.addEventListener('evopanel:shell-open-home', onOpenHome)
    window.addEventListener('evopanel:mobile-chat-list', onMobileChatList)
    window.addEventListener('evopanel:shell-select-session', onShellSelectSession)
    window.addEventListener('evopanel:settings-modal-opened', onSettingsModalOpened)
    window.addEventListener('evopanel:settings-modal-closed', onSettingsModalClosed)
    window.addEventListener('evopanel:chat-route-shown', onChatRouteShown)
    return () => {
      window.removeEventListener('evopanel:shell-new-session', onNew)
      window.removeEventListener('evopanel:shell-open-home', onOpenHome)
      window.removeEventListener('evopanel:mobile-chat-list', onMobileChatList)
      window.removeEventListener('evopanel:shell-select-session', onShellSelectSession)
      window.removeEventListener('evopanel:settings-modal-opened', onSettingsModalOpened)
      window.removeEventListener('evopanel:settings-modal-closed', onSettingsModalClosed)
      window.removeEventListener('evopanel:chat-route-shown', onChatRouteShown)
    }
}
