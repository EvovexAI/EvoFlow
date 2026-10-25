import { describe, expect, it, beforeEach } from 'vitest'
import { RightStageStore, hideRightStageIfKind, rightStageStore } from '../src/lib/right-stage/right-stage-store.js'
import { switchRightStageSession } from '../src/lib/right-stage/right-stage-session-memory.js'
import { setCurrentRightStageSessionKey } from '../src/lib/right-stage/right-stage-scope.js'
import {
  showRightStageCodeViewer,
  showRightStageCodeViewers,
  showRightStageFilePreview,
  showRightStageFromFileLink,
} from '../src/lib/right-stage/open-right-stage-file.js'

describe('RightStageStore multi-tab', () => {
  beforeEach(() => {
    rightStageStore.hideAll()
  })

  it('closeTab only removes one tab', () => {
    const store = new RightStageStore()
    store.show({ kind: 'browser', id: 'primary', title: '浏览器' })
    store.show({ kind: 'workspace-browse', id: 'primary', title: '工作区文件' })
    expect(store.getSnapshot().tabs.map((t) => t.kind)).toEqual(['browser', 'workspace-browse'])
    store.closeTab('browser:primary')
    const snap = store.getSnapshot()
    expect(snap.tabs.map((t) => `${t.kind}:${t.id}`)).toEqual(['workspace-browse:primary'])
    expect(snap.surface?.kind).toBe('workspace-browse')
  })

  it('collapse keeps tabs; hideAll clears and folds', () => {
    const store = new RightStageStore()
    store.show({ kind: 'browser', id: 'primary' })
    expect(store.getSnapshot().collapsed).toBe(false)
    store.collapse()
    expect(store.getSnapshot().collapsed).toBe(true)
    expect(store.getSnapshot().tabs).toHaveLength(1)
    store.expand()
    expect(store.getSnapshot().collapsed).toBe(false)
    store.hideAll()
    const snap = store.getSnapshot()
    expect(snap.tabs).toEqual([])
    expect(snap.collapsed).toBe(true)
    expect(snap.recentClosed.some((e) => e.key === 'browser:primary')).toBe(true)
  })

  it('hideRightStageIfKind does not wipe unrelated tabs', () => {
    rightStageStore.show({ kind: 'browser', id: 'primary' })
    rightStageStore.show({ kind: 'workspace-browse', id: 'primary' })
    hideRightStageIfKind('workspace-browse')
    const snap = rightStageStore.getSnapshot()
    expect(snap.tabs.map((t) => t.kind)).toEqual(['browser'])
    expect(snap.surface?.kind).toBe('browser')
  })

  it('rejects artifacts kind', () => {
    const store = new RightStageStore()
    store.show({ kind: 'artifacts', id: 'primary' })
    expect(store.getSnapshot().tabs).toEqual([])
  })

  it('session switch restores tabs cache', () => {
    rightStageStore.show({ kind: 'browser', id: 'primary' })
    switchRightStageSession('cache-a', 'cache-b')
    expect(rightStageStore.getSnapshot().tabs).toEqual([])
    rightStageStore.show({ kind: 'browser', id: 'secondary' })
    switchRightStageSession('cache-b', 'cache-a')
    const snap = rightStageStore.getSnapshot()
    expect(snap.tabs.map((t) => `${t.kind}:${t.id}`)).toEqual(['browser:primary'])
    expect(snap.collapsed).toBe(false)
  })

  it('workspace-scoped tabs follow across sessions and are not frozen per session', () => {
    rightStageStore.show({ kind: 'workspace-browse', id: 'primary' })
    rightStageStore.show({ kind: 'mind-map', id: 'primary' })
    rightStageStore.show({ kind: 'browser', id: 'primary' })
    // 切到没打开过右栏的会话：workspace 级标签延续，会话级浏览器不跟随。
    switchRightStageSession('ws-a', 'ws-b')
    const afterSwitch = rightStageStore.getSnapshot()
    expect(afterSwitch.tabs.map((t) => t.kind).sort()).toEqual(['mind-map', 'workspace-browse'])
    expect(afterSwitch.collapsed).toBe(false)
    // 切回：浏览器回来，workspace 级不重复插入。
    switchRightStageSession('ws-b', 'ws-a')
    const back = rightStageStore.getSnapshot()
    expect(back.tabs.map((t) => t.kind).sort()).toEqual([
      'browser',
      'mind-map',
      'workspace-browse',
    ])
  })

  it('session-scoped tabs freeze current session when caller omits sessionKey', () => {
    setCurrentRightStageSessionKey('sess-owner')
    rightStageStore.show({ kind: 'file', id: 'a.ts' })
    rightStageStore.show({ kind: 'news-dashboard', id: 'primary' })
    const tabs = rightStageStore.getSnapshot().tabs
    expect(tabs.every((t) => t.sessionKey === 'sess-owner')).toBe(true)
    // workspace 级 kind 不写归属（对所有会话可见）
    rightStageStore.show({ kind: 'workspace-browse', id: 'primary' })
    const workspaceTab = rightStageStore
      .getSnapshot()
      .tabs.find((t) => t.kind === 'workspace-browse')
    expect(workspaceTab?.sessionKey).toBeUndefined()
  })

  it('explicit sessionKey wins over the current UI session', () => {
    setCurrentRightStageSessionKey('sess-owner')
    rightStageStore.show({ kind: 'browser', id: 'primary', sessionKey: 'sess-other' })
    expect(rightStageStore.getSnapshot().tabs[0]?.sessionKey).toBe('sess-other')
  })
})

describe('open-right-stage-file (side pane, not fullscreen modal)', () => {
  beforeEach(() => {
    rightStageStore.hideAll()
  })

  it('opens code viewer half-width in right stage', () => {
    const key = showRightStageCodeViewer(
      { type: 'file', path: 'docs/a.md', title: 'a.md' },
      { sessionKey: 'sess-1', threadId: 'tid-1' },
    )
    const snap = rightStageStore.getSnapshot()
    expect(snap.collapsed).toBe(false)
    expect(snap.activeKey).toBe(key)
    expect(snap.tabs).toHaveLength(1)
    expect(snap.tabs[0]?.kind).toBe('codeViewer')
    expect(snap.tabs[0]?.layout).toBe('half')
    expect(snap.tabs[0]?.sessionKey).toBe('sess-1')
    expect(snap.tabs[0]?.data?.threadId).toBe('tid-1')
  })

  it('batch open activates the first tab', () => {
    showRightStageCodeViewers(
      [
        { type: 'file', path: 'a.md', title: 'a' },
        { type: 'file', path: 'b.md', title: 'b' },
      ],
      { sessionKey: 'sess-1' },
    )
    const snap = rightStageStore.getSnapshot()
    expect(snap.tabs).toHaveLength(2)
    expect(snap.activeKey).toBe('codeViewer:codeViewer:a.md')
  })

  it('file preview opens file kind in right stage', () => {
    const key = showRightStageFilePreview('src/foo.ts', {
      name: 'foo.ts',
      sessionKey: 'sess-2',
    })
    const snap = rightStageStore.getSnapshot()
    expect(key).toBe('file:src/foo.ts')
    expect(snap.collapsed).toBe(false)
    expect(snap.tabs[0]?.kind).toBe('file')
    expect(snap.tabs[0]?.layout).toBe('half')
  })

  it('markdown file link maps to codeViewer source', () => {
    showRightStageFromFileLink(
      { path: 'D:/proj/readme.md', label: 'readme.md', workspacePath: 'D:/proj' },
      { sessionKey: 'sess-3' },
    )
    const snap = rightStageStore.getSnapshot()
    const source = snap.tabs[0]?.data?.source as { type?: string; path?: string }
    expect(source?.type).toBe('file')
    expect(source?.path).toBe('D:/proj/readme.md')
  })

  it('hide() default primary must not close active collab-workflow (RUN_FINISHED bug)', () => {
    const store = new RightStageStore()
    store.show({
      kind: 'collab-workflow',
      id: 'workflow:mt-keep',
      title: '工作流',
      data: { mainTaskId: 'mt-keep' },
    })
    expect(store.getSnapshot().surface?.kind).toBe('collab-workflow')
    // 回合结束路径：applyDecideRightStage → hide() 默认 id=primary
    store.hide()
    const snap = store.getSnapshot()
    expect(snap.tabs).toHaveLength(1)
    expect(snap.tabs[0]?.kind).toBe('collab-workflow')
    expect(snap.collapsed).toBe(false)
  })

  it('hideUnlessProgressOpen keeps workflow and returns false', () => {
    const store = new RightStageStore()
    store.show({
      kind: 'collab-workflow',
      id: 'workflow:mt-2',
      data: { mainTaskId: 'mt-2' },
    })
    expect(store.hideUnlessProgressOpen()).toBe(false)
    expect(store.getSnapshot().tabs.map((t) => t.kind)).toEqual(['collab-workflow'])
  })

  it('hideUnlessProgressOpen closes non-progress panels', () => {
    const store = new RightStageStore()
    store.show({ kind: 'workspace-browse', id: 'primary' })
    expect(store.hideUnlessProgressOpen()).toBe(true)
    expect(store.getSnapshot().tabs).toEqual([])
  })
})

