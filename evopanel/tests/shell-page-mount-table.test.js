import { describe, expect, it } from 'vitest'
import {
  matchShellPagePath,
  resolveShellPageTabTitle,
  shellPageTabId,
} from '../src/lib/right-stage/shell-page-mount-table.ts'

describe('shell-page mount table', () => {
  it('aliases /employees to proactive board', () => {
    const hit = matchShellPagePath('/employees')
    expect(hit?.mountId).toBe('employees.board')
    expect(hit?.path).toBe('/proactive')
    expect(shellPageTabId('/employees')).toBe('shell:/proactive')
  })

  it('aliases /employees/:code to employee detail', () => {
    const hit = matchShellPagePath('/employees/duty-ops')
    expect(hit?.mountId).toBe('employees.detail')
    expect(hit?.path).toBe('/proactive/duty-ops')
    expect(hit?.params.code).toBe('duty-ops')
  })

  it('titles employees paths as BOT', () => {
    // 员工名册对外统一叫 BOT（与 chat-summary-panel 等用例口径一致）
    expect(resolveShellPageTabTitle({ path: '/employees' })).toBe('BOT')
    expect(resolveShellPageTabTitle({ path: '/proactive', mountId: 'employees.board' })).toBe(
      'BOT',
    )
  })

  it('matches tasks board and items board', () => {
    expect(matchShellPagePath('/tasks')?.mountId).toBe('tasks.board')
    expect(matchShellPagePath('/tasks/items')?.mountId).toBe('items.board')
    expect(matchShellPagePath('/task/mt-1')?.mountId).toBe('tasks.detail')
    expect(resolveShellPageTabTitle({ path: '/tasks', mountId: 'tasks.board' })).toBe('任务')
    expect(resolveShellPageTabTitle({ path: '/tasks/items', mountId: 'items.board' })).toBe('待办')
  })
})
