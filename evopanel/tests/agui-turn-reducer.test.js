import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EventSchemas } from '@ag-ui/core'
import {
  applyAgUiEvent,
  drainAgUiCompletedRound,
  emptyAgUiTurnState,
  projectAgUiToStreamTurnFields,
  replayAgUiEvents,
  timelineWithOpenAgUiAssistantText,
  timelineWithOpenAgUiReasoning,
  shouldReleaseAgUiBufferBeforeToolStart,
  finalizeGhostRunningToolsBeforeNewRound,
} from '../src/react/lib/agui-turn-reducer.ts'
import { aguiSlotsToBubbleSlots, projectAgUiTurnDisplay } from '../src/react/lib/agui-turn-projection.ts'

const __dir = dirname(fileURLToPath(import.meta.url))

function loadGoldenEvents(name) {
  const raw = readFileSync(join(__dir, 'fixtures', 'agui', name), 'utf8')
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => EventSchemas.parse(JSON.parse(l)))
}

describe('applyAgUiEvent', () => {
  it('TOOL_CALL_START creates args phase tool with placeholder compat', () => {
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, {
      type: 'TOOL_CALL_START',
      toolCallId: 'c1',
      toolCallName: 'web_search',
    })
    const tc = s.toolCalls.get('c1')
    expect(tc?.phase).toBe('args')
    expect(s.compatTools.length).toBe(1)
  })

  it('write TOOL_CALL_ARGS extracts target_file into _writeProgress.path', () => {
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, {
      type: 'TOOL_CALL_START',
      toolCallId: 'c-write',
      toolCallName: 'write_to_file',
    })
    s = applyAgUiEvent(s, {
      type: 'TOOL_CALL_ARGS',
      toolCallId: 'c-write',
      delta: '{"target_file":"evopanel/src/App.tsx","content":"export ',
    })
    const tc = s.toolCalls.get('c-write')
    expect(String(tc?._writeProgress?.path || '')).toBe('evopanel/src/App.tsx')
    expect(String(tc?._writeProgress?.content || '')).toContain('export')
    const row = s.compatTools.find((t) => t && t.id === 'c-write')
    expect(String(row?._writeProgress?.path || '')).toBe('evopanel/src/App.tsx')
  })

  it('REASONING_MESSAGE_CONTENT preserves spaces between deltas', () => {
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_START', messageId: 'rm1' })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_CONTENT', messageId: 'rm1', delta: 'Good' })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_CONTENT', messageId: 'rm1', delta: ', mind' })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_CONTENT', messageId: 'rm1', delta: ' map setup' })
    expect(s.messages.get('rm1')?.content).toBe('Good, mind map setup')
  })

  it('TEXT_MESSAGE_CONTENT keeps standalone newline deltas for markdown paragraphs', () => {
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, { type: 'TEXT_MESSAGE_START', messageId: 'b1', role: 'assistant' })
    for (const delta of ['实际发现的问题', '：', '\n\n', '**', '问题', ' |']) {
      s = applyAgUiEvent(s, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'b1', delta })
    }
    expect(s.messages.get('b1')?.content).toBe('实际发现的问题：\n\n**问题 |')
  })

  it('REASONING_MESSAGE_CONTENT ignores cumulative replay instead of doubling', () => {
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_START', messageId: 'rm1' })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_CONTENT', messageId: 'rm1', delta: '用户在问' })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_CONTENT', messageId: 'rm1', delta: '用户在问当前' })
    expect(s.messages.get('rm1')?.content).toBe('用户在问当前')
  })

  it('REASONING_MESSAGE_CONTENT ignores duplicate punctuation delta replay', () => {
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_START', messageId: 'rm1' })
    const deltas = [
      'The',
      ' user',
      ' wants',
      ' me',
      ' to',
      ' create',
      ' a',
      ' new',
      ' temporary',
      ' file',
      ',',
      ',',
      ' then',
      ' delete',
      ' it',
      '.',
      '.',
      ' Simple',
      ' two',
      '-step',
      ' process',
      '.',
      '.',
    ]
    for (const delta of deltas) {
      s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_CONTENT', messageId: 'rm1', delta })
    }
    expect(s.messages.get('rm1')?.content).toBe(
      'The user wants me to create a new temporary file, then delete it. Simple two-step process.',
    )
  })

  it('projectAgUiToStreamTurnFields exposes open reasoning before message end', () => {
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_START', messageId: 'rm1' })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_CONTENT', messageId: 'rm1', delta: 'streaming' })
    const proj = projectAgUiToStreamTurnFields(s)
    expect(proj.timeline).toHaveLength(1)
    expect(proj.timeline[0].kind).toBe('reasoning')
    expect(proj.reasoningPreview).toBe('streaming')
  })

  it('timelineWithOpenAgUiReasoning injects live reasoning into compat timeline', () => {
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_START', messageId: 'rm1' })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_CONTENT', messageId: 'rm1', delta: 'live think' })
    const live = timelineWithOpenAgUiReasoning(projectAgUiToStreamTurnFields(s).timeline, s)
    expect(live).toHaveLength(1)
    expect(live[0].kind).toBe('reasoning')
    expect(live[0].text).toBe('live think')
  })

  it('timelineWithOpenAgUiReasoning inserts before body when text closed first (no tools)', () => {
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_START', messageId: 'rm1' })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_CONTENT', messageId: 'rm1', delta: '分析用户意图' })
    // compat 投影短暂只有已封存正文、开放思考尚未写入 segment 的竞态
    const closed = [{ kind: 'text', text: '你好世界' }]
    const live = timelineWithOpenAgUiReasoning(closed, s)
    expect(live.map((seg) => seg.kind)).toEqual(['reasoning', 'text'])
    expect(live[0].text).toContain('分析')
  })

  it('does not promote sequenced tools ahead of earlier unsequenced reasoning', () => {
    let s = emptyAgUiTurnState('r1', 't1')
    // Bridge-style reasoning START/CONTENT: no wire seq
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_START', messageId: 'rm1', role: 'reasoning' })
    s = applyAgUiEvent(s, {
      type: 'REASONING_MESSAGE_CONTENT',
      messageId: 'rm1',
      delta: '先想清楚再调工具',
    })
    // Later ASGI tool batch carries seq — must not jump before reasoning
    s = applyAgUiEvent(s, {
      type: 'TOOL_CALL_START',
      toolCallId: 'c1',
      toolCallName: 'read_file',
      blockId: 'run:b2',
      blockKind: 'tools',
      seq: 2,
    })
    expect(s.order.map((e) => e.kind)).toEqual(['reasoning', 'tool'])
    const kinds = s.compatSegments.map((seg) => seg.kind)
    expect(kinds).toEqual(['reasoning', 'tools'])
    const live = timelineWithOpenAgUiReasoning(projectAgUiToStreamTurnFields(s).timeline, s)
    expect(live.map((seg) => seg.kind)).toEqual(['reasoning', 'tools'])
  })

  it('updates reasoning order seq from CONTENT when START lacked meta', () => {
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_START', messageId: 'rm1', role: 'reasoning' })
    s = applyAgUiEvent(s, {
      type: 'REASONING_MESSAGE_CONTENT',
      messageId: 'rm1',
      delta: 'think',
      blockId: 'run:b1',
      blockKind: 'reasoning',
      seq: 1,
    })
    s = applyAgUiEvent(s, {
      type: 'TOOL_CALL_START',
      toolCallId: 'c1',
      toolCallName: 'grep',
      blockId: 'run:b2',
      blockKind: 'tools',
      seq: 2,
    })
    expect(s.order.find((e) => e.kind === 'reasoning')?.seq).toBe(1)
    expect(s.compatSegments.map((seg) => seg.kind)).toEqual(['reasoning', 'tools'])
  })

  it('timelineWithOpenAgUiReasoning matches segment by blockId when id differs from messageId', () => {
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, {
      type: 'REASONING_MESSAGE_START',
      messageId: 'rm1',
      role: 'reasoning',
      blockId: 'blk-r1',
      blockKind: 'reasoning',
      seq: 1,
    })
    s = applyAgUiEvent(s, {
      type: 'REASONING_MESSAGE_CONTENT',
      messageId: 'rm1',
      delta: 'streaming think',
      blockId: 'blk-r1',
      blockKind: 'reasoning',
      seq: 1,
    })
    s = applyAgUiEvent(s, {
      type: 'TOOL_CALL_START',
      toolCallId: 'c1',
      toolCallName: 'read',
      blockId: 'blk-t1',
      blockKind: 'tools',
      seq: 2,
    })
    const live = timelineWithOpenAgUiReasoning(projectAgUiToStreamTurnFields(s).timeline, s)
    expect(live.map((seg) => seg.kind)).toEqual(['reasoning', 'tools'])
    expect(live.filter((seg) => seg.kind === 'reasoning')).toHaveLength(1)
    expect(live[0].text).toBe('streaming think')
  })

  it('keeps post-tool tools in a separate batch while reasoning is still open', () => {
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_START', messageId: 'r1' })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r1', delta: 'round1 think' })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_END', messageId: 'r1' })
    s = applyAgUiEvent(s, { type: 'TOOL_CALL_START', toolCallId: 't1', toolCallName: 'grep' })
    s = applyAgUiEvent(s, { type: 'TOOL_CALL_START', toolCallId: 't2', toolCallName: 'read' })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_START', messageId: 'r2' })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r2', delta: 'between batches' })
    s = applyAgUiEvent(s, { type: 'TOOL_CALL_START', toolCallId: 't3', toolCallName: 'rg' })
    const kinds = s.compatSegments.map((seg) => seg.kind)
    expect(kinds).toEqual(['reasoning', 'tools', 'reasoning', 'tools'])
    const batch1 = s.compatSegments.find((seg) => seg.kind === 'tools' && seg.ids?.includes('t1'))
    const batch2 = s.compatSegments.find((seg) => seg.kind === 'tools' && seg.ids?.includes('t3'))
    expect(batch1?.ids).toEqual(['t1', 't2'])
    expect(batch2?.ids).toEqual(['t3'])
    const live = timelineWithOpenAgUiReasoning(projectAgUiToStreamTurnFields(s).timeline, s)
    expect(live.map((seg) => seg.kind)).toEqual(['reasoning', 'tools', 'reasoning', 'tools'])
    const r2Idx = live.findIndex((seg) => seg.kind === 'reasoning' && seg.id === 'r2')
    const t3Idx = live.findIndex((seg) => seg.kind === 'tools' && seg.ids?.includes('t3'))
    expect(r2Idx).toBeGreaterThan(0)
    expect(t3Idx).toBeGreaterThan(r2Idx)
  })

  it('ghost running tool (lost TOOL_CALL_RESULT) is finalized and sealed before new round', () => {
    // 场景：t1 的 RESULT 正常到达；t2 的 RESULT 丢失（phase 卡在 running）。
    // 新一轮 TOOL_CALL_START(t3) 到来时：
    // 1. finalizeGhostRunningToolsBeforeNewRound 把 t2 收尾为 done
    // 2. drain 封存 t1 + t2，之后 t3 才 apply 进 fresh —— t2 不再以「调用中」悬挂
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_START', messageId: 'r1' })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r1', delta: 'round1' })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_END', messageId: 'r1' })
    s = applyAgUiEvent(s, { type: 'TOOL_CALL_START', toolCallId: 't1', toolCallName: 'read' })
    s = applyAgUiEvent(s, { type: 'TOOL_CALL_RESULT', toolCallId: 't1', content: 'ok' })
    s = applyAgUiEvent(s, { type: 'TOOL_CALL_START', toolCallId: 't2', toolCallName: 'search' })
    s = applyAgUiEvent(s, { type: 'TOOL_CALL_END', toolCallId: 't2' })
    // t2 RESULT 丢失 → phase 停留 running，显示「调用中」
    expect(s.toolCalls.get('t2')?.phase).toBe('running')

    const startNewRound = { type: 'TOOL_CALL_START', toolCallId: 't3', toolCallName: 'rg' }
    expect(shouldReleaseAgUiBufferBeforeToolStart(s, startNewRound)).toBe(true)
    finalizeGhostRunningToolsBeforeNewRound(s)
    expect(s.toolCalls.get('t2')?.phase).toBe('done')
    // compat 投影已重建：t2 status 从 running → ok，不再显示「调用中」光标
    const t2Row = s.compatTools.find((t) => t && t.id === 't2')
    expect(String(t2Row?.status || '')).toBe('ok')

    // 真实时序：drain 在 apply 新 START 之前（ChatApp 顺序）
    const { sealed, fresh } = drainAgUiCompletedRound(s)
    const sealedIds = sealed?.tools?.map((t) => t?.id)
    expect(sealedIds).toEqual(['t1', 't2'])
    // drain 后旧工具全部离开 fresh；t3 apply 进来后 fresh 只有 t3
    expect(fresh.toolCalls.size).toBe(0)
    const s2 = applyAgUiEvent(fresh, startNewRound)
    expect(s2.toolCalls.size).toBe(1)
    expect(s2.toolCalls.has('t3')).toBe(true)
    expect(s2.compatTools.map((t) => t?.id)).toEqual(['t3'])
  })

  it('shouldReleaseAgUiBufferBeforeToolStart releases on new tool blockId even when no done tool', () => {
    // 场景：整批工具的 RESULT 全部丢失（无任何 done 工具）。
    // 新一轮 TOOL_CALL_START 携带新 blockId → 仍应释放缓冲（否则永不释放）。
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_START', messageId: 'r1' })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_END', messageId: 'r1' })
    s = applyAgUiEvent(s, {
      type: 'TOOL_CALL_START',
      toolCallId: 't1',
      toolCallName: 'read',
      blockId: 'run:b2',
      blockKind: 'tools',
      seq: 2,
    })
    // t1 RESULT 丢失；新一轮工具 t2 使用新 blockId
    const newRoundEvent = {
      type: 'TOOL_CALL_START',
      toolCallId: 't2',
      toolCallName: 'rg',
      blockId: 'run:b4',
      blockKind: 'tools',
      seq: 4,
    }
    expect(shouldReleaseAgUiBufferBeforeToolStart(s, newRoundEvent)).toBe(true)
    finalizeGhostRunningToolsBeforeNewRound(s)
    // 真实时序：drain 在 apply 新 START 之前（ChatApp 顺序）
    const { sealed, fresh } = drainAgUiCompletedRound(s)
    expect(sealed?.tools?.map((t) => t?.id)).toEqual(['t1'])
    const s2 = applyAgUiEvent(fresh, newRoundEvent)
    expect(s2.toolCalls.has('t2')).toBe(true)
  })

  it('shouldReleaseAgUiBufferBeforeToolStart keeps same blockId batch unreleased (parallel tools)', () => {
    // 并行同批工具共享 blockId：中间 START 不得触发误封存正在执行的同批工具。
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_START', messageId: 'r1' })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_END', messageId: 'r1' })
    s = applyAgUiEvent(s, {
      type: 'TOOL_CALL_START',
      toolCallId: 't1',
      toolCallName: 'find',
      blockId: 'run:b2',
      blockKind: 'tools',
      seq: 2,
    })
    s = applyAgUiEvent(s, { type: 'TOOL_CALL_RESULT', toolCallId: 't1', content: 'ok' })
    const parallelPeer = {
      type: 'TOOL_CALL_START',
      toolCallId: 't2',
      toolCallName: 'rg',
      blockId: 'run:b2',
      blockKind: 'tools',
      seq: 2,
    }
    // 同批并行 peer 到达时：ChatApp 侧在 apply START 之前做 ghost 收尾 + drain，
    // 只封存已 done 的 t1；t2 尚未 apply，不会被封存也不会被误标 done。
    expect(shouldReleaseAgUiBufferBeforeToolStart(s, parallelPeer)).toBe(true)
    finalizeGhostRunningToolsBeforeNewRound(s)
    const { sealed } = drainAgUiCompletedRound(s)
    expect(sealed?.tools?.map((t) => t?.id)).toEqual(['t1'])
  })

  it('drainAgUiCompletedRound seals only done tools and keeps interleaved reasoning slots', () => {
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_START', messageId: 'r1' })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r1', delta: 'round1' })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_END', messageId: 'r1' })
    s = applyAgUiEvent(s, { type: 'TOOL_CALL_START', toolCallId: 't1', toolCallName: 'read' })
    s = applyAgUiEvent(s, { type: 'TOOL_CALL_RESULT', toolCallId: 't1', content: 'ok' })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_START', messageId: 'r2' })
    // 真实时序：ChatApp 在 apply 新 TOOL_CALL_START 之前 drain —— 此时
    // state 里只有旧轮内容（r2 open reasoning + t1 done）。
    const { sealed, fresh } = drainAgUiCompletedRound(s)
    expect(sealed?.segments?.map((seg) => seg.kind)).toEqual(['reasoning', 'tools'])
    expect(sealed?.segments?.find((seg) => seg.kind === 'tools')?.ids).toEqual(['t1'])
    // r2 是 open reasoning，留在 fresh
    expect(fresh.compatSegments.map((seg) => seg.kind)).toEqual(['reasoning'])
    s = fresh
    s = applyAgUiEvent(s, { type: 'TOOL_CALL_START', toolCallId: 't2', toolCallName: 'rg' })
    expect(s.compatSegments.find((seg) => seg.kind === 'tools')?.ids).toEqual(['t2'])
  })

  it('drainAgUiCompletedRound seals incrementally across multiple tool rounds', () => {
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_START', messageId: 'r1' })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r1', delta: 'think1' })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_END', messageId: 'r1' })
    s = applyAgUiEvent(s, { type: 'TOOL_CALL_START', toolCallId: 't1', toolCallName: 'read' })
    s = applyAgUiEvent(s, { type: 'TOOL_CALL_RESULT', toolCallId: 't1', content: 'a' })
    const first = drainAgUiCompletedRound(s)
    expect(first.sealed?.segments?.map((seg) => seg.kind)).toEqual(['reasoning', 'tools'])
    s = first.fresh
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_START', messageId: 'r2' })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r2', delta: 'think2' })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_END', messageId: 'r2' })
    s = applyAgUiEvent(s, { type: 'TOOL_CALL_START', toolCallId: 't2', toolCallName: 'rg' })
    s = applyAgUiEvent(s, { type: 'TOOL_CALL_RESULT', toolCallId: 't2', content: 'b' })
    const second = drainAgUiCompletedRound(s)
    expect(second.sealed?.segments?.map((seg) => seg.kind)).toEqual(['reasoning', 'tools'])
    expect(second.sealed?.segments?.find((seg) => seg.kind === 'tools')?.ids).toEqual(['t2'])
    s = second.fresh
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_START', messageId: 'r3' })
    s = applyAgUiEvent(s, { type: 'TOOL_CALL_START', toolCallId: 't3', toolCallName: 'write' })
    const merged = [
      ...(first.sealed?.segments || []),
      ...(second.sealed?.segments || []),
      ...s.compatSegments,
    ]
    expect(merged.map((seg) => seg.kind)).toEqual([
      'reasoning',
      'tools',
      'reasoning',
      'tools',
      'reasoning',
      'tools',
    ])
  })

  it('projectAgUiToStreamTurnFields exposes open assistant text before message end', () => {
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, { type: 'TEXT_MESSAGE_START', messageId: 'b1', role: 'assistant' })
    s = applyAgUiEvent(s, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'b1', delta: 'hello' })
    const proj = projectAgUiToStreamTurnFields(s)
    expect(proj.timeline).toHaveLength(0)
    expect(proj.openText).toBe('hello')
  })

  it('TEXT_MESSAGE_CONTENT without START still enters order so body shows after tools', () => {
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, {
      type: 'TOOL_CALL_START',
      toolCallId: 'c1',
      toolCallName: 'platform',
      blockId: 'run:b2',
      blockKind: 'tools',
      seq: 2,
    })
    s = applyAgUiEvent(s, {
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'b3',
      delta: '本轮值班结束。',
      blockId: 'run:b3',
      blockKind: 'body_text',
      seq: 3,
    })
    expect(s.order.some((e) => e.kind === 'text' && e.messageId === 'b3')).toBe(true)
    const proj = projectAgUiToStreamTurnFields(s)
    expect(proj.openText).toContain('本轮值班结束')
    const timeline = timelineWithOpenAgUiAssistantText(proj.timeline, s)
    expect(timeline.some((seg) => seg.kind === 'text' && String(seg.text).includes('本轮值班结束'))).toBe(
      true,
    )
  })

  it('TEXT_MESSAGE_CONTENT ignores duplicate single-char delta replay', () => {
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, { type: 'TEXT_MESSAGE_START', messageId: 'b1', role: 'assistant' })
    for (const delta of ['已', '已', '删', '删', '除', '除']) {
      s = applyAgUiEvent(s, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'b1', delta })
    }
    expect(projectAgUiToStreamTurnFields(s).openText).toBe('已删除')
  })

  it('TOOL_CALL_ARGS updates args preview', () => {
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'grep' })
    s = applyAgUiEvent(s, { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '{"query":"foo"}' })
    expect(s.toolCalls.get('c1')?.argsPreview).toContain('query=foo')
  })

  it('interleaves reasoning tool text in order', () => {
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_START', messageId: 'r1', role: 'reasoning' })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r1', delta: 'think' })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_END', messageId: 'r1' })
    s = applyAgUiEvent(s, { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'grep' })
    s = applyAgUiEvent(s, { type: 'TEXT_MESSAGE_START', messageId: 'b1', role: 'assistant' })
    s = applyAgUiEvent(s, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'b1', delta: 'hi' })
    expect(s.order.map((e) => e.kind)).toEqual(['reasoning', 'tool', 'text'])
    const view = projectAgUiTurnDisplay(s, { isStreaming: true })
    const kinds = view.slots.map((sl) => sl.kind)
    expect(kinds.indexOf('tool-card')).toBeLessThan(kinds.indexOf('text-block'))
    const slots = aguiSlotsToBubbleSlots(view)
    expect(slots.some((x) => x.kind === 'tool-row')).toBe(true)
    // 无后端 activity 时不展示兜底状态行
    expect(slots.some((x) => x.kind === 'thinking-wait')).toBe(false)
  })

  it('streaming bubble appends thinking-wait only when backend pushes activity', () => {
    let s = emptyAgUiTurnState('r1', 't1')
    // 1) 完全空白：流式开始，无 activity → 无状态行
    let view = projectAgUiTurnDisplay(s, { isStreaming: true })
    let slots = aguiSlotsToBubbleSlots(view)
    expect(slots.length).toBe(0)

    // 2) 后端推送 activity：状态行贴底
    s = applyAgUiEvent(s, {
      type: 'ACTIVITY_SNAPSHOT',
      content: { detail: '调用：web_search' },
    })
    view = projectAgUiTurnDisplay(s, { isStreaming: true })
    slots = aguiSlotsToBubbleSlots(view)
    expect(slots.length).toBe(1)
    expect(slots[slots.length - 1].kind).toBe('thinking-wait')
    expect(slots[slots.length - 1].label).toContain('web_search')

    // 3) 正文流入：状态行依旧贴底
    s = applyAgUiEvent(s, { type: 'TEXT_MESSAGE_START', messageId: 'b1', role: 'assistant' })
    s = applyAgUiEvent(s, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'b1', delta: 'hello' })
    view = projectAgUiTurnDisplay(s, { isStreaming: true })
    slots = aguiSlotsToBubbleSlots(view)
    expect(slots[slots.length - 1].kind).toBe('thinking-wait')

    // 4) 流式结束：状态行被移除
    s = applyAgUiEvent(s, { type: 'TEXT_MESSAGE_END', messageId: 'b1' })
    s = applyAgUiEvent(s, { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' })
    view = projectAgUiTurnDisplay(s, { isStreaming: false })
    slots = aguiSlotsToBubbleSlots(view)
    expect(slots.some((x) => x.kind === 'thinking-wait')).toBe(false)
  })

  it('MESSAGES_SNAPSHOT hydrates closed assistant + reasoning segments', () => {
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, { type: 'TEXT_MESSAGE_START', messageId: 'b2', role: 'assistant' })
    s = applyAgUiEvent(s, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'b2', delta: '你好' })
    s = applyAgUiEvent(s, {
      type: 'MESSAGES_SNAPSHOT',
      messages: [
        { id: 'b1', role: 'reasoning', content: 'think' },
        { id: 'b2', role: 'assistant', content: '你好！有什么可以帮到你的吗？' },
      ],
    })
    const proj = projectAgUiToStreamTurnFields(s)
    expect(proj.timeline).toHaveLength(2)
    expect(proj.timeline.some((seg) => seg.kind === 'text' && seg.text.includes('你好'))).toBe(true)
    expect(proj.openText).toBe('')
  })

  it('TOOL_CALL_RESULT preserves truncated meta for lazy-load tools', () => {
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'read' })
    s = applyAgUiEvent(s, {
      type: 'TOOL_CALL_RESULT',
      toolCallId: 'c1',
      content: '',
      truncated: true,
      content_bytes: 4096,
    })
    const tool = s.compatTools.find((t) => t && t.id === 'c1')
    expect(tool?.output_truncated).toBe(true)
    expect(tool?.content_bytes).toBe(4096)
  })

  it('TOOL_CALL_RESULT pending_approval is not downgraded to ok', () => {
    const pending = JSON.stringify({
      _evoflow_tool: { status: 'pending_approval' },
      approval: { tool_name: 'delete', tool_call_id: 'c-del', summary: 'outputs/x' },
    })
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, { type: 'TOOL_CALL_START', toolCallId: 'c-del', toolCallName: 'delete' })
    s = applyAgUiEvent(s, {
      type: 'TOOL_CALL_RESULT',
      toolCallId: 'c-del',
      content: pending,
      status: 'pending_approval',
    })
    const tool = s.compatTools.find((t) => t && t.id === 'c-del')
    expect(tool?.status).toBe('pending_approval')
  })

  it('shows only latest reasoning fold', () => {
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_START', messageId: 'r1', role: 'reasoning' })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r1', delta: 'first' })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_END', messageId: 'r1' })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_START', messageId: 'r2', role: 'reasoning' })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r2', delta: 'second' })
    const view = projectAgUiTurnDisplay(s, { isStreaming: true })
    const reasoning = view.slots.filter((sl) => sl.kind === 'reasoning-fold')
    expect(reasoning.length).toBe(1)
    expect(reasoning[0].messageId).toBe('r2')
  })

  it('merges parallel tool order entries into one tools segment', () => {
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'find' })
    s = applyAgUiEvent(s, { type: 'TOOL_CALL_START', toolCallId: 'c2', toolCallName: 'rg' })
    s = applyAgUiEvent(s, { type: 'TOOL_CALL_START', toolCallId: 'c3', toolCallName: 'read' })
    const toolSeg = s.compatSegments.filter((seg) => seg.kind === 'tools')
    expect(toolSeg.length).toBe(1)
    expect(toolSeg[0].ids).toEqual(['c1', 'c2', 'c3'])
    const view = projectAgUiTurnDisplay(s, { isStreaming: true })
    const slots = aguiSlotsToBubbleSlots(view)
    const toolRows = slots.filter((x) => x.kind === 'tool-row')
    expect(toolRows.length).toBe(1)
    expect(toolRows[0].toolCallIds).toEqual(['c1', 'c2', 'c3'])
  })

  it('MESSAGES_SNAPSHOT keeps tool role content off assistant body (tool_search)', () => {
    const toolResultJson = JSON.stringify({ status: 'ok', activated_now: ['read'] })
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, { type: 'TOOL_CALL_START', toolCallId: 'c-ts', toolCallName: 'tool_search' })
    s = applyAgUiEvent(s, { type: 'TEXT_MESSAGE_START', messageId: 'body', role: 'assistant' })
    s = applyAgUiEvent(s, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'body', delta: '好的，我来查找工具。' })
    s = applyAgUiEvent(s, {
      type: 'MESSAGES_SNAPSHOT',
      messages: [
        { id: 'plan', role: 'assistant', content: '好的，我来查找工具。' },
        {
          id: 'tools',
          role: 'assistant',
          toolCalls: [{ id: 'c-ts', type: 'function', function: { name: 'tool_search', arguments: '{"query":"read"}' } }],
        },
        { id: 'c-ts-result', role: 'tool', toolCallId: 'c-ts', content: toolResultJson },
      ],
    })
    const texts = s.compatSegments.filter((seg) => seg.kind === 'text').map((seg) => seg.text)
    expect(texts.join('\n')).not.toContain('activated_now')
    expect(texts.join('\n')).toContain('查找工具')
    expect(s.toolCalls.get('c-ts')?.result).toBe(toolResultJson)
    expect(s.toolCalls.get('c-ts')?.phase).toBe('done')
  })

  it('MESSAGES_SNAPSHOT preserves live tool batches when snapshot collapses tool slots', () => {
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, {
      type: 'TOOL_CALL_START',
      toolCallId: 'c1',
      toolCallName: 'write',
      blockId: 'run:b1',
      blockKind: 'tools',
      seq: 1,
    })
    s = applyAgUiEvent(s, {
      type: 'TEXT_MESSAGE_START',
      messageId: 'mid',
      role: 'assistant',
      blockId: 'run:b2',
      blockKind: 'body_text',
      seq: 2,
    })
    s = applyAgUiEvent(s, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'mid', delta: '中间说明' })
    s = applyAgUiEvent(s, { type: 'TEXT_MESSAGE_END', messageId: 'mid' })
    s = applyAgUiEvent(s, {
      type: 'TOOL_CALL_START',
      toolCallId: 'c2',
      toolCallName: 'read',
      blockId: 'run:b3',
      blockKind: 'tools',
      seq: 3,
    })
    s = applyAgUiEvent(s, {
      type: 'TEXT_MESSAGE_START',
      messageId: 'tail',
      role: 'assistant',
      blockId: 'run:b4',
      blockKind: 'body_text',
      seq: 4,
    })
    s = applyAgUiEvent(s, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'tail', delta: '最终总结' })
    s = applyAgUiEvent(s, { type: 'TEXT_MESSAGE_END', messageId: 'tail' })
    expect(s.compatSegments.map((seg) => seg.kind)).toEqual(['tools', 'text', 'tools', 'text'])

    s = applyAgUiEvent(s, {
      type: 'MESSAGES_SNAPSHOT',
      messages: [
        {
          id: 'tools-merged',
          role: 'assistant',
          seq: 1,
          blockKind: 'tools',
          toolCalls: [
            { id: 'c1', type: 'function', function: { name: 'write', arguments: '{}' } },
            { id: 'c2', type: 'function', function: { name: 'read', arguments: '{}' } },
          ],
        },
        { id: 'mid', role: 'assistant', content: '中间说明', seq: 2, blockKind: 'body_text' },
        { id: 'tail', role: 'assistant', content: '最终总结', seq: 3, blockKind: 'body_text' },
      ],
    })
    expect(s.compatSegments.map((seg) => seg.kind)).toEqual(['tools', 'text', 'tools', 'text'])
    expect(s.compatSegments.filter((seg) => seg.kind === 'tools')).toHaveLength(2)
  })

  it('MESSAGES_SNAPSHOT rebuilds order so plan text stays before body text', () => {
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, { type: 'TEXT_MESSAGE_START', messageId: 'body' })
    s = applyAgUiEvent(s, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'body', delta: '结论段' })
    s = applyAgUiEvent(s, { type: 'TEXT_MESSAGE_END', messageId: 'body' })
    s = applyAgUiEvent(s, {
      type: 'MESSAGES_SNAPSHOT',
      messages: [
        { id: 'plan', role: 'assistant', content: '计划段' },
        {
          id: 'tools',
          role: 'assistant',
          toolCalls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
        },
        { id: 'body', role: 'assistant', content: '结论段' },
      ],
    })
    const texts = s.compatSegments.filter((seg) => seg.kind === 'text').map((seg) => seg.text)
    expect(texts).toEqual(['计划段', '结论段'])
    expect(texts[0]).toBe('计划段')
    expect(s.compatSegments.find((seg) => seg.id === 'plan')?.blockKind).toBe('plan_text')
    expect(s.compatSegments.find((seg) => seg.id === 'body')?.blockKind).toBe('body_text')
  })
})

describe('golden fixture think-tool-body', () => {
  it('replays to stable slots snapshot', () => {
    const events = loadGoldenEvents('think-tool-body.jsonl')
    const state = replayAgUiEvents(events, 'r-fix', 't-fix')
    expect(state.finished).toBe(true)
    expect(state.toolCalls.get('call_1')?.phase).toBe('done')
    const view = projectAgUiTurnDisplay(state, { isStreaming: false })
    const slots = aguiSlotsToBubbleSlots(view)
    expect(slots.some((s) => s.kind === 'top-reasoning')).toBe(true)
    expect(slots.some((s) => s.kind === 'chunk' || s.kind === 'plain-body')).toBe(true)
    const toolSlots = slots.filter((s) => s.kind === 'tool-row')
    expect(toolSlots.length).toBeGreaterThan(0)
  })

  it('sorts order by wire seq when events arrive out of chronological order', () => {
    let s = emptyAgUiTurnState('r1', 't1')
    // Body (seq=4) arrives before tools (seq=2) and reasoning (seq=3)
    s = applyAgUiEvent(s, {
      type: 'TEXT_MESSAGE_START',
      messageId: 'b-body',
      role: 'assistant',
      blockId: 'run:b4',
      blockKind: 'body_text',
      seq: 4,
    })
    s = applyAgUiEvent(s, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'b-body', delta: 'answer' })
    s = applyAgUiEvent(s, { type: 'TEXT_MESSAGE_END', messageId: 'b-body' })
    s = applyAgUiEvent(s, {
      type: 'TOOL_CALL_START',
      toolCallId: 'c1',
      toolCallName: 'grep',
      blockId: 'run:b2',
      blockKind: 'tools',
      seq: 2,
    })
    s = applyAgUiEvent(s, {
      type: 'REASONING_MESSAGE_START',
      messageId: 'r1',
      role: 'reasoning',
      blockId: 'run:b3',
      blockKind: 'reasoning',
      seq: 3,
    })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r1', delta: 'think' })
    s = applyAgUiEvent(s, { type: 'REASONING_MESSAGE_END', messageId: 'r1' })
    expect(s.order.map((e) => e.seq)).toEqual([2, 3, 4])
    const kinds = s.compatSegments.map((seg) => seg.kind)
    expect(kinds).toEqual(['tools', 'reasoning', 'text'])
    expect(s.compatSegments[0].seq).toBe(2)
    expect(s.compatSegments[1].seq).toBe(3)
    expect(s.compatSegments[2].seq).toBe(4)
  })

  it('keeps body visible after TEXT_MESSAGE_END while run still streaming (tools only, no reasoning)', () => {
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, {
      type: 'TOOL_CALL_START',
      toolCallId: 'c1',
      toolCallName: 'grep',
      blockId: 'run:b2',
      blockKind: 'tools',
      seq: 2,
    })
    s = applyAgUiEvent(s, {
      type: 'TEXT_MESSAGE_START',
      messageId: 'b-body',
      role: 'assistant',
      blockId: 'run:b3',
      blockKind: 'body_text',
      seq: 3,
    })
    s = applyAgUiEvent(s, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'b-body', delta: '最终回答' })
    const mid = projectAgUiToStreamTurnFields(s)
    expect(mid.openText).toContain('最终回答')
    s = applyAgUiEvent(s, { type: 'TEXT_MESSAGE_END', messageId: 'b-body' })
    const afterEnd = projectAgUiToStreamTurnFields(s)
    // closed body 进入 timeline；openText 仅承载未 END 的流式尾
    expect(afterEnd.openText).toBe('')
    expect(afterEnd.timeline.some((seg) => seg.kind === 'text' && String(seg.text).includes('最终回答'))).toBe(
      true,
    )
    const timeline = timelineWithOpenAgUiAssistantText(afterEnd.timeline, s)
    expect(timeline.some((seg) => seg.kind === 'text' && String(seg.text).includes('最终回答'))).toBe(true)
    expect(timeline.findIndex((seg) => seg.kind === 'tools')).toBeLessThan(
      timeline.findIndex((seg) => seg.kind === 'text' && String(seg.text).includes('最终回答')),
    )
    s = applyAgUiEvent(s, { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' })
    const done = projectAgUiToStreamTurnFields(s)
    expect(done.openText).toBe('')
    expect(done.timeline.some((seg) => seg.kind === 'text' && String(seg.text).includes('最终回答'))).toBe(true)
  })

  it('RUN_FINISHED seals open post-tool body so it enters timeline without TEXT_MESSAGE_END', () => {
    let s = emptyAgUiTurnState('r1', 't1')
    s = applyAgUiEvent(s, {
      type: 'TEXT_MESSAGE_START',
      messageId: 'plan',
      role: 'assistant',
      blockId: 'run:b1',
      blockKind: 'plan_text',
      seq: 1,
    })
    s = applyAgUiEvent(s, {
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'plan',
      delta: '好的，我来将这个会话思维导图数据添加到知识库。',
    })
    s = applyAgUiEvent(s, { type: 'TEXT_MESSAGE_END', messageId: 'plan' })
    s = applyAgUiEvent(s, {
      type: 'TOOL_CALL_START',
      toolCallId: 'c1',
      toolCallName: 'platform',
      blockId: 'run:b2',
      blockKind: 'tools',
      seq: 2,
    })
    s = applyAgUiEvent(s, {
      type: 'TOOL_CALL_END',
      toolCallId: 'c1',
    })
    // 后端偶发只推 CONTENT、不推 END —— 此前 final 后气泡只剩 plan+Exploring
    s = applyAgUiEvent(s, {
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'wrap',
      delta: '本轮值班开始。\n\n**结论**：本轮值班结束。',
      blockId: 'run:b3',
      blockKind: 'body_text',
      seq: 3,
    })
    expect(projectAgUiToStreamTurnFields(s).openText).toContain('本轮值班结束')
    expect(
      projectAgUiToStreamTurnFields(s).timeline.some(
        (seg) => seg.kind === 'text' && String(seg.text).includes('本轮值班结束'),
      ),
    ).toBe(false)

    s = applyAgUiEvent(s, { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' })
    const done = projectAgUiToStreamTurnFields(s)
    expect(done.openText).toBe('')
    expect(
      done.timeline.some((seg) => seg.kind === 'text' && String(seg.text).includes('本轮值班结束')),
    ).toBe(true)
    expect(
      done.timeline.some((seg) => seg.kind === 'text' && String(seg.text).includes('知识库')),
    ).toBe(true)
    const toolsIdx = done.timeline.findIndex((seg) => seg.kind === 'tools')
    const wrapIdx = done.timeline.findIndex(
      (seg) => seg.kind === 'text' && String(seg.text).includes('本轮值班结束'),
    )
    expect(toolsIdx).toBeGreaterThanOrEqual(0)
    expect(wrapIdx).toBeGreaterThan(toolsIdx)
  })
})
