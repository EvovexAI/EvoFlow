import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RIGHT_STAGE_PERSIST_LIMITS,
  deserializeSessionEntries,
  isReloadNavigation,
  readPersistedSessionEntries,
  serializeSessionEntries,
  writePersistedSessionEntries,
  type PersistedSessionEntry,
} from '../src/lib/right-stage/right-stage-session-persistence.js'

const STORAGE_KEY = RIGHT_STAGE_PERSIST_LIMITS.storageKey

function entryOf(key: string, overrides: Partial<PersistedSessionEntry['memory']> = {}) {
  return {
    key,
    memory: {
      tabs: [
        { id: 'primary', kind: 'file', title: 'a.ts', layout: 'wide', data: { path: 'src/a.ts' } },
      ],
      activeKey: 'file:primary',
      collapsed: false,
      recentClosed: [],
      ...overrides,
    },
  } satisfies PersistedSessionEntry
}

describe('reload-only gating', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not consume persisted state on cold start and clears the key', () => {
    sessionStorage.setItem(STORAGE_KEY, serializeSessionEntries([entryOf('sess-a')]))
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { type: 'navigate' },
    ] as unknown as PerformanceEntryList)
    expect(readPersistedSessionEntries()).toEqual([])
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('restores persisted state on reload', () => {
    sessionStorage.setItem(STORAGE_KEY, serializeSessionEntries([entryOf('sess-a')]))
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { type: 'reload' },
    ] as unknown as PerformanceEntryList)
    expect(isReloadNavigation()).toBe(true)
    const entries = readPersistedSessionEntries()
    expect(entries.map((e) => e.key)).toEqual(['sess-a'])
    expect(entries[0]?.memory.tabs[0]?.kind).toBe('file')
  })
})

describe('serialize / deserialize', () => {
  it('round-trips tab identity and drops heavy payloads per tab', () => {
    const heavy = {
      key: 'sess-heavy',
      memory: {
        tabs: [
          {
            id: 'primary',
            kind: 'file' as const,
            title: '预览',
            layout: 'wide' as const,
            data: { path: 'src/a.ts', focusAnnotation: { body: 'x'.repeat(20_000) } },
          },
        ],
        activeKey: 'file:primary',
        collapsed: false,
        recentClosed: [],
      },
    }
    const raw = serializeSessionEntries([heavy])
    const [restored] = deserializeSessionEntries(raw)
    const tab = restored?.memory.tabs[0]
    // 身份保留，重载荷被剥掉并打 evicted 标记。
    expect(tab?.data.path).toBe('src/a.ts')
    expect(tab?.data.evicted).toBe(true)
    expect(tab?.data.focusAnnotation).toBeUndefined()
  })

  it('drops retired kinds, duplicates and dangling activeKey', () => {
    const raw = JSON.stringify({
      version: 1,
      entries: [
        {
          key: 'dirty',
          memory: {
            tabs: [
              { id: 'a', kind: 'artifacts', data: {} },
              { id: 'b', kind: 'browser', data: {} },
              { id: 'b', kind: 'browser', data: {} },
            ],
            activeKey: 'artifacts:a',
            collapsed: false,
          },
        },
      ],
    })
    const [entry] = deserializeSessionEntries(raw)
    expect(entry?.memory.tabs.map((t) => `${t.kind}:${t.id}`)).toEqual(['browser:b'])
    expect(entry?.memory.activeKey).toBe('browser:b')
  })

  it('discards corrupt payloads entirely', () => {
    expect(deserializeSessionEntries('not json')).toEqual([])
    expect(deserializeSessionEntries(JSON.stringify({ version: 99 }))).toEqual([])
    expect(deserializeSessionEntries(null)).toEqual([])
  })

  it('writes and removes the storage key', () => {
    expect(writePersistedSessionEntries([entryOf('sess-x')])).toBe(true)
    expect(sessionStorage.getItem(STORAGE_KEY)).toContain('sess-x')
    expect(writePersistedSessionEntries([])).toBe(true)
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('never persists recentClosed (redundant tab copies)', () => {
    const entry = entryOf('sess-r', {
      recentClosed: [
        {
          key: 'file:old',
          tab: { id: 'old', kind: 'file', layout: 'wide', data: { path: 'old.ts' } },
          closedAt: 1,
        },
      ],
    })
    const [restored] = deserializeSessionEntries(serializeSessionEntries([entry]))
    expect(restored?.memory.recentClosed).toEqual([])
  })
})

describe('storage failures degrade silently', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  it('returns false instead of throwing when the write fails', () => {
    // happy-dom 的 storage 方法挂在原型且不可覆写，这里整体替换全局对象模拟配额失败。
    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      get length() {
        return 0
      },
    } as unknown as Storage
    vi.stubGlobal('sessionStorage', failing)
    try {
      expect(writePersistedSessionEntries([entryOf('sess-q')])).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('reload restore wiring', () => {
  it('restores the persisted session on the first session switch after reload', async () => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { type: 'reload' },
    ] as unknown as PerformanceEntryList)
    writePersistedSessionEntries([entryOf('reload-sess')])

    // 重新加载模块，让 hydrate 读到上面的快照（模拟刷新后的新进程）。
    vi.resetModules()
    const mem = await import('../src/lib/right-stage/right-stage-session-memory.js')
    const store = await import('../src/lib/right-stage/right-stage-store.js')
    // ChatApp 首次 effect：prev = '' → next = 上次选中的会话。
    mem.switchRightStageSession('', 'reload-sess')
    expect(store.rightStageStore.getSnapshot().tabs.map((t) => `${t.kind}:${t.id}`)).toEqual([
      'file:primary',
    ])
    vi.restoreAllMocks()
  })
})

/**
 * 【self-evolution-bot · 2026-11-21 · 第103轮 · 模型:deepseek-v4.1-flash-1017】
 * 本轮真机实测抓到的两条真缺陷，各一条用例钉住：
 *  A. 用户主动收起后刷新页面，旧快照把标签**复活**并重新展开右栏
 *     （实测：08:25:52 收起 tabs=0/collapsed=true rev35 →
 *            08:26:29 webview reload → 08:26:34 上报 tabs=4/collapsed=false rev=1）
 *  B. 剥壳/裁剪重建记忆对象时手写字段表漏掉 ``userCollapsed``，收起意图被静默抹掉。
 */
describe('collapse intent survives reload (第103轮真机缺陷)', () => {
  it('收起后再刷新：恢复出来的记忆必须是收起态，不许把标签复活', async () => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { type: 'reload' },
    ] as unknown as PerformanceEntryList)
    // 收起的正确落盘形态：标签还在（收起不等于关签），但 collapsed=true 且锁定。
    writePersistedSessionEntries([
      entryOf('collapsed-sess', {
        collapsed: true,
        userCollapsed: true,
        activeKey: 'file:primary',
      }),
    ])

    vi.resetModules()
    const mem = await import('../src/lib/right-stage/right-stage-session-memory.js')
    const store = await import('../src/lib/right-stage/right-stage-store.js')
    mem.switchRightStageSession('', 'collapsed-sess')

    const snap = store.rightStageStore.getSnapshot()
    // 标签仍在（不丢用户上下文），但整栏必须是收起的、且锁定。
    expect(snap.tabs.map((t) => `${t.kind}:${t.id}`)).toEqual(['file:primary'])
    expect(snap.collapsed).toBe(true)
    expect(store.rightStageStore.isUserCollapsed).toBe(true)
    vi.restoreAllMocks()
  })

  it('会话记忆落盘时必须带上 userCollapsed（字段表漏写 = 静默抹掉）', async () => {
    // 判据说明：``readPersistedSessionEntries`` 只在 reload 导航下返回内容，冷启动会清键。
    // 落盘形状是 ``{version, entries:[...]}``，不是裸数组。
    // 边界：``persistNow`` 只落最近 12 个会话，所以剥壳（evicted）路径在落盘里看不到 ——
    //   本用例只钉「落盘字段完整」这一条，剥壳路径由 shellOutMemory 的单测覆盖。
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { type: 'reload' },
    ] as unknown as PerformanceEntryList)
    vi.resetModules()
    const persistence = await import(
      '../src/lib/right-stage/right-stage-session-persistence.js'
    )
    const mem = await import('../src/lib/right-stage/right-stage-session-memory.js')
    const store = await import('../src/lib/right-stage/right-stage-store.js')
    sessionStorage.clear()
    try {
      store.rightStageStore.importSessionMemory(
        {
          tabs: [
            { id: 'primary', kind: 'file', title: 'a.ts', layout: 'wide', data: { path: 'src/a.ts' } },
          ],
          activeKey: 'file:primary',
          collapsed: true,
          userCollapsed: true,
          recentClosed: [],
        },
        { carryTabs: [] },
      )
      mem.saveRightStageSessionMemory('uc-sess')
      mem.flushRightStageSessionPersistence()

      const parsed = JSON.parse(
        sessionStorage.getItem(persistence.RIGHT_STAGE_PERSIST_LIMITS.storageKey) || '{}',
      )
      const all: Array<{ key?: string; memory?: { userCollapsed?: boolean } }> =
        Array.isArray(parsed) ? parsed : Array.isArray(parsed.entries) ? parsed.entries : []
      expect(all.length).toBeGreaterThan(0)
      for (const e of all) expect(e.memory?.userCollapsed).toBe(true)
    } finally {
      vi.restoreAllMocks()
    }
  })
})

/**
 * 【self-evolution-bot · 2026-11-21 · 第103轮 · 模型:deepseek-v4.1-flash-1017】
 * 收起手势必须**当场**把意图落进会话记忆。
 * 本轮真机缺陷：``saveRightStageSessionMemory`` 只在「切会话」时调用，收起这条路径
 * 完全不写 —— sessionStorage 里留着收起前的旧快照（N 个签、collapsed=false），
 * 任何一次 webview reload 都会把它恢复回来：标签复活、右栏自己弹开。
 * 实测：08:25:52 收起 tabs=0/rev=35 → 08:26:29 reload → 08:26:34 上报 tabs=4/rev=1。
 * 走真实入口 ``collapseRightStageShell``（生产里右侧收起按钮就是它）。
 */
describe('收起手势落盘（第103轮真机缺陷 · 接线层）', () => {
  it('collapseRightStageShell 后，sessionStorage 里必须是收起态', async () => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { type: 'reload' },
    ] as unknown as PerformanceEntryList)
    vi.resetModules()
    const mem = await import('../src/lib/right-stage/right-stage-session-memory.js')
    const store = await import('../src/lib/right-stage/right-stage-store.js')
    const shell = await import(
      '../src/react/chat-app/right-stage/collapse-expand-right-stage.js'
    )
    sessionStorage.clear()
    try {
      // 顺序要紧：先切到目标会话（切换会换入其记忆、清空 live store），
      // 再往 live store 里放两个签 —— 反过来会被 switch 冲掉（我第一次就这么红的）。
      mem.switchRightStageSession('', 'collapse-wire-sess')
      store.rightStageStore.importSessionMemory(
        {
          tabs: [
            { id: 'shell:/tasks', kind: 'shell-page', title: '任务', layout: 'wide', data: { path: '/tasks' } },
            { id: 'shell:/apps', kind: 'shell-page', title: '工作流', layout: 'wide', data: { path: '/apps' } },
          ],
          activeKey: 'shell-page:shell:/tasks',
          collapsed: false,
          userCollapsed: false,
          recentClosed: [],
        },
        { carryTabs: [] },
      )
      expect(store.rightStageStore.getSnapshot().tabs.length).toBe(2)

      shell.collapseRightStageShell({
        rightStageUserPinnedRef: { current: null },
        scheduleBumpRef: { current: null },
        collapseRightStage: () => store.rightStageStore.collapse(),
        syncShellAsideForWorkspacePanel: () => {},
      })
      expect(store.rightStageStore.getSnapshot().collapsed).toBe(true)

      // 关键判据：落盘的这条会话记忆必须是「收起 + 标签仍在 + 锁住」。
      const raw = sessionStorage.getItem('evopanel_right_stage_sessions_v1') || '{}'
      const parsed = JSON.parse(raw)
      const entries: Array<{ key?: string; memory?: { collapsed?: boolean; userCollapsed?: boolean; tabs?: unknown[] } }> =
        Array.isArray(parsed) ? parsed : Array.isArray(parsed.entries) ? parsed.entries : []
      const saved = entries.find((e) => e.key === 'collapse-wire-sess')
      expect(saved, '收起后该会话必须有一条落盘记忆').toBeTruthy()
      expect(saved?.memory?.collapsed).toBe(true)
      expect(saved?.memory?.userCollapsed).toBe(true)
      expect(saved?.memory?.tabs?.length).toBe(2)
    } finally {
      vi.restoreAllMocks()
    }
  })
})
