import { describe, expect, it, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
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

describe('TurnHistoryFold（已工作折叠头）', () => {
  it('流式期间显示「已工作」头部且内容展开', () => {
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
    expect(trigger, '流式期间应渲染已工作折叠头').toBeTruthy()
    expect(trigger?.getAttribute('data-history-open')).toBe('true')
    expect(trigger?.textContent).toContain('工作中 30 秒')
    // 展开态:工具行可见
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
  })

  it('历史行(水合数据 + MessageRow 兜底时长)显示已工作折叠头并默认收起', () => {
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
    expect(trigger, '历史行应渲染已工作折叠头').toBeTruthy()
    expect(trigger?.textContent).toContain('已工作 10 分')
    expect(trigger?.getAttribute('data-history-open')).toBe('false')
    expect(screen.queryByText(/echo hello/)).toBeNull()
  })

  it('封存行缺 durationStr/思考时间戳时,用工具时间兜底仍显示头部', () => {
    const now = Date.now()
    // 模拟 ChatApp 封存:durStr 为空、segments 无 startedAtMs、工具只带 time
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
    expect(trigger?.getAttribute('data-history-open')).toBe('false')
  })

  it('纯文本回合(无思考无工具)完成也显示已工作头部,文本保持可见', () => {
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
    // 文本始终在头部下方可见
    expect(screen.queryByText(/纯文本回复/)).toBeTruthy()
  })

  it('完成后折叠头定格并默认收起', () => {
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
    expect(trigger, '完成后应渲染已工作折叠头').toBeTruthy()
    expect(trigger?.textContent).toContain('已工作 9 分 28 秒')
    expect(trigger?.getAttribute('data-history-open')).toBe('false')
    // 收起态:工具行不可见
    expect(screen.queryByText(/ls/)).toBeNull()
  })
})
