import { describe, expect, it } from 'vitest'
import { resolveAgentToolsDisplay, labelSkills } from '../src/react/lib/agent-caps-display.ts'

describe('resolveAgentToolsDisplay', () => {
  const catalog = [
    { value: 'shell', label: '终端', icon: '', desc: '', tier: 'core', typeLabel: '' },
    { value: 'web_search', label: '网页搜索', icon: '', desc: '', tier: 'core', typeLabel: '' },
    { value: 'rare_tool', label: '冷门工具', icon: '', desc: '', tier: 'optional', typeLabel: '' },
  ]

  it('shows default catalog tools when agent has no whitelist', () => {
    const r = resolveAgentToolsDisplay({ tools: [] }, catalog, 24)
    expect(r.mode).toBe('default')
    expect(r.tags.some((t) => t.label === '终端')).toBe(true)
    expect(r.tags.some((t) => t.id === 'rare_tool')).toBe(false)
  })

  it('shows explicit tools with labels when whitelist present', () => {
    const r = resolveAgentToolsDisplay({ tools: ['web_search'] }, catalog, 24)
    expect(r.mode).toBe('explicit')
    expect(r.tags).toEqual([{ id: 'web_search', label: '网页搜索' }])
  })
})

describe('labelSkills', () => {
  it('maps skill codes to catalog labels', () => {
    const tags = labelSkills(['aihot'], [{ name: 'aihot', label: 'AI HOT', description: '', icon: '' }])
    expect(tags[0].label).toBe('AI HOT')
  })
})
