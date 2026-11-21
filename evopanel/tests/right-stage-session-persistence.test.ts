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

/**
 * 【第115轮】恢复门控从 reload-only 放宽为「同一标签页内重载即恢复」。
 * 原断言（冷启动清键 + 返回空）随语义一起作废：sessionStorage 本身已表达
 * 标签页边界，再加 navigation type 判断会漏掉 dev HMR / webview reload
 * （实测 rev=41 tabs=7 → rev=1 tabs=0 的根因）。
 * 新增的唯一兜底是快照 TTL。
 */
describe('same-tab reload restore', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('restores persisted state even when navigation type is not reload (HMR / webview)', () => {
    sessionStorage.setItem(STORAGE_KEY, serializeSessionEntries([entryOf('sess-a')]))
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { type: 'navigate' },
    ] as unknown as PerformanceEntryList)
    // 关键：不再因为「不是 reload」就丢东西。
    const entries = readPersistedSessionEntries()
    expect(entries.map((e) => e.key)).toEqual(['sess-a'])
    expect(sessionStorage.getItem(STORAGE_KEY)).not.toBeNull()
  })

  it('restores persisted state on a classic reload', () => {
    sessionStorage.setItem(STORAGE_KEY, serializeSessionEntries([entryOf('sess-a')]))
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { type: 'reload' },
    ] as unknown as PerformanceEntryList)
    expect(isReloadNavigation()).toBe(true)
    const entries = readPersistedSessionEntries()
    expect(entries.map((e) => e.key)).toEqual(['sess-a'])
    expect(entries[0]?.memory.tabs[0]?.kind).toBe('file')
  })

  it('returns empty for a fresh tab (nothing persisted)', () => {
    sessionStorage.clear()
    expect(readPersistedSessionEntries()).toEqual([])
  })

  it('drops and clears an expired snapshot', () => {
    sessionStorage.setItem(STORAGE_KEY, serializeSessionEntries([entryOf('sess-old')]))
    // 拨到保鲜期之后：跨天残留不能糊到用户脸上。
    const later = Date.now() + RIGHT_STAGE_PERSIST_LIMITS.maxAgeMs + 1000
    vi.spyOn(Date, 'now').mockReturnValue(later)
    expect(readPersistedSessionEntries()).toEqual([])
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('skips rewriting when content is unchanged', () => {
    const entry = entryOf('sess-same')
    expect(writePersistedSessionEntries([entry])).toBe(true)
    const first = sessionStorage.getItem(STORAGE_KEY)
    expect(writePersistedSessionEntries([entry])).toBe(true)
    // savedAt 没被刷新 = 根本没重写（判重生效）。
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe(first)
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
    // 判据说明（第115轮更新）：恢复不再判 navigation type，同一标签页内重载即可恢复；
    // 唯一会清空的是「过期快照」（savedAt 超过保鲜期）。
    // 落盘形状是 ``{version, savedAt, entries:[...]}``，不是裸数组。
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

/**
 * 【第115轮】重载恢复的前置条件：签必须**在开的那一刻**就落盘。
 *
 * 本轮真机缺陷：开了 7 个签、没切过会话，整页重载后全丢
 * （rev=41 tabs=7 → rev=1 tabs=0）。放宽恢复门控只是「允许读」，
 * 若写入侧仍只在切会话/收起时落盘，读侧永远读不到东西。
 * 这里直接钉「开签 → bump → sessionStorage 出现该签」这条链路。
 */
describe('autosave on tab open（第115轮真机缺陷）', () => {
  it('开签后不切会话也能落盘，重载可恢复', async () => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { type: 'navigate' },
    ] as unknown as PerformanceEntryList)
    vi.resetModules()
    const mem = await import('../src/lib/right-stage/right-stage-session-memory.js')
    const store = await import('../src/lib/right-stage/right-stage-store.js')
    const scope = await import('../src/lib/right-stage/right-stage-scope.js')
    sessionStorage.clear()
    try {
      mem.setRightStageSessionPersistenceSuspended(false)
      scope.setCurrentRightStageSessionKey('autosave-sess')
      // 订阅安装在微任务里，等它跑完再动 store。
      await Promise.resolve()
      await Promise.resolve()

      store.rightStageStore.show({ kind: 'file', id: 'a', data: { path: 'src/auto.ts' } })
      mem.flushRightStageSessionPersistence()

      const raw = sessionStorage.getItem('evopanel_right_stage_sessions_v1') || ''
      expect(raw, '开签后必须已落盘').toContain('autosave-sess')
      expect(raw).toContain('src/auto.ts')

      // 用落盘内容反推恢复结果：模拟重载后 hydrate。
      const entries = await import(
        '../src/lib/right-stage/right-stage-session-persistence.js'
      )
      const restored = entries.readPersistedSessionEntries()
      const hit = restored.find((e) => e.key === 'autosave-sess')
      expect(hit?.memory.tabs.map((t) => `${t.kind}:${t.id}`)).toContain('file:a')
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('切会话时不许把目标会话的签写进源会话（autosave 抑制）', async () => {
    vi.resetModules()
    const mem = await import('../src/lib/right-stage/right-stage-session-memory.js')
    const store = await import('../src/lib/right-stage/right-stage-store.js')
    sessionStorage.clear()
    try {
      mem.setRightStageSessionPersistenceSuspended(false)
      mem.switchRightStageSession('', 'sess-a')
      await Promise.resolve()
      await Promise.resolve()
      store.rightStageStore.show({ kind: 'file', id: 'only-a', data: { path: 'a.ts' } })
      mem.switchRightStageSession('sess-a', 'sess-b')
      mem.flushRightStageSessionPersistence()

      const entries = await import(
        '../src/lib/right-stage/right-stage-session-persistence.js'
      )
      const restored = entries.readPersistedSessionEntries()
      // 真正的串台方向：换入 B 时 bump 早于 sessionKey 切换，会把「B 的空状态」
      // 写进 A —— A 的签被抹掉。B 本身从未开过签，天然就没有 file:only-a。
      const a = restored.find((e) => e.key === 'sess-a')
      expect(a?.memory.tabs.map((t) => `${t.kind}:${t.id}`)).toContain('file:only-a')
      const b = restored.find((e) => e.key === 'sess-b')
      expect((b?.memory.tabs ?? []).map((t) => `${t.kind}:${t.id}`)).not.toContain('file:only-a')
    } finally {
      vi.restoreAllMocks()
    }
  })
})

/**
 * 【第115轮】workspace 级签（文件树 / 写入 / 思维导图 / 交互终端 / 小V）
 * 必须能扛过整页重载。
 *
 * 为什么单列：``exportSessionMemory`` 有意把它们从会话记忆里过滤掉
 * （否则 40 条 LRU 会被同一份 workspace 副本吃满），代价是它们**只活在内存**。
 * 本轮之前重载后一条不剩 —— 而这恰恰是用户期望常驻的那类签。
 */
describe('workspace 级签跨重载（第115轮）', () => {
  it('开 workspace 签后落盘，重载后回填仍在', async () => {
    vi.resetModules()
    sessionStorage.clear()
    const mem = await import('../src/lib/right-stage/right-stage-session-memory.js')
    const store = await import('../src/lib/right-stage/right-stage-store.js')
    mem.setRightStageSessionPersistenceSuspended(false)
    await Promise.resolve()
    await Promise.resolve()
    try {
      store.rightStageStore.show({
        kind: 'workspace-browse',
        id: 'primary',
        data: { path: 'D:/dev/github/EvoFlow' },
      })
      store.rightStageStore.show({ kind: 'mind-map', id: 'primary' })
      mem.flushRightStageSessionPersistence()

      const raw = sessionStorage.getItem('evopanel_right_stage_workspace_v1')
      expect(raw, 'workspace 签必须有独立快照').toBeTruthy()
      expect(raw).toContain('workspace-browse')
      expect(raw).toContain('mind-map')
    } finally {
      vi.restoreAllMocks()
    }

    // 模拟整页重载：模块全量重建（store 归零），只留 sessionStorage。
    vi.resetModules()
    const mem2 = await import('../src/lib/right-stage/right-stage-session-memory.js')
    const store2 = await import('../src/lib/right-stage/right-stage-store.js')
    mem2.hydrateWorkspaceTabsFromPersistence()
    const kinds = store2.rightStageStore.getSnapshot().tabs.map((t) => t.kind).sort()
    expect(kinds).toEqual(['mind-map', 'workspace-browse'])
  })

  it('回填不会把用户收起的右栏撑开', async () => {
    sessionStorage.clear()
    const persistence = await import(
      '../src/lib/right-stage/right-stage-session-persistence.js'
    )
    persistence.writePersistedWorkspaceTabs([
      { id: 'primary', kind: 'workspace-browse', layout: 'wide', data: { path: 'D:/x' } },
    ])
    vi.resetModules()
    const mem = await import('../src/lib/right-stage/right-stage-session-memory.js')
    const store = await import('../src/lib/right-stage/right-stage-store.js')
    try {
      mem.hydrateWorkspaceTabsFromPersistence()
      const snap = store.rightStageStore.getSnapshot()
      expect(snap.tabs.map((t) => t.kind)).toContain('workspace-browse')
      // 签回来，但面板保持收起——恢复 ≠ 抢用户视线。
      expect(snap.collapsed).toBe(true)
    } finally {
      vi.restoreAllMocks()
    }
  })
})
