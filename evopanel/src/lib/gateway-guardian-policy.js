/**
 * Gateway 守护策略
 * 纯函数，便于测试自动重启与计数重置规则
 *
 * 契约（P0）：
 * - HTTP 探活失败但 sidecar 子进程仍存活 → 视为忙/事件循环堵，只 defer，不杀进程
 * - 仅当子进程已退出（或无法确认且连续失败达阈）才允许 restart
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

/**
 * 子进程仍活但 HTTP 不通：允许 defer 的最长时间。
 * 超过后仍不杀进程（避免误杀），只记录 reason=wedged_give_up。
 */
export const WEDGED_DEFER_MAX_MS = 30 * 60 * 1000

import { LONG_RUN_WALL_MS } from './long-run-limits.js'

/** Plan 执行中 defer 上限；与长跑墙钟对齐，超过后仍无响应才允许 guardian 重启 */
export const EXEC_HOLD_MAX_MS = LONG_RUN_WALL_MS

/**
 * @param {{
 *   consecutiveFailures: number
 *   hasActivePlanExecution: boolean
 *   hasBusyHold?: boolean
 *   holdFailureSince: number | null
 *   now: number
 *   sidecarProcessAlive?: boolean | null
 *   eventLoopLagHigh?: boolean
 * }} input
 */
export function evaluateHealthFailure({
  consecutiveFailures,
  hasActivePlanExecution,
  hasBusyHold = false,
  holdFailureSince,
  now,
  sidecarProcessAlive = null,
  eventLoopLagHigh = false,
}) {
  // Process still owned & alive: never kill — loop may be wedged on heavy work.
  if (sidecarProcessAlive === true) {
    const since = holdFailureSince != null ? holdFailureSince : now
    if (now - since >= WEDGED_DEFER_MAX_MS) {
      return {
        shouldRestart: false,
        defer: true,
        reason: 'wedged_give_up',
      }
    }
    return {
      shouldRestart: false,
      defer: true,
      reason: eventLoopLagHigh ? 'event_loop_lag' : 'process_alive_busy',
    }
  }

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

  // Busy hold: never fall through to kill while hold is logical-true.
  // (Caller may still pass this when early-return hold path is skipped.)
  if (hasBusyHold) {
    if (consecutiveFailures < BUSY_HOLD_FAILURE_THRESHOLD) {
      return {
        shouldRestart: false,
        defer: true,
        reason: 'busy',
      }
    }
    // Past busy threshold: still do not kill unless process is confirmed dead.
    if (sidecarProcessAlive !== false) {
      return {
        shouldRestart: false,
        defer: true,
        reason: 'busy_extended',
      }
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
