import { describe, expect, it } from 'vitest'
import {
  agentHasTag,
  buildTagPickerEntries,
  filterAgentsByTag,
  sortAgentsForPicker,
} from '../src/react/lib/agent-tags.ts'

describe('agent-tags', () => {
  const agents = [
    { agent_code: 'main', agent_name: '主智能体', tags: [] },
    { agent_code: 'project-planner', agent_name: '规划', tags: ['项目'] },
    { agent_code: 'my-bot', agent_name: '我的助手', tags: ['自定义', '代码'] },
  ]

  it('sortAgentsForPicker puts main first', () => {
    const sorted = sortAgentsForPicker(agents)
    expect(sorted[0]?.agent_code).toBe('main')
  })

  it('buildTagPickerEntries skips empty tags', () => {
    const entries = buildTagPickerEntries(agents)
    const labels = entries.map((e) => e.label)
    expect(labels).toContain('项目')
    expect(labels).toContain('自定义')
    expect(labels).not.toContain('核心')
  })

  it('filterAgentsByTag matches substring', () => {
    const filtered = filterAgentsByTag(agents, '项目')
    expect(filtered.map((a) => a.agent_code)).toEqual(['project-planner'])
    expect(agentHasTag(agents[2], '代码')).toBe(true)
  })
})
