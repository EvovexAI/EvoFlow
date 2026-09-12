/**
 * Eval Center API — live Gateway only (no mock fallback).
 * Envelope: { code, data, message }
 */
import { api } from '../../../lib/tauri-api.js'

type Envelope<T> = { code?: number; data?: T; message?: string }

function unwrap<T>(raw: unknown): T {
  if (raw && typeof raw === 'object' && 'code' in (raw as object)) {
    const env = raw as Envelope<T>
    if (env.code !== 0 && env.code !== undefined) {
      throw new Error(env.message || `eval api code ${env.code}`)
    }
    return env.data as T
  }
  return raw as T
}

async function get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
  const q: Record<string, string> = {}
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') q[k] = String(v)
    }
  }
  const raw = await (api as any).evalGet(path, q)
  return unwrap<T>(raw)
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const raw = await (api as any).evalPost(path, body || {})
  return unwrap<T>(raw)
}

export const evalApi = {
  dashboardSummary: (days = 7) => get<any>('/dashboard/summary', { days }),
  dashboardTrend: (days = 7) => get<any>('/dashboard/trend', { days }),
  dashboardAlerts: (days = 7, limit = 10) => get<any>('/dashboard/alerts', { days, limit }),
  agentsRanking: (days = 7, limit = 5) => get<any>('/dashboard/agents-ranking', { days, limit }),

  businessTasks: (days = 7) => get<any>('/business/tasks', { days }),
  businessTools: (days = 7) => get<any>('/business/tools', { days }),
  businessKnowledge: (days = 7) => get<any>('/business/knowledge', { days }),
  businessConversations: (days = 7) => get<any>('/business/conversations', { days }),
  businessScenarios: () => get<any>('/business/scenarios'),
  businessIntervention: (days = 7) => get<any>('/business/intervention', { days }),

  securitySummary: (days = 7) => get<any>('/security/summary', { days }),
  securityLeaks: (days = 7) => get<any>('/security/data-leaks', { days }),
  securityVulns: () => get<any>('/security/vulnerabilities'),
  securityAudit: (days = 7) => get<any>('/security/audit-stats', { days }),
  securityScan: () => post<any>('/security/scan', {}),

  performanceSummary: (days = 7) => get<any>('/performance/summary', { days }),
  performanceLatency: (days = 7) => get<any>('/performance/latency-distribution', { days }),
  performanceErrors: (days = 7) => get<any>('/performance/error-stats', { days }),
  performanceModules: (days = 7) => get<any>('/performance/module-breakdown', { days }),

  cases: (category?: string) => get<any>('/cases', category ? { category } : undefined),
  architecture: (pack?: string) =>
    get<any>('/architecture', pack ? { pack } : undefined),
  runs: (limit = 20) => get<any>('/runs', { limit }),

  runDetail: (runId: string) => get<any>(`/run/${encodeURIComponent(runId)}`),
  runProgress: (runId: string) => get<any>(`/run/${encodeURIComponent(runId)}/progress`),
  startRun: (body: {
    name?: string
    mode?: string
    type?: string
    case_ids?: string[]
    config?: Record<string, unknown>
    async_mode?: boolean
  }) => post<any>('/run', body),
  compare: (runIds: string[]) => get<any>('/compare', { run_ids: runIds.join(',') }),

  schedules: () => get<any>('/schedules'),
  createSchedule: (body: Record<string, unknown>) => post<any>('/schedules', body),
  toggleSchedule: (id: string) => post<any>(`/schedules/${encodeURIComponent(id)}/toggle`, {}),

  alertRules: () => get<any>('/alerts/rules'),
  createAlertRule: (body: Record<string, unknown>) => post<any>('/alerts/rules', body),
  toggleAlertRule: (id: string) => post<any>(`/alerts/rules/${encodeURIComponent(id)}/toggle`, {}),
  alerts: (limit = 50) => get<any>('/alerts', { limit }),
}

export async function pollRunUntilDone(
  runId: string,
  onProgress?: (p: any) => void,
  timeoutMs = 10 * 60 * 1000,
): Promise<any> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const p = await evalApi.runProgress(runId)
    onProgress?.(p)
    const st = String(p?.status || '')
    if (st && st !== 'running' && st !== 'queued') {
      return evalApi.runDetail(runId)
    }
    await new Promise((r) => setTimeout(r, 800))
  }
  throw new Error('评测超时')
}
