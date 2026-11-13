import { describe, it, expect } from 'vitest'
import {
  agentCodeLabelZh,
  effectiveBoardTaskStatus,
  groupBoardTasksByLane,
  riskLevelLabelZh,
} from '../src/react/lib/employee-current-task.ts'

describe('employee-current-task display helpers', () => {
  it('effectiveBoardTaskStatus lifts pending → executing when session is running', () => {
    expect(effectiveBoardTaskStatus('pending', { isRunning: true })).toBe('executing')
    expect(effectiveBoardTaskStatus('planned', { roleBusyOnSession: true })).toBe('executing')
    expect(effectiveBoardTaskStatus('pending', { isRunning: false })).toBe('pending')
    expect(effectiveBoardTaskStatus('completed', { isRunning: true })).toBe('completed')
  })

  it('riskLevelLabelZh maps enums', () => {
    expect(riskLevelLabelZh('low')).toBe('低风险')
    expect(riskLevelLabelZh('medium')).toBe('中风险')
    expect(riskLevelLabelZh('high')).toBe('高风险')
  })

  it('agentCodeLabelZh prefers resolver then builtins', () => {
    expect(agentCodeLabelZh('xiaomi')).toBe('小V')
    expect(
      agentCodeLabelZh('dev-fullstack', (c) => (c === 'dev-fullstack' ? '全栈工程师' : '')),
    ).toBe('全栈工程师')
    expect(agentCodeLabelZh('unknown-agent')).toBe('unknown-agent')
  })

  it('groupBoardTasksByLane splits active / queued / done', () => {
    const lanes = groupBoardTasksByLane([
      { id: '1', status: 'executing', updated_at: '2026-01-02' },
      { id: '2', status: 'pending', updated_at: '2026-01-03' },
      { id: '3', status: 'completed', updated_at: '2026-01-01' },
    ])
    expect(lanes.active.map((t) => t.id)).toEqual(['1'])
    expect(lanes.queued.map((t) => t.id)).toEqual(['2'])
    expect(lanes.done.map((t) => t.id)).toEqual(['3'])
    expect(lanes.open.map((t) => t.id)).toEqual(['1', '2'])
  })
})
