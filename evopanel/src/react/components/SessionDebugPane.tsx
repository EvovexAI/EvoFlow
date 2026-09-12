import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/tauri-api.js'
import { apiModelListRowToRequestRecord } from '../obs/data/adapter.js'
import { fetchObsModels } from '../obs/lib/obs-api.js'
import {
  fmtCacheHitTok,
  fmtUsageTok,
  requestTokenTitle,
} from '../obs/lib/obs-formatters.js'
import type { RequestRecord } from '../obs/types/index.js'
import {
  buildRunIdToChatSeq,
  fmtSessionDebugClock,
  groupCallsByTurn,
} from '../lib/session-debug-turn-groups.js'
import { SessionDebugCallModal } from './SessionDebugCallModal.js'

function replyKindLabel(row: RequestRecord): string {
  if (row.status === 'failed') return '失败'
  if (row.status === 'warning') return '警告'
  switch (row.replyKind) {
    case 'tool_call':
      return '工具'
    case 'tools_and_content':
      return '工具+文本'
    case 'planning':
      return '规划'
    case 'reason':
      return '推理'
    default:
      return '文本'
  }
}

function statusTone(status: RequestRecord['status']): string {
  if (status === 'failed') return 'failed'
  if (status === 'warning') return 'warning'
  return 'success'
}

async function fetchThreadModelCalls(threadId: string): Promise<RequestRecord[]> {
  const res = (await fetchObsModels({
    threadId,
    page: 1,
    pageSize: 100,
    timeRange: 'all',
  })) as { enabled?: boolean; items?: Record<string, unknown>[] }
  if (res?.enabled === false) return []
  const items = res?.items
  if (!Array.isArray(items)) return []
  return items.map((row) => apiModelListRowToRequestRecord(row))
}

async function fetchThreadChatSeqByRun(threadId: string): Promise<Map<string, number>> {
  try {
    const res = (await api.chatMessagesByThread(threadId, 2000)) as {
      messages?: unknown[]
    }
    return buildRunIdToChatSeq(Array.isArray(res?.messages) ? res.messages : [])
  } catch {
    return new Map()
  }
}

function SessionDebugPaneInner({
  threadId,
  isRunning = false,
}: {
  threadId: string
  isRunning?: boolean
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [calls, setCalls] = useState<RequestRecord[]>([])
  const [runIdToChatSeq, setRunIdToChatSeq] = useState<Map<string, number>>(() => new Map())
  const [selected, setSelected] = useState<RequestRecord | null>(null)
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null)

  const tid = String(threadId || '').trim()

  const reload = useCallback(async (silent = false) => {
    if (!tid) {
      setCalls([])
      setRunIdToChatSeq(new Map())
      setError(null)
      return
    }
    if (!silent) setLoading(true)
    setError(null)
    try {
      const [rows, seqMap] = await Promise.all([
        fetchThreadModelCalls(tid),
        fetchThreadChatSeqByRun(tid),
      ])
      setCalls(rows)
      setRunIdToChatSeq(seqMap)
    } catch (err) {
      setCalls([])
      setRunIdToChatSeq(new Map())
      setError(String((err as Error)?.message || err || '加载失败'))
    } finally {
      if (!silent) setLoading(false)
    }
  }, [tid])

  useEffect(() => {
    void reload(false)
  }, [reload])

  useEffect(() => {
    if (!tid) return
    const pollMs = isRunning ? 4000 : 15000
    const timer = setInterval(() => {
      void reload(true)
    }, pollMs)
    return () => clearInterval(timer)
  }, [tid, isRunning, reload])

  const turnGroups = useMemo(
    () => groupCallsByTurn(calls, runIdToChatSeq),
    [calls, runIdToChatSeq],
  )

  useEffect(() => {
    if (!turnGroups.length) {
      setExpandedRunId(null)
      return
    }
    setExpandedRunId((prev) => {
      if (prev && turnGroups.some((g) => g.runId === prev)) return prev
      return turnGroups[0]?.runId ?? null
    })
  }, [turnGroups])

  if (!tid) {
    return (
      <div className="react-chat-session-debug-empty">
        当前会话尚未绑定 thread_id，发送消息后会出现模型调用记录。
      </div>
    )
  }

  return (
    <>
      <div className="react-chat-session-debug">
        <div className="react-chat-session-debug-meta">
          <span className="react-chat-session-debug-meta-label">Thread</span>
          <code className="react-chat-session-debug-meta-value" title={tid}>
            {tid}
          </code>
          <button
            type="button"
            className="react-chat-info-rail-action"
            title="复制完整 thread_id"
            onClick={() => {
              void navigator.clipboard?.writeText(tid).catch(() => {})
            }}
          >
            复制
          </button>
          <button type="button" className="react-chat-info-rail-action" onClick={() => void reload(false)}>
            刷新
          </button>
        </div>

        {loading && !calls.length ? (
          <div className="react-chat-session-debug-empty">加载模型调用…</div>
        ) : null}
        {error ? <div className="react-chat-session-debug-error">{error}</div> : null}
        {!loading && !error && !calls.length ? (
          <div className="react-chat-session-debug-empty">
            本会话暂无模型调用记录。开启观测后，每轮对话的 Prompt、工具与 Token 会出现在这里。
          </div>
        ) : null}

        {turnGroups.length ? (
          <div className="react-chat-session-debug-turns">
            <div className="react-chat-session-debug-table-wrap">
              <table className="react-chat-session-debug-table">
                <thead>
                  <tr>
                    <th>轮次</th>
                    <th>#</th>
                    <th>时间</th>
                    <th>模型</th>
                    <th>类型</th>
                    <th>延迟</th>
                    <th>Token</th>
                    <th>预览</th>
                  </tr>
                </thead>
                <tbody>
                  {turnGroups.flatMap((group) =>
                    group.calls.map((row, idx) => (
                      <tr
                        key={row.id}
                        className={`is-${statusTone(row.status)}`}
                        onClick={() => setSelected(row)}
                        title="点击查看详情"
                      >
                        <td>{idx === 0 ? group.title : ''}</td>
                        <td>{row.modelCallSeq != null ? `#${row.modelCallSeq}` : '—'}</td>
                        <td title={row.time && row.time !== '—' ? row.time : undefined}>
                          {fmtSessionDebugClock(row.occurredAt, row.time)}
                        </td>
                        <td>{row.model || '—'}</td>
                        <td>{replyKindLabel(row)}</td>
                        <td>{row.latency || '—'}</td>
                        <td title={requestTokenTitle(row)}>
                          {fmtUsageTok(row.promptTokens)} / {fmtUsageTok(row.completionTokens)}
                          {row.cacheReadTokens
                            ? ` · 缓存 ${fmtCacheHitTok(row.cacheReadTokens, row.cacheMissTokens)}`
                            : ''}
                        </td>
                        <td className="react-chat-session-debug-table-preview">
                          {row.replyPreview || row.failureMessage || '—'}
                        </td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
            {turnGroups.map((group) => {
              const expanded = expandedRunId === group.runId
              return (
                <section key={group.runId} className="react-chat-session-debug-turn">
                  <button
                    type="button"
                    className={`react-chat-session-debug-turn-head${expanded ? ' is-open' : ''}`}
                    aria-expanded={expanded}
                    title={[group.titleHint, group.timeHint].filter(Boolean).join(' · ') || undefined}
                    onClick={() =>
                      setExpandedRunId((prev) => (prev === group.runId ? null : group.runId))
                    }
                  >
                    <span className="react-chat-session-debug-turn-title">
                      {group.title}
                      <span className="react-chat-session-debug-turn-clock">{group.timeLabel}</span>
                    </span>
                    <span className="react-chat-session-debug-turn-meta">
                      {group.calls.length} 次调用
                      {group.relativeLabel && group.relativeLabel !== '—'
                        ? ` · ${group.relativeLabel}`
                        : ''}
                    </span>
                  </button>
                  {expanded ? (
                    <ul className="react-chat-session-debug-call-list">
                      {group.calls.map((row) => (
                        <li key={row.id}>
                          <button
                            type="button"
                            className="react-chat-session-debug-call-btn"
                            onClick={() => setSelected(row)}
                          >
                            <span className={`react-chat-session-debug-status is-${statusTone(row.status)}`} />
                            <span className="react-chat-session-debug-call-main">
                              <span className="react-chat-session-debug-call-title">
                                {row.modelCallSeq != null ? `#${row.modelCallSeq} · ` : ''}
                                {row.model}
                              </span>
                              <span className="react-chat-session-debug-call-sub">
                                {replyKindLabel(row)}
                                {row.payloadMessageCount != null ? ` · ${row.payloadMessageCount} 条消息` : ''}
                                {row.thinkingLabel ? ` · ${row.thinkingLabel}` : ''}
                              </span>
                              {row.replyPreview ? (
                                <span className="react-chat-session-debug-call-preview" title={row.replyPreview}>
                                  {row.replyPreview}
                                </span>
                              ) : row.failureMessage ? (
                                <span
                                  className="react-chat-session-debug-call-preview is-error"
                                  title={row.failureMessage}
                                >
                                  {row.failureMessage}
                                </span>
                              ) : null}
                            </span>
                            <span className="react-chat-session-debug-call-stats">
                              <span
                                className="react-chat-session-debug-call-time"
                                title={row.time && row.time !== '—' ? row.time : undefined}
                              >
                                {fmtSessionDebugClock(row.occurredAt, row.time)}
                              </span>
                              <span>{row.latency}</span>
                              <span title={requestTokenTitle(row)}>
                                {fmtUsageTok(row.promptTokens)} / {fmtUsageTok(row.completionTokens)}
                              </span>
                              {row.cacheReadTokens ? (
                                <span title={requestTokenTitle(row)}>
                                  缓存 {fmtCacheHitTok(row.cacheReadTokens, row.cacheMissTokens)}
                                </span>
                              ) : null}
                              <span>{row.tokens.toLocaleString()} tok</span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </section>
              )
            })}
          </div>
        ) : null}
      </div>

      {selected ? (
        <SessionDebugCallModal request={selected} onClose={() => setSelected(null)} />
      ) : null}
    </>
  )
}

export const SessionDebugPane = memo(SessionDebugPaneInner)
