import { describe, expect, it } from 'vitest'
import { extractDeptGroupHandoffs } from '../src/react/lib/dept-group-handoff.ts'

describe('extractDeptGroupHandoffs', () => {
  it('reads handlers list from tasks state result', () => {
    const hits = extractDeptGroupHandoffs({
      task_id: '2611031501_9b1e',
      status: 'completed',
      handlers: [
        { agent_code: 'dev-tech-director', content: '出最小版需求方案' },
        { agent_code: 'dev-qa', content: '独立验收' },
      ],
    })
    expect(hits.map((h) => h.agentCode)).toEqual(['dev-tech-director', 'dev-qa'])
    expect(hits[0].content).toContain('需求方案')
  })

  it('reads handlers_dispatched and dedupes by agent_code', () => {
    const hits = extractDeptGroupHandoffs({
      handlers: [{ agent_code: 'dev-backend', content: '短' }],
      handlers_dispatched: [
        { agent_code: 'dev-backend', content: '更长的派发说明', task_id: 't1', ok: true },
      ],
    })
    expect(hits).toHaveLength(1)
    expect(hits[0].agentCode).toBe('dev-backend')
    expect(hits[0].content).toContain('更长')
    expect(hits[0].taskId).toBe('t1')
  })

  it('parses JSON string content from tool payload', () => {
    const hits = extractDeptGroupHandoffs({
      content: JSON.stringify({
        handlers: [{ agent_code: 'dev-tech-director', content: '回群' }],
      }),
    })
    expect(hits).toEqual([
      { agentCode: 'dev-tech-director', content: '回群' },
    ])
  })

  it('returns empty for unrelated tool payloads', () => {
    expect(extractDeptGroupHandoffs({ name: 'read_file', path: '/x' })).toEqual([])
    expect(extractDeptGroupHandoffs(null)).toEqual([])
  })
})
