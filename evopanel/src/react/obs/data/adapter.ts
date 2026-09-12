import type { ObsDashboardBundle, ObsRecentRequest, ObsTimeRangeKey, ObsToolErrorRow } from '../lib/obs-types'
import {
  fmtDeltaPct,
  fmtDeltaPts,
  fmtCnyEstimate,
  fmtHitPct,
  fmtIso,
  fmtMs,
  fmtNum,
  fmtPct,
  fmtRelativeTime,
  fmtTok,
  agentKindLabel,
  displayProviderLabelZh,
  displayProviderName,
} from '../lib/obs-formatters'
import { looksLikeApiError, parseResponseViews } from '../lib/obs-payload-parse'
import type {
  AgentRecord,
  GatewayRoute,
  ModelRecord,
  ProviderRecord,
  RequestRecord,
  TimePoint,
  ToolCallRecord,
  ToolRecord,
  TraceRecord,
  TraceStep,
} from '../types'
import type { Metric } from '../types'

const EMPTY_METRICS: Metric[] = [
  { title: '模型调用', value: '—', delta: '—', trend: 'neutral', icon: '〽', accent: 'blue', data: [0] },
  { title: '成功率', value: '—', delta: '—', trend: 'neutral', icon: '✓', accent: 'green', data: [0] },
  { title: '平均延迟', value: '—', delta: '—', trend: 'neutral', icon: '◷', accent: 'purple', data: [0] },
  { title: 'Token 消耗', value: '—', delta: '—', trend: 'neutral', icon: '◉', accent: 'orange', data: [0] },
]

const DONUT_COLORS = ['#3b82f6', '#22c55e', '#a855f7', '#f59e0b', '#ef4444', '#06b6d4', '#8b5cf6']

export type HealthSegment = {
  label: string
  value: number
  percent: number
  color: 'success' | 'warning' | 'failed'
}

export type ModelRankingRow = {
  label: string
  provider?: string
  value: number
  requests: string
  tokens: string
  cacheRead: string
  cacheHitRate: string
  cost: string
  cacheReadTokens: number
}

function sparkValues(points: { value: number }[] | undefined): number[] {
  if (!points?.length) return [0]
  return points.map((p) => p.value)
}

function shortDayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00`)
  if (Number.isNaN(d.getTime())) return day
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function mapRequestStatus(status: 'success' | 'warning' | 'error'): RequestRecord['status'] {
  return status === 'error' ? 'failed' : status
}

function rangeLabel(key: ObsTimeRangeKey): string {
  return key === 'all' ? '全部' : key
}

function deltaLabel(
  value: number | null | undefined,
  kind: 'pct' | 'pts' | 'ms',
  range: ObsTimeRangeKey,
): string {
  const suffix = ` vs ${rangeLabel(range)} 前`
  if (value == null || !Number.isFinite(value)) return `—${suffix}`
  if (kind === 'pts') return `${fmtDeltaPts(value)}${suffix}`
  if (kind === 'ms') {
    const arrow = value >= 0 ? '↑' : '↓'
    return `${arrow} ${Math.abs(Math.round(value))}ms${suffix}`
  }
  return `${fmtDeltaPct(value)}${suffix}`
}

export function useLiveData(bundle: ObsDashboardBundle | null): boolean {
  return bundle?.enabled === true
}

function mapCacheFields(row: {
  cache_read_tokens?: number | null
  cache_creation_tokens?: number | null
  cache_miss_tokens?: number | null
}) {
  const cacheRead = Number(row.cache_read_tokens) || 0
  const cacheCreation = Number(row.cache_creation_tokens) || 0
  const cacheMiss = Number(row.cache_miss_tokens) || 0
  return {
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheCreation > 0 ? { cacheCreationTokens: cacheCreation } : {}),
    ...(cacheMiss > 0 ? { cacheMissTokens: cacheMiss } : {}),
  }
}

export function apiRecentToRequestRecord(row: ObsRecentRequest): RequestRecord {
  const status = mapRequestStatus(row.status)
  const failureMessage =
    (row.failure_message ?? row.error ?? undefined)?.trim() || undefined
  const replyPreview = row.reply_preview?.trim() || undefined
  const messageCount = row.message_count != null ? Number(row.message_count) : undefined
  const modelCallSeq = row.model_call_seq != null ? Number(row.model_call_seq) : undefined
  let replyKind: string | undefined
  if (status === 'failed') {
    replyKind = 'error'
  } else if (status === 'warning') {
    replyKind = 'warning'
  } else {
    const kind = (row.invocation_kind || '').trim().toLowerCase()
    if (kind === 'tool_call' || kind === 'tool-use') {
      replyKind = 'tool_call'
    } else if (kind === 'planning' || kind === 'reason') {
      replyKind = kind
    } else {
      replyKind = 'text'
    }
  }
  return {
    id: row.id,
    status,
    time: fmtIso(row.occurred_at),
    relativeTime: fmtRelativeTime(row.occurred_at),
    occurredAt: String(row.occurred_at || '').trim() || undefined,
    agent: row.agent_label || '—',
    model: row.model || '—',
    provider: displayProviderName(row.provider, row.model),
    latency: fmtMs(row.latency_ms),
    latencyMs: row.latency_ms ?? 0,
    totalCycleMs: row.total_cycle_ms ?? 0,
    totalCycle: fmtMs(row.total_cycle_ms),
    promptTokens: row.prompt_tokens ?? 0,
    completionTokens: row.completion_tokens ?? 0,
    ...mapCacheFields(row),
    tokens: row.tokens,
    cost: row.cost_usd ?? 0,
    estimatedCostCny:
      row.estimated_cost_cny != null && Number.isFinite(Number(row.estimated_cost_cny))
        ? Number(row.estimated_cost_cny)
        : undefined,
    threadId: row.thread_id || '—',
    runId: row.run_id || '—',
    stage: row.stage || '—',
    replyKind,
    payloadMessageCount: messageCount,
    modelCallSeq: Number.isFinite(modelCallSeq) && modelCallSeq! > 0 ? modelCallSeq : undefined,
    contextTurns: messageCount,
    failureMessage,
    replyPreview,
    thinkingLabel: row.thinking_label?.trim() || undefined,
    reasoningEffort: (row.reasoning_effort as string | null) ?? null,
    thinkingType: (row.thinking_type as string | null) ?? null,
    thinkingBudgetTokens:
      row.thinking_budget_tokens != null ? Number(row.thinking_budget_tokens) : null,
    sessionMode: (row.session_mode as string | null) ?? null,
    region: '—',
  }
}

/** Map a paginated ``/observability/models`` list row to ``RequestRecord``. */
export function apiModelListRowToRequestRecord(row: Record<string, unknown>): RequestRecord {
  const summary = row.response_summary as
    | { kind?: string; content_preview?: string; contentPreview?: string }
    | undefined
  const preview = String(summary?.content_preview || summary?.contentPreview || '').trim() || undefined
  const failureFromDb = String(row.error_message || '').trim() || undefined
  const responseViews = row.response_json != null ? parseResponseViews(row.response_json) : null
  const failureFromResponse = responseViews?.errorMessage?.trim() || undefined
  const failureFromSummary =
    preview && String(summary?.kind || '') === 'error' && looksLikeApiError(preview) ? preview : undefined
  const failureMessage = failureFromDb || failureFromResponse || failureFromSummary
  const reasoningPreview = responseViews?.reasoningContent?.trim()
    ? responseViews.reasoningContent.trim().slice(0, 200)
    : undefined
  const replyPreview =
    preview && !failureMessage
      ? preview
      : reasoningPreview && !failureMessage
        ? `[Thinking] ${reasoningPreview}${responseViews!.reasoningContent.length > 200 ? '…' : ''}`
        : undefined
  const truncatedThinkingOnly = Boolean(
    responseViews?.truncationNote && !responseViews?.assistantContent?.trim() && reasoningPreview,
  )
  const statusRaw = failureMessage
    ? 'error'
    : truncatedThinkingOnly ||
        summary?.kind === 'truncated_thinking' ||
        String(summary?.kind || '') === 'warning'
      ? 'warning'
      : 'success'
  const base = apiRecentToRequestRecord({
    id: String(row.id || ''),
    status: statusRaw as ObsRecentRequest['status'],
    agent_label: String(row.invocation_kind || row.model || '主对话 Agent'),
    model: String(row.model || '—'),
    provider: displayProviderName(String(row.provider || '—'), String(row.model || '')),
    latency_ms: (row.latency_ms as number | null) ?? null,
    total_cycle_ms: (row.total_cycle_ms as number | null) ?? null,
    prompt_tokens: Number(row.usage_input_tokens || 0),
    completion_tokens: Number(row.usage_output_tokens || 0),
    cache_read_tokens:
      row.usage_cache_read_tokens != null
        ? Number(row.usage_cache_read_tokens)
        : row.cache_read_tokens != null
          ? Number(row.cache_read_tokens)
          : null,
    cache_creation_tokens:
      row.usage_cache_creation_tokens != null
        ? Number(row.usage_cache_creation_tokens)
        : row.cache_creation_tokens != null
          ? Number(row.cache_creation_tokens)
          : null,
    cache_miss_tokens:
      row.usage_cache_miss_tokens != null
        ? Number(row.usage_cache_miss_tokens)
        : row.cache_miss_tokens != null
          ? Number(row.cache_miss_tokens)
          : null,
    tokens: Number(row.usage_total_tokens || 0),
    cost_usd: row.estimated_cost_cny != null ? Number(row.estimated_cost_cny) : null,
    estimated_cost_cny: row.estimated_cost_cny != null ? Number(row.estimated_cost_cny) : null,
    occurred_at: String(row.requested_at || ''),
    thread_id: String(row.thread_id || ''),
    run_id: String(row.run_id || ''),
    stage: String(row.stage || ''),
    trace_id: String(row.trace_id || ''),
    failure_message: failureMessage ?? null,
    reply_preview: replyPreview ?? null,
    invocation_kind: row.invocation_kind as string | undefined,
    message_count: row.message_count as number | undefined,
    model_call_seq: row.model_call_seq as number | undefined,
    thinking_label: row.thinking_label as string | undefined,
    reasoning_effort: row.reasoning_effort as string | undefined,
    thinking_type: row.thinking_type as string | undefined,
    thinking_budget_tokens: row.thinking_budget_tokens as number | undefined,
    session_mode: row.session_mode as string | undefined,
  })
  // Override replyKind based on response_summary.kind which reflects the actual response content
  const responseKind = (summary?.kind || '').trim().toLowerCase()
  if (statusRaw === 'success') {
    if (responseKind === 'tools_and_content') {
      base.replyKind = 'tools_and_content'
    } else if (responseKind === 'tools') {
      base.replyKind = 'tool_call'
    } else if (responseKind === 'content') {
      base.replyKind = 'text'
    }
  }
  return base
}

export type AgentTopRow = {
  rank: number
  name: string
  successRate: number
  avgLatency: string
  requests: number
  errorRate: number
  status: '正常' | '注意' | '异常'
  mainModel: string
}

export function bundleAgentsToTopRows(bundle: ObsDashboardBundle | null, enabled: boolean): AgentTopRow[] {
  if (!enabled || !bundle?.agents_summary?.length) return []
  return bundle.agents_summary.slice(0, 5).map((row, index) => {
    const successRate = Number(row.success_rate || 0)
    const statusRaw = row.status || 'normal'
    const status: AgentTopRow['status'] =
      statusRaw === 'error' ? '异常' : statusRaw === 'warning' ? '注意' : '正常'
    return {
      rank: index + 1,
      name: agentKindLabel(row.name),
      successRate,
      avgLatency: fmtMs(Number(row.avg_latency_ms || 0)),
      requests: Number(row.requests || 0),
      errorRate: Math.round((100 - successRate) * 10) / 10,
      status,
      mainModel: row.main_model || '—',
    }
  })
}

export function bundleRecentToolErrors(
  bundle: ObsDashboardBundle | null,
  enabled: boolean,
): ObsToolErrorRow[] {
  if (!enabled || !bundle?.recent_tool_errors?.length) return []
  return bundle.recent_tool_errors
}

export function bundleToMetrics(
  bundle: ObsDashboardBundle | null,
  timeRange: ObsTimeRangeKey,
  enabled: boolean,
) {
  if (!enabled || !bundle?.kpis) return EMPTY_METRICS
  const k = bundle.kpis
  const d = k.deltas
  return [
    {
      title: '模型调用',
      value: fmtNum(k.total_requests),
      delta: deltaLabel(d.total_requests_pct, 'pct', timeRange),
      trend: d.total_requests_pct != null && d.total_requests_pct < 0 ? 'down' : 'up',
      icon: '〽',
      accent: 'blue' as const,
      data: sparkValues(k.sparklines.requests),
    },
    {
      title: '成功率',
      value: fmtPct(k.success_rate),
      delta: deltaLabel(d.success_rate_pts, 'pts', timeRange),
      trend: d.success_rate_pts != null && d.success_rate_pts < 0 ? 'bad' : 'up',
      icon: '✓',
      accent: 'green' as const,
      data: sparkValues(k.sparklines.success_rate),
    },
    {
      title: '平均延迟',
      value: fmtMs(k.avg_latency_ms),
      delta: deltaLabel(d.avg_latency_ms_pct, 'pct', timeRange),
      trend: d.avg_latency_ms_pct != null && d.avg_latency_ms_pct > 0 ? 'bad' : 'neutral',
      icon: '◷',
      accent: 'purple' as const,
      data: sparkValues(k.sparklines.latency_ms),
    },
  ]
}

export function bundleToRequestTrend(bundle: ObsDashboardBundle | null, enabled: boolean): TimePoint[] {
  if (!enabled || !bundle?.request_trends?.length) return []
  const tokenByDay = new Map((bundle.token_trends ?? []).map((t) => [t.day, t]))
  return bundle.request_trends.map((row) => {
    const tokens = tokenByDay.get(row.day)
    return {
      label: shortDayLabel(row.day),
      total: row.total,
      success: row.success,
      failed: row.failed,
      prompt: tokens ? tokens.prompt_tokens : 0,
      completion: tokens ? tokens.completion_tokens : 0,
      cost: tokens?.cost_usd ?? 0,
      cacheRead: tokens?.cache_read_tokens ?? 0,
      cacheHitRatePct: tokens?.cache_hit_rate_pct ?? null,
    }
  })
}

export function bundleToRecentRequests(bundle: ObsDashboardBundle | null, enabled: boolean): RequestRecord[] {
  if (!enabled || !bundle?.recent_requests?.length) return []
  return bundle.recent_requests.map(apiRecentToRequestRecord)
}

export function bundleToHealth(bundle: ObsDashboardBundle | null, enabled: boolean): {
  healthyPct: number
  segments: HealthSegment[]
} {
  if (!enabled || !bundle?.agent_health) {
    return { healthyPct: 0, segments: [] }
  }
  const h = bundle.agent_health
  const total = Math.max(h.total, 1)
  const segments: HealthSegment[] = [
    { label: 'Normal', value: h.normal, percent: Math.round((h.normal / total) * 100), color: 'success' },
    { label: 'Warning', value: h.warning, percent: Math.round((h.warning / total) * 100), color: 'warning' },
    { label: 'Error', value: h.error, percent: Math.round((h.error / total) * 100), color: 'failed' },
  ]
  return {
    healthyPct: Math.round((h.healthy_pct ?? h.normal / total) * 100),
    segments,
  }
}

export type PaletteDonutSegment = {
  label: string
  value: number
  percent: number
  color: string
}

export function modelRankingToDonut(rows: ModelRankingRow[], limit = 5): PaletteDonutSegment[] {
  if (!rows.length) return []
  const top = rows.slice(0, limit)
  const rest = rows.slice(limit)
  const segments = [...top]
  if (rest.length) {
    const othersValue = rest.reduce((sum, row) => sum + row.value, 0)
    if (othersValue > 0) {
      segments.push({
        label: 'others',
        provider: undefined,
        value: othersValue,
        requests: '—',
        tokens: fmtTok(othersValue),
        cacheRead: '—',
        cacheHitRate: '—',
        cost: '—',
        cacheReadTokens: 0,
      })
    }
  }
  const total = segments.reduce((sum, row) => sum + row.value, 0) || 1
  return segments.map((row, index) => ({
    label: row.label,
    value: row.value,
    percent: Math.round((row.value / total) * 1000) / 10,
    color: DONUT_COLORS[index % DONUT_COLORS.length],
  }))
}

export function bundleToModelRanking(bundle: ObsDashboardBundle | null, enabled: boolean): ModelRankingRow[] {
  if (!enabled || !bundle?.model_ranking?.length) {
    return []
  }
  return bundle.model_ranking.map((row) => ({
    label: row.model,
    provider: displayProviderName(row.provider, row.model),
    value: row.tokens,
    requests: row.requests.toLocaleString(),
    tokens: fmtTok(row.tokens),
    cacheRead: fmtTok(row.cache_read_tokens ?? 0),
    cacheHitRate: fmtHitPct(row.cache_hit_rate_pct ?? null),
    cost: row.cost_usd != null ? `$${row.cost_usd.toFixed(2)}` : '—',
    cacheReadTokens: Number(row.cache_read_tokens ?? 0),
  }))
}

export function apiAgentsToRecords(items: unknown[]): AgentRecord[] {
  return items
    .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
    .map((row) => ({
      name: String(row.name || '—'),
      status: (row.status as AgentRecord['status']) || 'normal',
      requests: Number(row.requests || 0),
      successRate: Number(row.success_rate || 0),
      avgLatency: fmtMs(Number(row.avg_latency_ms || 0)),
      tokens: fmtTok(Number(row.tokens || 0)),
      mainModel: String(row.main_model || '—'),
      tools: Number(row.tools || 0),
      owner: String(row.owner || '—'),
    }))
}

export function apiModelsToRecords(items: unknown[]): ModelRecord[] {
  return items
    .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
    .map((row) => {
      const tokensNum = Number(row.tokens || 0)
      const cacheReadNum = Number(row.cache_read_tokens || 0)
      return {
        model: String(row.model || '—'),
        provider: displayProviderLabelZh(String(row.provider || '—'), String(row.model || '')),
        requests: Number(row.requests || 0),
        successRate: Number(row.success_rate || 0),
        avgLatency: fmtMs(Number(row.avg_latency_ms || 0)),
        p95Latency: fmtMs(Number(row.p95_latency_ms || 0)),
        promptTokens: fmtTok(Number(row.prompt_tokens || 0)),
        completionTokens: fmtTok(Number(row.completion_tokens || 0)),
        tokens: fmtTok(tokensNum),
        tokensNum,
        cacheReadTokens: fmtTok(cacheReadNum),
        cacheReadNum,
        cacheHitRate: fmtHitPct(row.cache_hit_rate_pct as number | null | undefined),
        estimatedSavingsCny: fmtCnyEstimate(row.estimated_savings_cny as number | null | undefined),
        cost: Number(row.cost_usd || 0),
        errorRate: Number(row.error_rate || 0),
        mainAgents: Array.isArray(row.main_agents) ? row.main_agents.map(String) : [],
      }
    })
}

export function apiProvidersToRecords(items: unknown[]): ProviderRecord[] {
  return items
    .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
    .map((row) => ({
      name: displayProviderLabelZh(String(row.name || '—')),
      status: (row.status as ProviderRecord['status']) || 'normal',
      requests: Number(row.requests || 0),
      successRate: Number(row.success_rate || 0),
      avgLatency: fmtMs(Number(row.avg_latency_ms || 0)),
      tokens: fmtTok(Number(row.tokens || 0)),
      cacheReadTokens: fmtTok(Number(row.cache_read_tokens || 0)),
      cacheHitRate: fmtHitPct(row.cache_hit_rate_pct as number | null | undefined),
      estimatedSavingsCny: fmtCnyEstimate(row.estimated_savings_cny as number | null | undefined),
      cost: Number(row.cost_usd || 0),
      errors: String(row.errors ?? '—'),
    }))
}

export function apiToolsToRecords(items: unknown[]): ToolRecord[] {
  return items
    .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
    .map((row) => ({
      name: String(row.name || '—'),
      category: String(row.category || 'Tool'),
      requests: Number(row.requests || 0),
      successRate: Number(row.success_rate || 0),
      avgLatency: fmtMs(Number(row.avg_latency_ms || 0)),
      p95Latency: fmtMs(Number(row.p95_latency_ms || 0)),
      failureRate: Number(row.failure_rate || 0),
      mainAgent: String(row.main_agent || '—'),
    }))
}

export function apiToolCallsToRecords(items: unknown[]): ToolCallRecord[] {
  return items
    .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
    .map((row) => {
      const output = String(row.output || '')
      let status: ToolCallRecord['status'] =
        row.status === 'failed' ? 'failed' : row.status === 'warning' ? 'warning' : 'success'
      const exitM = output.match(/\[exit code:\s*(-?\d+)\]/i)
      if (exitM && Number(exitM[1]) !== 0) status = 'failed'
      else if (row.error && status === 'success') status = 'failed'

      return {
        id: String(row.id || ''),
        time: String(row.time || ''),
        toolName: String(row.tool_name || '—'),
        agent: String(row.agent || '—'),
        requestId: String(row.request_id || '—'),
        traceId: String(row.trace_id || '—'),
        status,
        latency: fmtMs(Number(row.latency_ms || 0)),
        input: String(row.input || ''),
        output,
        error: row.error ? String(row.error) : undefined,
      }
    })
}

export function apiGatewayRoutesToRecords(items: unknown[]): GatewayRoute[] {
  return items
    .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
    .map((row) => ({
      route: String(row.route || '—'),
      method: String(row.method || 'GET'),
      requests: Number(row.requests || 0),
      avgLatency: fmtMs(Number(row.avg_latency_ms || 0)),
      p95Latency: fmtMs(Number(row.p95_latency_ms || 0)),
      status2xx: Number(row.status2xx || 0),
      status4xx: Number(row.status4xx || 0),
      status5xx: Number(row.status5xx || 0),
      rateLimited: Number(row.rate_limited || 0),
      upstream: String(row.upstream || 'Gateway'),
    }))
}

export function apiThreadsToRecords(items: unknown[]): TraceRecord[] {
  return items
    .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
    .map((row) => ({
      id: String(row.id || row.thread_id || ''),
      threadId: String(row.thread_id || row.id || ''),
      agent: String(row.agent || '—'),
      duration: fmtMs(Number(row.duration_ms || 0)),
      steps: Number(row.steps || 0),
      status: (row.status as TraceRecord['status']) || 'success',
      startedAt: String(row.started_at || ''),
      summary: String(row.summary || ''),
      items: [],
    }))
}

function parseIsoToMs(iso: unknown): number | undefined {
  if (!iso || typeof iso !== 'string') return undefined
  const t = Date.parse(iso)
  return Number.isNaN(t) ? undefined : t
}

export function timelineToTraceSteps(items: unknown[]): TraceStep[] {
  return items
    .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
    .map((row, index) => {
      const kind = String(row.kind || 'event')
      const isModel = kind === 'model'
      const isTool = kind === 'tool'
      const title = isModel
        ? `Model: ${row.model || 'call'}`
        : isTool
          ? `Tool: ${row.tool_name || 'call'}`
          : String(row.event || 'Trace event')

      const rawStatus = String(row.status || (isModel ? 'completed' : isTool ? 'success' : ''))
      const isRunning = rawStatus === 'running'
      const status: TraceStep['status'] = isRunning
        ? 'warning'
        : rawStatus === 'error' || rawStatus === 'failed'
          ? 'failed'
          : rawStatus === 'warning'
            ? 'warning'
            : 'success'

      const durMs = Number(row.duration_ms ?? row.latency_ms ?? 0)

      const tsMs = parseIsoToMs(row.started_at ?? row.occurred_at ?? row.requested_at ?? row.at)
      let endedMs: number | undefined
      if (isTool) {
        endedMs = parseIsoToMs(row.ended_at) ?? (tsMs != null ? tsMs + durMs : undefined)
      } else if (isModel && !isRunning) {
        endedMs = tsMs != null ? tsMs + durMs : undefined
      }

      return {
        id: String(row.id || index),
        type: kind,
        title,
        duration: isRunning ? 'running…' : fmtMs(durMs),
        durationMs: durMs,
        status,
        statusRaw: rawStatus || undefined,
        meta: String(row.error_message || row.stage || row.event || ''),
        tsMs,
        endedMs,
      }
    })
}

export function trendsToTimePoints(trends: Record<string, unknown> | null): TimePoint[] {
  if (!trends?.enabled) return []
  const modelDaily = (trends.model_daily as Array<Record<string, unknown>>) || []
  const toolDaily = (trends.tool_daily as Array<Record<string, unknown>>) || []
  const toolErrByDay = new Map(toolDaily.map((r) => [String(r.day || ''), Number(r.tool_errors || 0)]))
  return modelDaily.map((row) => {
    const day = String(row.day || '')
    const total = Number(row.model_calls || 0)
    const failed = Math.min(total, toolErrByDay.get(day) || 0)
    return {
      label: shortDayLabel(day),
      total,
      success: Math.max(0, total - failed),
      failed,
      prompt: 0,
      completion: 0,
      cost: 0,
    }
  })
}
