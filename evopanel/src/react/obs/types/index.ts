export type Status = 'success' | 'warning' | 'failed' | 'normal' | 'error';

export type NavKey =
  | 'dashboard'
  | 'requests'
  | 'agents'
  | 'models'
  | 'tools'
  | 'tool-calls'
  | 'mcp'
  | 'gateway'
  | 'trace'
  | 'analytics'
  | 'settings'
  | 'code-index';

export interface TimePoint {
  label: string;
  total: number;
  success: number;
  failed: number;
  warning?: number;
  prompt?: number;
  completion?: number;
  cost?: number;
  cacheRead?: number;
  cacheHitRatePct?: number | null;
}

export interface Metric {
  title: string;
  value: string;
  delta: string;
  trend: 'up' | 'down' | 'neutral' | 'bad';
  icon: string;
  accent: 'blue' | 'green' | 'purple' | 'orange' | 'cyan' | 'red';
  data: number[];
}

export interface RequestRecord {
  id: string;
  status: 'success' | 'warning' | 'failed';
  time: string;
  relativeTime: string;
  /** Raw ISO timestamp from observability (for clock display / sort) */
  occurredAt?: string;
  agent: string;
  model: string;
  provider: string;
  latency: string;
  latencyMs: number;
  /** Wall-clock to next model call in same thread (ms); 0 if last/unknown */
  totalCycleMs?: number;
  /** Formatted total cycle duration */
  totalCycle?: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheMissTokens?: number;
  tokens: number;
  cost: number;
  /** Estimated per-request cost (CNY) from observability pricing rules. */
  estimatedCostCny?: number;
  threadId: string;
  runId: string;
  stage: string;
  /** Reply kind: 'text', 'tool_call', 'error', etc. */
  replyKind?: string;
  /** Messages in vendor_request.messages for this HTTP call */
  payloadMessageCount?: number;
  /** 1-based index of this model call within the same run_id */
  modelCallSeq?: number;
  /** @deprecated use payloadMessageCount */
  contextTurns?: number;
  /** Failure reason — only for failed / warning invocations */
  failureMessage?: string;
  /** Normal assistant reply preview */
  replyPreview?: string;
  /** Human-readable thinking level */
  thinkingLabel?: string;
  reasoningEffort?: string | null;
  thinkingType?: string | null;
  thinkingBudgetTokens?: number | null;
  sessionMode?: string | null;
  region: string;
}

export interface AgentRecord {
  name: string;
  status: 'normal' | 'warning' | 'error';
  requests: number;
  successRate: number;
  avgLatency: string;
  tokens: string;
  mainModel: string;
  tools: number;
  owner: string;
}

export interface ModelRecord {
  model: string;
  provider: string;
  requests: number;
  successRate: number;
  avgLatency: string;
  p95Latency: string;
  promptTokens: string;
  completionTokens: string;
  tokens: string;
  tokensNum: number;
  cacheReadTokens: string;
  cacheReadNum: number;
  cacheHitRate: string;
  estimatedSavingsCny: string;
  cost: number;
  errorRate: number;
  mainAgents: string[];
}

export interface ProviderRecord {
  name: string;
  status: 'normal' | 'warning' | 'error';
  requests: number;
  successRate: number;
  avgLatency: string;
  tokens: string;
  cacheReadTokens: string;
  cacheHitRate: string;
  estimatedSavingsCny: string;
  cost: number;
  errors: string;
}

export interface ToolRecord {
  name: string;
  category: string;
  requests: number;
  successRate: number;
  avgLatency: string;
  p95Latency: string;
  failureRate: number;
  mainAgent: string;
}

export interface ToolCallRecord {
  id: string;
  time: string;
  toolName: string;
  agent: string;
  requestId: string;
  traceId: string;
  status: 'success' | 'failed' | 'warning';
  latency: string;
  input: string;
  output: string;
  error?: string;
}

export interface GatewayRoute {
  route: string;
  method: string;
  requests: number;
  avgLatency: string;
  p95Latency: string;
  status2xx: number;
  status4xx: number;
  status5xx: number;
  rateLimited: number;
  upstream: string;
}

export interface TraceStep {
  id: string;
  type: string;
  title: string;
  duration: string;
  durationMs?: number;
  status: 'success' | 'warning' | 'failed';
  statusRaw?: string;
  meta: string;
  tsMs?: number;
  endedMs?: number;
}

export interface TraceRecord {
  id: string;
  threadId: string;
  agent: string;
  duration: string;
  steps: number;
  status: 'success' | 'warning' | 'failed';
  startedAt: string;
  summary: string;
  items: TraceStep[];
}
