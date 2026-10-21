import { describe, expect, it } from 'vitest'
import {
  resolveGearHostRowIndex,
  resolveMessageRowIsStreaming,
  resolveMessageRowThreadBusy,
  shouldDropEmptyStreamPlaceholder,
} from '../src/react/lib/message-row-streaming.ts'

describe('resolveMessageRowIsStreaming', () => {
  it('true only for continued row while stream active', () => {
    expect(resolveMessageRowIsStreaming(2, 2, true)).toBe(true)
    expect(resolveMessageRowIsStreaming(2, 2, false)).toBe(false)
    expect(resolveMessageRowIsStreaming(1, 2, true)).toBe(false)
    expect(resolveMessageRowIsStreaming(2, -1, true)).toBe(false)
  })
})

describe('resolveMessageRowThreadBusy / resolveGearHostRowIndex（齿轮与停止按钮同源）', () => {
  it('isSending=false → 无齿轮宿主', () => {
    expect(resolveGearHostRowIndex({ isSending: false, streamContinuedRowIndex: 3, continuationTargetIndex: 3 })).toBe(
      -1,
    )
    expect(resolveMessageRowThreadBusy(3, 3, false)).toBe(false)
  })

  it('优先 streamContinuedRowIndex（内容已合并的续写行）', () => {
    expect(
      resolveGearHostRowIndex({ isSending: true, streamContinuedRowIndex: 2, continuationTargetIndex: 5 }),
    ).toBe(2)
    expect(resolveMessageRowThreadBusy(2, 2, true)).toBe(true)
    expect(resolveMessageRowThreadBusy(5, 2, true)).toBe(false)
  })

  it('审批虚流空窗：streamContinued=-1 时退回 incomplete 续写目标，齿轮仍亮', () => {
    // suppressStreamUiAfterSeal 把 streamActive 压掉 → streamContinuedRowIndex=-1，
    // 但 incomplete 审批气泡仍是 continuationTarget → 齿轮必须挂在那里（停止按钮仍亮）。
    expect(
      resolveGearHostRowIndex({ isSending: true, streamContinuedRowIndex: -1, continuationTargetIndex: 4 }),
    ).toBe(4)
    expect(resolveMessageRowThreadBusy(4, 4, true)).toBe(true)
  })

  it('无可续写气泡 → gearHost=-1（由独立 _stream pin 挂齿轮）', () => {
    expect(
      resolveGearHostRowIndex({ isSending: true, streamContinuedRowIndex: -1, continuationTargetIndex: -1 }),
    ).toBe(-1)
  })
})

describe('shouldDropEmptyStreamPlaceholder（多轮新流一闪而过回归）', () => {
  const sealedPriorAssistant = {
    role: 'assistant',
    durationStr: '12秒',
    tokenStr: '1.2k',
    incompleteStream: undefined,
  }

  it('isSending=true（多轮续跑新 run 启动、runId 空窗）时勿清理「运行中」骨架', () => {
    expect(
      shouldDropEmptyStreamPlaceholder(true, true, sealedPriorAssistant, false),
    ).toBe(false)
  })

  it('isSending=false（final 后 streamActive grace 残留）时才清理空占位', () => {
    expect(
      shouldDropEmptyStreamPlaceholder(true, false, sealedPriorAssistant, false),
    ).toBe(true)
  })

  it('上一轮为 incomplete（审批暂停）或无 token/计时时勿清理', () => {
    expect(
      shouldDropEmptyStreamPlaceholder(true, false, { ...sealedPriorAssistant, incompleteStream: true }, false),
    ).toBe(false)
    expect(
      shouldDropEmptyStreamPlaceholder(true, false, { role: 'assistant' }, false),
    ).toBe(false)
  })

  it('上一轮为 user 或已接受续流时勿清理', () => {
    expect(shouldDropEmptyStreamPlaceholder(true, true, { role: 'user' }, false)).toBe(false)
    expect(shouldDropEmptyStreamPlaceholder(true, true, sealedPriorAssistant, true)).toBe(false)
  })

  it('非空占位（有正文/工具/思考）永远不清理', () => {
    expect(shouldDropEmptyStreamPlaceholder(false, true, sealedPriorAssistant, false)).toBe(false)
    expect(shouldDropEmptyStreamPlaceholder(false, false, sealedPriorAssistant, false)).toBe(false)
  })
})
