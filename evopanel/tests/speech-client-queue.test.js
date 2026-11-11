import { describe, expect, it, beforeEach } from 'vitest'
import {
  advanceSpeechChunk,
  appendStreamingSpeech,
  finalFlushStreamingSpeech,
  hasStreamingSpeechRemaining,
  resetStreamingSpeechQueue,
} from '../src/lib/speech-client.js'

describe('speech-client queue chunking', () => {
  it('splits on sentence punctuation', () => {
    const text = '你好，这是第一句。第二句还在'
    expect(advanceSpeechChunk(text, 0)).toBe(text.indexOf('。') + 1)
  })

  it('does not split short text at comma before enough length', () => {
    const text = '牛市早都结束了，然后还在说后面的内容'
    expect(advanceSpeechChunk(text, 0)).toBe(0)
  })

  it('splits long text without sentence end at phrase boundary', () => {
    const text =
      '这是一段没有任何句号的长文本需要尽早开始播报给用户听并且继续往后延伸直到足够长度可以切分还有更多字'
    const end = advanceSpeechChunk(text, 0)
    expect(end).toBeGreaterThanOrEqual(48)
    expect(end).toBeLessThan(text.length)
  })

  it('waits when buffer is still too short', () => {
    const text = '短文本'
    expect(advanceSpeechChunk(text, 0)).toBe(0)
  })

  it('first-chunk mode splits early at the first comma', () => {
    const text = '好的，我看一下您现在的任务进度情况，然后给您汇报'
    const end = advanceSpeechChunk(text, 0, { first: true })
    expect(end).toBe(text.indexOf('，') + 1)
    expect(end).toBeLessThanOrEqual(14)
  })

  it('first-chunk mode still waits when too short', () => {
    const text = '好的呀'
    expect(advanceSpeechChunk(text, 0, { first: true })).toBe(0)
  })
})

describe('speech-client queue dedup', () => {
  beforeEach(() => {
    resetStreamingSpeechQueue()
  })

  it('does not re-enqueue identical cumulative text', () => {
    appendStreamingSpeech('你好，这是第一句。')
    appendStreamingSpeech('你好，这是第一句。')
    expect(hasStreamingSpeechRemaining('你好，这是第一句。')).toBe(false)
  })

  it('only flushes unplayed tail at final', () => {
    appendStreamingSpeech('你好，这是第一句。')
    // a3363f5a 起返回「final 仍有播报工作」= 新尾巴入队或 kick 未播句：
    // 整句已在流式阶段入队 → final 不重复入队，但测试环境无 TTS、句子未播 → kick 后返回 true。
    expect(finalFlushStreamingSpeech('你好，这是第一句。')).toBe(true)
    // 关键契约：游标到末尾，不得留下重复尾巴。
    expect(hasStreamingSpeechRemaining('你好，这是第一句。')).toBe(false)
  })

  it('final flush plays remainder after partial stream', () => {
    appendStreamingSpeech('你好，这是')
    expect(finalFlushStreamingSpeech('你好，这是第一句。')).toBe(true)
    expect(hasStreamingSpeechRemaining('你好，这是第一句。')).toBe(false)
  })

  it('realigns when stream text is rewritten with same length', () => {
    appendStreamingSpeech('旧前缀内容。')
    appendStreamingSpeech('新前缀内容。')
    // 同长度改写触发 realign（回退游标后重入队新文本）；final 不再重复入队，仅 kick 未播句 → true。
    expect(finalFlushStreamingSpeech('新前缀内容。')).toBe(true)
    expect(hasStreamingSpeechRemaining('新前缀内容。')).toBe(false)
  })
})
