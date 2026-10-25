/**
 * 员工执行过程：对话体只走主聊同一套 V4（V4SessionPaneBridge → V4ZCodeTimeline）。
 * 旧 ProactiveLiveProcessHost / SubtaskExecutionDrawer 行渲染仅作 modal 等非右栏路径。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { resolveProactiveProcessMeta } from '../../../lib/proactive-session-messages.js'
import { V4SessionPaneBridge } from '../../v4/V4SessionPaneBridge.js'

const POLL_MS = 2000
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
  const [displayRole, setDisplayRole] = useState(() => String(roleName || '').trim())
  const [loaded, setLoaded] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

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
      if (meta.role_name) setDisplayRole(String(meta.role_name).trim())
      setLoaded(true)
    } catch {
      setLoaded(true)
    }
  }, [code, taskId, roundId])

  const statusLow = String(runStatus || '').toLowerCase()
  const running = busy || RUNNING.has(statusLow)
  const keepPoll = !loaded || running || !threadId

  useEffect(() => {
    setDisplayRole(String(roleName || '').trim())
  }, [roleName])

  useEffect(() => {
    let disposed = false
    void fetchMeta()
    if (!keepPoll) {
      return () => {
        disposed = true
      }
    }
    pollRef.current = setInterval(() => {
      if (disposed) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void fetchMeta()
    }, POLL_MS)
    return () => {
      disposed = true
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [fetchMeta, keepPoll])

  const headerTitle =
    String(title || '').trim() ||
    String(displayRole || roleName || code).trim() ||
    '执行过程'
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
