/**
 * 员工任务「看起来卡住」回归：
 *   1. 执行中的任务必须能算出「已运行 X」；
 *   2. 完成的任务必须能算出「耗时 X」；
 *   3. 没有 started_at 时不编造数字；
 *   4. 完成但无产出的文案不能伪装成正常完成。
 */
import { describe, it, expect } from 'vitest'
import { durationLabel, fmtDuration, isExecutingStatus } from '../src/lib/task-duration.js'

const T0 = '2026-10-23T20:10:18.000Z'
const T1 = '2026-10-23T20:14:38.000Z' // +4m20s

describe('task duration labels', () => {
  it('formats seconds / minutes / hours', () => {
    expect(fmtDuration(T0, '2026-10-23T20:10:48.000Z')).toBe('30 秒')
    expect(fmtDuration(T0, T1)).toBe('4 分 20 秒')
    expect(fmtDuration(T0, '2026-10-23T21:50:18.000Z')).toBe('1 小时 40 分')
  })

  it('marks running tasks with a growing "已运行" label', () => {
    const task = { status: 'executing', started_at: T0 }
    const at = Date.parse('2026-10-23T20:12:18.000Z') // +2m

    expect(durationLabel(task, at)).toBe('已运行 2 分')
    expect(isExecutingStatus(task.status)).toBe(true)
  })

  it('marks finished tasks with a fixed "耗时" label', () => {
    const task = { status: 'completed', started_at: T0, completed_at: T1 }
    expect(durationLabel(task)).toBe('耗时 4 分 20 秒')
  })

  it('never fabricates a duration without a start time', () => {
    expect(durationLabel({ status: 'completed' })).toBe('')
    expect(durationLabel(null)).toBe('')
    expect(fmtDuration('not-a-date', T1)).toBe('')
  })

  it('treats in_progress / running as executing', () => {
    expect(isExecutingStatus('in_progress')).toBe(true)
    expect(isExecutingStatus('RUNNING')).toBe(true)
    expect(isExecutingStatus('completed')).toBe(false)
    expect(isExecutingStatus('')).toBe(false)
  })
})
