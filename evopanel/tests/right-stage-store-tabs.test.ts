import { describe, expect, it, beforeEach } from 'vitest'
import { RightStageStore, hideRightStageIfKind, rightStageStore } from '../src/lib/right-stage/right-stage-store.js'
import { switchRightStageSession } from '../src/lib/right-stage/right-stage-session-memory.js'
import { setCurrentRightStageSessionKey } from '../src/lib/right-stage/right-stage-scope.js'
import {
  resolveFileLinkOpenPath,
  showRightStageCodeViewer,
  showRightStageCodeViewers,
  showRightStageFilePreview,
  showRightStageFromFileLink,
} from '../src/lib/right-stage/open-right-stage-file.js'
import { setChatWorkspaceRoot } from '../src/lib/chat-workspace-context.js'

describe('RightStageStore multi-tab', () => {
  beforeEach(() => {
    rightStageStore.hideAll()
    // f31b7138 起 hideAll 会钉住「收起锁」；补一次显式展开，
    // 让 show()/切会话恢复按「用户未锁收起」的语义展开面板。
    rightStageStore.expand()
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
    // type:file 走 file 标签，不再占 codeViewer
    expect(snap.activeKey).toBe('file:a.md')
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

  it('task-center file preview keeps task-center sessionKey and workspaceRoot', () => {
    const key = showRightStageFilePreview(
      'D:/dev/github/EvoFlow/backend/outputs/report.md',
      {
        name: 'report.md',
        sessionKey: 'task-center:task-1',
        workspaceRoot: 'D:/dev/github/EvoFlow/backend/outputs',
      },
    )
    const snap = rightStageStore.getSnapshot()
    expect(key).toBe('file:D:/dev/github/EvoFlow/backend/outputs/report.md')
    expect(snap.tabs[0]?.sessionKey).toBe('task-center:task-1')
    expect(snap.tabs[0]?.data?.workspaceRoot).toBe('D:/dev/github/EvoFlow/backend/outputs')
    expect(snap.collapsed).toBe(false)
  })

  it('patch tabs with different content coexist; same content reuses the tab', () => {
    // 对齐 ZCode：patch sourceKey 含内容指纹。之前同路径新 diff 直接覆盖旧 tab，
    // 看起来像「diff 面板只能打开一个」。
    const keyA = showRightStageCodeViewer(
      { type: 'patch', path: 'src/app.ts', title: 'app.ts', patch: 'line1\nline2' },
      { sessionKey: 'patch-sess' },
    )
    const keyB = showRightStageCodeViewer(
      { type: 'patch', path: 'src/app.ts', title: 'app.ts', patch: 'line1\nCHANGED' },
      { sessionKey: 'patch-sess' },
    )
    expect(keyB).not.toBe(keyA)
    const keyA2 = showRightStageCodeViewer(
      { type: 'patch', path: 'src/app.ts', title: 'app.ts', patch: 'line1\nline2' },
      { sessionKey: 'patch-sess' },
    )
    expect(keyA2).toBe(keyA)
    // file 类型保持 path 复用语义（内容更新刷新到最新 source），不受指纹影响
    const keyFile1 = showRightStageCodeViewer(
      { type: 'file', path: 'a.md', title: 'a.md' },
      { sessionKey: 'patch-sess' },
    )
    const keyFile2 = showRightStageCodeViewer(
      { type: 'file', path: 'a.md', title: 'a.md' },
      { sessionKey: 'patch-sess' },
    )
    expect(keyFile2).toBe(keyFile1)
    rightStageStore.closeTab(keyA)
    rightStageStore.closeTab(keyB)
    rightStageStore.closeTab(keyFile1)
  })

  it('markdown file link maps to file preview tab', () => {
    showRightStageFromFileLink(
      { path: 'D:/proj/readme.md', label: 'readme.md', workspacePath: 'D:/proj' },
      { sessionKey: 'sess-3' },
    )
    const snap = rightStageStore.getSnapshot()
    expect(snap.tabs[0]?.kind).toBe('file')
    expect(snap.tabs[0]?.data?.path).toBe('D:/proj/readme.md')
    expect(snap.tabs[0]?.data?.name).toBe('readme.md')
  })

  it('resolveFileLinkOpenPath joins workspace-relative cite onto session root', () => {
    const opened = resolveFileLinkOpenPath(
      {
        path: 'outputs/clip.mp4',
        relativePath: 'outputs/clip.mp4',
        workspacePath: 'D:/ws',
      },
      'D:/ws',
    )
    expect(opened.workspaceRoot).toBe('D:/ws')
    expect(opened.path.replace(/\\/g, '/')).toBe('D:/ws/outputs/clip.mp4')
  })

  it('absolute path wins; relativePath is only a fallback when path is missing', () => {
    // path 优先：relativePath 可能是展示 label（zcode-ui 渲染层在 workspacePath
    // 缺失时会把 label 填进来）或 workspace 外路径的裸 leaf，采信它会拼出
    // root/<label>、root/<leaf> 这类错误路径。旧 root 的过期绝对路径改由
    // WorkspaceFilePreviewPanel 读文件失败时的 heal 重试纠偏。
    const kept = resolveFileLinkOpenPath(
      {
        path: 'D:/old-root/outputs/clip.mp4',
        relativePath: 'outputs/clip.mp4',
        workspacePath: 'D:/new-root',
      },
      'D:/new-root',
    )
    expect(kept.path.replace(/\\/g, '/')).toBe('D:/old-root/outputs/clip.mp4')

    const rebased = resolveFileLinkOpenPath(
      { relativePath: 'outputs/clip.mp4', workspacePath: 'D:/new-root' },
      'D:/new-root',
    )
    expect(rebased.path.replace(/\\/g, '/')).toBe('D:/new-root/outputs/clip.mp4')
  })

  it('markdown relative cite opens under session workspace root', () => {
    setChatWorkspaceRoot('D:/session-ws')
    showRightStageFromFileLink(
      {
        path: 'outputs/report.md',
        relativePath: 'outputs/report.md',
        label: 'report.md',
      },
      { sessionKey: 'sess-rel' },
    )
    const snap = rightStageStore.getSnapshot()
    expect(snap.tabs[0]?.kind).toBe('file')
    expect(String(snap.tabs[0]?.data?.path || '').replace(/\\/g, '/')).toBe(
      'D:/session-ws/outputs/report.md',
    )
    expect(snap.tabs[0]?.data?.workspaceRoot).toBe('D:/session-ws')
    setChatWorkspaceRoot('')
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

  it('user-activated tab is not stolen by later auto show (screenshot)', () => {
    const store = new RightStageStore()
    store.show({ kind: 'screenshot', id: 'shot-1', title: '截图', data: { uri: 'a.png' } })
    expect(store.getSnapshot().activeKey).toBe('screenshot:shot-1')
    store.show({
      kind: 'shell-page',
      id: 'agent-app',
      title: '应用',
      forceExpand: true,
      data: { page: 'x' },
    })
    expect(store.getSnapshot().activeKey).toBe('shell-page:agent-app')
    // 用户再点应用签钉住（总览 / 标签条同路径）
    store.activateTab('shell-page:agent-app')
    // 后续截图 auto show：只写签，不抢 active
    store.show({ kind: 'screenshot', id: 'shot-2', title: '截图', data: { uri: 'b.png' } })
    expect(store.getSnapshot().tabs.map((t) => `${t.kind}:${t.id}`)).toEqual([
      'screenshot:shot-1',
      'shell-page:agent-app',
      'screenshot:shot-2',
    ])
    expect(store.getSnapshot().activeKey).toBe('shell-page:agent-app')
    // 同签数据刷新也不抢
    store.show({ kind: 'screenshot', id: 'shot-1', title: '截图', data: { uri: 'a2.png' } })
    expect(store.getSnapshot().activeKey).toBe('shell-page:agent-app')
  })

  it('forceExpand show can take focus even when another tab is pinned', () => {
    const store = new RightStageStore()
    store.show({ kind: 'screenshot', id: 'shot-1', forceExpand: true })
    store.activateTab('screenshot:shot-1')
    store.show({ kind: 'xiaomi', id: 'global', title: '小V', forceExpand: true })
    expect(store.getSnapshot().activeKey).toBe('xiaomi:global')
    expect(store.getSnapshot().collapsed).toBe(false)
  })
})

