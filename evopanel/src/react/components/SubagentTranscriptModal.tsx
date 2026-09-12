import { createPortal } from 'react-dom'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useModalEscapeClose } from '../hooks/useModalEscapeClose.js'
import { SubtaskModalMessageRow } from './SubtaskModalMessageRow.js'
import { messagesToSubtaskModalRows } from '../../lib/subtask-modal-rows.js'
import { fetchSubagentTaskTranscript } from '../../lib/fetch-subagent-transcript.js'
import AgentAvatar from './AgentAvatar.js'

function LoadingDots() {
  return (
    <span className="subagent-modal-loading" aria-label="加载中">
      <span className="subagent-modal-loading-dot" />
      <span className="subagent-modal-loading-dot" />
      <span className="subagent-modal-loading-dot" />
    </span>
  )
}

/** Aggregate token usage from raw LangChain AIMessage dicts. */
function aggregateTokenUsage(messages: unknown[]): { input: number; output: number; total: number } {
  let input = 0
  let output = 0
  let total = 0
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue
    const msg = m as Record<string, unknown>
    const usage = msg.usage_metadata
    if (!usage || typeof usage !== 'object') continue
    const u = usage as Record<string, unknown>
    input += Number(u.input_tokens) || 0
    output += Number(u.output_tokens) || 0
    total += Number(u.total_tokens) || 0
  }
  return { input, output, total }
}

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function lastStreamableRowIndex(rows: unknown[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const role = String((rows[i] as { role?: string })?.role || '').trim()
    if (role === 'assistant' || role === '_stream') return i
  }
  return -1
}

const POLL_INTERVAL_MS = 3000
const RUNNING_POLL_INTERVAL_MS = 2500
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'timed_out', 'cancelled'])

/**
 * 子智能体对话弹窗：复用主会话的消息转换链路（messagesToSubtaskModalRows ->
 * SubtaskModalMessageRow），所以工具调用、Exploring 折叠、segments、markdown
 * 渲染等所有主对话能力都自动具备。
 *
 * 数据源：GET /api/tasks/subagent/{task_id}/transcript
 *   - 后端从 SubagentExecutor._background_tasks 或 _completed_task_snapshots
 *     里取出 stream_messages（完整 LangChain message dict 数组）
 *   - 前端不自己解析 content，直接喂给 messagesToSubtaskModalRows
 */
function fallbackRowsFromLive(text: string | undefined, tools: unknown[] | undefined): unknown[] {
  const body = String(text || '').trim()
  const toolList = Array.isArray(tools) ? tools : []
  if (!body && !toolList.length) return []
  return messagesToSubtaskModalRows([
    {
      type: 'ai',
      role: 'assistant',
      content: body || (toolList.length ? '' : '（暂无正文）'),
      tool_calls: toolList.length
        ? toolList.map((t, i) => {
            const o = t && typeof t === 'object' ? (t as Record<string, unknown>) : {}
            return {
              id: String(o.id || o.tool_call_id || `fallback-${i}`),
              name: String(o.name || o.tool_name || 'tool'),
              args: o.input ?? o.args ?? {},
            }
          })
        : undefined,
    },
    ...toolList
      .map((t, i) => {
        const o = t && typeof t === 'object' ? (t as Record<string, unknown>) : {}
        const out = o.output ?? o.content ?? o.result
        if (out == null || out === '') return null
        return {
          type: 'tool',
          role: 'tool',
          tool_call_id: String(o.id || o.tool_call_id || `fallback-${i}`),
          name: String(o.name || o.tool_name || 'tool'),
          content: typeof out === 'string' ? out : JSON.stringify(out),
        }
      })
      .filter(Boolean),
  ])
}

function SubagentTranscriptModalInner({
  taskId,
  title,
  sessionKey,
  fallbackText,
  fallbackTools,
  fallbackStatus,
  onClose,
}: {
  taskId: string
  title?: string
  /** Lead chat session — needed so nested tool detail can lazy-load /tool-results */
  sessionKey?: string
  /** 内存 transcript 不可用时（跨进程 / 已清理）：用流式 liveOutput 兜底 */
  fallbackText?: string
  fallbackTools?: unknown[]
  fallbackStatus?: string
  onClose: () => void
}) {
  const [status, setStatus] = useState<string>('')
  const [rows, setRows] = useState<unknown[]>([])
  const [loaded, setLoaded] = useState(false)
  const [tokenTotal, setTokenTotal] = useState({ input: 0, output: 0, total: 0 })
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastRowCountRef = useRef(0)
  const usingFallbackRef = useRef(false)

  const fetchOnce = useCallback(async () => {
    const data = await fetchSubagentTaskTranscript(taskId)
    setLoaded(true)
    const apiStatus = String(data?.status || '')
    const raw = Array.isArray(data?.messages) ? data.messages : []
    const apiEmpty =
      !raw.length &&
      (data?.empty === true ||
        apiStatus === 'unknown' ||
        apiStatus === 'not_found' ||
        apiStatus === 'error' ||
        !apiStatus)
    // Aggregate token usage from raw AIMessage dicts (usage_metadata field)
    setTokenTotal(aggregateTokenUsage(raw))
    if (!apiEmpty && raw.length) {
      usingFallbackRef.current = false
      setStatus(apiStatus)
      // 主对话同款转换：把 LangChain message dict 数组转成 DisplayRow 数组
      // （工具调用、segments、Exploring 折叠等所有展示能力一并继承）
      setRows(messagesToSubtaskModalRows(raw))
      return
    }
    // API 无正文时：优先用 result/error 字段，再回退到前端流式 liveOutput
    const resultText = String(data?.result || data?.error || '').trim()
    const fb = fallbackRowsFromLive(resultText || fallbackText, fallbackTools)
    usingFallbackRef.current = fb.length > 0
    setStatus(apiStatus && apiStatus !== 'unknown' && apiStatus !== 'not_found' ? apiStatus : String(fallbackStatus || apiStatus || ''))
    setRows(fb)
  }, [taskId, fallbackText, fallbackTools, fallbackStatus])

  // 新行到达时自动滚到底
  useEffect(() => {
    if (rows.length > lastRowCountRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
    lastRowCountRef.current = rows.length
  }, [rows])

  // 初次拉取
  useEffect(() => {
    queueMicrotask(() => void fetchOnce())
  }, [fetchOnce])

  // 轮询：终态停轮询（纯 fallback 且已有正文时仍低频刷新，以便 API 稍后可用）
  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    if (TERMINAL_STATUSES.has(status) && !usingFallbackRef.current) return
    const interval = status === 'running' || !status ? RUNNING_POLL_INTERVAL_MS : POLL_INTERVAL_MS
    pollRef.current = setInterval(() => {
      void fetchOnce()
    }, interval)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [fetchOnce, status])

  // 流式 liveOutput 更新时，若仍走 fallback，同步刷新正文
  useEffect(() => {
    if (!usingFallbackRef.current) return
    const fb = fallbackRowsFromLive(fallbackText, fallbackTools)
    if (fb.length) setRows(fb)
  }, [fallbackText, fallbackTools])

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  useModalEscapeClose(onClose, { deferToNestedModal: true })

  if (typeof document === 'undefined') return null

  const isRunning =
    status === 'running' ||
    status === 'pending' ||
    status === '' ||
    fallbackStatus === 'running'
  const streamingRowIndex = isRunning ? lastStreamableRowIndex(rows) : -1
  const showRunningPending = isRunning && streamingRowIndex < 0
  const statusLabel =
    status === 'completed' || fallbackStatus === 'completed'
      ? '已完成'
      : status === 'failed' || fallbackStatus === 'failed'
        ? '失败'
        : status === 'timed_out' || fallbackStatus === 'timed_out'
          ? '超时'
          : status === 'cancelled' || fallbackStatus === 'cancelled'
            ? '已取消'
            : status === 'running' || fallbackStatus === 'running'
              ? '执行中'
              : rows.length > 0
                ? '已完成'
                : '等待中'
  const statusClass =
    status === 'completed'
      ? 'react-chat-subtask-status-light--ok'
      : status === 'failed' || status === 'timed_out'
        ? 'react-chat-subtask-status-light--err'
        : status === 'cancelled'
          ? 'react-chat-subtask-status-light--muted'
          : 'react-chat-subtask-status-light--run'

  return createPortal(
    <div
      className="react-chat-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="子智能体对话"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="react-chat-modal-card react-chat-modal-card--settings react-chat-subtask-modal-card"
        style={{ width: 'min(980px, 96vw)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="react-chat-modal-header react-chat-subtask-modal-header">
          <div className="react-chat-subtask-modal-header-main">
            <div className="react-chat-subtask-modal-header-agent-row">
              <span
                className={`react-chat-subtask-status-light ${statusClass}`}
                title={statusLabel}
                aria-label={`状态：${statusLabel}`}
              />
              <span className="react-chat-subtask-modal-header-agent">
                <span className="react-chat-subtask-agent-ico" aria-hidden>
                  <AgentAvatar agent={{ agent_name: title }} size={18} />
                </span>
                {title || '子智能体'}
              </span>
              {isRunning ? <LoadingDots /> : null}
            </div>
            <div className="react-chat-subtask-modal-title">
              {statusLabel}
              {rows.length > 0 ? `（${rows.length} 条消息）` : ''}
            </div>
            {tokenTotal.total > 0 ? (
              <div
                className="react-chat-subtask-modal-token-summary"
                style={{ fontSize: '12px', color: 'var(--ev-text-muted, #888)', marginTop: '2px' }}
              >
                📊 输入 {formatTokenCount(tokenTotal.input)} · 输出 {formatTokenCount(tokenTotal.output)} · 合计 {formatTokenCount(tokenTotal.total)}
              </div>
            ) : null}
          </div>
          <div className="react-chat-subtask-modal-header-actions">
            <button type="button" className="react-chat-modal-close" onClick={onClose}>
              ×
            </button>
          </div>
        </div>

        <div className="react-chat-modal-body react-chat-subtask-modal-body">
          <div className="react-chat-subtask-modal-content" ref={scrollRef}>
            <div className="msg-list">
              {!loaded ? (
                <p className="react-chat-subtask-modal-empty">加载中…</p>
              ) : rows.length === 0 ? (
                <p className="react-chat-subtask-modal-empty">
                  {isRunning ? '等待子智能体输出…' : '（该子智能体暂无对话记录）'}
                </p>
              ) : (
                <>
                  {rows.map((r, i) => (
                    <SubtaskModalMessageRow
                      key={`${taskId}:${i}`}
                      row={r as Parameters<typeof SubtaskModalMessageRow>[0]['row']}
                      sessionKey={sessionKey}
                      isStreaming={isRunning && i === streamingRowIndex}
                    />
                  ))}
                  {showRunningPending ? (
                    <div className="msg msg-ai" aria-live="polite">
                      <div className="msg-bubble react-chat-subtask-modal-pending">
                        子智能体仍在执行… <LoadingDots />
                      </div>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export const SubagentTranscriptModal = memo(SubagentTranscriptModalInner)
