import { memo, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { ContentStatsBar } from '../obs/components/ContentStatsBar.js'
import { JsonViewer } from '../obs/components/JsonViewer.js'
import { fetchObsModelDetail } from '../obs/lib/obs-api.js'
import {
  formatJsonText,
  parseRequestViews,
  parseResponseViews,
  resolveFailureMessage,
  type ToolContentStat,
} from '../obs/lib/obs-payload-parse.js'
import {
  fmtCacheHitTok,
  fmtMs,
  fmtUsageTok,
  requestTokenTitle,
} from '../obs/lib/obs-formatters.js'
import {
  estimateTextStats,
  fmtContentStats,
  fmtContentStatsShort,
  resolveContentStats,
  type ContentStats,
} from '../obs/lib/obs-text-stats.js'
import type { RequestRecord } from '../obs/types/index.js'
import { splitSystemPromptSections } from '../lib/system-prompt-sections.js'

type ModalTab =
  | 'tools'
  | 'system'
  | 'user'
  | 'assistant'
  | 'tool_calls'
  | 'request'
  | 'response'
  | 'usage'

function DebugTextPanel({
  value,
  stats,
  emptyHint = '暂无内容',
}: {
  value: string | null | undefined
  stats?: ContentStats | null
  emptyHint?: string
}) {
  const text = String(value || '').trim()
  const resolvedStats = resolveContentStats(stats, text)
  if (!text) {
    return <div className="react-chat-session-debug-modal-empty">{emptyHint}</div>
  }
  return (
    <div className="react-chat-session-debug-modal-text-panel">
      <ContentStatsBar stats={resolvedStats} />
      <pre className="react-chat-session-debug-modal-pre react-chat-session-debug-modal-pre--fill">
        {text}
      </pre>
    </div>
  )
}

/** 按组装 XML 块拆开系统提示词，便于对照员工/主对话拼装逻辑 */
function DebugSystemPromptPanel({
  value,
  stats,
  emptyHint = '暂无内容',
}: {
  value: string | null | undefined
  stats?: ContentStats | null
  emptyHint?: string
}) {
  const text = String(value || '').trim()
  const resolvedStats = resolveContentStats(stats, text)
  const sections = useMemo(() => splitSystemPromptSections(text), [text])
  const [mode, setMode] = useState<'sections' | 'full'>('sections')
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({})

  useEffect(() => {
    // 默认展开前 3 块，避免一次铺开过长
    const next: Record<string, boolean> = {}
    sections.slice(0, 3).forEach((s) => {
      next[s.id] = true
    })
    setOpenIds(next)
    setMode(sections.length > 1 ? 'sections' : 'full')
  }, [text])

  if (!text) {
    return <div className="react-chat-session-debug-modal-empty">{emptyHint}</div>
  }

  const showSections = mode === 'sections' && sections.length > 1

  return (
    <div className="react-chat-session-debug-modal-text-panel">
      <div className="react-chat-session-debug-system-toolbar">
        <ContentStatsBar stats={resolvedStats} />
        {sections.length > 1 ? (
          <div className="react-chat-session-debug-system-mode" role="group" aria-label="系统提示词视图">
            <button
              type="button"
              className={showSections ? 'is-active' : ''}
              onClick={() => setMode('sections')}
            >
              组装块 ({sections.length})
            </button>
            <button
              type="button"
              className={!showSections ? 'is-active' : ''}
              onClick={() => setMode('full')}
            >
              全文
            </button>
          </div>
        ) : null}
      </div>
      {showSections ? (
        <div className="react-chat-session-debug-system-sections">
          {sections.map((sec) => {
            const open = Boolean(openIds[sec.id])
            const short = estimateTextStats(sec.text)
            return (
              <section key={sec.id} className="react-chat-session-debug-system-section">
                <button
                  type="button"
                  className={`react-chat-session-debug-system-section-head${open ? ' is-open' : ''}`}
                  aria-expanded={open}
                  onClick={() =>
                    setOpenIds((prev) => ({ ...prev, [sec.id]: !prev[sec.id] }))
                  }
                >
                  <span className="react-chat-session-debug-system-section-title">
                    {sec.label}
                    {sec.tag && !sec.tag.startsWith('_') ? (
                      <code className="react-chat-session-debug-system-section-tag">&lt;{sec.tag}&gt;</code>
                    ) : null}
                  </span>
                  <span className="react-chat-session-debug-system-section-meta">
                    {short ? fmtContentStatsShort(short) : ''}
                  </span>
                </button>
                {open ? (
                  <pre className="react-chat-session-debug-modal-pre react-chat-session-debug-modal-pre--compact">
                    {sec.text}
                  </pre>
                ) : null}
              </section>
            )
          })}
        </div>
      ) : (
        <pre className="react-chat-session-debug-modal-pre react-chat-session-debug-modal-pre--fill">
          {text}
        </pre>
      )}
    </div>
  )
}

function DebugToolsPanel({
  toolStats,
  toolNames,
  loading,
}: {
  toolStats: ToolContentStat[]
  toolNames: string[]
  loading: boolean
}) {
  const rows = useMemo(() => {
    if (toolStats.length) {
      return [...toolStats].sort((a, b) => b.tokens - a.tokens)
    }
    return toolNames.map((name) => ({
      name,
      chars: 0,
      tokens: 0,
      estimated: false as const,
    }))
  }, [toolStats, toolNames])

  const total = useMemo(() => {
    if (!toolStats.length) return null
    return {
      chars: toolStats.reduce((sum, row) => sum + row.chars, 0),
      tokens: toolStats.reduce((sum, row) => sum + row.tokens, 0),
    }
  }, [toolStats])

  if (!rows.length) {
    return (
      <div className="react-chat-session-debug-modal-empty">
        {loading ? '加载中…' : '本次调用未挂载工具'}
      </div>
    )
  }

  return (
    <div className="react-chat-session-debug-modal-tools-panel">
      {total ? (
        <ContentStatsBar stats={total} label="工具 schema 合计" />
      ) : (
        <div className="obs-content-stats-bar obs-content-stats-bar--muted">
          旧记录无逐工具统计；重启后端后发新对话可看到每项 token
        </div>
      )}
      <div className="react-chat-session-debug-modal-tools-table-wrap">
        <table className="react-chat-session-debug-modal-tools-table">
          <thead>
            <tr>
              <th>工具</th>
              <th>字符</th>
              <th>Token（估）</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name}>
                <td className="react-chat-session-debug-modal-tools-name">{row.name}</td>
                <td className="react-chat-session-debug-modal-tools-num">
                  {toolStats.length ? row.chars.toLocaleString() : '—'}
                </td>
                <td className="react-chat-session-debug-modal-tools-num">
                  {toolStats.length ? `~${row.tokens.toLocaleString()}` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function tabLabel(
  base: string,
  stats: ContentStats | null | undefined,
  tokenOverride?: number | null,
): string {
  const tok =
    typeof tokenOverride === 'number' && Number.isFinite(tokenOverride)
      ? tokenOverride
      : stats?.tokens
  const short = tok != null ? fmtContentStatsShort({ chars: 0, tokens: tok }) : ''
  return short ? `${base} (${short})` : base
}

function SessionDebugCallModalInner({
  request,
  onClose,
}: {
  request: RequestRecord
  onClose: () => void
}) {
  const [tab, setTab] = useState<ModalTab>('assistant')
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)

  const promptViews = useMemo(
    () => parseRequestViews(detail?.request_json),
    [detail?.request_json],
  )
  const responseViews = useMemo(
    () => parseResponseViews(detail?.response_json),
    [detail?.response_json],
  )
  const failureMessage = useMemo(
    () => resolveFailureMessage(request, detail, responseViews),
    [request, detail, responseViews],
  )

  const toolNames = promptViews?.requestToolNames ?? []
  const toolStats = promptViews?.requestToolStats ?? []
  const toolCalls = responseViews?.toolCalls ?? []
  const hasUsage = detail?.usage_json != null

  const assistantText =
    responseViews?.assistantContent?.trim() ||
    (responseViews?.reasoningContent?.trim()
      ? `[Thinking]\n${responseViews.reasoningContent.trim()}`
      : '') ||
    request.replyPreview?.trim() ||
    ''

  const assistantStats = resolveContentStats(
    responseViews?.assistantStats,
    assistantText,
  )
  const systemStats = resolveContentStats(
    promptViews?.systemPromptStats,
    promptViews?.systemPrompt,
  )
  const userStats = resolveContentStats(
    promptViews?.userLatestStats,
    promptViews?.userLatest,
  )

  const tabs = useMemo(() => {
    const items: { id: ModalTab; label: string }[] = [
      {
        id: 'tools',
        label: tabLabel('工具', null, promptViews?.requestToolsTokensTotal),
      },
      {
        id: 'system',
        label: tabLabel('系统提示词', systemStats),
      },
      {
        id: 'user',
        label: tabLabel('用户', userStats),
      },
      {
        id: 'assistant',
        label: tabLabel('回复', assistantStats),
      },
    ]
    if (toolCalls.length > 0) {
      items.push({ id: 'tool_calls', label: `工具调用 (${toolCalls.length})` })
    }
    items.push({ id: 'request', label: '请求 JSON' })
    items.push({ id: 'response', label: '响应 JSON' })
    if (hasUsage) {
      items.push({ id: 'usage', label: '用量' })
    }
    return items
  }, [
    assistantStats,
    hasUsage,
    promptViews?.requestToolsTokensTotal,
    systemStats,
    toolCalls.length,
    userStats,
  ])

  useEffect(() => {
    queueMicrotask(() => setTab('assistant'))
  }, [request.id])

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      setLoading(true)
      void fetchObsModelDetail(request.id)
        .then((row) => {
          if (!cancelled) setDetail(row)
        })
        .catch(() => {
          if (!cancelled) setDetail(null)
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    })
    return () => {
      cancelled = true
    }
  }, [request.id])

  useEffect(() => {
    if (!tabs.some((t) => t.id === tab)) {
      queueMicrotask(() => setTab('assistant'))
    }
  }, [tab, tabs])

  const statusLabel =
    request.status === 'failed' ? '失败' : request.status === 'warning' ? '警告' : '成功'

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const renderTabBody = () => {
    if (loading && tab !== 'tools') {
      return <div className="react-chat-session-debug-modal-empty">加载详情…</div>
    }

    switch (tab) {
      case 'tools':
        return (
          <DebugToolsPanel
            toolStats={toolStats}
            toolNames={toolNames}
            loading={loading}
          />
        )

      case 'system':
        return (
          <DebugSystemPromptPanel
            value={promptViews?.systemPrompt}
            stats={promptViews?.systemPromptStats}
            emptyHint={loading ? '加载中…' : '未记录系统提示词'}
          />
        )

      case 'user':
        return (
          <DebugTextPanel
            value={promptViews?.userLatest}
            stats={promptViews?.userLatestStats}
            emptyHint={loading ? '加载中…' : '未找到用户消息'}
          />
        )

      case 'assistant':
        return (
          <div className="react-chat-session-debug-modal-stack">
            <DebugTextPanel
              value={assistantText}
              stats={responseViews?.assistantStats}
              emptyHint={
                loading
                  ? '加载中…'
                  : failureMessage || responseViews?.truncationNote || '暂无文本回复'
              }
            />
            {responseViews?.reasoningContent?.trim() ? (
              <section className="react-chat-session-debug-modal-section react-chat-session-debug-modal-section--inline">
                <div className="react-chat-session-debug-modal-section-title">
                  Thinking
                  {responseViews.reasoningStats
                    ? ` · ${fmtContentStats(responseViews.reasoningStats)}`
                    : ''}
                </div>
                <pre className="react-chat-session-debug-modal-pre react-chat-session-debug-modal-pre--compact">
                  {responseViews.reasoningContent.trim()}
                </pre>
              </section>
            ) : null}
            {failureMessage ? (
              <section className="react-chat-session-debug-modal-section react-chat-session-debug-modal-section--inline">
                <div className="react-chat-session-debug-modal-section-title">
                  失败原因
                  {estimateTextStats(failureMessage)
                    ? ` · ${fmtContentStats(estimateTextStats(failureMessage))}`
                    : ''}
                </div>
                <pre className="react-chat-session-debug-modal-pre react-chat-session-debug-modal-pre--compact">
                  {failureMessage}
                </pre>
              </section>
            ) : null}
            {responseViews?.truncationNote && !failureMessage ? (
              <section className="react-chat-session-debug-modal-section react-chat-session-debug-modal-section--inline">
                <div className="react-chat-session-debug-modal-section-title">输出截断</div>
                <pre className="react-chat-session-debug-modal-pre react-chat-session-debug-modal-pre--compact">
                  {responseViews.truncationNote}
                </pre>
              </section>
            ) : null}
          </div>
        )

      case 'tool_calls':
        return (
          <div className="react-chat-session-debug-modal-tool-calls react-chat-session-debug-modal-tool-calls--panel">
            {toolCalls.map((tool, index) => {
              const argsText = formatJsonText(tool.arguments ?? tool.raw) || '—'
              const argsStats = estimateTextStats(argsText)
              return (
                <div key={`${tool.id}-${index}`} className="react-chat-session-debug-modal-tool-call">
                  <div className="react-chat-session-debug-modal-tool-call-name">
                    {tool.name}
                    {argsStats ? ` · ${fmtContentStats(argsStats)}` : ''}
                  </div>
                  <pre className="react-chat-session-debug-modal-pre">{argsText}</pre>
                </div>
              )
            })}
          </div>
        )

      case 'request':
        return (
          <JsonViewer
            title=""
            layout="panel"
            value={detail?.request_json ?? promptViews?.raw}
            emptyHint={loading ? '加载中…' : '暂无请求数据'}
          />
        )

      case 'response':
        return (
          <JsonViewer
            title=""
            layout="panel"
            value={detail?.response_json ?? responseViews?.raw}
            emptyHint={loading ? '加载中…' : '暂无响应数据'}
          />
        )

      case 'usage':
        return (
          <JsonViewer
            title=""
            layout="panel"
            value={detail?.usage_json}
            emptyHint={loading ? '加载中…' : '暂无用量数据'}
          />
        )

      default:
        return null
    }
  }

  return createPortal(
    <div
      className="react-chat-session-debug-modal-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="react-chat-session-debug-modal"
        role="dialog"
        aria-modal="true"
        aria-label="模型调用详情"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="react-chat-session-debug-modal-header">
          <div className="react-chat-session-debug-modal-header-main">
            <h3>
              {request.modelCallSeq != null ? `#${request.modelCallSeq} · ` : ''}
              {request.model}
            </h3>
            <p>
              <span className={`react-chat-session-debug-modal-status is-${request.status}`}>
                {statusLabel}
              </span>
              <span>{request.relativeTime || request.time}</span>
              <span>{request.latency}</span>
              <span title={requestTokenTitle(request)}>
                {fmtUsageTok(request.promptTokens)} / {fmtUsageTok(request.completionTokens)} tok
              </span>
              {request.cacheReadTokens ? (
                <span title={requestTokenTitle(request)}>
                  缓存 {fmtCacheHitTok(request.cacheReadTokens, request.cacheMissTokens)}
                </span>
              ) : null}
              {request.totalCycleMs ? (
                <span title={`模型 ${request.latency} + 开销 ${fmtMs(Math.max(0, request.totalCycleMs - request.latencyMs))}`}>
                  整轮 {request.totalCycle}
                </span>
              ) : null}
            </p>
          </div>
          <button
            type="button"
            className="react-chat-session-debug-modal-close"
            aria-label="关闭"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="react-chat-session-debug-modal-tabs" role="tablist">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={`react-chat-session-debug-modal-tab${tab === item.id ? ' is-active' : ''}`}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="react-chat-session-debug-modal-body">
          <div className="react-chat-session-debug-modal-tab-panel">{renderTabBody()}</div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export const SessionDebugCallModal = memo(SessionDebugCallModalInner)
