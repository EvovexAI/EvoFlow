import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 回归：右栏「Agent 应用」冷启动必须**先开签再起服务**。
 *
 * 背景：managed 扩展（node/python 本地服务）冷启动要 30~60s。
 * 若先 await ensureUiExtensionReady() 再开签，用户在这段时间里右栏
 * 完全没反应——表现就是「点了没反应」。
 *
 * 本测试用可控的 pending promise 模拟慢服务，断言：
 *  1) 服务还没就绪时，showKind 已经被调用（签先开了）；
 *  2) 服务就绪后，签的 url 被刷新（cache-buster），首屏能救回来；
 *  3) 服务启动失败时，签不消失，错误写进签的 data。
 */

// 控制 service status / ready 的时序
let serviceStatus: { state: string } = { state: 'stopped' }
let readyResolve: ((v: unknown) => void) | null = null
let readyReject: ((e: unknown) => void) | null = null
let readyCalled = 0

vi.mock('../src/lib/ui-extensions.js', () => ({
  getUiExtension: vi.fn(async (id: string) => ({
    id,
    enabled: true,
    manifest: {
      id,
      name: 'ops',
      nav: { title: '运营台' },
      ui: { entry: 'http://127.0.0.1:5173/' },
      service: { mode: 'managed', hint: '需先 npm install' },
    },
  })),
  uiExtensionServiceStatus: vi.fn(async () => serviceStatus),
  ensureUiExtensionReady: vi.fn(async () => {
    readyCalled += 1
    return new Promise((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
    })
  }),
}))

import { rightStageStore } from '../src/lib/right-stage/right-stage-store.js'
import {
  openUiExtensionInStage,
  uiExtensionStageTabId,
} from '../src/react/chat-app/right-stage/open-ui-extension-in-stage.js'

function makeCtx() {
  const showKind = vi.fn()
  const ctx = {
    rightStageOpen: false,
    rightStageUserPinnedRef: { current: null },
    scheduleBumpRef: { current: null },
    cancelPendingStreamUiBumpsRef: { current: vi.fn() },
    lastStreamWritePathRef: { current: null },
    writeStreamDismissedRef: { current: false },
    syncShellAsideForWorkspacePanel: vi.fn(),
    // 真 store：openUiExtensionInStage 后续会 findTab/updateData 同一个签。
    showKind: vi.fn((kind: string, opts?: Record<string, unknown>) => {
      showKind(kind, opts)
      rightStageStore.show({
        kind: kind as never,
        id: opts?.id as never,
        title: opts?.title as never,
        data: (opts?.data as Record<string, unknown>) ?? {},
        forceExpand: opts?.forceExpand as never,
      })
    }),
    setWorkspacePanelOpen: vi.fn(),
    setWorkspaceTreePinned: vi.fn(),
    setStreamingWritePreview: vi.fn(),
    setCollabExecPanelOpen: vi.fn(),
    setKnowledgeMapPanelOpen: vi.fn(),
  }
  return { ctx, showKind }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  serviceStatus = { state: 'stopped' }
  readyResolve = null
  readyReject = null
  readyCalled = 0
  rightStageStore.closeAllTabs()
  rightStageStore.expand()
})

afterEach(() => {
  rightStageStore.closeAllTabs()
  vi.clearAllMocks()
})

describe('openUiExtensionInStage — 冷启动先开签', () => {
  it('opens the tab before the service is ready (no "点了没反应" window)', async () => {
    const { ctx, showKind } = makeCtx()
    openUiExtensionInStage(ctx as never, 'ops')
    await flush()

    // 服务还没起来（ensure 处于 pending），但签必须已经开了
    expect(readyCalled).toBe(1)
    expect(showKind).toHaveBeenCalledTimes(1)
    const [kind, opts] = showKind.mock.calls[0] as [string, Record<string, unknown>]
    expect(kind).toBe('web-embed')
    expect(opts.id).toBe(uiExtensionStageTabId('ops'))
    expect(opts.forceExpand).toBe(true)
    // 冷启动中：签里带 serviceStarting，面板据此显示「服务启动中」
    expect((opts.data as Record<string, unknown>).serviceStarting).toBe(true)
    expect((opts.data as Record<string, unknown>).url).toBe('http://127.0.0.1:5173/')
  })

  it('reloads the tab with a cache-buster once the service comes up', async () => {
    const { ctx } = makeCtx()
    openUiExtensionInStage(ctx as never, 'ops')
    await flush()

    readyResolve?.({ ok: true, entry: 'http://127.0.0.1:5173/', state: 'running' })
    await flush()
    await flush()

    const tab = rightStageStore.findTab(`web-embed:${uiExtensionStageTabId('ops')}`)
    expect(tab).toBeTruthy()
    const url = String(tab?.data?.url || '')
    expect(url).toContain('http://127.0.0.1:5173/')
    expect(url).toContain('_evoflow_r=')
    expect(tab?.data?.serviceStarting).toBe(false)
    expect(tab?.data?.serviceReady).toBe(true)
  })

  it('keeps the tab open and records the error when the service fails to start', async () => {
    const { ctx } = makeCtx()
    openUiExtensionInStage(ctx as never, 'ops')
    await flush()

    readyReject?.(new Error('扩展服务启动失败'))
    await flush()
    await flush()

    const tab = rightStageStore.findTab(`web-embed:${uiExtensionStageTabId('ops')}`)
    expect(tab).toBeTruthy()
    expect(tab?.data?.serviceStarting).toBe(false)
    expect(String(tab?.data?.serviceError || '')).toContain('扩展服务启动失败')
  })

  it('does not spawn the service when it is already running', async () => {
    serviceStatus = { state: 'running' }
    const { ctx, showKind } = makeCtx()
    openUiExtensionInStage(ctx as never, 'ops')
    await flush()

    expect(showKind).toHaveBeenCalledTimes(1)
    const opts = showKind.mock.calls[0][1] as Record<string, unknown>
    // 已在跑 → 不显示「启动中」
    expect((opts.data as Record<string, unknown>).serviceStarting).toBeUndefined()
    expect(readyCalled).toBe(0)
  })
})
