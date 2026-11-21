import { beforeEach, describe, expect, it } from 'vitest'
import { resolveChatPaneMode } from '../src/react/lib/chat-pane-mode.ts'
import {
  mergeOptimisticUserInputRow,
  v4WindowHasUserText,
} from '../src/react/v4/optimisticUserInput.ts'
import {
  isV4DisplayAuthoritative,
  publishV4DisplayAuthority,
} from '../src/react/v4/v4Gate.ts'
import { createConversationTurnRenderUnitsSelector } from '../src/zcode-ui/v4/conversationTurnRenderUnits.ts'
import type { ConversationRow, UserInputRow } from '@zcode/shared/zcode-protocol-v4'

const base = {
  v4Phase: 'connecting' as const,
  localHasRows: false,
  historyLoading: true,
  v4HasRows: false,
  isHomeSurface: false,
  localOptimisticHold: false,
}

describe('resolveChatPaneMode — V4 开启时对话不回落老面板', () => {
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

  it('尚无 thread：默认不当草稿（ensure 在途）；knownEmptyDraft 才居中', () => {
    expect(
      resolveChatPaneMode({
        ...base,
        v4Phase: 'no-thread',
        historyLoading: false,
      }).draftEmpty,
    ).toBe(false)
    expect(
      resolveChatPaneMode({
        ...base,
        v4Phase: 'no-thread',
        historyLoading: false,
        knownEmptyDraft: true,
      }).draftEmpty,
    ).toBe(true)
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

  it('工作台首页走旧壳；v4Phase=disabled 也不再回落主对话老面板', () => {
    expect(resolveChatPaneMode({ ...base, v4Phase: 'disabled' }).useLegacyPane).toBe(false)
    expect(resolveChatPaneMode({ ...base, isHomeSurface: true }).useLegacyPane).toBe(true)
  })

  it('空窗首发乐观 / 有历史乐观：都不回落老面板', () => {
    expect(
      resolveChatPaneMode({
        ...base,
        v4Phase: 'ready',
        localOptimisticHold: true,
      }).useLegacyPane,
    ).toBe(false)
    expect(
      resolveChatPaneMode({
        ...base,
        v4Phase: 'ready',
        localHasRows: true,
        historyLoading: false,
        v4HasRows: true,
        localOptimisticHold: true,
      }).useLegacyPane,
    ).toBe(false)
  })

  it('V4 store failed：仍留在 V4（失败态），不回落老面板', () => {
    const mode = resolveChatPaneMode({
      ...base,
      v4Phase: 'failed',
      localHasRows: true,
      historyLoading: false,
    })
    expect(mode.useLegacyPane).toBe(false)
    expect(mode.draftEmpty).toBe(false)
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

  it('knownEmptyDraft：历史还在加载 / connecting 也按空草稿居中，避免贴底再跳', () => {
    expect(
      resolveChatPaneMode({
        ...base,
        v4Phase: 'connecting',
        historyLoading: true,
        knownEmptyDraft: true,
      }).draftEmpty,
    ).toBe(true)
    expect(
      resolveChatPaneMode({
        ...base,
        v4Phase: 'no-thread',
        historyLoading: true,
        knownEmptyDraft: true,
      }).draftEmpty,
    ).toBe(true)
  })
})

describe('optimistic userInput（发送瞬间不切老面板）', () => {
  function userRow(text: string, rowId = 1): ConversationRow {
    return {
      rowId,
      turnId: `t-${rowId}`,
      kind: 'userInput',
      text,
      origin: 'realUser',
      createdAt: 1,
      createdAtSeq: 0,
    }
  }

  it('v4WindowHasUserText 只认窗口尾部非空 userInput', () => {
    const rows = [userRow('hello'), userRow('world', 2)]
    expect(v4WindowHasUserText(rows, 'world')).toBe(true)
    expect(v4WindowHasUserText(rows, 'hello')).toBe(false)
  })

  it('v4WindowHasUserText 跳过尾部空 userInput，避免误判未 echo', () => {
    const rows = [userRow('hello'), userRow('', 2)]
    expect(v4WindowHasUserText(rows, 'hello')).toBe(true)
    expect(mergeOptimisticUserInputRow(rows, 'hello')).toBe(rows)
  })

  it('mergeOptimisticUserInputRow 缺 echo 时追加，已有则复用原数组', () => {
    const rows = [userRow('old')]
    const next = mergeOptimisticUserInputRow(rows, 'new')
    expect(next).toHaveLength(2)
    expect(next[1]).toMatchObject({ kind: 'userInput', text: 'new' })
    expect(mergeOptimisticUserInputRow(rows, 'old')).toBe(rows)
  })

  it('选择器：send 乐观追加新轮时历史 units 逐项复用（原 tryAppend 快路径）', () => {
    const asUser = (text: string, rowId: number, turnId?: string): UserInputRow => ({
      rowId,
      turnId: turnId || `t-${rowId}`,
      kind: 'userInput',
      text,
      origin: 'realUser',
      createdAt: rowId,
      createdAtSeq: 0,
    })
    const base: ConversationRow[] = [asUser('hello', 1), asUser('world', 2)]
    const select = createConversationTurnRenderUnitsSelector()
    const before = select({ history: base, tail: [] }, { sessionBusy: false })
    expect(before.history).toHaveLength(2)
    expect(before.tail).toHaveLength(0)

    const next = [...base, asUser('搞定了吗', 3, 'optimistic-1')]
    const after = select(
      { history: base, tail: [next[2]!] },
      { sessionBusy: true },
    )
    expect(after.history).toHaveLength(2)
    expect(after.tail).toHaveLength(1)
    // 尾轮出现后历史末项不再是最后一轮（isLastTurn 正确翻转、产生新对象），
    // 其余历史 unit 逐项复用；与原 tryAppend 快路径的复用范围一致。
    for (let i = 0; i < before.history.length - 1; i++) {
      expect(after.history[i]).toBe(before.history[i])
    }
    expect(after.history[1]?.isLastTurn).toBe(false)
    expect(after.tail[0]?.visibleUserInputs[0]?.text).toBe('搞定了吗')
  })
})

describe('V4 display authority（闸门）', () => {
  beforeEach(() => {
    publishV4DisplayAuthority({ threadId: null, live: false })
  })

  it('未发布 live 时不权威，避免错误闸掉 TEXT_*', () => {
    expect(isV4DisplayAuthoritative('t1')).toBe(false)
  })

  it('仅对已 live 的 thread 权威', () => {
    publishV4DisplayAuthority({ threadId: 't1', live: true })
    expect(isV4DisplayAuthoritative('t1')).toBe(true)
    expect(isV4DisplayAuthoritative('t2')).toBe(false)
  })
})
