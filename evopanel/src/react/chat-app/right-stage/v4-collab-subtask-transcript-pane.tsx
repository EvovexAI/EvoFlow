/**
 * V4 右侧：协作工作流「单个节点」进度（独立 tab）。
 * 数据：tab.data 种子 rows/outcome + 轮询 fetchSubtaskConversationHistory。
 * 点文件 → 再开 file/codeViewer tab（同侧栏，不跳页）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SubtaskModalMessageRow } from '../../components/SubtaskModalMessageRow.js'
import {
  fetchSubtaskConversationHistory,
  outcomeFromSubtaskSnapshot,
} from '../../../lib/subtask-conversation-history.js'
import {
  coalesceSubtaskTranscriptRows,
} from '../../../lib/subtask-transcript-seed.js'
import {
  openRightStageForCodeViewerSource,
  showRightStageFilePreview,
} from '../../../lib/right-stage/open-right-stage-file.js'
import { isTaskRunningStatus, isTaskPlanningStatus } from '../../../lib/task-status-label.js'
import type { CollabSubtaskStageOutcome } from '../../../lib/right-stage/open-collab-subtask-stage.js'

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
  /** 打开 tab 时节点已预取的行，避免空白闪一下再等二次请求 */
  initialRows?: unknown[]
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
    initialRows,
    initialOutcome = null,
    onClose,
  } = props

  const seeded = useMemo(
    () => coalesceSubtaskTranscriptRows(initialRows, initialOutcome as Record<string, unknown> | null),
    // 只在挂载/切换节点时吃种子；后续以轮询为准
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mainTaskId, subtaskId],
  )

  const [rows, setRows] = useState<unknown[]>(() => seeded)
  const [status, setStatus] = useState(String(statusProp || ''))
  const [loaded, setLoaded] = useState(() => seeded.length > 0)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const lastRowCountRef = useRef(0)
  const outcomeRef = useRef<CollabSubtaskStageOutcome | null | undefined>(initialOutcome)

  const running = isTaskRunningStatus(status) || isTaskPlanningStatus(status)

  const fetchOnce = useCallback(async () => {
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
        subtask_thread_id: String(subtaskThreadId || ''),
        subtaskThreadId: String(subtaskThreadId || ''),
        taskReport:
          prior && typeof prior === 'object' ? String(prior.task_report || prior.summary || '') : '',
        result:
          prior && typeof prior === 'object' ? String(prior.task_report || prior.summary || '') : '',
        outputs: prior && typeof prior === 'object' ? prior.outputs : undefined,
        evidence_paths: prior && typeof prior === 'object' ? prior.evidence_paths : undefined,
      }
      const resp = await fetchSubtaskConversationHistory({
        mainTaskId: mid,
        subtaskId: sid,
        leadThreadId: String(leadThreadId || '').trim(),
        storedSubtaskThreadId: String(subtaskThreadId || '').trim(),
        subtaskSnapshot: snapshot,
      })
      const nextOutcome =
        (resp?.outcome && typeof resp.outcome === 'object'
          ? (resp.outcome as CollabSubtaskStageOutcome)
          : null) ||
        outcomeFromSubtaskSnapshot(snapshot) ||
        prior ||
        null
      outcomeRef.current = nextOutcome
      setRows(
        coalesceSubtaskTranscriptRows(
          Array.isArray(resp?.rows) ? resp.rows : [],
          nextOutcome as Record<string, unknown> | null,
        ),
      )
      if (statusProp) setStatus(String(statusProp))
      setLoaded(true)
    } catch {
      // 请求失败时保留种子行，避免已有内容被清空
      setRows((prev) =>
        prev.length
          ? prev
          : coalesceSubtaskTranscriptRows([], outcomeRef.current as Record<string, unknown> | null),
      )
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
  ])

  useEffect(() => {
    let disposed = false
    void fetchOnce()
    pollRef.current = setInterval(() => {
      if (disposed) return
      if (!running && loaded) {
        if (pollRef.current) clearInterval(pollRef.current)
        pollRef.current = null
        return
      }
      void fetchOnce()
    }, POLL_MS)
    return () => {
      disposed = true
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [fetchOnce, running, loaded])

  useEffect(() => {
    setStatus(String(statusProp || ''))
  }, [statusProp])

  useEffect(() => {
    if (rows.length === lastRowCountRef.current) return
    lastRowCountRef.current = rows.length
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [rows])

  const onOpenFile = useCallback(
    (rawPath: string, displayName?: string) => {
      const path = String(rawPath || '').trim()
      if (!path) return
      const name = String(displayName || '').trim()
      const lower = path.toLowerCase()
      const looksCode =
        /\.(ts|tsx|js|jsx|py|go|rs|java|kt|c|cpp|h|hpp|cs|rb|php|swift|md|json|ya?ml|toml|css|scss|html|sql|sh)$/i.test(
          lower,
        )
      if (looksCode) {
        openRightStageForCodeViewerSource(
          { type: 'file', path, title: name || undefined },
          { sessionKey, threadId: leadThreadId },
        )
        return
      }
      showRightStageFilePreview(path, { sessionKey, name: name || undefined })
    },
    [sessionKey, leadThreadId],
  )

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
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {rows.length > 0 ? (
          <div className="flex flex-col gap-3">
            {rows.map((row, index) => (
              <SubtaskModalMessageRow
                key={index}
                row={row as Parameters<typeof SubtaskModalMessageRow>[0]['row']}
                sessionKey={sessionKey}
                isStreaming={running && index === rows.length - 1}
                onOpenWorkspaceFile={onOpenFile}
              />
            ))}
          </div>
        ) : loaded ? (
          <div className="flex h-full items-center justify-center text-ui-sm text-foreground-subtlest">
            （暂无输出内容）
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-ui-sm text-foreground-subtlest">
            正在加载节点进度…
          </div>
        )}
      </div>
    </div>
  )
}
