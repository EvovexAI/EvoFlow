import { describe, it, expect } from 'vitest'
import {
  omitWorkerParentWhenExpanded,
  prepareWorkerToolsForDisplayRow,
} from '../src/react/worker-file-tools.ts'
import {
  exploringActivityStepCount,
  activityPiecesHasToolSteps,
  exploringHeaderToolSummary,
  groupSegmentsForExploringDisplay,
  coalesceAdjacentActivityChunks,
  dedupeStandaloneToolChunks,
  isInterExploringTextSegment,
  isPreToolsPlanTextSegment,
  isFinalReplyTextSegment,
  splitToolIdsForExploring,
  toolBreaksExploringGroup,
  toolsForActivityPieces,
  toolsSegmentIsHiddenOnly,
} from '../src/react/lib/exploring-activity-group.ts'

describe('groupSegmentsForExploringDisplay', () => {
  it('keeps pre-tools plan text outside Exploring while streaming', () => {
    const plan = '好的，开始新一轮工作区场景工具验证！先激活 workspace 场景。'
    const segments = [
      { kind: 'reasoning', text: 'think' },
      { kind: 'text', text: plan },
      { kind: 'tools', ids: ['find1'] },
    ]
    const tools = [{ id: 'find1', name: 'find', status: 'running' }]
    expect(isPreToolsPlanTextSegment(segments, 1, tools, true)).toBe(true)
    expect(isInterExploringTextSegment(segments, 1, tools, true, true)).toBe(false)
    const chunks = groupSegmentsForExploringDisplay(segments, tools, true, true)
    expect(chunks.some((c) => c.kind === 'text' && String(c.text).includes('开始新一轮'))).toBe(true)
    const act = chunks.find((c) => c.kind === 'activity')
    expect(act?.pieces.some((p) => p.kind === 'text' && String(p.text).includes('开始新一轮'))).toBe(
      false,
    )
  })

  it('keeps pre-tools plan outside Exploring after tools finish while streaming', () => {
    const plan = '第四轮走起！换新花样来测。'
    const segments = [
      { kind: 'reasoning', text: 'think long' },
      { kind: 'text', text: plan },
      { kind: 'tools', ids: ['find1'] },
    ]
    const tools = [{ id: 'find1', name: 'find', status: 'ok' }]
    expect(isInterExploringTextSegment(segments, 1, tools, true, true)).toBe(false)
    const chunks = groupSegmentsForExploringDisplay(segments, tools, true, true)
    expect(chunks.some((c) => c.kind === 'text' && String(c.text).includes('第四轮'))).toBe(true)
    const act = chunks.find((c) => c.kind === 'activity')
    expect(act?.pieces.some((p) => p.kind === 'text')).toBe(false)
  })

  it('merges reasoning between tool segments into one activity chunk', () => {
    const segments = [
      { kind: 'text', text: '先说明计划' },
      { kind: 'reasoning', text: '想想第一步' },
      { kind: 'tools', ids: ['a'] },
      { kind: 'reasoning', text: '工具间思考' },
      { kind: 'tools', ids: ['b'] },
      { kind: 'text', text: '最终总结' },
    ]
    const chunks = groupSegmentsForExploringDisplay(segments, [], true)
    expect(chunks.map((c) => c.kind)).toEqual(['text', 'activity', 'text'])
    const act = chunks[1]
    expect(act.kind).toBe('activity')
    expect(act.pieces.map((p) => p.kind)).toEqual([
      'reasoning',
      'tools',
      'reasoning',
      'tools',
    ])
  })

  it('absorbs inter-tool text into Exploring activity', () => {
    const segments = [
      { kind: 'tools', ids: ['a'] },
      { kind: 'text', text: '好，直接调 `search_code_index` 搜一下' },
      { kind: 'tools', ids: ['b'] },
    ]
    const tools = [
      { id: 'a', name: 'search_code_index' },
      { id: 'b', name: 'grep' },
    ]
    expect(isInterExploringTextSegment(segments, 1, tools, true)).toBe(true)
    const chunks = groupSegmentsForExploringDisplay(segments, tools, true)
    expect(chunks.map((c) => c.kind)).toEqual(['activity'])
    expect(chunks[0].pieces.map((p) => p.kind)).toEqual(['tools', 'text', 'tools'])
    expect(chunks[0].pieces[1].text).toContain('search_code_index')
  })

  it('absorbs streaming narration between tool rounds before next tool segment arrives', () => {
    const segments = [
      { kind: 'tools', ids: ['a'] },
      { kind: 'text', text: '第一轮结果收到了，继续查下一处。' },
    ]
    const tools = [{ id: 'a', name: 'grep', status: 'ok' }]
    expect(isInterExploringTextSegment(segments, 1, tools, true, true)).toBe(true)
    const chunks = groupSegmentsForExploringDisplay(segments, tools, true, true)
    expect(chunks.map((c) => c.kind)).toEqual(['activity'])
    expect(chunks[0].pieces.map((p) => p.kind)).toEqual(['tools', 'text'])
  })

  it('treats intro after hidden-only tools as pre-visible plan text', () => {
    const intro = '好的，开始工作区操作冒烟测试！我会并行测试多项核心工具，验证它们是否正常工作。'
    const segments = [
      { kind: 'reasoning', text: 'think' },
      { kind: 'tools', ids: ['sc'] },
      { kind: 'reasoning', text: 'more think' },
      { kind: 'text', text: intro },
      { kind: 'tools', ids: ['mm'] },
    ]
    const tools = [
      { id: 'sc', name: 'scenario', status: 'ok' },
      { id: 'mm', name: 'mind_map', status: 'ok' },
    ]
    expect(toolsSegmentIsHiddenOnly(segments[1], tools, true)).toBe(true)
    expect(isPreToolsPlanTextSegment(segments, 3, tools, true)).toBe(true)
  })

  it('keeps intro outside Exploring when only hidden tools precede visible batch', () => {
    const intro = '好的，开始工作区操作冒烟测试！我会并行测试多项核心工具，验证它们是否正常工作。'
    const segments = [
      { kind: 'reasoning', text: 'think' },
      { kind: 'tools', ids: ['sc'] },
      { kind: 'text', text: intro },
      { kind: 'tools', ids: ['mm'] },
      { kind: 'tools', ids: ['term'] },
    ]
    const tools = [
      { id: 'sc', name: 'scenario', status: 'ok' },
      { id: 'mm', name: 'mind_map', status: 'ok' },
      { id: 'term', name: 'terminal', status: 'running' },
    ]
    const chunks = groupSegmentsForExploringDisplay(segments, tools, true, true)
    expect(chunks.some((c) => c.kind === 'text' && String(c.text).includes('冒烟测试'))).toBe(true)
    const act = chunks.find(
      (c) => c.kind === 'activity' && c.pieces.some((p) => p.kind === 'tools'),
    )
    expect(act?.pieces.some((p) => p.kind === 'text' && String(p.text).includes('冒烟测试'))).toBe(
      false,
    )
    const actTools = toolsForActivityPieces(act?.pieces || [], tools)
    expect(actTools.some((t) => String(t?.name || '').toLowerCase() === 'terminal')).toBe(true)
  })

  it('splits activity at hidden-only tools segment during streaming', () => {
    const segments = [
      { kind: 'reasoning', text: 'round1' },
      { kind: 'tools', ids: ['sc'] },
      { kind: 'reasoning', text: 'round2' },
      { kind: 'tools', ids: ['find1'] },
    ]
    const tools = [
      { id: 'sc', name: 'scenario', status: 'ok' },
      { id: 'find1', name: 'find', status: 'running' },
    ]
    const raw = groupSegmentsForExploringDisplay(segments, tools, true, true)
    const chunks = coalesceAdjacentActivityChunks(raw, true)
    const activities = chunks.filter((c) => c.kind === 'activity')
    expect(activities).toHaveLength(2)
    expect(activities[0].pieces.map((p) => p.kind)).toEqual(['reasoning'])
    expect(activities[1].pieces.some((p) => p.kind === 'tools')).toBe(true)
  })

  it('shows markdown tables outside Exploring while streaming', () => {
    const segments = [
      { kind: 'tools', ids: ['a'] },
      { kind: 'text', text: '| A | B |\n| --- | --- |\n| 1 | 2 |\n\n总结如下' },
    ]
    const tools = [{ id: 'a', name: 'read_file', status: 'ok' }]
    expect(isInterExploringTextSegment(segments, 1, tools, true, true)).toBe(false)
    const streamingChunks = groupSegmentsForExploringDisplay(segments, tools, true, true)
    expect(streamingChunks.map((c) => c.kind)).toEqual(['activity', 'text'])
    const doneChunks = groupSegmentsForExploringDisplay(segments, tools, true, false)
    expect(doneChunks.map((c) => c.kind)).toEqual(['activity', 'text'])
  })

  it('splits streaming Exploring batches when a new reasoning round follows tools', () => {
    const segments = [
      { kind: 'reasoning', text: 'round1 think' },
      { kind: 'tools', ids: ['a'] },
      { kind: 'reasoning', text: 'round2 think' },
      { kind: 'tools', ids: ['b'] },
    ]
    const tools = [
      { id: 'a', name: 'find' },
      { id: 'b', name: 'rg' },
    ]
    const raw = groupSegmentsForExploringDisplay(segments, tools, true, true)
    const chunks = coalesceAdjacentActivityChunks(raw, true)
    expect(chunks.filter((c) => c.kind === 'activity')).toHaveLength(2)
  })

  it('merges streaming inter-tool text into one Exploring fold', () => {
    const segments = [
      { kind: 'tools', ids: ['s1'] },
      { kind: 'text', text: '继续查入口文件' },
      { kind: 'tools', ids: ['r1', 'r2'] },
      { kind: 'text', text: '再看配置' },
      { kind: 'tools', ids: ['s2'] },
    ]
    const tools = [
      { id: 's1', name: 'search_code_index' },
      { id: 'r1', name: 'read_file' },
      { id: 'r2', name: 'read_file' },
      { id: 's2', name: 'search_code_index' },
    ]
    expect(isInterExploringTextSegment(segments, 1, tools, true, true)).toBe(true)
    const raw = groupSegmentsForExploringDisplay(segments, tools, true, true)
    const chunks = coalesceAdjacentActivityChunks(raw, true)
    expect(chunks.filter((c) => c.kind === 'activity')).toHaveLength(1)
  })

  it('keeps inter-tool narration inside Exploring after tools complete while streaming', () => {
    const segments = [
      { kind: 'reasoning', text: 'think' },
      { kind: 'text', text: '还没搞定，我还在排查中。让我继续深入分析。' },
      { kind: 'tools', ids: ['rg1'] },
    ]
    const tools = [{ id: 'rg1', name: 'rg', status: 'ok' }]
    expect(isInterExploringTextSegment(segments, 1, tools, true, true)).toBe(true)
    const chunks = groupSegmentsForExploringDisplay(segments, tools, true, true)
    expect(chunks.some((c) => c.kind === 'text')).toBe(false)
    const act = chunks.find((c) => c.kind === 'activity')
    expect(act?.pieces.map((p) => p.kind)).toEqual(['reasoning', 'text', 'tools'])
  })

  it('keeps final summary outside after file mutation', () => {
    const segments = [
      { kind: 'text', text: '计划' },
      { kind: 'tools', ids: ['search'] },
      { kind: 'text', text: '准备写入' },
      { kind: 'tools', ids: ['write'] },
      { kind: 'text', text: '最终总结' },
    ]
    const tools = [
      { id: 'search', name: 'search_code_index' },
      { id: 'write', name: 'write_to_file' },
    ]
    const chunks = groupSegmentsForExploringDisplay(segments, tools, true)
    expect(chunks.map((c) => c.kind)).toEqual(['text', 'activity', 'text'])
    const act = chunks.find((c) => c.kind === 'activity')
    expect(act.pieces.map((p) => p.kind)).toEqual(['tools', 'text', 'tools'])
    expect(act.pieces[1].text).toBe('准备写入')
    expect(chunks[chunks.length - 1].text).toBe('最终总结')
    expect(isFinalReplyTextSegment(segments, 4, tools, true)).toBe(true)
    expect(isFinalReplyTextSegment(segments, 2, tools, true)).toBe(false)
  })

  it('exploringHeaderToolSummary counts per tool type', () => {
    const tools = [
      { id: 'a', name: 'search_code_index' },
      { id: 'b', name: 'search_code_index' },
      { id: 'c', name: 'read_file' },
    ]
    const summary = exploringHeaderToolSummary(tools)
    expect(summary).toBe('3工具')
    expect(summary).not.toMatch(/🔍/)
    expect(summary).not.toMatch(/step/)
  })

  it('exploringHeaderToolSummary accumulates file edit +/- across turn tools', () => {
    const exploringTools = [
      { id: 'a', name: 'search_code_index' },
      { id: 'b', name: 'read_file' },
    ]
    const turnTools = [
      ...exploringTools,
      {
        id: 'w1',
        name: 'write',
        _writeProgress: { lines_added: 3, lines_removed: 0 },
      },
      {
        id: 'r1',
        name: 'str_replace',
        _writeProgress: { lines_added: 2, lines_removed: 1 },
      },
    ]
    const pieces = [
      { kind: 'tools', ids: ['a'], segIndex: 0 },
      { kind: 'tools', ids: ['b'], segIndex: 1 },
    ]
    const summary = exploringHeaderToolSummary(exploringTools, pieces, turnTools)
    expect(summary).toBe('2工具 2轮 +5 −1')
  })

  it('step count uses tool segments not per-file tool ids', () => {
    const pieces = [
      { kind: 'reasoning', text: 'think', segIndex: 0 },
      { kind: 'tools', ids: ['a', 'b', 'c'], segIndex: 1 },
    ]
    expect(exploringActivityStepCount(pieces)).toBe(2)
  })

  it('keeps write/delete/replace inside Exploring', () => {
    const segments = [
      { kind: 'text', text: '计划' },
      { kind: 'tools', ids: ['search', 'write'] },
    ]
    const tools = [
      { id: 'search', name: 'search_code_index' },
      { id: 'write', name: 'write_to_file', args: { path: 'a.txt' } },
    ]
    const chunks = groupSegmentsForExploringDisplay(segments, tools, true)
    expect(chunks.map((c) => c.kind)).toEqual(['text', 'activity'])
    const act = chunks.find((c) => c.kind === 'activity')
    expect(act.pieces.find((p) => p.kind === 'tools')?.ids).toEqual(['search', 'write'])
  })

  it('includes legacy segment fixtures for gateway-hidden tools (live stream filtered server-side)', () => {
    const segments = [{ kind: 'tools', ids: ['sc', 'read'] }]
    const tools = [
      { id: 'sc', name: 'scenario', input: { action: 'activate', scenario_key: 'plan' } },
      { id: 'read', name: 'read_file' },
    ]
    const chunks = groupSegmentsForExploringDisplay(segments, tools, true)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].kind).toBe('activity')
    expect(chunks[0].pieces.find((p) => p.kind === 'tools')?.ids).toEqual(['read'])
    const listed = exploringHeaderToolSummary(toolsForActivityPieces(chunks[0].pieces, tools))
    expect(listed).toContain('工具')
  })

  it('splitToolIdsForExploring keeps file mutations in exploring', () => {
    const tools = [
      { id: 'a', name: 'list_dir' },
      { id: 'b', name: 'delete_file' },
    ]
    expect(splitToolIdsForExploring(['a', 'b'], tools, true)).toEqual({
      exploring: ['a', 'b'],
      standalone: [],
    })
  })

  it('interleaves reasoning and tools in activity pieces when timeline alternates', () => {
    const segments = [
      { kind: 'reasoning', text: 'think1' },
      { kind: 'tools', ids: ['t1'] },
      { kind: 'reasoning', text: 'think2' },
      { kind: 'tools', ids: ['t2'] },
      { kind: 'reasoning', text: 'think3' },
    ]
    const tools = [
      { id: 't1', name: 'rg' },
      { id: 't2', name: 'read_file' },
    ]
    const chunks = groupSegmentsForExploringDisplay(segments, tools, true, false)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].kind).toBe('activity')
    expect(chunks[0].pieces.map((p) => p.kind)).toEqual([
      'reasoning',
      'tools',
      'reasoning',
      'tools',
      'reasoning',
    ])
  })

  it('layout: plan + single Exploring + final reply', () => {
    const segments = [
      { kind: 'text', text: '先说明计划' },
      { kind: 'reasoning', text: '想想步骤' },
      { kind: 'tools', ids: ['read', 'grep'] },
      { kind: 'text', text: '搜完再看写入' },
      { kind: 'tools', ids: ['write'] },
      { kind: 'text', text: '最终总结给用户' },
    ]
    const tools = [
      { id: 'read', name: 'read_file' },
      { id: 'grep', name: 'search_code_index' },
      { id: 'write', name: 'write_to_file' },
    ]
    const streaming = groupSegmentsForExploringDisplay(segments, tools, true, true)
    expect(streaming.map((c) => c.kind)).toEqual(['text', 'activity', 'text'])
    const act = streaming.find((c) => c.kind === 'activity')
    expect(act.pieces.map((p) => p.kind)).toEqual(['reasoning', 'tools', 'text', 'tools'])
    expect(isFinalReplyTextSegment(segments, 5, tools, true, true)).toBe(true)

    const done = groupSegmentsForExploringDisplay(segments, tools, true, false)
    expect(done.map((c) => c.kind)).toEqual(['text', 'activity', 'text'])
    expect(done[0].text).toBe('先说明计划')
    expect(done[done.length - 1].text).toBe('最终总结给用户')
    expect(isFinalReplyTextSegment(segments, 5, tools, true, false)).toBe(true)
  })

  it('dedupes duplicate tool ids within one tools segment', () => {
    const dupId = 'search-read-9-e8afa0aad1'
    const segments = [{ kind: 'tools', ids: [dupId, dupId] }]
    const tools = [{ id: dupId, name: 'read_file', input: { path: '/a.py' } }]
    const chunks = groupSegmentsForExploringDisplay(segments, tools, true)
    expect(chunks).toHaveLength(1)
    const toolPiece = chunks[0].pieces.find((p) => p.kind === 'tools')
    expect(toolPiece?.ids).toEqual([dupId])
  })

  it('keeps plan tool inside Exploring batch', () => {
    const segments = [
      { kind: 'tools', ids: ['t1'] },
      { kind: 'tools', ids: ['t2'] },
    ]
    const tools = [
      { id: 't1', name: 'read_file' },
      { id: 't2', name: 'plan', input: {} },
    ]
    const chunks = groupSegmentsForExploringDisplay(segments, tools, true)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].kind).toBe('activity')
    const toolIds = chunks[0].pieces
      .filter((p) => p.kind === 'tools')
      .flatMap((p) => p.ids)
    expect(toolIds).toEqual(['t1', 't2'])
  })

  it('groups terminal/bash with other exploring tools in one activity batch', () => {
    const segments = [{ kind: 'tools', ids: ['read', 'term'] }]
    const tools = [
      { id: 'read', name: 'read_file', input: { path: 'a.py' } },
      { id: 'term', name: 'bash', input: { command: 'npm test' } },
    ]
    const chunks = groupSegmentsForExploringDisplay(segments, tools, true)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].kind).toBe('activity')
    const toolIds = chunks[0].pieces
      .filter((p) => p.kind === 'tools')
      .flatMap((p) => p.ids)
    expect(toolIds).toEqual(['read', 'term'])
  })
})

describe('toolBreaksExploringGroup', () => {
  it('keeps terminal/bash and file tools inside Exploring', () => {
    expect(toolBreaksExploringGroup({ name: 'terminal' }, true)).toBe(false)
    expect(toolBreaksExploringGroup({ name: 'bash' }, true)).toBe(false)
    expect(toolBreaksExploringGroup({ name: 'execute_command' }, true)).toBe(false)
    expect(toolBreaksExploringGroup({ name: 'read_file' }, true)).toBe(false)
    expect(toolBreaksExploringGroup({ name: 'write' }, true)).toBe(false)
    expect(toolBreaksExploringGroup({ name: 'web_search' }, true)).toBe(false)
    expect(toolBreaksExploringGroup({ name: 'subagent' }, true)).toBe(false)
  })

  it('breaks Exploring only for pending approval and ask_clarification', () => {
    expect(toolBreaksExploringGroup({ name: 'ask_clarification' }, true)).toBe(true)
    expect(
      toolBreaksExploringGroup(
        { name: 'write', status: 'pending_approval', id: 'w1' },
        true,
      ),
    ).toBe(true)
  })

  it('keeps just-approved tools standalone until final ok/error', () => {
    expect(
      toolBreaksExploringGroup({ name: 'write', status: 'approved', id: 'w1' }, true),
    ).toBe(true)
    expect(
      toolBreaksExploringGroup(
        { name: 'write', status: 'approved_waiting', id: 'w1' },
        true,
      ),
    ).toBe(true)
    expect(
      toolBreaksExploringGroup({ name: 'write', status: 'ok', id: 'w1' }, true),
    ).toBe(false)
  })
})

describe('worker search in Exploring layout', () => {
  it('groups worker parent with other exploring tools (nested worker rows hidden)', () => {
    const segments = [{ kind: 'tools', ids: ['search', 'worker'] }]
    const tools = [
      { id: 'search', name: 'search_code_index' },
      {
        id: 'worker',
        name: 'worker',
        input: { tasks: [{ action: 'search', query: 'bar' }] },
      },
      {
        id: 'worker-0-abc',
        name: 'search_code_index',
        input: {
          query: 'bar',
          parent_worker_tool_call_id: 'worker',
          invocation_source: 'worker',
        },
        output: 'Symbols:\n  - foo @ a.py:1',
      },
    ]
    const prepared = prepareWorkerToolsForDisplayRow(tools, segments)
    const panelTools = omitWorkerParentWhenExpanded(prepared.tools)
    const chunks = groupSegmentsForExploringDisplay(prepared.segments, panelTools, true)
    expect(chunks.map((c) => c.kind)).toEqual(['activity'])
    const act = chunks.find((c) => c.kind === 'activity')
    const toolIds = act?.pieces.filter((p) => p.kind === 'tools').flatMap((p) => p.ids)
    expect(toolIds).toEqual(['search', 'worker-0-abc'])
  })

  it('exploringHeaderToolSummary falls back to step count without resolved tool rows', () => {
    const pieces = [
      { kind: 'reasoning', text: 'think', segIndex: 0 },
      { kind: 'tools', ids: ['sc'], segIndex: 1 },
    ]
    expect(exploringHeaderToolSummary([], pieces)).toBe('1工具 1轮')
  })

  it('exploringHeaderToolSummary omits step count for reasoning-only activity', () => {
    const pieces = [{ kind: 'reasoning', text: 'think', segIndex: 0 }]
    expect(activityPiecesHasToolSteps(pieces)).toBe(false)
    expect(exploringHeaderToolSummary([], pieces)).toBe('')
  })

  it('exploringHeaderToolSummary shows worker icon for worker tool rows', () => {
    const tools = [
      {
        id: 'call_w1',
        name: 'worker',
        function: {
          name: 'worker',
          arguments: JSON.stringify({
            tasks: [
              { action: 'search', query: 'docker' },
              { action: 'locate', query: '*.yml' },
            ],
          }),
        },
      },
    ]
    const summary = exploringHeaderToolSummary(tools)
    expect(summary).toBe('1工具')
  })

  it('keeps one Explored fold when inter-tool text looks like a summary but more tools follow', () => {
    const segments = [
      { kind: 'tools', ids: ['a', 'b', 'c', 'd'] },
      {
        kind: 'text',
        text: '我已经对 backend 做了初步分析，接下来继续搜索 cli 相关模块与入口文件',
      },
      { kind: 'tools', ids: ['e', 'f', 'g'] },
      { kind: 'tools', ids: ['h'] },
    ]
    const tools = [
      { id: 'a', name: 'find_file', input: { pattern: 'cli*' } },
      { id: 'b', name: 'find_file', input: { pattern: 'cli*' } },
      { id: 'c', name: 'rg', input: { pattern: 'cli', path: 'backend' } },
      { id: 'd', name: 'search_code_index', input: { query: 'cli backend' } },
      { id: 'e', name: 'read_file', input: { path: 'backend/app/main.py' } },
      { id: 'f', name: 'find_file', input: { pattern: '*cli*' } },
      { id: 'g', name: 'rg', input: { pattern: 'argparse', path: 'backend' } },
      { id: 'h', name: 'search_code_index', input: { query: 'cli entry' } },
    ]
    expect(isInterExploringTextSegment(segments, 1, tools, true, false)).toBe(true)
    const chunks = groupSegmentsForExploringDisplay(segments, tools, true, false)
    expect(chunks.filter((c) => c.kind === 'activity')).toHaveLength(1)
    const act = chunks.find((c) => c.kind === 'activity')
    expect(act?.pieces.map((p) => p.kind)).toEqual(['tools', 'text', 'tools', 'tools'])
  })

  it('dedupes repeated write tool ids inside one activity batch', () => {
    const tools = [
      { id: 'w1', name: 'write', status: 'ok', input: { path: 'smoke_test.txt' } },
      { id: 't1', name: 'terminal', status: 'ok', input: { command: 'date' } },
      { id: 'r1', name: 'read', status: 'ok', input: { path: 'a.ts' } },
    ]
    const segments = [
      { kind: 'tools', ids: ['w1'] },
      { kind: 'tools', ids: ['t1', 'r1'] },
      { kind: 'tools', ids: ['w1'] },
    ]
    const raw = groupSegmentsForExploringDisplay(segments, tools, true, true)
    const chunks = dedupeStandaloneToolChunks(raw)
    expect(chunks.filter((c) => c.kind === 'tools-standalone')).toHaveLength(0)
    const act = chunks.find((c) => c.kind === 'activity')
    expect(act?.pieces.some((p) => p.kind === 'tools' && p.ids.includes('w1'))).toBe(true)
  })

  it('splits activity at hidden-only tools when scenario tool is not hydrated yet', () => {
    const segments = [
      { kind: 'reasoning', text: 'round1' },
      { kind: 'tools', ids: ['sc'] },
      { kind: 'reasoning', text: 'round2' },
      { kind: 'tools', ids: ['find1'] },
    ]
    const tools = [{ id: 'find1', name: 'find', status: 'running' }]
    const raw = groupSegmentsForExploringDisplay(segments, tools, true, true)
    const chunks = coalesceAdjacentActivityChunks(raw, true)
    const activities = chunks.filter((c) => c.kind === 'activity')
    expect(activities).toHaveLength(2)
    expect(activities[0].pieces.map((p) => p.kind)).toEqual(['reasoning'])
    expect(activities[1].pieces.some((p) => p.kind === 'reasoning' && p.text === 'round2')).toBe(
      true,
    )
  })

  it('collapseTurnToSingleExploringChunk merges all activity/standalone and absorbs inter-activity text', async () => {
    const { collapseTurnToSingleExploringChunk } = await import(
      '../src/react/lib/exploring-activity-group.ts'
    )
    const raw = [
      { kind: 'activity', pieces: [{ kind: 'reasoning', text: 'r1', segIndex: 0 }], startIndex: 0 },
      { kind: 'text', text: 'inter-body', segIndex: 1 },
      {
        kind: 'activity',
        pieces: [{ kind: 'tools', ids: ['a'], segIndex: 2 }],
        startIndex: 2,
      },
      { kind: 'tools-standalone', ids: ['w'], segIndex: 3 },
      { kind: 'text', text: 'final', segIndex: 4 },
    ]
    const merged = collapseTurnToSingleExploringChunk(raw)
    // 活动间 text 吸收进合并 activity；活动后 text 保留为外部最终总结
    expect(merged.map((c) => c.kind)).toEqual(['activity', 'text'])
    const act = merged[0]
    if (act.kind !== 'activity') throw new Error('expected activity')
    expect(act.pieces.some((p) => p.kind === 'reasoning')).toBe(true)
    expect(act.pieces.some((p) => p.kind === 'text' && p.text === 'inter-body')).toBe(true)
    expect(act.pieces.some((p) => p.kind === 'tools' && p.ids.includes('a'))).toBe(true)
    expect(act.pieces.some((p) => p.kind === 'tools' && p.ids.includes('w'))).toBe(true)
    expect(merged[1].kind).toBe('text')
    if (merged[1].kind !== 'text') throw new Error('expected text')
    expect(merged[1].text).toBe('final')
  })

  it('collapseTurnToSingleExploringChunk absorbs body between activities into merged activity', async () => {
    const { collapseTurnToSingleExploringChunk } = await import(
      '../src/react/lib/exploring-activity-group.ts'
    )
    const raw = [
      {
        kind: 'activity',
        pieces: [
          { kind: 'reasoning', text: 'thinking before tools', segIndex: 0 },
          { kind: 'tools', ids: ['tool1'], segIndex: 1 },
        ],
        startIndex: 0,
      },
      { kind: 'text', text: 'This is the assistant body text after tools', segIndex: 2 },
      {
        kind: 'activity',
        pieces: [{ kind: 'reasoning', text: 'new reasoning after body', segIndex: 3 }],
        startIndex: 3,
      },
    ]
    const merged = collapseTurnToSingleExploringChunk(raw)
    // 正文不再下沉到合并 activity 下方，而是按到达顺序吸收进合并 activity 内部
    expect(merged.map((c) => c.kind)).toEqual(['activity'])
    const act = merged[0]
    if (act.kind !== 'activity') throw new Error('expected activity chunk')
    const reasoningTexts = act.pieces
      .filter((p) => p.kind === 'reasoning')
      .map((p) => p.text)
    expect(reasoningTexts).toContain('thinking before tools')
    expect(reasoningTexts).toContain('new reasoning after body')
    expect(act.pieces.some((p) => p.kind === 'tools')).toBe(true)
    expect(act.pieces.some((p) => p.kind === 'text' && p.text === 'This is the assistant body text after tools')).toBe(true)
  })

  it('collapseTurnToSingleExploringChunk absorbs text between reasoning-only activities into merged activity', async () => {
    const { collapseTurnToSingleExploringChunk } = await import(
      '../src/react/lib/exploring-activity-group.ts'
    )
    const raw = [
      { kind: 'activity', pieces: [{ kind: 'reasoning', text: 'r1', segIndex: 0 }], startIndex: 0 },
      { kind: 'text', text: 'plan text', segIndex: 1 },
      {
        kind: 'activity',
        pieces: [{ kind: 'reasoning', text: 'r2', segIndex: 2 }],
        startIndex: 2,
      },
    ]
    const merged = collapseTurnToSingleExploringChunk(raw)
    // 纯思考 activity 之间的 text 不再上推为开场计划，而是吸收进合并 activity
    expect(merged.map((c) => c.kind)).toEqual(['activity'])
    const act = merged[0]
    if (act.kind !== 'activity') throw new Error('expected activity')
    expect(act.pieces.some((p) => p.kind === 'text' && p.text === 'plan text')).toBe(true)
    expect(act.pieces.filter((p) => p.kind === 'reasoning')).toHaveLength(2)
  })

  it('mergeOrphanToolsOnlyActivityChunks folds tools-only batch into next activity', async () => {
    const { mergeOrphanToolsOnlyActivityChunks } = await import(
      '../src/react/lib/exploring-activity-group.ts'
    )
    const tools = [
      { id: 'rg1', name: 'rg', status: 'ok' },
      { id: 'find1', name: 'find', status: 'ok' },
    ]
    const raw = [
      { kind: 'activity', pieces: [{ kind: 'tools', ids: ['rg1'], segIndex: 0 }], startIndex: 0 },
      {
        kind: 'activity',
        pieces: [
          { kind: 'reasoning', text: 'after rg', segIndex: 1 },
          { kind: 'tools', ids: ['find1'], segIndex: 2 },
        ],
        startIndex: 1,
      },
    ]
    const merged = mergeOrphanToolsOnlyActivityChunks(raw, tools)
    expect(merged.filter((c) => c.kind === 'activity')).toHaveLength(1)
    expect(merged[0].pieces.map((p) => p.kind)).toEqual(['tools', 'reasoning', 'tools'])
  })

  it('mergeOrphanToolsOnlyActivityChunks does not chain-merge multiple tools-only batches', async () => {
    const { mergeOrphanToolsOnlyActivityChunks, groupSegmentsForExploringDisplay } = await import(
      '../src/react/lib/exploring-activity-group.ts'
    )
    const tools = [
      { id: 't1', name: 'read', status: 'ok' },
      { id: 't2', name: 'read', status: 'ok' },
      { id: 't3', name: 'rg', status: 'ok' },
    ]
    const segments = [
      { kind: 'tools', ids: ['t1'] },
      { kind: 'reasoning', text: 'round2 think' },
      { kind: 'tools', ids: ['t2', 't3'] },
    ]
    const raw = groupSegmentsForExploringDisplay(segments, tools, true, true)
    const merged = mergeOrphanToolsOnlyActivityChunks(raw, tools)
    const act = merged.find((c) => c.kind === 'activity')
    const kinds = act?.pieces.map((p) => p.kind) || []
    expect(kinds.indexOf('reasoning')).toBeGreaterThan(kinds.indexOf('tools'))
  })

  it('mergeOrphanToolsOnlyActivityChunks does not collapse chained tools-only activities before reasonings', async () => {
    const { mergeOrphanToolsOnlyActivityChunks } = await import(
      '../src/react/lib/exploring-activity-group.ts'
    )
    const tools = [
      { id: 't1', name: 'read', status: 'ok' },
      { id: 't2', name: 'read', status: 'ok' },
      { id: 't3', name: 'rg', status: 'ok' },
    ]
    const raw = [
      { kind: 'activity', pieces: [{ kind: 'tools', ids: ['t1'], segIndex: 0 }], startIndex: 0 },
      { kind: 'activity', pieces: [{ kind: 'tools', ids: ['t2'], segIndex: 1 }], startIndex: 1 },
      {
        kind: 'activity',
        pieces: [
          { kind: 'reasoning', text: 'think2', segIndex: 2 },
          { kind: 'reasoning', text: 'think3', segIndex: 3 },
        ],
        startIndex: 2,
      },
      { kind: 'activity', pieces: [{ kind: 'tools', ids: ['t3'], segIndex: 4 }], startIndex: 4 },
    ]
    const merged = mergeOrphanToolsOnlyActivityChunks(raw, tools)
    expect(merged.filter((c) => c.kind === 'activity').length).toBeGreaterThan(1)
    const folded = merged.find(
      (c) =>
        c.kind === 'activity' &&
        c.pieces.some((p) => p.kind === 'reasoning') &&
        c.pieces.some((p) => p.kind === 'tools' && p.ids.includes('t2')),
    )
    expect(folded?.pieces.map((p) => p.kind)).toEqual(['tools', 'reasoning', 'reasoning'])
  })
})
