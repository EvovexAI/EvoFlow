import { describe, expect, it } from 'vitest'
import {
  assistantStripPrefixFromRows,
  commitPriorTurnStripFromStreamTurn,
  filterTerminalStreamsForToolIds,
  findAssistantRowBeforeTrailingUser,
  fixReasoningStreamText,
  isolateStreamProjection,
  mergePriorTurnStripBundles,
  priorTurnStripBundleFromRows,
  priorTurnStripBundleWithStream,
  priorTurnStripFromStreamTurn,
  stripLoosePriorBodyEcho,
  stripPriorTurnAssistantText,
  stripPriorTurnPollutants,
  stripPriorTurnReasoningFromStream,
  sanitizeLiveStreamDisplayFields,
  sanitizeFinalizedTurnForPersist,
  sanitizeHistoryRowsForTurnIsolation,
  trimReasoningTextAgainstBody,
  stripThreadPanelReasoningPreview,
} from '../src/react/lib/turn-text-isolation.ts'
import { emptyStreamTurn, reduceStreamTurn } from '../src/react/lib/stream-turn-engine.ts'
import { flattenStreamDisplayText } from '../src/lib/chat-normalize.js'

describe('turn-text-isolation', () => {
  it('stripPriorTurnAssistantText removes prior turn even when short', () => {
    const prior = '好的，收到。'
    const mixed = `${prior}这是本轮新回复。`
    expect(stripPriorTurnAssistantText(mixed, prior)).toBe('这是本轮新回复。')
  })

  it('assistantStripPrefixFromRows skips system rows and uses assistant before trailing user', () => {
    const rows = [
      { role: 'user', text: 'first', timestamp: 1 },
      { role: 'assistant', text: 'old answer', timestamp: 2 },
      { role: 'system', text: '生成已停止', timestamp: 3 },
      { role: 'user', text: 'second', timestamp: 4 },
    ]
    expect(assistantStripPrefixFromRows(rows)).toBe('old answer')
    expect(findAssistantRowBeforeTrailingUser(rows)?.text).toBe('old answer')
  })

  it('stripPriorTurnPollutants removes prior reasoning from next body', () => {
    const bundle = {
      body: '正式回复。',
      reasoning: '先分析用户需求，再组织语言。',
    }
    const mixed = `${bundle.reasoning}${bundle.body}新的正文。`
    expect(stripPriorTurnPollutants(mixed, bundle)).toBe('新的正文。')
  })

  it('priorTurnStripBundleFromRows captures reasoning from prior assistant row', () => {
    const rows = [
      { role: 'user', text: 'q1', timestamp: 1 },
      {
        role: 'assistant',
        text: 'answer1',
        reasoningPreview: 'thinking one',
        tools: [{ id: 'tc-old', name: 'search' }],
        timestamp: 2,
      },
      { role: 'user', text: 'q2', timestamp: 3 },
    ]
    expect(priorTurnStripBundleFromRows(rows)).toEqual({
      body: 'answer1',
      reasoning: 'thinking one',
      reasoningSegments: ['thinking one'],
      toolIds: ['tc-old'],
    })
  })

  it('stripLoosePriorBodyEcho removes whitespace-normalized prior replay', () => {
    const prior = '第一段\n\n第二段'
    const replay = '第一段  第二段'
    expect(stripLoosePriorBodyEcho(replay, prior)).toBe('')
    expect(stripLoosePriorBodyEcho(`${replay}新的内容`, prior)).toBe('新的内容')
  })

  it('isolateStreamProjection hides checkpoint replay of prior assistant body', () => {
    const prior =
      '这是一段已经落库完成的助手回复正文，用于测试 checkpoint 回灌时是否会在新回合闪回显示。'
    const turn = {
      ...emptyStreamTurn(),
      openText: prior,
      timeline: [],
    }
    const p = isolateStreamProjection(turn, { body: prior, reasoning: '', toolIds: [] })
    expect(flattenStreamDisplayText(p.segments, p.text).trim()).toBe('')
  })

  it('isolateStreamProjection drops stale tools from stream bubble', () => {
    const turn = {
      ...emptyStreamTurn(),
      tools: [
        { id: 'tc-old', name: 'search' },
        { id: 'tc-new', name: 'read_file' },
      ],
      timeline: [{ kind: 'tools', ids: ['tc-old', 'tc-new'] }],
    }
    const p = isolateStreamProjection(turn, {
      body: '',
      reasoning: '',
      toolIds: ['tc-old'],
    })
    expect(p.tools).toHaveLength(1)
    expect(p.tools[0].id).toBe('tc-new')
    expect(p.segments.filter((s) => s.kind === 'tools')).toEqual([{ kind: 'tools', ids: ['tc-new'] }])
  })

  it('isolateStreamProjection cleans stream bubble display', () => {
    const turn = {
      ...emptyStreamTurn(),
      openText: '上一轮内容。本轮正文。',
      timeline: [{ kind: 'text', text: '上一轮内容。本轮正文。' }],
    }
    const p = isolateStreamProjection(turn, { body: '上一轮内容。', reasoning: '', toolIds: [] })
    expect(p.text).toBe('本轮正文。')
  })

  it('isolateStreamProjection drops stale media when no live assistant content', () => {
    const turn = {
      ...emptyStreamTurn(),
      tools: [{ id: 'tc-old', name: 'search' }],
      timeline: [{ kind: 'tools', ids: ['tc-old'] }],
      files: [{ url: '/outputs/old.html', name: 'old.html' }],
      systemActivity: '执行 search',
    }
    const p = isolateStreamProjection(turn, {
      body: '',
      reasoning: '',
      toolIds: ['tc-old'],
    })
    expect(p.tools).toHaveLength(0)
    expect(p.files).toHaveLength(0)
    expect(p.systemActivity).toBeNull()
  })

  it('filterTerminalStreamsForToolIds keeps only current turn tools', () => {
    const streams = {
      tc1: { toolCallId: 'tc1', phase: 'running' },
      tc2: { toolCallId: 'tc2', phase: 'running' },
    }
    const filtered = filterTerminalStreamsForToolIds(streams, new Set(['tc2']))
    expect(filtered && Object.keys(filtered)).toEqual(['tc2'])
  })

  it('stripThreadPanelReasoningPreview strips prior sidebar reasoning', () => {
    const bundle = { body: '', reasoning: '旧思考', toolIds: [] }
    expect(stripThreadPanelReasoningPreview('旧思考新思考', bundle)).toBe('新思考')
  })

  it('stripPriorTurnReasoningFromStream isolates reasoning channel', () => {
    const bundle = { body: '', reasoning: '旧思考过程', toolIds: [] }
    expect(stripPriorTurnReasoningFromStream('旧思考过程新思考', bundle)).toBe('新思考')
  })

  it('priorTurnStripBundleWithStream prefers longer in-flight body before seal', () => {
    const rows = [
      { role: 'user', text: '写一篇', timestamp: 1 },
      { role: 'assistant', text: '短落库', timestamp: 2 },
      { role: 'user', text: '继续', timestamp: 3 },
    ]
    const streamTurn = reduceStreamTurn(emptyStreamTurn(), {
      type: 'text_piece',
      piece: '短落库。流里还有更长的一段正文。',
    })
    expect(priorTurnStripBundleWithStream(rows, streamTurn).body).toBe(
      '短落库。流里还有更长的一段正文。',
    )
  })

  it('priorTurnStripFromStreamTurn captures reasoning for stop-then-resend isolation', () => {
    const streamTurn = reduceStreamTurn(emptyStreamTurn(), {
      type: 'reasoning_piece',
      piece: '先分析需求，再组织回答。',
    })
    expect(priorTurnStripFromStreamTurn(streamTurn).reasoning).toBe('先分析需求，再组织回答。')
  })

  it('commitPriorTurnStripFromStreamTurn persists strip on runtime for next send', () => {
    const rt = { priorTurnStrip: { body: '', reasoning: '', toolIds: [] } }
    const streamTurn = reduceStreamTurn(emptyStreamTurn(), {
      type: 'reasoning_piece',
      piece: '上一轮思考内容',
    })
    commitPriorTurnStripFromStreamTurn(rt, streamTurn)
    expect(rt.priorTurnStrip.reasoning).toBe('上一轮思考内容')
    const merged = mergePriorTurnStripBundles(rt.priorTurnStrip, {
      body: '',
      reasoning: '上一轮',
      toolIds: [],
    })
    expect(merged.reasoning).toBe('上一轮思考内容')
  })

  it('stripPriorTurnReasoningFromStream tolerates CJK spacing drift', () => {
    const bundle = { body: '', reasoning: '先分析用户需求', toolIds: [] }
    const spaced = fixReasoningStreamText('先 分析 用户 需求') + '新一轮思考'
    expect(stripPriorTurnReasoningFromStream(spaced, bundle)).toBe('新一轮思考')
  })

  it('trimReasoningTextAgainstBody removes answer draft from reasoning', () => {
    const body = '当前是 **Plan 模式**。\n\n这个模式从一开始做修复计划时就激活了'
    const reasoning =
      '用户问当前是什么模式。需要明确回答。\n\n' + body + '\n\n如果要亲自验证需要切 Agent 模式。'
    const trimmed = trimReasoningTextAgainstBody(reasoning, body)
    expect(trimmed).toBe('用户问当前是什么模式。需要明确回答。')
    expect(trimmed).not.toContain('Plan 模式')
  })

  it('trimReasoningTextAgainstBody removes short answer tail from reasoning', () => {
    const body = '当前是 Plan 模式。'
    const reasoning = '用户在问模式。当前是 Plan 模式。'
    expect(trimReasoningTextAgainstBody(reasoning, body)).toBe('用户在问模式。')
  })

  it('sanitizeLiveStreamDisplayFields strips prior turn and reasoning/body overlap', () => {
    const prior = {
      body: '上一轮正式回复正文。',
      reasoning: '上一轮思考过程。',
      toolIds: [],
    }
    const out = sanitizeLiveStreamDisplayFields(
      {
        text: `${prior.body}当前是 Plan 模式。`,
        reasoningPreview: `${prior.reasoning}用户在问模式。${prior.body}当前是 Plan 模式。`,
        reasoningSegments: [],
      },
      prior,
    )
    expect(out.text).toBe('当前是 Plan 模式。')
    expect(out.reasoningPreview).toBe('用户在问模式。')
  })

  it('sanitizeLiveStreamDisplayFields strips each prior reasoning segment independently', () => {
    const prior = {
      body: '',
      reasoning: 'think A\n\nthink B',
      reasoningSegments: ['think A', 'think B'],
      toolIds: [],
    }
    const out = sanitizeLiveStreamDisplayFields(
      {
        text: '',
        reasoningPreview: null,
        reasoningSegments: ['think A', 'think B new thoughts'],
      },
      prior,
    )
    expect(out.reasoningSegments).toEqual(['new thoughts'])
  })

  it('sanitizeFinalizedTurnForPersist strips replayed prior turn before row persist', () => {
    const prior = {
      body: '收到 👍',
      reasoning: 'The user just sent "1".',
      reasoningSegments: ['The user just sent "1".'],
      toolIds: [],
    }
    const fin = sanitizeFinalizedTurnForPersist(
      {
        text: '收到 👍哈哈 😄',
        reasoningSegments: ['The user just sent "1".', 'The user just said haha'],
        reasoningPreview: 'The user just said haha',
        segments: [
          { kind: 'reasoning', text: 'The user just sent "1".' },
          { kind: 'reasoning', text: 'The user just said haha' },
          { kind: 'text', text: '收到 👍哈哈 😄' },
        ],
      },
      prior,
    )
    expect(fin.reasoningSegments).toEqual(['The user just said haha'])
    const bodyPlain = flattenStreamDisplayText(fin.segments, fin.text).trim()
    expect(bodyPlain).toBe('哈哈 😄')
    expect(fin.segments?.filter((s) => s.kind === 'reasoning')).toHaveLength(1)
  })
})

describe('build-stream-display-row', () => {
  it('does not throw when building live stream row with prior-turn strip', async () => {
    const { buildStreamDisplayRow } = await import('../src/react/lib/build-stream-display-row.ts')
    const { emptyStreamTurn } = await import('../src/react/lib/stream-turn-engine.ts')
    const turn = reduceStreamTurn(emptyStreamTurn(), { type: 'reasoning_piece', text: '先想一下。' })
    const streamRef = {
      current: {
        turn,
        compactedParts: [],
        runId: 'run-1',
      },
    }
    const row = buildStreamDisplayRow(
      streamRef,
      '',
      false,
      true,
      { body: '上一轮正文', reasoning: '上一轮思考', toolIds: ['tc_old'] },
    )
    expect(row?.role).toBe('_stream')
    expect(String(row?.reasoningPreview || '')).not.toContain('上一轮思考')
  })

  it('agui wire uses agui openText only (legacy turn double-append must not leak)', async () => {
    const { buildStreamDisplayRow } = await import('../src/react/lib/build-stream-display-row.ts')
    const { applyAgUiEvent, emptyAgUiTurnState } = await import('../src/react/lib/agui-turn-reducer.ts')
    const { emptyStreamTurn } = await import('../src/react/lib/stream-turn-engine.ts')
    let agui = emptyAgUiTurnState('run-1', 'thread-1')
    agui = applyAgUiEvent(agui, { type: 'TEXT_MESSAGE_START', messageId: 'b1', role: 'assistant' })
    agui = applyAgUiEvent(agui, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'b1', delta: '已删除' })
    const streamRef = {
      current: {
        turn: { ...emptyStreamTurn(), openText: '已已删除删除' },
        aguiTurn: agui,
        compactedParts: [],
        runId: 'run-1',
      },
    }
    const row = buildStreamDisplayRow(streamRef, '', false, true)
    expect(row?.text).toBe('已删除')
    expect(row?.text).not.toContain('已已')
  })

  it('agui live reasoning appears on stream row before message end', async () => {
    const { buildStreamDisplayRow } = await import('../src/react/lib/build-stream-display-row.ts')
    const { applyAgUiEvent, emptyAgUiTurnState } = await import('../src/react/lib/agui-turn-reducer.ts')
    const { emptyStreamTurn } = await import('../src/react/lib/stream-turn-engine.ts')
    let agui = emptyAgUiTurnState('run-1', 'thread-1')
    agui = applyAgUiEvent(agui, { type: 'REASONING_MESSAGE_START', messageId: 'rm1' })
    agui = applyAgUiEvent(agui, { type: 'REASONING_MESSAGE_CONTENT', messageId: 'rm1', delta: '正在分析…' })
    const streamRef = {
      current: {
        turn: emptyStreamTurn(),
        aguiTurn: agui,
        compactedParts: [],
        runId: 'run-1',
      },
    }
    const row = buildStreamDisplayRow(streamRef, '', false, true)
    expect(String(row?.reasoningPreview || '')).toContain('正在分析')
    expect((row?.segments || []).some((s) => s.kind === 'reasoning')).toBe(true)
  })

  it('write_file_progress content_len invalidates row cache without new tools', async () => {
    const { buildStreamDisplayRow } = await import('../src/react/lib/build-stream-display-row.ts')
    const { applyAgUiEvent, emptyAgUiTurnState } = await import('../src/react/lib/agui-turn-reducer.ts')
    const { emptyStreamTurn } = await import('../src/react/lib/stream-turn-engine.ts')
    let agui = emptyAgUiTurnState('run-1', 'thread-1')
    agui = applyAgUiEvent(agui, {
      type: 'TOOL_CALL_START',
      toolCallId: 'call_write_1',
      toolCallName: 'write',
    })
    agui = applyAgUiEvent(agui, {
      type: 'CUSTOM',
      name: 'write_file_progress',
      value: {
        tool_call_id: 'call_write_1',
        tool_name: 'write',
        path: '',
        phase: 'args',
        lines_added: 1,
        lines_removed: 0,
        content_len: 2,
        content_delta: '# ',
      },
    })
    const streamRef = {
      current: {
        turn: emptyStreamTurn(),
        aguiTurn: agui,
        compactedParts: [],
        runId: 'run-1',
      },
    }
    const row1 = buildStreamDisplayRow(streamRef, '', false, true)
    const wp1 = row1?.tools?.[0]?._writeProgress
    expect(wp1?.content_len).toBe(2)
    expect(String(wp1?.content || '')).toBe('# ')

    agui = applyAgUiEvent(agui, {
      type: 'CUSTOM',
      name: 'write_file_progress',
      value: {
        tool_call_id: 'call_write_1',
        tool_name: 'write',
        path: '',
        phase: 'args',
        lines_added: 2,
        lines_removed: 0,
        content_len: 6,
        content_delta: '猫事记\n',
      },
    })
    streamRef.current.aguiTurn = agui
    const row2 = buildStreamDisplayRow(streamRef, '', false, true)
    const wp2 = row2?.tools?.[0]?._writeProgress
    expect(wp2?.content_len).toBe(6)
    expect(String(wp2?.content || '')).toBe('# 猫事记\n')
    expect(row2).not.toBe(row1)
  })

  it('write_file_progress path arrival invalidates row cache at same content_len', async () => {
    const { buildStreamDisplayRow } = await import('../src/react/lib/build-stream-display-row.ts')
    const { applyAgUiEvent, emptyAgUiTurnState } = await import('../src/react/lib/agui-turn-reducer.ts')
    const { emptyStreamTurn } = await import('../src/react/lib/stream-turn-engine.ts')
    let agui = emptyAgUiTurnState('run-1', 'thread-1')
    agui = applyAgUiEvent(agui, {
      type: 'TOOL_CALL_START',
      toolCallId: 'call_write_path',
      toolCallName: 'write_to_file',
    })
    agui = applyAgUiEvent(agui, {
      type: 'CUSTOM',
      name: 'write_file_progress',
      value: {
        tool_call_id: 'call_write_path',
        tool_name: 'write_to_file',
        path: '',
        phase: 'args',
        lines_added: 1,
        lines_removed: 0,
        content_len: 4,
        content_delta: 'body',
      },
    })
    const streamRef = {
      current: {
        turn: emptyStreamTurn(),
        aguiTurn: agui,
        compactedParts: [],
        runId: 'run-1',
      },
    }
    const row1 = buildStreamDisplayRow(streamRef, '', false, true)
    expect(String(row1?.tools?.[0]?._writeProgress?.path || '')).toBe('')

    agui = applyAgUiEvent(agui, {
      type: 'CUSTOM',
      name: 'write_file_progress',
      value: {
        tool_call_id: 'call_write_path',
        tool_name: 'write_to_file',
        path: 'src/components/Hello.tsx',
        phase: 'args',
        lines_added: 1,
        lines_removed: 0,
        content_len: 4,
      },
    })
    streamRef.current.aguiTurn = agui
    const row2 = buildStreamDisplayRow(streamRef, '', false, true)
    expect(String(row2?.tools?.[0]?._writeProgress?.path || '')).toBe('src/components/Hello.tsx')
    expect(row2).not.toBe(row1)
  })
})

describe('sanitizeHistoryRowsForTurnIsolation', () => {
  it('strips prior assistant body from current turn after DB reload', () => {
    const prior = '上一轮完整回复正文。'
    const rows = [
      { role: 'user', text: 'first' },
      { role: 'assistant', text: prior, segments: [{ kind: 'text', text: prior }] },
      { role: 'user', text: 'second' },
      {
        role: 'assistant',
        text: `${prior}本轮新回复。`,
        segments: [{ kind: 'text', text: `${prior}本轮新回复。` }],
      },
    ]
    const out = sanitizeHistoryRowsForTurnIsolation(rows)
    expect(out[3].text).toBe('本轮新回复。')
    expect(out[3].segments?.[0]?.text).toBe('本轮新回复。')
  })
})
