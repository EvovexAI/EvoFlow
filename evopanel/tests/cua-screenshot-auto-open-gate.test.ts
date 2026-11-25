import { describe, expect, it } from 'vitest'
import { shouldAutoOpenCuaScreenshot } from '../src/lib/right-stage/cua-screenshot-auto-open-gate.js'
import { isRightStageTabVisibleForSession } from '../src/lib/right-stage/right-stage-session-visibility.js'
import type { RightStageSurface } from '../src/lib/right-stage/right-stage-types.js'

describe('cua screenshot auto-open gate', () => {
  it('only opens on the live tail turn', () => {
    expect(shouldAutoOpenCuaScreenshot(true, true)).toBe(true)
  })

  it('never opens for a historical turn (opening an old conversation)', () => {
    // 历史会话的最后一轮 isLastTurn 也是 true —— 这正是串台来源：
    // 打开任何旧会话，它的尾轮截图会被重新开进右栏并打上当前会话的戳。
    expect(shouldAutoOpenCuaScreenshot(true, false)).toBe(false)
    expect(shouldAutoOpenCuaScreenshot(false, true)).toBe(false)
    expect(shouldAutoOpenCuaScreenshot(false, false)).toBe(false)
  })

  it('treats missing/undefined flags as "do not open"', () => {
    expect(shouldAutoOpenCuaScreenshot(undefined, undefined)).toBe(false)
    expect(shouldAutoOpenCuaScreenshot(null, null)).toBe(false)
  })
})

describe('screenshot tab visibility is session-scoped', () => {
  const shotTab: RightStageSurface = {
    id: 'call_aaa',
    kind: 'screenshot',
    title: '截图',
    layout: 'half',
    sessionKey: 'agent:main:A',
    data: { uri: 'http://local/snap/shot-1', mimeType: 'image/png', title: '截图' },
  }

  it('shows inside the session that opened it', () => {
    expect(isRightStageTabVisibleForSession(shotTab, 'agent:main:A')).toBe(true)
  })

  it('does not leak into other sessions', () => {
    expect(isRightStageTabVisibleForSession(shotTab, 'agent:main:B')).toBe(false)
    expect(
      isRightStageTabVisibleForSession(shotTab, 'proactive:personal-assistant:chat:1'),
    ).toBe(false)
  })

  it('screenshot is a session-scoped kind, not workspace-scoped', () => {
    expect(shotTab.kind).toBe('screenshot')
    expect(isRightStageTabVisibleForSession({ ...shotTab, sessionKey: undefined }, '')).toBe(
      false,
    )
  })

  // 【self-evolution-bot · 2026-11-21 · 第105轮】串台第二层根因的回归锁。
  // 归属兜底走 getCurrentRightStageSessionKey()，冷启动/切会话中间态为空串，
  // 于是截图标签无归属落地；旧规则 `if (!tabSk) return true` 把它放行给所有会话。
  it('never leaks a screenshot tab that lost its session ownership', () => {
    const orphan = { ...shotTab, sessionKey: undefined, id: 'call_orphan' }
    expect(isRightStageTabVisibleForSession(orphan, 'agent:main:A')).toBe(false)
    expect(isRightStageTabVisibleForSession(orphan, 'agent:main:B')).toBe(false)
  })

  it('session-scoped tabs without ownership never leak across chats', () => {
    // 旧遗留豁免已撤：file / web-embed 等无归属也不再对所有会话可见。
    const legacyFile: RightStageSurface = {
      id: 'legacy',
      kind: 'file',
      title: '文件',
      layout: 'half',
      data: { path: 'D:/tmp/a.txt' },
    }
    expect(isRightStageTabVisibleForSession(legacyFile, 'agent:main:A')).toBe(false)
    expect(isRightStageTabVisibleForSession(legacyFile, 'agent:main:B')).toBe(false)
  })

  it('workspace-scoped tabs without ownership stay shared', () => {
    const writeTab: RightStageSurface = {
      id: 'primary',
      kind: 'write',
      title: '写入预览',
      layout: 'half',
      data: {},
    }
    expect(isRightStageTabVisibleForSession(writeTab, 'agent:main:A')).toBe(true)
    expect(isRightStageTabVisibleForSession(writeTab, 'agent:main:B')).toBe(true)
  })
})
