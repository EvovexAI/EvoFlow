/**
 * 协作节点进度：对话体只走主聊同一套 V4（V4SessionPaneBridge → V4ZCodeTimeline）。
 * 旧 SubtaskModalMessageRow / modal-rows 已退役，不再作兜底。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchSubtaskTranscriptMeta,
  outcomeFromSubtaskSnapshot,
} from '../../../lib/subtask-conversation-history.js'
import { summarizeOutcome } from '../../../lib/subtask-transcript-seed.js'
import { isTaskRunningStatus, isTaskPlanningStatus } from '../../../lib/task-status-label.js'
import type { CollabSubtaskStageOutcome } from '../../../lib/right-stage/open-collab-subtask-stage.js'
import { V4SessionPaneBridge } from '../../v4/V4SessionPaneBridge.js'

const POLL_MS = 2000

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
    onClose,
  } = props

  const [outcome, setOutcome] = useState<CollabSubtaskStageOutcome | null | undefined>(
    () => initialOutcome,
  )
  const [status, setStatus] = useState(String(statusProp || ''))
  const [resolvedThreadId, setResolvedThreadId] = useState(() => String(subtaskThreadId || '').trim())
  const [loaded, setLoaded] = useState(() => !!String(subtaskThreadId || '').trim() || !!initialOutcome)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const outcomeRef = useRef<CollabSubtaskStageOutcome | null | undefined>(initialOutcome)

  const running = isTaskRunningStatus(status) || isTaskPlanningStatus(status)

  const fetchMeta = useCallback(async () => {
    const mid = String(mainTaskId || '').trim()
    const sid = String(subtaskId || '').trim()
    if (!mid || !sid) {
      setLoaded(true)
      return
    }
    try {
      const prior = outcomeRef.current
      const snapshot = {
        subtaskId: sid,
        name: String(title || sid),
        description: String(description || ''),
        status: String(statusProp || 'pending'),
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
      if (resp?.status) setStatus(String(resp.status))
      else if (statusProp) setStatus(String(statusProp))
      else if (nextOutcome && typeof nextOutcome === 'object' && nextOutcome.status) {
        setStatus(String(nextOutcome.status))
      }
      setLoaded(true)
    } catch {
      setLoaded(true)
    }
  }, [
    mainTaskId,
    subtaskId,
    leadThreadId,
    title,
    description,
    statusProp,
    assignedAgent,
    subtaskThreadId,
    resolvedThreadId,
  ])

  useEffect(() => {
    const tid = String(subtaskThreadId || '').trim()
    if (tid) setResolvedThreadId(tid)
  }, [subtaskThreadId])

  useEffect(() => {
    let disposed = false
    void fetchMeta()
    pollRef.current = setInterval(() => {
      if (disposed) return
      if (!running && loaded) {
        if (pollRef.current) clearInterval(pollRef.current)
        pollRef.current = null
        return
      }
      void fetchMeta()
    }, POLL_MS)
    return () => {
      disposed = true
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [fetchMeta, running, loaded])

  useEffect(() => {
    setStatus(String(statusProp || ''))
  }, [statusProp])

  const outcomeSummary = useMemo(
    () => summarizeOutcome(outcome as Record<string, unknown> | null),
    [outcome],
  )
  const hasOutcomeAside = Boolean(outcomeSummary.report || outcomeSummary.pathLines.length)

  return (
    <div className="v4-collab-subtask-transcript flex h-full min-h-0 flex-col bg-card">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 truncate text-ui-sm font-medium text-foreground">
          {title || '节点进度'}
        </span>
        <span
          className={
            'rounded px-1.5 py-0.5 text-[11px] ' +
            (running
              ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
              : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400')
          }
        >
          {running ? '执行中' : status || '已完成'}
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
        {resolvedThreadId ? (
          <V4SessionPaneBridge
            sessionId={resolvedThreadId}
            connecting={!loaded}
            sessionKey={sessionKey || undefined}
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
          aria-label="结案摘要"
        >
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-foreground-subtlest">
            结案摘要
          </div>
          {outcomeSummary.report ? (
            <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-sans text-ui-sm leading-relaxed">
              {outcomeSummary.report}
            </pre>
          ) : null}
          {outcomeSummary.pathLines.length ? (
            <ul className="mt-2 list-disc space-y-0.5 pl-4 text-foreground-subtle">
              {outcomeSummary.pathLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </aside>
      ) : null}
    </div>
  )
}
