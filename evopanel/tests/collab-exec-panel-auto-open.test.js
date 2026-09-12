import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldAutoOpenCollabExecPanel } from '../src/lib/plan-task-status.js'

test('shouldAutoOpenCollabExecPanel opens only during active execution', () => {
  const base = {
    boundPlanReady: true,
    executionAuthorized: true,
    planGoal: 'goal',
  }
  assert.equal(
    shouldAutoOpenCollabExecPanel({ ...base, status: 'executing' }, { collabPhase: 'executing' }),
    true,
  )
  assert.equal(
    shouldAutoOpenCollabExecPanel({ ...base, status: 'completed' }, { collabPhase: 'executing' }),
    false,
  )
  assert.equal(
    shouldAutoOpenCollabExecPanel({ ...base, status: 'planned' }, { collabPhase: 'plan_ready' }),
    false,
  )
})

test('shouldAutoOpenCollabExecPanel ignores executing phase without plan body', () => {
  assert.equal(
    shouldAutoOpenCollabExecPanel(null, { collabPhase: 'executing' }),
    false,
  )
  assert.equal(
    shouldAutoOpenCollabExecPanel({ status: 'executing' }, { collabPhase: 'executing' }),
    false,
  )
})
