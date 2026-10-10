// v5.8 流式对比双日志：sse-recv.log + ui-display.log，按 sessionKey/runId 隔离
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  isStreamCompareFileLogOn,
  markStreamCompareSession,
  markStreamCompareRun,
  logStreamCompareSseRecv,
  logStreamCompareUiDisplay,
  logStreamCompareUiChunks,
  logStreamCompareUiStreamTools,
  logStreamCompareAgUiDrain,
  logStreamCompareAgUiInternals,
  logStreamCompareDomView,
  dumpStreamCompareBuffers,
  sanitizeSessionLogId,
  sanitizeRunLogId,
} from '../src/react/lib/stream-compare-file-log.ts'
import { buildAssistantBubbleDisplayPlan } from '../src/react/lib/message-row-display-plan.ts'
import { buildAssistantDomView } from '../src/react/lib/assistant-dom-view.ts'
import { emptyAgUiTurnState, applyAgUiEvent } from '../src/react/lib/agui-turn-reducer.ts'
import type { DisplayRow } from '../src/react/chat-types.ts'

function setLsDefaultOn() {
  try {
    localStorage.removeItem('EVOFLOW_STREAM_COMPARE_LOG')
  } catch {
    /* jsdom */
  }
}

function setLs(on: boolean) {
  try {
    if (on) localStorage.removeItem('EVOFLOW_STREAM_COMPARE_LOG') // 默认 ON
    else localStorage.setItem('EVOFLOW_STREAM_COMPARE_LOG', '0')
  } catch {
    /* jsdom */
  }
}

beforeEach(() => {
  setLsDefaultOn()
  // 清理内存缓冲
  const w = window as Window & { __evoflowStreamCompare?: { sessions?: Record<string, unknown>; activeSessionLogId?: string } }
  if (w.__evoflowStreamCompare) delete w.__evoflowStreamCompare
  // 暴露到测试用：清模块级 run/turn 缓存（每个测试用例都重新跑 markStreamCompareRun）
  ;(window as any).__evoflowStreamCompareResetForTest?.()
})

afterEach(() => {
  setLsDefaultOn()
})

describe('v5.8 双日志：sse-recv + ui-display，按 sessionKey/runId 隔离', () => {
  it('sanitize：sessionKey / runId 含特殊字符会被规整为子目录安全名', () => {
    expect(sanitizeSessionLogId('lc_run:01a1209a/abc')).toBe('lc_run_01a1209a_abc')
    expect(sanitizeSessionLogId('a:b/c d')).toBe('a_b_c_d')
    expect(sanitizeRunLogId('run:01a1209a-54a7')).toBe('run_01a1209a-54a7')
  })

  it('v5.8 默认开启：未设 localStorage 即落盘；显式 0 才 no-op', () => {
    // v5.8 起默认 ON（不再需要手动 setItem 1）
    expect(isStreamCompareFileLogOn()).toBe(true)
    markStreamCompareSession('lc_run:abc')
    markStreamCompareRun('lc_run:abc', 'run-1')
    logStreamCompareSseRecv({
      sessionKey: 'lc_run:abc',
      runId: 'run-1',
      data: { type: 'TEXT_MESSAGE_CONTENT', delta: 'hi' },
    })
    const on = dumpStreamCompareBuffers('lc_run:abc', 'run-1')
    expect(on.sseRecv.length).toBeGreaterThanOrEqual(1)
    // 显式 setItem '0' 关闭
    setLs(false)
    expect(isStreamCompareFileLogOn()).toBe(false)
    markStreamCompareSession('lc_run:off')
    markStreamCompareRun('lc_run:off', 'run-off')
    logStreamCompareSseRecv({
      sessionKey: 'lc_run:off',
      runId: 'run-off',
      data: { type: 'TEXT_MESSAGE_CONTENT', delta: 'should-drop' },
    })
    const off = dumpStreamCompareBuffers('lc_run:off', 'run-off')
    expect(off.sseRecv.length).toBe(0)
    expect(off.uiDisplay.length).toBe(0)
  })

  it('开启后：SSE 每帧落 sse-recv，UI 渲染落 ui-display，2 文件物理隔离', () => {
    setLs(true)
    expect(isStreamCompareFileLogOn()).toBe(true)
    markStreamCompareSession('lc_run:abc')
    markStreamCompareRun('lc_run:abc', 'run-1')

    // 1. 模拟 3 条 AG-UI wire 事件
    logStreamCompareSseRecv({
      sessionKey: 'lc_run:abc',
      runId: 'run-1',
      data: { type: 'RUN_STARTED', runId: 'run-1', threadId: 't1' },
    })
    logStreamCompareSseRecv({
      sessionKey: 'lc_run:abc',
      runId: 'run-1',
      data: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '你好' },
    })
    logStreamCompareSseRecv({
      sessionKey: 'lc_run:abc',
      runId: 'run-1',
      data: { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
    })

    // 2. 模拟 1 次 UI 渲染（stream row）
    const row: DisplayRow = {
      role: '_stream',
      runId: 'run-1',
      text: '你好',
      segments: [
        { kind: 'tools', ids: ['call_1'], seq: 1 },
        { kind: 'text', text: '你好', seq: 2 },
      ],
      tools: [{ id: 'call_1', name: 'write', status: 'ok' }],
    }
    const planInput: any = {
      row,
      displaySegments: row.segments || [],
      tools: row.tools || [],
      rawText: row.text || '',
      text: row.text || '',
      textTrimmed: true,
      reasoningPreview: '',
      reasoningSegments: [],
      isStreaming: true,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: true,
      systemActivityLabel: '',
      streamThinkingLabel: '',
      legacyHasTools: false,
      legacyShowBody: true,
      plainBodyRaw: '',
      plainShowThinkingCursor: false,
    }
    const plan = buildAssistantBubbleDisplayPlan(planInput)
    logStreamCompareUiDisplay({ row, plan, sessionKey: 'lc_run:abc', forceWrite: true })
    logStreamCompareUiChunks({ row, plan, sessionKey: 'lc_run:abc', forceWrite: true })
    logStreamCompareUiStreamTools({ row, tools: row.tools || [], sessionKey: 'lc_run:abc', isStreaming: true, forceWrite: true })

    // 立刻 flush 48ms 防抖
    ;(window as any).__evoflowStreamCompareFlush?.()

    const out = dumpStreamCompareBuffers('lc_run:abc', 'run-1')
    // SSE 全部入 sse-recv
    expect(out.sseRecv.length).toBeGreaterThanOrEqual(3)
    // 含 RUN_STARTED
    expect(out.sseRecv.some((l) => l.includes('RUN_STARTED'))).toBe(true)
    expect(out.sseRecv.some((l) => l.includes('TEXT_MESSAGE_CONTENT'))).toBe(true)
    expect(out.sseRecv.some((l) => l.includes('TEXT_MESSAGE_END'))).toBe(true)
    // UI 渲染走 ui-display
    expect(out.uiDisplay.length).toBeGreaterThan(0)
    const allUi = out.uiDisplay.join('\n')
    expect(allUi).toContain('TURN')
    expect(allUi).toContain('session=')
    expect(allUi).toContain('run=')
  })

  it('session 隔离：两个 session 完全独立文件', () => {
    setLs(true)
    markStreamCompareSession('lc_run:sessionA')
    markStreamCompareRun('lc_run:sessionA', 'run-A')
    logStreamCompareSseRecv({
      sessionKey: 'lc_run:sessionA',
      runId: 'run-A',
      data: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'mA', delta: 'A 流' },
    })

    markStreamCompareSession('lc_run:sessionB')
    markStreamCompareRun('lc_run:sessionB', 'run-B')
    logStreamCompareSseRecv({
      sessionKey: 'lc_run:sessionB',
      runId: 'run-B',
      data: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'mB', delta: 'B 流' },
    })

    const outA = dumpStreamCompareBuffers('lc_run:sessionA', 'run-A')
    const outB = dumpStreamCompareBuffers('lc_run:sessionB', 'run-B')
    // A 只含 A 流
    expect(outA.sseRecv.every((l) => !l.includes('B 流'))).toBe(true)
    expect(outA.sseRecv.some((l) => l.includes('A 流'))).toBe(true)
    // B 只含 B 流
    expect(outB.sseRecv.every((l) => !l.includes('A 流'))).toBe(true)
    expect(outB.sseRecv.some((l) => l.includes('B 流'))).toBe(true)
  })

  it('run 隔离：同 session 不同 run 互不污染', () => {
    setLs(true)
    markStreamCompareSession('lc_run:sessionC')
    markStreamCompareRun('lc_run:sessionC', 'run-1')
    logStreamCompareSseRecv({
      sessionKey: 'lc_run:sessionC',
      runId: 'run-1',
      data: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'run1 流' },
    })
    markStreamCompareRun('lc_run:sessionC', 'run-2')
    logStreamCompareSseRecv({
      sessionKey: 'lc_run:sessionC',
      runId: 'run-2',
      data: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm2', delta: 'run2 流' },
    })

    const out1 = dumpStreamCompareBuffers('lc_run:sessionC', 'run-1')
    const out2 = dumpStreamCompareBuffers('lc_run:sessionC', 'run-2')
    expect(out1.sseRecv.some((l) => l.includes('run1 流'))).toBe(true)
    expect(out1.sseRecv.every((l) => !l.includes('run2 流'))).toBe(true)
    expect(out2.sseRecv.some((l) => l.includes('run2 流'))).toBe(true)
    expect(out2.sseRecv.every((l) => !l.includes('run1 流'))).toBe(true)
    // 不同 run 互不污染
  })

  it('drain / internals 也走 ui-display（多轮工具封存时序可追）', async () => {
    setLs(true)
    markStreamCompareSession('lc_run:drainTest')
    markStreamCompareRun('lc_run:drainTest', 'run-D')

    const agui = emptyAgUiTurnState('run-D', 't1')
    // 注入 2 个 tool
    let s = agui
    for (const id of ['t1', 't2']) {
      s = applyAgUiEvent(s, { type: 'TOOL_CALL_START', toolCallId: id, toolCallName: 'terminal' } as any)
      s = applyAgUiEvent(s, { type: 'TOOL_CALL_ARGS', toolCallId: id, delta: '{}' } as any)
      s = applyAgUiEvent(s, { type: 'TOOL_CALL_END', toolCallId: id } as any)
      s = applyAgUiEvent(s, {
        type: 'TOOL_CALL_RESULT',
        toolCallId: id,
        content: 'ok',
        messageId: `${id}-r`,
      } as any)
    }
    // drain → sealed
    const { finalizeGhostRunningToolsBeforeNewRound, drainAgUiCompletedRound } = await import(
      '../src/react/lib/agui-turn-reducer.ts'
    )
    finalizeGhostRunningToolsBeforeNewRound(s)
    const { sealed } = drainAgUiCompletedRound(s)
    logStreamCompareAgUiDrain({
      sessionKey: 'lc_run:drainTest',
      runId: 'run-D',
      sealed,
      releasedToolIds: ['t1', 't2'],
    })
    logStreamCompareAgUiInternals({
      sessionKey: 'lc_run:drainTest',
      runId: 'run-D',
      aguiTurn: s,
      label: 'after-drain',
      forceWrite: true,
    })
    ;(window as any).__evoflowStreamCompareFlush?.()
    const out = dumpStreamCompareBuffers('lc_run:drainTest', 'run-D')
    const all = out.uiDisplay.join('\n')
    // 落 ui-display 的 internal-mirror 段（v5.9 起 agui-drain / after-drain 都标 internal-mirror）
    expect(all).toContain('internal-mirror agui-drain')
    expect(all).toContain('internal-mirror after-drain')
  })
})

describe('v5.9 DOM 视角 1:1 快照：buildAssistantDomView + logStreamCompareDomView', () => {
  it('已工作（折叠）助手行：head + 4 个 tools latest + final-reply 正文', () => {
    const tools = [
      {
        tool_call_id: 'call_00_n4ksbdh5g5eb3g61zo98kue6',
        name: 'write',
        status: 'completed',
        args: { path: 'simple.md' },
        stat: { additions: 4, deletions: 0 },
        _uiStartedAtMs: Date.parse('2026-10-09T13:26:00+08:00'),
        _uiEndedAtMs: Date.parse('2026-10-09T13:26:00.4+08:00'),
        time: '2026-10-09T13:26:00+08:00',
      },
      {
        tool_call_id: 'call_00_dmivu9m5thdrfrnfbos7l8kq',
        name: 'read',
        status: 'completed',
        args: { path: 'outputs/_smoke/simple.md' },
        _uiStartedAtMs: Date.parse('2026-10-09T13:26:01+08:00'),
        _uiEndedAtMs: Date.parse('2026-10-09T13:26:01.2+08:00'),
        time: '2026-10-09T13:26:01+08:00',
      },
      {
        tool_call_id: 'call_00_4tsunsejozjtyzbb17plp0yc',
        name: 'replace',
        status: 'completed',
        args: { path: 'simple.md' },
        stat: { additions: 1, deletions: 1 },
        _uiStartedAtMs: Date.parse('2026-10-09T13:27:00+08:00'),
        _uiEndedAtMs: Date.parse('2026-10-09T13:27:00.3+08:00'),
        time: '2026-10-09T13:27:00+08:00',
      },
      {
        tool_call_id: 'call_00_t35lipd9j0m2zallsbjy5toa',
        name: 'delete',
        status: 'completed',
        args: { path: 'simple.md' },
        _uiStartedAtMs: Date.parse('2026-10-09T13:27:05+08:00'),
        _uiEndedAtMs: Date.parse('2026-10-09T13:27:05.1+08:00'),
        time: '2026-10-09T13:27:05+08:00',
      },
    ]
    const row: DisplayRow = {
      role: 'assistant',
      runId: 'run-dom-1',
      text: '简单冒烟完成',
      tools: tools as unknown as DisplayRow['tools'],
      segments: [
        { kind: 'tools', ids: [tools[0].tool_call_id, tools[1].tool_call_id, tools[2].tool_call_id, tools[3].tool_call_id], seq: 1 },
      ],
    } as DisplayRow
    const plan = buildAssistantBubbleDisplayPlan({
      row,
      displaySegments: row.segments || [],
      tools: row.tools || [],
      rawText: row.text || '',
      text: row.text || '',
      textTrimmed: true,
      reasoningPreview: '',
      reasoningSegments: [],
      isStreaming: false,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: true,
      systemActivityLabel: '',
      streamThinkingLabel: '',
      legacyHasTools: false,
      legacyShowBody: true,
      plainBodyRaw: '',
      plainShowThinkingCursor: false,
    } as any)
    // 把 plan.layout.displayChunks + plan.slots 强制设成「用户给的 DOM 样本」对应的 2 段
    ;(plan as any).layout = {
      ...(plan as any).layout,
      displayChunks: [
        {
          kind: 'activity',
          startIndex: 0,
          pieces: tools.map((t) => ({ kind: 'tools', ids: [t.tool_call_id], segIndex: 0 })),
        },
        {
          kind: 'text',
          text: '简单冒烟完成，依次调 4 个工具：\n\n| 序 | 工具 | 结果 |\n| 1 | write | ✅ |\n\n全部正常，临时文件已清理。',
          segIndex: 1,
        },
      ],
      finalReplyChunkIndex: 1,
    }
    ;(plan as any).slots = [
      { kind: 'chunk', chunk: (plan as any).layout.displayChunks[0], chunkIndex: 0 },
      { kind: 'chunk', chunk: (plan as any).layout.displayChunks[1], chunkIndex: 1 },
    ]
    // 重算 slots：让 chunks 顺序与 displayChunks 一致
    const view = buildAssistantDomView({
      row,
      plan,
      isStreaming: false,
      workedLabel: '32 秒',
    })
    expect(view.foldOpen).toBe(false)
    expect(view.gear).toBe('off')
    expect(view.head).toBe('32 秒')
    // 2 段 chunk
    expect(view.chunks.length).toBeGreaterThanOrEqual(2)
    // 第 1 段 flat-activity 含 4 个 tool piece（每个 piece=1 tool，与 DOM 4 个独立 <div class="msg-tool-activity-piece"> 1:1）
    const flatChunk = view.chunks.find((c) => c.kind === 'flat-activity') as any
    expect(flatChunk).toBeTruthy()
    expect(flatChunk.pieces.length).toBe(4)
    // 4 个 tool piece 全部 role=latest
    for (const p of flatChunk.pieces) {
      expect(p.kind).toBe('tools')
      expect(p.role).toBe('latest')
    }
    expect(flatChunk.pieces.map((p: any) => p.tools[0].name)).toEqual(['write', 'read', 'replace', 'delete'])
    expect(flatChunk.pieces[0].tools[0].file).toBe('simple.md')
    expect(flatChunk.pieces[0].tools[0].diff).toBe('+4 −0')
    // 第 2 段是 msg-text final-reply
    const textChunk = view.chunks.find((c) => c.kind === 'msg-text' && c.role === 'final-reply') as any
    expect(textChunk).toBeTruthy()
    expect(textChunk.text).toContain('简单冒烟完成')
    expect(textChunk.markdown.tables).toBeGreaterThanOrEqual(1)
    expect(textChunk.markdown.paragraphs).toBeGreaterThanOrEqual(2)

    // 落盘：logStreamCompareDomView 写到 ui-display [turn=N | session | run] header + [dom-view] body
    markStreamCompareSession('lc_run:domView1')
    markStreamCompareRun('lc_run:domView1', 'run-dom-1')
    logStreamCompareDomView({
      sessionKey: 'lc_run:domView1',
      runId: 'run-dom-1',
      foldOpen: view.foldOpen,
      head: view.head,
      gear: view.gear,
      chunks: view.chunks,
      fileChanges: view.fileChanges,
    })
    ;(window as any).__evoflowStreamCompareFlush?.()
    const out = dumpStreamCompareBuffers('lc_run:domView1', 'run-dom-1')
    const all = out.uiDisplay.join('\n')
    // 头部「fold=closed / gear=off / head」
    expect(all).toMatch(/\[fold=closed\]/)
    expect(all).toMatch(/\[gear=off\]/)
    expect(all).toMatch(/head: 32 秒/)
    // 4 个 tool name 都打印
    expect(all).toContain('write(completed)')
    expect(all).toContain('read(completed)')
    expect(all).toContain('replace(completed)')
    expect(all).toContain('delete(completed)')
    // tool piece role=latest
    expect(all).toMatch(/piece#\d+ tools\s+role=latest/)
    // 正文 chunk
    expect(all).toMatch(/chunk#\d+ msg-text role=final-reply/)
    expect(all).toContain('简单冒烟完成')
  })

  it('工作中（展开）流式行：spinner 在最末、head 工作中 X', () => {
    const row: DisplayRow = {
      role: '_stream',
      runId: 'run-dom-2',
      text: '',
      tools: [] as unknown as DisplayRow['tools'],
      segments: [],
    } as DisplayRow
    const plan = buildAssistantBubbleDisplayPlan({
      row,
      displaySegments: [],
      tools: [],
      rawText: '',
      text: '',
      textTrimmed: true,
      reasoningPreview: '',
      reasoningSegments: [],
      isStreaming: true,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: false,
      systemActivityLabel: '',
      streamThinkingLabel: '',
      legacyHasTools: false,
      legacyShowBody: true,
      plainBodyRaw: '',
    } as any)
    const view = buildAssistantDomView({
      row,
      plan,
      isStreaming: true,
      threadBusy: true,
      workedLabel: '12 秒',
    })
    expect(view.foldOpen).toBe(true)
    expect(view.gear).toBe('spinner')
    expect(view.head).toBe('12 秒')
    // spinner 段一定在
    expect(view.chunks.some((c) => c.kind === 'spinner')).toBe(true)
  })

  it('多次工具轮：所有 pieces 都是 latest（432d4840 起全量 latest，无 history role）', () => {
    const t1 = { tool_call_id: 'c1', name: 'write', status: 'completed' }
    const t2 = { tool_call_id: 'c2', name: 'read', status: 'completed' }
    const row: DisplayRow = {
      role: 'assistant',
      runId: 'run-dom-3',
      text: '最新正文',
      tools: [t1, t2] as unknown as DisplayRow['tools'],
      segments: [
        { kind: 'tools', ids: ['c1'], seq: 1 },
        { kind: 'text', text: '旧的思考1', seq: 2 },
        { kind: 'tools', ids: ['c2'], seq: 3 },
        { kind: 'text', text: '旧的思考2', seq: 4 },
        { kind: 'text', text: '最新正文', seq: 5 },
      ],
    } as DisplayRow
    const plan = buildAssistantBubbleDisplayPlan({
      row,
      displaySegments: row.segments || [],
      tools: row.tools || [],
      rawText: row.text || '',
      text: row.text || '',
      textTrimmed: true,
      reasoningPreview: '',
      reasoningSegments: [],
      isStreaming: false,
      interactiveToolApproval: false,
      suppressPlanExecPromptNoise: false,
      hasToolsInTurnEarly: true,
      systemActivityLabel: '',
      streamThinkingLabel: '',
      legacyHasTools: false,
      legacyShowBody: true,
      plainBodyRaw: '',
    } as any)
    ;(plan as any).layout = {
      ...(plan as any).layout,
      displayChunks: [
        {
          kind: 'activity',
          startIndex: 0,
          pieces: [
            { kind: 'tools', ids: ['c1'], segIndex: 0 },
            { kind: 'text', text: '旧的思考1', segIndex: 1 },
            { kind: 'tools', ids: ['c2'], segIndex: 2 },
            { kind: 'text', text: '旧的思考2', segIndex: 3 },
            { kind: 'text', text: '最新正文', segIndex: 4 },
          ],
        },
      ],
    }
    ;(plan as any).slots = [
      { kind: 'chunk', chunk: (plan as any).layout.displayChunks[0], chunkIndex: 0 },
    ]
    const view = buildAssistantDomView({
      row,
      plan,
      isStreaming: false,
      workedLabel: '5 秒',
    })
    const flat = view.chunks.find((c) => c.kind === 'flat-activity') as any
    expect(flat.pieces.length).toBe(5)
    // v5.10（432d4840）：piece role 全量 latest —— tools 与 text 都不再标 history
    expect(flat.pieces[0]).toMatchObject({ kind: 'tools', role: 'latest' })
    expect(flat.pieces[1]).toMatchObject({ kind: 'text', role: 'latest', text: '旧的思考1' })
    expect(flat.pieces[2]).toMatchObject({ kind: 'tools', role: 'latest' })
    expect(flat.pieces[3]).toMatchObject({ kind: 'text', role: 'latest', text: '旧的思考2' })
    expect(flat.pieces[4]).toMatchObject({ kind: 'text', role: 'latest', text: '最新正文' })
  })

  it('同 section 多次 logStreamCompareDomView 不重复写入：最后一次胜出', () => {
    markStreamCompareSession('lc_run:domDedup')
    markStreamCompareRun('lc_run:domDedup', 'run-dedup')
    // 同一 turn=1 header、同 section 名，连发 3 次 dom-view
    logStreamCompareDomView({
      sessionKey: 'lc_run:domDedup',
      runId: 'run-dedup',
      foldOpen: false,
      head: '已工作 5 秒',
      gear: 'off',
      chunks: [
        {
          kind: 'flat-activity',
          pieces: [{ kind: 'tools', role: 'latest', tools: [{ name: 'write', status: 'completed', id: 'a' }] }],
        },
      ],
    })
    logStreamCompareDomView({
      sessionKey: 'lc_run:domDedup',
      runId: 'run-dedup',
      foldOpen: false,
      head: '已工作 5 秒',
      gear: 'off',
      chunks: [
        {
          kind: 'flat-activity',
          pieces: [
            { kind: 'tools', role: 'latest', tools: [{ name: 'write', status: 'completed', id: 'a' }] },
            { kind: 'tools', role: 'latest', tools: [{ name: 'read', status: 'completed', id: 'b' }] },
          ],
        },
      ],
    })
    logStreamCompareDomView({
      sessionKey: 'lc_run:domDedup',
      runId: 'run-dedup',
      foldOpen: false,
      head: '已工作 5 秒',
      gear: 'off',
      chunks: [
        {
          kind: 'flat-activity',
          pieces: [
            { kind: 'tools', role: 'latest', tools: [{ name: 'write', status: 'completed', id: 'a' }] },
            { kind: 'tools', role: 'latest', tools: [{ name: 'read', status: 'completed', id: 'b' }] },
            { kind: 'tools', role: 'latest', tools: [{ name: 'delete', status: 'completed', id: 'c' }] },
          ],
        },
      ],
    })
    ;(window as any).__evoflowStreamCompareFlush?.()
    const out = dumpStreamCompareBuffers('lc_run:domDedup', 'run-dedup')
    const all = out.uiDisplay.join('\n')
    // 同 section 应只出现 1 次（最后一次胜出，3 个 tools）
    const domViewMatches = all.match(/turn=\d+ \| session=lc_run_domDedup \| run=run-dedup/g) || []
    expect(domViewMatches.length).toBe(1)
    expect(all).toContain('delete(completed)')
    // 不应重复出现多余的"已工作"块
    const foldMatches = all.match(/\[fold=closed\]/g) || []
    expect(foldMatches.length).toBe(1)
  })
})
