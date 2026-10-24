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
