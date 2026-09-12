/**
 * Gateway 守护策略
 * 纯函数，便于测试自动重启与计数重置规则
 */

export const MAX_AUTO_RESTART = 3
export const RESTART_COOLDOWN = 60000
export const STABLE_RUNNING_MS = 120000

/** 常规：连续 4 次 health 失败才重启（poll 15s → ~60s），降低繁忙误报 */
export const UNHEALTHY_THRESHOLD = 4

/** 流式 / reload 期间：再放宽至约 3 分钟（12 × 15s） */
export const BUSY_HOLD_FAILURE_THRESHOLD = 12

/** Plan 执行中：放宽至约 3 分钟无响应再考虑重启（12 × 15s） */
export const EXEC_HOLD_FAILURE_THRESHOLD = 12

import { LONG_RUN_WALL_MS } from './long-run-limits.js'

/** Plan 执行中 defer 上限；与长跑墙钟对齐，超过后仍无响应才允许 guardian 重启 */
export const EXEC_HOLD_MAX_MS = LONG_RUN_WALL_MS

/**
 * @param {{
 *   consecutiveFailures: number
 *   hasActivePlanExecution: boolean
 *   hasBusyHold: boolean
 *   holdFailureSince: number | null
 *   now: number
 * }} input
 */
export function evaluateHealthFailure({
  consecutiveFailures,
  hasActivePlanExecution,
  hasBusyHold = false,
  holdFailureSince,
  now,
}) {
  if (hasActivePlanExecution) {
    const since = holdFailureSince != null ? holdFailureSince : now
    if (now - since >= EXEC_HOLD_MAX_MS) {
      return {
        shouldRestart: consecutiveFailures >= UNHEALTHY_THRESHOLD,
        defer: false,
        forceAfterHold: true,
        reason: 'hold_expired',
      }
    }

    if (consecutiveFailures < EXEC_HOLD_FAILURE_THRESHOLD) {
      return {
        shouldRestart: false,
        defer: true,
        reason: 'plan_executing',
      }
    }

    return {
      shouldRestart: true,
      defer: false,
      forceAfterHold: true,
      reason: 'hold_threshold',
    }
  }

  if (hasBusyHold && consecutiveFailures < BUSY_HOLD_FAILURE_THRESHOLD) {
    return {
      shouldRestart: false,
      defer: true,
      reason: 'busy',
    }
  }

  return {
    shouldRestart: consecutiveFailures >= UNHEALTHY_THRESHOLD,
    defer: false,
  }
}

export function evaluateAutoRestartAttempt({
  now,
  lastRestartTime,
  autoRestartCount,
}) {
  if (now - lastRestartTime < RESTART_COOLDOWN) {
    return { action: 'cooldown' }
  }

  if (autoRestartCount >= MAX_AUTO_RESTART) {
    return { action: 'give_up' }
  }

  return {
    action: 'restart',
    autoRestartCount: autoRestartCount + 1,
    lastRestartTime: now,
  }
}

export function shouldResetAutoRestartCount({
  autoRestartCount,
  runningSince,
  now,
}) {
  if (autoRestartCount <= 0) return false
  if (!runningSince) return false
  return now - runningSince >= STABLE_RUNNING_MS
}
