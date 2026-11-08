import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// 该组件链会 import 到 api-client.js（subtask-stream-bind → collab-subtasks-from-api）。
// 不 mock 的话，真实模块会污染其它用 vi.mock('api-client') 的测试文件。
vi.mock('../src/lib/api-client.js', () => ({
  tasksAPI: {
    getTask: vi.fn(),
    listTasks: vi.fn(),
    listSubtasks: vi.fn(),
  },
}))

import { CollabExecutionPanel } from '../src/react/components/CollabExecutionPanel.js'

/**
 * 工作流侧栏：运行中的节点必须能看到「此刻在跑什么工具」和实时正文，
 * 并且顶栏要有运行中状态 + 节点计数（原来只有一个百分比）。
 */
describe('CollabExecutionPanel running state', () => {
  const baseProps = {
    isOpen: true,
    mainTaskId: 'main-1',
    chatThreadId: 'thread-1',
    onClose: () => {},
    onSubtaskTranscriptOpen: () => {},
  }

  it('shows running spinner, inline percentage, step counts and task id in the header', () => {
    const { container } = render(
      <CollabExecutionPanel
        {...baseProps}
        collabTask={{
          taskId: 'main-1',
          name: '整理竞品资料',
          status: 'in_progress',
          progress: 40,
        }}
        apiSubtasks={[
          { subtaskId: 'st-1', name: '第一步', status: 'completed' },
          { subtaskId: 'st-2', name: '第二步', status: 'in_progress' },
          { subtaskId: 'st-3', name: '第三步', status: 'pending' },
        ]}
      />,
    )

    // 顶栏运行中：转圈（不再有「运行中」文字）
    const runningChip = container.querySelector('.react-chat-collab-exec-panel-running-chip')
    expect(runningChip).toBeTruthy()
    expect(runningChip?.textContent || '').toBe('')
    expect(container.querySelector('.react-chat-collab-exec-panel-running-dot')).toBeTruthy()

    // 百分比在标题行内联，不再有独立的总体进度条
    const pct = container.querySelector('.react-chat-collab-exec-panel-progress-pct')
    expect(pct?.textContent).toBe('40%')
    expect(container.querySelector('.react-chat-collab-exec-panel-progress-row')).toBeNull()

    // 节点计数 + 任务名 + 任务 ID
    expect(screen.getByText('1/3')).toBeTruthy()
    expect(screen.getByText('整理竞品资料')).toBeTruthy()
    const taskId = container.querySelector('.react-chat-collab-exec-panel-task-id')
    expect(taskId?.textContent).toBe('main-1')

    // 任务 ID 在标题行内（同一行，不是另起一行）
    const titleRow = container.querySelector('.react-chat-collab-exec-panel-title-row')
    expect(titleRow?.contains(taskId)).toBe(true)
    expect(taskId?.tagName).toBe('SPAN')

    // 顶栏只有一行内容，没有日志开关按钮
    expect(container.querySelector('.react-chat-collab-exec-panel-log-toggle')).toBeNull()
  })

  it('renders the latest tool and live text for a running subtask', () => {
    const { container } = render(
      <CollabExecutionPanel
        {...baseProps}
        collabTask={{ taskId: 'main-1', name: '任务', status: 'in_progress', progress: 20 }}
        apiSubtasks={[{ subtaskId: 'st-1', name: '搜资料', status: 'in_progress' }]}
        subagentTasks={{
          'st-1': {
            taskId: 'st-1',
            phase: 'running',
            tools: [
              { name: 'web_search', status: 'done' },
              { name: 'read_file', status: 'running' },
            ],
            liveOutput: '正在读取竞品页面内容',
          },
        }}
      />,
    )

    // 只显示最新一条（正在跑的 read_file → 「读取」），不是 chips 列表
    const activity = container.querySelector('.collab-wf-node-activity')
    expect(activity).toBeTruthy()
    expect(activity?.textContent || '').toContain('读取')
    expect(container.querySelectorAll('.collab-wf-node-activity').length).toBe(1)
    expect(container.querySelector('.collab-wf-node-tool-chip')).toBeNull()

    // 节点上的运行徽标（齿轮位）
    expect(container.querySelector('.collab-wf-node-running-badge')).toBeTruthy()
  })

  it('falls back to API-persisted live text when there is no WS stream', () => {
    // 回归：刷新后 / 从别的工作流打开时，subagentTasks 为空。
    // 节点必须显示后端落库的实时正文，否则用户看到空白卡片。
    const { container } = render(
      <CollabExecutionPanel
        {...baseProps}
        collabTask={{ taskId: 'main-1', name: '任务', status: 'in_progress', progress: 20 }}
        apiSubtasks={[
          {
            subtaskId: 'st-1',
            name: '搜资料',
            status: 'in_progress',
            executionPreview: '正在读取竞品页面内容',
          },
        ]}
      />,
    )

    const activity = container.querySelector('.collab-wf-node-activity')
    expect(activity).toBeTruthy()
    expect(activity?.textContent || '').toContain('正在读取竞品页面内容')
  })

  it('falls back to API currentStep when there is no live preview', () => {
    const { container } = render(
      <CollabExecutionPanel
        {...baseProps}
        collabTask={{ taskId: 'main-1', name: '任务', status: 'in_progress', progress: 20 }}
        apiSubtasks={[
          {
            subtaskId: 'st-1',
            name: '搜资料',
            status: 'in_progress',
            currentStep: '正在整理竞品对比表',
          },
        ]}
      />,
    )

    expect(container.querySelector('.collab-wf-node-activity')?.textContent || '').toContain(
      '正在整理竞品对比表',
    )
  })

  it('shows the latest prose when no tool is running', () => {
    const { container } = render(
      <CollabExecutionPanel
        {...baseProps}
        collabTask={{ taskId: 'main-1', name: '任务', status: 'in_progress', progress: 20 }}
        apiSubtasks={[{ subtaskId: 'st-1', name: '搜资料', status: 'in_progress' }]}
        subagentTasks={{
          'st-1': {
            taskId: 'st-1',
            phase: 'running',
            tools: [{ name: 'web_search', status: 'done' }],
            liveOutput: '正在读取竞品页面内容',
          },
        }}
      />,
    )

    expect(container.textContent || '').toContain('正在读取竞品页面内容')
  })

  it('does not show a running badge when the task is done', () => {
    const { container } = render(
      <CollabExecutionPanel
        {...baseProps}
        collabTask={{ taskId: 'main-1', name: '任务', status: 'completed', progress: 100 }}
        apiSubtasks={[{ subtaskId: 'st-1', name: '第一步', status: 'completed' }]}
      />,
    )

    expect(container.querySelector('.collab-wf-node-running-badge')).toBeNull()
    expect(container.querySelector('.react-chat-collab-exec-panel-running-chip')).toBeNull()
  })
})
