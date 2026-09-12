import { describe, expect, it } from 'vitest'
import {
  formatAvatarForSave,
  hashColor,
  parseAvatarString,
  resolveAgentAvatar,
} from '../src/react/lib/agent-avatar.ts'

describe('agent-avatar', () => {
  it('parses emoji strings', () => {
    expect(parseAvatarString('emoji:🛠')).toEqual({ type: 'emoji', value: '🛠' })
  })

  it('falls back to initial letter when avatar unset', () => {
    const r = resolveAgentAvatar({ agent_code: 'main', agent_name: '小V' })
    expect(r.kind).toBe('initial')
    if (r.kind === 'initial') {
      expect(r.initial).toBe('小')
      expect(r.bg).toBe(hashColor('小V'))
    }
  })

  it('uses image when has_avatar_file even if avatar field is null', () => {
    const r = resolveAgentAvatar(
      { agent_code: 'quality-inspector', agent_name: '技术总监', avatar: null, has_avatar_file: true },
      { baseUrl: 'http://localhost' },
    )
    expect(r.kind).toBe('image')
    if (r.kind === 'image') {
      expect(r.src).toContain('/api/agents/quality-inspector/avatar')
    }
  })

  it('honors gallery preset even when an old avatar file still exists', () => {
    const r = resolveAgentAvatar(
      {
        agent_code: 'main',
        agent_name: '超级助手',
        avatar: 'preset:pm',
        has_avatar_file: true,
        avatar_rev: 'abc123',
      },
      { baseUrl: 'http://localhost' },
    )
    expect(r.kind).toBe('image')
    if (r.kind === 'image') {
      expect(r.src).toContain('/api/agents/avatar-presets/pm')
      expect(r.src).not.toContain('/api/agents/main/avatar')
    }
  })

  it('honors emoji over leftover avatar file', () => {
    const r = resolveAgentAvatar({
      agent_code: 'main',
      agent_name: '超级助手',
      avatar: 'emoji:🤖',
      has_avatar_file: true,
    })
    expect(r.kind).toBe('emoji')
    if (r.kind === 'emoji') expect(r.emoji).toBe('🤖')
  })

  it('uses file for legacy preset:mochi when has_avatar_file', () => {
    const r = resolveAgentAvatar(
      {
        agent_code: 'main',
        avatar: 'preset:mochi',
        has_avatar_file: true,
        avatar_rev: 'abc123',
      },
      { baseUrl: 'http://localhost' },
    )
    expect(r.kind).toBe('image')
    if (r.kind === 'image') {
      expect(r.src).toContain('/api/agents/main/avatar')
    }
  })

  it('resolves system preset avatars', () => {
    const r = resolveAgentAvatar(
      { agent_code: 'my-bot', avatar: 'preset:pm' },
      { baseUrl: 'http://localhost:8080' },
    )
    expect(r.kind).toBe('image')
    if (r.kind === 'image') {
      expect(r.src).toBe('http://localhost:8080/api/agents/avatar-presets/pm?v=preset%3Apm')
    }
  })

  it('ignores legacy preset values and uses initial', () => {
    const r = resolveAgentAvatar({ agent_code: 'x', avatar: 'preset:mochi' })
    expect(r.kind).toBe('initial')
  })

  it('formats preset for save', () => {
    expect(formatAvatarForSave('preset', 'engineer')).toBe('preset:engineer')
    expect(formatAvatarForSave('preset', 'mochi')).toBeNull()
  })

  it('prefixes gateway base on agent avatar image urls', () => {
    const r = resolveAgentAvatar(
      { agent_code: 'main', avatar: 'image', has_avatar_file: true, avatar_rev: 'r1' },
      { baseUrl: 'http://127.0.0.1:8070' },
    )
    expect(r.kind).toBe('image')
    if (r.kind === 'image') {
      expect(r.src).toBe('http://127.0.0.1:8070/api/agents/main/avatar?v=r1')
    }
  })
})
