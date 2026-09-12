import { useEffect, useMemo, useState } from 'react'
import type { RequestRecord } from '../types'
import { fetchObsModelDetail } from '../lib/obs-api'
import {
  parseRequestViews,
  parseResponseViews,
  parseThinkingContext,
  resolveFailureMessage,
} from '../lib/obs-payload-parse'
import { JsonViewer } from './JsonViewer'
import { ContentStatsBar } from './ContentStatsBar'
import { fmtContentStats } from '../lib/obs-text-stats'
import { ThreadLabel } from './ThreadLabel'
import { StatusBadge } from './StatusBadge'
import { fmtCacheHitTok, fmtCnyEstimate, fmtMs, fmtUsageTok, requestTokenTitle } from '../lib/obs-formatters'

const DRAWER_TABS = ['Overview', 'Prompt', 'Response', 'Token', 'Metadata', 'Trace', 'Errors'] as const
type DrawerTab = (typeof DRAWER_TABS)[number]

function buildMetadata(request: RequestRecord, detail: Record<string, unknown> | null) {
  if (detail) {
    const { request_json: _rq, response_json: _rs, ...rest } = detail
    return rest
  }
  return {
    request_id: request.id,
    agent: request.agent,
    model: request.model,
    provider: request.provider,
    status: request.status,
    latency_ms: request.latencyMs,
    total_cycle_ms: request.totalCycleMs || null,
    tokens: {
      prompt: request.promptTokens,
      completion: request.completionTokens,
      total: request.tokens,
      cache_read: request.cacheReadTokens ?? null,
      cache_creation: request.cacheCreationTokens ?? null,
      cache_miss: request.cacheMissTokens ?? null,
    },
    cost_usd: request.cost || null,
    thread_id: request.threadId,
    run_id: request.runId,
    stage: request.stage,
    model_call_seq: request.modelCallSeq ?? null,
    payload_message_count: request.payloadMessageCount ?? null,
    thinking_label: request.thinkingLabel ?? null,
    reasoning_effort: request.reasoningEffort ?? null,
    thinking_type: request.thinkingType ?? null,
    thinking_budget_tokens: request.thinkingBudgetTokens ?? null,
    session_mode: request.sessionMode ?? null,
  }
}

export function RequestDetailDrawer({ request, onClose }: { request: RequestRecord | null; onClose: () => void }) {
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<DrawerTab>('Overview')

  useEffect(() => {
    queueMicrotask(() => setActiveTab('Overview'))
  }, [request?.id])

  useEffect(() => {
    if (!request?.id) {
      queueMicrotask(() => {
        setDetail(null)
      })
      return
    }
    queueMicrotask(() => {
      setLoading(true)
      void fetchObsModelDetail(request.id)
        .then((row) => setDetail(row))
        .catch(() => setDetail(null))
        .finally(() => setLoading(false))
    })
  }, [request?.id])

  const promptViews = useMemo(
    () => parseRequestViews(detail?.request_json),
    [detail?.request_json],
  )
  const thinkingContext = useMemo(
    () =>
      parseThinkingContext(detail?.request_json, detail) ||
      promptViews?.thinkingContext,
    [detail, promptViews?.thinkingContext],
  )
  const responseViews = useMemo(
    () => parseResponseViews(detail?.response_json),
    [detail?.response_json],
  )
  const metadata = useMemo(() => (request ? buildMetadata(request, detail) : null), [request, detail])
  const failureMessage = useMemo(
    () => (request ? resolveFailureMessage(request, detail, responseViews) : null),
    [request, detail, responseViews],
  )
  const replyPreview = useMemo(() => {
    if (!request) return null
    if (responseViews?.assistantContent?.trim()) return responseViews.assistantContent.trim()
    if (responseViews?.reasoningContent?.trim()) {
      const r = responseViews.reasoningContent.trim()
      return r.length > 400 ? `${r.slice(0, 400)}…` : r
    }
    if (responseViews?.truncationNote) return responseViews.truncationNote
    return request.replyPreview?.trim() || null
  }, [request, responseViews])

  const toolNames = useMemo(() => promptViews?.requestToolNames ?? [], [promptViews?.requestToolNames])
  const toolStats = useMemo(() => promptViews?.requestToolStats ?? [], [promptViews?.requestToolStats])

  if (!request) return null

  const costLabel = fmtCnyEstimate(request.estimatedCostCny ?? (request.cost > 0 ? request.cost : null))
  const displayStatus =
    responseViews?.truncationNote && !responseViews?.assistantContent?.trim() && !responseViews?.toolCalls?.length
      ? 'warning'
      : request.status

  const openTrace = () => {
    if (request.threadId && request.threadId !== '—') {
      window.location.hash = `#/debug/agent-trace?thread_id=${encodeURIComponent(request.threadId)}`
    }
  }

  const copyRequestId = async () => {
    try {
      await navigator.clipboard.writeText(request.id)
    } catch {
      /* ignore */
    }
  }

  return (
    <aside className="detail-drawer">
      <div className="drawer-header">
        <div>
          <h2>Request Detail</h2>
          <p>
            <span className="danger-dot" />
            {displayStatus === 'failed' ? '失败' : displayStatus === 'warning' ? '警告' : '成功'} · {request.relativeTime} ({request.time})
          </p>
        </div>
        <button type="button" className="icon-button" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="request-id-box">
        <span>Request ID</span>
        <code>{request.id}</code>
        <button type="button" onClick={() => void copyRequestId()}>
          复制
        </button>
      </div>
      <div className="tabs slim">
        {DRAWER_TABS.map((tab) => (
          <button
            type="button"
            className={activeTab === tab ? 'active' : ''}
            key={tab}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </div>

      {loading && activeTab !== 'Overview' && activeTab !== 'Token' && (
        <div className="obs-loading-banner">加载详情…</div>
      )}

      {activeTab === 'Overview' && (
        <div className="drawer-tab-panel">
          <div className="kv-list">
            <div>
              <span>Agent</span>
              <strong>{request.agent}</strong>
            </div>
            <div>
              <span>Model</span>
              <strong>{request.model}</strong>
            </div>
            <div>
              <span>Provider</span>
              <strong>{request.provider}</strong>
            </div>
            <div>
              <span>思考等级</span>
              <strong>{thinkingContext?.label || request.thinkingLabel || '—'}</strong>
              <em>
                {thinkingContext?.reasoningEffort
                  ? `reasoning.effort=${thinkingContext.reasoningEffort}`
                  : thinkingContext?.reasoningEffortInferred
                    ? `推断=${thinkingContext.reasoningEffortInferred}`
                    : ''}
                {thinkingContext?.thinkingType ? ` · type=${thinkingContext.thinkingType}` : ''}
                {thinkingContext?.thinkingBudgetTokens
                  ? ` · budget=${thinkingContext.thinkingBudgetTokens}`
                  : ''}
              </em>
            </div>
            <div>
              <span>Latency</span>
              <strong className={request.status === 'failed' ? 'text-danger' : ''}>{request.latency}</strong>
            </div>
            <div>
              <span>整轮耗时</span>
              <strong title={request.totalCycleMs ? `模型推理 ${request.latency} + 系统开销 ${fmtMs(Math.max(0, request.totalCycleMs - request.latencyMs))}` : undefined}>
                {request.totalCycleMs ? request.totalCycle : '—'}
              </strong>
              <em>
                {request.totalCycleMs
                  ? `推理 ${request.latency} · 开销 ${fmtMs(Math.max(0, request.totalCycleMs - request.latencyMs))}`
                  : '本线程最后一条调用'}
              </em>
            </div>
            <div>
              <span>Tokens</span>
              <strong>{request.tokens.toLocaleString()} tokens</strong>
              <em>
                输入 {fmtUsageTok(request.promptTokens)} · 输出 {fmtUsageTok(request.completionTokens)}
                {request.cacheReadTokens
                  ? ` · 缓存命中 ${fmtCacheHitTok(request.cacheReadTokens, request.cacheMissTokens)}`
                  : ''}
              </em>
            </div>
            {(request.cacheReadTokens || request.cacheCreationTokens || request.cacheMissTokens) ? (
              <div>
                <span>Prompt Cache</span>
                <strong title={requestTokenTitle(request)}>
                  {request.cacheReadTokens ? `命中 ${request.cacheReadTokens.toLocaleString()}` : '—'}
                  {request.cacheMissTokens ? ` · 未命中 ${request.cacheMissTokens.toLocaleString()}` : ''}
                  {request.cacheCreationTokens
                    ? ` · 写入 ${request.cacheCreationTokens.toLocaleString()}`
                    : ''}
                </strong>
              </div>
            ) : null}
            <div>
              <span>Cost</span>
              <strong>{costLabel}</strong>
            </div>
            <div>
              <span>Status</span>
              <StatusBadge status={displayStatus} />
            </div>
            <div>
              <span>Thread</span>
              <strong>
                <ThreadLabel threadId={request.threadId} showId />
              </strong>
            </div>
            <div>
              <span>Run</span>
              <strong>{request.runId}</strong>
            </div>
            <div>
              <span>Stage</span>
              <strong>{request.stage}</strong>
            </div>
            {request.modelCallSeq != null ? (
              <div>
                <span>消息seq</span>
                <strong>#{request.modelCallSeq}</strong>
              </div>
            ) : null}
            {request.payloadMessageCount != null ? (
              <div>
                <span>消息条数</span>
                <strong>{request.payloadMessageCount} 条</strong>
              </div>
            ) : null}
            <div>
              <span>工具列表</span>
              {toolNames.length > 0 ? (
                <strong className="drawer-tool-names">
                  {toolNames.map((name) => (
                    <span key={name} className="drawer-tool-name-chip">
                      {name}
                    </span>
                  ))}
                </strong>
              ) : (
                <strong>{loading ? '加载中…' : '—'}</strong>
              )}
              {toolStats.length > 0 ? (
                <em>
                  schema 合计 ~
                  {(
                    promptViews?.requestToolsTokensTotal ??
                    toolStats.reduce((sum, row) => sum + row.tokens, 0)
                  ).toLocaleString()}{' '}
                  tok
                </em>
              ) : null}
            </div>
          </div>
          <div className="drawer-section-title">用户最新问题</div>
          <JsonViewer
            title=""
            value={promptViews?.userLatest}
            mode="text"
            maxHeight={180}
            emptyHint={loading ? '加载中…' : '未找到 user 消息'}
          />
          {failureMessage && (
            <>
              <div className="drawer-section-title">失败原因</div>
              <JsonViewer title="" value={failureMessage} mode="text" maxHeight={160} />
            </>
          )}
          {responseViews?.truncationNote && (
            <>
              <div className="drawer-section-title">输出截断说明</div>
              <JsonViewer title="" value={responseViews.truncationNote} mode="text" maxHeight={120} />
            </>
          )}
          {replyPreview && (
            <>
              <div className="drawer-section-title">
                {responseViews?.assistantContent?.trim()
                  ? '回复预览'
                  : responseViews?.reasoningContent?.trim()
                    ? 'Thinking 预览'
                    : '回复预览'}
              </div>
              <JsonViewer title="" value={replyPreview} mode="text" maxHeight={180} />
            </>
          )}
        </div>
      )}

      {activeTab === 'Prompt' && (
        <div className="drawer-tab-panel">
          <div className="drawer-section-title">
            系统提示词
            {promptViews?.systemPromptStats
              ? ` · ${fmtContentStats(promptViews.systemPromptStats)}`
              : ''}
          </div>
          <ContentStatsBar stats={promptViews?.systemPromptStats} />
          <JsonViewer
            title=""
            value={promptViews?.systemPrompt}
            mode="text"
            emptyHint={loading ? '加载中…' : '未记录系统提示词'}
          />
          <div className="drawer-section-title">
            用户最新问题
            {promptViews?.userLatestStats
              ? ` · ${fmtContentStats(promptViews.userLatestStats)}`
              : ''}
          </div>
          <ContentStatsBar stats={promptViews?.userLatestStats} />
          <JsonViewer
            title=""
            value={promptViews?.userLatest}
            mode="text"
            emptyHint={loading ? '加载中…' : '未找到 user 消息'}
          />
          <div className="drawer-section-title">完整厂商请求 (request_json)</div>
          <JsonViewer
            title=""
            value={promptViews?.vendorRequest ?? promptViews?.raw ?? detail?.request_json}
            emptyHint={loading ? '加载中…' : '暂无厂商请求数据'}
          />
        </div>
      )}

      {activeTab === 'Response' && (
        <div className="drawer-tab-panel">
          {responseViews?.truncationNote && (
            <>
              <div className="drawer-section-title">截断 / 无正文说明</div>
              <JsonViewer title="" value={responseViews.truncationNote} mode="text" maxHeight={140} />
            </>
          )}
          {responseViews?.finishReason && (
            <div className="kv-list" style={{ marginBottom: '0.75rem' }}>
              <div>
                <span>finish_reason</span>
                <strong>{responseViews.finishReason}</strong>
              </div>
            </div>
          )}
          <div className="drawer-section-title">
            模型返回内容
            {responseViews?.assistantStats
              ? ` · ${fmtContentStats(responseViews.assistantStats)}`
              : ''}
          </div>
          <ContentStatsBar stats={responseViews?.assistantStats} />
          <JsonViewer
            title=""
            value={responseViews?.assistantContent}
            mode="text"
            emptyHint={
              loading
                ? '加载中…'
                : responseViews?.reasoningContent?.trim()
                  ? '无可见正文（输出在 Thinking 中，见下方）'
                  : '暂无文本回复'
            }
          />
          {responseViews?.reasoningContent?.trim() && (
            <>
              <div className="drawer-section-title">
                Thinking / reasoning_content
                {responseViews.reasoningStats
                  ? ` · ${fmtContentStats(responseViews.reasoningStats)}`
                  : ''}
              </div>
              <ContentStatsBar stats={responseViews.reasoningStats} />
              <JsonViewer
                title=""
                value={responseViews.reasoningContent}
                mode="text"
                emptyHint="无 thinking 内容"
                maxHeight={360}
              />
            </>
          )}
          {responseViews && responseViews.toolCalls.length > 0 && (
            <>
              <div className="drawer-section-title">工具调用 ({responseViews.toolCalls.length})</div>
              {responseViews.toolCalls.map((tool, index) => (
                <JsonViewer
                  key={`${tool.id}-${index}`}
                  title={`Tool · ${tool.name}`}
                  value={tool.arguments ?? tool.raw}
                  emptyHint="无参数"
                  maxHeight={200}
                />
              ))}
            </>
          )}
          <div className="drawer-section-title">完整 response_json</div>
          <JsonViewer
            title="response_json"
            value={responseViews?.raw ?? detail?.response_json}
            emptyHint={loading ? '加载中…' : '暂无 Response 数据'}
          />
        </div>
      )}

      {activeTab === 'Token' && (
        <div className="drawer-tab-panel">
          <div className="kv-list">
            <div>
              <span>Total</span>
              <strong>{request.tokens.toLocaleString()}</strong>
            </div>
            <div>
              <span>输入 (Prompt)</span>
              <strong>{request.promptTokens.toLocaleString()}</strong>
            </div>
            <div>
              <span>输出 (Completion)</span>
              <strong>{request.completionTokens.toLocaleString()}</strong>
            </div>
            <div>
              <span>缓存命中</span>
              <strong>{request.cacheReadTokens ? request.cacheReadTokens.toLocaleString() : '—'}</strong>
            </div>
            <div>
              <span>未命中</span>
              <strong>{request.cacheMissTokens ? request.cacheMissTokens.toLocaleString() : '—'}</strong>
            </div>
            <div>
              <span>写入缓存</span>
              <strong>{request.cacheCreationTokens ? request.cacheCreationTokens.toLocaleString() : '—'}</strong>
            </div>
            <div>
              <span>Cost</span>
              <strong>{costLabel}</strong>
            </div>
          </div>
          {detail?.usage_json != null && (
            <>
              <div className="drawer-section-title">Token 用量</div>
              <JsonViewer title="Token 用量" value={detail.usage_json} emptyHint="暂无用量数据" />
            </>
          )}
        </div>
      )}

      {activeTab === 'Metadata' && (
        <div className="drawer-tab-panel">
          <JsonViewer title="Metadata" value={metadata} emptyHint="暂无元数据" />
        </div>
      )}

      {activeTab === 'Trace' && (
        <div className="drawer-tab-panel">
          <div className="kv-list">
            <div>
              <span>Thread</span>
              <strong>
                <ThreadLabel threadId={request.threadId} showId />
              </strong>
            </div>
            <div>
              <span>Run</span>
              <strong>{request.runId}</strong>
            </div>
            <div>
              <span>Stage</span>
              <strong>{request.stage}</strong>
            </div>
            <div>
              <span>Trace ID</span>
              <strong>{String(detail?.trace_id ?? '—')}</strong>
            </div>
          </div>
          <div className="drawer-actions drawer-actions--inline">
            <button type="button" onClick={openTrace} disabled={!request.threadId || request.threadId === '—'}>
              在 Trace 中查看
            </button>
          </div>
        </div>
      )}

      {activeTab === 'Errors' && (
        <div className="drawer-tab-panel">
          {failureMessage ? (
            <>
              <div className="drawer-section-title">失败详情</div>
              <JsonViewer
                title="失败详情"
                value={{ failure_message: failureMessage, status: request.status }}
              />
              {detail?.error_type != null && (
                <>
                  <div className="drawer-section-title">错误类型</div>
                  <JsonViewer title="error_type" value={String(detail.error_type)} mode="text" maxHeight={120} />
                </>
              )}
            </>
          ) : (
            <div className="drawer-empty-hint">该请求没有记录失败信息</div>
          )}
        </div>
      )}

      <div className="drawer-actions">
        <button type="button" onClick={openTrace} disabled={!request.threadId || request.threadId === '—'}>
          在 Trace 中查看
        </button>
        <button type="button">复制 curl</button>
        <button type="button">导出 JSON</button>
      </div>
    </aside>
  )
}
