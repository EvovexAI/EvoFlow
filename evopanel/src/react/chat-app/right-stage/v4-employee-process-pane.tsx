/**
 * 员工执行过程 / 续聊：对话体走主聊同一套 V4（V4SessionPaneBridge → V4ZCodeTimeline），
 * 底部 sticky dock 挂主聊 ChatComposer（可输入、发送、停止），不强制切主区会话。
 *
 * 进度策略（非流式订阅）：
 * - 执行中 / 尚无 thread：约 3s 拉 meta + 强制 V4 投影刷新
 * - 刚结束：再收一帧后停止高频轮询
 * - 已完成：不再定时刷
 * - 打开后宽限内继续刷，避免首轮误绑旧 done 会话就停死
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
  clearEmployeeProcessPendingSend,
  employeeProcessStageTabKey,
  patchEmployeeProcessTabTitle,
  resolveEmployeeProcessTabTitle,
} from '../../../lib/right-stage/open-employee-process-stage.js'
import { rightStageStore } from '../../../lib/right-stage/right-stage-store.js'
import { logRightStagePane } from '../../../lib/right-stage/panel-set-debug-log.js'
import { refreshEvoflowV4Session } from '../../v4/V4StreamRowsBridge.js'
import { V4SessionPaneBridge } from '../../v4/V4SessionPaneBridge.js'
import { toast } from '../../../components/toast.js'
import { EmployeeStageAvatar } from '../../components/EmployeeStageAvatar.js'

/** 执行中：跟进度 */
const POLL_ACTIVE_MS = 3000
/** 刚结束：收尾再确认一次的延迟 */
const SETTLE_DELAY_MS = 2500
/**
 * 派发/唤醒常先开右栏、会话行稍后才入库。若首轮 meta 误绑旧「done」会话会立刻停刷。
 * 打开后宽限内即使看起来已结束也继续轮询，好换到真正在跑的 thread。
 */
const OPEN_GRACE_MS = 45_000

const RUNNING = new Set(['running', 'busy', 'active', 'in_progress', 'queued', 'pending'])


function looksLikeAgentCodeLabel(name: string, agentCode: string): boolean {
  const n = String(name || '').trim()
  const c = String(agentCode || '').trim()
  if (!n) return true
  if (c && n.toLowerCase() === c.toLowerCase()) return true
  if (n === '执行过程' || n === '查看进度' || n === '进度') return true
  return false
}

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
  /** 平台 chat_send 排队的首条消息；挂载后走输入框同款 handleSend */
  pendingSendMessage?: string
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
    pendingSendMessage = '',
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
  const openedAtRef = useRef(Date.now())

  useEffect(() => {
    logRightStagePane('employeeProcess.mount', {
      agentCode: code || null,
      roleName: String(roleName || '').trim() || null,
      title: String(title || '').trim() || null,
      taskId: taskId || null,
      roundId: roundId || null,
      ownerSessionKey: String(sessionKey || '').trim() || null,
      employeeSessionKeyHint: String(employeeSessionKeyHint || '').trim() || null,
      pendingSendLen: String(pendingSendMessage || '').trim().length,
      busy,
    })
  }, [
    code,
    roleName,
    title,
    taskId,
    roundId,
    sessionKey,
    employeeSessionKeyHint,
    pendingSendMessage,
    busy,
  ])

  const fetchMeta = useCallback(async () => {
    if (!code) {
      setLoaded(true)
      return
    }
    try {
      const hintSk = String(employeeSessionKeyHint || employeeSessionKey || '').trim()
      // surface.sessionKey / selectedSessionKey = 主聊归属；绝不能当员工会话去订 V4
      const ownerSk = String(sessionKey || '').trim()
      const meta = await resolveProactiveProcessMeta({
        agentCode: code,
        taskId,
        roundId,
        sessionKey: hintSk || undefined,
        ensureThread: ensureChatThread,
      })
      let tid = String(meta.thread_id || '').trim()
      const metaSk = String(meta.session_key || '').trim()
      // 防串台：解析结果若落到主聊 session/thread，丢掉 thread，继续宽限轮询
      let rejectedOwner = false
      if (ownerSk && metaSk && metaSk === ownerSk) {
        rejectedOwner = true
        tid = ''
      } else if (tid && ownerSk) {
        try {
          const { wsClient } = await import('../../../lib/ws-client.js')
          const ownerTid = String(wsClient.getSessionThreadId?.(ownerSk) || '').trim()
          // 有明确员工 hint 时，ensure 出的 thread 以 hint 为准，勿因偶发与主聊 map 撞号而拒绑
          if (ownerTid && tid === ownerTid && !hintSk) {
            rejectedOwner = true
            tid = ''
          }
        } catch {
          /* optional */
        }
      }
      if (!tid && hintSk) {
        try {
          tid = String((await ensureChatThread(hintSk)) || '').trim()
        } catch {
          /* optional */
        }
      }
      // 拒绑时也必须清掉错误 thread，否则会一直订着主聊
      setThreadId(tid)
      if (hintSk) {
        setEmployeeSessionKey(hintSk)
      } else if (metaSk && metaSk !== ownerSk) {
        setEmployeeSessionKey((prev) => prev || metaSk)
      }
      const status = String(meta.run_status || '').trim()
      if (rejectedOwner) {
        setRunStatus('')
      } else if (hintSk && metaSk && metaSk !== hintSk) {
        /* keep prior / busy fallback */
      } else if (status) {
        setRunStatus(status)
      } else if (!hintSk || metaSk === hintSk) {
        setRunStatus('')
      }
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
      logRightStagePane('employeeProcess.fetchMeta', {
        agentCode: code,
        taskId: taskId || null,
        roundId: roundId || null,
        hintSk: hintSk || null,
        ownerSk: ownerSk || null,
        sessionKey: metaSk || null,
        threadId: tid || null,
        runStatus: rejectedOwner ? null : status || null,
        hintMismatch: Boolean(hintSk && metaSk && metaSk !== hintSk),
        rejectedOwnerBind: rejectedOwner,
        graceMsLeft: Math.max(0, OPEN_GRACE_MS - (Date.now() - openedAtRef.current)),
        displayRole: String(displayRole || roleName || '').trim() || null,
      })
      setLoaded(true)
    } catch (err) {
      logRightStagePane('employeeProcess.fetchMeta error', {
        agentCode: code,
        error: String((err as Error)?.message || err || 'unknown'),
      })
      setLoaded(true)
    }
  }, [code, taskId, roundId, employeeSessionKeyHint, employeeSessionKey, sessionKey])

  const statusLow = String(runStatus || '').toLowerCase()
  // 后端 run_status 是权威；busy 只在尚未取到时兜底。
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
    openedAtRef.current = Date.now()
    wasRunningRef.current = false
    settledRef.current = false
    setLoaded(false)
    setThreadId('')
    setRunStatus('')
  }, [code, taskId, roundId, employeeSessionKeyHint])

  useEffect(() => {
    setDisplayRole(resolveEmployeeProcessTabTitle({ title, roleName, agentCode: code }))
  }, [title, roleName, code])

  // 岗位名缺失或只剩 agent_code 时，拉 proactiveGetRole / agents 补中文名
  useEffect(() => {
    if (!code) return
    let cancelled = false
    const current = String(displayRole || roleName || title || '').trim()
    if (current && !looksLikeAgentCodeLabel(current, code)) return

    void (async () => {
      try {
        const { api } = await import('../../../lib/tauri-api.js')
        let nice = ''
        try {
          const res = await api.proactiveGetRole?.(code)
          const role = (res && typeof res === 'object' ? (res as any).role || res : null) as
            | Record<string, unknown>
            | null
          // 岗位中文名优先；合同名为空时用智能体显示名，绝不用 agent_code
          nice = String(
            role?.role_name || role?.roleName || role?.agent_name || role?.name || '',
          ).trim()
        } catch {
          /* ignore */
        }
        if ((!nice || looksLikeAgentCodeLabel(nice, code)) && typeof api.listAgents === 'function') {
          try {
            const agents = await api.listAgents()
            const row = (Array.isArray(agents) ? agents : []).find(
              (a: any) =>
                String(a?.agent_code || '')
                  .trim()
                  .toLowerCase() === code.toLowerCase(),
            )
            nice =
              String(row?.agent_name || row?.name || '').trim() || nice
          } catch {
            /* ignore */
          }
        }
        if (cancelled || !nice || looksLikeAgentCodeLabel(nice, code)) return
        setDisplayRole(nice)
        patchEmployeeProcessTabTitle(taskId, nice, {
          sessionKey,
          roleName: nice,
          agentCode: code,
        })
      } catch {
        /* ignore */
      }
    })()

    return () => {
      cancelled = true
    }
  }, [code, displayRole, roleName, title, taskId, sessionKey])

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

    const inOpenGrace = Date.now() - openedAtRef.current < OPEN_GRACE_MS
    // 宽限内继续刷：派发后会话行可能晚于右栏打开，避免首轮误绑旧 done 就停死
    const shouldPoll =
      !loaded || running || sending || !threadId || (inOpenGrace && !settledRef.current)

    logRightStagePane('employeeProcess.poll', {
      agentCode: code,
      shouldPoll,
      loaded,
      running,
      sending,
      hasThread: Boolean(threadId),
      inOpenGrace,
      settled: settledRef.current,
      wasRunning: wasRunningRef.current,
      runStatus: statusLow || null,
      sessionKey: String(employeeSessionKeyHint || employeeSessionKey || '').trim() || null,
      threadId: threadId || null,
    })

    if (shouldPoll) {
      wasRunningRef.current = wasRunningRef.current || running || sending
      if (running || sending) settledRef.current = false
      clearSettle()
      clearPoll()
      pollRef.current = setInterval(() => {
        if (disposed) return
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        // 宽限结束后若已非 running 且有 thread，下一轮 effect 会走 settle/停刷
        if (
          Date.now() - openedAtRef.current >= OPEN_GRACE_MS &&
          !running &&
          !sending &&
          threadId &&
          loaded
        ) {
          clearPoll()
          return
        }
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
          sessionKey: String(employeeSessionKey || employeeSessionKeyHint || '').trim() || undefined,
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
  }, [employeeSessionKey, employeeSessionKeyHint, code, taskId, roundId, threadId])

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

  // 平台 chat_send：只开右栏 + pending，由本面板走与输入框同一套发送（ensureThread→chatSend）
  const pendingSentRef = useRef('')
  useEffect(() => {
    const pending = String(pendingSendMessage || '').trim()
    if (!pending || !code) return
    const dedupe = `${code}||${String(employeeSessionKeyHint || employeeSessionKey || '').trim()}||${pending}`
    if (pendingSentRef.current === dedupe) return
    if (sending) return
    pendingSentRef.current = dedupe
    logRightStagePane('employeeProcess.pendingSend → handleSend', {
      agentCode: code,
      pendingLen: pending.length,
      pendingPreview: pending.slice(0, 120),
      employeeSessionKey:
        String(employeeSessionKeyHint || employeeSessionKey || '').trim() || null,
    })
    clearEmployeeProcessPendingSend(taskId, {
      sessionKey,
      agentCode: code,
    })
    void handleSend(pending)
  }, [
    pendingSendMessage,
    code,
    employeeSessionKeyHint,
    employeeSessionKey,
    taskId,
    sessionKey,
    sending,
    handleSend,
  ])

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

  const headerTitleRaw = String(displayRole || title || roleName || '').trim()
  const headerTitle = looksLikeAgentCodeLabel(headerTitleRaw, code)
    ? '执行过程'
    : headerTitleRaw || '执行过程'
  // 时间线 scope 必须用员工会话；主聊 sessionKey 只作文件 tab 挂靠（owner）
  const ownerSessionKey = String(sessionKey || '').trim()
  const timelineSessionKey = String(employeeSessionKey || ownerSessionKey || '').trim()
  const bridgeSessionKey = timelineSessionKey || undefined
  const fileOwnerSessionKey = ownerSessionKey || timelineSessionKey || undefined

  if (!code) return null

  return (
    <div className="v4-employee-process flex h-full min-h-0 flex-col bg-card">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <EmployeeStageAvatar
          agentCode={code}
          title={headerTitle}
          size={22}
          busy={running || sending}
          className="shrink-0"
        />
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
            sessionKey={fileOwnerSessionKey}
            evoflowSessionKey={bridgeSessionKey}
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
