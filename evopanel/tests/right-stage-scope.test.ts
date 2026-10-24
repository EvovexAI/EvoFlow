import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RightStageStore, rightStageStore } from '../src/lib/right-stage/right-stage-store.js'
import {
  resolveTabSessionKey,
  scopeOfKind,
  setCurrentRightStageSessionKey,
} from '../src/lib/right-stage/right-stage-scope.js'
import { RIGHT_STAGE_PERSIST_LIMITS } from '../src/lib/right-stage/right-stage-session-persistence.js'
import {
  clearRightStageSessionMemory,
  flushRightStageSessionPersistence,
  getRightStageMemoryStats,
  setRightStageSessionPersistenceSuspended,
  restoreRightStageSessionMemory,
  saveRightStageSessionMemory,
  upsertTabInSessionMemory,
} from '../src/lib/right-stage/right-stage-session-memory.js'

describe('right stage scope', () => {
  it('classifies workspace-scoped kinds', () => {
    expect(scopeOfKind('workspace-browse')).toBe('workspace')
    expect(scopeOfKind('write')).toBe('workspace')
    expect(scopeOfKind('mind-map')).toBe('workspace')
    expect(scopeOfKind('collab-workflow')).toBe('workspace')
    expect(scopeOfKind('collabSubtaskTranscript')).toBe('workspace')
    expect(scopeOfKind('employeeProcess')).toBe('workspace')
  })

  it('classifies session-scoped kinds and defaults unknown to session', () => {
    expect(scopeOfKind('browser')).toBe('session')
    expect(scopeOfKind('file')).toBe('session')
    expect(scopeOfKind('terminal')).toBe('session')
    expect(scopeOfKind('some-future-kind')).toBe('session')
    expect(scopeOfKind('')).toBe('session')
  })

  it('resolveTabSessionKey respects explicit value and workspace scope', () => {
    expect(resolveTabSessionKey('browser', 'explicit', 'ui')).toBe('explicit')
    expect(resolveTabSessionKey('browser', '', 'ui')).toBe('ui')
    expect(resolveTabSessionKey('workspace-browse', '', 'ui')).toBeUndefined()
    expect(resolveTabSessionKey('browser', '', '')).toBeUndefined()
  })
})

describe('session memory ownership routing', () => {
  beforeEach(() => {
    setCurrentRightStageSessionKey('')
    rightStageStore.hideAll()
  })

  it('refuses to write into the current UI session (caller must use live store)', () => {
    setCurrentRightStageSessionKey('sess-ui')
    const wrote = upsertTabInSessionMemory({
      sessionKey: 'sess-ui',
      tab: { id: 'primary', kind: 'browser', data: {} },
    })
    expect(wrote).toBe(false)
  })

  it('writes into a background session memory without touching live tabs', () => {
    setCurrentRightStageSessionKey('sess-ui')
    rightStageStore.show({ kind: 'browser', id: 'ui-tab' })
    const before = rightStageStore.getSnapshot().tabs.length

    const wrote = upsertTabInSessionMemory({
      sessionKey: 'sess-bg',
      tab: { id: 'primary', kind: 'web-embed', title: '后台页', data: { url: 'https://x.test' } },
    })
    expect(wrote).toBe(true)
    expect(rightStageStore.getSnapshot().tabs.length).toBe(before)

    // 切到后台会话后，才看见它自己的标签。
    saveRightStageSessionMemory('sess-ui')
    restoreRightStageSessionMemory('sess-bg')
    const tabs = rightStageStore.getSnapshot().tabs
    expect(tabs.map((t) => `${t.kind}:${t.id}`)).toEqual(['web-embed:primary'])
    expect(tabs[0]?.sessionKey).toBe('sess-bg')
  })

  it('workspace-scoped tabs are not frozen into per-session memory', () => {
    setCurrentRightStageSessionKey('sess-a')
    rightStageStore.show({ kind: 'workspace-browse', id: 'primary' })
    rightStageStore.show({ kind: 'browser', id: 'primary' })
    const memory = rightStageStore.exportSessionMemory()
    expect(memory.tabs.map((t) => t.kind)).toEqual(['browser'])
  })

  it('local store instances see the same current session key', () => {
    setCurrentRightStageSessionKey('sess-local')
    const store = new RightStageStore()
    store.show({ kind: 'browser', id: 'primary' })
    expect(store.getSnapshot().tabs[0]?.sessionKey).toBe('sess-local')
  })
})

describe('session memory LRU shelling', () => {
  beforeEach(() => {
    setCurrentRightStageSessionKey('')
    rightStageStore.hideAll()
    clearRightStageSessionMemory()
  })

  it('keeps tab shells instead of dropping whole sessions at the limit', () => {
    const stats0 = getRightStageMemoryStats()
    expect(stats0.entries).toBe(0)

    // 写入超过 MAX_ENTRIES 的会话，且每个都带重载荷（预览正文 / 历史栈）。
    for (let i = 0; i < stats0.maxEntries + 5; i += 1) {
      upsertTabInSessionMemory({
        sessionKey: `bg-${i}`,
        tab: {
          id: 'primary',
          kind: 'file',
          title: `文件 ${i}`,
          data: {
            path: `src/f${i}.ts`,
            focusAnnotation: { title: 'x', body: 'y'.repeat(500) },
          },
        },
      })
    }

    const stats = getRightStageMemoryStats()
    // 条目总数不被砍到 MAX_ENTRIES：超出的那些只是被剥壳了。
    expect(stats.entries).toBe(stats0.maxEntries + 5)
    expect(stats.heavyEntries).toBe(stats0.maxEntries)
    expect(stats.shells).toBe(5)
    expect(stats.shelledTabs).toBe(5)
  })

  it('shelled tabs keep identity fields so panels can reload content', () => {
    const { maxEntries } = getRightStageMemoryStats()
    for (let i = 0; i < maxEntries + 2; i += 1) {
      upsertTabInSessionMemory({
        sessionKey: `id-${i}`,
        tab: {
          id: 'primary',
          kind: 'file',
          title: `文件 ${i}`,
          data: {
            path: `src/f${i}.ts`,
            focusAnnotation: { title: 'x', body: 'y'.repeat(500) },
          },
        },
      })
    }
    const stats = getRightStageMemoryStats()
    restoreRightStageSessionMemory('id-0')
    const tab = rightStageStore.getSnapshot().tabs[0]
    // bg-0 是最早写入的，必定已被剥壳。
    expect(tab?.kind).toBe('file')
    expect(tab?.data.path).toBe('src/f0.ts')
    expect(tab?.data.evicted).toBe(true)
    // 重载荷被丢弃
    expect(tab?.data.focusAnnotation).toBeUndefined()
    expect(stats.maxShellEntries).toBeGreaterThan(stats.maxEntries)
  })
})

describe('session memory normalize on restore', () => {
  beforeEach(() => {
    setCurrentRightStageSessionKey('')
    rightStageStore.hideAll()
    clearRightStageSessionMemory()
  })

  it('drops retired kinds, duplicate keys and dangling activeKey', () => {
    // 直接用 upsert 写入违反约束的脏数据：artifacts 已禁用、重复 key 两条。
    upsertTabInSessionMemory({
      sessionKey: 'dirty',
      tab: { id: 'primary', kind: 'artifacts', data: {} },
    })
    upsertTabInSessionMemory({
      sessionKey: 'dirty',
      tab: { id: 'a', kind: 'file', data: { path: 'a.ts' } },
    })
    restoreRightStageSessionMemory('dirty')
    const snap = rightStageStore.getSnapshot()
    const kinds = snap.tabs.map((t) => `${t.kind}:${t.id}`)
    expect(kinds).toEqual(['file:a'])
    // activeKey 指向被丢弃的 artifacts 时回退到现存标签。
    expect(snap.activeKey).toBe('file:a')
  })
})

describe('reload-only persistence wiring', () => {
  beforeEach(() => {
    setCurrentRightStageSessionKey('')
    rightStageStore.hideAll()
    clearRightStageSessionMemory()
    setRightStageSessionPersistenceSuspended(false)
    sessionStorage.clear()
  })

  afterEach(() => {
    setRightStageSessionPersistenceSuspended(true)
  })

  it('flush writes the recent sessions into sessionStorage', () => {
    upsertTabInSessionMemory({
      sessionKey: 'persist-a',
      tab: { id: 'primary', kind: 'file', title: 'a.ts', data: { path: 'src/a.ts' } },
    })
    flushRightStageSessionPersistence()
    const raw = sessionStorage.getItem(RIGHT_STAGE_PERSIST_LIMITS.storageKey)
    expect(raw).toBeTruthy()
    expect(raw).toContain('persist-a')
    expect(raw).toContain('src/a.ts')
  })

  it('suspending persistence keeps writes off the storage', () => {
    setRightStageSessionPersistenceSuspended(true)
    upsertTabInSessionMemory({
      sessionKey: 'persist-b',
      tab: { id: 'primary', kind: 'file', data: { path: 'b.ts' } },
    })
    flushRightStageSessionPersistence()
    expect(sessionStorage.getItem(RIGHT_STAGE_PERSIST_LIMITS.storageKey)).toBeNull()
  })
})
