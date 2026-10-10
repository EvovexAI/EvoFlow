import { describe, expect, it } from 'vitest'
import { resolveMessageRowIsStreaming } from '../src/react/lib/message-row-streaming.ts'
import { shouldDropEmptyStreamPlaceholder } from '../src/react/lib/message-row-streaming.ts'

describe('resolveMessageRowIsStreaming', () => {
  it('true only for continued row while stream active', () => {
    expect(resolveMessageRowIsStreaming(2, 2, true)).toBe(true)
    expect(resolveMessageRowIsStreaming(2, 2, false)).toBe(false)
    expect(resolveMessageRowIsStreaming(1, 2, true)).toBe(false)
    expect(resolveMessageRowIsStreaming(2, -1, true)).toBe(false)
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
