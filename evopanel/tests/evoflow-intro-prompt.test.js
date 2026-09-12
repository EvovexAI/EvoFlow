import { describe, expect, it } from 'vitest'
import { EVOFLOW_INTRO_SELF_LABEL, EVOFLOW_INTRO_SELF_PROMPT } from '../src/lib/evoflow-intro-prompt.js'

describe('evoflow-intro-prompt', () => {
  it('uses intro label and formal self-intro prompt', () => {
    expect(EVOFLOW_INTRO_SELF_LABEL).toBe('介绍一下自己~')
    expect(EVOFLOW_INTRO_SELF_PROMPT).toContain('正式、清晰地介绍')
    expect(EVOFLOW_INTRO_SELF_PROMPT).toContain('https://www.evovexai.com/')
  })
})
