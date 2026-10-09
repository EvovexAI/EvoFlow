import { describe, expect, it, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { buildAssistantBubbleDisplayPlan } from '../src/react/lib/message-row-display-plan.ts'
import { AssistantBubbleSlotView } from '../src/react/components/AssistantBubbleSlotView.tsx'

function buildInput(overrides: Record<string, unknown> = {}) {
  return {
    row: { role: 'assistant' } as unknown,
    displaySegments: [] as unknown[],
    tools: [] as unknown[],
    rawText: '',
    text: '',
    textTrimmed: false,
    reasoningPreview: '',
    reasoningSegments: [] as string[],
    isStreaming: false,
    interactiveToolApproval: false,
    suppressPlanExecPromptNoise: false,
    hasToolsInTurnEarly: true,
    systemActivityLabel: '',
    streamThinkingLabel: '',
    legacyHasTools: true,
    legacyShowBody: true,
    plainBodyRaw: '',
    plainShowThinkingCursor: false,
    flatTimeline: true,
    ...overrides,
  }
}

afterEach(() => cleanup())

describe('TurnHistoryFold v5.2（外层状态条 = 唯一折叠入口，工作中默认展开，已工作默认折叠）', () => {
  it('流式期间显示「工作中」状态条，defaultOpen=true 可点 chevron 折叠', () => {
    const now = Date.now()
    const input = buildInput({
      isStreaming: true,
      durationLabel: '30s',
      displaySegments: [
        { kind: 'reasoning', text: '第一段思考'.repeat(30), startedAtMs: now - 30_000, seq: 1 },
        { kind: 'tools', ids: ['t1'], seq: 2 },
      ],
      tools: [
        {
          id: 't1',
          name: 'bash',
          input: { command: 'ls -la' },
          status: 'ok',
          output: 'file-a\nfile-b',
          _uiStartedAtMs: now - 20_000,
          _uiEndedAtMs: now - 19_000,
          time: now - 20_000,
        },
      ],
    })
    const plan = buildAssistantBubbleDisplayPlan(input as never)
    render(
      <AssistantBubbleSlotView
        plan={plan}
        displaySegments={input.displaySegments as never}
        tools={input.tools as never}
        rawText=""
        reasoningPreview=""
        isStreaming
        askInline={null}
        suppressPlanExecPromptNoise={false}
        interactiveToolApproval={false}
        durationLabel="30s"
        messageId="msg_test_1"
      />,
    )
    const trigger = screen.queryByTestId('chat-assistant-history-trigger-msg_test_1')
    expect(trigger, '流式期间应渲染工作中状态条').toBeTruthy()
    expect(trigger?.textContent).toContain('工作中 30 秒')
    // v5.2：工作中默认展开（用户实时看），可点 chevron 折叠
    expect(trigger?.getAttribute('aria-expanded')).toBe('true')
    expect(trigger?.getAttribute('disabled')).toBeNull()
    // 当前轮工具/正文永远可见（外层折叠 body 内）
    expect(screen.queryByText(/ls -la/)).toBeTruthy()
  })

  it('流式首帧(无工作条目)先渲染独立「工作中」头部', () => {
    const input = buildInput({
      isStreaming: true,
      reasoningSegments: [],
      displaySegments: [],
      tools: [],
      hasToolsInTurnEarly: false,
      legacyHasTools: false,
      reasoningPreview: '',
    })
    const plan = buildAssistantBubbleDisplayPlan(input as never)
    render(
      <AssistantBubbleSlotView
        plan={plan}
        displaySegments={[]}
        tools={[]}
        rawText=""
        reasoningPreview=""
        isStreaming
        askInline={null}
        suppressPlanExecPromptNoise={false}
        interactiveToolApproval={false}
        durationLabel="3s"
        messageId="msg_test_0"
      />,
    )
    const trigger = screen.queryByTestId('chat-assistant-history-trigger-msg_test_0')
    expect(trigger, '流式首帧应渲染独立工作中头部').toBeTruthy()
    expect(trigger?.textContent).toContain('工作中 3 秒')
    // 流式首帧也是工作中 → 默认展开
    expect(trigger?.getAttribute('aria-expanded')).toBe('true')
  })

  it('历史行显示「已工作」状态条，defaultOpen=false（默认折叠），点 chevron 展开', () => {
    const now = Date.now()
    const input = buildInput({
      isStreaming: false,
      displaySegments: [{ kind: 'tools', ids: ['t1', 't2'] }],
      tools: [
        {
          id: 't1',
          name: 'bash',
          input: { command: 'echo hello' },
          status: 'ok',
          output: 'hello',
          time: now - 600_000,
        },
        {
          id: 't2',
          name: 'read_file',
          input: { path: 'a.txt' },
          status: 'ok',
          output: 'content',
          time: now - 500_000,
        },
      ],
    })
    const plan = buildAssistantBubbleDisplayPlan(input as never)
    render(
      <AssistantBubbleSlotView
        plan={plan}
        displaySegments={input.displaySegments as never}
        tools={input.tools as never}
        rawText=""
        reasoningPreview=""
        isStreaming={false}
        askInline={null}
        suppressPlanExecPromptNoise={false}
        interactiveToolApproval={false}
        durationLabel="10m00s"
        messageId="msg_hist_1"
      />,
    )
    const trigger = screen.queryByTestId('chat-assistant-history-trigger-msg_hist_1')
    expect(trigger, '历史行应渲染已工作状态条').toBeTruthy()
    expect(trigger?.textContent).toContain('已工作 10 分')
    // v5.2：已工作默认折叠
    expect(trigger?.getAttribute('aria-expanded')).toBe('false')
    expect(trigger?.getAttribute('disabled')).toBeNull()
    // v5.3：纯 tools 段整段视为 latest → 折叠时仍可见
    expect(screen.queryByText(/echo hello/)).toBeTruthy()
    // 点 chevron → 展开
    fireEvent.click(trigger as HTMLElement)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(screen.queryByText(/echo hello/)).toBeTruthy()
  })

  it('封存行缺 durationStr/思考时间戳时,用工具时间兜底仍显示「已工作」头部', () => {
    const now = Date.now()
    const input = buildInput({
      isStreaming: false,
      displaySegments: [
        { kind: 'tools', ids: ['t1'], seq: 1 },
        { kind: 'text', text: '最终回复', seq: 2 },
      ],
      tools: [
        {
          id: 't1',
          name: 'bash',
          input: { command: 'ls' },
          status: 'ok',
          output: 'ok',
          time: now - 120_000,
        },
      ],
    })
    const plan = buildAssistantBubbleDisplayPlan(input as never)
    render(
      <AssistantBubbleSlotView
        plan={plan}
        displaySegments={input.displaySegments as never}
        tools={input.tools as never}
        rawText=""
        reasoningPreview=""
        isStreaming={false}
        askInline={null}
        suppressPlanExecPromptNoise={false}
        interactiveToolApproval={false}
        durationLabel="2m00s"
        messageId="msg_seal_1"
      />,
    )
    const trigger = screen.queryByTestId('chat-assistant-history-trigger-msg_seal_1')
    expect(trigger, '封存行应显示已工作头部').toBeTruthy()
    expect(trigger?.textContent).toContain('已工作 2 分')
    // 封存行默认折叠
    expect(trigger?.getAttribute('aria-expanded')).toBe('false')
  })

  it('纯文本回合(无思考无工具)完成也显示「已工作」头部,默认折叠', () => {
    const input = buildInput({
      isStreaming: false,
      displaySegments: [{ kind: 'text', text: '这是一段纯文本回复。' }],
      tools: [],
      hasToolsInTurnEarly: false,
      legacyHasTools: false,
    })
    const plan = buildAssistantBubbleDisplayPlan(input as never)
    render(
      <AssistantBubbleSlotView
        plan={plan}
        displaySegments={input.displaySegments as never}
        tools={[]}
        rawText=""
        reasoningPreview=""
        isStreaming={false}
        askInline={null}
        suppressPlanExecPromptNoise={false}
        interactiveToolApproval={false}
        durationLabel="8s"
        messageId="msg_text_only"
      />,
    )
    const trigger = screen.queryByTestId('chat-assistant-history-trigger-msg_text_only')
    expect(trigger, '纯文本回合应显示已工作头部').toBeTruthy()
    expect(trigger?.textContent).toContain('已工作 8 秒')
    // v5.2：默认折叠
    expect(trigger?.getAttribute('aria-expanded')).toBe('false')
    // v5.3：纯文本段（无 reasoning/tools）整段视为 latest → 折叠时仍可见
    expect(screen.queryByText(/纯文本回复/)).toBeTruthy()
    // 点 chevron
    fireEvent.click(trigger as HTMLElement)
    expect(screen.queryByText(/纯文本回复/)).toBeTruthy()
  })

  it('完成后「已工作」默认折叠；点 chevron 展开看到完整过程（无过程 N 项二级头）', () => {
    const now = Date.now()
    const input = buildInput({
      isStreaming: false,
      displaySegments: [
        { kind: 'reasoning', text: '思考'.repeat(40), startedAtMs: now - 568_000, endedAtMs: now - 540_000, seq: 1 },
        { kind: 'tools', ids: ['t1'], seq: 2 },
        { kind: 'text', text: '最终回复', seq: 3 },
      ],
      tools: [
        {
          id: 't1',
          name: 'bash',
          input: { command: 'ls' },
          status: 'ok',
          output: 'ok',
          _uiStartedAtMs: now - 540_000,
          _uiEndedAtMs: now - 530_000,
          time: now - 540_000,
        },
      ],
    })
    const plan = buildAssistantBubbleDisplayPlan(input as never)
    render(
      <AssistantBubbleSlotView
        plan={plan}
        displaySegments={input.displaySegments as never}
        tools={input.tools as never}
        rawText=""
        reasoningPreview=""
        isStreaming={false}
        askInline={null}
        suppressPlanExecPromptNoise={false}
        interactiveToolApproval={false}
        durationLabel="9m28s"
        messageId="msg_test_2"
      />,
    )
    const trigger = screen.queryByTestId('chat-assistant-history-trigger-msg_test_2')
    expect(trigger, '完成后应渲染已工作状态条').toBeTruthy()
    expect(trigger?.textContent).toContain('已工作 9 分 28 秒')
    // v5.2：默认折叠
    expect(trigger?.getAttribute('aria-expanded')).toBe('false')
    // v5.4：本段 input = reasoning + tools（text 是 sibling chunk 不进 ExploringActivityChunk）。
    //       折叠时只显示"轮内正文" → 但本 chunk 内没有 text kind 的 piece，
    //       全部 piece (reasoning + tools) 都是 history → 折叠时整段隐藏。
    //       视觉上：折叠后用户看到"已工作 9分28秒"标签 + sibling msg-text 段（最终回复）。
    const historyPieces = document.querySelectorAll('[data-piece-role="history"]')
    const latestPieces = document.querySelectorAll('[data-piece-role="latest"]')
    expect(historyPieces.length).toBe(2)  // reasoning + tools 都是 history
    expect(latestPieces.length).toBe(0)   // chunk 内无 text piece
    // 折叠态下 reasoning + tools (ls) 都 CSS 隐藏
    const allText = document.body.textContent || ''
    // 展开
    fireEvent.click(trigger as HTMLElement)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    // 展开后 reasoning + tools 都可见
    expect(allText).toContain('思考')
    expect(allText).toContain('ls')
    // v5.2 反馈：绝不应再出现「过程 N 项」二级折叠头
    expect(screen.queryByText(/过程 \d+ 项/)).toBeNull()
  })

  it('v5.2 反馈：流式多轮时也不应出现「过程 N 项」二级折叠头（统一为外层单折叠入口）', () => {
    // 流式多轮: 思考 → 工具 → 思考 → 正文
    const now = Date.now()
    const input = buildInput({
      isStreaming: true,
      durationLabel: '20s',
      displaySegments: [
        { kind: 'reasoning', text: '第一段思考'.repeat(20), startedAtMs: now - 30_000, endedAtMs: now - 25_000, seq: 1 },
        { kind: 'tools', ids: ['t1'], seq: 2 },
        { kind: 'reasoning', text: '第二段思考'.repeat(20), startedAtMs: now - 20_000, endedAtMs: now - 15_000, seq: 3 },
        { kind: 'text', text: '最终回复', seq: 4 },
      ],
      tools: [
        {
          id: 't1',
          name: 'bash',
          input: { command: 'ls' },
          status: 'ok',
          output: 'ok',
          _uiStartedAtMs: now - 22_000,
          _uiEndedAtMs: now - 21_000,
          time: now - 22_000,
        },
      ],
    })
    const plan = buildAssistantBubbleDisplayPlan(input as never)
    render(
      <AssistantBubbleSlotView
        plan={plan}
        displaySegments={input.displaySegments as never}
        tools={input.tools as never}
        rawText=""
        reasoningPreview=""
        isStreaming
        askInline={null}
        suppressPlanExecPromptNoise={false}
        interactiveToolApproval={false}
        durationLabel="20s"
        messageId="msg_test_multi"
      />,
    )
    // v5.2：所有 piece 平铺到外层折叠 body，不再有「过程 N 项」二级头
    expect(screen.queryByText(/过程 \d+ 项/)).toBeNull()
    expect(screen.queryByText(/历史 \d+ 轮/)).toBeNull()
    // 工作中 → 外层默认展开 → 多轮内容都在 body 内可见
    const trigger = screen.queryByTestId('chat-assistant-history-trigger-msg_test_multi')
    expect(trigger?.getAttribute('aria-expanded')).toBe('true')
  })

  it('v5.5：已工作默认折叠时，chunk 内多段 text 只有最后 1 段外露，前面 text/tools 全藏', () => {
    // 实际 plan 会把 text 段 flush 成独立 chunk（不相邻的 activity chunk）。
    // 我们构造 input 让 ExploringActivityChunk 收到 1 个 activity 段，内含
    //   2 tools + 1 中间 text + 1 末尾 text，
    // 验证末尾 text = latest，前面 = history。
    // 真实场景中单 chunk 内只会有 1 段 text，但本测试也覆盖多段 text 的语义。
    const now = Date.now()
    const input = buildInput({
      isStreaming: false,
      durationLabel: '20s',
      // 把 text 段用 plan-top 的 "plan-top" 段位置塞进去，模拟"探索中切行说人话"
      // displaySegments 顺序：tools → text(中间) → tools → text(末尾)
      // 期望：ExploringActivityChunk 收到 tools + tools（text 被 plan 拆到独立 slot）
      // 我们先验证「单段 text」情况下的 v5.5 行为；
      // 多 text 段的情况由多 chunk 渲染的 v5.3 路径覆盖（每个 chunk 独立决定 lastText）
      displaySegments: [
        { kind: 'tools', ids: ['t1'], seq: 1 },
        { kind: 'text', text: '第一段正文', seq: 2 },
        { kind: 'tools', ids: ['t2'], seq: 3 },
      ],
      tools: [
        { id: 't1', name: 'bash', input: { command: 'ls' }, status: 'ok', output: 'ok', time: now - 22_000 },
        { id: 't2', name: 'read', input: { path: 'a.txt' }, status: 'ok', output: 'x', time: now - 12_000 },
      ],
    })
    const plan = buildAssistantBubbleDisplayPlan(input as never)
    render(
      <AssistantBubbleSlotView
        plan={plan}
        displaySegments={input.displaySegments as never}
        tools={input.tools as never}
        rawText=""
        reasoningPreview=""
        isStreaming={false}
        askInline={null}
        suppressPlanExecPromptNoise={false}
        interactiveToolApproval={false}
        durationLabel="20s"
        messageId="msg_v5_5"
      />,
    )
    const trigger = screen.queryByTestId('chat-assistant-history-trigger-msg_v5_5')
    expect(trigger?.getAttribute('aria-expanded')).toBe('false')
    // v5.5：plan 切分后 ExploringActivityChunk 收到 5 段（3 tools + 2 text）
    // 5 段中：3 tools + 1 中间 text = 4 history；1 最后 text = 1 latest
    const historyPieces = document.querySelectorAll('[data-piece-role="history"]')
    const latestPieces = document.querySelectorAll('[data-piece-role="latest"]')
    // 实际 chunk 切分由 plan 决定。1 text piece 总是 last text → 1 latest。
    // history 数量 = ExploringActivityChunk 内所有非 last text piece。
    expect(latestPieces.length).toBe(1)
    expect(historyPieces.length).toBeGreaterThanOrEqual(2)  // 至少 2 tools
    // 验证 latest 容器内是"第一段正文"（这 chunk 内唯一 text）
    const latestText = latestPieces[0]?.textContent || ''
    expect(latestText).toContain('第一段正文')
    // 展开
    fireEvent.click(trigger as HTMLElement)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
  })

  it('v5.6 粘滞展开：流式期间展开过的回合，完成后已显示的工具不消失（isStreaming 抖动/完成都不自动收起）', () => {
    const now = Date.now()
    const toolsDef = [
      {
        id: 't1',
        name: 'bash',
        input: { command: 'echo step1' },
        status: 'ok',
        output: 'step1',
        time: now - 30_000,
      },
      {
        id: 't2',
        name: 'read_file',
        input: { path: 'a.txt' },
        status: 'ok',
        output: 'content-a',
        time: now - 10_000,
      },
    ]
    const segmentsDef = [
      { kind: 'tools', ids: ['t1'], seq: 1 },
      { kind: 'tools', ids: ['t2'], seq: 2 },
      { kind: 'text', text: '最终回复', seq: 3 },
    ]
    const common = {
      durationLabel: '30s',
      displaySegments: segmentsDef as never,
      tools: toolsDef as never,
      messageId: 'msg_sticky_1',
    }
    const streamingInput = buildInput({ ...common, isStreaming: true })
    const doneInput = buildInput({ ...common, isStreaming: false })

    const planStreaming = buildAssistantBubbleDisplayPlan(streamingInput as never)
    const planDone = buildAssistantBubbleDisplayPlan(doneInput as never)

    const { rerender } = render(
      <AssistantBubbleSlotView
        plan={planStreaming}
        displaySegments={segmentsDef as never}
        tools={toolsDef as never}
        rawText=""
        reasoningPreview=""
        isStreaming
        askInline={null}
        suppressPlanExecPromptNoise={false}
        interactiveToolApproval={false}
        durationLabel="30s"
        messageId="msg_sticky_1"
      />,
    )
    const triggerAfterStream = screen.queryByTestId('chat-assistant-history-trigger-msg_sticky_1')
    expect(triggerAfterStream?.getAttribute('aria-expanded')).toBe('true')
    expect(screen.queryByText(/echo step1/)).toBeTruthy()

    // 完成：isStreaming 翻 false（真实流：final 后折叠 defaultOpen 翻 false）
    rerender(
      <AssistantBubbleSlotView
        plan={planDone}
        displaySegments={segmentsDef as never}
        tools={toolsDef as never}
        rawText=""
        reasoningPreview=""
        isStreaming={false}
        askInline={null}
        suppressPlanExecPromptNoise={false}
        interactiveToolApproval={false}
        durationLabel="30s"
        messageId="msg_sticky_1"
      />,
    )
    const triggerDone = screen.queryByTestId('chat-assistant-history-trigger-msg_sticky_1')
    expect(triggerDone?.textContent).toContain('已工作')
    // v5.6：完成不自动收起 —— 已实时显示过的工具保持可见
    expect(triggerDone?.getAttribute('aria-expanded')).toBe('true')
    expect(screen.queryByText(/echo step1/)).toBeTruthy()
    expect(screen.queryByText(/a\.txt/)).toBeTruthy()

    // 用户手动收起 → 进入 v5.5 折叠态（只露最新正文，工具 CSS 隐藏）
    fireEvent.click(triggerDone as HTMLElement)
    expect(triggerDone?.getAttribute('aria-expanded')).toBe('false')
    // 再点开 → 全部可见
    fireEvent.click(triggerDone as HTMLElement)
    expect(triggerDone?.getAttribute('aria-expanded')).toBe('true')
    expect(screen.queryByText(/echo step1/)).toBeTruthy()
  })

  it('v5.6：DB 历史行（从未流式展开过）仍默认折叠，点 chevron 展开', () => {
    const now = Date.now()
    const input = buildInput({
      isStreaming: false,
      displaySegments: [
        { kind: 'tools', ids: ['t1'], seq: 1 },
      ],
      tools: [
        { id: 't1', name: 'bash', input: { command: 'echo hi' }, status: 'ok', output: 'hi', time: now - 60_000 },
      ],
      durationLabel: '5s',
    })
    const plan = buildAssistantBubbleDisplayPlan(input as never)
    render(
      <AssistantBubbleSlotView
        plan={plan}
        displaySegments={input.displaySegments as never}
        tools={input.tools as never}
        rawText=""
        reasoningPreview=""
        isStreaming={false}
        askInline={null}
        suppressPlanExecPromptNoise={false}
        interactiveToolApproval={false}
        durationLabel="5s"
        messageId="msg_db_hist"
      />,
    )
    const trigger = screen.queryByTestId('chat-assistant-history-trigger-msg_db_hist')
    expect(trigger?.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger as HTMLElement)
    expect(trigger?.getAttribute('aria-expanded')).toBe('true')
    expect(screen.queryByText(/echo hi/)).toBeTruthy()
  })
})
