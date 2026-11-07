/**
 * 协作 / 工作流节点进度：对话体只走主聊同一套 V4（V4SessionPaneBridge → V4ZCodeTimeline）。
 * 与员工执行过程对齐：sessionBusy 驱动末轮齿轮；底部可续聊；旁观靠 meta + catchup。
 *
 * 进度策略（本机通常无该子会话 SSE）：
 * - 执行中 / 尚无 thread：约 2s 拉 meta + V4 catchup 心跳
 * - 已完成：停刷并 settle 再收一帧；标题旁保留最近活动时间
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { tasksAPI } from '../../../lib/api-client.js'
import {
  fetchSubtaskTranscriptMeta,
  outcomeFromSubtaskSnapshot,
} from '../../../lib/subtask-conversation-history.js'
import { summarizeOutcome } from '../../../lib/subtask-transcript-seed.js'
import {
  formatTaskStatusZh,
  isTaskRunningStatus,
  isTaskPlanningStatus,
  isTaskCancellableStatus,
} from '../../../lib/task-status-label.js'
import type { CollabSubtaskStageOutcome } from '../../../lib/right-stage/open-collab-subtask-stage.js'
import { formatTrailRowClock } from '../../components/SubtaskExecutionDrawer.js'
import {
  peekEvoflowV4LastActivityAt,
  refreshEvoflowV4Session,
} from '../../v4/V4StreamRowsBridge.js'
import { V4SessionPaneBridge } from '../../v4/V4SessionPaneBridge.js'

const POLL_MS = 2000
/** 右栏 / 调试坞观察无 live mirror：soft catchup 与 meta 同频 */
const V4_SOFT_MS = POLL_MS
/** 标题时钟：投影更新后本地再扫一遍 store */
const ACTIVITY_PEEK_MS = 1000
const SETTLE_DELAY_MS = 2500

const LOG_TAG = '[wf-step-transcript]'

function wfLog(event: string, detail: Record<string, unknown>) {
  try {
    console.info(LOG_TAG, event, { t: new Date().toISOString(), ...detail })
  } catch {
    /* ignore */
  }
}

export type V4CollabSubtaskTranscriptPaneProps = {
  mainTaskId: string
  subtaskId: string
  leadThreadId?: string
  title?: string
  status?: string
  assignedAgent?: string
  description?: string
  subtaskThreadId?: string
  sessionKey?: string
  initialOutcome?: CollabSubtaskStageOutcome | null
  /** 调试坞内嵌：不显示关闭；仍可刷新 / 续聊 */
  embedded?: boolean
  /** 默认 true：与员工面板一样可续聊 */
  allowCompose?: boolean
  onClose?: () => void
}

export function V4CollabSubtaskTranscriptPane(props: V4CollabSubtaskTranscriptPaneProps) {
  const {
    mainTaskId,
    subtaskId,
    leadThreadId = '',
    title,
    status: statusProp = '',
    assignedAgent = '',
    description = '',
    subtaskThreadId = '',
    sessionKey = '',
    initialOutcome = null,
    embedded = false,
    allowCompose = true,
    onClose,
  } = props

  const [outcome, setOutcome] = useState<CollabSubtaskStageOutcome | null | undefined>(
    () => initialOutcome,
  )
  const [status, setStatus] = useState(String(statusProp || ''))
  const [resolvedThreadId, setResolvedThreadId] = useState(() => String(subtaskThreadId || '').trim())
  const [loaded, setLoaded] = useState(() => !!String(subtaskThreadId || '').trim() || !!initialOutcome)
  const [lastActivityAt, setLastActivityAt] = useState<number | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [composeText, setComposeText] = useState('')
  const [composeError, setComposeError] = useState('')
  const [sending, setSending] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const outcomeRef = useRef<CollabSubtaskStageOutcome | null | undefined>(initialOutcome)
  const wasRunningRef = useRef(false)
  const settledRef = useRef(false)
  const statusRef = useRef(String(statusProp || ''))

  const running =
    isTaskRunningStatus(status) || isTaskPlanningStatus(status) || sending
  // pending/queued 也要继续心跳，否则等依赖放行时永远拿不到 thread_id / 状态跳变
  const keepMetaPoll = !loaded || isTaskCancellableStatus(status) || running
  const turnBusy = running || sending
  const statusLabel = formatTaskStatusZh(status, { fallback: running ? '执行中' : '已完成' })

  const syncLastActivity = useCallback((threadId: string) => {
    const tid = String(threadId || '').trim()
    if (!tid) return
    const at = peekEvoflowV4LastActivityAt(tid)
    if (at != null) {
      setLastActivityAt((prev) => (prev != null && prev >= at ? prev : at))
    }
  }, [])

  const bumpV4 = useCallback(
    (threadId: string, reason: string) => {
      const tid = String(threadId || '').trim()
      if (!tid) return
      wfLog('v4.catchup', {
        reason,
        threadId: tid,
        mainTaskId,
        subtaskId,
        status: statusRef.current,
      })
      refreshEvoflowV4Session(tid, { softIntervalMs: V4_SOFT_MS })
      syncLastActivity(tid)
    },
    [mainTaskId, subtaskId, syncLastActivity],
  )

  const fetchMeta = useCallback(
    async (opts?: { silent?: boolean; reason?: string }) => {
      const mid = String(mainTaskId || '').trim()
      const sid = String(subtaskId || '').trim()
      if (!mid || !sid) {
        setLoaded(true)
        return
      }
      if (!opts?.silent) setRefreshing(true)
      try {
        const prior = outcomeRef.current
        const snapshot = {
          subtaskId: sid,
          name: String(title || sid),
          description: String(description || ''),
          status: String(statusProp || statusRef.current || 'pending'),
          assignedAgent: String(assignedAgent || ''),
          parentTaskId: mid,
          subtask_thread_id: String(subtaskThreadId || resolvedThreadId || ''),
          subtaskThreadId: String(subtaskThreadId || resolvedThreadId || ''),
          taskReport:
            prior && typeof prior === 'object' ? String(prior.task_report || prior.summary || '') : '',
          result:
            prior && typeof prior === 'object' ? String(prior.task_report || prior.summary || '') : '',
          outputs: prior && typeof prior === 'object' ? prior.outputs : undefined,
          evidence_paths: prior && typeof prior === 'object' ? prior.evidence_paths : undefined,
        }
        const resp = await fetchSubtaskTranscriptMeta({
          mainTaskId: mid,
          subtaskId: sid,
          leadThreadId: String(leadThreadId || '').trim(),
          storedSubtaskThreadId: String(subtaskThreadId || resolvedThreadId || '').trim(),
          subtaskSnapshot: snapshot,
        })
        const nextThread = String(resp?.thread_id || '').trim()
        if (nextThread) setResolvedThreadId(nextThread)

        const nextOutcome =
          (resp?.outcome && typeof resp.outcome === 'object'
            ? (resp.outcome as CollabSubtaskStageOutcome)
            : null) ||
          outcomeFromSubtaskSnapshot(snapshot) ||
          prior ||
          null
        outcomeRef.current = nextOutcome
        setOutcome(nextOutcome)

        let nextStatus = ''
        if (resp?.status) nextStatus = String(resp.status)
        else if (statusProp) nextStatus = String(statusProp)
        else if (nextOutcome && typeof nextOutcome === 'object' && nextOutcome.status) {
          nextStatus = String(nextOutcome.status)
        }
        if (nextStatus) {
          const prev = statusRef.current
          if (prev !== nextStatus) {
            wfLog('status.change', {
              reason: opts?.reason || 'meta',
              mainTaskId: mid,
              subtaskId: sid,
              title: String(title || ''),
              from: prev || null,
              to: nextStatus,
              threadId: nextThread || resolvedThreadId || null,
              at: new Date().toISOString(),
            })
          }
          statusRef.current = nextStatus
          setStatus(nextStatus)
        }

        const tid = nextThread || String(resolvedThreadId || '').trim()
        if (tid) bumpV4(tid, opts?.reason || 'meta')
        setLoaded(true)
        wfLog('meta.ok', {
          reason: opts?.reason || 'meta',
          mainTaskId: mid,
          subtaskId: sid,
          title: String(title || ''),
          status: nextStatus || statusRef.current,
          threadId: tid || null,
          hasOutcome: Boolean(nextOutcome),
        })
      } catch (e) {
        wfLog('meta.fail', {
          reason: opts?.reason || 'meta',
          mainTaskId: mid,
          subtaskId: sid,
          error: String((e as Error)?.message || e || 'fail'),
        })
        setLoaded(true)
      } finally {
        if (!opts?.silent) setRefreshing(false)
      }
    },
    [
      mainTaskId,
      subtaskId,
      leadThreadId,
      title,
      description,
      statusProp,
      assignedAgent,
      subtaskThreadId,
      resolvedThreadId,
      bumpV4,
    ],
  )

  useEffect(() => {
    const tid = String(subtaskThreadId || '').trim()
    if (tid) setResolvedThreadId(tid)
  }, [subtaskThreadId])

  useEffect(() => {
    const next = String(statusProp || '').trim()
    if (!next) return
    if (statusRef.current === next) return
    wfLog('status.prop', {
      mainTaskId,
      subtaskId,
      title: String(title || ''),
      from: statusRef.current || null,
      to: next,
    })
    statusRef.current = next
    setStatus(next)
  }, [statusProp, mainTaskId, subtaskId, title])

  useEffect(() => {
    let disposed = false
    wasRunningRef.current = false
    settledRef.current = false
    wfLog('open', {
      mainTaskId,
      subtaskId,
      title: String(title || ''),
      status: String(statusProp || ''),
      threadId: String(subtaskThreadId || '').trim() || null,
      embedded,
      allowCompose,
    })
    void fetchMeta({ silent: true, reason: 'open' })
    if (!keepMetaPoll) {
      return () => {
        disposed = true
      }
    }
    pollRef.current = setInterval(() => {
      if (disposed) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void fetchMeta({ silent: true, reason: 'poll' })
    }, POLL_MS)
    return () => {
      disposed = true
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [fetchMeta, keepMetaPoll, mainTaskId, subtaskId, title, statusProp, subtaskThreadId, embedded, allowCompose])

  useEffect(() => {
    if (running || sending) {
      wasRunningRef.current = true
      settledRef.current = false
    }
  }, [running, sending])

  // 刚结束：再收一帧投影，避免最后一次工具调用停在旧快照
  useEffect(() => {
    if (keepMetaPoll || running) return
    if (!wasRunningRef.current || settledRef.current) return
    settledRef.current = true
    const tid = String(resolvedThreadId || '').trim()
    wfLog('settle', {
      mainTaskId,
      subtaskId,
      title: String(title || ''),
      status,
      threadId: tid || null,
    })
    if (tid) bumpV4(tid, 'settle')
    const timer = window.setTimeout(() => {
      void fetchMeta({ silent: true, reason: 'settle' })
    }, SETTLE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [
    keepMetaPoll,
    running,
    resolvedThreadId,
    bumpV4,
    fetchMeta,
    mainTaskId,
    subtaskId,
    title,
    status,
  ])

  // 投影 catchup / SSE 入账后，标题时钟跟最新工具时间
  useEffect(() => {
    const tid = String(resolvedThreadId || '').trim()
    if (!tid) return
    syncLastActivity(tid)
    if (!keepMetaPoll && !running) return
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      syncLastActivity(tid)
    }, ACTIVITY_PEEK_MS)
    return () => window.clearInterval(timer)
  }, [resolvedThreadId, keepMetaPoll, running, syncLastActivity])

  const handleRefresh = useCallback(() => {
    const tid = String(resolvedThreadId || '').trim()
    if (tid) bumpV4(tid, 'manual-refresh')
    void fetchMeta({ reason: 'manual-refresh' })
  }, [resolvedThreadId, bumpV4, fetchMeta])

  const handleSend = useCallback(async () => {
    const text = composeText.trim()
    const mid = String(mainTaskId || '').trim()
    const sid = String(subtaskId || '').trim()
    if (!text || !mid || !sid || sending) return
    setSending(true)
    setComposeError('')
    wfLog('compose.send', { mainTaskId: mid, subtaskId: sid, textLen: text.length })
    try {
      await tasksAPI.continueSubtaskSession(mid, sid, text, {
        keepSessionOpen: true,
        waitForCompletion: true,
      })
      setComposeText('')
      const tid = String(resolvedThreadId || '').trim()
      if (tid) bumpV4(tid, 'after-send')
      void fetchMeta({ silent: true, reason: 'after-send' })
    } catch (e) {
      setComposeError(String((e as Error)?.message || e || '发送失败'))
    } finally {
      setSending(false)
    }
  }, [composeText, mainTaskId, subtaskId, sending, resolvedThreadId, bumpV4, fetchMeta])

  const lastActivityLabel = useMemo(
    () => (lastActivityAt != null ? formatTrailRowClock(lastActivityAt) : ''),
    [lastActivityAt],
  )

  const outcomeSummary = useMemo(
    () => summarizeOutcome(outcome as Record<string, unknown> | null),
    [outcome],
  )
  const hasReport = Boolean(outcomeSummary.report)
  const hasPaths = outcomeSummary.pathLines.length > 0
  const hasOutcomeAside = hasReport || hasPaths
  const [outcomeTab, setOutcomeTab] = useState<'report' | 'paths'>(() =>
    hasReport ? 'report' : 'paths',
  )

  useEffect(() => {
    if (hasReport && hasPaths) return
    if (hasReport) setOutcomeTab('report')
    else if (hasPaths) setOutcomeTab('paths')
  }, [hasReport, hasPaths])

  const activeTab: 'report' | 'paths' =
    outcomeTab === 'paths' && hasPaths
      ? 'paths'
      : outcomeTab === 'report' && hasReport
        ? 'report'
        : hasReport
          ? 'report'
          : 'paths'

  const composeFooter =
    allowCompose && String(mainTaskId || '').trim() && String(subtaskId || '').trim() ? (
      <footer className="shrink-0 border-t border-border bg-card px-3 py-2">
        {composeError ? (
          <p className="mb-1 text-[12px] text-destructive" role="alert">
            {composeError}
          </p>
        ) : null}
        <div className="flex items-end gap-2">
          <textarea
            className="min-h-[56px] flex-1 resize-y rounded-md border border-border bg-background px-2 py-1.5 text-ui-sm text-foreground outline-none focus:border-ring"
            rows={2}
            placeholder="继续向该节点说明修改意见…"
            value={composeText}
            disabled={sending}
            onChange={(e) => setComposeText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleSend()
              }
            }}
          />
          <button
            type="button"
            className="react-chat-modal-btn react-chat-modal-btn--primary shrink-0"
            disabled={sending || !composeText.trim()}
            onClick={() => void handleSend()}
          >
            {sending ? '发送中…' : '发送'}
          </button>
        </div>
      </footer>
    ) : null

  return (
    <div className="v4-collab-subtask-transcript flex h-full min-h-0 flex-col bg-card">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 truncate text-ui-sm font-medium text-foreground">
          {title || '节点进度'}
        </span>
        {lastActivityLabel ? (
          <span
            className="shrink-0 tabular-nums text-[11px] text-foreground-subtlest"
            title={`最近活动 ${lastActivityLabel}`}
          >
            {lastActivityLabel}
          </span>
        ) : null}
        <span
          className={
            'rounded px-1.5 py-0.5 text-[11px] ' +
            (running
              ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
              : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400')
          }
          title={`status=${status || ''}`}
        >
          {running ? '执行中' : statusLabel}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          className="rounded px-1.5 py-0.5 text-[11px] text-foreground-subtlest hover:bg-hover hover:text-foreground"
          onClick={handleRefresh}
          disabled={refreshing}
          title="刷新节点对话投影"
        >
          {refreshing ? '刷新中…' : '刷新'}
        </button>
        {!embedded && onClose ? (
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

      <div className="wf-step-transcript-scroll min-h-0 flex-1 overflow-hidden">
        {resolvedThreadId ? (
          <V4SessionPaneBridge
            sessionId={resolvedThreadId}
            connecting={!loaded}
            sessionKey={sessionKey || undefined}
            embedded
            sessionBusy={turnBusy}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-ui-sm text-foreground-subtlest">
            {!loaded
              ? '正在解析节点会话…'
              : running
                ? '节点执行中，等待会话 thread…'
                : '暂无节点会话（未写入 subtask_thread_id）'}
          </div>
        )}
      </div>

      {hasOutcomeAside ? (
        <aside
          className="shrink-0 border-t border-border bg-muted/40 px-3 py-2 text-ui-sm text-foreground"
          aria-label="节点产出"
        >
          <div className="mb-1.5 flex items-center gap-0.5" role="tablist" aria-label="结案与产出">
            {hasReport ? (
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'report'}
                className={
                  'rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors ' +
                  (activeTab === 'report'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-foreground-subtlest hover:bg-hover hover:text-foreground-subtle')
                }
                onClick={() => setOutcomeTab('report')}
              >
                结案摘要
              </button>
            ) : null}
            {hasPaths ? (
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'paths'}
                className={
                  'rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors ' +
                  (activeTab === 'paths'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-foreground-subtlest hover:bg-hover hover:text-foreground-subtle')
                }
                onClick={() => setOutcomeTab('paths')}
              >
                产出路径
                <span className="ml-0.5 opacity-60">{outcomeSummary.pathLines.length}</span>
              </button>
            ) : null}
          </div>
          {activeTab === 'report' && hasReport ? (
            <pre
              role="tabpanel"
              className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-sans text-ui-sm leading-relaxed"
            >
              {outcomeSummary.report}
            </pre>
          ) : null}
          {activeTab === 'paths' && hasPaths ? (
            <ul
              role="tabpanel"
              className="max-h-40 list-disc space-y-0.5 overflow-y-auto pl-4 text-foreground-subtle"
            >
              {outcomeSummary.pathLines.map((line) => (
                <li key={line} className="break-all font-mono text-[12px]">
                  {line}
                </li>
              ))}
            </ul>
          ) : null}
        </aside>
      ) : null}

      {composeFooter}
    </div>
  )
}
