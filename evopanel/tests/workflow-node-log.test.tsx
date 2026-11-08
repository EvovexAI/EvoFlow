import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'

vi.mock('../src/lib/api-client.js', () => ({
  tasksAPI: {
    getTask: vi.fn(),
    listTasks: vi.fn(),
    listSubtasks: vi.fn(),
  },
}))

import { CollabExecutionPanel } from '../src/react/components/CollabExecutionPanel.js'
import {
  enableWorkflowNodeLog,
  disableWorkflowNodeLog,
  isWorkflowNodeLogEnabled,
} from '../src/lib/workflow-node-log.js'

const baseProps = {
  isOpen: true,
  mainTaskId: 'main-1',
  chatThreadId: 'thread-1',
  onClose: () => {},
  onSubtaskTranscriptOpen: () => {},
}

function wfNodeLogs(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map((c) => String(c[0] || ''))
    .filter((s) => s.startsWith('[wf-node]'))
}

describe('workflow node logging', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // localStorage 可能在别的用例里被打开过，先归零
    disableWorkflowNodeLog()
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
  })

  afterEach(() => {
    infoSpy.mockRestore()
    disableWorkflowNodeLog()
  })

  it('is disabled by default', () => {
    expect(isWorkflowNodeLogEnabled()).toBe(false)
  })

  it('logs exactly what the node displays, with task name and task id', () => {
    enableWorkflowNodeLog()
    expect(isWorkflowNodeLogEnabled()).toBe(true)

    render(
      <CollabExecutionPanel
        {...baseProps}
        collabTask={{ taskId: 'main-1', name: '整理竞品资料', status: 'in_progress', progress: 40 }}
        apiSubtasks={[
          {
            subtaskId: 'st-1',
            name: '搜竞品',
            status: 'in_progress',
            progress: 30,
            executionPreview: '正在读取竞品页面内容',
          },
        ]}
      />,
    )

    const calls = wfNodeLogs(infoSpy)
    expect(calls.length).toBeGreaterThan(0)

    const line = calls.find((s) => s.includes('subtaskId=st-1')) || ''
    // 任务名 + 任务 ID
    expect(line).toContain('任务="整理竞品资料"')
    expect(line).toContain('taskId=main-1')
    // 节点名 + 子任务 ID
    expect(line).toContain('节点="搜竞品"')
    expect(line).toContain('subtaskId=st-1')
    // 状态 + 进度
    expect(line).toContain('状态=')
    expect(line).toContain('进度=30%')
    // 节点上显示什么，日志上就显示什么
    expect(line).toContain('显示="正在读取竞品页面内容"')
  })

  it('does not log when disabled', () => {
    disableWorkflowNodeLog()
    render(
      <CollabExecutionPanel
        {...baseProps}
        collabTask={{ taskId: 'main-1', name: '任务', status: 'in_progress', progress: 20 }}
        apiSubtasks={[{ subtaskId: 'st-1', name: '搜资料', status: 'in_progress' }]}
      />,
    )
    expect(wfNodeLogs(infoSpy).length).toBe(0)
  })

  it('logs the tool name when a tool is running', () => {
    enableWorkflowNodeLog()
    render(
      <CollabExecutionPanel
        {...baseProps}
        collabTask={{ taskId: 'main-1', name: '任务', status: 'in_progress', progress: 20 }}
        apiSubtasks={[{ subtaskId: 'st-1', name: '搜资料', status: 'in_progress' }]}
        subagentTasks={{
          'st-1': {
            taskId: 'st-1',
            phase: 'running',
            tools: [{ name: 'read_file', status: 'running' }],
          },
        }}
      />,
    )
    const calls = wfNodeLogs(infoSpy)
    const line = calls.find((s) => s.includes('subtaskId=st-1')) || ''
    expect(line).toContain('显示="读取"')
    expect(line).toContain('[工具]')
  })
})

describe('workflow node layout', () => {
  it('has no bottom progress bar and shows percentage in the title row', () => {
    const { container } = render(
      <CollabExecutionPanel
        {...baseProps}
        collabTask={{ taskId: 'main-1', name: '任务', status: 'in_progress', progress: 20 }}
        apiSubtasks={[
          { subtaskId: 'st-1', name: '搜资料', status: 'in_progress', progress: 60 },
        ]}
      />,
    )

    // node bottom progress bar removed
    expect(container.querySelector('.collab-wf-node-progress-bar')).toBeNull()
    expect(container.querySelector('.collab-wf-node-status-row')).toBeNull()

    // percentage lives in the node title row
    const titleRow = container.querySelector('.collab-wf-node-title-row')
    const pct = titleRow?.querySelector('.collab-wf-node-progress-pct')
    expect(pct?.textContent).toBe('60%')
  })

  it('shows the running spinner inside the node title row', () => {
    const { container } = render(
      <CollabExecutionPanel
        {...baseProps}
        collabTask={{ taskId: 'main-1', name: '任务', status: 'in_progress', progress: 20 }}
        apiSubtasks={[{ subtaskId: 'st-1', name: '搜资料', status: 'in_progress' }]}
      />,
    )
    const titleRow = container.querySelector('.collab-wf-node-title-row')
    expect(titleRow?.querySelector('.collab-wf-node-running-badge')).toBeTruthy()
    expect(titleRow?.querySelector('.collab-wf-node-spinner')).toBeTruthy()
  })
})
