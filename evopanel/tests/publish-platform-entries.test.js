/**
 * 平台条目发布进 Info Rail 时，不得关掉刚打开的工作流/节点进度右栏。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { publishPlatformEntries } from '../src/react/chat-app/right-stage/publish-platform-entries.ts'
import { setChatPanelDisplayMode } from '../src/react/chat-app/right-stage/set-chat-panel-display-mode.ts'
import { rightStageStore } from '../src/lib/right-stage/right-stage-store.ts'

function makeCtx(snapshot) {
  const hide = vi.fn()
  return {
    turnPlatformEntriesRef: { current: [] },
    setTurnPlatformEntries: vi.fn(),
    setSessionPlatformEntries: vi.fn((fn) => (typeof fn === 'function' ? fn([]) : undefined)),
    rightStageHintTimerRef: { current: 0 },
    rightStageStore: {
      getSnapshot: () => snapshot,
      hide,
    },
    setChatPanelDisplayMode: vi.fn(),
    setInfoRailOpen: vi.fn(),
    setInfoRailTab: vi.fn(),
    setPlatformFocusEntryId: vi.fn(),
    latestPlatformRunEntryId: () => 'platform:1',
    _hide: hide,
  }
}

const entry = {
  id: 'platform:1',
  kind: 'success',
  title: '已创建任务',
  appliedAt: Date.now(),
}

describe('publishPlatformEntries', () => {
  it('hides right stage when no protected panel is open', () => {
    const ctx = makeCtx({
      surface: { kind: 'write', id: 'primary' },
      tabs: [{ kind: 'write', id: 'primary' }],
    })
    publishPlatformEntries(ctx, [entry])
    expect(ctx._hide).toHaveBeenCalled()
    expect(ctx.setInfoRailTab).toHaveBeenCalledWith('platform')
  })

  it('keeps collab-workflow open (platform CTA / panel_set progress)', () => {
    const ctx = makeCtx({
      surface: { kind: 'collab-workflow', id: 'workflow:mt-1' },
      tabs: [{ kind: 'collab-workflow', id: 'workflow:mt-1' }],
    })
    publishPlatformEntries(ctx, [entry])
    expect(ctx._hide).not.toHaveBeenCalled()
    expect(ctx.setInfoRailOpen).toHaveBeenCalledWith(true)
    // 仍会切状态卡到「平台」，但 setChatPanelDisplayMode 内部不得 collapse 工作流
    expect(ctx.setChatPanelDisplayMode).toHaveBeenCalledWith('panel')
  })

  it('keeps progress tab even when another surface is active', () => {
    const ctx = makeCtx({
      surface: { kind: 'file', id: 'f1' },
      tabs: [
        { kind: 'collab-workflow', id: 'workflow:mt-1' },
        { kind: 'file', id: 'f1' },
      ],
    })
    publishPlatformEntries(ctx, [entry])
    expect(ctx._hide).not.toHaveBeenCalled()
  })

  it('keeps browser panel open', () => {
    const ctx = makeCtx({
      surface: { kind: 'browser', id: 'browser' },
      tabs: [{ kind: 'browser', id: 'browser' }],
    })
    publishPlatformEntries(ctx, [entry])
    expect(ctx._hide).not.toHaveBeenCalled()
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
