/**
 * 平台条目发布进 Info Rail 时，不得关掉刚打开的工作流/节点进度右栏。
 * 右栏占宽展开时：不自动撑开摘要卡（优先级：右栏 > 状态通知）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { publishPlatformEntries } from '../src/react/chat-app/right-stage/publish-platform-entries.ts'
import { setChatPanelDisplayMode } from '../src/react/chat-app/right-stage/set-chat-panel-display-mode.ts'
import { rightStageStore } from '../src/lib/right-stage/right-stage-store.ts'

function makeCtx(snapshot) {
  const hide = vi.fn()
  const hideUnlessProgressOpen = vi.fn()
  return {
    turnPlatformEntriesRef: { current: [] },
    setTurnPlatformEntries: vi.fn(),
    setSessionPlatformEntries: vi.fn((fn) => (typeof fn === 'function' ? fn([]) : undefined)),
    rightStageHintTimerRef: { current: 0 },
    rightStageStore: {
      getSnapshot: () => snapshot,
      hide,
      hideUnlessProgressOpen,
    },
    setChatPanelDisplayMode: vi.fn(),
    setInfoRailOpen: vi.fn(),
    setInfoRailTab: vi.fn(),
    setPlatformFocusEntryId: vi.fn(),
    latestPlatformRunEntryId: () => 'platform:1',
    _hide: hide,
    _hideUnless: hideUnlessProgressOpen,
  }
}

const entry = {
  id: 'platform:1',
  kind: 'success',
  title: '已创建任务',
  appliedAt: Date.now(),
}

describe('publishPlatformEntries', () => {
  it('hides right stage when collapsed / no open panel', () => {
    const ctx = makeCtx({
      collapsed: true,
      surface: { kind: 'write', id: 'primary' },
      tabs: [{ kind: 'write', id: 'primary' }],
    })
    publishPlatformEntries(ctx, [entry])
    expect(ctx._hideUnless).toHaveBeenCalled()
    expect(ctx.setChatPanelDisplayMode).toHaveBeenCalledWith('panel')
    expect(ctx.setInfoRailTab).toHaveBeenCalledWith('platform')
  })

  it('skips summary expand when right stage is open (any kind)', () => {
    const ctx = makeCtx({
      collapsed: false,
      surface: { kind: 'file', id: 'f1' },
      tabs: [{ kind: 'file', id: 'f1' }],
    })
    publishPlatformEntries(ctx, [entry])
    expect(ctx._hide).not.toHaveBeenCalled()
    expect(ctx._hideUnless).not.toHaveBeenCalled()
    expect(ctx.setChatPanelDisplayMode).not.toHaveBeenCalled()
    expect(ctx.setInfoRailOpen).not.toHaveBeenCalled()
    // 条目 / focus 仍写入，手动开摘要时能落到平台 tab
    expect(ctx.setPlatformFocusEntryId).toHaveBeenCalledWith('platform:1')
    expect(ctx.setTurnPlatformEntries).toHaveBeenCalled()
  })

  it('keeps collab-workflow open when already expanded (skip summary)', () => {
    const ctx = makeCtx({
      collapsed: false,
      surface: { kind: 'collab-workflow', id: 'workflow:mt-1' },
      tabs: [{ kind: 'collab-workflow', id: 'workflow:mt-1' }],
    })
    publishPlatformEntries(ctx, [entry])
    expect(ctx._hide).not.toHaveBeenCalled()
    expect(ctx.setChatPanelDisplayMode).not.toHaveBeenCalled()
    expect(ctx.setPlatformFocusEntryId).toHaveBeenCalledWith('platform:1')
  })

  it('keeps progress tab even when another surface is active (right open → skip summary)', () => {
    const ctx = makeCtx({
      collapsed: false,
      surface: { kind: 'file', id: 'f1' },
      tabs: [
        { kind: 'collab-workflow', id: 'workflow:mt-1' },
        { kind: 'file', id: 'f1' },
      ],
    })
    publishPlatformEntries(ctx, [entry])
    expect(ctx._hide).not.toHaveBeenCalled()
    expect(ctx.setChatPanelDisplayMode).not.toHaveBeenCalled()
  })

  it('keeps browser panel open (right open → skip summary)', () => {
    const ctx = makeCtx({
      collapsed: false,
      surface: { kind: 'browser', id: 'browser' },
      tabs: [{ kind: 'browser', id: 'browser' }],
    })
    publishPlatformEntries(ctx, [entry])
    expect(ctx._hide).not.toHaveBeenCalled()
    expect(ctx.setChatPanelDisplayMode).not.toHaveBeenCalled()
  })
})

describe('setChatPanelDisplayMode — panel 不得 fold 工作流侧栏', () => {
  beforeEach(() => {
    rightStageStore.hideAll()
  })
  afterEach(() => {
    rightStageStore.hideAll()
  })

  it('collapses right stage when opening panel with no progress tabs', () => {
    const collapseRightStage = vi.fn()
    setChatPanelDisplayMode(
      {
        setChatPanelMode: vi.fn(),
        saveChatSummaryDisplayMode: vi.fn(),
        collapseRightStage,
      },
      'panel',
    )
    expect(collapseRightStage).toHaveBeenCalled()
  })

  it('does not collapse when collab-workflow tab is open', () => {
    rightStageStore.show({
      kind: 'collab-workflow',
      id: 'workflow:mt-1',
      title: '工作流',
      data: { mainTaskId: 'mt-1' },
    })
    const collapseRightStage = vi.fn()
    setChatPanelDisplayMode(
      {
        setChatPanelMode: vi.fn(),
        saveChatSummaryDisplayMode: vi.fn(),
        collapseRightStage,
      },
      'panel',
    )
    expect(collapseRightStage).not.toHaveBeenCalled()
    expect(rightStageStore.getSnapshot().collapsed).toBe(false)
  })
})
