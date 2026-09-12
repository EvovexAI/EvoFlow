import { describe, expect, it } from 'vitest'
import {
  LIVE_TOOL_ROUND_WINDOW,
  findLatestDisplayRoundStart,
  windowLiveExploringPieces,
} from '../src/react/lib/window-live-exploring-pieces.ts'

function toolsPiece(ids, segIndex) {
  return { kind: 'tools', ids, segIndex }
}

function reasoningPiece(text, segIndex) {
  return { kind: 'reasoning', text, segIndex }
}

function textPiece(text, segIndex) {
  return { kind: 'text', text, segIndex }
}

function toolRow(id, status) {
  return { id, tool_call_id: id, name: 'read_file', status }
}

describe('windowLiveExploringPieces — hard single-round constraint', () => {
  it('exposes default window size of 1', () => {
    expect(LIVE_TOOL_ROUND_WINDOW).toBe(1)
  })

  it('clears prior round when new reasoning appears after tools', () => {
    const pieces = [
      reasoningPiece('old-think', 0),
      toolsPiece(['t0'], 1),
      reasoningPiece('new-think', 2),
    ]
    const result = windowLiveExploringPieces({
      pieces,
      tools: [toolRow('t0', 'ok')],
      isStreaming: true,
    })
    expect(result.visiblePieces.map((p) => `${p.kind}:${p.text || p.ids?.[0]}`)).toEqual([
      'reasoning:new-think',
    ])
    expect(result.hiddenToolIds).toEqual(['t0'])
  })

  it('clears prior round when body appears after tools (no thinking)', () => {
    const pieces = [
      reasoningPiece('old', 0),
      textPiece('old-body', 1),
      toolsPiece(['t0'], 2),
      textPiece('new-body', 3),
    ]
    const result = windowLiveExploringPieces({
      pieces,
      tools: [toolRow('t0', 'ok')],
      isStreaming: true,
    })
    expect(result.visiblePieces.map((p) => `${p.kind}:${p.text}`)).toEqual(['text:new-body'])
    expect(result.hiddenToolIds).toEqual(['t0'])
  })

  it('never stacks body+tools then body+tools', () => {
    const pieces = [
      textPiece('body1', 0),
      toolsPiece(['t0'], 1),
      textPiece('body2', 2),
      toolsPiece(['t1'], 3),
    ]
    const result = windowLiveExploringPieces({
      pieces,
      tools: [toolRow('t0', 'ok'), toolRow('t1', 'ok')],
      isStreaming: true,
    })
    // body2 在工具后出现 → 强制新一轮，上一轮 body1+t0 清空
    expect(result.visiblePieces.map((p) => (p.kind === 'tools' ? p.ids[0] : `${p.kind}:${p.text}`))).toEqual([
      'text:body2',
      't1',
    ])
    expect(result.hiddenToolIds).toEqual(['t0'])
  })

  it('allows one thinking + body + multiple tools in the same round', () => {
    const pieces = [
      reasoningPiece('think', 0),
      textPiece('body', 1),
      toolsPiece(['t0'], 2),
      toolsPiece(['t1'], 3),
      toolsPiece(['t2'], 4),
    ]
    const result = windowLiveExploringPieces({
      pieces,
      tools: [toolRow('t0', 'ok'), toolRow('t1', 'ok'), toolRow('t2', 'running')],
      isStreaming: true,
    })
    expect(result.hiddenToolRoundCount).toBe(0)
    expect(result.visiblePieces).toEqual(pieces)
  })

  it('keeps consecutive tools without new thinking/body in the same round', () => {
    const pieces = [
      reasoningPiece('r0', 0),
      toolsPiece(['t0'], 1),
      toolsPiece(['t1'], 2),
    ]
    const result = windowLiveExploringPieces({
      pieces,
      tools: [toolRow('t0', 'ok'), toolRow('t1', 'running')],
      isStreaming: true,
    })
    expect(result.hiddenToolRoundCount).toBe(0)
    expect(result.visiblePieces).toEqual(pieces)
  })

  it('new thinking then tools replaces previous body+tools unit', () => {
    const pieces = [
      reasoningPiece('old', 0),
      textPiece('old-body', 1),
      toolsPiece(['t0'], 2),
      reasoningPiece('latest-think', 3),
      toolsPiece(['t1'], 4),
      toolsPiece(['t2'], 5),
    ]
    const result = windowLiveExploringPieces({
      pieces,
      isStreaming: true,
    })
    expect(result.hiddenToolIds).toEqual(['t0'])
    expect(result.visiblePieces.map((p) => (p.kind === 'tools' ? p.ids[0] : `${p.kind}:${p.text}`))).toEqual([
      'reasoning:latest-think',
      't1',
      't2',
    ])
  })

  it('findLatestDisplayRoundStart jumps to latest post-tool thinking or body', () => {
    const pieces = [
      reasoningPiece('r0', 0),
      toolsPiece(['t0'], 1),
      textPiece('aside', 2),
      toolsPiece(['t1'], 3),
      reasoningPiece('r2', 4),
      toolsPiece(['t2'], 5),
    ]
    expect(findLatestDisplayRoundStart(pieces)).toBe(4)
  })

  it('with K=3 still respects hard cut at latest post-tool boundary', () => {
    const pieces = [
      reasoningPiece('r0', 0),
      toolsPiece(['t0'], 1),
      reasoningPiece('r1', 2),
      toolsPiece(['t1'], 3),
      textPiece('aside', 4),
      toolsPiece(['t2'], 5),
      reasoningPiece('r2', 6),
      toolsPiece(['t3'], 7),
      toolsPiece(['t4'], 8),
    ]
    const result = windowLiveExploringPieces({
      pieces,
      tools: pieces
        .filter((p) => p.kind === 'tools')
        .flatMap((p) => p.ids.map((id) => toolRow(id, 'ok'))),
      keepLastToolRounds: 3,
      isStreaming: true,
    })
    // 硬切在 r2：上一轮 aside/t2 不得再出现
    expect(result.visiblePieces.map((p) => (p.kind === 'tools' ? p.ids[0] : `${p.kind}:${p.text}`))).toEqual([
      'reasoning:r2',
      't3',
      't4',
    ])
  })

  it('full-history keepLast skips live clipping', () => {
    const pieces = [
      reasoningPiece('r0', 0),
      toolsPiece(['t0'], 1),
      reasoningPiece('r1', 2),
      toolsPiece(['t1'], 3),
    ]
    const result = windowLiveExploringPieces({
      pieces,
      isStreaming: true,
      keepLastToolRounds: 10_000,
    })
    expect(result.visiblePieces).toEqual(pieces)
    expect(result.hiddenToolRoundCount).toBe(0)
  })

  it('force-keeps early running tools', () => {
    const pieces = [
      reasoningPiece('r0', 0),
      toolsPiece(['t0'], 1),
      reasoningPiece('r1', 2),
      toolsPiece(['t1'], 3),
    ]
    const result = windowLiveExploringPieces({
      pieces,
      tools: [toolRow('t0', 'running'), toolRow('t1', 'ok')],
      isStreaming: true,
    })
    expect(result.visiblePieces.some((p) => p.kind === 'tools' && p.ids[0] === 't0')).toBe(true)
    expect(result.visiblePieces.some((p) => p.kind === 'reasoning' && p.text === 'r1')).toBe(true)
  })

  it('does not window when not streaming', () => {
    const pieces = [
      reasoningPiece('r0', 0),
      toolsPiece(['t0'], 1),
      reasoningPiece('r1', 2),
    ]
    const result = windowLiveExploringPieces({
      pieces,
      isStreaming: false,
    })
    expect(result.visiblePieces).toEqual(pieces)
    expect(result.hiddenToolRoundCount).toBe(0)
  })
})
