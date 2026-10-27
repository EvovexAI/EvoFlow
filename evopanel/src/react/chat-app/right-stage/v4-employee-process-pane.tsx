/**
 * 员工执行过程 / 续聊：对话体走主聊同一套 V4（V4SessionPaneBridge → V4ZCodeTimeline），
 * 底部 sticky dock 挂主聊 ChatComposer（可输入、发送、停止），不强制切主区会话。
 *
 * 进度策略（非流式订阅）：
 * - 执行中 / 尚无 thread：约 3s 拉 meta + 强制 V4 投影刷新
 * - 刚结束：再收一帧后停止高频轮询
 * - 已完成：不再定时刷
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatAttachment } from '../../chat-types.js'
import { ChatComposer } from '../../components/ChatComposer.js'
import { mintEmployeeChatEpisodeId } from '../../components/EmployeeTalkModeBar.js'
import {
  isProactiveSessionKey,
  parseProactiveSessionKey,
} from '../../lib/session-list/workspace-groups.js'
import { resolveProactiveProcessMeta } from '../../../lib/proactive-session-messages.js'
import {
  employeeProcessStageTabKey,
  patchEmployeeProcessTabTitle,
  resolveEmployeeProcessTabTitle,
} from '../../../lib/right-stage/open-employee-process-stage.js'
import { rightStageStore } from '../../../lib/right-stage/right-stage-store.js'
import { refreshEvoflowV4Session } from '../../v4/V4StreamRowsBridge.js'
import { V4SessionPaneBridge } from '../../v4/V4SessionPaneBridge.js'
import { toast } from '../../../components/toast.js'

/** 执行中：跟进度 */
const POLL_ACTIVE_MS = 3000
/** 刚结束：收尾再确认一次的延迟 */
const SETTLE_DELAY_MS = 2500

const RUNNING = new Set(['running', 'busy', 'active', 'in_progress', 'queued', 'pending'])

/** 后端 run_status 原值 → 徽标文案（未收录的回退原样显示） */
const STATUS_LABEL: Record<string, string> = {
  done: '已完成',
  completed: '已完成',
  success: '已完成',
  failed: '失败',
  error: '失败',
  cancelled: '已取消',
  canceled: '已取消',
  timeout: '超时',
  timed_out: '超时',
  running: '执行中',
  busy: '执行中',
  active: '执行中',
  in_progress: '执行中',
  queued: '排队中',
  pending: '等待中',
}

export type V4EmployeeProcessPaneProps = {
  agentCode: string
  roleName?: string
  title?: string
  taskId?: string
  roundId?: string
  busy?: boolean
  /** 归属主会话（文件预览 tab 挂靠）；缺省用员工 session_key */
  sessionKey?: string
  /** 平台 chat_send / openStage 传入的员工对话 key，优先于 meta 解析 */
  employeeSessionKeyHint?: string
  onClose?: () => void
}

async function ensureChatThread(sessionKey: string): Promise<string> {
  const sk = String(sessionKey || '').trim()
  if (!sk) return ''
  try {
    const { wsClient } = await import('../../../lib/ws-client.js')
    if (typeof wsClient.resolveSessionThreadId === 'function') {
      return String((await wsClient.resolveSessionThreadId(sk)) || '').trim()
    }
    if (typeof wsClient.ensureChatThread === 'function') {
      const r = await wsClient.ensureChatThread(sk)
      return String(
        r?.thread_id || r?.threadId || wsClient.getSessionThreadId?.(sk) || '',
      ).trim()
    }
  } catch {
    /* optional */
  }
  return ''
}

async function patchProactiveChatContext(sessionKey: string): Promise<void> {
  if (!isProactiveSessionKey(sessionKey)) return
  const parsed = parseProactiveSessionKey(sessionKey)
  try {
    const { api } = await import('../../../lib/tauri-api.js')
    const patch: Record<string, unknown> = {
      source: 'proactive',
      proactive_agent_code: parsed.agentCode || null,
      employee_talk_mode: 'chat',
    }
    if (parsed.kind === 'task' && parsed.taskId) {
      patch.workspace_kind = 'task'
      patch.related_task_id = parsed.taskId
    } else if (parsed.kind === 'chat') {
      patch.workspace_kind = 'chat'
      patch.related_task_id = null
    } else if (parsed.kind === 'duty') {
      patch.workspace_kind = 'duty'
    }
    await api.chatUpdateContext?.(sessionKey, patch)
  } catch {
    /* ignore */
  }
}

function mintEmployeeChatSessionKey(agentCode: string): string {
  const code = String(agentCode || '').trim()
  if (!code) return ''
  const stamp = mintEmployeeChatEpisodeId()
    .replace(/^chat:/, '')
    .replace(/[:/\\]/g, '-')
  return `proactive:${code}:chat:${stamp}`
}

export function V4EmployeeProcessPane(props: V4EmployeeProcessPaneProps) {
  const {
    agentCode,
    roleName = '',
    title,
    taskId = '',
    roundId = '',
    busy = false,
    sessionKey = '',
    employeeSessionKeyHint = '',
    onClose,
  } = props

  const code = String(agentCode || '').trim()
  const [threadId, setThreadId] = useState('')
  const [employeeSessionKey, setEmployeeSessionKey] = useState(() =>
    String(employeeSessionKeyHint || '').trim(),
  )

  useEffect(() => {
    const hint = String(employeeSessionKeyHint || '').trim()
    if (hint) setEmployeeSessionKey(hint)
  }, [employeeSessionKeyHint])
  const [runStatus, setRunStatus] = useState('')
  const [displayRole, setDisplayRole] = useState(() =>
    resolveEmployeeProcessTabTitle({ title, roleName, agentCode: code }),
  )
  const [loaded, setLoaded] = useState(false)
  const [sending, setSending] = useState(false)
  const [draftVersion, setDraftVersion] = useState(0)
  const draftRef = useRef('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wasRunningRef = useRef(false)
  const settledRef = useRef(false)

  const fetchMeta = useCallback(async () => {
    if (!code) {
      setLoaded(true)
      return
    }
    try {
      const meta = await resolveProactiveProcessMeta({
        agentCode: code,
        taskId,
        roundId,
        ensureThread: ensureChatThread,
      })
      const tid = String(meta.thread_id || '').trim()
      if (tid) setThreadId(tid)
      // 平台 chat_send / 用户已绑定的 key 优先，避免轮询 meta 抢成别的会话
      if (meta.session_key) {
        setEmployeeSessionKey((prev) => prev || String(meta.session_key).trim())
      }
      if (meta.run_status) setRunStatus(String(meta.run_status).trim())
      if (meta.role_name) {
        setDisplayRole(
          resolveEmployeeProcessTabTitle({
            title: meta.role_name,
            roleName: meta.role_name,
            agentCode: code,
          }),
        )
      }
      if (tid) refreshEvoflowV4Session(tid)
      setLoaded(true)
    } catch {
      setLoaded(true)
    }
  }, [code, taskId, roundId])

  const statusLow = String(runStatus || '').toLowerCase()
  // 后端 run_status 是唯一权威；busy 只在尚未取到时兜底。
  const running = statusLow ? RUNNING.has(statusLow) : busy
  const turnBusy = sending || running

  useEffect(() => {
    if (!statusLow) return
    const key = employeeProcessStageTabKey(taskId, sessionKey, code)
    if (!key) return
    const alive = RUNNING.has(statusLow)
    try {
      rightStageStore.patchTab(key, { data: { busy: alive } })
    } catch {
      /* store 不可用时忽略 */
    }
  }, [statusLow, taskId, sessionKey, code])

  useEffect(() => {
    setDisplayRole(resolveEmployeeProcessTabTitle({ title, roleName, agentCode: code }))
  }, [title, roleName, code])

  useEffect(() => {
    const nice = String(displayRole || '').trim()
    if (!code || !nice || nice === '执行过程') return
    patchEmployeeProcessTabTitle(taskId, nice, {
      sessionKey,
      roleName: nice,
      agentCode: code,
    })
  }, [displayRole, taskId, sessionKey, code])

  useEffect(() => {
    let disposed = false

    const clearPoll = () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
    const clearSettle = () => {
      if (settleTimerRef.current) {
        clearTimeout(settleTimerRef.current)
        settleTimerRef.current = null
      }
    }

    void fetchMeta()

    if (!loaded || running || sending) {
      wasRunningRef.current = wasRunningRef.current || running || sending
      settledRef.current = false
      clearSettle()
      clearPoll()
      pollRef.current = setInterval(() => {
        if (disposed) return
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        void fetchMeta()
      }, POLL_ACTIVE_MS)
      return () => {
        disposed = true
        clearPoll()
        clearSettle()
      }
    }

    if (wasRunningRef.current && !settledRef.current) {
      settledRef.current = true
      clearPoll()
      clearSettle()
      settleTimerRef.current = setTimeout(() => {
        if (disposed) return
        void fetchMeta()
      }, SETTLE_DELAY_MS)
      return () => {
        disposed = true
        clearPoll()
        clearSettle()
      }
    }

    clearPoll()
    clearSettle()
    return () => {
      disposed = true
      clearPoll()
      clearSettle()
    }
  }, [fetchMeta, loaded, running, sending, threadId])

  const resolveSendSessionKey = useCallback(async (): Promise<{ sk: string; tid: string }> => {
    let sk = String(employeeSessionKey || '').trim()
    if (!sk && code) {
      if (taskId) {
        const meta = await resolveProactiveProcessMeta({
          agentCode: code,
          taskId,
          roundId,
          ensureThread: ensureChatThread,
        })
        sk = String(meta.session_key || '').trim()
      }
      if (!sk) sk = mintEmployeeChatSessionKey(code)
      setEmployeeSessionKey(sk)
    }
    let tid = String(threadId || '').trim()
    if (sk && !tid) {
      tid = await ensureChatThread(sk)
      if (tid) setThreadId(tid)
    }
    return { sk, tid }
  }, [employeeSessionKey, code, taskId, roundId, threadId])

  const handleSend = useCallback(
    async (message: string, attachments?: ChatAttachment[]) => {
      const text = String(message || '').trim()
      if (!text || sending) return
      setSending(true)
      try {
        const { sk, tid } = await resolveSendSessionKey()
        if (!sk) {
          toast('无法解析员工会话', 'error')
          return
        }
        await patchProactiveChatContext(sk)
        const { api } = await import('../../../lib/tauri-api.js')
        await api.chatSend(sk, text, attachments || [], undefined, {
          source: 'employee-process-pane',
        })
        draftRef.current = ''
        setDraftVersion((v) => v + 1)
        if (tid) refreshEvoflowV4Session(tid)
        // 乐观：进入执行中，等 meta 回写
        setRunStatus('running')
        void fetchMeta()
      } catch (e) {
        toast(String((e as Error)?.message || e || '发送失败'), 'error')
      } finally {
        setSending(false)
      }
    },
    [sending, resolveSendSessionKey, fetchMeta],
  )

  const handleAbort = useCallback(async () => {
    const sk = String(employeeSessionKey || '').trim()
    if (!sk) return
    try {
      const { api } = await import('../../../lib/tauri-api.js')
      await api.chatAbort?.(sk, undefined, { userInitiated: true, skipRunIdle: true })
      await api.stopSessionExecution?.(sk, { userInitiated: true })
      toast('已停止执行', 'info')
      void fetchMeta()
    } catch (e) {
      toast(String((e as Error)?.message || e || '停止失败'), 'error')
    }
  }, [employeeSessionKey, fetchMeta])

  const handleDraftChange = useCallback((value: string) => {
    draftRef.current = value
  }, [])

  const composerDock = useMemo(
    () => (
      <div
        className="v4-employee-process-composer border-t border-border bg-card px-2 pb-2 pt-1"
        data-v4-employee-composer-host="true"
      >
        <ChatComposer
          sessionReady={Boolean(code)}
          engineReady
          initialDraft={draftRef.current}
          draftVersion={draftVersion}
          onDraftChange={handleDraftChange}
          sending={turnBusy}
          streaming={turnBusy}
          onSend={handleSend}
          onAbort={handleAbort}
          placeholder={
            displayRole
              ? `跟「${displayRole}」说点什么…`
              : '输入消息，继续与该员工对话…'
          }
          speechEnabled={false}
        />
      </div>
    ),
    [
      code,
      draftVersion,
      handleDraftChange,
      turnBusy,
      handleSend,
      handleAbort,
      displayRole,
    ],
  )

  const headerTitle =
    String(displayRole || title || roleName || code).trim() || '执行过程'
  const bridgeSessionKey = String(sessionKey || employeeSessionKey || '').trim() || undefined

  if (!code) return null

  return (
    <div className="v4-employee-process flex h-full min-h-0 flex-col bg-card">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 truncate text-ui-sm font-medium text-foreground">{headerTitle}</span>
        <span
          className={
            'rounded px-1.5 py-0.5 text-[11px] ' +
            (running || sending
              ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
              : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400')
          }
        >
          {running || sending
            ? '执行中'
            : STATUS_LABEL[statusLow] || runStatus || (loaded ? '可对话' : '加载中')}
        </span>
        <div className="flex-1" />
        {onClose ? (
          <button
            type="button"
            className="rounded p-1 text-foreground-subtlest hover:bg-hover"
            onClick={onClose}
            aria-label="关闭"
          >
            {'\u2715'}
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {threadId ? (
          <V4SessionPaneBridge
            sessionId={threadId}
            connecting={!loaded}
            sessionKey={bridgeSessionKey}
            bottomDock={composerDock}
          />
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-ui-sm text-foreground-subtlest">
              {!loaded
                ? '正在解析员工会话…'
                : running || sending
                  ? '执行中，等待会话 thread…'
                  : '暂无历史消息，可在下方直接发第一句'}
            </div>
            {composerDock}
          </div>
        )}
      </div>
    </div>
  )
}
