/**
 * Agent avatar resolution — emoji, custom image, system preset, or initial fallback.
 */

import {
  avatarMetaFromWire,
  agentAvatarImageUrl,
  agentAvatarPresetUrl,
  type AgentAvatarMetaWire,
} from './agent-avatar-meta'

export type { AgentAvatarMetaWire } from './agent-avatar-meta'

export type AgentAvatarAgent = {
  agent_code?: string | null
  agent_name?: string | null
  avatar?: string | null
  avatar_meta?: AgentAvatarMetaWire | null
  has_avatar_file?: boolean
  /** Cache-bust token from GET /api/agents (bundled sha / mtime). */
  avatar_rev?: string | null
}

export type ResolvedAgentAvatar =
  | { kind: 'emoji'; emoji: string }
  | { kind: 'image'; src: string; meta: ReturnType<typeof avatarMetaFromWire> }
  | { kind: 'initial'; initial: string; bg: string }

const AVATAR_COLORS = ['#635bff', '#4b5563', '#64748b', '#57534e', '#0f766e', '#1d4ed8', '#b45309', '#7c3aed']

/** Legacy UI placeholders — not real gallery ids. */
const LEGACY_PRESET_IDS = new Set(['mochi', 'ink', 'bolt'])

const EMOJI_RE = /^(?:\p{Emoji_Presentation}|\p{Emoji}️)(?:‍(?:\p{Emoji_Presentation}|\p{Emoji}️))*$/u

export function hashColor(name: string): string {
  const hash = name.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]
}

export function resolveInitial(agent?: AgentAvatarAgent | null): string {
  const name = String(agent?.agent_name || agent?.agent_code || '?').trim()
  return name.charAt(0).toUpperCase() || '?'
}

export function parseAvatarString(avatar?: string | null): { type: string; value: string } | null {
  const raw = avatar?.trim()
  if (!raw) return null
  if (raw === 'image') return { type: 'image', value: 'image' }
  const idx = raw.indexOf(':')
  if (idx <= 0) {
    if (/^https?:\/\//i.test(raw) || raw.startsWith('/')) return { type: 'url', value: raw }
    if (EMOJI_RE.test(raw)) return { type: 'emoji', value: raw }
    return null
  }
  const type = raw.slice(0, idx)
  const value = raw.slice(idx + 1)
  return { type, value }
}

export function resolveAgentAvatar(
  agent: AgentAvatarAgent | null | undefined,
  opts?: { baseUrl?: string }
): ResolvedAgentAvatar {
  const code = String(agent?.agent_code || '').trim().toLowerCase()
  const displayName = String(agent?.agent_name || code || '?')
  const parsed = parseAvatarString(agent?.avatar)
  const base = opts?.baseUrl || ''

  // Explicit gallery preset always wins — do not let a leftover agents/{code}/avatar.*
  // (or re-seeded builtin cutout) hide the user's selection.
  if (parsed?.type === 'preset' && parsed.value) {
    const pid = String(parsed.value).trim().toLowerCase()
    if (pid && !LEGACY_PRESET_IDS.has(pid)) {
      return {
        kind: 'image',
        src: agentAvatarPresetUrl(base, pid, agent?.avatar || ''),
        meta: avatarMetaFromWire(agent?.avatar_meta ?? null),
      }
    }
  }

  // Explicit emoji wins over an on-disk file (user deliberately left cutout mode).
  if (parsed?.type === 'emoji' && parsed.value) {
    return { kind: 'emoji', emoji: parsed.value }
  }

  // File / URL cutout: avatar=image|url, or legacy null/empty with a file on disk
  // (common after packaging shipped cutouts but config was never upgraded).
  const preferImage =
    parsed?.type === 'image' ||
    parsed?.type === 'url' ||
    ((!parsed || (parsed.type === 'preset' && LEGACY_PRESET_IDS.has(String(parsed.value).toLowerCase()))) &&
      agent?.has_avatar_file === true)

  if (preferImage && agent?.has_avatar_file !== false) {
    const cacheKey =
      agent?.avatar_rev ||
      (agent?.avatar_meta ? JSON.stringify(agent.avatar_meta) : '') ||
      agent?.avatar ||
      ''
    const src =
      parsed?.type === 'url'
        ? parsed.value
        : code
          ? agentAvatarImageUrl(base, code, cacheKey)
          : ''
    if (src) {
      const meta = avatarMetaFromWire(agent?.avatar_meta ?? null)
      return { kind: 'image', src, meta }
    }
  }

  return {
    kind: 'initial',
    initial: resolveInitial(agent),
    bg: hashColor(displayName),
  }
}

export function formatAvatarForSave(kind: 'emoji' | 'image' | 'preset', value?: string): string | null {
  if (kind === 'image') return 'image'
  if (kind === 'emoji' && value) return `emoji:${value}`
  if (kind === 'preset' && value) {
    const id = String(value).trim().toLowerCase()
    if (!id || LEGACY_PRESET_IDS.has(id)) return null
    return `preset:${id}`
  }
  return null
}
