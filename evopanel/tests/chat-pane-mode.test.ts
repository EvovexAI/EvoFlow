import { describe, expect, it } from 'vitest'
import { resolveChatPaneMode } from '../src/react/lib/chat-pane-mode.ts'

const base = {
  v4Phase: 'connecting' as const,
  localHasRows: false,
  historyLoading: true,
  v4HasRows: false,
  isHomeSurface: false,
  localOptimisticHold: false,
}

describe('resolveChatPaneMode — 坚持 V4，有历史不回落老面板', () => {
  it('打开历史会话、V4 还在 connecting：留在 V4，不显示草稿问候', () => {
    const mode = resolveChatPaneMode(base)
    expect(mode.draftEmpty).toBe(false)
    expect(mode.useLegacyPane).toBe(false)
  })

  it('本地已有历史行但 V4 仍在 connecting：仍留在 V4（不回落老面板）', () => {
    const mode = resolveChatPaneMode({
      ...base,
      localHasRows: true,
      historyLoading: false,
    })
    expect(mode.useLegacyPane).toBe(false)
    expect(mode.draftEmpty).toBe(false)
  })

  it('无 thread 但本地有历史：仍留在 V4（connecting/no-thread 由加载态承接）', () => {
    const mode = resolveChatPaneMode({
      ...base,
      v4Phase: 'no-thread',
      localHasRows: true,
      historyLoading: false,
    })
    expect(mode.useLegacyPane).toBe(false)
    expect(mode.draftEmpty).toBe(false)
  })

  it('V4 ready 空窗但本地有历史：仍留在 V4，不算草稿', () => {
    const mode = resolveChatPaneMode({
      ...base,
      v4Phase: 'ready',
      localHasRows: true,
      historyLoading: false,
      v4HasRows: false,
    })
    expect(mode.useLegacyPane).toBe(false)
    expect(mode.draftEmpty).toBe(false)
  })

  it('历史接口仍在加载且本地尚无行：既不算草稿，也不回落', () => {
    const mode = resolveChatPaneMode({ ...base, v4Phase: 'ready' })
    expect(mode.draftEmpty).toBe(false)
    expect(mode.useLegacyPane).toBe(false)
  })

  it('真正的空草稿（无行、历史加载完、V4 确认无行）才居中问候', () => {
    const mode = resolveChatPaneMode({
      ...base,
      v4Phase: 'ready',
      historyLoading: false,
    })
    expect(mode.draftEmpty).toBe(true)
    expect(mode.useLegacyPane).toBe(false)
  })

  it('尚无 thread 且确认没有本地行：也是新草稿', () => {
    const mode = resolveChatPaneMode({
      ...base,
      v4Phase: 'no-thread',
      historyLoading: false,
    })
    expect(mode.draftEmpty).toBe(true)
  })

  it('V4 已有该会话的行：用 V4 时间线', () => {
    const mode = resolveChatPaneMode({
      ...base,
      v4Phase: 'ready',
      localHasRows: true,
      historyLoading: false,
      v4HasRows: true,
    })
    expect(mode.useLegacyPane).toBe(false)
    expect(mode.draftEmpty).toBe(false)
  })

  it('开关关闭 / 工作台首页 / 乐观气泡等待：才走老面板', () => {
    expect(resolveChatPaneMode({ ...base, v4Phase: 'disabled' }).useLegacyPane).toBe(true)
    expect(resolveChatPaneMode({ ...base, isHomeSurface: true }).useLegacyPane).toBe(true)
    expect(
      resolveChatPaneMode({ ...base, v4Phase: 'ready', localOptimisticHold: true }).useLegacyPane,
    ).toBe(true)
  })

  it('乐观等待期间绝不出草稿问候', () => {
    const mode = resolveChatPaneMode({
      ...base,
      v4Phase: 'ready',
      historyLoading: false,
      localOptimisticHold: true,
    })
    expect(mode.draftEmpty).toBe(false)
  })
})
