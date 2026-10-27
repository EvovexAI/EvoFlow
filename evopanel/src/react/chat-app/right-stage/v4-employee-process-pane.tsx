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
  employeeProcessStageTabKey,
  patchEmployeeProcessTabTitle,
  resolveEmployeeProcessTabTitle,
} from '../../../lib/right-stage/open-employee-process-stage.js'
import { rightStageStore } from '../../../lib/right-stage/right-stage-store.js'
import { refreshEvoflowV4Session } from '../../v4/V4StreamRowsBridge.js'
import { V4SessionPaneBridge } from '../../v4/V4SessionPaneBridge.js'

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
  // 后端 run_status 是唯一权威：一旦拿到（含 done/completed/failed 等终态）就以它为准。
  // busy 只是「派单那一刻」写进 tab 的乐观值，没有任何回写路径；若用「或」合并，
  // 任务早已结束徽标也会永远停在「执行中」，且 3s 高频轮询停不下来（实测复现）。
  // 故 busy 只在后端状态尚未取到时兜底。
  const running = statusLow ? RUNNING.has(statusLow) : busy

  // 拿到后端真实状态后，把 tab.data.busy 同步回落：否则关掉再打开还会读到
  // 派单时写死的 busy=true，徽标又"复活"成执行中。
  useEffect(() => {
    if (!statusLow) return
    const key = employeeProcessStageTabKey(taskId, sessionKey)
    if (!key) return
    const alive = RUNNING.has(statusLow)
    try {
      rightStageStore.patchTab(key, { data: { busy: alive } })
    } catch {
      /* store 不可用时忽略 */
    }
  }, [statusLow, taskId, sessionKey])

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
          {running
            ? '执行中'
            : STATUS_LABEL[statusLow] || runStatus || (loaded ? '已完成' : '加载中')}
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
