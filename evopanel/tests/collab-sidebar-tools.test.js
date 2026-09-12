import { describe, expect, it } from 'vitest'
import {
  buildCollabSidebarFromTools,
  collectAssistantToolArraysFromRows,
  extractLastPlanToolSuccess,
  mergeAssistantToolsFromRows,
} from '../src/lib/collab-sidebar-from-tools.js'

describe('collab-sidebar-from-tools rows', () => {
  it('collects all assistant tool arrays in order', () => {
    const rows = [
      { role: 'user', text: 'go' },
      { role: 'assistant', tools: [{ name: 'plan', id: 'p1' }] },
      { role: 'assistant', text: 'done', tools: [] },
      { role: 'assistant', tools: [{ name: 'supervisor', id: 's1' }] },
    ]
    const arrays = collectAssistantToolArraysFromRows(rows)
    expect(arrays).toHaveLength(2)
    expect(arrays[0][0].name).toBe('plan')
    expect(arrays[1][0].name).toBe('supervisor')
  })

  it('mergeAssistantToolsFromRows flattens assistant tools', () => {
    const rows = [
      { role: 'assistant', tools: [{ name: 'plan', id: 'a' }] },
      { role: 'assistant', tools: [{ name: 'supervisor', id: 'b' }] },
    ]
    const merged = mergeAssistantToolsFromRows(rows)
    expect(merged).toHaveLength(2)
    expect(merged.map((t) => t.name)).toEqual(['plan', 'supervisor'])
  })

  it('extractLastPlanToolSuccess matches plan by input shape when name is generic 工具', () => {
    const hit = extractLastPlanToolSuccess([
      {
        name: '工具',
        id: 'p-generic',
        input: {
          goal: '测试目标',
          steps: [{ name: '步骤1', description: '做一件事' }],
        },
      },
    ])
    expect(hit?.planInput?.goal).toBe('测试目标')
    expect(hit?.boundPlanReady).toBe(false)
  })

  it('extractLastPlanToolSuccess reads task id from created parentTaskId', () => {
    const hit = extractLastPlanToolSuccess([
      {
        name: 'plan',
        id: 'p1',
        output: {
          success: true,
          boundPlanPersisted: true,
          created: [{ subtaskId: 'Subtask_1', parentTaskId: 'Task_from_created', name: 'Step 1' }],
        },
      },
    ])
    expect(hit?.boundPlanReady).toBe(true)
    expect(hit?.taskId).toBe('Task_from_created')
  })

  it('start_execution delegated ok without detached marks subtask executing not completed', () => {
    const built = buildCollabSidebarFromTools([
      {
        name: 'supervisor',
        id: 'se1',
        input: { action: 'start_execution', task_id: 'Task_main' },
        output: {
          success: true,
          action: 'start_execution',
          taskId: 'Task_main',
          delegatedSubtasks: [{ subtaskId: 'Subtask_a', ok: true, detached: false }],
          delegationAllSucceeded: true,
        },
      },
    ])
    expect(built.subtasks).toHaveLength(1)
    expect(built.subtasks[0].subtaskId).toBe('Subtask_a')
    expect(built.subtasks[0].status).toBe('executing')
    expect(built.main?.status).not.toBe('completed')
  })

  it('start_execution detached subtask stays executing', () => {
    const built = buildCollabSidebarFromTools([
      {
        name: 'supervisor',
        id: 'se2',
        input: { action: 'start_execution', task_id: 'Task_main' },
        output: {
          success: true,
          action: 'start_execution',
          taskId: 'Task_main',
          delegatedSubtasks: [{ subtaskId: 'Subtask_b', ok: true, detached: true }],
        },
      },
    ])
    expect(built.subtasks[0].status).toBe('executing')
  })
})
