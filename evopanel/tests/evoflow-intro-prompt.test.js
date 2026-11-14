import { describe, expect, it } from 'vitest'
import { EVOFLOW_INTRO_SELF_LABEL, EVOFLOW_INTRO_SELF_PROMPT } from '../src/lib/evoflow-intro-prompt.js'

describe('evoflow-intro-prompt', () => {
  it('uses intro label and formal self-intro prompt', () => {
    expect(EVOFLOW_INTRO_SELF_LABEL).toBe('介绍一下自己~')
    expect(EVOFLOW_INTRO_SELF_PROMPT).toContain('正式、清晰地介绍')
    // b380398a 起 prompt 精简为能力/场景/使用方式三类要点，不再内嵌官网 URL——
    // 详细产品资料合并进 evoflow-admin 的 references/product-intro.md（见文件头注释）。
    expect(EVOFLOW_INTRO_SELF_PROMPT).toContain('能力边界')
    expect(EVOFLOW_INTRO_SELF_PROMPT).toContain('适用场景')
    expect(EVOFLOW_INTRO_SELF_PROMPT).toContain('基本使用方式')
  })
})
