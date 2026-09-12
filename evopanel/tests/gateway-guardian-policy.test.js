import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_AUTO_RESTART,
  RESTART_COOLDOWN,
  STABLE_RUNNING_MS,
  UNHEALTHY_THRESHOLD,
  EXEC_HOLD_FAILURE_THRESHOLD,
  EXEC_HOLD_MAX_MS,
  evaluateAutoRestartAttempt,
  evaluateHealthFailure,
  shouldResetAutoRestartCount,
} from '../src/lib/gateway-guardian-policy.js'

test('短暂恢复运行不应立即清零自动重启计数', () => {
  assert.equal(
    shouldResetAutoRestartCount({
      autoRestartCount: 2,
      runningSince: 10_000,
      now: 10_000 + STABLE_RUNNING_MS - 1,
    }),
    false,
  )
})

test('稳定运行超过阈值后才允许清零自动重启计数', () => {
  assert.equal(
    shouldResetAutoRestartCount({
      autoRestartCount: 2,
      runningSince: 10_000,
      now: 10_000 + STABLE_RUNNING_MS,
    }),
    true,
  )
})

test('达到最大自动重启次数后必须停止守护', () => {
  assert.deepEqual(
    evaluateAutoRestartAttempt({
      now: 90_000,
      lastRestartTime: 0,
      autoRestartCount: MAX_AUTO_RESTART,
    }),
    { action: 'give_up' },
  )
})

test('冷却时间内不应重复自动重启', () => {
  assert.deepEqual(
    evaluateAutoRestartAttempt({
      now: RESTART_COOLDOWN - 1,
      lastRestartTime: 0,
      autoRestartCount: 1,
    }),
    { action: 'cooldown' },
  )
})

test('满足条件时应增加自动重启计数并记录重启时间', () => {
  assert.deepEqual(
    evaluateAutoRestartAttempt({
      now: 120_000,
      lastRestartTime: 0,
      autoRestartCount: 1,
    }),
    {
      action: 'restart',
      autoRestartCount: 2,
      lastRestartTime: 120_000,
    },
  )
})

test('无 Plan 执行时连续 health 失败达到阈值才应重启', () => {
  assert.deepEqual(
    evaluateHealthFailure({
      consecutiveFailures: UNHEALTHY_THRESHOLD,
      hasActivePlanExecution: false,
      holdFailureSince: null,
      now: 30_000,
    }),
    { shouldRestart: true, defer: false },
  )
})

test('Plan 执行中应 defer 自动重启', () => {
  assert.deepEqual(
    evaluateHealthFailure({
      consecutiveFailures: UNHEALTHY_THRESHOLD,
      hasActivePlanExecution: true,
      holdFailureSince: 10_000,
      now: 40_000,
    }),
    { shouldRestart: false, defer: true, reason: 'plan_executing' },
  )
})

test('Plan 执行中长时间无响应后允许强制重启', () => {
  const decision = evaluateHealthFailure({
    consecutiveFailures: UNHEALTHY_THRESHOLD,
    hasActivePlanExecution: true,
    holdFailureSince: 0,
    now: EXEC_HOLD_MAX_MS + 1,
  })
  assert.equal(decision.shouldRestart, true)
  assert.equal(decision.defer, false)
  assert.equal(decision.forceAfterHold, true)
  assert.equal(decision.reason, 'hold_expired')
})

test('Plan 执行中连续失败达到 hold 阈值后重启', () => {
  const decision = evaluateHealthFailure({
    consecutiveFailures: EXEC_HOLD_FAILURE_THRESHOLD,
    hasActivePlanExecution: true,
    holdFailureSince: 10_000,
    now: 200_000,
  })
  assert.equal(decision.shouldRestart, true)
  assert.equal(decision.forceAfterHold, true)
  assert.equal(decision.reason, 'hold_threshold')
})

test('流式 run 或 reload 期间应 defer 自动重启', () => {
  assert.deepEqual(
    evaluateHealthFailure({
      consecutiveFailures: 4,
      hasActivePlanExecution: false,
      hasBusyHold: true,
      holdFailureSince: null,
      now: 60_000,
    }),
    { shouldRestart: false, defer: true, reason: 'busy' },
  )
})
