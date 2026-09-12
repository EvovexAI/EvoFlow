import { describe, expect, it } from 'vitest'
import { collabSseEnvelopeToSubtaskStreamEvent } from '../src/lib/collab-events.js'

describe('collabSseEnvelopeToSubtaskStreamEvent', () => {
  it('unwraps gateway task:running envelope', () => {
    const ev = collabSseEnvelopeToSubtaskStreamEvent({
      type: 'task:running',
      data: {
        type: 'task_running',
        task_id: 'SupervisorExec_abc',
        collab_subtask_id: 'Subtask_parallel_02',
        message: { type: 'ai', content: 'hello' },
      },
    })
    expect(ev?.type).toBe('task_running')
    expect(ev?.collab_subtask_id).toBe('Subtask_parallel_02')
  })

  it('maps task:completed when inner type missing', () => {
    const ev = collabSseEnvelopeToSubtaskStreamEvent({
      type: 'task:completed',
      data: {
        task_id: 'Subtask_parallel_03',
        collab_subtask_id: 'Subtask_parallel_03',
        result: 'done',
      },
    })
    expect(ev?.type).toBe('task_completed')
  })
})
