import test from 'node:test'
import assert from 'node:assert/strict'

import {
  clearPlanExecutionHold,
  isPlanExecutionHoldActive,
  registerPlanExecution,
  syncPlanExecHoldFromTaskRow,
  unregisterPlanExecution,
} from '../src/lib/gateway-exec-hold.js'

test('syncPlanExecHoldFromTaskRow registers executing tasks', () => {
  clearPlanExecutionHold()
  syncPlanExecHoldFromTaskRow({
    id: 'Task_1',
    thread_id: 'thread-a',
    status: 'executing',
  })
  assert.equal(isPlanExecutionHoldActive(), true)
  syncPlanExecHoldFromTaskRow({ id: 'Task_1', status: 'completed' })
  assert.equal(isPlanExecutionHoldActive(), false)
})

test('register and unregister plan execution', () => {
  clearPlanExecutionHold()
  registerPlanExecution('Task_2', 'thread-b')
  assert.equal(isPlanExecutionHoldActive(), true)
  unregisterPlanExecution('Task_2')
  assert.equal(isPlanExecutionHoldActive(), false)
})
