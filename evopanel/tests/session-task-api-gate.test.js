import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveSessionTaskId,
  sessionNeedsTaskApiLookup,
} from '../src/lib/session-task-api-gate.js'

test('sessionNeedsTaskApiLookup only checks session task id', () => {
  assert.equal(sessionNeedsTaskApiLookup(''), false)
  assert.equal(sessionNeedsTaskApiLookup('Task_1'), true)
})

test('resolveSessionTaskId uses session list collabTaskId only', () => {
  assert.equal(resolveSessionTaskId({ collabTaskId: 'Task_row' }), 'Task_row')
  assert.equal(resolveSessionTaskId({ collabTaskId: '' }), '')
  assert.equal(resolveSessionTaskId(null, 'Task_hint'), 'Task_hint')
})
