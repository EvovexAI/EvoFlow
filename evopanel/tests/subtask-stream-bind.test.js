import test from 'node:test'
import assert from 'node:assert/strict'
import { findSubagentTaskForCollabSubtask } from '../src/lib/subtask-stream-bind.js'

test('binds stream only by collab_subtask_id for persisted subtasks', () => {
  const sub1 = 'Subtask_20260417055511_035676'
  const sub2 = 'Subtask_20260417055511_035677'
  const sub3 = 'Subtask_20260417055511_035678'
  const tasksMap = {
    exec1: {
      taskId: 'exec1',
      collabSubtaskId: sub1,
      phase: 'running',
      description: 'Analyze codebase structure',
      liveOutput: 'Reading files…',
    },
  }

  assert.equal(findSubagentTaskForCollabSubtask(tasksMap, sub1, 'Analyze codebase structure')?.taskId, 'exec1')
  assert.equal(findSubagentTaskForCollabSubtask(tasksMap, sub2, 'Implement feature'), undefined)
  assert.equal(findSubagentTaskForCollabSubtask(tasksMap, sub3, 'Write tests'), undefined)
})

test('does not steal a stream already bound to another subtask via fuzzy description', () => {
  const sub1 = 'Subtask_aaa_111'
  const sub2 = 'Subtask_aaa_222'
  const tasksMap = {
    exec1: {
      taskId: 'exec1',
      collabSubtaskId: sub1,
      phase: 'running',
      description: 'Step one: gather requirements',
      liveOutput: 'streaming step one',
    },
  }

  assert.equal(
    findSubagentTaskForCollabSubtask(tasksMap, sub2, 'Step two: implement based on requirements'),
    undefined,
  )
})

test('orphan stream without collab_subtask_id matches only exact description', () => {
  const sub1 = 'Subtask_orphan_1'
  const tasksMap = {
    exec1: {
      taskId: 'exec1',
      phase: 'running',
      description: 'Exact subtask title',
      liveOutput: 'live',
    },
  }

  assert.equal(
    findSubagentTaskForCollabSubtask(tasksMap, sub1, 'Exact subtask title')?.taskId,
    'exec1',
  )
  assert.equal(findSubagentTaskForCollabSubtask(tasksMap, sub1, 'Exact subtask'), undefined)
})

test('matches by taskId when collabSubtaskId missing on stream row', () => {
  const sub1 = 'Subtask_20260417055511_035676'
  const tasksMap = {
    [sub1]: {
      taskId: sub1,
      phase: 'running',
      description: 'Run analysis',
      liveOutput: 'working',
    },
  }

  assert.equal(findSubagentTaskForCollabSubtask(tasksMap, sub1, 'Run analysis')?.taskId, sub1)
})
