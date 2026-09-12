import type {
  AlertRule,
  ApiEnvelope,
  DataLeak,
  DataSource,
  EvalCase,
  EvalRun,
  EvalRunDetail,
  EvalSchedule,
  LatencyBucket,
  LatencyTrendPoint,
  ModuleLatency,
  PermissionMatrix,
  PerformanceSummary,
  SecurityAuditEvent,
  SecuritySummary,
  VersionCompareItem,
  Vulnerability
} from '../types';
import {
  alertRules,
  dataLeaks,
  errorStats,
  evalCases,
  evalRunDetail,
  evalRuns,
  evalSchedules,
  failureReasons,
  latencyDistribution,
  latencyTrend,
  moduleLatency,
  permissionMatrix,
  performanceSummary,
  securityAuditEvents,
  securitySummary,
  taskQualityStats,
  taskTrend as mockTaskTrendData,
  toolReliabilityStats,
  toolTrend as mockToolTrendData,
  versionCompare,
  vulnerabilities
} from '../data/mock';

/**
 * 评测中心 API 层。
 *
 * 统一信封：{ code, data, message }。
 * 优雅降级：先尝试真实 API，失败（网络 / 404 / 非 0 code）时 fallback 到本地 mock，
 * 并在返回值中标注 dataSource: 'live' | 'demo'，供页面显示「演示数据/真实数据」角标。
 */

const BASE_URL = '/api/eval';

/* ------------------------------------------------------------------ */
/* 类型工具                                                           */
/* ------------------------------------------------------------------ */

export interface ApiResult<T> {
  data: T;
  dataSource: DataSource;
}

const LIVE: DataSource = 'live';
const DEMO: DataSource = 'demo';

/** 尝试调用真实 API；若请求失败或后端返回非 0 code，抛出错误以触发 fallback。 */
async function tryFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, init);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const json = (await res.json()) as ApiEnvelope<T>;
  if (json.code !== 0) {
    throw new Error(json.message || `code ${json.code}`);
  }
  return json.data;
}

/**
 * 带降级的 GET 包装器：先请求真实 API，失败则返回本地 mock。
 * mockFn 返回 { data, dataSource: 'demo' }。
 */
async function safeGet<T>(path: string, mock: () => T, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const data = await tryFetch<T>(path, init);
    return { data, dataSource: LIVE };
  } catch {
    return { data: mock(), dataSource: DEMO };
  }
}

/**
 * 带降级的写操作包装器：真实 API 失败时模拟成功（返回 { ok: true } 或 mock 结果），
 * 让界面在无后端时也能正常交互。
 */
async function safePost<T>(path: string, body: unknown, mock: () => T): Promise<ApiResult<T>> {
  try {
    const data = await tryFetch<T>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {})
    });
    return { data, dataSource: LIVE };
  } catch {
    return { data: mock(), dataSource: DEMO };
  }
}

/* ------------------------------------------------------------------ */
/* 健康总览                                                           */
/* ------------------------------------------------------------------ */

export interface DashboardSummary {
  healthScore: number;
  taskCompletionRate: number;
  securityScore: number;
  avgLatencyMs: number;
  toolSuccessRate: number;
  activeAgents: number;
  dimensionScores: Record<string, number>;
  alerts: Array<{ level: string; message: string; timestamp: string }>;
  agentsRanking: Array<{ agent: string; tasks: number; done: number; completionRate: number }>;
  recentEvaluations: Array<{ id: string; dimension: string; score: number; status: string; timestamp: string }>;
}

export interface DashboardTrend {
  series: Array<{ date: string; healthScore: number; business: number; performance: number; tasks: number }>;
}

export interface DashboardAlert {
  level: string;
  message: string;
  timestamp: string;
}

function mockDashboardSummary(): DashboardSummary {
  return {
    healthScore: 86,
    taskCompletionRate: 0.853,
    securityScore: 72,
    avgLatencyMs: 2800,
    toolSuccessRate: 0.967,
    activeAgents: 5,
    dimensionScores: { business: 88, performance: 92, security: 72, stability: 85 },
    alerts: [
      { level: 'high', message: 'SummarizeAgent 成功率跌破 92%，接近服务降级阈值', timestamp: '10 分钟前' },
      { level: 'medium', message: 'code_interpreter P95 延迟 7.1s，超出 SLO 2.5 倍', timestamp: '35 分钟前' },
      { level: 'low', message: '本地 Llama 节点 GPU 繁忙', timestamp: '1 小时前' }
    ],
    agentsRanking: [
      { agent: 'ResearchAgent', tasks: 28430, done: 28117, completionRate: 0.989 },
      { agent: 'TranslateAgent', tasks: 10922, done: 10824, completionRate: 0.991 },
      { agent: 'DataAnalyst', tasks: 22104, done: 21684, completionRate: 0.981 }
    ],
    recentEvaluations: [
      { id: 'eval_240601', dimension: '综合健康', score: 86, status: 'ok', timestamp: '2025-06-01 02:00' },
      { id: 'eval_240525', dimension: '业务质量', score: 91, status: 'ok', timestamp: '2025-05-25 09:30' }
    ]
  };
}

function mockDashboardTrend(): DashboardTrend {
  return {
    series: [
      { date: '6/1', healthScore: 82, business: 84, performance: 86, tasks: 12 },
      { date: '6/2', healthScore: 84, business: 86, performance: 88, tasks: 15 },
      { date: '6/3', healthScore: 85, business: 88, performance: 90, tasks: 14 },
      { date: '6/4', healthScore: 86, business: 89, performance: 91, tasks: 18 },
      { date: '6/5', healthScore: 87, business: 90, performance: 92, tasks: 16 }
    ]
  };
}

function mockDashboardAlerts(): DashboardAlert[] {
  return mockDashboardSummary().alerts;
}

function mockAgentsRanking(): DashboardSummary['agentsRanking'] {
  return mockDashboardSummary().agentsRanking;
}

export const getDashboardSummary = (days: number) => safeGet<DashboardSummary>(`/dashboard/summary?days=${days}`, mockDashboardSummary);
export const getDashboardTrend = (days: number) => safeGet<DashboardTrend>(`/dashboard/trend?days=${days}`, mockDashboardTrend);
export const getDashboardAlerts = (days: number, limit: number) => safeGet<DashboardAlert[]>(`/dashboard/alerts?days=${days}&limit=${limit}`, mockDashboardAlerts);
export const getAgentsRanking = (days: number, limit: number) => safeGet<DashboardSummary['agentsRanking']>(`/dashboard/agents-ranking?days=${days}&limit=${limit}`, mockAgentsRanking);

/* ------------------------------------------------------------------ */
/* 业务质量                                                           */
/* ------------------------------------------------------------------ */

export interface TaskStats {
  total: number;
  done: number;
  failed: number;
  completionRate: number;
  failureRate: number;
  duration: { p50: number; p95: number; p99: number; avg: number };
  failureReasons: Array<{ reason: string; count: number }>;
}

export interface TaskTrendPoint {
  date: string;
  total: number;
  done: number;
  completionRate: number;
}

export interface ToolStatsItem {
  tool: string;
  calls: number;
  success: number;
  fail: number;
  successRate: number;
  avgDurationMs: number;
}

export interface ToolTrendPoint {
  date: string;
  calls: number;
}

export interface KnowledgeStats {
  knowledgeBases: number;
  documents: number;
  retrievals: number;
}

export interface ConversationStats {
  sessions: number;
  messages: number;
  activeUsers: number;
  messagesPerSession: number;
}

function mockTaskStats(): TaskStats {
  return {
    total: taskQualityStats.totalTasks,
    done: Math.round(taskQualityStats.totalTasks * (taskQualityStats.completionRate / 100)),
    failed: Math.round(taskQualityStats.totalTasks * (taskQualityStats.failureRate / 100)),
    completionRate: taskQualityStats.completionRate / 100,
    failureRate: taskQualityStats.failureRate / 100,
    duration: { p50: 1.8, p95: 6.4, p99: 11.2, avg: 3.2 },
    failureReasons: failureReasons.map((r) => ({ reason: r.label, count: r.value }))
  };
}

function buildTaskTrend(): TaskTrendPoint[] {
  return mockTaskTrendData.map((p) => ({ date: p.label, total: p.completed + p.failed, done: p.completed, completionRate: p.completed / (p.completed + p.failed) }));
}

function mockToolStats(): ToolStatsItem[] {
  return toolReliabilityStats.map((t) => ({
    tool: t.name,
    calls: t.calls,
    success: Math.round(t.calls * (t.successRate / 100)),
    fail: Math.round(t.calls * (t.failureRate / 100)),
    successRate: t.successRate / 100,
    avgDurationMs: 0
  }));
}

function buildToolTrend(): ToolTrendPoint[] {
  return mockToolTrendData.map((p) => ({ date: p.label, calls: p.web_search }));
}

function mockKnowledgeStats(): KnowledgeStats {
  return { knowledgeBases: 3, documents: 86, retrievals: 1280 };
}

function mockConversationStats(): ConversationStats {
  return { sessions: 320, messages: 4210, activeUsers: 24, messagesPerSession: 13.2 };
}

export const getTaskStats = (days: number) => safeGet<TaskStats>(`/business/tasks?days=${days}`, mockTaskStats);
export const getTaskTrend = (days: number) => safeGet<TaskTrendPoint[]>(`/business/tasks/trend?days=${days}`, buildTaskTrend);
export const getToolStats = (days: number) => safeGet<ToolStatsItem[]>(`/business/tools?days=${days}`, mockToolStats);
export const getToolTrend = (days: number) => safeGet<ToolTrendPoint[]>(`/business/tools/trend?days=${days}`, buildToolTrend);
export const getKnowledgeStats = (days: number) => safeGet<KnowledgeStats>(`/business/knowledge?days=${days}`, mockKnowledgeStats);
export const getConversationStats = (days: number) => safeGet<ConversationStats>(`/business/conversations?days=${days}`, mockConversationStats);

/* ------------------------------------------------------------------ */
/* 安全中心                                                           */
/* ------------------------------------------------------------------ */

const securityMock = {
  summary: (): SecuritySummary => securitySummary,
  vulnerabilities: (): Vulnerability[] => vulnerabilities,
  permissionMatrix: (): PermissionMatrix => permissionMatrix as PermissionMatrix,
  dataLeaks: (): DataLeak[] => dataLeaks,
  auditStats: (): SecurityAuditEvent[] => securityAuditEvents
};

export const getSecuritySummary = (days: number) => safeGet<SecuritySummary>(`/security/summary?days=${days}`, securityMock.summary);
export const getPermissionMatrix = () => safeGet<PermissionMatrix>(`/security/permission-matrix`, securityMock.permissionMatrix);
export const getDataLeaks = (days: number) => safeGet<DataLeak[]>(`/security/data-leaks?days=${days}`, securityMock.dataLeaks);
export const getVulnerabilities = (params: { severity?: string; limit?: number } = {}) => {
  const qs = new URLSearchParams();
  if (params.severity) qs.set('severity', params.severity);
  if (params.limit) qs.set('limit', String(params.limit));
  const q = qs.toString() ? `?${qs.toString()}` : '';
  return safeGet<Vulnerability[]>(`/security/vulnerabilities${q}`, securityMock.vulnerabilities);
};
export const getAuditStats = (days: number) => safeGet<SecurityAuditEvent[]>(`/security/audit-stats?days=${days}`, securityMock.auditStats);
export const runSecurityScan = () => safePost<{ ok: boolean; message: string }>('/security/scan', {}, () => ({ ok: true, message: '扫描已触发（演示模式）' }));

/* ------------------------------------------------------------------ */
/* 性能基准                                                           */
/* ------------------------------------------------------------------ */

const performanceMock = {
  summary: (): PerformanceSummary => performanceSummary,
  latencyDistribution: (): LatencyBucket[] => latencyDistribution,
  latencyTrend: (): LatencyTrendPoint[] => latencyTrend,
  moduleBreakdown: (): ModuleLatency[] => moduleLatency,
  errorStats: () => errorStats
};

export const getPerformanceSummary = (days: number) => safeGet<PerformanceSummary>(`/performance/summary?days=${days}`, performanceMock.summary);
export const getLatencyDistribution = (days: number) => safeGet<LatencyBucket[]>(`/performance/latency-distribution?days=${days}`, performanceMock.latencyDistribution);
export const getLatencyTrend = (days: number) => safeGet<LatencyTrendPoint[]>(`/performance/trend?days=${days}`, performanceMock.latencyTrend);
export const getModuleBreakdown = (days: number) => safeGet<ModuleLatency[]>(`/performance/module-breakdown?days=${days}`, performanceMock.moduleBreakdown);
export const getErrorStats = (days: number) => safeGet<typeof errorStats>(`/performance/error-stats?days=${days}`, performanceMock.errorStats);
export const getVersionCompare = () => safeGet<VersionCompareItem[]>(`/performance/version-compare`, () => versionCompare);
export const runLoadTest = (config: Record<string, unknown>) =>
  safePost<{ ok: boolean; taskId: string }>('/performance/run-load-test', config, () => ({ ok: true, taskId: 'lt_mock' }));

/* ------------------------------------------------------------------ */
/* 评测管理                                                           */
/* ------------------------------------------------------------------ */

const evalMock = {
  runs: (): EvalRun[] => evalRuns,
  runDetail: (): EvalRunDetail => evalRunDetail,
  cases: (): EvalCase[] => evalCases
};

export const runEval = (data: { name: string; type: string; case_ids?: string[]; config?: unknown }) =>
  safePost<{ id: string }>('/run', data, () => ({ id: `eval_${Date.now()}` }));

export const listEvalRuns = (params: { limit?: number; type?: string; status?: string } = {}) => {
  const qs = new URLSearchParams();
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.type) qs.set('type', params.type);
  if (params.status) qs.set('status', params.status);
  const q = qs.toString() ? `?${qs.toString()}` : '';
  return safeGet<EvalRun[]>(`/runs${q}`, evalMock.runs);
};

export const getEvalRun = (id: string) => safeGet<EvalRunDetail>(`/run/${id}`, evalMock.runDetail);
export const getEvalProgress = (id: string) => safeGet<{ progress: number; status: string }>(`/run/${id}/progress`, () => ({ progress: 60, status: 'running' }));
export const rerunEval = (id: string) => safePost<{ ok: boolean }>(`/run/${id}/re-run`, {}, () => ({ ok: true }));
export const compareEvals = (runIds: string[]) => {
  const qs = new URLSearchParams();
  qs.set('run_ids', runIds.join(','));
  return safeGet<unknown>(`/compare?${qs.toString()}`, () => ({ runIds, note: '演示对比数据' }));
};
export const listEvalCases = (params: { category?: string; level?: string } = {}) => {
  const qs = new URLSearchParams();
  if (params.category) qs.set('category', params.category);
  if (params.level) qs.set('level', params.level);
  const q = qs.toString() ? `?${qs.toString()}` : '';
  return safeGet<EvalCase[]>(`/cases${q}`, evalMock.cases);
};

/* ------------------------------------------------------------------ */
/* 评测计划 & 告警                                                    */
/* ------------------------------------------------------------------ */

export const listSchedules = () => safeGet<EvalSchedule[]>('/schedules', () => evalSchedules);
export const createSchedule = (data: unknown) => safePost<{ ok: boolean }>('/schedules', data, () => ({ ok: true }));
export const toggleSchedule = (id: string) => safePost<{ ok: boolean }>(`/schedules/${id}/toggle`, {}, () => ({ ok: true }));

export const listAlertRules = () => safeGet<AlertRule[]>('/alerts/rules', () => alertRules);
export const createAlertRule = (data: unknown) => safePost<{ ok: boolean }>('/alerts/rules', data, () => ({ ok: true }));
export const toggleAlertRule = (id: string) => safePost<{ ok: boolean }>(`/alerts/rules/${id}/toggle`, {}, () => ({ ok: true }));
