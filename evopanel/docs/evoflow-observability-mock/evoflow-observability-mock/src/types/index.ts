export type Status = 'success' | 'warning' | 'failed' | 'normal' | 'error';

export type NavKey =
  | 'dashboard'
  | 'requests'
  | 'agents'
  | 'models'
  | 'tools'
  | 'gateway'
  | 'trace'
  | 'analytics'
  | 'eval-dashboard'
  | 'eval-business'
  | 'eval-security'
  | 'eval-performance'
  | 'eval-history'
  | 'eval-schedule'
  | 'eval-alert'
  | 'settings';

export interface TimePoint {
  label: string;
  total: number;
  success: number;
  failed: number;
  warning?: number;
  prompt?: number;
  completion?: number;
  cost?: number;
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
  agent: string;
  model: string;
  provider: string;
  latency: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  tokens: number;
  cost: number;
  threadId: string;
  runId: string;
  stage: string;
  error?: string;
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
  status: 'success' | 'warning' | 'failed';
  meta: string;
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

/* ---------- 评测中心 Evaluation Center ---------- */

export interface EvalSummary {
  healthScore: number;
  taskCompletionRate: number;
  securityScore: number;
  avgLatency: string;
  toolSuccessRate: number;
  activeAgents: number;
}

export interface TaskQualityStats {
  totalTasks: number;
  completionRate: number;
  failureRate: number;
  humanInterventionRate: number;
}

export interface ToolReliabilityStats {
  name: string;
  category: string;
  calls: number;
  successRate: number;
  avgLatency: string;
  p95Latency: string;
  failureRate: number;
}

export interface AgentRankingItem {
  rank: number;
  name: string;
  score: number;
  tasks: number;
  successRate: number;
  status: 'normal' | 'warning' | 'error';
}

export interface AlertItem {
  id: string;
  level: 'high' | 'medium' | 'low';
  title: string;
  type: string;
  time: string;
}

export interface EvalHistoryItem {
  id: string;
  name: string;
  scope: string;
  score: number;
  status: 'success' | 'warning' | 'failed';
  startedAt: string;
  duration: string;
}

/* ---------- 评测中心 Phase 2 ---------- */

export type DataSource = 'live' | 'demo';

export interface ApiEnvelope<T = unknown> {
  code: number;
  data: T;
  message: string;
  dataSource?: DataSource;
}

/* 安全中心 */
export type VulnLevel = 'high' | 'medium' | 'low';
export type VulnStatus = 'pending' | 'processing' | 'resolved' | 'ignored';

export interface SecuritySummary {
  score: number;
  highVulns: number;
  pendingFixes: number;
  highNew: number;
  pendingNew: number;
  lastScan: string;
}

export interface Vulnerability {
  id: string;
  level: VulnLevel;
  name: string;
  scope: string;
  foundAt: string;
  status: VulnStatus;
  category: string;
}

export interface PermissionMatrix {
  roles: string[];
  actions: string[];
  matrix: Record<string, Record<string, 'allow' | 'deny' | 'warn'>>;
}

export interface DataLeak {
  id: string;
  type: string;
  severity: VulnLevel;
  source: string;
  description: string;
  foundAt: string;
  status: VulnStatus;
}

export interface SecurityAuditEvent {
  id: string;
  level: VulnLevel | 'info';
  message: string;
  time: string;
}

/* 性能基准 */
export interface PerformanceSummary {
  p50: number;
  p95: number;
  p99: number;
  peakQps: number;
  p50Delta: number;
  p95Delta: number;
  p99Delta: number;
  qpsDelta: number;
  lastTest: string;
}

export interface LatencyBucket {
  label: string;
  count: number;
}

export interface LatencyTrendPoint {
  label: string;
  p50: number;
  p95: number;
  p99: number;
}

export interface ModuleLatency {
  module: string;
  latency: number;
  p95: number;
}

export interface VersionCompareItem {
  version: string;
  p95: number;
  delta: number;
}

export interface ErrorStats {
  total: number;
  errorRate: number;
  byType: Array<{ type: string; count: number }>;
}

/* 评测管理 */
export type EvalRunStatus = 'pending' | 'running' | 'completed' | 'failed';
export type EvalType = 'smoke' | 'full' | 'security' | 'performance' | 'custom';

export interface EvalRun {
  id: string;
  name: string;
  type: EvalType;
  status: EvalRunStatus;
  passRate: number;
  duration: string;
  executedAt: string;
  progress?: number;
}

export interface EvalDimension {
  name: string;
  score: number;
  status: 'success' | 'warning' | 'failed';
}

export interface EvalCaseResult {
  id: string;
  name: string;
  category: string;
  status: 'success' | 'warning' | 'failed';
  message?: string;
}

export interface EvalRunDetail {
  id: string;
  name: string;
  type: EvalType;
  status: EvalRunStatus;
  passRate: number;
  duration: string;
  startedAt: string;
  triggeredBy: string;
  dimensions: EvalDimension[];
  cases: EvalCaseResult[];
}

export interface EvalCase {
  id: string;
  name: string;
  category: string;
  level: string;
  description: string;
  severity: string;
  enabled: boolean;
}

/* 评测计划 & 告警 */
export interface EvalSchedule {
  id: string;
  name: string;
  type: EvalType;
  frequency: string;
  nextRun: string;
  enabled: boolean;
  lastRun?: string;
}

export interface AlertRule {
  id: string;
  name: string;
  metric: string;
  condition: string;
  threshold: string;
  severity: 'critical' | 'warning' | 'info';
  channels: string;
  enabled: boolean;
}
