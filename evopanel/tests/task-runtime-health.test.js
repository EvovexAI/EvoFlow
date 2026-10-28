import { describe, expect, it } from 'vitest'
import {
  buildActiveSessionIndex,
  resolveTaskRuntimeHealth,
  runtimeHealthStatusSuffix,
} from '../src/lib/task-runtime-health.js'

describe('resolveTaskRuntimeHealth', () => {
  const index = buildActiveSessionIndex([
    { session_key: 's1', thread_id: 'th-live', collab_task_id: 'task-a', status: 'running' },
  ])

  it('marks in-flight task live when thread matches', () => {
    expect(
      resolveTaskRuntimeHealth({ id: 'x', status: 'executing', thread_id: 'th-live' }, index),
    ).toBe('live')
  })

  it('marks in-flight task live when collab_task_id matches', () => {
    expect(
      resolveTaskRuntimeHealth({ id: 'task-a', status: 'executing', thread_id: '' }, index),
    ).toBe('live')
  })

  it('marks in-flight task interrupted when no active session', () => {
    expect(
      resolveTaskRuntimeHealth({ id: 'orphan', status: 'executing', thread_id: 'th-dead' }, index),
    ).toBe('interrupted')
  })

  it('returns idle for completed / waiting / pending', () => {
    expect(resolveTaskRuntimeHealth({ id: '1', status: 'completed' }, index)).toBe('idle')
    expect(resolveTaskRuntimeHealth({ id: '1', status: 'awaiting_close' }, index)).toBe('idle')
    expect(resolveTaskRuntimeHealth({ id: '1', status: 'pending' }, index)).toBe('idle')
  })

  it('suffix text for status line', () => {
    expect(runtimeHealthStatusSuffix('live')).toBe('进程在跑')
    expect(runtimeHealthStatusSuffix('interrupted')).toBe('进程已停')
    expect(runtimeHealthStatusSuffix('idle')).toBe('')
  })

  it('does not guess interrupted before session index is ready', () => {
    expect(
      resolveTaskRuntimeHealth({ id: 'x', status: 'executing', thread_id: 'th' }, null),
    ).toBe('n/a')
  })

  it('prefers server runtime_health over client session probe', () => {
    expect(
      resolveTaskRuntimeHealth(
        { id: 'task-a', status: 'executing', runtime_health: 'interrupted' },
        index,
      ),
    ).toBe('interrupted')
    expect(
      resolveTaskRuntimeHealth(
        { id: 'orphan', status: 'executing', runtime_health: 'live' },
        index,
      ),
    ).toBe('live')
  })
})
