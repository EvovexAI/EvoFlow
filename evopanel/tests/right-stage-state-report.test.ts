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
