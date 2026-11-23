import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * 【self-evolution-bot · 2026-11-20 · 第100轮 · 模型:deepseek-v4.1-flash-1017】
 * 改了什么：右栏状态上报的门禁——必须经 gatewayFetch 打到 `/api/stage/right-stage/state`，
 *   且**只发身份字段**；另加反证：URL 里不得再出现 `/__evoflow` 前缀。
 * 为什么（用户明确指出）：「你知道我当前右侧标签页是哪个吗？这个在你的管理体系里边能查到吗？」
 *   改动前 `grep activeKey backend --include=*.py` 命中 0 次：状态只活在前端内存。
 *   更关键的是**第一版实现自己也是坏的**：它手拼 `${window.__EVOFLOW_GATEWAY_BASE__ || '/__evoflow'}`
 *   + `/api/...` → `/__evoflow/api/stage/right-stage/state`，而网关只挂 `/api/...`
 *   （`grep '/__evoflow' backend` 只命中 `__evoflow-log` 两条日志路由）。
 *   于是能力上线了但上报从没到达，ui.current 恒 known=false —— 写了等于没写。
 *   所以本文件必须有一条断言盯着前缀，否则下次谁改回去都不会红。
 *
 * 判据（可反证）：
 * - POST 必须真的发出，body 带 activeKey / activeKind。
 * - body 里**不得**出现 data 载荷（预览正文、消息数组）——只允许身份字段。
 * - 事件间隔小于节流窗口时只发最后一份（不刷屏）。
 * - URL 不得含 `/__evoflow`（反证：改回手拼前缀必须红）。
 */

const gatewayFetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }))

vi.mock('../src/lib/gateway-json.js', () => ({
  gatewayFetch: (...args: unknown[]) => gatewayFetchMock(...(args as [])),
  gatewayJson: vi.fn(),
}))

beforeEach(() => {
  gatewayFetchMock.mockClear()
  // 【self-evolution-bot · 2026-11-21 · 第103轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：加 resetModules —— 本模块的 timer/pending/inFlight/queued 是**模块级**状态。
  // 为什么：不重置时，上一个用例留下的在飞请求会把下一个用例直接吞进 queued，
  //   表现为「只发了 1 次」的假失败（判据没错，是被隔壁用例污染）。
  vi.resetModules()
  vi.stubGlobal('window', { __EVOFLOW_GATEWAY_BASE__: 'http://127.0.0.1:8382' })
})

function snapshot(overrides = {}) {
  // 【self-evolution-bot · 2026-11-20 · 第100轮 · 模型:deepseek-v4.1-flash-1017】
  // 夹具按 store 真实形状写：RightStageSurface **没有 key 字段**，键由
  // `${kind}:${id}` 算出。第一版夹具自己塞了 key，于是现网出现「tabs[].key 全空、
  // activeKind 恒 null」时单测照样全绿 —— 自造样例不算证据，夹具必须照现网形状。
  return {
    activeKey: 'employeeProcess:live:reviewer',
    collapsed: false,
    rev: 3,
    tabs: [
      {
        kind: 'employeeProcess',
        id: 'live:reviewer',
        title: '审核员',
        sessionKey: 'proactive:reviewer:chat:dept-x',
        // 【self-evolution-bot · 2026-11-23 · 第128轮续 · 模型:deepseek-v4.1-flash】
        // 夹具带 openedBy：用户 2026-11-23 要求「让 AI 能看懂就可以了」，而本上报
        // 是 AI 唯一能读到「谁开的签」的通道（platform action=ui.current → tabs[]）。
        // 夹具不含该字段时，白名单把它吃掉也不会有任何测试变红 —— 那就是假绿。
        openedBy: 'agent:reviewer',
        data: {
          agentCode: 'reviewer',
          // 载荷：绝不允许上报出去
          messages: [{ role: 'user', text: '这句话不该出仓库'.repeat(200) }],
          preview: 'X'.repeat(5000),
        },
      },
    ],
    ...overrides,
  }
}

function lastCall() {
  const calls = gatewayFetchMock.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  const [url, init] = calls[calls.length - 1] as unknown as [string, Record<string, unknown>]
  return { url: String(url), init }
}

/** gatewayFetch 接受对象 body（内部再序列化），测试里两种形态都要能吃。 */
function bodyOf(init: Record<string, unknown>): Record<string, unknown> {
  const raw = init.body
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>
}

describe('right-stage-state-report', () => {
  it('状态变化会真的上报，并带 activeKey/activeKind', async () => {
    const { reportRightStageState, __flushRightStageStateForTest } = await import(
      '../src/lib/right-stage/right-stage-state-report.ts'
    )
    reportRightStageState(snapshot())
    await __flushRightStageStateForTest()

    expect(gatewayFetchMock).toHaveBeenCalledTimes(1)
    const { url, init } = lastCall()
    expect(url).toBe('/api/stage/right-stage/state')
    expect(init.method).toBe('POST')

    const body = bodyOf(init)
    expect(body.activeKey).toBe('employeeProcess:live:reviewer')
    expect(body.activeKind).toBe('employeeProcess')
    expect(body.activeTitle).toBe('审核员')
    expect(body.tabs).toHaveLength(1)
    // key 必须由 kind:id 算出来，不能是空串（现网曾全空）
    expect(body.tabs[0].key).toBe('employeeProcess:live:reviewer')
    expect(body.tabs[0].data.agentCode).toBe('reviewer')
    // 【self-evolution-bot · 2026-11-23 · 第128轮续 · 模型:deepseek-v4.1-flash】
    // 「谁说这签是谁开的」必须能随上报出去：AI 走 platform ui.current 只能看这里。
    // 这条断言漏了的话，白名单吃掉 openedBy 也不会红 → 用户要的功能对 AI 等于不存在。
    expect(body.tabs[0].openedBy).toBe('agent:reviewer')
  })

  it('反证：上报 URL 绝不能带 /__evoflow 前缀（网关没这个挂载）', async () => {
    const { reportRightStageState, __flushRightStageStateForTest } = await import(
      '../src/lib/right-stage/right-stage-state-report.ts'
    )
    reportRightStageState(snapshot())
    await __flushRightStageStateForTest()

    const { url } = lastCall()
    expect(url).not.toContain('__evoflow')
    expect(url.startsWith('/api/')).toBe(true)
  })

  it('只发身份字段，载荷一个字都不出去', async () => {
    const { reportRightStageState, __flushRightStageStateForTest } = await import(
      '../src/lib/right-stage/right-stage-state-report.ts'
    )
    reportRightStageState(snapshot())
    await __flushRightStageStateForTest()

    const body = bodyOf(lastCall().init)
    const tabData = body.tabs[0].data
    expect(tabData.messages).toBeUndefined()
    expect(tabData.preview).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('这句话不该出仓库')
  })

  it('节流：连发多次只提交最后一份', async () => {
    const { reportRightStageState, __flushRightStageStateForTest } = await import(
      '../src/lib/right-stage/right-stage-state-report.ts'
    )
    reportRightStageState(snapshot({ activeKey: 'a', rev: 1 }))
    reportRightStageState(snapshot({ activeKey: 'b', rev: 2 }))
    reportRightStageState(snapshot({ activeKey: 'c', rev: 3 }))
    await __flushRightStageStateForTest()

    expect(gatewayFetchMock).toHaveBeenCalledTimes(1)
    expect(bodyOf(lastCall().init).activeKey).toBe('c')
  })

  it('上报失败不影响调用方（静默）', async () => {
    gatewayFetchMock.mockImplementationOnce(() => Promise.reject(new Error('gateway down')))
    const { reportRightStageState, __flushRightStageStateForTest } = await import(
      '../src/lib/right-stage/right-stage-state-report.ts'
    )
    reportRightStageState(snapshot())
    await expect(__flushRightStageStateForTest()).resolves.toBeUndefined()
  })
})
describe('right-stage-state-report 修复项（第103轮）', () => {
  it('协作两类签的 mainTaskId/subtaskId 必须上报（否则 ui.current 看不出是哪一单）', async () => {
    const { reportRightStageState, __flushRightStageStateForTest } = await import(
      '../src/lib/right-stage/right-stage-state-report.ts'
    )
    reportRightStageState({
      activeKey: 'collabSubtaskTranscript:collabSubtaskTranscript:st-1',
      collapsed: false,
      rev: 5,
      tabs: [
        {
          kind: 'collabSubtaskTranscript',
          id: 'collabSubtaskTranscript:st-1',
          title: '节点进度',
          data: { mainTaskId: 'mt-1', subtaskId: 'st-1' },
        },
      ],
    })
    await __flushRightStageStateForTest()

    const tabData = bodyOf(lastCall().init).tabs[0].data
    expect(tabData.mainTaskId).toBe('mt-1')
    expect(tabData.subtaskId).toBe('st-1')
  })

  it('在飞期间到达的新状态不许丢：结束后必须补发最后那份', async () => {
    // 【self-evolution-bot · 2026-11-21 · 第103轮 · 模型:deepseek-v4.1-flash-1017】
    // 反证目标：旧实现 `if (inFlight) return` 会让**最后一次**状态被静默丢弃，
    //   于是 ui.current 永远读到中间态（模型看到 3 个签，用户屏幕上只剩 1 个）。
    // 判据走真通道（reportRightStageState → 节流定时器 → post），不借测试专用出口。
    // 注意：post 第一件事是 `await import('../gateway-json.js')` —— inFlight 是在那个
    //   microtask **之后**才置位的，所以「第二次 report 落在 queued 分支」必须等到
    //   mock 真正被调用之后再发生；用 waitFor(calls===1) 卡这个点，而不是拍 microtask 数。
    vi.useFakeTimers()
    try {
      let release: (v: unknown) => void = () => {}
      gatewayFetchMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve as (v: unknown) => void
          }),
      )
      const { reportRightStageState } = await import(
        '../src/lib/right-stage/right-stage-state-report.ts'
      )

      reportRightStageState(snapshot({ activeKey: 'a', rev: 1 }))
      await vi.advanceTimersByTimeAsync(500) // 节流窗口到点，第一份发出并进入在飞
      await vi.waitFor(() => expect(gatewayFetchMock).toHaveBeenCalledTimes(1))

      reportRightStageState(snapshot({ activeKey: 'b', rev: 2 }))
      await vi.advanceTimersByTimeAsync(500) // 第二份此时必须落到 queued
      expect(gatewayFetchMock).toHaveBeenCalledTimes(1) // 还没补发

      release({ ok: true })
      await vi.waitFor(() => expect(gatewayFetchMock).toHaveBeenCalledTimes(2))
      expect(bodyOf(lastCall().init).activeKey).toBe('b')
    } finally {
      vi.useRealTimers()
      gatewayFetchMock.mockReset()
      gatewayFetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ ok: true }) }))
    }
  })
})
