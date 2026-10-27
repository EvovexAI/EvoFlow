/**
 * 员工执行过程：对话体只走主聊同一套 V4（V4SessionPaneBridge → V4ZCodeTimeline）。
 * 旧 ProactiveLiveProcessHost / SubtaskExecutionDrawer 行渲染仅作 modal 等非右栏路径。
 *
 * 进度策略（非流式）：
 * - 执行中 / 尚无 thread：约 3s 拉 meta + 强制 V4 投影刷新，保证能看到最新记录
 * - 刚结束：再收一帧后停止高频轮询
 * - 已完成：不再定时刷（结束态没必要打后端）
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { resolveProactiveProcessMeta } from '../../../lib/proactive-session-messages.js'
import {
  patchEmployeeProcessTabTitle,
  resolveEmployeeProcessTabTitle,
} from '../../../lib/right-stage/open-employee-process-stage.js'
import { refreshEvoflowV4Session } from '../../v4/V4StreamRowsBridge.js'
import { V4SessionPaneBridge } from '../../v4/V4SessionPaneBridge.js'

/** 执行中：跟进度 */
const POLL_ACTIVE_MS = 3000
/** 刚结束：收尾再确认一次的延迟 */
const SETTLE_DELAY_MS = 2500

const RUNNING = new Set(['running', 'busy', 'active', 'in_progress', 'queued', 'pending'])

export type V4EmployeeProcessPaneProps = {
  agentCode: string
  roleName?: string
  title?: string
  taskId?: string
  roundId?: string
  busy?: boolean
  /** 归属主会话（文件预览 tab 挂靠）；缺省用员工 session_key */
  sessionKey?: string
  onClose?: () => void
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
    onClose,
  } = props

  const code = String(agentCode || '').trim()
  const [threadId, setThreadId] = useState('')
  const [employeeSessionKey, setEmployeeSessionKey] = useState('')
  const [runStatus, setRunStatus] = useState('')
  const [displayRole, setDisplayRole] = useState(() =>
    resolveEmployeeProcessTabTitle({ title, roleName, agentCode: code }),
  )
  const [loaded, setLoaded] = useState(false)
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
      let ensureThread: ((sk: string) => Promise<string>) | undefined
      try {
        const { wsClient } = await import('../../../lib/ws-client.js')
        if (wsClient && typeof wsClient.resolveSessionThreadId === 'function') {
          ensureThread = (sk: string) => wsClient.resolveSessionThreadId(sk)
        } else if (wsClient && typeof wsClient.ensureChatThread === 'function') {
          ensureThread = async (sk: string) => {
            const r = await wsClient.ensureChatThread(sk)
            return String(
              r?.thread_id || r?.threadId || wsClient.getSessionThreadId?.(sk) || '',
            ).trim()
          }
        }
      } catch {
        ensureThread = undefined
      }

      const meta = await resolveProactiveProcessMeta({
        agentCode: code,
        taskId,
        roundId,
        ensureThread,
      })
      const tid = String(meta.thread_id || '').trim()
      if (tid) setThreadId(tid)
      if (meta.session_key) setEmployeeSessionKey(String(meta.session_key).trim())
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
      // 有 thread 就拉最新投影（不要求流式，只要记录跟上）
      if (tid) refreshEvoflowV4Session(tid)
      setLoaded(true)
    } catch {
      setLoaded(true)
    }
  }, [code, taskId, roundId])

  const statusLow = String(runStatus || '').toLowerCase()
  const running = busy || RUNNING.has(statusLow)

  useEffect(() => {
    setDisplayRole(resolveEmployeeProcessTabTitle({ title, roleName, agentCode: code }))
  }, [title, roleName, code])

  // 标签回写员工名
  useEffect(() => {
    const tid = String(taskId || '').trim()
    const nice = String(displayRole || '').trim()
    if (!tid || !nice || nice === '执行过程') return
    patchEmployeeProcessTabTitle(tid, nice, {
      sessionKey,
      roleName: nice,
    })
  }, [displayRole, taskId, sessionKey])

  // 自适应轮询：跑着跟；结束后收一帧再停
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

    // 未就绪或执行中才高频跟；没有 thread 但已结束则不必空转
    if (!loaded || running) {
      wasRunningRef.current = wasRunningRef.current || running
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

    // 刚从执行中结束：再拉一次最新记录，然后停
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

    // 已完成且已收尾：不再轮询
    clearPoll()
    clearSettle()
    return () => {
      disposed = true
      clearPoll()
      clearSettle()
    }
  }, [fetchMeta, loaded, running, threadId])

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
            (running
              ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
              : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400')
          }
        >
          {running ? '执行中' : runStatus || (loaded ? '已完成' : '加载中')}
        </span>
        <div className="flex-1" />
        {onClose ? (
          <button
            type="button"
            className="rounded p-1 text-foreground-subtlest hover:bg-hover"
            onClick={onClose}
            aria-label="关闭"
          >
            ✕
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {threadId ? (
          <V4SessionPaneBridge
            sessionId={threadId}
            connecting={!loaded}
            sessionKey={bridgeSessionKey}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-ui-sm text-foreground-subtlest">
            {!loaded
              ? '正在解析员工会话…'
              : running
                ? '执行中，等待会话 thread…'
                : '暂无员工会话（未绑定 thread_id）'}
          </div>
        )}
      </div>
    </div>
  )
}
