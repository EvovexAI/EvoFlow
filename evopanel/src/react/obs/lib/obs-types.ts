export type ObsSparkPoint = { day: string; value: number }

export type ObsDashboardKpis = {
  total_requests: number
  success_rate: number
  avg_latency_ms: number
  total_tokens: number
  tool_calls?: number
  tool_errors?: number
  deltas: {
    total_requests_pct: number | null
    success_rate_pts: number | null
    avg_latency_ms_pct: number | null
    total_tokens_pct: number | null
  }
  sparklines: {
    requests: ObsSparkPoint[]
    success_rate: ObsSparkPoint[]
    latency_ms: ObsSparkPoint[]
    tokens: ObsSparkPoint[]
  }
}

export type ObsRequestTrend = {
  day: string
  total: number
  success: number
  failed: number
}

export type ObsAgentHealth = {
  healthy_pct: number
  normal: number
  warning: number
  error: number
  total: number
}

export type ObsModelRanking = {
  model: string
  provider?: string
  requests: number
  tokens: number
  cache_read_tokens?: number
  cache_hit_rate_pct?: number | null
  cost_usd: number | null
  avg_latency_ms?: number
  error_rate?: number
}

export type ObsTokenTrend = {
  day: string
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cache_read_tokens?: number
  cache_miss_tokens?: number
  cache_hit_rate_pct?: number | null
  cost_usd: number | null
}

export type ObsRecentRequest = {
  id: string
  status: 'success' | 'warning' | 'error'
  agent_label: string
  invocation_kind?: string
  model?: string
  provider?: string
  latency_ms: number | null
  /** Wall-clock from this call to the next model call in the same thread (ms). */
  total_cycle_ms?: number | null
  prompt_tokens?: number
  completion_tokens?: number
  cache_read_tokens?: number | null
  cache_creation_tokens?: number | null
  cache_miss_tokens?: number | null
  tokens: number
  cost_usd?: number | null
  /** Estimated API cost from published CNY list prices (百炼 / 火山). */
  estimated_cost_cny?: number | null
  occurred_at: string
  thread_id: string
  run_id?: string
  stage?: string
  trace_id?: string
  /** Number of messages in the vendor API payload (not user-turn count). */
  message_count?: number | null
  /** 1-based model call index within the same run (tool-loop step). */
  model_call_seq?: number | null
  /** Present only when the invocation actually failed */
  failure_message?: string | null
  /** Short preview of assistant reply / tool summary for successful calls */
  reply_preview?: string | null
  /** Resolved thinking level label (e.g. 轻度 / 中度) */
  thinking_label?: string | null
  reasoning_effort?: string | null
  thinking_type?: string | null
  thinking_enabled?: number | null
  thinking_budget_tokens?: number | null
  session_mode?: string | null
  /** @deprecated use failure_message */
  error?: string | null
}

export type ObsAgentSummaryItem = {
  name: string
  status: 'normal' | 'warning' | 'error'
  requests: number
  success_rate: number
  avg_latency_ms: number
  tokens: number
  main_model: string
  tools: number
}

export type ObsToolErrorRow = {
  tool_name?: string
  error_type?: string
  error_message?: string
  ended_at?: string
  thread_id?: string
  duration_ms?: number
}

export type ObsDashboardBundle = {
  enabled: boolean
  window?: {
    since_hours: number | null
    since_iso: string | null
    previous_since_iso: string | null
  }
  kpis?: ObsDashboardKpis
  request_trends?: ObsRequestTrend[]
  agent_health?: ObsAgentHealth
  model_ranking?: ObsModelRanking[]
  token_trends?: ObsTokenTrend[]
  recent_requests?: ObsRecentRequest[]
  agents_summary?: ObsAgentSummaryItem[]
  recent_tool_errors?: ObsToolErrorRow[]
  summary?: {
    token_cost_usd: number | null
    avg_tokens_per_request: number
    tool_calls?: number
    tool_errors?: number
    cache_read_tokens?: number
    cache_creation_tokens?: number
    cache_miss_tokens?: number
    cache_hit_rate?: number | null
    cache_hit_rate_pct?: number | null
    estimated_savings_cny?: number | null
    estimated_total_cost_cny?: number | null
    estimated_full_price_cny?: number | null
    estimated_savings_usd?: number | null
    pricing_note?: string | null
    pricing_platform?: string | null
  }
}

export type ObsTimeRangeKey = '24h' | '7d' | '30d' | '90d' | 'all'

export const OBS_TIME_RANGE_OPTIONS: { key: ObsTimeRangeKey; label: string; sinceHours: number | null }[] = [
  { key: '24h', label: '近24小时', sinceHours: 24 },
  { key: '7d', label: '近7天', sinceHours: 168 },
  { key: '30d', label: '近30天', sinceHours: 720 },
  { key: '90d', label: '近90天', sinceHours: 2160 },
  { key: 'all', label: '全部', sinceHours: null },
]

export type ObsStatusFilter = 'all' | 'success' | 'warning' | 'error'

export type ObsModelDetail = Record<string, unknown>

export type ObsPaginated<T> = {
  enabled?: boolean
  items?: T[]
  total?: number
  page?: number
  page_size?: number
  pages?: number
}
