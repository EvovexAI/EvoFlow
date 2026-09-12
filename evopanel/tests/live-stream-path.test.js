import { describe, expect, it } from 'vitest'
import { createRafBatch } from '../src/react/lib/raf-batch.ts'
import {
  applyLiveStreamOverlay,
} from '../src/react/lib/apply-live-stream-overlay.ts'
import {
  clearLiveStream,
  getLiveStreamSnapshot,
  publishLiveStream,
  resetLiveStreamStoreForTests,
  subscribeLiveStream,
} from '../src/react/lib/live-stream-store.ts'

describe('createRafBatch', () => {
  it('coalesces pushes into one flush', async () => {
    const flushes = []
    const batch = createRafBatch((items) => {
      flushes.push([...items])
    })
    batch.push(1)
    batch.push(2)
    batch.push(3)
    expect(flushes).toEqual([])
    await new Promise((r) => setTimeout(r, 20))
    expect(flushes).toEqual([[1, 2, 3]])
    batch.dispose()
  })

  it('drain flushes immediately and cancels scheduled frame', () => {
    const flushes = []
    const batch = createRafBatch((items) => {
      flushes.push([...items])
    })
    batch.push('a')
    batch.drain()
    expect(flushes).toEqual([['a']])
    batch.push('b')
    batch.drain()
    expect(flushes).toEqual([['a'], ['b']])
    batch.dispose()
  })
})

describe('live-stream-store', () => {
  it('publishes and notifies per session', () => {
    resetLiveStreamStoreForTests()
    let n = 0
    const unsub = subscribeLiveStream('s1', () => {
      n += 1
    })
    publishLiveStream('s1', { text: 'hi', streaming: true })
    expect(getLiveStreamSnapshot('s1').text).toBe('hi')
    expect(n).toBe(1)
    publishLiveStream('s1', { text: 'hi' })
    expect(n).toBe(1)
    publishLiveStream('s2', { text: 'other', streaming: true })
    expect(n).toBe(1)
    clearLiveStream('s1')
    expect(getLiveStreamSnapshot('s1').text).toBe('')
    expect(n).toBe(2)
    unsub()
  })

  it('updates snapshot without notifying when no listeners', () => {
    resetLiveStreamStoreForTests()
    let n = 0
    publishLiveStream('bg', { text: 'silent', streaming: true })
    expect(getLiveStreamSnapshot('bg').text).toBe('silent')
    expect(n).toBe(0)
    const unsub = subscribeLiveStream('bg', () => {
      n += 1
    })
    publishLiveStream('bg', { text: 'live', streaming: true })
    expect(n).toBe(1)
    unsub()
  })
})

describe('applyLiveStreamOverlay', () => {
  it('patches trailing text; post-tool reasoning appends a new segment', () => {
    const row = {
      role: '_stream',
      text: 'a',
      reasoningPreview: 'r',
      segments: [
        { kind: 'reasoning', text: 'r' },
        { kind: 'tools', ids: ['t1'] },
        { kind: 'text', text: 'a' },
      ],
      tools: [],
    }
    const out = applyLiveStreamOverlay(row, {
      sessionKey: 's',
      text: 'abc',
      reasoning: 'r2',
      streaming: true,
      epoch: 2,
    })
    expect(out.text).toBe('abc')
    expect(out.reasoningPreview).toBe('r2')
    expect(out.segments?.find((s) => s.kind === 'text')?.text).toBe('abc')
    expect(out.segments?.filter((s) => s.kind === 'reasoning').map((s) => s.text)).toEqual([
      'r',
      'r2',
    ])
    expect(out.tools).toBe(row.tools)
  })

  it('keeps first-round reasoning above body when overlay updates both', () => {
    const row = {
      role: '_stream',
      text: '你好',
      reasoningPreview: '',
      segments: [{ kind: 'text', text: '你好' }],
      tools: [],
    }
    const out = applyLiveStreamOverlay(row, {
      sessionKey: 's',
      text: '你好世界',
      reasoning: '先想清楚再答',
      streaming: true,
      epoch: 1,
    })
    expect(out.segments?.map((s) => s.kind)).toEqual(['reasoning', 'text'])
    expect(out.segments?.[0].text).toBe('先想清楚再答')
    expect(out.segments?.[1].text).toBe('你好世界')
  })

  it('updates same-round reasoning in place when body already follows (no tools)', () => {
    const row = {
      role: '_stream',
      text: '正文',
      reasoningPreview: '想',
      segments: [
        { kind: 'reasoning', text: '想' },
        { kind: 'text', text: '正文' },
      ],
      tools: [],
    }
    const out = applyLiveStreamOverlay(row, {
      sessionKey: 's',
      text: '正文续',
      reasoning: '想完了',
      streaming: true,
      epoch: 2,
    })
    expect(out.segments?.map((s) => s.kind)).toEqual(['reasoning', 'text'])
    expect(out.segments?.[0].text).toBe('想完了')
    expect(out.segments?.[1].text).toBe('正文续')
  })
})
