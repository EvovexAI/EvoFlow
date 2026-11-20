import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { ToolCallList } from '../src/react/components/ToolCallList.tsx'

/**
 * 工具卡耗时「运行中必须走表」的接线测试。
 *
 * 【self-evolution-bot · 2026-11-20 · 第91轮 · 模型:deepseek-v4.1-flash-1017】
 * 为什么这条测试非写不可：我第一版只给 toolToChip 加了修复并让单测变绿，
 * 但 toolToChip 只被 compare-log 的旁路调用，**根本不是用户看到的渲染路径**。
 * 判据：必须 render 真实组件 + 真推进 1s 定时器 + 断言 DOM 文本变了。
 */

function baseTool(overrides = {}) {
  return {
    id: 'call_1',
    tool_call_id: 'call_1',
    tool_name: 'bash',
    name: 'bash',
    status: 'running',
    function: { name: 'bash', arguments: '{"command":"sleep 60"}' },
    input: { command: 'sleep 60' },
    time: Date.now() - 5_000,
    _uiStartedAtMs: Date.now() - 5_000,
    ...overrides,
  }
}

const baseProps = {
  subagentTasks: {},
  terminalStreams: {},
  showToolTiming: true,
  activityGrouped: false,
  interactiveToolApproval: false,
  toolApprovalBusy: false,
}

function elapsedNode(container) {
  return container.querySelector('.msg-tool-elapsed')
}

describe('ToolCallList：运行中工具卡的耗时必须每秒走表', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('有 status=running 时，推进 2 秒后耗时文本必须变大', () => {
    const { container } = render(
      <ToolCallList {...baseProps} tools={[baseTool()]} isStreaming />,
    )
    const first = elapsedNode(container)
    expect(first, '运行中的工具卡应当显示耗时').toBeTruthy()
    const text0 = first.textContent

    act(() => {
      vi.advanceTimersByTime(2000)
    })

    const second = elapsedNode(container)
    expect(second, '推进后仍应显示耗时').toBeTruthy()
    expect(second.textContent, `耗时必须走动：${text0} → ${second.textContent}`).not.toBe(text0)
  })

  it('没有 status（流式首帧常态）但有起点无终点时，耗时同样必须走表', () => {
    const tool = baseTool()
    delete (tool as Record<string, unknown>).status
    const { container } = render(
      <ToolCallList {...baseProps} tools={[tool]} isStreaming />,
    )
    const first = elapsedNode(container)
    expect(first, '无 status 但已开始的工具也必须显示耗时').toBeTruthy()
    const text0 = first.textContent

    act(() => {
      vi.advanceTimersByTime(2000)
    })

    const second = elapsedNode(container)
    expect(second, '推进后仍应显示耗时').toBeTruthy()
    expect(second.textContent, `无 status 时耗时也必须走动：${text0} → ${second.textContent}`).not.toBe(text0)
  })

  it('已结束的工具耗时冻结（不随定时器继续涨）—— 防回归', () => {
    const done = baseTool({
      status: 'ok',
      output: 'done',
      _uiEndedAtMs: Date.now() - 1_000,
    })
    const { container } = render(
      <ToolCallList {...baseProps} tools={[done]} isStreaming={false} />,
    )
    const first = elapsedNode(container)
    if (!first) return // 已结束行若不显示耗时，也不算回归
    const text0 = first.textContent
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    const second = elapsedNode(container)
    expect(second?.textContent, '已结束的耗时不能继续涨').toBe(text0)
  })
})
