import { describe, it, vi, beforeEach } from 'vitest'
import assert from 'node:assert/strict'

vi.mock('../src/lib/api-client.js', () => ({
  tasksAPI: {
    getTask: vi.fn(),
    listTasks: vi.fn(),
    listSubtasks: vi.fn(),
  },
}))

import { tasksAPI } from '../src/lib/api-client.js'
import { invalidatePlanApiCache } from '../src/lib/plan-from-api.js'
import {
  extractSubtaskRowsFromTaskResponse,
  fetchCollabSubtasksForMainTask,
  mapApiSubtaskRow,
} from '../src/lib/collab-subtasks-from-api.js'

function listTasksResponse(task) {
  return { success: true, data: { tasks: task ? [task] : [], total: task ? 1 : 0 } }
}

describe('collab-subtasks-from-api', () => {
  beforeEach(() => {
    vi.mocked(tasksAPI.getTask).mockReset()
    vi.mocked(tasksAPI.listTasks).mockReset()
    vi.mocked(tasksAPI.listSubtasks).mockReset()
    invalidatePlanApiCache()
  })

  it('extracts embedded subtasks from task row', () => {
    const rows = extractSubtaskRowsFromTaskResponse({
      id: 'Task_1',
      subtasks: [{ id: 'Subtask_a', name: 'A', status: 'pending' }],
    })
    assert.equal(rows.length, 1)
    const mapped = mapApiSubtaskRow(rows[0], 'Task_1')
    assert.equal(mapped?.subtaskId, 'Subtask_a')
    assert.equal(mapped?.parentTaskId, 'Task_1')
    assert.equal(mapped?.name, 'A')
  })

  it('fetchCollabSubtasksForMainTask uses listTasks when threadId given', async () => {
    vi.mocked(tasksAPI.listTasks).mockResolvedValue(
      listTasksResponse({
        id: 'Task_1',
        thread_id: 'thread-1',
        subtasks: [{ id: 'Sub_a', name: 'A' }],
      }),
    )
    const rows = await fetchCollabSubtasksForMainTask('Task_1', {
      threadId: 'thread-1',
      bypassCache: true,
    })
    assert.equal(rows.length, 1)
    assert.equal(vi.mocked(tasksAPI.listTasks).mock.calls.length, 1)
    assert.equal(vi.mocked(tasksAPI.getTask).mock.calls.length, 0)
    assert.equal(vi.mocked(tasksAPI.listSubtasks).mock.calls.length, 0)
  })

  it('fetchCollabSubtasksForMainTask ignores sessionKey as threadId', async () => {
    vi.mocked(tasksAPI.listTasks).mockResolvedValue(listTasksResponse(null))
    vi.mocked(tasksAPI.getTask).mockResolvedValue({
      id: 'Task_1',
      subtasks: [{ id: 'Sub_a', name: 'A' }],
    })
    const rows = await fetchCollabSubtasksForMainTask('Task_1', {
      threadId: 'agent:main:new-abc',
      preferTaskId: 'Task_1',
    })
    assert.equal(rows.length, 1)
    assert.equal(vi.mocked(tasksAPI.listTasks).mock.calls.length, 0)
    assert.equal(vi.mocked(tasksAPI.getTask).mock.calls.length, 1)
  })

  it('preferPersistedCollabSubtasks drops plan placeholders when Subtask_ rows exist', async () => {
    const { preferPersistedCollabSubtasks } = await import('../src/lib/collab-subtasks-from-api.js')
    const out = preferPersistedCollabSubtasks([
      { subtaskId: '__plan__:Task_1:任务1', name: '任务1' },
      { subtaskId: 'Subtask_a', name: 'Step 1: 任务1' },
      { subtaskId: '__plan__:Task_1:任务2', name: '任务2' },
      { subtaskId: 'Subtask_b', name: 'Step 2: 任务2' },
    ])
    assert.equal(out.length, 2)
    assert.equal(out[0].subtaskId, 'Subtask_a')
    assert.equal(out[1].subtaskId, 'Subtask_b')
  })

  it('fetchCollabSubtasksForMainTask shares row cache with plan path', async () => {
    vi.mocked(tasksAPI.listTasks).mockResolvedValue(
      listTasksResponse({
        id: 'Task_dedupe',
        thread_id: 'thread-d',
        subtasks: [],
      }),
    )
    const [a, b] = await Promise.all([
      fetchCollabSubtasksForMainTask('Task_dedupe', { threadId: 'thread-d' }),
      fetchCollabSubtasksForMainTask('Task_dedupe', { threadId: 'thread-d' }),
    ])
    assert.deepEqual(a, b)
    assert.equal(vi.mocked(tasksAPI.listTasks).mock.calls.length, 1)
  })
})
