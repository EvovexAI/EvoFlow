import { describe, it, expect } from 'vitest'
import {
  buildSubagentTasksFromTools,
  extractSubagentDisplayTextFromTool,
  extractSubagentDisplayTextFromToolOutput,
} from '../src/lib/subagent-tool-display.js'

describe('extractSubagentDisplayTextFromToolOutput', () => {
  it('parses Task Succeeded result prefix', () => {
    const text = extractSubagentDisplayTextFromToolOutput(
      'Task Succeeded. Result: ## 调研结论\n\n模块 A 负责路由。',
    )
    expect(text).toContain('调研结论')
    expect(text).not.toMatch(/^Task Succeeded/i)
  })

  it('parses JSON result object', () => {
    expect(extractSubagentDisplayTextFromToolOutput({ result: 'hello' })).toBe('hello')
  })
})

describe('buildSubagentTasksFromTools', () => {
  it('rebuilds map keyed by tool_call_id for history', () => {
    const map = buildSubagentTasksFromTools([
      {
        id: 'call_abc',
        name: 'subagent',
        input: { description: '代码调研', prompt: '列出模块', subagent_type: 'general-purpose' },
        output: 'Task Succeeded. Result: 正文在这里',
        status: 'completed',
      },
    ])
    expect(map.call_abc).toBeTruthy()
    expect(map.call_abc.liveOutput).toBe('正文在这里')
    expect(map.call_abc.description).toBe('代码调研')
  })

  it('extractSubagentDisplayTextFromTool works on tool row', () => {
    const t = {
      name: 'task',
      tool_call_id: 'x1',
      output: 'Task failed. Error: timeout',
    }
    expect(extractSubagentDisplayTextFromTool(t)).toBe('timeout')
  })
})
