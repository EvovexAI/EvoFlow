import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/lib/tauri-api.js', () => {
  const chatHistory = vi.fn()
  const chatSessionsCreate = vi.fn(async () => ({}))
  const chatSend = vi.fn(async () => ({}))
  return {
    api: { chatHistory, chatSessionsCreate, chatSend },
  }
})

vi.mock('../src/lib/ws-client.js', () => ({
  wsClient: {
    updateSessionContext: vi.fn(async () => {}),
    onEvent: vi.fn(() => () => {}),
  },
}))

import { api } from '../src/lib/tauri-api.js'
import { wsClient } from '../src/lib/ws-client.js'
import {
  extractHistoryAssistantText,
  loadLatestDeptMemberReply,
  runDeptMemberWorkTurn,
} from '../src/react/lib/dept-member-work-session.ts'

describe('dept-member-work-session history extract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads assistant text from content_json.content', () => {
    expect(
      extractHistoryAssistantText({
        role: 'assistant',
        content: '',
        content_json: { content: '群里直接回复进度' },
      }),
    ).toBe('群里直接回复进度')
  })

  it('skips non-assistant rows', () => {
    expect(
      extractHistoryAssistantText({
        role: 'user',
        content: 'hello',
      }),
    ).toBe('')
  })

  it('loadLatestDeptMemberReply picks newest assistant', async () => {
    api.chatHistory.mockResolvedValue({
      messages: [
        { role: 'user', content: 'ping' },
        { role: 'assistant', content_json: { content: '旧回复' } },
        { role: 'assistant', content: '最新回复' },
      ],
    })
    await expect(loadLatestDeptMemberReply('proactive:a:chat:dept-x')).resolves.toBe(
      '最新回复',
    )
  })

  it('steward turn keeps rules/roster in session ctx; user text is slim', async () => {
    api.chatSessionsCreate.mockResolvedValue({})
    api.chatSend.mockResolvedValue({})
    wsClient.onEvent.mockReturnValue(() => {})
    wsClient.updateSessionContext.mockResolvedValue({})

    await runDeptMemberWorkTurn({
      deptId: 'rd',
      deptName: '研发部',
      agentCode: 'xiaomi',
      roleName: '小V',
      text: '群里有谁啊',
      groupContext: '用户：哈喽\n小V：收到',
      stewardMode: true,
      roster: [
        { agent_code: 'cto', role_name: '技术总监' },
        { agent_code: 'qa', role_name: '测试工程师' },
      ],
    })

    const ctx = api.chatSessionsCreate.mock.calls[0][1].context
    expect(ctx.dept_group_im).toBe(true)
    expect(ctx.dept_group_steward).toBe(true)
    expect(ctx.dept_group_roster).toEqual(['技术总监', '测试工程师'])

    const userText = api.chatSend.mock.calls[0][1]
    expect(userText).toContain('<dept_group_turn')
    expect(userText).toContain('<dept_group_recent')
    expect(userText).toContain('用户：哈喽')
    expect(userText).toContain('<dept_group_instruction')
    expect(userText).toContain('群里有谁啊')
    expect(userText).toContain('<dept_group_hint')
    expect(userText).not.toContain('硬规则')
    expect(userText).not.toContain('本群可点名')
    expect(userText).not.toContain('禁止 Markdown')
    expect(userText).not.toContain('【群近期】')
  })
})


describe('dept-member-work-session detached turn', () => {
  const opts = { deptId: 'design', agentCode: 'xiaomi', text: '请查图纸' }
  const sk = 'proactive:xiaomi:chat:dept-design'
  let listener, unsubscribe, rows, state
  const emit = (payload) => listener({ type: 'event', event: 'chat', payload: { sessionKey: sk, runId: 'current', ...payload } })
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetAllMocks()
    rows = [{ seq: 1, role: 'assistant', runId: 'old', content: '旧回复 @设计师' }]
    state = { runId: 'current', status: 'running', executing: true }
    unsubscribe = vi.fn()
    api.chatHistory.mockImplementation(async () => ({ messages: [...rows] }))
    api.chatSessionsCreate.mockResolvedValue({})
    api.chatSend.mockResolvedValue({ ok: true, runId: 'current', awaitingV4: true })
    wsClient.getSessionRunStatus = vi.fn(async () => state)
    wsClient.onEvent.mockImplementation((cb) => { listener = cb; return unsubscribe })
  })
  afterEach(() => vi.useRealTimers())

  it('keeps listening after send handoff and returns this run and its handoffs', async () => {
    let settled = false
    const turn = runDeptMemberWorkTurn(opts).then((r) => { settled = true; return r })
    await vi.advanceTimersByTimeAsync(1500)
    expect(settled).toBe(false)
    expect(unsubscribe).not.toHaveBeenCalled()
    emit({ state: 'tool_result', result: { handlers: [{ agent_code: 'designer', content: '查图纸' }] } })
    emit({ state: 'final', message: { content: '@设计师 请接手' } })
    state = { runId: 'current', status: 'done', executing: false }
    await vi.advanceTimersByTimeAsync(1500)
    expect(await turn).toEqual({ text: '@设计师 请接手', handoffs: [{ agentCode: 'designer', content: '查图纸' }] })
    expect(api.chatSend).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('recovers current-run history when V4 emits no legacy chat events', async () => {
    const turn = runDeptMemberWorkTurn(opts)
    await vi.advanceTimersByTimeAsync(1500)
    rows.push({ seq: 2, role: 'assistant', run_id: 'current', content: '处理中' })
    await vi.advanceTimersByTimeAsync(1500)
    rows.push({ seq: 3, role: 'tool', run_id: 'current', content: JSON.stringify({ handlers: [{ agent_code: 'designer', content: '接手' }] }) })
    rows.push({ seq: 4, role: 'assistant', run_id: 'current', content_json: { content: '本轮最终回复 @设计师' } })
    state = { runId: 'current', status: 'done', executing: false }
    await vi.advanceTimersByTimeAsync(1500)
    expect(await turn).toEqual({ text: '本轮最终回复 @设计师', handoffs: [{ agentCode: 'designer', content: '接手' }] })
    expect(api.chatSend).toHaveBeenCalledTimes(1)
  })

  it('ignores a final from another run in the sticky session', async () => {
    const turn = runDeptMemberWorkTurn(opts)
    await vi.advanceTimersByTimeAsync(1500)
    emit({ runId: 'old', state: 'final', message: { content: '过期回复' } })
    emit({ state: 'final', message: { content: '本轮回复' } })
    state = { runId: 'current', status: 'done', executing: false }
    await vi.advanceTimersByTimeAsync(1500)
    expect((await turn).text).toBe('本轮回复')
  })

  it('propagates send failure instead of returning an old reply', async () => {
    api.chatSend.mockResolvedValue({ ok: false, error: 'send failed' })
    await expect(runDeptMemberWorkTurn(opts)).rejects.toThrow('send failed')
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('stops waiting on cancellation without re-posting', async () => {
    const signal = { aborted: false }
    const turn = runDeptMemberWorkTurn({ ...opts, signal })
    await vi.advanceTimersByTimeAsync(1500)
    signal.aborted = true
    await vi.advanceTimersByTimeAsync(1500)
    expect((await turn).text).toBe('')
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(api.chatSend).toHaveBeenCalledTimes(1)
  })

  it('waits for history persistence after the run reports done', async () => {
    state = { runId: 'current', status: 'done', executing: false }
    let settled = false
    const turn = runDeptMemberWorkTurn(opts).then((r) => { settled = true; return r })
    await vi.advanceTimersByTimeAsync(750)
    expect(settled).toBe(false)
    rows.push({ seq: 2, role: 'assistant', run_id: 'current', content: '稍后落库的正文' })
    await vi.advanceTimersByTimeAsync(750)
    expect((await turn).text).toBe('稍后落库的正文')
  })

  it('does not return old text when this run completes without a body', async () => {
    state = { runId: 'current', status: 'done', executing: false }
    const turn = runDeptMemberWorkTurn(opts)
    await vi.advanceTimersByTimeAsync(2250)
    expect(await turn).toEqual({ text: '', handoffs: [] })
  })

  it('does not dispatch intermediate text before the run finishes', async () => {
    let settled = false
    const turn = runDeptMemberWorkTurn(opts).then((r) => { settled = true; return r })
    await vi.advanceTimersByTimeAsync(750)
    rows.push({ seq: 2, role: 'assistant', run_id: 'current', content: '@设计师 临时说明' })
    await vi.advanceTimersByTimeAsync(2250)
    expect(settled).toBe(false)
    rows.push({ seq: 3, role: 'assistant', run_id: 'current', content: '最终回复' })
    state = { runId: 'current', status: 'done', executing: false }
    await vi.advanceTimersByTimeAsync(750)
    expect((await turn).text).toBe('最终回复')
  })

  it('propagates backend failure and cleans up the listener', async () => {
    state = { runId: 'current', status: 'failed', executing: false }
    await expect(runDeptMemberWorkTurn(opts)).rejects.toThrow('failed')
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('bounds a detached run with unknown status without sending again', async () => {
    state = { runId: null, status: 'idle', executing: false }
    const turn = runDeptMemberWorkTurn(opts)
    const checked = expect(turn).rejects.toThrow('等待本轮回复超时')
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 750)
    await checked
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(api.chatSend).toHaveBeenCalledTimes(1)
  })

  it('preserves normal streamed replies without polling for a detached run', async () => {
    api.chatSend.mockImplementation(async () => {
      emit({ state: 'delta', delta: '正常回复' })
      emit({ state: 'final', message: { content: '正常回复' } })
      return { ok: true, runId: 'current' }
    })
    expect((await runDeptMemberWorkTurn(opts)).text).toBe('正常回复')
    expect(wsClient.getSessionRunStatus).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })


  it('does not let an old completion mask the current run status', async () => {
    state = { runId: 'current', status: 'done', executing: false, recently_completed_run_id: 'old', recently_completed_status: 'done' }
    api.chatSend.mockImplementation(async () => {
      rows.push({ seq: 2, role: 'assistant', run_id: 'current', content: '本轮回复' })
      return { ok: true, runId: 'current', awaitingV4: true }
    })
    expect((await runDeptMemberWorkTurn(opts)).text).toBe('本轮回复')
  })

  it('discards stale events received before the handoff identifies the run', async () => {
    api.chatSend.mockImplementation(async () => {
      emit({ runId: 'old', state: 'final', message: { content: '迟到的旧回复' } })
      return { ok: true, runId: 'current', awaitingV4: true }
    })
    let settled = false
    const turn = runDeptMemberWorkTurn(opts).then((r) => { settled = true; return r })
    await vi.advanceTimersByTimeAsync(1500)
    expect(settled).toBe(false)
    emit({ state: 'final', message: { content: '本轮回复' } })
    await vi.advanceTimersByTimeAsync(750)
    expect((await turn).text).toBe('本轮回复')
  })


  it('requires the handed-off run id for history and events, even after the baseline', async () => {
    const turn = runDeptMemberWorkTurn(opts)
    await vi.advanceTimersByTimeAsync(750)
    rows.push({ seq: 2, role: 'assistant', content: '无法归属本轮的回复' })
    emit({ runId: undefined, state: 'final', message: { content: '无法归属的事件' } })
    state = { runId: 'current', status: 'done', executing: false }
    await vi.advanceTimersByTimeAsync(2250)
    expect((await turn).text).toBe('')
  })


  it('accepts persisted current-run completion when execution state clears the run id', async () => {
    state = { runId: null, status: 'done', executing: false, recently_completed: false, recently_completed_run_id: null }
    api.chatSend.mockImplementation(async () => {
      rows.push({ seq: 2, role: 'assistant', run_id: 'current', turn_state: 'completed', turn_duration_ms: 17760, content: '实际已完成的回复' })
      return { ok: true, runId: 'current', awaitingV4: true }
    })
    expect((await runDeptMemberWorkTurn(opts)).text).toBe('实际已完成的回复')
  })

  it('does not infer completion from id-less done state and an unrelated reply', async () => {
    state = { runId: null, status: 'done', executing: false }
    const signal = { aborted: false }
    const turn = runDeptMemberWorkTurn({ ...opts, signal })
    await vi.advanceTimersByTimeAsync(750)
    rows.push({ seq: 2, role: 'assistant', run_id: 'other', turn_state: 'completed', content: '别人的回复' })
    await vi.advanceTimersByTimeAsync(750)
    signal.aborted = true
    await vi.advanceTimersByTimeAsync(750)
    expect((await turn).text).toBe('')
  })

})
