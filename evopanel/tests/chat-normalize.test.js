import { describe, it, expect } from 'vitest'
import { collectBrowserPanelState, collectBrowserScreenshotsFromRows } from '../src/lib/browser-panel-screenshots.js'
import {
  browserPanelPreviewWithThread,
  isBrowserToolWireName,
  previewPatchFromBrowserAgUiTool,
  shouldOpenBrowserPanelForAgUiEvent,
} from '../src/lib/browser-panel-agui.js'
import {
  normalizeHistoryRole,
  messagesToDisplayRows,
  dedupeHistory,
  dropSupersededPartialAbortMessages,
  isPartialAbortHistoryMessage,
  interleaveReasoningIntoSegments,
  insertOrphanToolsIntoSegments,
  normalizeAssistantSegmentTimelineOrder,
  extractContent,
  extractChatContent,
  normalizeChatToolPayloadToEntries,
  getToolInputObject,
  getToolInputObjectFromRow,
  serializeToolCallArgsForPersist,
  extractShellCommandFromToolInput,
  extractPathFromToolInput,
  extractPathFromToolOutput,
  extractSessionIdFromToolInput,
  mergeStreamingToolCallArgStrings,
  accumulateStreamAssistantText,
  applyStreamAssistantTextDelta,
  appendStreamAssistantTextPiece,
  streamLiveTailForDisplay,
  trimAssistantBubbleMarkdown,
  parseUsageToStats,
  formatUsageTokenStr,
  stripThinkingTags,
  stripThinkingTagsPreserveNewlines,
  stripAgentMetaLines,
  upsertTool,
  formatToolDisplayValue,
  formatToolOutputForUserDisplay,
  envelopeUserMessageFromToolOutput,
  parseBrowserScreenshotToolOutput,
  parseBrowserLiveToolOutput,
  maybeSlimToolOutputForUi,
  resolveBrowserScreenshotSrc,
  isStructuredToolSummaryText,
  stripStructuredToolSummaryFromDisplayText,
  CHAT_MAIN_SESSION_KEY,
  stripLegacyEmbeddedReasoningPrefix,
  unwrapAssistantContentJsonEnvelope,
  parseAssistantContentJsonEnvelope,
  toolOmitFromChatPanel,
  turnHasVisibleChatTools,
  filterToolsForChatPanelDisplay,
  filterDisplaySegmentsForChatPanel,
  timelineHasVisibleChatTools,
  toolsSegmentHasVisibleChatTools,
  toolOmitFromStreamingChatPanel,
  CHAT_PANEL_HIDDEN_TOOL_NAMES,
  normalizeScenarioKeyForUi,
  pickDisplayChatSceneFromScenarioResult,
  mediaToolStatusFromOutput,
  parseMediaImagePreview,
  resolveMediaAssetSrc,
  inferMediaAssetsFromToolEntries,
  flattenStreamDisplayText,
  resolveHistoryMessageContent,
  resolveHistoryMessageToolCalls,
  parseTerminalExitCodeFromOutput,
  isShellToolBriefNoiseLine,
  firstMeaningfulShellOutputLine,
  extractTerminalErrorSummary,
  isTerminalToolFailed,
  maybeSyncTerminalToolStatusFromOutput,
} from '../src/lib/chat-normalize.js'

describe('toolOmitFromStreamingChatPanel', () => {
  it('shows user-facing tools during stream; hides scheduler internals only', () => {
    expect(toolOmitFromStreamingChatPanel({ name: 'read_file' })).toBe(false)
    expect(toolOmitFromStreamingChatPanel({ name: 'grep' })).toBe(false)
    expect(toolOmitFromStreamingChatPanel({ name: 'search_code_index' })).toBe(false)
    expect(toolOmitFromStreamingChatPanel({ name: 'web_fetch' })).toBe(false)
    expect(toolOmitFromStreamingChatPanel({ name: 'web_search' })).toBe(false)
    expect(toolOmitFromStreamingChatPanel({ name: 'list_dir' })).toBe(false)
    expect(toolOmitFromStreamingChatPanel({ name: 'read_lints' })).toBe(false)
    expect(toolOmitFromStreamingChatPanel({ name: 'write_to_file' })).toBe(false)
    expect(toolOmitFromStreamingChatPanel({ name: 'write' })).toBe(false)
    expect(toolOmitFromStreamingChatPanel({ name: 'replace' })).toBe(false)
    expect(toolOmitFromStreamingChatPanel({ name: 'bash' })).toBe(false)
    expect(
      toolOmitFromStreamingChatPanel({
        name: 'read_file',
        tool_call_id: 'search-1:post-search-read:0',
        input: { path: '/a.ts', invocation_source: 'post_search' },
      }),
    ).toBe(true)
    expect(
      toolOmitFromStreamingChatPanel({
        name: 'read_file',
        input: { path: '/x', invocation_source: 'prefetch' },
      }),
    ).toBe(true)
  })
})

describe('toolOmitFromChatPanel (chat bubble denylist)', () => {
  it('shows read_file / web_search / bash / MCP / agent tools in panel', () => {
    expect(toolOmitFromChatPanel({ name: 'read_file' })).toBe(false)
    expect(toolOmitFromChatPanel({ name: 'web_search' })).toBe(false)
    expect(toolOmitFromChatPanel({ name: 'bash' })).toBe(false)
    expect(toolOmitFromChatPanel({ name: 'list_dir' })).toBe(false)
    expect(toolOmitFromChatPanel({ name: 'replace_in_file' })).toBe(false)
    expect(toolOmitFromChatPanel({ name: 'some_mcp_tool' })).toBe(false)
    expect(toolOmitFromChatPanel({ name: 'list_agents' })).toBe(false)
    expect(toolOmitFromChatPanel({ name: 'create_agent' })).toBe(false)
    expect(toolOmitFromChatPanel({ name: 'update_agent' })).toBe(false)
  })
  it('hides scheduler internal tools and prefetch reads', () => {
    expect(toolOmitFromChatPanel({ name: 'scheduler:post_search_read' })).toBe(true)
    expect(
      toolOmitFromChatPanel({
        name: 'read_file',
        input: { path: '/x', invocation_source: 'prefetch' },
      }),
    ).toBe(true)
  })

  it('hides present_files and todo; shows plan / task / supervisor', () => {
    expect(toolOmitFromChatPanel({ name: 'plan' })).toBe(false)
    expect(toolOmitFromChatPanel({ name: 'task' })).toBe(false)
    expect(toolOmitFromChatPanel({ name: 'present_files' })).toBe(true)
    expect(toolOmitFromChatPanel({ name: 'present_file' })).toBe(true)
    expect(toolOmitFromChatPanel({ name: 'supervisor' })).toBe(false)
    expect(toolOmitFromChatPanel({ name: 'todo' })).toBe(true)
    expect(toolOmitFromChatPanel({ name: 'todo_write' })).toBe(true)
  })
  it('still exposes ask_clarification and propose_goal in chat panel', () => {
    expect(toolOmitFromChatPanel({ name: 'ask_clarification' })).toBe(false)
    expect(toolOmitFromChatPanel({ name: 'propose_goal' })).toBe(false)
    expect(toolOmitFromChatPanel({ name: 'propose_hosted_agent' })).toBe(false)
    expect(toolOmitFromChatPanel({ name: 'worker' })).toBe(false)
    expect(
      toolOmitFromChatPanel({
        name: 'search_code_index',
        input: { query: 'foo', invocation_source: 'worker', parent_worker_tool_call_id: 'w1' },
      }),
    ).toBe(true)
  })
  it('shows terminal / process / browser_* in panel', () => {
    expect(toolOmitFromChatPanel({ name: 'terminal' })).toBe(false)
    expect(toolOmitFromChatPanel({ name: 'execute_command' })).toBe(false)
    expect(toolOmitFromChatPanel({ name: 'process' })).toBe(false)
    expect(toolOmitFromChatPanel({ name: 'process_start' })).toBe(false)
    expect(toolOmitFromChatPanel({ name: 'process_poll' })).toBe(false)
    expect(toolOmitFromChatPanel({ name: 'process_log' })).toBe(false)
    expect(toolOmitFromChatPanel({ name: 'browser_navigate' })).toBe(false)
    expect(toolOmitFromChatPanel({ name: 'browser_snapshot' })).toBe(false)
  })
  it('CHAT_PANEL_HIDDEN_TOOL_NAMES is denylist only', () => {
    expect(CHAT_PANEL_HIDDEN_TOOL_NAMES.has('read_file')).toBe(false)
    expect(CHAT_PANEL_HIDDEN_TOOL_NAMES.has('present_files')).toBe(true)
    expect(CHAT_PANEL_HIDDEN_TOOL_NAMES.has('ask_clarification')).toBe(false)
    expect(CHAT_PANEL_HIDDEN_TOOL_NAMES.has('propose_goal')).toBe(false)
  })
  it('hides scenario tools in chat panel (header sync only)', () => {
    expect(CHAT_PANEL_HIDDEN_TOOL_NAMES.has('scenario')).toBe(true)
    expect(CHAT_PANEL_HIDDEN_TOOL_NAMES.has('scenario_activation')).toBe(true)
    expect(
      toolOmitFromChatPanel({
        name: 'scenario',
        output: JSON.stringify({
          status: 'success',
          action: 'activate',
          scenario_key: 'plan',
          all_active_scenarios: ['plan'],
        }),
      }),
    ).toBe(true)
  })
  it('hides mind_map and session_mind_map (dedicated knowledge map panel only)', () => {
    expect(toolOmitFromChatPanel({ name: 'mind_map' })).toBe(true)
    expect(toolOmitFromChatPanel({ name: 'session_mind_map' })).toBe(true)
    expect(CHAT_PANEL_HIDDEN_TOOL_NAMES.has('mind_map')).toBe(true)
    expect(CHAT_PANEL_HIDDEN_TOOL_NAMES.has('session_mind_map')).toBe(true)
  })
  it('turnHasVisibleChatTools ignores chat-panel hidden tools in DB history', () => {
    const tools = [{ tool_call_id: 'mm1', name: 'mind_map', status: 'ok' }]
    const segments = [{ kind: 'tools', ids: ['mm1'] }]
    expect(turnHasVisibleChatTools(tools, segments)).toBe(false)
    expect(timelineHasVisibleChatTools(segments, tools)).toBe(false)
    expect(toolsSegmentHasVisibleChatTools(segments[0], tools)).toBe(false)
    const mixed = [
      { tool_call_id: 'mm1', name: 'mind_map' },
      { tool_call_id: 'r1', name: 'read' },
    ]
    const mixedSeg = [{ kind: 'tools', ids: ['mm1', 'r1'] }]
    expect(turnHasVisibleChatTools(mixed, mixedSeg)).toBe(true)
    expect(toolsSegmentHasVisibleChatTools(mixedSeg[0], mixed)).toBe(true)
  })

  it('filterDisplaySegmentsForChatPanel drops hidden tool ids', () => {
    const tools = [
      { tool_call_id: 'mm1', name: 'mind_map' },
      { tool_call_id: 'r1', name: 'read' },
    ]
    const segments = [
      { kind: 'tools', ids: ['mm1', 'r1'] },
      { kind: 'text', text: 'ok' },
    ]
    const out = filterDisplaySegmentsForChatPanel(segments, tools)
    expect(out).toEqual([
      { kind: 'tools', ids: ['r1'] },
      { kind: 'text', text: 'ok' },
    ])
    expect(filterToolsForChatPanelDisplay(tools)).toEqual([{ tool_call_id: 'r1', name: 'read' }])
  })
})

describe('normalizeHistoryRole', () => {
  it('maps human to user', () => {
    expect(normalizeHistoryRole({ type: 'human' })).toBe('user')
  })
  it('maps HumanMessage-style type to user', () => {
    expect(normalizeHistoryRole({ type: 'HumanMessage' })).toBe('user')
  })
  it('maps ai to assistant', () => {
    expect(normalizeHistoryRole({ type: 'ai' })).toBe('assistant')
  })
  it('respects explicit role', () => {
    expect(normalizeHistoryRole({ role: 'user' })).toBe('user')
  })
  it('maps middleware todo HumanMessage to system (not user bubble)', () => {
    expect(
      normalizeHistoryRole({
        type: 'human',
        name: 'todo_reminder',
        content: '<system_reminder>\nYour todo list...\n</system_reminder>',
      }),
    ).toBe('system')
  })
  it('maps loop-detection injected HumanMessage to system', () => {
    expect(
      normalizeHistoryRole({
        type: 'human',
        content: '[LOOP DETECTED] Stop calling tools...',
      }),
    ).toBe('system')
  })
  it('maps conversation_summary HumanMessage to system (backend-tagged)', () => {
    expect(
      normalizeHistoryRole({
        type: 'human',
        name: 'conversation_summary',
        content: 'Here is a summary of the conversation to date:\n\nfoo',
      }),
    ).toBe('system')
  })
  it('maps LangChain summary HumanMessage without name to system (legacy checkpoint)', () => {
    expect(
      normalizeHistoryRole({
        type: 'human',
        content: "Here's a summary of the conversation to date:\n\nbar",
      }),
    ).toBe('system')
  })
  it('maps CONTEXT COMPACTION HumanMessage without name to system', () => {
    expect(
      normalizeHistoryRole({
        type: 'human',
        content: '[CONTEXT COMPACTION — REFERENCE ONLY]\n## 目标\n测试',
      }),
    ).toBe('system')
  })
  it('maps summary blocks with output_text-like shape to system', () => {
    expect(
      normalizeHistoryRole({
        type: 'human',
        content: [{ type: 'output_text', text: 'Here is a summary of the conversation to date:\n\nbaz' }],
      }),
    ).toBe('system')
  })
})

describe('extractContent + dedupeHistory', () => {
  it('hides context compaction summary from display rows', () => {
    const rows = messagesToDisplayRows([
      { type: 'human', content: '用户问题' },
      {
        type: 'human',
        content: '[CONTEXT COMPACTION — REFERENCE ONLY]\n## 目标\n不应展示',
      },
      { type: 'ai', content: '助手回答' },
    ])
    const joined = rows.map((r) => r.text || '').join('\n')
    expect(joined).not.toMatch(/CONTEXT COMPACTION/i)
    expect(joined).not.toContain('不应展示')
    expect(joined).toContain('用户问题')
    expect(joined).toContain('助手回答')
  })
  it('hides tool_history batch merge from display rows', () => {
    const rows = messagesToDisplayRows([
      { type: 'human', content: '用户问题' },
      {
        type: 'human',
        name: 'tool_history',
        content: '[tool:history] merged_tools=2\ntools: read_file\n',
      },
      { type: 'ai', content: '助手回答' },
    ])
    const joined = rows.map((r) => r.text || '').join('\n')
    expect(joined).not.toMatch(/\[tool:history\]/i)
    expect(joined).toContain('用户问题')
    expect(joined).toContain('助手回答')
  })
  it('treats type:tool as tool result (checkpoint / LangGraph)', () => {
    const c = extractContent({
      type: 'tool',
      name: 'write_file',
      tool_call_id: 'call_ab',
      content: 'OK',
    })
    expect(c.tools).toHaveLength(1)
    expect(c.tools[0].id).toBe('call_ab')
    expect(c.tools[0].output).toBe('OK')
  })
  it('attaches tool results by tool_call_id when message already lists tool_calls', () => {
    const pending = JSON.stringify({
      _evoflow_tool: { status: 'pending_approval' },
      approval: { tool_name: 'delete_file', tool_call_id: 'tc_del', summary: 'x' },
    })
    const c = extractContent({
      type: 'tool',
      name: 'delete_file',
      tool_call_id: 'tc_del',
      content: pending,
      tool_calls: [
        { id: 'tc_list', name: 'list_dir', args: { path: '.' } },
        { id: 'tc_del', name: 'delete_file', args: { path: 'x' } },
      ],
    })
    expect(c.tools).toHaveLength(2)
    const list = c.tools.find((t) => t.id === 'tc_list')
    const del = c.tools.find((t) => t.id === 'tc_del')
    expect(list?.output == null || list?.output === '').toBe(true)
    expect(del?.status).toBe('pending_approval')
  })
  it('interleaves text and tools in segments when merging assistant history', () => {
    const raw = [
      { role: 'assistant', content: [{ type: 'text', text: '先说明' }] },
      {
        role: 'assistant',
        content: [],
        tool_calls: [{ id: 't1', name: 'write_file', args: { path: '/a' } }],
      },
      { role: 'tool', tool_call_id: 't1', name: 'write_file', content: 'OK' },
      { role: 'assistant', content: [{ type: 'text', text: '再总结' }] },
    ]
    const d = dedupeHistory(raw)
    expect(d.length).toBe(1)
    // 历史回放需保持“文本在前、工具在后”，并允许后续文本继续追加为新段
    expect(d[0].segments?.map((s) => s.kind)).toEqual(['text', 'tools', 'text'])
    expect(d[0].text).toContain('先说明')
    expect(d[0].text).toContain('再总结')
  })
  it('keeps alternating text/tool order on history replay', () => {
    const raw = [
      { role: 'assistant', content: '第一段', tool_calls: [{ id: 't1', name: 'read_file', args: { path: '/a' } }] },
      { role: 'tool', tool_call_id: 't1', name: 'read_file', content: 'ok' },
      { role: 'assistant', content: '第二段', tool_calls: [{ id: 't2', name: 'read_file', args: { path: '/b' } }] },
      { role: 'tool', tool_call_id: 't2', name: 'read_file', content: 'ok' },
    ]
    const d = dedupeHistory(raw)
    expect(d.length).toBe(1)
    expect(d[0].segments?.map((s) => s.kind)).toEqual(['text', 'tools', 'text', 'tools'])
  })
  it('extracts text from string content', () => {
    const c = extractContent({ role: 'user', content: 'hello' })
    expect(c.text).toContain('hello')
  })
  it('merges consecutive assistant with different text', () => {
    const raw = [
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
    ]
    const d = dedupeHistory(raw)
    expect(d.length).toBe(1)
    expect(d[0].role).toBe('assistant')
    expect(d[0].text).toBe('a b')
  })
  it('merges claude-style stream deltas without one-char-per-line', () => {
    const raw = [
      { role: 'assistant', content: '你' },
      { role: 'assistant', content: '好' },
      { role: 'assistant', content: '世' },
      { role: 'assistant', content: '界' },
    ]
    const d = dedupeHistory(raw)
    expect(d.length).toBe(1)
    expect(d[0].text).toBe('你好世界')
  })
  it('joins multi-block content array without newline between deltas', () => {
    const c = extractContent({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'text', text: 'world' },
      ],
    })
    expect(c.text).toBe('Hello world')
  })
  it('prefers newer assistant text when it semantically contains previous text', () => {
    const raw = [
      { role: 'assistant', content: '好的！我将为您创建今日AI新闻搜索任务，并分配2个子任务。创建新闻搜索与文件写入任务' },
      {
        role: 'assistant',
        content:
          '好的！我将为您创建今日AI新闻搜索任务，并分配2个子任务。创建新闻搜索与文件写入任务 任务已创建（ID: 65c93e22）。现在我来创建2个子任务：',
      },
    ]
    const d = dedupeHistory(raw)
    expect(d.length).toBe(1)
    expect(d[0].text).toContain('任务已创建（ID: 65c93e22）')
    expect(d[0].text).not.toContain('写入任务\n好的！我将为您创建')
  })
  it('does not concatenate inter-tool status blurbs into row.text on history replay', () => {
    const raw = [
      {
        role: 'assistant',
        content: '好的，先检查当前工作区状态，看看有没有待提交的变更。',
        tool_calls: [{ id: 't1', name: 'run_terminal', args: {} }],
      },
      { role: 'tool', tool_call_id: 't1', name: 'run_terminal', content: 'ok' },
      {
        role: 'assistant',
        content: '已暂存完成。',
        tool_calls: [{ id: 't2', name: 'run_terminal', args: {} }],
      },
      { role: 'tool', tool_call_id: 't2', name: 'run_terminal', content: 'ok' },
      {
        role: 'assistant',
        content: '继续提交、推送、触发。',
        tool_calls: [{ id: 't3', name: 'run_terminal', args: {} }],
      },
      { role: 'tool', tool_call_id: 't3', name: 'run_terminal', content: 'ok' },
    ]
    const d = dedupeHistory(raw)
    expect(d.length).toBe(1)
    expect(d[0].segments?.map((s) => s.kind)).toEqual(['text', 'tools', 'text', 'tools', 'text', 'tools'])
    expect(d[0].text).toContain('先检查当前工作区状态')
    expect(d[0].text).not.toContain('已暂存完成')
    expect(d[0].text).not.toContain('继续提交、推送、触发')
  })
})

describe('messagesToDisplayRows', () => {
  it('drops resolved ask_clarification tool echo from merged assistant row', () => {
    const questionnaire = JSON.stringify({
      title: 'AI 角色需求调研',
      questions: [{ prompt: 'q1', options: [{ label: 'A' }, { label: 'B' }] }],
    })
    const rows = messagesToDisplayRows([
      { role: 'user', type: 'human', content: '创建角色', run_id: 'run-1' },
      {
        role: 'assistant',
        type: 'AIMessage',
        content: '请先确认需求',
        tool_calls: [
          {
            id: 'call_ask',
            name: 'ask_clarification',
            args: { title: '调研', questions: [{ prompt: 'q1', options: ['A', 'B'] }] },
          },
        ],
        run_id: 'run-1',
      },
      {
        role: 'user',
        type: 'human',
        content: '__EVF_CLARIFY_ANS_V1__: {"answers":[]}',
        run_id: 'run-2',
      },
      {
        role: 'tool',
        type: 'ToolMessage',
        name: 'ask_clarification',
        content: questionnaire,
        tool_call_id: 'call_ask',
      },
      {
        role: 'assistant',
        type: 'AIMessage',
        content: '好的，已创建角色',
        run_id: 'run-2',
      },
    ])
    const last = rows[rows.length - 1]
    expect(last.role).toBe('assistant')
    const names = (last.tools || []).map((t) => t.name)
    expect(names).not.toContain('ask_clarification')
  })

  it('maps system-type messages to assistant role (parity with chat.js)', () => {
    const rows = messagesToDisplayRows([
      { type: 'system', content: [{ type: 'text', text: 'sys' }] },
    ])
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].role).toBe('assistant')
    expect(rows[0].text).toContain('sys')
  })
  it('keeps real user text separate from injected todo reminder after reload', () => {
    const rows = messagesToDisplayRows([
      { type: 'human', content: '查一下今日新闻' },
      {
        type: 'human',
        name: 'todo_reminder',
        content: '<system_reminder>\nlong reminder\n</system_reminder>',
      },
      { type: 'ai', content: '好的' },
    ])
    expect(rows.map((r) => r.role)).toContain('user')
    expect(rows.map((r) => r.role)).not.toContain('system')
    const userRow = rows.find((r) => r.role === 'user')
    expect(userRow?.text).toContain('查一下今日新闻')
    expect(rows.some((r) => String(r.text || '').includes('system_reminder'))).toBe(false)
  })
  it('drops LangChain conversation summary from display rows (state API shape)', () => {
    const rows = messagesToDisplayRows([
      {
        type: 'human',
        content:
          'Here is a summary of the conversation to date:\n\n**任务状态摘要** 主任务：x',
      },
      { type: 'human', content: '用户真实问题' },
      { type: 'ai', content: '回复' },
    ])
    expect(rows.some((r) => String(r.text || '').includes('summary of the conversation to date'))).toBe(
      false,
    )
    expect(rows.find((r) => r.role === 'user')?.text).toContain('用户真实问题')
  })
})

describe('accumulateStreamAssistantText', () => {
  it('prefers longer prefix', () => {
    expect(accumulateStreamAssistantText('hel', 'hello')).toBe('hello')
  })
  it('concatenates when not prefix', () => {
    expect(accumulateStreamAssistantText('a', 'b')).toBe('ab')
  })
  it('ignores stale shorter snapshot (no duplicate concat)', () => {
    expect(accumulateStreamAssistantText('hello world', 'hello')).toBe('hello world')
  })
  it('replaces status line rewrite instead of appending', () => {
    expect(accumulateStreamAssistantText('删 ✅ | 收工', '全部删 ✅ | 收工')).toBe('全部删 ✅ | 收工')
  })
})

describe('appendStreamAssistantTextPiece', () => {
  it('appends tokens to tail after tools without replacing', () => {
    const segs = [
      { kind: 'text', text: '计划' },
      { kind: 'tools', ids: ['t1'] },
    ]
    let tail = ''
    let r = appendStreamAssistantTextPiece(segs, tail, '最终')
    tail = r.tailText
    expect(tail).toBe('最终')
    r = appendStreamAssistantTextPiece(segs, tail, '总结')
    expect(r.tailText).toBe('最终总结')
    expect(r.segments[0].text).toBe('计划')
  })

  it('ignores duplicate piece', () => {
    const segs = [{ kind: 'tools', ids: ['t1'] }]
    const r = appendStreamAssistantTextPiece(segs, 'hello', 'hello')
    expect(r.changed).toBe(false)
  })
})

describe('applyStreamAssistantTextDelta', () => {
  it('joins segments with newline for prefix match', () => {
    const segs = [{ kind: 'text', text: '写 ✅ | 下一步读' }]
    const r = applyStreamAssistantTextDelta(segs, '', '写 ✅ | 下一步读\n\n读 ✅ | 下一步改')
    expect(r.changed).toBe(true)
    expect(r.tailText).toBe('读 ✅ | 下一步改')
  })

  it('rewrites last text segment on status line update after tool flush', () => {
    const segs = [
      { kind: 'text', text: '删 ✅ | 收工' },
      { kind: 'tools', ids: ['t1'] },
    ]
    const r = applyStreamAssistantTextDelta(segs, '', '全部删 ✅ | 收工')
    expect(r.changed).toBe(true)
    expect(r.segments[0].text).toBe('全部删 ✅ | 收工')
    expect(r.tailText).toBe('')
  })

  it('appends word tokens inline without extra newlines', () => {
    const segs = []
    let tail = ''
    let r = applyStreamAssistantTextDelta(segs, tail, 'Hello')
    tail = r.tailText
    expect(tail).toBe('Hello')
    r = applyStreamAssistantTextDelta(segs, tail, 'Hello world')
    expect(r.tailText).toBe('Hello world')
    r = applyStreamAssistantTextDelta(segs, r.tailText, 'Hello world!')
    expect(r.tailText).toBe('Hello world!')
  })

  it('completes partial last line without duplicating prefix (读 → 读 ✅)', () => {
    const segs = [{ kind: 'text', text: '写 ✅' }]
    let r = applyStreamAssistantTextDelta(segs, '读', '读')
    expect(r.tailText).toBe('读')
    r = applyStreamAssistantTextDelta(r.segments, r.tailText, '读 ✅\n\n')
    expect(r.tailText).toBe('读 ✅\n\n')
    expect(r.tailText).not.toContain('读读')
  })

  it('after tool flush: ws cumulative full text only extends tail, does not replace', () => {
    const segs = [
      { kind: 'text', text: '先说明计划' },
      { kind: 'tools', ids: ['t1'] },
    ]
    let r = applyStreamAssistantTextDelta(segs, '', '先说明计划\n\n最终总结第一段')
    expect(r.tailText).toBe('最终总结第一段')
    r = applyStreamAssistantTextDelta(r.segments, r.tailText, '先说明计划\n\n最终总结第一段更多内容')
    expect(r.tailText).toBe('最终总结第一段更多内容')
    expect(r.segments[0].text).toBe('先说明计划')
  })

  it('does not put flushed inter-tool text into tail when last line extends (empty tail)', () => {
    const segs = [
      { kind: 'text', text: '计划' },
      { kind: 'tools', ids: ['t1'] },
      { kind: 'text', text: '工具间旁白最后一行' },
    ]
    const r = applyStreamAssistantTextDelta(
      segs,
      '',
      '工具间旁白最后一行\n\n最终总结开始',
    )
    expect(r.tailText).toBe('最终总结开始')
    expect(r.segments[2].text).toBe('工具间旁白最后一行')
  })

  it('streamLiveTailForDisplay strips segment prefix from tail', () => {
    const segs = [
      { kind: 'text', text: '计划' },
      { kind: 'tools', ids: ['t1'] },
      { kind: 'text', text: '旁白' },
    ]
    expect(streamLiveTailForDisplay(segs, '计划\n\n旁白\n\n最终')).toBe('最终')
  })

  it('streamLiveTailForDisplay keeps growing tail when short post-tool segment was mis-sealed', () => {
    const segs = [
      { kind: 'text', text: '好的，先创建目录。' },
      { kind: 'tools', ids: ['t1'] },
      { kind: 'text', text: '好' },
    ]
    expect(streamLiveTailForDisplay(segs, '好，测试目录已创建')).toBe('好，测试目录已创建')
  })

  it('streamLiveTailForDisplay drops whitespace-only tail', () => {
    expect(streamLiveTailForDisplay([], '\n\n\n\n')).toBe('')
  })

  it('trimAssistantBubbleMarkdown collapses trailing blank lines', () => {
    expect(trimAssistantBubbleMarkdown('正文\n\n\n\n\n')).toBe('正文')
    expect(trimAssistantBubbleMarkdown('a\n\n')).toBe('a')
  })

  it('does not replace long tail when only first 48 chars match (Exploring post-reply)', () => {
    const prefix = '## 分析\n\n第一段内容很长，用于模拟最终回复流式输出。'
    const segs = [{ kind: 'text', text: '计划' }, { kind: 'tools', ids: ['t1'] }]
    let tail = prefix
    let r = applyStreamAssistantTextDelta(segs, tail, prefix)
    tail = r.tailText
    const revised =
      '## 分析\n\n第一段内容很长，用于模拟最终回复流式输出。第二段续写继续增长而不应丢失前文。'
    r = applyStreamAssistantTextDelta(segs, tail, revised)
    expect(r.tailText).toContain('第一段')
    expect(r.tailText).toContain('第二段')
  })
})

describe('resolvePrimaryToolCallArgs (via normalizeChatToolPayloadToEntries / extract)', () => {
  it('reads function.arguments when args is empty object', () => {
    const entries = normalizeChatToolPayloadToEntries({
      data: {
        type: 'tool_call',
        tool_calls: [
          {
            id: 'call_1',
            name: 'read_file',
            args: {},
            function: {
              name: 'read_file',
              arguments:
                '{"path":"/mnt/skills/public/deep-research/SKILL.md","description":"load skill"}',
            },
          },
        ],
      },
    })
    expect(entries[0].input).toEqual({
      path: '/mnt/skills/public/deep-research/SKILL.md',
      description: 'load skill',
    })
  })
  it('extractContent merges tool_calls args from function.arguments', () => {
    const c = extractContent({
      role: 'assistant',
      tool_calls: [
        {
          id: 't1',
          name: 'read_file',
          args: {},
          function: { arguments: '{"path":"/workspace/foo.txt"}' },
        },
      ],
    })
    expect(c.tools[0].input).toEqual({ path: '/workspace/foo.txt' })
  })
  it('extractChatContent uses function.arguments for content tool blocks', () => {
    const c = extractChatContent({
      role: 'assistant',
      content: [
        {
          type: 'tool_call',
          id: 'tb1',
          name: 'read_file',
          args: {},
          function: { arguments: '{"path":"/x.md"}' },
        },
      ],
    })
    expect(c?.tools?.[0]?.input).toEqual({ path: '/x.md' })
  })
  it('extractChatContent preserves newlines on evf delta pieces (no per-chunk trim)', () => {
    const pieces = ['Evo', 'Flow ', '是什么\n\n', '**', 'Evo', 'Flow**']
    let acc = ''
    for (const piece of pieces) {
      const c = extractChatContent({
        role: 'assistant',
        content: [{ type: 'text', text: piece }],
      })
      acc += c?.text || ''
    }
    expect(acc).toBe('EvoFlow 是什么\n\n**EvoFlow**')
    expect(stripThinkingTags('\n\n**')).toBe('**')
    expect(stripThinkingTagsPreserveNewlines('\n\n**')).toBe('\n\n**')
  })
  it('extracts path from incomplete function.arguments JSON (streaming chunk)', () => {
    const entries = normalizeChatToolPayloadToEntries({
      data: {
        type: 'tool_call',
        tool_calls: [
          {
            id: 'call_1',
            name: 'read_file',
            args: {},
            function: {
              name: 'read_file',
              arguments: '{"path":"/tmp/partial-no-close',
            },
          },
        ],
      },
    })
    expect(entries[0].input).toEqual({ path: '/tmp/partial-no-close' })
  })
  it('uses top-level target_file when args empty and no function.arguments', () => {
    const entries = normalizeChatToolPayloadToEntries({
      data: {
        type: 'tool_call',
        tool_calls: [
          {
            id: 'c1',
            name: 'read_file',
            args: {},
            target_file: '/only/here.md',
          },
        ],
      },
    })
    expect(entries[0].input).toEqual({ path: '/only/here.md' })
  })
  it('getToolInputObject reads path from partial JSON string input', () => {
    expect(getToolInputObject('{"path":"/stream/read.md')).toEqual({ path: '/stream/read.md' })
  })
  it('marks slim tool_result with empty content and status ok as ok', () => {
    const entries = normalizeChatToolPayloadToEntries({
      toolCallId: 'call_rg1',
      name: 'rg',
      data: {
        type: 'tool',
        role: 'tool',
        tool_call_id: 'call_rg1',
        name: 'rg',
        content: '',
        status: 'ok',
      },
    })
    expect(entries).toHaveLength(1)
    expect(entries[0].status).toBe('ok')
  })
  it('marks slim tool_result with truncated hint as ok even without status', () => {
    const entries = normalizeChatToolPayloadToEntries({
      toolCallId: 'call_read1',
      name: 'read',
      data: {
        type: 'tool',
        role: 'tool',
        tool_call_id: 'call_read1',
        name: 'read',
        content: '',
        truncated: true,
        content_bytes: 4096,
      },
    })
    expect(entries).toHaveLength(1)
    expect(entries[0].status).toBe('ok')
    expect(entries[0].output_truncated).toBe(true)
  })
  it('keeps empty tool_call placeholder running without completion hint', () => {
    const entries = normalizeChatToolPayloadToEntries({
      data: {
        type: 'tool_call',
        tool_calls: [{ id: 'call_pending', name: 'rg', args: { pattern: 'foo' } }],
      },
    })
    expect(entries).toHaveLength(1)
    expect(entries[0].status).toBe('running')
  })
  it('pending_approval envelope wins over wire status ok on tool result', () => {
    const pending = JSON.stringify({
      _evoflow_tool: { status: 'pending_approval' },
      approval: { tool_name: 'delete', tool_call_id: 'tc_del', summary: 'x' },
    })
    const entries = normalizeChatToolPayloadToEntries({
      status: 'ok',
      data: {
        type: 'tool',
        name: 'delete',
        tool_call_id: 'tc_del',
        content: pending,
        status: 'ok',
      },
    })
    expect(entries).toHaveLength(1)
    expect(entries[0].status).toBe('pending_approval')
  })
  it('getToolInputObject picks last object from concatenated JSON blobs', () => {
    const raw =
      '{"action":"activate","scenario_key":"workspace"}' +
      '{"command":"powershell Get-ChildItem","timeout":60}'
    expect(getToolInputObject(raw)).toEqual({ command: 'powershell Get-ChildItem', timeout: 60 })
  })
})

describe('extractShellCommandFromToolInput', () => {
  it('extracts command from last concatenated JSON blob', () => {
    const raw =
      '{"action":"activate","scenario_key":"workspace"}' +
      '{"command":"powershell -Command \\"dir\\""}'
    expect(extractShellCommandFromToolInput(raw, null)).toBe('powershell -Command "dir"')
  })

  it('extracts command from partial streaming JSON', () => {
    const raw = '{"command":"npm run build'
    expect(extractShellCommandFromToolInput(raw, null)).toBe('npm run build')
  })
})

describe('getToolInputObjectFromRow terminal streaming', () => {
  it('reads command from function.arguments while input is empty', () => {
    const row = {
      id: 'tc-1',
      name: 'terminal',
      input: {},
      function: { name: 'terminal', arguments: '{"command":"git status"' },
      status: 'running',
    }
    expect(getToolInputObjectFromRow(row)).toEqual({ command: 'git status' })
  })

  it('reads path from function.arguments while input is empty object', () => {
    const row = {
      id: 'tc-2',
      name: 'read_file',
      input: {},
      function: { name: 'read_file', arguments: '{"path":"/src/app.ts"' },
      status: 'running',
    }
    expect(getToolInputObjectFromRow(row)).toEqual({ path: '/src/app.ts' })
  })

  it('reads offset/limit from streaming function.arguments before JSON closes', () => {
    const row = {
      id: 'tc-read-range',
      name: 'read_file',
      input: {},
      function: {
        name: 'read_file',
        arguments: '{"path":"/src/app.ts","offset":1300,"limit":200',
      },
      status: 'running',
    }
    expect(getToolInputObjectFromRow(row)).toEqual({
      path: '/src/app.ts',
      offset: '1300',
      limit: '200',
    })
  })

  it('getToolInputObject reads offset/limit from partial JSON string input', () => {
    expect(getToolInputObject('{"path":"/a.ts","offset":10,"limit":50')).toEqual({
      path: '/a.ts',
      offset: '10',
      limit: '50',
    })
  })

  it('merges path from function.arguments when input has other keys only', () => {
    const row = {
      id: 'tc-3',
      name: 'read_file',
      input: { invocation_source: 'post_search' },
      function: { name: 'read_file', arguments: '{"path":"/src/app.ts"}' },
      status: 'running',
    }
    expect(getToolInputObjectFromRow(row)).toEqual({
      path: '/src/app.ts',
      invocation_source: 'post_search',
    })
  })

  it('reads session_id from function.arguments for process_poll', () => {
    const row = {
      id: 'tc-4',
      name: 'process_poll',
      input: {},
      function: { name: 'process_poll', arguments: '{"session_id":"proc_abc' },
      status: 'running',
    }
    expect(getToolInputObjectFromRow(row)).toEqual({ session_id: 'proc_abc' })
  })
})

describe('serializeToolCallArgsForPersist', () => {
  it('reads path from function.arguments when args/input are empty', () => {
    expect(
      serializeToolCallArgsForPersist({
        id: 'tc-read',
        name: 'read_file',
        args: {},
        function: { name: 'read_file', arguments: '{"path":"src/app.ts","offset":10}' },
      }),
    ).toEqual({ path: 'src/app.ts', offset: 10 })
  })

  it('backfills read_file path from tool output when args missing', () => {
    expect(
      serializeToolCallArgsForPersist({
        id: 'tc-read',
        name: 'read_file',
        input: {},
        output: '[tool:summary] tool=read_file\npath: lib/foo.ts\ncore: snippet\n',
      }),
    ).toEqual({ path: 'lib/foo.ts' })
  })

  it('backfills delete_file path from tool output when args missing', () => {
    expect(
      serializeToolCallArgsForPersist({
        id: 'tc-del',
        name: 'delete_file',
        input: {},
        output: 'OK: Deleted src/old.ts (128 bytes)',
      }),
    ).toEqual({ path: 'src/old.ts' })
  })

  it('backfills write_to_file path from function.arguments when args empty', () => {
    expect(
      serializeToolCallArgsForPersist({
        id: 'tc-write',
        name: 'write_to_file',
        args: {},
        function: { name: 'write_to_file', arguments: '{"path":"outputs/a.txt","content":"hi"}' },
      }),
    ).toEqual({ path: 'outputs/a.txt', content: 'hi' })
  })
})

describe('extractPathFromToolInput', () => {
  it('extracts path from partial streaming JSON', () => {
    const raw = '{"path":"/long/path/to/file.py'
    expect(extractPathFromToolInput(raw, null)).toBe('/long/path/to/file.py')
  })
})

describe('extractPathFromToolOutput', () => {
  it('parses write tool OK line', () => {
    expect(
      extractPathFromToolOutput(
        'write',
        'OK: wrote 78 bytes to D:/example/EvoFlow/backend/smoke_test_temp.txt',
      ),
    ).toBe('D:/example/EvoFlow/backend/smoke_test_temp.txt')
  })
  it('parses replace and delete OK lines', () => {
    expect(extractPathFromToolOutput('replace', 'OK: Replaced 2 occurrence(s) in src/foo.ts')).toBe(
      'src/foo.ts',
    )
    expect(extractPathFromToolOutput('delete', 'OK: Deleted tmp/old.txt')).toBe('tmp/old.txt')
  })
})

describe('extractSessionIdFromToolInput', () => {
  it('extracts session_id from partial streaming JSON', () => {
    const raw = '{"session_id":"proc_xyz789'
    expect(extractSessionIdFromToolInput(raw, null)).toBe('proc_xyz789')
  })
})

describe('mergeStreamingToolCallArgStrings complete objects', () => {
  it('replaces prior complete JSON when next is also complete', () => {
    const a = '{"action":"activate","scenario_key":"workspace"}'
    const b = '{"command":"echo hi"}'
    expect(mergeStreamingToolCallArgStrings(a, b)).toBe(b)
  })
})

describe('upsertTool', () => {
  it('replaces empty object input with later full args', () => {
    const tools = []
    upsertTool(tools, { id: 'tc1', name: 'write_file', input: {}, status: 'running' })
    upsertTool(tools, {
      id: 'tc1',
      name: 'write_file',
      input: { path: '/mnt/x.txt', content: 'hi' },
      status: 'running',
    })
    expect(tools).toHaveLength(1)
    expect(tools[0].input).toEqual({ path: '/mnt/x.txt', content: 'hi' })
  })
  it('merges partial object inputs', () => {
    const tools = []
    upsertTool(tools, { id: 'tc1', name: 't', input: { path: '/a' }, status: 'running' })
    upsertTool(tools, { id: 'tc1', name: 't', input: { content: 'b' }, status: 'running' })
    expect(tools[0].input).toEqual({ path: '/a', content: 'b' })
  })
  it('merges string "{}" then object args', () => {
    const tools = []
    upsertTool(tools, { id: 'x', name: 'write_file', input: '{}', status: 'running' })
    upsertTool(tools, { id: 'x', name: 'write_file', input: { path: '/p', content: 'c' }, status: 'running' })
    expect(tools[0].input).toEqual({ path: '/p', content: 'c' })
  })
  it('merges by name when output exists but input still empty', () => {
    const tools = []
    upsertTool(tools, {
      id: 'call-1',
      name: 'write_file',
      input: {},
      output: 'OK',
      status: 'ok',
    })
    upsertTool(tools, { name: 'write_file', input: { path: '/mnt/a.txt', content: 'hi' }, status: 'ok' })
    expect(tools).toHaveLength(1)
    expect(tools[0].input).toEqual({ path: '/mnt/a.txt', content: 'hi' })
  })
  it('merges input from delta-style tool_call without input key (args + function.arguments)', () => {
    const tools = []
    upsertTool(tools, {
      id: 'functions.read_file:5',
      name: 'read_file',
      args: {},
      function: { name: 'read_file', arguments: '{"path":"/tmp/stream-read.txt"}' },
    })
    expect(tools[0].input).toEqual({ path: '/tmp/stream-read.txt' })
  })
  it('merges incremental function.arguments string into existing read_file row', () => {
    const tools = []
    upsertTool(tools, {
      id: 't1',
      name: 'read_file',
      args: {},
      function: { arguments: '{"path":"/x' },
    })
    upsertTool(tools, {
      id: 't1',
      name: 'read_file',
      args: {},
      function: { arguments: '{"path":"/x.md"}' },
    })
    expect(tools[0].input).toEqual({ path: '/x.md' })
  })
  it('does not merge same-name tools when each has distinct id (multi write_file)', () => {
    const tools = []
    upsertTool(tools, { id: 'call_a', name: 'write_file', input: { path: '/a' }, status: 'running' })
    upsertTool(tools, { id: 'call_b', name: 'write_file', input: { path: '/b' }, status: 'running' })
    expect(tools).toHaveLength(2)
    expect(tools[0].id).toBe('call_a')
    expect(tools[1].id).toBe('call_b')
  })
  it('updates tool name when merging placeholder entry with real tool call', () => {
    const tools = []
    upsertTool(tools, { id: 'tc1', name: '工具', input: null, output: null, status: 'pending' })
    upsertTool(tools, {
      id: 'tc1',
      name: 'supervisor',
      input: { action: 'create_task' },
      status: 'running',
    })
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('supervisor')
  })
  it('reads name from tool_name or function.name on merge', () => {
    const tools = []
    upsertTool(tools, { id: 'x', name: '工具', input: {}, status: 'running' })
    upsertTool(tools, { id: 'x', tool_name: 'read_file', input: { path: '/a' }, status: 'running' })
    expect(tools[0].name).toBe('read_file')
    upsertTool(tools, {
      id: 'y',
      name: '工具',
      input: {},
      status: 'running',
    })
    upsertTool(tools, {
      id: 'y',
      function: { name: 'bash' },
      input: { command: 'ls' },
      status: 'running',
    })
    expect(tools.find((t) => t.id === 'y')?.name).toBe('bash')
  })
  it('merges cumulative JSON string fragments into parsed input', () => {
    const tools = []
    upsertTool(tools, { id: 'c1', name: 'web_search', input: '{"query":', status: 'running' })
    upsertTool(tools, { id: 'c1', name: 'web_search', input: '{"query":"hi"}', status: 'running' })
    expect(tools[0].input).toEqual({ query: 'hi' })
  })
  it('does not replace object input with a partial JSON string', () => {
    const tools = []
    upsertTool(tools, { id: 'c2', name: 't', input: { query: 'x' }, status: 'running' })
    upsertTool(tools, { id: 'c2', name: 't', input: '{"query":', status: 'running' })
    expect(tools[0].input).toEqual({ query: 'x' })
  })
  it('merges cumulative string tool outputs', () => {
    const tools = []
    upsertTool(tools, { id: 'o1', name: 'bash', input: {}, output: 'lin', status: 'running' })
    upsertTool(tools, { id: 'o1', name: 'bash', input: {}, output: 'line1\nline2', status: 'ok' })
    expect(tools[0].output).toBe('line1\nline2')
  })
  it('backfills web_search input from JSON output when stream args were empty', () => {
    const tools = []
    upsertTool(tools, {
      id: 'ws1',
      name: 'web_search',
      input: {},
      status: 'running',
    })
    upsertTool(tools, {
      id: 'ws1',
      name: 'web_search',
      output: JSON.stringify({ query: 'cats', results: [] }),
      status: 'ok',
    })
    expect(tools[0].input).toEqual({ query: 'cats' })
  })
  it('backfills tasks input from result payload when assistant tool_calls were missing', () => {
    const tools = []
    upsertTool(tools, {
      id: 'tk1',
      name: 'tasks',
      input: {},
      status: 'ok',
      output: {
        ok: true,
        action: 'state',
        result: {
          status: 'completed',
          status_zh: '已完成',
          summary: '已按要求回复确认信息',
          progress: 100,
        },
      },
    })
    expect(tools[0].input).toMatchObject({
      action: 'state',
      status: 'completed',
      status_zh: '已完成',
      summary: '已按要求回复确认信息',
      progress: 100,
    })
  })
  it('backfills web_search ai_daily and news_53ai from JSON output when present', () => {
    const tools = []
    upsertTool(tools, {
      id: 'ws1b',
      name: 'web_search',
      input: {},
      status: 'running',
    })
    upsertTool(tools, {
      id: 'ws1b',
      name: 'web_search',
      output: JSON.stringify({
        query: 'AI 新闻',
        ai_daily: 'auto',
        news_53ai: 'latest',
        results: [],
      }),
      status: 'ok',
    })
    expect(tools[0].input).toEqual({
      query: 'AI 新闻',
      ai_daily: 'auto',
      news_53ai: 'latest',
    })
  })
  it('does not overwrite non-empty web_search input with inferred output', () => {
    const tools = []
    upsertTool(tools, {
      id: 'ws2',
      name: 'web_search',
      input: { query: 'dogs' },
      status: 'running',
    })
    upsertTool(tools, {
      id: 'ws2',
      name: 'web_search',
      output: JSON.stringify({ query: 'cats' }),
      status: 'ok',
    })
    expect(tools[0].input).toEqual({ query: 'dogs' })
  })
  it('backfills web_fetch input from JSON output when stream args were empty', () => {
    const tools = []
    upsertTool(tools, {
      id: 'wf1',
      name: 'web_fetch',
      input: {},
      status: 'running',
    })
    upsertTool(tools, {
      id: 'wf1',
      name: 'web_fetch',
      output: JSON.stringify({ url: 'https://example.com', body: 'x' }),
      status: 'ok',
    })
    expect(tools[0].input).toEqual({ url: 'https://example.com' })
  })
  it('does not downgrade completed status when values delta re-attaches running stub', () => {
    const tools = []
    upsertTool(tools, {
      id: 'lint1',
      name: 'read_lints',
      input: { paths: ['src/a.ts'] },
      output: 'No issues',
      status: 'ok',
    })
    upsertTool(tools, {
      id: 'lint1',
      name: 'read_lints',
      input: { paths: ['src/a.ts'] },
      output: null,
      status: 'running',
    })
    expect(tools[0].status).toBe('ok')
    expect(tools[0].output).toBe('')
    expect(tools[0].output_truncated).toBe(true)
  })
})

describe('parseUsageToStats', () => {
  it('parses total_tokens', () => {
    expect(parseUsageToStats({ total_tokens: 10 })).toEqual({ input: 0, output: 0, total: 10 })
  })

  it('parses flat persisted transcript rows', () => {
    expect(
      parseUsageToStats({
        role: 'assistant',
        input_tokens: 1200,
        output_tokens: 340,
        total_tokens: 1540,
      }),
    ).toEqual({ input: 1200, output: 340, total: 1540 })
  })

  it('parses anthropic cache fields', () => {
    expect(
      parseUsageToStats({
        usage_metadata: {
          input_tokens: 200,
          output_tokens: 350,
          cache_read_input_tokens: 2000,
          cache_creation_input_tokens: 0,
        },
      }),
    ).toEqual({
      input: 2200,
      output: 350,
      total: 2550,
      cacheRead: 2000,
      cacheMiss: 200,
    })
  })

  it('parses openai prompt_tokens_details cached_tokens', () => {
    expect(
      parseUsageToStats({
        usage: {
          prompt_tokens: 2200,
          completion_tokens: 350,
          total_tokens: 2550,
          prompt_tokens_details: { cached_tokens: 2000 },
        },
      }),
    ).toEqual({
      input: 2200,
      output: 350,
      total: 2550,
      cacheRead: 2000,
      cacheMiss: 200,
    })
  })

  it('parses bailian explicit cache_creation_input_tokens', () => {
    expect(
      parseUsageToStats({
        usage: {
          prompt_tokens: 2200,
          completion_tokens: 350,
          total_tokens: 2550,
          prompt_tokens_details: {
            cached_tokens: 0,
            cache_creation_input_tokens: 2000,
          },
        },
      }),
    ).toEqual({
      input: 2200,
      output: 350,
      total: 2550,
      cacheCreation: 2000,
      cacheMiss: 200,
    })
  })

  it('parses langchain usage_metadata input_token_details.cache_read', () => {
    expect(
      parseUsageToStats({
        usage_metadata: {
          input_tokens: 2200,
          output_tokens: 350,
          total_tokens: 2550,
          input_token_details: { cache_read: 2000 },
        },
      }),
    ).toEqual({
      input: 2200,
      output: 350,
      total: 2550,
      cacheRead: 2000,
      cacheMiss: 200,
    })
  })

  it('formats token string with cache hit', () => {
    expect(formatUsageTokenStr({ input: 100, output: 20, total: 120, cacheRead: 80 })).toBe(
      '↑100 ↓20 · ⚡80',
    )
  })
})

describe('usageTripletFromStreamPart', () => {
  it('reads cache from response_metadata.usage on streaming AI tasks', async () => {
    const { usageTripletFromStreamPart, usageWirePayloadFromTriplet } = await import(
      '../src/lib/chat-normalize.js'
    )
    const triplet = usageTripletFromStreamPart({
      type: 'AIMessageChunk',
      response_metadata: {
        usage: {
          input_tokens: 200,
          output_tokens: 350,
          cache_read_input_tokens: 2000,
        },
      },
    })
    expect(triplet).toEqual({
      input_tokens: 2200,
      output_tokens: 350,
      total_tokens: 2550,
      cache_read_tokens: 2000,
      cache_miss_tokens: 200,
    })
    expect(usageWirePayloadFromTriplet(triplet)).toEqual(triplet)
  })
})

describe('stripThinkingTags', () => {
  it('removes collab_phase_context blocks', () => {
    const raw =
      '你好<collab_phase_context> **Collaboration phase:** `req_confirm`</collab_phase_context>结尾'
    expect(stripThinkingTags(raw)).toBe('你好结尾')
  })
  it('removes agent meta preamble lines (identity / collab phase)', () => {
    expect(stripThinkingTags('身份：助手\n\n用户可见')).toBe('用户可见')
    expect(stripThinkingTags('协作阶段：req_confirm\n正文')).toBe('正文')
  })
})

describe('stripAgentMetaLines', () => {
  it('drops lines starting with known prefixes', () => {
    const raw = '核心任务：wait\n技能：17\n\n已完成'
    expect(stripAgentMetaLines(raw)).toBe('已完成')
  })
})

describe('tool summary display sanitization', () => {
  const sample = `path: backend/app/channels/
lines: 无
status: success
core: 成功检索到飞书相关代码。
key_facts: class FeishuChannel
refs: backend/app/channels/feishu.py
搜索代码索引工具调用成功！✅`

  it('detects structured tool summary blocks', () => {
    expect(isStructuredToolSummaryText(sample)).toBe(true)
  })

  it('strips field block but keeps trailing user line', () => {
    expect(stripStructuredToolSummaryFromDisplayText(sample)).toBe('搜索代码索引工具调用成功！✅')
  })

  it('lazy search_code_index panel display drops result body', () => {
    const out = formatToolOutputForUserDisplay(sample, 'search_code_index')
    expect(out).toBe('')
  })

  it('lazy search_code_index raw listing is not kept in panel display', () => {
    const raw = `[tool:summary] tool=search_code_index
core: 233:
Symbols:
  - function MessageRow @ evopanel/src/react/components/MessageRow.tsx:12
Read catalog:
[0] evopanel/src/react/components/MessageVirtualList.tsx`
    const out = formatToolOutputForUserDisplay(raw, 'search_code_index')
    expect(out).toBe('（点击查看完整内容）')
    expect(out).not.toContain('MessageRow.tsx')
  })

  it('read_file slice does not keep body in panel memory', () => {
    const slice = '1:hello\n2:world\n3:line\n4:more\n5:x\n6:y\n7:z\n8:w\n9:tail'
    const out = formatToolOutputForUserDisplay(slice, 'read_file')
    expect(out).toBe('')
  })

  it('read alias strips body from panel display', () => {
    const body = Array.from({ length: 20 }, (_, i) => `${i + 1}:line`).join('\n')
    const out = formatToolOutputForUserDisplay(body, 'read')
    expect(out).toBe('')
  })

  it('read_file upsert strips output from page state', () => {
    const tools = []
    upsertTool(tools, {
      id: 'r1',
      name: 'read_file',
      input: { path: 'a.md' },
      output: `${'line\n'.repeat(100)}`,
      status: 'ok',
    })
    expect(tools[0].output).toBe('')
    expect(tools[0].output_truncated).toBe(true)
    expect(tools[0].output_bytes).toBeGreaterThan(0)
  })

  it('grep / web_search upsert strips output from page state', () => {
    const tools = []
    upsertTool(tools, {
      id: 'g1',
      name: 'grep',
      input: { pattern: 'foo' },
      output: 'match line 1\n'.repeat(50),
      status: 'ok',
    })
    upsertTool(tools, {
      id: 'w1',
      name: 'web_search',
      input: { query: 'test' },
      output: JSON.stringify({ results: [{ title: 'a', snippet: 'x'.repeat(500) }] }),
      status: 'ok',
    })
    expect(tools[0].output).toBe('')
    expect(tools[1].output).toBe('')
    expect(tools[0].output_truncated).toBe(true)
    expect(tools[1].output_truncated).toBe(true)
  })

  it('bash / list_agents upsert strips output from page state', () => {
    const tools = []
    upsertTool(tools, {
      id: 'b1',
      name: 'bash',
      input: { command: 'ls -la' },
      output: 'total 42\n'.repeat(200),
      status: 'ok',
    })
    upsertTool(tools, {
      id: 'a1',
      name: 'list_agents',
      input: {},
      output: JSON.stringify({ agents: [{ id: 'x', name: 'y'.repeat(300) }] }),
      status: 'ok',
    })
    expect(tools.every((t) => t.output === '')).toBe(true)
    expect(tools.every((t) => t.output_truncated === true)).toBe(true)
  })

  it('ls / read_lints / browser tools upsert strips output from page state', () => {
    const tools = []
    upsertTool(tools, {
      id: 'l1',
      name: 'list_dir',
      input: { path: 'src' },
      output: 'file1.ts\n'.repeat(80),
      status: 'ok',
    })
    upsertTool(tools, {
      id: 'lint1',
      name: 'read_lints',
      input: { paths: ['a.ts'] },
      output: 'error TS1234\n'.repeat(40),
      status: 'ok',
    })
    expect(tools.every((t) => t.output === '')).toBe(true)
    expect(tools.every((t) => t.output_truncated === true)).toBe(true)
  })

  it('read_file markdown body is not kept in panel display', () => {
    const body = [
      '---',
      'path: skills/public/evoflow-intro/SKILL.md',
      'status: draft',
      'core: EvoFlow 自介绍技能',
      '---',
      '',
      '## 简介',
      '正文段落。',
    ].join('\n')
    const out = formatToolOutputForUserDisplay(body, 'read_file')
    expect(out).toBe('')
  })

  it('envelope tool error shows message once, not full duplicate JSON', () => {
    const raw = JSON.stringify({
      tool_name: 'read_file',
      required_scenario: 'workspace',
      candidate_scenarios: ['workspace', 'plan', 'creative'],
      _evoflow_tool: {
        status: 'error',
        message: 'Error: 工具「read_file」未激活（请先 activate workspace）。',
        error_type: 'ScenarioNotActivated',
      },
    })
    expect(envelopeUserMessageFromToolOutput(raw)).toContain('未激活')
    const panel = formatToolOutputForUserDisplay(raw, 'read_file')
    expect(panel).toContain('未激活')
    expect(panel).not.toContain('candidate_scenarios')
    expect(panel).not.toContain('_evoflow_tool')
  })

  it('terminal failure with exit code is not shown as ok output summary', () => {
    const raw = [
      'Lines Words Characters Property',
      '----- ----- ---------- --------',
      '    0',
      '=====',
      '[stderr]',
      'git : Too many revisions specified',
      '[exit code: 1]',
    ].join('\n')
    expect(parseTerminalExitCodeFromOutput(raw)).toBe(1)
    expect(isTerminalToolFailed({ status: 'ok', output: raw })).toBe(true)
    expect(formatToolOutputForUserDisplay(raw, 'terminal')).toContain('exit 1')
    expect(formatToolOutputForUserDisplay(raw, 'terminal')).toContain('Too many revisions')
    expect(isShellToolBriefNoiseLine('NativeCommandError')).toBe(true)
    expect(isShellToolBriefNoiseLine('Lines Words Characters Property')).toBe(true)
    expect(firstMeaningfulShellOutputLine(raw)).toContain('Too many revisions')
    expect(extractTerminalErrorSummary(raw)).toContain('Too many revisions')
  })

  it('maybeSyncTerminalToolStatusFromOutput marks failed shell tools', () => {
    const tool = {
      name: 'terminal',
      status: 'ok',
      output: 'boom\n[exit code: 2]',
    }
    maybeSyncTerminalToolStatusFromOutput(tool)
    expect(tool.status).toBe('error')
  })

  it('parses browser_screenshot JSON for UI preview', () => {
    const raw = JSON.stringify({
      type: 'browser_screenshot',
      summary: 'Screenshot captured (1280x800px)',
      image_url: '/api/threads/t1/browser-snapshots/abc123',
      page_url: 'https://www.taobao.com/',
    })
    const shot = parseBrowserScreenshotToolOutput(raw)
    expect(shot?.src).toBe('/api/threads/t1/browser-snapshots/abc123')
    expect(shot?.summary).toContain('1280x800')
    expect(shot?.pageUrl).toBe('https://www.taobao.com/')
    expect(resolveBrowserScreenshotSrc(shot.src)).toBe(shot.src)
    const panel = formatToolOutputForUserDisplay(raw, 'browser_snapshot')
    expect(panel).toContain('1280x800')
    expect(panel).not.toContain('image_url')
  })

  it('parses browser_screenshot JSON embedded in open tool output', () => {
    const payload = JSON.stringify({
      type: 'browser_screenshot',
      image_url: '/api/threads/t1/browser-snapshots/abc123',
      page_url: 'https://worldcup.cctv.cn/2026/index.shtml',
    })
    const raw = `Opened https://worldcup.cctv.cn/2026/index.shtml\n\n${payload}`
    const shot = parseBrowserScreenshotToolOutput(raw)
    expect(shot?.src).toBe('/api/threads/t1/browser-snapshots/abc123')
    expect(shot?.pageUrl).toBe('https://worldcup.cctv.cn/2026/index.shtml')
  })

  it('read_file persisted hint shows path only, not body', () => {
    const persisted =
      '[ToolResult persisted — read_file]\nhead summary\n\nFull output: C:\\tmp\\big.txt\nUse read_file'
    const out = formatToolOutputForUserDisplay(persisted, 'read_file')
    expect(out).toContain('C:\\tmp\\big.txt')
    expect(out).not.toContain('head summary')
  })

  it('hides raw summary from assistant history rows', () => {
    const rows = messagesToDisplayRows([
      { type: 'human', content: '查飞书代码' },
      { type: 'ai', content: sample },
    ])
    const joined = rows.map((r) => r.text || '').join('\n')
    expect(joined).not.toMatch(/^path:/m)
    expect(joined).toContain('搜索代码索引工具调用成功')
  })
})

describe('formatToolDisplayValue', () => {
  it('pretty-prints JSON strings', () => {
    expect(formatToolDisplayValue('{"a":1,"b":2}')).toBe(
      `{
  "a": 1,
  "b": 2
}`,
    )
  })
  it('leaves non-JSON strings as-is (after stripAnsi)', () => {
    expect(formatToolDisplayValue('plain ok')).toBe('plain ok')
  })
  it('stringifies objects like safeStringify', () => {
    expect(formatToolDisplayValue({ x: 1 })).toBe(
      `{
  "x": 1
}`,
    )
  })
})

describe('insertOrphanToolsIntoSegments', () => {
  it('appends orphan tools after timeline tail, not after first text', () => {
    const segs = [
      { kind: 'text', text: 'intro' },
      { kind: 'tools', ids: ['t1'] },
      { kind: 'reasoning', text: 'think' },
    ]
    const out = insertOrphanToolsIntoSegments(segs, ['t2'])
    expect(out.map((s) => s.kind)).toEqual(['text', 'tools', 'reasoning', 'tools'])
    expect(out[3].ids).toEqual(['t2'])
  })

  it('keeps leading plan text before first orphan tool batch', () => {
    const segs = [{ kind: 'text', text: '计划' }]
    const out = insertOrphanToolsIntoSegments(segs, ['t1'])
    expect(out.map((s) => s.kind)).toEqual(['text', 'tools'])
    expect(out[0].text).toBe('计划')
  })
})

describe('dropSupersededPartialAbortMessages', () => {
  it('drops partial-abort when same turn has lc_run assistant', () => {
    const raw = [
      { role: 'user', content_json: { content: '你好啊' }, id: 'u2' },
      {
        role: 'assistant',
        content_json: { content: '脏 partial' },
        id: 'partial-abort-run-old',
      },
      {
        role: 'assistant',
        content_json: { content: '你好呀～' },
        id: 'lc_run--019f1709-d597',
      },
    ]
    const filtered = dropSupersededPartialAbortMessages(raw)
    expect(filtered).toHaveLength(2)
    expect(isPartialAbortHistoryMessage(filtered[1])).toBe(false)
    const rows = dedupeHistory(filtered)
    expect(rows).toHaveLength(2)
    expect(rows[1].text).toBe('你好呀～')
  })
})

describe('reasoning timeline history', () => {
  it('interleaves reasoning before and between tool segments', () => {
    const base = [
      { kind: 'tools', ids: ['a'] },
      { kind: 'text', text: 'answer' },
    ]
    const out = interleaveReasoningIntoSegments(base, ['think-1', 'think-2'])
    expect(out.map((s) => s.kind)).toEqual(['reasoning', 'tools', 'reasoning', 'text'])
    expect(out[0].text).toBe('think-1')
    expect(out[2].text).toBe('think-2')
  })

  it('dedupeHistory builds segments from transcript content and tool_calls', () => {
    const rows = dedupeHistory([
      {
        role: 'assistant',
        content_json: {
          content: 'hi',
          reasoning: 'plan',
          tool_calls: [{ name: 'grep', id: 'x', type: 'tool_call', args: {} }],
        },
      },
    ])
    expect(rows.length).toBe(1)
    expect(rows[0].segments?.map((s) => s.kind)).toEqual(['tools', 'reasoning', 'text'])
  })

  it('dedupeHistory interleaves content_json.reasoning with tool_calls', () => {
    const rows = dedupeHistory([
      {
        role: 'assistant',
        content_json: {
          content: '终端也通了！',
          reasoning: 'Let me summarize the smoke test results.',
          tool_calls: [{ name: 'write', id: 'call_write', type: 'tool_call', args: {} }],
        },
      },
    ])
    expect(rows[0].reasoningPreview).toContain('Let me summarize')
    expect(rows[0].segments?.map((s) => s.kind)).toEqual(['tools', 'reasoning', 'text'])
  })

  it('dedupeHistory places reasoning before final report when only content_json fields exist', () => {
    const rows = dedupeHistory([
      {
        role: 'assistant',
        type: 'ai',
        content_json: {
          content: '## 测试结果：Step 1 失败 ❌\n\n测试跑完了。',
          reasoning:
            'The issue is clear now. The API endpoint is returning a 404 with the FastGPT frontend HTML page.',
        },
      },
    ])
    expect(rows.length).toBe(1)
    expect(rows[0].segments?.map((s) => s.kind)).toEqual(['reasoning', 'text'])
    expect(rows[0].segments?.[0].text).toContain('The issue is clear')
    expect(rows[0].segments?.[1].text).toContain('## 测试结果')
  })

  it('normalizeAssistantSegmentTimelineOrder moves reasoning before sealed final text', () => {
    const out = normalizeAssistantSegmentTimelineOrder([
      { kind: 'tools', ids: ['t1'] },
      { kind: 'text', text: '## 最终汇报\n\n正文' },
      { kind: 'reasoning', text: 'still thinking' },
    ])
    expect(out.map((s) => s.kind)).toEqual(['tools', 'reasoning', 'text'])
  })

  it('normalizeAssistantSegmentTimelineOrder fixes text-before-reasoning without tools', () => {
    const out = normalizeAssistantSegmentTimelineOrder([
      { kind: 'text', text: 'final answer' },
      { kind: 'reasoning', text: 'thought first chronologically' },
    ])
    expect(out.map((s) => s.kind)).toEqual(['reasoning', 'text'])
  })

  it('normalizeAssistantSegmentTimelineOrder fixes text-before-reasoning when wire seq misorders', () => {
    const out = normalizeAssistantSegmentTimelineOrder([
      { kind: 'text', text: 'final answer', seq: 1 },
      { kind: 'reasoning', text: 'thought first chronologically', seq: 2 },
    ])
    expect(out.map((s) => s.kind)).toEqual(['reasoning', 'text'])
  })

  it('normalizeAssistantSegmentTimelineOrder keeps post-tool reasoning after inter text', () => {
    const out = normalizeAssistantSegmentTimelineOrder([
      { kind: 'reasoning', text: 'plan' },
      { kind: 'text', text: '好的，让我先确认代码。' },
      { kind: 'tools', ids: ['t1'] },
      { kind: 'reasoning', text: 'Now I have the complete picture.' },
    ])
    expect(out.map((s) => s.kind)).toEqual(['reasoning', 'text', 'tools', 'reasoning'])
  })

  it('dedupeHistory keeps all reasoning segments when multiple assistant messages merge', () => {
    const rows = dedupeHistory([
      {
        role: 'assistant',
        content_json: {
          content: 'first body',
          reasoning: 'think-1',
          tool_calls: [{ name: 'write', id: 't1', type: 'tool_call', args: {} }],
        },
      },
      {
        role: 'assistant',
        content_json: {
          content: 'second body',
          reasoning: 'think-2',
          tool_calls: [{ name: 'read', id: 't2', type: 'tool_call', args: {} }],
        },
      },
    ])
    expect(rows.length).toBe(1)
    expect(rows[0].reasoningSegments).toEqual(['think-1', 'think-2'])
    expect(rows[0].segments?.map((s) => s.kind)).toEqual([
      'reasoning',
      'tools',
      'reasoning',
      'text',
      'text',
      'tools',
    ])
    expect(rows[0].segments?.[0].text).toBe('think-1')
    expect(rows[0].segments?.[2].text).toBe('think-2')
  })
})

describe('chat image path normalization', () => {
  it('normalizeLocalImagePath converts Windows backslashes', async () => {
    const { normalizeLocalImagePath } = await import('../src/lib/chat-image-src.js')
    expect(normalizeLocalImagePath('D:\\github\\EvoFlow\\outputs\\cat.png')).toBe(
      'D:/github/EvoFlow/outputs/cat.png',
    )
  })

  it('normalizeLocalImagePath recovers markdown-corrupted paths', async () => {
    const { normalizeLocalImagePath } = await import('../src/lib/chat-image-src.js')
    expect(
      normalizeLocalImagePath('D:githubEvoFlowoutputsmedia_image_dd1ec110-b420-4932-93c3-b610b19a.png'),
    ).toBe('D:/githubEvoFlow/outputs/media_image_dd1ec110-b420-4932-93c3-b610b19a.png')
  })

  it('resolveMediaAssetSrc infers workspace root from absolute path without binding', async () => {
    const { setChatWorkspaceRoot } = await import('../src/lib/chat-workspace-context.js')
    setChatWorkspaceRoot('')
    const src = resolveMediaAssetSrc('D:/github/EvoFlow/outputs/cat.png')
    expect(src).toContain('/api/workspaces/serve-file')
    expect(src).toContain(encodeURIComponent('D:/github/EvoFlow'))
    expect(src).toContain(encodeURIComponent('D:/github/EvoFlow/outputs/cat.png'))
  })
})

describe('linkifyWorkspaceAtMentions images', () => {
  it('converts @@outputs/*.png@@ to markdown image with absolute path when root bound', async () => {
    const { setChatWorkspaceRoot } = await import('../src/lib/chat-workspace-context.js')
    const { linkifyWorkspaceAtMentions } = await import('../src/lib/workspace-file-mention-display.js')
    setChatWorkspaceRoot('D:/project/ws')
    const out = linkifyWorkspaceAtMentions('生成完成：@@outputs/media_image_abc.png@@')
    expect(out).toContain('![media_image_abc.png](D:/project/ws/outputs/media_image_abc.png)')
    expect(out).not.toContain('evoflow-file:')
    setChatWorkspaceRoot('')
  })

  it('falls back to relative outputs path without workspace root', async () => {
    const { setChatWorkspaceRoot } = await import('../src/lib/chat-workspace-context.js')
    const { linkifyWorkspaceAtMentions } = await import('../src/lib/workspace-file-mention-display.js')
    setChatWorkspaceRoot('')
    const out = linkifyWorkspaceAtMentions('@@outputs/foo.png@@')
    expect(out).toContain('![foo.png](outputs/foo.png)')
  })
})

describe('linkifyWorkspaceAtMentions absolute paths', () => {
  it('preserves POSIX absolute path inside @@…@@ (does not strip leading /)', async () => {
    const { linkifyWorkspaceAtMentions } = await import('../src/lib/workspace-file-mention-display.js')
    const abs = '/Users/example/.evoflow/读白电影_AI智能体_计划.md'
    const out = linkifyWorkspaceAtMentions(`见文件 @@${abs}@@`)
    const encoded = encodeURIComponent(abs)
    expect(out).toContain(`evoflow-file:${encoded}`)
    // Leading slash must survive as %2F… (not stripped to Users/…)
    expect(encoded.startsWith('%2F')).toBe(true)
    expect(out).toContain('evoflow-file:%2FUsers%2Fexample')
  })

  it('heals stripped POSIX absolute when workspace root is bound', async () => {
    const { setChatWorkspaceRoot } = await import('../src/lib/chat-workspace-context.js')
    const {
      healStrippedAbsolutePath,
      linkifyWorkspaceAtMentions,
    } = await import('../src/lib/workspace-file-mention-display.js')
    setChatWorkspaceRoot('/Users/example/.evoflow')
    const stripped = 'Users/example/.evoflow/读白电影_AI智能体_计划.md'
    expect(healStrippedAbsolutePath(stripped)).toBe('/Users/example/.evoflow/读白电影_AI智能体_计划.md')
    const out = linkifyWorkspaceAtMentions(`@@${stripped}@@`)
    expect(out).toContain(
      `evoflow-file:${encodeURIComponent('/Users/example/.evoflow/读白电影_AI智能体_计划.md')}`,
    )
    setChatWorkspaceRoot('')
  })

  it('unwraps backtick-wrapped @@path@@ so chat does not show raw evoflow-file markdown', async () => {
    const { setChatWorkspaceRoot } = await import('../src/lib/chat-workspace-context.js')
    const { linkifyWorkspaceAtMentions } = await import('../src/lib/workspace-file-mention-display.js')
    const { renderMarkdown } = await import('../src/lib/markdown.js')
    setChatWorkspaceRoot('D:/dev/github/EvoFlow')
    const stored = '`@@D:/dev/github/EvoFlow/outputs/smart-employee-test/@@`'
    const linked = linkifyWorkspaceAtMentions(stored)
    expect(linked).toContain('evoflow-file:')
    expect(linked).not.toMatch(/`\[📄/)
    const html = renderMarkdown(`### 交付物位置\n${stored}\n`)
    expect(html).toContain('msg-workspace-file-mention')
    expect(html).toContain('data-evf-file-path="D:/dev/github/EvoFlow/outputs/smart-employee-test/"')
    expect(html).not.toMatch(/<code>[^<]*evoflow-file/)
    setChatWorkspaceRoot('')
  })
})

describe('media image inline preview', () => {
  it('resolveMediaAssetSrc maps outputs via serve-file when workspace root set', async () => {
    const { setChatWorkspaceRoot } = await import('../src/lib/chat-workspace-context.js')
    setChatWorkspaceRoot('D:/project/ws')
    const src = resolveMediaAssetSrc('outputs/media_image_abc.png')
    expect(src).toContain('/api/workspaces/serve-file')
    expect(src).toContain(encodeURIComponent('D:/project/ws'))
    setChatWorkspaceRoot('')
  })

  it('resolveMediaAssetSrc uses serve-file for absolute_path from tool', async () => {
    const { setChatWorkspaceRoot } = await import('../src/lib/chat-workspace-context.js')
    setChatWorkspaceRoot('D:/project/ws')
    const abs = 'D:/project/ws/outputs/cat.png'
    const src = resolveMediaAssetSrc(abs)
    expect(src).toContain('/api/workspaces/serve-file')
    expect(src).toContain(encodeURIComponent(abs))
    setChatWorkspaceRoot('')
  })

  it('parseMediaImagePreview prefers absolute_path from media_image_generate', async () => {
    const { setChatWorkspaceRoot } = await import('../src/lib/chat-workspace-context.js')
    setChatWorkspaceRoot('D:/project/ws')
    const out = {
      ok: true,
      status: 'succeeded',
      absolute_path: 'D:/project/ws/outputs/media_image_abc.png',
      local_path: 'D:/project/ws/outputs/media_image_abc.png',
      url: 'https://example.com/x.png',
    }
    const preview = parseMediaImagePreview(out, 'media_image_generate')
    expect(preview?.localPath).toBe('D:/project/ws/outputs/media_image_abc.png')
    expect(preview?.src).toContain('/api/workspaces/serve-file')
    setChatWorkspaceRoot('')
  })

  it('inferMediaAssetsFromToolEntries skips media_image_generate (tool card previews inline)', async () => {
    const derived = inferMediaAssetsFromToolEntries([
      {
        name: 'media_image_generate',
        output: JSON.stringify({
          ok: true,
          status: 'succeeded',
          absolute_path: 'D:/project/ws/outputs/cat.png',
        }),
      },
    ])
    expect(derived.images).toHaveLength(0)
  })
})

describe('mediaToolStatusFromOutput', () => {
  it('marks ok:false media JSON as error', () => {
    const out = JSON.stringify({ ok: false, status: 'error', message: 'missing key', provider: 'kling' })
    expect(mediaToolStatusFromOutput(out)).toBe('error')
  })
  it('marks ok:true processing as ok', () => {
    const out = JSON.stringify({ ok: true, status: 'processing', task_id: 't1' })
    expect(mediaToolStatusFromOutput(out)).toBe('ok')
  })
})

describe('media scenario aliases normalize to ask', () => {
  it('maps legacy media aliases to ask', () => {
    expect(normalizeScenarioKeyForUi('creative')).toBe('ask')
    expect(normalizeScenarioKeyForUi('media')).toBe('ask')
    expect(normalizeScenarioKeyForUi('short-video')).toBe('ask')
  })

  it('pickDisplayChatScene prefers plan over ask in active list', () => {
    expect(pickDisplayChatSceneFromScenarioResult({ all_active_scenarios: ['plan', 'ask'] }, undefined)).toBe(
      'plan',
    )
  })
})

describe('CHAT_MAIN_SESSION_KEY', () => {
  it('matches ws-client main key', () => {
    expect(CHAT_MAIN_SESSION_KEY).toBe('agent:main:main')
  })
})

describe('stripLegacyEmbeddedReasoningPrefix', () => {
  it('removes old embedded reasoning markdown header', () => {
    expect(stripLegacyEmbeddedReasoningPrefix('**思考：**\n先想想\n\n正文')).toBe('先想想\n\n正文')
    expect(stripLegacyEmbeddedReasoningPrefix('**思考:**\nonly')).toBe('only')
  })

  it('leaves normal text unchanged', () => {
    expect(stripLegacyEmbeddedReasoningPrefix('正常正文')).toBe('正常正文')
  })
})

describe('unwrapAssistantContentJsonEnvelope', () => {
  it('unwraps content_json-shaped assistant JSON to visible body', () => {
    const json =
      '{"content":"哈哈，收到～","reasoning":"The user is sending casual chat messages."}'
    expect(unwrapAssistantContentJsonEnvelope(json)).toBe('哈哈，收到～')
    expect(parseAssistantContentJsonEnvelope(json)?.reasoning).toContain('casual chat')
  })

  it('leaves normal prose unchanged', () => {
    expect(unwrapAssistantContentJsonEnvelope('正常回复')).toBe('正常回复')
  })
})

describe('relaxMarkdownLineBreaks', () => {
  it('inserts newlines before glued headings', async () => {
    const { relaxMarkdownLineBreaks, renderMarkdown } = await import('../src/lib/markdown.js')
    const raw = '介绍。---##一、整体定位'
    const relaxed = relaxMarkdownLineBreaks(raw)
    expect(relaxed).toContain('---\n\n##')
    const html = renderMarkdown(raw)
    expect(html).toContain('<h2>')
  })

  it('merges split separator chunks and renders partial streaming table', async () => {
    const { renderMarkdownStreaming } = await import('../src/lib/markdown.js')
    const raw = '**标题：EvoFlow 自动化计划**\n\n| 问题 | 现状 | 改造方向 |\n|------\n|---------|'
    const html = renderMarkdownStreaming(raw)
    expect(html).toContain('msg-streaming-table-partial')
    expect(html).toContain('<th>问题</th>')
    expect(html).toContain('<strong>标题')
  })

  it('renders complete GFM table when three rows arrive', async () => {
    const { renderMarkdownStreaming } = await import('../src/lib/markdown.js')
    const raw =
      '| 问题 | 现状 | 改造方向 |\n|------|------|---------|\n| 后端 | 硬编码 | 动态指派 |'
    const html = renderMarkdownStreaming(raw)
    expect(html).toContain('<table>')
    expect(html).toContain('<td>后端</td>')
  })

  it('splits glued H1 title and body for streaming intro', async () => {
    const { relaxMarkdownLineBreaks, renderMarkdownStreaming } = await import('../src/lib/markdown.js')
    const raw =
      '#EvoFlow产品能力全景介绍你好，我是**Evo Assistant**，由 **EvovexAI**开发。'
    const relaxed = relaxMarkdownLineBreaks(raw)
    expect(relaxed).toMatch(/介绍\n\n你好/)
    const html = renderMarkdownStreaming(raw)
    expect(html).toContain('<h1>')
    expect(html).toContain('<strong>Evo Assistant</strong>')
    expect(html).not.toMatch(/<h1>[^<]*你好/)
  })
})

describe('resolveHistoryMessageContent', () => {
  it('reads body from content_json when top-level content is absent', () => {
    const msg = { role: 'user', content_json: { content: 'only json' } }
    expect(resolveHistoryMessageContent(msg)).toBe('only json')
    expect(resolveHistoryMessageToolCalls(msg)).toBeNull()
  })

  it('prefers content_json.content over legacy top-level content', () => {
    const msg = {
      role: 'assistant',
      content: 'legacy',
      content_json: { content: 'canonical', tool_calls: [{ id: 't1' }] },
    }
    expect(resolveHistoryMessageContent(msg)).toBe('canonical')
    expect(resolveHistoryMessageToolCalls(msg)?.[0]?.id).toBe('t1')
  })

  it('extractContent works with content_json-only history API rows', () => {
    const c = extractContent({
      role: 'assistant',
      content_json: { content: [{ type: 'text', text: 'hello json' }] },
    })
    expect(c.text).toBe('hello json')
  })
})

describe('renderMarkdownStreaming', () => {
  it('renders heading and holds incomplete table in pending block', async () => {
    const { renderMarkdownStreaming } = await import('../src/lib/markdown.js')
    const src = '### 4.2 场景\n\n| Chat | 说明 |\n| --- |'
    const html = renderMarkdownStreaming(src)
    expect(html).toContain('<h3>')
    expect(html).toContain('msg-markdown-streaming-pending')
    expect(html).not.toContain('<table>')
  })

  it('keeps header and data together when separator streams as ||', async () => {
    const { renderMarkdownStreaming } = await import('../src/lib/markdown.js')
    const raw =
      '计划已就绪：\n\n| 步骤 | 任务 | 依赖 | 文件 |\n||\n| Step 1 | 生成任务1 | 无 | task1.txt |'
    const html = renderMarkdownStreaming(raw)
    expect(html).toContain('msg-streaming-table-partial')
    expect(html).toContain('<th>步骤</th>')
    expect(html).toContain('<td>Step 1</td>')
    expect(html).not.toContain('<p>| 步骤')
    expect(html).not.toContain('<p>||</p>')
  })
})

describe('collectBrowserScreenshotsFromRows', () => {
  it('collects browser_snapshot tool outputs without duplicates', () => {
    const payload = JSON.stringify({
      type: 'browser_screenshot',
      image_url: '/api/threads/t1/browser-snapshots/abc123',
      page_url: 'https://example.com',
      summary: 'Captured',
    })
    const rows = [
      {
        role: 'assistant',
        timestamp: 1000,
        tools: [{ name: 'browser_snapshot', output: payload }],
      },
      {
        role: 'assistant',
        timestamp: 2000,
        tools: [{ name: 'browser_snapshot', output: payload }],
      },
    ]
    const shots = collectBrowserScreenshotsFromRows(rows)
    expect(shots).toHaveLength(1)
    expect(shots[0].pageUrl).toBe('https://example.com')
    expect(shots[0].toolName).toBe('browser_snapshot')
  })

  it('preserves browser_screenshot meta after output slimming', () => {
    const payload = JSON.stringify({
      type: 'browser_screenshot',
      image_url: '/api/threads/t1/browser-snapshots/abc123',
      page_url: 'https://example.com',
    })
    const tool = { name: 'browser', output: payload, status: 'completed' }
    maybeSlimToolOutputForUi(tool)
    expect(tool.browser_screenshot?.src).toContain('/api/threads/t1/browser-snapshots/abc123')
    expect(tool.output).toBe(payload)
  })

  it('parses browser_live JSON for live stream panel', () => {
    const raw = JSON.stringify({
      type: 'browser_live',
      stream_ws: '/api/threads/t1/browser-stream',
      page_url: 'https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026',
      summary: 'Browser opened',
    })
    const live = parseBrowserLiveToolOutput(raw)
    expect(live?.streamWs).toBe('/api/threads/t1/browser-stream')
    expect(live?.pageUrl).toContain('fifa.com')
  })

  it('preserves browser_live meta after output slimming', () => {
    const payload = JSON.stringify({
      type: 'browser_live',
      stream_ws: '/api/threads/t1/browser-stream',
      page_url: 'https://example.com',
    })
    const tool = { name: 'browser', output: payload, status: 'completed' }
    maybeSlimToolOutputForUi(tool)
    expect(tool.browser_live?.streamWs).toBe('/api/threads/t1/browser-stream')
    expect(tool.output).toBe(payload)
  })

  it('collects browser open URL and activity without screenshot', () => {
    const rows = [
      {
        role: 'assistant',
        timestamp: 1000,
        tools: [
          {
            name: 'browser',
            status: 'completed',
            input: { action: 'open', url: 'https://example.com' },
            browser_page_url: 'https://example.com',
          },
        ],
      },
    ]
    const state = collectBrowserPanelState(rows)
    expect(state.activityCount).toBe(1)
    expect(state.pageUrl).toBe('https://example.com')
    expect(state.screenshots).toHaveLength(0)
  })
})

describe('browser-panel-agui', () => {
  it('opens panel on TOOL_CALL_START for browser', () => {
    expect(
      shouldOpenBrowserPanelForAgUiEvent(
        { type: 'TOOL_CALL_START', toolCallName: 'browser' },
        'browser',
      ),
    ).toBe(true)
  })

  it('extracts open url from browser args', () => {
    const patch = previewPatchFromBrowserAgUiTool({
      toolCallId: 'call_1',
      toolCallName: 'browser',
      argsText: '{"action":"open","url":"https://www.baidu.com"}',
    })
    expect(patch?.pageUrl).toBe('https://www.baidu.com')
    expect(isBrowserToolWireName('browser')).toBe(true)
  })

  it('adds stream path when thread id is known', () => {
    const patch = browserPanelPreviewWithThread(null, 'thread-abc')
    expect(patch?.liveStreamUrl).toContain('thread-abc')
  })
})
