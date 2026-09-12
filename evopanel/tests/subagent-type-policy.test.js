import { describe, expect, it } from 'vitest'
import {
  isClaudeCodeSubagentType,
  usesDeltaStreamMerge,
} from '../src/lib/subagent-type-policy.js'

describe('subagent-type-policy', () => {
  it('treats only Claude Code family as claude', () => {
    expect(isClaudeCodeSubagentType('claude-code')).toBe(true)
    expect(isClaudeCodeSubagentType('claude-session')).toBe(true)
    expect(isClaudeCodeSubagentType('my-custom-video-agent')).toBe(false)
    expect(isClaudeCodeSubagentType('media-crew')).toBe(false)
    expect(isClaudeCodeSubagentType('bash')).toBe(false)
  })

  it('delta merge for every non-claude name including custom registry ids', () => {
    expect(usesDeltaStreamMerge('my-custom-research-bot')).toBe(true)
    expect(usesDeltaStreamMerge('general-purpose')).toBe(true)
    expect(usesDeltaStreamMerge('claude-code')).toBe(false)
  })
})
