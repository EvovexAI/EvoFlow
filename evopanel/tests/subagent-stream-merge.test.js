import { describe, expect, it } from 'vitest'
import { mergeSubagentStreamEvent } from '../src/react/subagent-stream-merge.js'

describe('mergeSubagentStreamEvent', () => {
  it('does not regress phase from completed when a stale task_running arrives (claude SSE reorder)', () => {
    const map = {}
    mergeSubagentStreamEvent(map, {
      type: 'task_started',
      task_id: 'sub-1',
      collab_subtask_id: 'sub-1',
      description: 'x',
      subagent_type: 'claude-code',
    })
    mergeSubagentStreamEvent(map, {
      type: 'task_completed',
      task_id: 'sub-1',
      collab_subtask_id: 'sub-1',
      subagent_type: 'claude-code',
      result: 'done',
    })
    expect(map['sub-1']?.phase).toBe('completed')
    mergeSubagentStreamEvent(map, {
      type: 'task_running',
      task_id: 'sub-1',
      collab_subtask_id: 'sub-1',
      subagent_type: 'claude-code',
      message: { type: 'ai', content: 'late chunk' },
    })
    expect(map['sub-1']?.phase).toBe('completed')
  })

  it('any non-claude id (built-in or custom agents/config name) uses delta merge', () => {
    for (const subagent_type of [
      'bash',
      'general-purpose',
      'my-custom-video-agent',
      'media-crew',
    ]) {
      const map = {}
      const id = `sub-${subagent_type}`
      mergeSubagentStreamEvent(map, {
        type: 'task_running',
        task_id: id,
        collab_subtask_id: id,
        subagent_type,
        message: { type: 'ai', content: 'hel' },
      })
      mergeSubagentStreamEvent(map, {
        type: 'task_running',
        task_id: id,
        collab_subtask_id: id,
        subagent_type,
        message: { type: 'ai', content: 'lo' },
      })
      expect(map[id]?.liveOutput).toBe('hello')
    }
  })

  it('claude-code still uses session delta merge (not paragraph append)', () => {
    const map = {}
    mergeSubagentStreamEvent(map, {
      type: 'task_running',
      task_id: 'claude-1',
      subagent_type: 'claude-code',
      message: { type: 'ai', content: 'ab' },
    })
    mergeSubagentStreamEvent(map, {
      type: 'task_running',
      task_id: 'claude-1',
      subagent_type: 'claude-code',
      message: { type: 'ai', content: 'c' },
    })
    expect(map['claude-1']?.liveOutput).toBe('abc')
  })

  it('parallel subtasks merge into separate buckets by collab_subtask_id', () => {
    const map = {}
    for (const sid of ['Subtask_1', 'Subtask_2', 'Subtask_3']) {
      mergeSubagentStreamEvent(map, {
        type: 'task_running',
        task_id: sid,
        collab_subtask_id: sid,
        subagent_type: 'general-purpose',
        message: { type: 'ai', content: `live-${sid}` },
      })
    }
    expect(map.Subtask_1?.liveOutput).toContain('live-Subtask_1')
    expect(map.Subtask_2?.liveOutput).toContain('live-Subtask_2')
    expect(map.Subtask_3?.liveOutput).toContain('live-Subtask_3')
  })

  it('task_started after completed starts a new running cycle', () => {
    const map = {}
    mergeSubagentStreamEvent(map, {
      type: 'task_completed',
      task_id: 'sub-2',
      collab_subtask_id: 'sub-2',
      result: 'first',
    })
    mergeSubagentStreamEvent(map, {
      type: 'task_started',
      task_id: 'sub-2',
      collab_subtask_id: 'sub-2',
      description: 'retry',
    })
    expect(map['sub-2']?.phase).toBe('running')
  })

  it('sequential subtasks keep separate stream buckets after first completes', () => {
    const map = {}
    mergeSubagentStreamEvent(map, {
      type: 'task_running',
      task_id: 'Subtask_A',
      task_exec_id: 'exec-a',
      collab_subtask_id: 'Subtask_A',
      message: { type: 'ai', content: 'first live' },
    })
    mergeSubagentStreamEvent(map, {
      type: 'task_completed',
      task_id: 'exec-a',
      task_exec_id: 'exec-a',
      collab_subtask_id: 'Subtask_A',
      result: 'done',
    })
    mergeSubagentStreamEvent(map, {
      type: 'task_running',
      task_id: 'Subtask_B',
      task_exec_id: 'exec-b',
      collab_subtask_id: 'Subtask_B',
      message: { type: 'ai', content: 'second live' },
    })
    expect(map.Subtask_A?.phase).toBe('completed')
    expect(map.Subtask_B?.phase).toBe('running')
    expect(map.Subtask_B?.liveOutput).toContain('second live')
  })

  it('preserves background task_id as taskExecId when collab remaps the map key', () => {
    const map = {}
    mergeSubagentStreamEvent(map, {
      type: 'task_started',
      task_id: 'call_bg_99',
      collab_subtask_id: 'Subtask_X',
      description: 'voice reply',
      subagent_type: 'general-purpose',
    })
    expect(map.Subtask_X?.taskId).toBe('Subtask_X')
    expect(map.Subtask_X?.taskExecId).toBe('call_bg_99')
    expect(map.call_bg_99?.taskExecId).toBe('call_bg_99')
    mergeSubagentStreamEvent(map, {
      type: 'task_running',
      task_id: 'call_bg_99',
      collab_subtask_id: 'Subtask_X',
      message: { type: 'ai', content: 'hello live' },
    })
    expect(map.Subtask_X?.liveOutput).toContain('hello live')
    expect(map.call_bg_99?.liveOutput).toContain('hello live')
  })
})
