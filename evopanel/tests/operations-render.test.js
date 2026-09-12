import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/lib/tauri-api.js', () => ({
  api: {
    observabilityOverview: vi.fn().mockResolvedValue({
      thread_count: 1,
      tool_invocations: 10,
      model_invocations: 5,
      tool_error_rate: 0.1,
      total_tokens: { total: 100, input: 60, output: 40 },
      model_latency_p95_ms: 500,
    }),
    observabilityWaterfallSummary: vi.fn().mockResolvedValue({ sampled_threads: 2 }),
    observabilityTrends: vi.fn().mockResolvedValue({
      tool_daily: [{ day: '2026-06-12', tool_calls: 5, tool_errors: 0 }],
      model_daily: [{ day: '2026-06-12', model_calls: 3 }],
    }),
    observabilityReport: vi.fn().mockResolvedValue({ recommendations: [] }),
    observabilityInsights: vi.fn().mockResolvedValue({ recent_tool_errors: [] }),
    observabilityErrorsSummary: vi.fn().mockResolvedValue({ by_error_type: [] }),
  },
}))

describe('operations page', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="content"></div>'
  })

  it('render() returns shell layout with side nav', async () => {
    const mod = await import('../src/pages/operations.js')
    const page = await mod.render()
    expect(page).toBeInstanceOf(HTMLElement)
    expect(page.querySelector('#ops-shell-mount')).toBeTruthy()
    expect(page.querySelector('#obs-side-nav')).toBeTruthy()
    expect(page.querySelector('#obs-main-panel')).toBeTruthy()
  })
})
