import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

describe('fetchSubtaskConversationHistory', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('prefers by-thread messages when storedSubtaskThreadId is set', async () => {
    const byThreadMsgs = [
      { id: 'm1', role: 'assistant', content: 'from by-thread' },
    ]
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/api/chat/sessions/by-thread/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ messages: byThreadMsgs, sessionKey: 'sk' }),
        }
      }
      if (u.includes('/conversation-history')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            messages: [{ id: 'legacy', role: 'assistant', content: 'from history' }],
            thread_id: 'SubThread_s1',
            outcome: { task_report: 'done', reported: true },
          }),
        }
      }
      throw new Error(`unexpected fetch ${u}`)
    })

    const { fetchSubtaskConversationHistory } = await import(
      '../src/lib/subtask-conversation-history.js'
    )
    const resp = await fetchSubtaskConversationHistory({
      mainTaskId: 'task1',
      subtaskId: 's1',
      storedSubtaskThreadId: 'SubThread_s1',
    })

    expect(resp.messages).toEqual(byThreadMsgs)
    expect(resp.thread_id).toBe('SubThread_s1')
    expect(resp.emptyConversation).toBe(false)
    const byThreadCalls = globalThis.fetch.mock.calls.filter(([u]) =>
      String(u).includes('/api/chat/sessions/by-thread/'),
    )
    expect(byThreadCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('filters legacy outcome-report fake turns', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url)
      if (u.includes('/conversation-history')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            messages: [
              { id: 'ok', role: 'assistant', content: 'real' },
              {
                id: 's1:outcome-report',
                role: 'assistant',
                content: 'final',
                source: 'subtask_outcome_report',
              },
            ],
            thread_id: null,
            outcome: { task_report: 'final', reported: true },
          }),
        }
      }
      throw new Error(`unexpected fetch ${u}`)
    })

    const { fetchSubtaskConversationHistory } = await import(
      '../src/lib/subtask-conversation-history.js'
    )
    const resp = await fetchSubtaskConversationHistory({
      mainTaskId: 'task1',
      subtaskId: 's1',
    })
    expect(resp.messages.map((m) => m.id)).toEqual(['ok'])
    expect(resp.outcome?.task_report).toBe('final')
  })
})
