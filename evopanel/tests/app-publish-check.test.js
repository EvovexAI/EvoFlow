import { describe, expect, it } from 'vitest'
import { assessPublishReadiness } from '../src/lib/app-publish-check.js'

describe('assessPublishReadiness', () => {
  it('blocks only when there are no steps', () => {
    const r = assessPublishReadiness({ steps: [] }, [])
    expect(r.blockers.length).toBe(1)
    expect(r.warnings.length).toBe(0)
  })

  it('warns soft when answer is missing but still publishable', () => {
    const r = assessPublishReadiness({
      steps: [{ ref: '1', goal: '写一份竞品摘要', assigned_agent: 'general-purpose' }],
      answer_from_ref: '',
    })
    expect(r.blockers).toEqual([])
    expect(r.warnings.some((w) => w.includes('最终答案'))).toBe(true)
  })

  it('does not warn unused params when at least one required param is referenced', () => {
    const r = assessPublishReadiness(
      {
        steps: [{ ref: '1', goal: '围绕 {{topic}} 写报告', assigned_agent: 'general-purpose' }],
        answer_from_ref: '1',
      },
      [
        { name: 'topic', required: true },
        { name: 'tone', required: true },
      ],
    )
    expect(r.blockers).toEqual([])
    expect(r.warnings.some((w) => w.includes('运行参数'))).toBe(false)
  })

  it('warns when all required params are unused', () => {
    const r = assessPublishReadiness(
      {
        steps: [{ ref: '1', goal: '写一份报告', assigned_agent: 'general-purpose' }],
        answer_from_ref: '1',
      },
      [{ name: 'topic', required: true }],
    )
    expect(r.blockers).toEqual([])
    expect(r.warnings.some((w) => w.includes('运行参数'))).toBe(true)
  })
})
