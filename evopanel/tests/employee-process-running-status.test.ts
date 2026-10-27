import { describe, expect, it } from 'vitest'

/**
 * 回归：员工执行过程面板的「执行中」徽标必须以后端 run_status 为准。
 *
 * 现象（2026-10-27 实测）：任务已经 completed，右侧面板徽标仍显示「执行中」，
 * 因为 busy 是派单那一刻写进 tab 的乐观值、没有回写，而旧判定是
 * `busy || RUNNING.has(status)` —— 或运算让 busy 永远压过真实终态。
 */

const RUNNING = new Set(['running', 'busy', 'active', 'in_progress', 'queued', 'pending'])

/** 与 v4-employee-process-pane.tsx 保持一致 */
function isRunning(busy: boolean, runStatus: string): boolean {
  const statusLow = String(runStatus || '').toLowerCase()
  return statusLow ? RUNNING.has(statusLow) : busy
}

describe('员工执行过程 · 运行态判定', () => {
  it('后端已 done 时不因 busy=true 仍显示执行中', () => {
    expect(isRunning(true, 'done')).toBe(false)
  })

  it('后端终态 completed / failed / cancelled 都算结束', () => {
    expect(isRunning(true, 'completed')).toBe(false)
    expect(isRunning(true, 'failed')).toBe(false)
    expect(isRunning(true, 'cancelled')).toBe(false)
  })

  it('后端仍在跑时显示执行中（busy 无论真假）', () => {
    expect(isRunning(false, 'running')).toBe(true)
    expect(isRunning(true, 'running')).toBe(true)
  })

  it('后端状态缺失时才用 busy 兜底', () => {
    expect(isRunning(true, '')).toBe(true)
    expect(isRunning(false, '')).toBe(false)
  })
})
