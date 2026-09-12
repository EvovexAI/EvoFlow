import { describe, expect, it } from 'vitest'
import {
  appendBlockText,
  closeBlockInState,
  collectToolIdsFromBlockState,
  flushOpenTextIntoBlockState,
  parseStreamBlockWire,
  reasoningFromBlockState,
  registerToolEntriesOnBlockState,
  segmentsFromBlockState,
  sortSegmentsBySeq,
  assignMonotonicDisplaySeq,
  enforceSegmentDisplayOrder,
  dedupeToolsTimelineSegments,
} from '../src/react/lib/content-blocks.ts'

describe('content-blocks', () => {
  it('parseStreamBlockWire validates block wire', () => {
    expect(parseStreamBlockWire({ blockId: 'r:b1', blockKind: 'reasoning', seq: 2 })).toEqual({
      blockId: 'r:b1',
      blockKind: 'reasoning',
      seq: 2,
    })
    expect(parseStreamBlockWire({ blockId: '', blockKind: 'reasoning', seq: 1 })).toBeNull()
  })

  it('enforceSegmentDisplayOrder renumbers duplicate wire seq in append order', () => {
    const segs = [
      { kind: 'text', text: 'plan', seq: 1 },
      { kind: 'tools', ids: ['t1'], seq: 2 },
      { kind: 'text', text: 'mid', seq: 3 },
      { kind: 'tools', ids: ['t2'], seq: 2 },
      { kind: 'text', text: 'tail', seq: 4 },
    ]
    const out = enforceSegmentDisplayOrder(segs)
    expect(out.map((s) => s.kind)).toEqual(['text', 'tools', 'text', 'tools', 'text'])
    expect(out.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5])
  })

  it('sortSegmentsBySeq preserves append order when wire seq duplicates across rounds', () => {
    const segs = [
      { kind: 'text', text: 'plan', seq: 1 },
      { kind: 'tools', ids: ['t1'], seq: 2 },
      { kind: 'text', text: 'mid', seq: 3 },
      { kind: 'tools', ids: ['t2'], seq: 2 },
      { kind: 'text', text: 'tail', seq: 4 },
    ]
    expect(sortSegmentsBySeq(segs).map((s) => s.kind)).toEqual([
      'text',
      'tools',
      'text',
      'tools',
      'text',
    ])
  })

  it('assignMonotonicDisplaySeq reindexes in arrival order', () => {
    const segs = [
      { kind: 'text', text: 'a', seq: 1 },
      { kind: 'tools', ids: ['t1'], seq: 2 },
      { kind: 'text', text: 'b', seq: 2 },
    ]
    expect(assignMonotonicDisplaySeq(segs).map((s) => s.seq)).toEqual([1, 2, 3])
  })

  it('dedupeToolsTimelineSegments drops repeated tool ids at tail', () => {
    const segs = [
      { kind: 'text', text: 'plan', seq: 1 },
      { kind: 'tools', ids: ['t1'], seq: 2 },
      { kind: 'text', text: 'mid', seq: 3 },
      { kind: 'tools', ids: ['t2'], seq: 4 },
      { kind: 'text', text: 'tail', seq: 5 },
      { kind: 'tools', ids: ['t1', 't2'], seq: 6 },
      { kind: 'tools', ids: ['t2'], seq: 7 },
    ]
    const out = dedupeToolsTimelineSegments(segs)
    expect(out.map((s) => s.kind)).toEqual(['text', 'tools', 'text', 'tools', 'text'])
    expect(out.filter((s) => s.kind === 'tools').map((s) => s.ids)).toEqual([['t1'], ['t2']])
  })

  it('segmentsFromBlockState preserves seq order', () => {
    const blocks = {
      'r:b1': { id: 'r:b1', kind: 'plan_text', seq: 1, status: 'open', text: 'plan' },
      'r:b2': { id: 'r:b2', kind: 'tools', seq: 2, status: 'open', toolIds: ['t1'] },
      'r:b3': { id: 'r:b3', kind: 'reasoning', seq: 3, status: 'open', text: 'think' },
      'r:b4': { id: 'r:b4', kind: 'body_text', seq: 4, status: 'open', text: 'report' },
    }
    const order = ['r:b4', 'r:b1', 'r:b3', 'r:b2']
    const segs = sortSegmentsBySeq(segmentsFromBlockState(blocks, order))
    expect(segs.map((s) => s.seq)).toEqual([1, 2, 3, 4])
    expect(segs.map((s) => s.kind)).toEqual(['text', 'tools', 'reasoning', 'text'])
  })

  it('reasoningFromBlockState uses last reasoning block only for preview', () => {
    const blocks = {
      a: { id: 'a', kind: 'reasoning', seq: 1, status: 'closed', text: 'first' },
      b: { id: 'b', kind: 'reasoning', seq: 3, status: 'open', text: 'second live' },
    }
    const { segments, preview } = reasoningFromBlockState(blocks, ['a', 'b'])
    expect(segments).toEqual(['first', 'second live'])
    expect(preview).toBe('second live')
  })

  it('appendBlockText merges into block map', () => {
    const wire = { blockId: 'r:b1', blockKind: 'body_text', seq: 4 }
    const s0 = { blocks: {}, blockOrder: [] }
    const s1 = appendBlockText(s0, wire, 'hel')
    const s2 = appendBlockText(s1, wire, 'lo')
    expect(s2.blocks['r:b1'].text).toBe('hello')
    expect(s2.blockOrder).toEqual(['r:b1'])
  })

  it('closeBlockInState marks block closed', () => {
    const wire = { blockId: 'r:b1', blockKind: 'plan_text', seq: 1 }
    const opened = appendBlockText({ blocks: {}, blockOrder: [] }, wire, 'plan')
    const closed = closeBlockInState(opened, wire)
    expect(closed.blocks['r:b1'].status).toBe('closed')
    expect(closed.blocks['r:b1'].text).toBe('plan')
  })

  it('collectToolIdsFromBlockState reads tools block ids', () => {
    const blocks = {
      'r:b2': { id: 'r:b2', kind: 'tools', seq: 2, status: 'open', toolIds: ['t1', 't2'] },
    }
    const ids = collectToolIdsFromBlockState(blocks, ['r:b2'])
    expect([...ids]).toEqual(['t1', 't2'])
  })

  it('flushOpenTextIntoBlockState merges tail into last body block', () => {
    const blocks = {
      'r:b1': { id: 'r:b1', kind: 'plan_text', seq: 1, status: 'closed', text: 'plan' },
      'r:b4': { id: 'r:b4', kind: 'body_text', seq: 4, status: 'open', text: 'rep' },
    }
    const out = flushOpenTextIntoBlockState({
      blocks,
      blockOrder: ['r:b1', 'r:b4'],
      openText: 'ort tail',
    })
    expect(out.openText).toBe('')
    expect(out.blocks['r:b4'].text).toBe('report tail')
  })

  it('flushOpenTextIntoBlockState does not duplicate fully-captured openText (regression: MD breakage)', () => {
    // 真实场景：两个 body block，openText 全量累积且末尾即最后 block 全文
    const blocks = {
      'r:b1': { id: 'r:b1', kind: 'body_text', seq: 1, status: 'closed', text: '开场正文' },
      'r:b3': { id: 'r:b3', kind: 'body_text', seq: 3, status: 'open', text: '## 最终报告\n正文段' },
    }
    const out = flushOpenTextIntoBlockState({
      blocks,
      blockOrder: ['r:b1', 'r:b3'],
      openText: '开场正文\n\n## 最终报告\n正文段',
    })
    expect(out.openText).toBe('')
    // 最后 block 不应被全量 openText 污染：保持自身文本，不重复早段正文
    expect(out.blocks['r:b3'].text).toBe('## 最终报告\n正文段')
  })

  it('flushOpenTextIntoBlockState appends only uncaptured suffix with separator', () => {
    const blocks = {
      'r:b1': { id: 'r:b1', kind: 'body_text', seq: 1, status: 'closed', text: '开场正文' },
      'r:b3': { id: 'r:b3', kind: 'body_text', seq: 3, status: 'open', text: '## 报告标题' },
    }
    const out = flushOpenTextIntoBlockState({
      blocks,
      blockOrder: ['r:b1', 'r:b3'],
      openText: '开场正文\n\n## 报告标题\n后补的未带 wire 尾巴',
    })
    expect(out.openText).toBe('')
    // 只追加 block 未捕获的后缀，且补双换行避免 Markdown 段落硬拼
    expect(out.blocks['r:b3'].text).toBe('## 报告标题\n\n后补的未带 wire 尾巴')
  })

  it('registerToolEntriesOnBlockState creates tools block before any text block', () => {
    const toolsBlock = { blockId: 'run:b2', blockKind: 'tools', seq: 2 }
    const out = registerToolEntriesOnBlockState({ blocks: {}, blockOrder: [] }, [{ id: 't1' }], toolsBlock)
    expect(out.blockOrder).toEqual(['run:b2'])
    expect(out.blocks['run:b2'].toolIds).toEqual(['t1'])
  })
})
