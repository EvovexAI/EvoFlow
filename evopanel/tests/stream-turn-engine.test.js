import { describe, it, expect } from 'vitest'
import {
  emptyStreamTurn,
  reduceStreamTurn,
  projectStreamTurn,
  finalizeStreamTurn,
  appendTextMonotonic,
  appendStreamBodyPiece,
  appendStreamDeltaPiece,
  mergeReasoningStreamPiece,
  streamTurnHasVisibleContent,
  isNewToolRoundStarting,
  drainStreamTurnRoundBuffer,
  shouldReleaseStreamBufferBeforeEvent,
  shouldKeepStreamDeltaAfterStrip,
  areLastTimelineToolsComplete,
  mergeCompactedPartsIntoTurn,
  projectStreamTurnWithCompacted,
  finalizedTurnToCompactedPart,
  staleToolIdsExcludingTurnTools,
  capStreamTailText,
  STREAM_ASSISTANT_BODY_CAP,
  STREAM_REASONING_TEXT_CAP,
} from '../src/react/lib/stream-turn-engine.ts'
import {
  flattenStreamDisplayText,
  stripThinkingTags,
  stripThinkingTagsPreserveNewlines,
} from '../src/lib/chat-normalize.js'

describe('appendTextMonotonic', () => {
  it('appends incremental pieces', () => {
    expect(appendTextMonotonic('hello', ' world')).toBe('hello world')
    expect(appendTextMonotonic('ab', 'abc')).toBe('abc')
  })
})

describe('stripThinkingTagsPreserveNewlines', () => {
  it('does not trim chunk edges', () => {
    expect(stripThinkingTags('---\n\n')).toBe('---')
    expect(stripThinkingTagsPreserveNewlines('---\n\n')).toBe('---\n\n')
    expect(stripThinkingTagsPreserveNewlines('\n\n##')).toBe('\n\n##')
  })
})

describe('reduceStreamTurn text_piece', () => {
  it('preserves 是什么 paragraph break (evf piece sequence)', () => {
    let s = emptyStreamTurn()
    for (const piece of ['Evo', 'Flow ', '是什么\n\n', '**', 'Evo', 'Flow**']) {
      s = reduceStreamTurn(s, { type: 'text_piece', piece })
    }
    expect(s.openText).toBe('EvoFlow 是什么\n\n**EvoFlow**')
  })

  it('preserves newlines after 一句话定位 (evf piece sequence)', () => {
    let s = emptyStreamTurn()
    for (const piece of ['一、', '一句话定位', '\n\n**', 'Evo', 'Flow**']) {
      s = reduceStreamTurn(s, { type: 'text_piece', piece })
    }
    expect(s.openText).toBe('一、一句话定位\n\n**EvoFlow**')
  })

  it('preserves 我是谁 paragraph break (evf piece sequence)', () => {
    let s = emptyStreamTurn()
    for (const piece of [
      '#',
      ' Evo',
      'Flow ',
      '能力',
      '与定位',
      '介绍\n\n',
      '##',
      ' 我是',
      '谁\n\n',
      '我是',
      ' **E',
    ]) {
      s = reduceStreamTurn(s, { type: 'text_piece', piece })
    }
    expect(s.openText).toContain('我是谁\n\n我是')
    expect(s.openText).not.toMatch(/我是谁我是/)
  })

  it('preserves newlines from model delta pieces (no per-chunk trim)', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, { type: 'text_piece', piece: '---\n\n' })
    expect(s.openText).toBe('---\n\n')
    s = reduceStreamTurn(s, { type: 'text_piece', piece: '# E' })
    s = reduceStreamTurn(s, { type: 'text_piece', piece: 'voFlow' })
    s = reduceStreamTurn(s, { type: 'text_piece', piece: ' 能力' })
    s = reduceStreamTurn(s, { type: 'text_piece', piece: '介绍' })
    expect(s.openText).toBe('---\n\n# EvoFlow 能力介绍')
    s = reduceStreamTurn(s, { type: 'text_piece', piece: '\n\n##' })
    expect(s.openText).toBe('---\n\n# EvoFlow 能力介绍\n\n##')
    s = reduceStreamTurn(s, { type: 'text_piece', piece: ' 一句话' })
    s = reduceStreamTurn(s, { type: 'text_piece', piece: '定位\n\n' })
    expect(s.openText).toBe('---\n\n# EvoFlow 能力介绍\n\n## 一句话定位\n\n')
  })

  it('keeps pre_tools then post_tools after tools event', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, { type: 'text_piece', piece: '计划', phase: 'pre_tools' })
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 't1', name: 'read_file', status: 'running' }],
    })
    expect(s.timeline.some((x) => x.kind === 'tools')).toBe(true)
    expect(s.textPhase).toBe('post_tools')
    s = reduceStreamTurn(s, { type: 'text_piece', piece: '总结', phase: 'post_tools' })
    const p = projectStreamTurn(s)
    expect(p.segments.some((x) => x.kind === 'text' && x.text === '计划')).toBe(true)
    expect(p.text).toBe('总结')
  })
})

describe('reduceStreamTurn reasoning_piece after tools', () => {
  it('collapses consecutive reasoning timeline segments into one preview', () => {
    let s = emptyStreamTurn()
    s = {
      ...s,
      timeline: [
        { kind: 'reasoning', text: 'The' },
        { kind: 'reasoning', text: ' user wants' },
      ],
    }
    const p = projectStreamTurn(s)
    expect(p.reasoningSegments).toEqual(['The user wants'])
  })

  it('keeps separate reasoning rounds when tools sit between them', () => {
    let s = emptyStreamTurn()
    s = {
      ...s,
      timeline: [
        { kind: 'reasoning', text: 'plan' },
        { kind: 'tools', ids: ['t1'] },
        { kind: 'reasoning', text: 'after tool' },
      ],
    }
    const p = projectStreamTurn(s)
    expect(p.reasoningSegments).toEqual(['plan', 'after tool'])
    expect(p.reasoningPreview).toBe('after tool')
    expect(p.reasoningPreview).not.toContain('plan')
  })

  it('appends post-tool reasoning after tools segment in timeline order', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, { type: 'reasoning_piece', piece: 'before' })
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 't1', name: 'read_file', status: 'running' }],
    })
    s = reduceStreamTurn(s, { type: 'reasoning_piece', piece: ' after' })
    const kinds = s.timeline.map((x) => x.kind)
    expect(kinds).toEqual(['reasoning', 'tools', 'reasoning'])
    expect(projectStreamTurn(s).reasoningSegments).toEqual(['before', ' after'])
  })

  it('places late first-round reasoning before tools that raced ahead', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 't1', name: 'read_file', status: 'running' }],
    })
    s = reduceStreamTurn(s, { type: 'reasoning_piece', piece: 'delayed think' })
    expect(s.timeline.map((x) => x.kind)).toEqual(['reasoning', 'tools'])
    expect(s.timeline[0].text).toBe('delayed think')
  })

  it('starts new reasoning segment after each tool batch (interleaved)', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, { type: 'reasoning_piece', piece: 'round1' })
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 't1', name: 'rg', status: 'running' }],
    })
    s = reduceStreamTurn(s, { type: 'reasoning_piece', piece: 'round2' })
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 't2', name: 'read', status: 'running' }],
    })
    s = reduceStreamTurn(s, { type: 'reasoning_piece', piece: 'round3' })
    const kinds = s.timeline.map((x) => x.kind)
    expect(kinds).toEqual(['reasoning', 'tools', 'reasoning', 'tools', 'reasoning'])
    expect(projectStreamTurn(s).reasoningSegments).toEqual(['round1', 'round2', 'round3'])
  })

  it('preserves leading spaces in delta reasoning pieces', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, { type: 'reasoning_piece', piece: 'The' })
    s = reduceStreamTurn(s, { type: 'reasoning_piece', piece: ' user' })
    s = reduceStreamTurn(s, { type: 'reasoning_piece', piece: ' wants' })
    const p = projectStreamTurn(s)
    expect(p.reasoningPreview).toBe('The user wants')
  })

  it('keeps post-tool reasoning_piece in reasoning segment (no body redirect)', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, { type: 'reasoning_piece', piece: 'I need to read the skill file' })
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 't1', name: 'read_file', status: 'running' }],
    })
    s = reduceStreamTurn(s, {
      type: 'reasoning_piece',
      piece: '## 一、总结\n\n这是工具后的正式回复正文。',
    })
    const p = projectStreamTurn(s)
    expect(p.text).toBe('')
    expect(p.reasoningPreview).toContain('## 一、总结')
    const postReasoning = p.segments.filter((x) => x.kind === 'reasoning').pop()
    expect(postReasoning?.text || '').toContain('这是工具后的正式回复正文')
  })

  it('keeps inter-tool reasoning with 能力边界 out of openText (run 8db35723)', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, {
      type: 'reasoning_piece',
      piece:
        '用户要求正式介绍 EvoFlow 与自身能力边界。这正好命中 evoflow-intro 技能。我需要先读取该技能内容，然后按要求输出。',
    })
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 't1', name: 'tool_search', status: 'running' }],
    })
    s = reduceStreamTurn(s, { type: 'reasoning_piece', piece: '要求正式介绍 Evo' })
    s = reduceStreamTurn(s, { type: 'reasoning_piece', piece: 'Flow 与自身' })
    s = reduceStreamTurn(s, { type: 'reasoning_piece', piece: '能力边界。命中' })
    s = reduceStreamTurn(s, { type: 'reasoning_piece', piece: 'evoflow-int' })
    s = reduceStreamTurn(s, {
      type: 'reasoning_piece',
      piece: 'ro 技能，先读取该技能内容。',
    })
    expect(s.openText).toBe('')
    const p = projectStreamTurn(s)
    expect(p.text).toBe('')
    expect(p.segments.some((x) => x.kind === 'text')).toBe(false)
    const postReasoning = p.segments.filter((x) => x.kind === 'reasoning').pop()
    expect(postReasoning?.text || '').toContain('能力边界。命中')
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 't2', name: 'read', status: 'running' }],
    })
    const afterTools = projectStreamTurn(s)
    expect(afterTools.segments.some((x) => x.kind === 'text' && x.text.includes('能力边界。命中'))).toBe(
      false,
    )
  })

  it('seals post-tool openText into timeline when a new tool round starts', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 't1', name: 'terminal', status: 'ok' }],
    })
    s = reduceStreamTurn(s, {
      type: 'text_piece',
      piece: '## 测试结果\n\nStep 1 失败',
      phase: 'post_tools',
    })
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 't2', name: 'read_file', status: 'running' }],
    })
    s = reduceStreamTurn(s, {
      type: 'reasoning_piece',
      piece: 'The API endpoint is returning 404.',
    })
    const p = projectStreamTurn(s)
    const kinds = p.segments.map((x) => x.kind)
    const textIdx = kinds.indexOf('text')
    const reasoningIdx = kinds.indexOf('reasoning')
    expect(textIdx).toBeGreaterThanOrEqual(0)
    expect(reasoningIdx).toBeGreaterThanOrEqual(0)
    expect(p.text).toBe('')
    expect(p.segments.some((x) => x.kind === 'text' && x.text.includes('## 测试结果'))).toBe(true)
    expect(p.reasoningPreview).toContain('404')
  })

  it('keeps post-tool reasoning in project when openText shares a prefix', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 't1', name: 'terminal', status: 'ok' }],
    })
    s = reduceStreamTurn(s, {
      type: 'reasoning_piece',
      piece: 'The API endpoint is returning 404 with HTML.',
    })
    s = reduceStreamTurn(s, {
      type: 'text_piece',
      piece: '## 测试结果\n\nStep 1 失败',
      phase: 'post_tools',
    })
    const p = projectStreamTurn(s)
    const reasoning = p.segments
      .filter((x) => x.kind === 'reasoning')
      .map((x) => x.text)
      .join('')
    expect(reasoning).toContain('404')
    expect(p.reasoningPreview).toContain('404')
  })

  it('preserves post-tool reasoning in project even when openText overlaps', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 't1', name: 'read_file', status: 'ok' }],
    })
    s = {
      ...s,
      timeline: [
        ...s.timeline,
        { kind: 'reasoning', text: 'internal thought\n\n## intro\n\nbody text here' },
      ],
      openText: '## intro\n\nbody text here',
      textPhase: 'post_tools',
    }
    const p = projectStreamTurn(s)
    const reasoning = p.segments
      .filter((x) => x.kind === 'reasoning')
      .map((x) => x.text)
      .join('')
    expect(reasoning).toContain('internal thought')
    expect(p.text).toBe('## intro\n\nbody text here')
  })
})

describe('reconcileToolCallIds (via reduceStreamTurn tools)', () => {
  it('does not seal post-tool openText when values replays an existing tool_call', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, { type: 'text_piece', piece: '好的，先创建目录。\n\n' })
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 'tc-term-1', name: 'terminal', status: 'running', input: { command: 'mkdir' } }],
    })
    s = reduceStreamTurn(s, { type: 'text_piece', piece: '好' })
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 'tc-term-1', name: 'terminal', status: 'ok', output: 'Test dir created' }],
    })
    s = reduceStreamTurn(s, { type: 'text_piece', piece: '，' })
    s = reduceStreamTurn(s, { type: 'text_piece', piece: '测试目录已创建' })
    const p = projectStreamTurn(s)
    expect(p.text).toBe('好，测试目录已创建')
    const postToolSegs = p.segments.filter((x) => x.kind === 'text' && x.text !== '好的，先创建目录。\n\n')
    expect(postToolSegs.length).toBe(0)
  })

  it('keeps both read_file rows when a second read starts while the first is still running', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [
        { id: 'tc-read-1', name: 'read_file', status: 'running', input: { path: '/a.ts' } },
      ],
    })
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [
        { id: 'tc-read-2', name: 'read_file', status: 'running', input: { path: '/b.ts' } },
      ],
    })
    const ids = s.tools.map((t) => String(t.id || t.tool_call_id || ''))
    expect(ids).toContain('tc-read-1')
    expect(ids).toContain('tc-read-2')
    expect(s.tools).toHaveLength(2)
    const toolSeg = s.timeline.find((x) => x.kind === 'tools')
    expect(toolSeg?.ids).toContain('tc-read-1')
    expect(toolSeg?.ids).toContain('tc-read-2')
    expect(s.tools.find((t) => t.id === 'tc-read-1')?.input).toEqual({ path: '/a.ts' })
    expect(s.tools.find((t) => t.id === 'tc-read-2')?.input).toEqual({ path: '/b.ts' })
  })

  it('keeps both write rows when a second write starts while the first is still running', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 'tc-write-1', name: 'write', status: 'running', input: { path: '/a.txt' } }],
    })
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 'tc-write-2', name: 'write', status: 'running', input: { path: '/b.txt' } }],
    })
    const ids = s.tools.map((t) => String(t.id || t.tool_call_id || ''))
    expect(ids).toContain('tc-write-1')
    expect(ids).toContain('tc-write-2')
    expect(s.tools).toHaveLength(2)
    const toolSegs = s.timeline.filter((x) => x.kind === 'tools')
    const allIds = toolSegs.flatMap((seg) => seg.ids || [])
    expect(allIds).toContain('tc-write-1')
    expect(allIds).toContain('tc-write-2')
  })

  it('does not duplicate the same write tool_call_id across timeline tool segments', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 'w1', name: 'write', status: 'running', input: { path: '/a.txt' } }],
    })
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 't1', name: 'terminal', status: 'running', input: { command: 'date' } }],
    })
    s = reduceStreamTurn(s, {
      type: 'tools_update',
      entries: [
        { id: 'w1', name: 'write', status: 'ok', output: 'OK' },
        { id: 't1', name: 'terminal', status: 'ok', output: 'ok' },
      ],
    })
    const w1Segments = s.timeline.filter(
      (seg) => seg.kind === 'tools' && (seg.ids || []).includes('w1'),
    )
    expect(w1Segments).toHaveLength(1)
    const w1Count = s.timeline
      .filter((seg) => seg.kind === 'tools')
      .flatMap((seg) => seg.ids || [])
      .filter((id) => id === 'w1').length
    expect(w1Count).toBe(1)
  })

  it('does not rewrite prior terminal tool_call_id when a new terminal starts', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 'tc-term-1', name: 'terminal', status: 'running', input: { command: 'echo 1' } }],
    })
    s = reduceStreamTurn(s, {
      type: 'tools_update',
      entries: [
        {
          id: 'tc-term-1',
          name: 'terminal',
          status: 'running',
          _terminalStream: { toolCallId: 'tc-term-1', phase: 'success', stdout: 'one\n', chunks: [] },
        },
      ],
    })
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 'tc-term-2', name: 'terminal', status: 'running', input: { command: 'echo 2' } }],
    })
    const ids = s.tools.map((t) => String(t.id || t.tool_call_id || ''))
    expect(ids).toContain('tc-term-1')
    expect(ids).toContain('tc-term-2')
    const toolSeg = s.timeline.find((x) => x.kind === 'tools')
    expect(toolSeg?.ids).toContain('tc-term-1')
    expect(toolSeg?.ids).toContain('tc-term-2')
  })
})

describe('finalizeStreamTurn', () => {
  it('keeps one text segment when final only differs by whitespace from stream', () => {
    let s = emptyStreamTurn()
    const streamed =
      '#EvoFlow介绍---##一、定位**EvoFlow**是智能体平台。'
    const formatted =
      '# EvoFlow 介绍\n\n---\n\n## 一、定位\n\n**EvoFlow** 是智能体平台。'
    s = reduceStreamTurn(s, { type: 'text_piece', piece: streamed })
    const fin = finalizeStreamTurn(s, formatted)
    const textSegs = fin.segments?.filter((x) => x.kind === 'text') || []
    expect(textSegs.length).toBe(1)
    expect(textSegs[0].text).toBe(formatted)
    expect(fin.text).toBe('')
  })

  it('does not set row.text tail when answer is already in segments', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, { type: 'text_piece', piece: '完整回答正文在这里。' })
    const fin = finalizeStreamTurn(s, '完整回答正文在这里。')
    expect(fin.segments?.filter((x) => x.kind === 'text').length).toBe(1)
    expect(fin.text).toBe('')
  })

  it('merges authoritative final text into timeline', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, { type: 'text_piece', piece: '部分' })
    const fin = finalizeStreamTurn(s, '部分与完整结尾')
    const plain = fin.segments
      ?.filter((x) => x.kind === 'text')
      .map((x) => x.text)
      .join('')
    expect(plain).toContain('部分')
    expect(streamTurnHasVisibleContent(s)).toBe(true)
  })

  it('keeps partial openText on abort finalize with empty authoritative', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, { type: 'text_piece', piece: '已输出的一百字正文片段' })
    const fin = finalizeStreamTurn(s, '')
    expect(streamTurnHasVisibleContent(s)).toBe(true)
    expect(fin.segments?.some((x) => x.kind === 'text' && String(x.text).includes('一百字'))).toBe(true)
    expect(fin.text).toBe('')
  })

  it('seals intro openText when tools arrive (gateway filters hidden-only updates)', () => {
    const intro = '好的，开始工作区操作冒烟测试！我会并行测试多项核心工具，验证它们是否正常工作。'
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, { type: 'reasoning_piece', piece: 'think' })
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 'sc', name: 'scenario', status: 'ok' }],
    })
    s = reduceStreamTurn(s, { type: 'text_piece', piece: intro })
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 'mm', name: 'mind_map', status: 'ok' }],
    })
    expect(String(s.openText || '')).toBe('')
    expect(s.timeline.some((seg) => seg.kind === 'text' && String(seg.text).includes('好的，开始'))).toBe(
      true,
    )
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 'term', name: 'terminal', status: 'running' }],
    })
    expect(s.timeline.some((seg) => seg.kind === 'text' && String(seg.text).includes('好的，开始'))).toBe(
      true,
    )
  })

  it('does not duplicate pre-tool preamble when run_end repeats it after tools', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, { type: 'text_piece', piece: '我来为你做一次正式的能力介绍。\n\n' })
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 't1', name: 'scenario', status: 'ok' }],
    })
    s = reduceStreamTurn(s, { type: 'text_piece', piece: '以下是对 EvoFlow 的介绍' })
    const full =
      '我来为你做一次正式的能力介绍。\n\n以下是对 EvoFlow 的介绍\n\n## EvoFlow 产品能力边界'
    const fin = finalizeStreamTurn(s, full)
    const textSegs = fin.segments?.filter((x) => x.kind === 'text') || []
    expect(textSegs.length).toBe(1)
    expect(textSegs[0].text).toBe(full)
    expect(fin.text).toBe('')
    expect(full.match(/我来为你做一次正式的能力介绍/g)?.length).toBe(1)
  })

  it('appends post-tool piece verbatim (no prefix strip)', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, { type: 'text_piece', piece: '开场白。\n\n' })
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 't1', name: 'read_file', status: 'ok' }],
    })
    const cumulative = '开场白。\n\n正文第一段'
    s = reduceStreamTurn(s, { type: 'text_piece', piece: cumulative })
    const p = projectStreamTurn(s)
    expect(p.text).toBe(cumulative)
  })
  it('system_activity counts as visible stream content', () => {
    let s = emptyStreamTurn()
    expect(streamTurnHasVisibleContent(s)).toBe(false)
    s = reduceStreamTurn(s, { type: 'system_activity', detail: '准备中…' })
    expect(streamTurnHasVisibleContent(s)).toBe(true)
    expect(projectStreamTurn(s).systemActivity).toBe('准备中…')
    s = reduceStreamTurn(s, { type: 'system_activity', detail: '' })
    expect(projectStreamTurn(s).systemActivity).toBeNull()
  })
})

describe('filterStaleToolEntries', () => {
  it('drops tool calls from prior stopped turn', async () => {
    const { filterStaleToolEntries } = await import('../src/react/lib/stream-turn-engine.ts')
    const stale = ['tc-old-1', 'tc-old-2']
    const entries = [
      { id: 'tc-old-1', name: 'search' },
      { id: 'tc-new-1', name: 'read_file' },
    ]
    const out = filterStaleToolEntries(entries, stale)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('tc-new-1')
  })
})

describe('drainStreamTurnRoundBuffer', () => {
  it('detects new tool round when timeline already has tools', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 't1', name: 'read_file', status: 'ok', output: 'big' }],
    })
    s = reduceStreamTurn(s, { type: 'text_piece', piece: 'round1 reply' })
    expect(isNewToolRoundStarting(s, [{ id: 't2', name: 'grep', status: 'running' }])).toBe(true)
    expect(isNewToolRoundStarting(s, [{ id: 't1', name: 'read_file', status: 'ok' }])).toBe(false)
  })

  it('releases prior timeline and tools from memory', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, { type: 'text_piece', piece: 'plan' })
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 't1', name: 'read_file', status: 'ok', output: 'x'.repeat(5000) }],
    })
    s = reduceStreamTurn(s, { type: 'text_piece', piece: 'summary' })
    const { sealed, releasedToolIds, fresh } = drainStreamTurnRoundBuffer(s)
    expect(releasedToolIds).toEqual(['t1'])
    expect(sealed.timeline.some((x) => x.kind === 'tools')).toBe(true)
    expect(streamTurnHasVisibleContent(sealed)).toBe(true)
    expect(fresh.timeline).toEqual([])
    expect(fresh.tools).toEqual([])
    expect(fresh.openText).toBe('')
  })
})

describe('shouldReleaseStreamBufferBeforeEvent', () => {
  it('releases before first tools when reasoning and body already buffered', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, { type: 'reasoning_piece', piece: 'think first' })
    s = reduceStreamTurn(s, { type: 'text_piece', piece: 'plan body' })
    const entries = [{ id: 't1', name: 'read_file', status: 'running' }]
    expect(shouldReleaseStreamBufferBeforeEvent(s, { kind: 'tools', entries })).toBe(true)
  })

  it('does not release mid pre-tool body stream', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, { type: 'text_piece', piece: 'partial ' })
    expect(
      shouldReleaseStreamBufferBeforeEvent(s, { kind: 'text_piece', piece: 'more' }),
    ).toBe(false)
  })

  it('does not release on post-tool text (same uncertain reply as tools)', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 't1', name: 'grep', status: 'ok', output: 'hits' }],
    })
    expect(
      shouldReleaseStreamBufferBeforeEvent(s, {
        kind: 'text_piece',
        piece: '## answer',
        phase: 'post_tools',
      }),
    ).toBe(false)
  })

  it('does not release on post-tool reasoning', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 't1', name: 'read_file', status: 'ok', output: 'done' }],
    })
    expect(
      shouldReleaseStreamBufferBeforeEvent(s, { kind: 'reasoning_piece', piece: 'think' }),
    ).toBe(false)
  })
})

describe('mergeCompactedPartsIntoTurn', () => {
  it('merges sealed parts with current turn for one stream projection', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, { type: 'reasoning_piece', piece: 'think A' })
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 't1', name: 'read_file', status: 'ok', output: 'ok' }],
    })
    const { sealed, fresh } = drainStreamTurnRoundBuffer(s)
    const part = finalizedTurnToCompactedPart(finalizeStreamTurn(sealed, ''))
    let cur = reduceStreamTurn(fresh, { type: 'reasoning_piece', piece: 'think B' })
    const merged = projectStreamTurnWithCompacted(cur, [part])
    expect(merged.segments.some((x) => x.kind === 'tools')).toBe(true)
    expect(merged.segments.some((x) => x.kind === 'reasoning')).toBe(true)
    const toolsIdx = merged.segments.findIndex((x) => x.kind === 'tools')
    const lastReasoningIdx = merged.segments.map((x) => x.kind).lastIndexOf('reasoning')
    expect(toolsIdx).toBeGreaterThanOrEqual(0)
    expect(lastReasoningIdx).toBeGreaterThan(toolsIdx)
  })

  it('keeps chronological order: compacted segments before current turn', () => {
    const part = {
      segments: [{ kind: 'tools', ids: ['t1'] }],
      text: '',
      tools: [{ id: 't1', name: 'grep', status: 'ok' }],
      reasoningSegments: [],
      reasoningPreview: null,
      images: [],
      videos: [],
      audios: [],
      files: [],
    }
    const cur = reduceStreamTurn(emptyStreamTurn(), {
      type: 'reasoning_piece',
      piece: 'after tools',
    })
    const merged = mergeCompactedPartsIntoTurn([part], cur)
    expect(merged.timeline[0]?.kind).toBe('tools')
    expect(merged.timeline[1]?.kind).toBe('reasoning')
  })

  it('stale filter keeps same-turn compacted tool ids', () => {
    const turn = mergeCompactedPartsIntoTurn(
      [
        {
          segments: [{ kind: 'tools', ids: ['t1'] }],
          text: '',
          tools: [{ id: 't1', name: 'read_file', status: 'ok' }],
          reasoningSegments: [],
          reasoningPreview: null,
          images: [],
          videos: [],
          audios: [],
          files: [],
        },
      ],
      emptyStreamTurn(),
    )
    const stale = staleToolIdsExcludingTurnTools(['t1', 't-old'], turn)
    expect(stale).toEqual(['t-old'])
  })
})

describe('capStreamTailText', () => {
  it('passes through under cap', () => {
    expect(capStreamTailText('hello', 100)).toBe('hello')
  })

  it('keeps tail and adds truncation head', () => {
    const raw = 'a'.repeat(100)
    const out = capStreamTailText(raw, 40)
    expect(out.length).toBeLessThanOrEqual(40)
    expect(out).toContain('仅保留最近部分')
    expect(out.endsWith('aaa')).toBe(true)
  })
})

describe('reduceStreamTurn body cap', () => {
  it('caps openText after many text_piece events', () => {
    let s = emptyStreamTurn()
    for (let i = 0; i < 300; i++) {
      s = reduceStreamTurn(s, { type: 'text_piece', piece: 'x'.repeat(2000) + i })
    }
    expect(s.openText.length).toBeLessThanOrEqual(STREAM_ASSISTANT_BODY_CAP)
    expect(s.openText).toContain('仅保留最近部分')
  })

  it('caps reasoning timeline segments', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, { type: 'reasoning_piece', piece: 'r'.repeat(STREAM_REASONING_TEXT_CAP + 5000) })
    const reasoning = s.timeline.find((seg) => seg.kind === 'reasoning')
    expect(reasoning?.text.length).toBeLessThanOrEqual(STREAM_REASONING_TEXT_CAP)
  })
})

describe('reduceStreamTurn write_file_progress', () => {
  it('stores line stats on the matching tool row', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 'tc1', name: 'write_to_file', function: { name: 'write_to_file', arguments: '{"path":"a.txt"}' } }],
    })
    s = reduceStreamTurn(s, {
      type: 'write_file_progress',
      toolCallId: 'tc1',
      progress: { path: 'a.txt', lines_added: 12, lines_removed: 0 },
    })
    const tool = s.tools[0]
    expect(tool._writeProgress).toEqual({ path: 'a.txt', tool_name: undefined, lines_added: 12, lines_removed: 0 })
  })
})

describe('reduceStreamTurn content blocks', () => {
  it('projectStreamTurn prefers block timeline sorted by seq', () => {
    const block = { blockId: 'run:b1', blockKind: 'body_text', seq: 4 }
    const toolsBlock = { blockId: 'run:b2', blockKind: 'tools', seq: 2 }
    const reasoningBlock = { blockId: 'run:b3', blockKind: 'reasoning', seq: 3 }
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, { type: 'text_piece', piece: 'plan', phase: 'pre_tools', block: { blockId: 'run:b0', blockKind: 'plan_text', seq: 1 } })
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 't1', name: 'read_file' }],
      block: toolsBlock,
    })
    s = reduceStreamTurn(s, { type: 'reasoning_piece', piece: 'think', block: reasoningBlock })
    s = reduceStreamTurn(s, { type: 'text_piece', piece: 'report', phase: 'post_tools', block })
    const proj = projectStreamTurn(s)
    expect(proj.segments.map((seg) => seg.seq)).toEqual([1, 2, 3, 4])
    expect(proj.reasoningPreview).toBe('think')
  })

  it('finalizeStreamTurn skips timeline normalize when blocks present', () => {
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, { type: 'text_piece', piece: 'wrong order body', phase: 'post_tools', block: { blockId: 'r:b4', blockKind: 'body_text', seq: 4 } })
    s = reduceStreamTurn(s, { type: 'reasoning_piece', piece: 'think', block: { blockId: 'r:b3', blockKind: 'reasoning', seq: 3 } })
    s.timeline.push({ kind: 'text', text: 'legacy noise' })
    const fin = finalizeStreamTurn(s, '')
    expect(fin.segments?.map((seg) => seg.seq)).toEqual([3, 4])
  })

  it('block_close marks block status without dropping segment text', () => {
    const plan = { blockId: 'run:b1', blockKind: 'plan_text', seq: 1 }
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, { type: 'text_piece', piece: 'plan', phase: 'pre_tools', block: plan })
    s = reduceStreamTurn(s, { type: 'block_close', block: plan })
    expect(s.blocks['run:b1'].status).toBe('closed')
    const proj = projectStreamTurn(s)
    expect(proj.segments).toHaveLength(1)
    expect(proj.segments[0].text).toBe('plan')
  })

  it('block authority skips legacy timeline writes', () => {
    const plan = { blockId: 'run:b1', blockKind: 'plan_text', seq: 1 }
    const toolsBlock = { blockId: 'run:b2', blockKind: 'tools', seq: 2 }
    const reasoningBlock = { blockId: 'run:b3', blockKind: 'reasoning', seq: 3 }
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, { type: 'text_piece', piece: 'plan', phase: 'pre_tools', block: plan })
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 't1', name: 'read_file' }],
      block: toolsBlock,
    })
    s = reduceStreamTurn(s, { type: 'reasoning_piece', piece: 'think', block: reasoningBlock })
    expect(s.timeline).toEqual([])
    expect(projectStreamTurn(s).segments.map((seg) => seg.seq)).toEqual([1, 2, 3])
    expect(shouldReleaseStreamBufferBeforeEvent(s, { kind: 'tools', entries: [{ id: 't2', name: 'grep' }] })).toBe(
      false,
    )
  })

  it('finalizeStreamTurn flushes openText into block body on abort path', () => {
    const body = { blockId: 'run:b4', blockKind: 'body_text', seq: 4 }
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, { type: 'text_piece', piece: 'report', phase: 'post_tools', block: body })
    s = { ...s, openText: ' tail' }
    const fin = finalizeStreamTurn(s, '')
    expect(fin.segments?.find((seg) => seg.seq === 4)?.text).toBe('report tail')
  })

  it('projectStreamTurn exposes tools segment when block path skips legacy timeline', () => {
    const plan = { blockId: 'run:b1', blockKind: 'plan_text', seq: 1 }
    const toolsBlock = { blockId: 'run:b2', blockKind: 'tools', seq: 2 }
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, { type: 'text_piece', piece: 'plan', phase: 'pre_tools', block: plan })
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 't1', name: 'read_file', status: 'running' }],
      block: toolsBlock,
    })
    expect(s.timeline).toEqual([])
    const proj = projectStreamTurn(s)
    expect(proj.segments.some((seg) => seg.kind === 'tools' && seg.ids?.includes('t1'))).toBe(true)
    expect(proj.tools).toHaveLength(1)
  })

  it('tools_update syncs ids onto tools block in block path', () => {
    const toolsBlock = { blockId: 'run:b2', blockKind: 'tools', seq: 2 }
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, { type: 'text_piece', piece: 'plan', phase: 'pre_tools', block: { blockId: 'run:b1', blockKind: 'plan_text', seq: 1 } })
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 't1', name: 'grep', status: 'running' }],
      block: toolsBlock,
    })
    s = reduceStreamTurn(s, {
      type: 'tools_update',
      entries: [{ id: 't1', name: 'grep', status: 'ok', output: 'done' }],
    })
    expect(s.blocks['run:b2'].toolIds).toEqual(['t1'])
    const proj = projectStreamTurn(s)
    expect(proj.segments.some((seg) => seg.kind === 'tools' && seg.ids?.includes('t1'))).toBe(true)
  })

  it('projectStreamTurn exposes tools when tool block arrives before plan text', () => {
    const toolsBlock = { blockId: 'run:b2', blockKind: 'tools', seq: 2 }
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 't1', name: 'read_file', status: 'running' }],
      block: toolsBlock,
    })
    s = reduceStreamTurn(s, {
      type: 'text_piece',
      piece: 'plan',
      phase: 'pre_tools',
      block: { blockId: 'run:b1', blockKind: 'plan_text', seq: 1 },
    })
    const proj = projectStreamTurn(s)
    expect(proj.segments.some((seg) => seg.kind === 'tools' && seg.ids?.includes('t1'))).toBe(true)
    expect(proj.tools).toHaveLength(1)
  })

  it('new tool batch after open tools + reasoning creates new block at bottom (not merged into old)', () => {
    const toolsBlock1 = { blockId: 'run:b2', blockKind: 'tools', seq: 2 }
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 't1', name: 'read_file', status: 'running' }],
      block: toolsBlock1,
    })
    s = reduceStreamTurn(s, {
      type: 'reasoning_piece',
      piece: '中间思考',
      block: { blockId: 'run:b3', blockKind: 'reasoning', seq: 3 },
    })
    // Second tool batch while first tools block is still open (no block_close yet)
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 't2', name: 'terminal', status: 'running' }],
      block: { blockId: 'run:b4', blockKind: 'tools', seq: 4 },
    })
    const proj = projectStreamTurn(s)
    const toolsSegs = proj.segments.filter((seg) => seg.kind === 'tools')
    const t1Seg = toolsSegs.find((seg) => seg.ids?.includes('t1'))
    const t2Seg = toolsSegs.find((seg) => seg.ids?.includes('t2'))
    expect(t1Seg).toBeDefined()
    expect(t2Seg).toBeDefined()
    expect(t1Seg).not.toBe(t2Seg)
    expect((t2Seg?.seq) || 0).toBeGreaterThan((t1Seg?.seq) || 0)
    const reasoningIdx = proj.segments.findIndex((seg) => seg.kind === 'reasoning')
    const t1Idx = proj.segments.findIndex((seg) => seg === t1Seg)
    const t2Idx = proj.segments.findIndex((seg) => seg === t2Seg)
    expect(t1Idx).toBeLessThan(reasoningIdx)
    expect(t2Idx).toBeGreaterThan(reasoningIdx)
  })

  it('new tool batch after closed tools block creates new block at bottom (not appended to old position)', () => {
    // Regression: findOpenToolsBlockWire previously returned closed tools blocks,
    // causing new tool ids to be appended into the old (smaller seq) block,
    // rendering the latest tools above earlier content.
    const toolsBlock1 = { blockId: 'run:b2', blockKind: 'tools', seq: 2 }
    let s = emptyStreamTurn()
    s = reduceStreamTurn(s, {
      type: 'text_piece',
      piece: '开场正文',
      phase: 'pre_tools',
      block: { blockId: 'run:b1', blockKind: 'body_text', seq: 1 },
    })
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 't1', name: 'read_file', status: 'ok', output: 'done' }],
      block: toolsBlock1,
    })
    // Close the first tools block (block_close arrives from SSE)
    s = reduceStreamTurn(s, { type: 'block_close', block: toolsBlock1 })
    // Post-tool body text arrives
    s = reduceStreamTurn(s, {
      type: 'text_piece',
      piece: '中间总结',
      phase: 'post_tools',
      block: { blockId: 'run:b3', blockKind: 'body_text', seq: 3 },
    })
    // New tool batch arrives WITHOUT a block wire (stream_turn path drops block)
    s = reduceStreamTurn(s, {
      type: 'tools',
      entries: [{ id: 't2', name: 'terminal', status: 'running' }],
    })
    const proj = projectStreamTurn(s)
    const toolsSegs = proj.segments.filter((seg) => seg.kind === 'tools')
    // t2 must appear in a tools segment with HIGHER seq than t1's block
    const t2Seg = toolsSegs.find((seg) => seg.ids?.includes('t2'))
    expect(t2Seg).toBeDefined()
    const t1Seg = toolsSegs.find((seg) => seg.ids?.includes('t1'))
    expect(t1Seg).toBeDefined()
    expect((t2Seg && t2Seg.seq) || 0).toBeGreaterThan((t1Seg && t1Seg.seq) || 0)
    // The new tools block must be AFTER the post-tool body text (seq 3)
    // New tools should render after post-tool body OR at least at bottom-most seq
    expect((t2Seg && t2Seg.seq) || 0).toBeGreaterThan(3)
  })
})

function seq(fn, pieces) {
  let acc = ''
  for (const p of pieces) acc = fn(acc, p)
  return acc
}

describe('重叠数字修复 — 连续相同字符不再被吞', () => {
  it('1000 不会被截成 10 (纯增量分片)', () => {
    expect(seq(appendStreamBodyPiece, ['1', '0', '0', '0'])).toBe('1000')
    expect(seq(appendStreamDeltaPiece, ['1', '0', '0', '0'])).toBe('1000')
    expect(seq(appendTextMonotonic, ['1', '0', '0', '0'])).toBe('1000')
    expect(seq(mergeReasoningStreamPiece, ['1', '0', '0', '0'])).toBe('1000')
  })

  it('100 不会被截成 10', () => {
    expect(seq(appendStreamBodyPiece, ['1', '0', '0'])).toBe('100')
    expect(seq(mergeReasoningStreamPiece, ['1', '0', '0'])).toBe('100')
  })

  it('正文混合数字: 满分100分', () => {
    expect(seq(appendStreamBodyPiece, ['满分', '100', '分'])).toBe('满分100分')
    expect(seq(appendStreamBodyPiece, ['满分1', '0', '0分'])).toBe('满分100分')
  })

  it('价格10 + 0元 = 价格100元 (尾部字符重叠不误吞)', () => {
    expect(seq(appendStreamBodyPiece, ['价格10', '0元'])).toBe('价格100元')
    expect(seq(appendTextMonotonic, ['价格10', '0元'])).toBe('价格100元')
    expect(seq(mergeReasoningStreamPiece, ['价格10', '0元'])).toBe('价格100元')
  })

  it('累积重放仍正确去重: [满分100, 满分100分]', () => {
    expect(seq(appendStreamBodyPiece, ['满分100', '满分100分'])).toBe('满分100分')
    expect(seq(appendTextMonotonic, ['满分100', '满分100分'])).toBe('满分100分')
    expect(seq(mergeReasoningStreamPiece, ['满分100', '满分100分'])).toBe('满分100分')
  })

  it('纯重复数字累积重放: [100, 100分] = 100分', () => {
    expect(seq(appendStreamBodyPiece, ['100', '100分'])).toBe('100分')
    expect(seq(appendTextMonotonic, ['100', '100分'])).toBe('100分')
    expect(seq(mergeReasoningStreamPiece, ['100', '100分'])).toBe('100分')
  })

  it('连续相同数字拼接: [100, 00] = 10000', () => {
    expect(seq(appendStreamBodyPiece, ['100', '00'])).toBe('10000')
    expect(seq(appendStreamDeltaPiece, ['100', '00'])).toBe('10000')
    expect(seq(appendTextMonotonic, ['100', '00'])).toBe('10000')
  })

  it('delta piece 纯追加 (不做任何去重)', () => {
    expect(seq(appendStreamDeltaPiece, ['a', 'b', 'c'])).toBe('abc')
    expect(seq(appendStreamDeltaPiece, ['1', '1', '00'])).toBe('1100')
  })

  it('reasoning 连续空格保留', () => {
    expect(seq(mergeReasoningStreamPiece, ['The', ' user', ' wants'])).toBe('The user wants')
  })

  it('CJK 段落保留 (原有行为不回归)', () => {
    expect(seq(appendStreamBodyPiece, ['Evo', 'Flow ', '是什么\n\n', '**', 'Evo', 'Flow**']))
      .toBe('EvoFlow 是什么\n\n**EvoFlow**')
  })
})

describe('shouldKeepStreamDeltaAfterStrip', () => {
  it('keeps whitespace-only deltas (markdown paragraph breaks)', () => {
    expect(shouldKeepStreamDeltaAfterStrip('\n\n')).toBe(true)
    expect(shouldKeepStreamDeltaAfterStrip('\n')).toBe(true)
    expect(shouldKeepStreamDeltaAfterStrip(' ')).toBe(true)
  })

  it('drops only truly empty stripped results', () => {
    expect(shouldKeepStreamDeltaAfterStrip('')).toBe(false)
  })
})
