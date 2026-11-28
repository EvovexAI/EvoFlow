/**
 * 协作完成通知：重启后不得把历史 delivered 积压全弹一遍。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../src/components/toast.js', () => ({
  toast: vi.fn(),
}))
vi.mock('../src/lib/desktop-notification.js', () => ({
  notifyDesktopCompletion: vi.fn(async () => {}),
}))
vi.mock('../src/lib/tauri-api.js', () => ({
  appendFrontendLog: vi.fn(),
  api: {
    proactiveListCollabChatCalls: vi.fn(),
  },
}))

describe('collab-chat-complete-notify bootstrap', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.useFakeTimers()
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('成功的冷启动 poll 把历史记入 seen 且不 toast', async () => {
    const { api } = await import('../src/lib/tauri-api.js')
    const { toast } = await import('../src/components/toast.js')
    const { notifyDesktopCompletion } = await import('../src/lib/desktop-notification.js')
    const mod = await import('../src/lib/collab-chat-complete-notify.js')

    api.proactiveListCollabChatCalls.mockResolvedValue({
      ok: true,
      calls: [
        {
          call_id: 'c-hist-a',
          status: 'delivered',
          target_agent: 'manju-writer',
          run_status: 'completed',
          summary: '剧本写完',
        },
        {
          call_id: 'c-hist-b',
          status: 'resumed',
          target_agent: 'image-designer',
          run_status: 'failed',
          summary: 'quota',
        },
      ],
    })

    mod.startCollabChatCompleteNotify()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    const st = mod.__collabChatCompleteNotifyTestState()
    expect(st.bootstrapped).toBe(true)
    expect(st.seen).toEqual(expect.arrayContaining(['c-hist-a', 'c-hist-b']))
    expect(toast).not.toHaveBeenCalled()
    expect(notifyDesktopCompletion).not.toHaveBeenCalled()

    await mod.handleCollabChatComplete({
      call_id: 'c-new-1',
      title: '协作完成 · manju-writer',
      body: '新的',
      ok: true,
    })
    expect(toast).toHaveBeenCalledTimes(1)
    expect(notifyDesktopCompletion).toHaveBeenCalledTimes(1)
  })

  it('首轮 poll 失败不结束 bootstrap，避免下一轮把积压当新通知', async () => {
    const { api } = await import('../src/lib/tauri-api.js')
    const { toast } = await import('../src/components/toast.js')
    const mod = await import('../src/lib/collab-chat-complete-notify.js')

    api.proactiveListCollabChatCalls.mockRejectedValue(new Error('ECONNREFUSED'))
    mod.startCollabChatCompleteNotify()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(mod.__collabChatCompleteNotifyTestState().bootstrapped).toBe(false)
    expect(toast).not.toHaveBeenCalled()

    api.proactiveListCollabChatCalls.mockResolvedValue({
      ok: true,
      calls: [
        {
          call_id: 'c-old-1',
          status: 'delivered',
          target_agent: 'manju-writer',
          run_status: 'completed',
          summary: '旧回执',
        },
      ],
    })
    await vi.advanceTimersByTimeAsync(15_000)
    await Promise.resolve()
    await Promise.resolve()

    const st = mod.__collabChatCompleteNotifyTestState()
    expect(st.bootstrapped).toBe(true)
    expect(st.seen).toContain('c-old-1')
    expect(toast).not.toHaveBeenCalled()
  })

  it('重启后从 localStorage 恢复 seen，不重弹上次已通知过的 call', async () => {
    localStorage.setItem(
      'evopanel.collab-chat-complete.seen.v1',
      JSON.stringify(['c-prev-1', 'c-prev-2']),
    )
    const { api } = await import('../src/lib/tauri-api.js')
    const { toast } = await import('../src/components/toast.js')
    const mod = await import('../src/lib/collab-chat-complete-notify.js')

    api.proactiveListCollabChatCalls.mockResolvedValue({
      ok: true,
      calls: [
        {
          call_id: 'c-prev-1',
          status: 'delivered',
          target_agent: 'manju-writer',
          run_status: 'completed',
          summary: '上次已弹过',
        },
      ],
    })

    mod.startCollabChatCompleteNotify()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(mod.__collabChatCompleteNotifyTestState().seen).toContain('c-prev-1')
    expect(toast).not.toHaveBeenCalled()

    await mod.handleCollabChatComplete({
      call_id: 'c-prev-1',
      title: '协作完成 · manju-writer',
      body: '不应再弹',
      ok: true,
    })
    expect(toast).not.toHaveBeenCalled()
  })
})
