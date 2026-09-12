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
    expect(finalFlushStreamingSpeech('你好，这是第一句。')).toBe(false)
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
    expect(finalFlushStreamingSpeech('新前缀内容。')).toBe(false)
  })
})
