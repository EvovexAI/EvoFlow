import { describe, expect, it } from 'vitest'
import {
  buildConversationTurnRenderUnits,
  createConversationTurnRenderUnitsSelector,
} from '../src/zcode-ui/v4/conversationTurnRenderUnits.ts'
import { splitConversationTimelineLiveTail } from '../src/zcode-ui/v4/conversationTimelineLiveTail.ts'
import {
  createConversationTurnNavigatorItemsSelector,
  createConversationTurnNavigatorQueryRowIdsSelector,
} from '../src/zcode-ui/v4/conversationTurnNavigatorHelpers.ts'
import type { ConversationRow } from '@zcode/shared/zcode-protocol-v4'

// 分区化派生管线的关键性质：与整窗 builder 输出逐项相等，但流式帧/时钟 tick 之间
// 历史 unit 与目录成员保持引用身份，下游 memo/virtualizer 不随 token 重建。

function turnHeader(rowId: number, turnId: string, state: 'running' | 'completedSuccess'): ConversationRow {
  return {
    rowId,
    turnId,
    kind: 'turnHeader',
    state,
    startedAt: 1_000 + rowId,
    origin: 'userInput',
    createdAt: rowId,
  } as ConversationRow
}

function userInput(rowId: number, turnId: string, text: string): ConversationRow {
  return {
    rowId,
    turnId,
    kind: 'userInput',
    origin: 'realUser',
    text,
    createdAt: rowId,
  } as ConversationRow
}

function assistantText(
  rowId: number,
  turnId: string,
  text: string,
  state: 'streaming' | 'complete' = 'complete',
): ConversationRow {
  return {
    rowId,
    turnId,
    kind: 'assistantText',
    text,
    state,
    createdAt: rowId,
  } as ConversationRow
}

const OPTIONS = { nowMs: 5_000, sessionBusy: false }

describe('createConversationTurnRenderUnitsSelector', () => {
  it('输出与整窗 builder 逐项相等', () => {
    const rows: ConversationRow[] = [
      turnHeader(1, 't1', 'completedSuccess'),
      userInput(2, 't1', '你好'),
      assistantText(3, 't1', '回答一'),
      turnHeader(4, 't2', 'completedSuccess'),
      userInput(5, 't2', '再来一个问题'),
      assistantText(6, 't2', '回答二'),
    ]
    const select = createConversationTurnRenderUnitsSelector()
    const partitioned = select({ history: rows.slice(0, 3), tail: rows.slice(3) }, OPTIONS)
    const flat = buildConversationTurnRenderUnits(rows, OPTIONS)
    expect([...partitioned.history, ...partitioned.tail]).toEqual(flat)
  })

  it('流式帧只动尾轮：历史 unit 逐项复用，尾轮重 materialize', () => {
    const historyRows: ConversationRow[] = [
      turnHeader(1, 't1', 'completedSuccess'),
      userInput(2, 't1', '你好'),
      assistantText(3, 't1', '回答一'),
    ]
    const tailTurn = 't2'
    const tailBase: ConversationRow[] = [
      turnHeader(4, tailTurn, 'running'),
      userInput(5, tailTurn, '流式问题'),
    ]
    const select = createConversationTurnRenderUnitsSelector()
    const first = select({ history: historyRows, tail: tailBase }, {
      ...OPTIONS,
      sessionBusy: true,
    })
    expect(first.tail).toHaveLength(1)

    const streamed: ConversationRow[] = [...tailBase, assistantText(6, tailTurn, '流式回答', 'streaming')]
    const second = select({ history: historyRows, tail: streamed }, {
      ...OPTIONS,
      sessionBusy: true,
    })
    expect(second.history).toHaveLength(first.history.length)
    for (let i = 0; i < first.history.length; i++) {
      expect(second.history[i]).toBe(first.history[i])
    }
    expect(second.history).toBe(first.history)
    expect(second.tail[0]?.isRunning).toBe(true)
    // 历史 unit 不变、尾轮 unit 内容已更新
    expect(second.tail[0]).not.toBe(first.tail[0])
  })

  it('时钟 tick（nowMs 变化）不重建历史，运行尾轮正常走秒', () => {
    const historyRows: ConversationRow[] = [
      turnHeader(1, 't1', 'completedSuccess'),
      userInput(2, 't1', '你好'),
      assistantText(3, 't1', '回答一'),
    ]
    const tailRows: ConversationRow[] = [
      turnHeader(4, 't2', 'running'),
      userInput(5, 't2', '流式问题'),
    ]
    const select = createConversationTurnRenderUnitsSelector()
    const busy = { sessionBusy: true }
    const first = select({ history: historyRows, tail: tailRows }, { ...OPTIONS, ...busy })
    const tick = select({ history: historyRows, tail: tailRows }, { ...OPTIONS, ...busy, nowMs: 6_000 })
    expect(tick.history).toBe(first.history)
    expect(tick.tail[0]).not.toBe(first.tail[0])
    expect(tick.tail[0]?.isRunning).toBe(true)
  })

  it('sessionBusy 翻转是缓存失效信号：末轮 running 与停止按钮一致', () => {
    const rows: ConversationRow[] = [
      turnHeader(1, 't1', 'running'),
      userInput(2, 't1', '你好'),
      assistantText(3, 't1', '回答中', 'streaming'),
    ]
    const select = createConversationTurnRenderUnitsSelector()
    const busy = select({ history: [], tail: rows }, { ...OPTIONS, sessionBusy: true })
    expect(busy.tail[0]?.isRunning).toBe(true)
    const stopped = select({ history: [], tail: rows }, { ...OPTIONS, sessionBusy: false })
    expect(stopped.tail[0]?.isRunning).toBe(false)
  })

  it('尾轮 unit 被过滤时历史末项按最后一轮重新归一化（tailDropped）', () => {
    const historyRows: ConversationRow[] = [
      turnHeader(1, 't1', 'completedSuccess'),
      userInput(2, 't1', '你好'),
      assistantText(3, 't1', '回答一'),
    ]
    // 只有 turnHeader 的尾轮 → 过滤为空
    const tailRows: ConversationRow[] = [turnHeader(4, 't2', 'completedSuccess')]
    const select = createConversationTurnRenderUnitsSelector()
    const result = select({ history: historyRows, tail: tailRows }, OPTIONS)
    expect(result.tail).toHaveLength(0)
    expect(result.history).toHaveLength(1)
    expect(result.history[0]?.isLastTurn).toBe(true)
    // 历史段 rows 引用不变时，tailDropped 结果也保持引用
    const again = select({ history: historyRows, tail: tailRows }, OPTIONS)
    expect(again.history).toBe(result.history)
  })

  it('空跑占位在尾轮出现真实产出后被撤销（strip 种子跨段生效）', () => {
    const t1 = 'turn-empty'
    const historyRows: ConversationRow[] = [
      turnHeader(1, t1, 'completedSuccess'),
      userInput(2, t1, '第一问'),
      {
        rowId: 3,
        turnId: t1,
        kind: 'assistantText',
        text: '本轮未产出可见回复（空流或过早收尾）。',
        state: 'complete',
        entityId: 'empty-run-1',
        createdAt: 1_000,
      } as ConversationRow,
    ]
    const t2 = 'turn-continue'
    const select = createConversationTurnRenderUnitsSelector()
    // 尾轮只有用户输入、无真实产出 → 占位保留
    const pendingTail: ConversationRow[] = [
      turnHeader(4, t2, 'running'),
      userInput(5, t2, '第二问'),
    ]
    const before = select({ history: historyRows, tail: pendingTail }, {
      ...OPTIONS,
      sessionBusy: true,
    })
    expect(before.history[0]?.assistantTextRows).toHaveLength(1)

    // 尾轮出现真实正文 → 历史段占位被撤
    const withReal: ConversationRow[] = [...pendingTail, assistantText(6, t2, '真实回复', 'streaming')]
    const after = select({ history: historyRows, tail: withReal }, {
      ...OPTIONS,
      sessionBusy: true,
    })
    expect(after.history[0]?.assistantTextRows).toHaveLength(0)
  })
})

describe('splitConversationTimelineLiveTail（位置化）', () => {
  it('最后一轮始终在 normal-flow：Stop 翻转 isRunning 不换容器（同位置同 key）', () => {
    const rows: ConversationRow[] = [
      turnHeader(1, 't1', 'running'),
      userInput(2, 't1', '你好'),
      assistantText(3, 't1', '回答中', 'streaming'),
    ]
    const select = createConversationTurnRenderUnitsSelector()
    const running = select({ history: [], tail: rows }, { ...OPTIONS, sessionBusy: true })
    const stopped = select({ history: [], tail: rows }, { ...OPTIONS, sessionBusy: false })

    const runningSplit = splitConversationTimelineLiveTail(running)
    const stoppedSplit = splitConversationTimelineLiveTail(stopped)
    // 位置化：无论 running 与否，最后一轮都留在 live tail 容器（同 slot 同 key → 不重挂）
    expect(runningSplit.liveUnit?.key).toBe('t1')
    expect(stoppedSplit.liveUnit?.key).toBe('t1')
    expect(stoppedSplit.liveUnitIndex).toBe(runningSplit.liveUnitIndex)
    expect(stoppedSplit.virtualizedUnits).toHaveLength(0)
    expect(runningSplit.virtualizedUnits).toHaveLength(0)
    expect(runningSplit.liveUnit?.isRunning).toBe(true)
    expect(stoppedSplit.liveUnit?.isRunning).toBe(false)
  })

  it('尾轮恰一个 unit 时虚拟列表直接用历史数组（引用在流式帧之间不变）', () => {
    const historyRows: ConversationRow[] = [
      turnHeader(1, 't1', 'completedSuccess'),
      userInput(2, 't1', '你好'),
      assistantText(3, 't1', '回答一'),
    ]
    const tailRows: ConversationRow[] = [
      turnHeader(4, 't2', 'running'),
      userInput(5, 't2', '流式问题'),
    ]
    const select = createConversationTurnRenderUnitsSelector()
    const partition = select({ history: historyRows, tail: tailRows }, { ...OPTIONS, sessionBusy: true })
    const split = splitConversationTimelineLiveTail(partition)
    expect(split.virtualizedUnits).toBe(partition.history)
    expect(split.liveUnitIndex).toBe(1)
  })
})

describe('navigator 选择器', () => {
  const NAV_OPTIONS = {
    assistantEmptyPreview: '(空)',
    assistantRunningPreview: '(运行中)',
    userFallbackPreview: '(消息)',
  }

  it('queryRowIds：尾轮成员不变时保持同一 Set 身份', () => {
    const historyRows: ConversationRow[] = [
      turnHeader(1, 't1', 'completedSuccess'),
      userInput(2, 't1', '第一问'),
      assistantText(3, 't1', '回答一'),
    ]
    const tailRows: ConversationRow[] = [
      turnHeader(4, 't2', 'running'),
      userInput(5, 't2', '流式问题'),
    ]
    const select = createConversationTurnNavigatorQueryRowIdsSelector()
    const selectUnits = createConversationTurnRenderUnitsSelector()
    const first = select(selectUnits({ history: historyRows, tail: tailRows }, { ...OPTIONS, sessionBusy: true }))
    const streamedTail: ConversationRow[] = [...tailRows, assistantText(6, 't2', '流式回答', 'streaming')]
    const second = select(
      selectUnits({ history: historyRows, tail: streamedTail }, { ...OPTIONS, sessionBusy: true }),
    )
    expect(second).toBe(first)
    expect([...first]).toEqual([2, 5])
  })

  it('items：时钟 tick 后尾轮是新 unit 但 preview 值未变 → items 保持引用', () => {
    const historyRows: ConversationRow[] = [
      turnHeader(1, 't1', 'completedSuccess'),
      userInput(2, 't1', '第一问'),
      assistantText(3, 't1', '回答一'),
    ]
    const tailRows: ConversationRow[] = [
      turnHeader(4, 't2', 'running'),
      userInput(5, 't2', '流式问题'),
      assistantText(6, 't2', '流式回答', 'streaming'),
    ]
    const selectItems = createConversationTurnNavigatorItemsSelector()
    const selectUnits = createConversationTurnRenderUnitsSelector()
    const first = selectItems(
      selectUnits({ history: historyRows, tail: tailRows }, { ...OPTIONS, sessionBusy: true }),
      NAV_OPTIONS,
    )
    expect(first).toHaveLength(2)

    // nowMs 前进 → 尾轮 unit 重 materialize（新对象），但目录展示值全部未变
    const second = selectItems(
      selectUnits({ history: historyRows, tail: tailRows }, {
        ...OPTIONS,
        sessionBusy: true,
        nowMs: 6_000,
      }),
      NAV_OPTIONS,
    )
    expect(second).toBe(first)
  })
})
