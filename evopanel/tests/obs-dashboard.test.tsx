/** @vitest-environment happy-dom */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'

const fetchObsDashboard = vi.fn()
const fetchObsStatus = vi.fn()
const fetchAgents = vi.fn()

const fetchObsModelDetail = vi.fn()

vi.mock('../src/react/obs/lib/obs-api.ts', () => ({
  fetchObsDashboard: (...args: unknown[]) => fetchObsDashboard(...args),
  fetchObsStatus: (...args: unknown[]) => fetchObsStatus(...args),
  fetchObsModelDetail: (...args: unknown[]) => fetchObsModelDetail(...args),
  fetchAgents: (...args: unknown[]) => fetchAgents(...args),
  fetchObsModels: vi.fn(),
  fetchObsAgentsSummary: vi.fn().mockResolvedValue({ enabled: true, items: [] }),
  fetchObsModelsSummary: vi.fn(),
  fetchObsProvidersSummary: vi.fn(),
  fetchObsToolsSummary: vi.fn().mockResolvedValue({ enabled: true, items: [] }),
  fetchObsGatewayRoutesSummary: vi.fn(),
  fetchObsThreadsSummary: vi.fn(),
  fetchObsThreadTimeline: vi.fn(),
  fetchObsAnalyticsSummary: vi.fn().mockResolvedValue({ enabled: true, agents: [] }),
  fetchObsGatewayRequestSummary: vi.fn().mockResolvedValue({ enabled: true, request_count: 0 }),
  fetchObsInsights: vi.fn().mockResolvedValue({ enabled: true, recent_tool_errors: [] }),
  fetchObsErrorsSummary: vi.fn().mockResolvedValue({ enabled: true, by_tool_name: [] }),
  fetchObsRuntimeStatus: vi.fn().mockResolvedValue({ summary: {} }),
  getObsTimeRange: () => '7d',
  setObsTimeRange: vi.fn(),
  sinceHoursForRange: () => '168',
  checkObsEnabled: vi.fn().mockResolvedValue(true),
}))

import ObsDashboardApp from '../src/react/obs/ObsDashboardApp.tsx'

const mockBundle = {
  enabled: true,
  kpis: {
    total_requests: 115,
    success_rate: 0.992,
    avg_latency_ms: 23800,
    total_tokens: 5700000,
    deltas: {
      total_requests_pct: 0.12,
      success_rate_pts: 0.003,
      avg_latency_ms_pct: -0.18,
      total_tokens_pct: 0.08,
    },
    sparklines: {
      requests: [{ day: '2026-06-01', value: 10 }],
      success_rate: [{ day: '2026-06-01', value: 0.99 }],
      latency_ms: [{ day: '2026-06-01', value: 2000 }],
      tokens: [{ day: '2026-06-01', value: 5000 }],
    },
  },
  request_trends: [{ day: '2026-06-01', total: 10, success: 9, failed: 1 }],
  agent_health: { healthy_pct: 0.98, normal: 98, warning: 12, error: 5, total: 115 },
  model_ranking: [{
    model: 'gpt-4o',
    requests: 50,
    tokens: 10000,
    cache_read_tokens: 8200,
    cache_hit_rate_pct: 91.2,
    cost_usd: null,
  }],
  token_trends: [
    {
      day: '2026-06-01',
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      cache_read_tokens: 88,
      cache_miss_tokens: 12,
      cache_hit_rate_pct: 88.0,
      cost_usd: null,
    },
  ],
  recent_requests: [
    {
      id: 'req-1',
      status: 'success' as const,
      agent_label: '主对话Agent',
      model: 'gpt-4o',
      provider: 'openai',
      latency_ms: 2300,
      prompt_tokens: 900,
      completion_tokens: 632,
      tokens: 1532,
      occurred_at: new Date().toISOString(),
      thread_id: 't1',
      run_id: 'run-1',
      stage: 'final',
    },
  ],
  summary: {
    token_cost_usd: null,
    avg_tokens_per_request: 1200,
    tool_calls: 42,
    tool_errors: 1,
    cache_read_tokens: 125000,
    cache_creation_tokens: 8000,
    cache_miss_tokens: 15000,
    cache_hit_rate: 0.8929,
    cache_hit_rate_pct: 89.3,
    estimated_savings_cny: 0.48,
    pricing_note: '火山方舟 · 豆包2.1 Pro',
  },
  agents_summary: [
    {
      name: 'main',
      status: 'normal',
      requests: 80,
      success_rate: 99.1,
      avg_latency_ms: 2100,
      tokens: 400000,
      main_model: 'gpt-4o',
      tools: 12,
    },
  ],
  recent_tool_errors: [],
}

describe('ObsDashboardApp', () => {
  beforeEach(() => {
    fetchObsDashboard.mockResolvedValue(mockBundle)
    fetchAgents.mockResolvedValue([])
    fetchObsStatus.mockResolvedValue({ enabled: true, sqlite_path: '/tmp/test.db' })
    fetchObsModelDetail.mockResolvedValue({ id: 'req-1', model: 'gpt-4o', requested_at: new Date().toISOString() })
    document.documentElement.dataset.theme = 'dark'
  })

  it('renders dashboard header and KPI labels', async () => {
    render(<ObsDashboardApp />)
    expect(await screen.findByText('观测总览')).toBeTruthy()
    expect(await screen.findByText('模型调用')).toBeTruthy()
    expect(await screen.findByText('115')).toBeTruthy()
  })

  it('shows demo fallback banner when disabled', async () => {
    fetchObsStatus.mockResolvedValue({ enabled: false })
    fetchObsDashboard.mockResolvedValue({ enabled: false })
    render(<ObsDashboardApp />)
    expect(await screen.findByText(/观测数据未启用/)).toBeTruthy()
    expect(screen.getAllByText('模型调用').length).toBeGreaterThan(0)
  })

  it('opens drawer when clicking recent request', async () => {
    render(<ObsDashboardApp />)
    const rows = await screen.findAllByText('主对话Agent')
    const activityBtn = rows.map((el) => el.closest('button.activity-row')).find(Boolean)
    expect(activityBtn).toBeTruthy()
    fireEvent.click(activityBtn!)
    await waitFor(() => {
      expect(screen.getByText('Request Detail')).toBeTruthy()
    })
    expect(await screen.findByText('req-1')).toBeTruthy()
  })
})
