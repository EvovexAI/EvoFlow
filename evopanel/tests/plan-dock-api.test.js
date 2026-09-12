import { describe, expect, it } from 'vitest'
import { planDockApiHide, planDockApiShow } from '../src/lib/plan-dock-api.js'

describe('plan-dock-api', () => {
  it('planDockApiShow marks show true with source', () => {
    const view = planDockApiShow('session_enter', { taskId: 'Task_1', statusLabel: '待授权开始执行' })
    expect(view.show).toBe(true)
    expect(view.source).toBe('session_enter')
    expect(view.taskId).toBe('Task_1')
  })

  it('planDockApiHide marks show false with reason', () => {
    const view = planDockApiHide('session_enter', 'not_awaiting_exec', { taskId: 'Task_1' })
    expect(view.show).toBe(false)
    expect(view.reason).toBe('not_awaiting_exec')
  })
})
