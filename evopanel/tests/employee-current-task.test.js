import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import {
  listSessionBoardTasks,
  pickBoardTask,
  resolveOverlayLiveTask,
} from '../src/react/lib/employee-current-task.ts'

describe('employee-current-task (multi-task session)', () => {
  const sk = 'proactive:ops-bot:chat:round-1'
  const tasks = [
    {
      task_id: 'A',
      name: '旧任务',
      status: 'executing',
      source_ref: sk,
      updated_at: '2026-08-28T10:00:00Z',
    },
    {
      task_id: 'B',
      name: '新建任务',
      status: 'pending',
      source_ref: sk,
      updated_at: '2026-08-28T11:00:00Z',
    },
    {
      task_id: 'C',
      name: '其它岗位任务',
      status: 'executing',
      updated_at: '2026-08-28T12:00:00Z',
    },
  ]

  it('defaults to newest active among pool (create becomes current)', () => {
    const sessionPool = tasks.filter((t) => t.source_ref === sk)
    const hit = pickBoardTask(sessionPool, 'A', '')
    assert.equal(hit?.task_id, 'B')
  })

  it('manual focus wins over newest active', () => {
    const hit = pickBoardTask(tasks, 'A', '', 'A')
    assert.equal(hit?.task_id, 'A')
  })

  it('lists session-scoped tasks via source_ref', () => {
    const { items, scoped } = listSessionBoardTasks(tasks, sk, ['A'])
    assert.equal(scoped, true)
    assert.deepEqual(
      items.map((t) => t.task_id),
      ['B', 'A'],
    )
  })

  it('falls back to open role tasks when no source_ref match', () => {
    const { items, scoped } = listSessionBoardTasks(tasks, 'proactive:other:chat:x', [])
    assert.equal(scoped, false)
    assert.ok(items.some((t) => t.task_id === 'C'))
  })

  it('overlays liveTask only when it matches focus', () => {
    const live = resolveOverlayLiveTask('A', { taskId: 'B', name: '偷焦点' })
    assert.equal(live, null)
    const ok = resolveOverlayLiveTask('A', { taskId: 'A', name: '同任务' })
    assert.equal(ok?.taskId, 'A')
  })
})
