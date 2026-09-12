import type { AgentPickerRow } from './agent-tags.ts'
import { normalizeAgentNameList } from './agent-tags.ts'
import type { SkillPickerItem } from '../components/SkillPickerModal.tsx'
import type { WorkflowToolItem } from '../hooks/useWorkflowResources.ts'

export type CapTag = { id: string; label: string }

const DEFAULT_TOOL_TIERS = new Set(['core', 'runtime', 'workspace'])

/** Map skill codes → human labels from catalog. */
export function labelSkills(
  names: string[],
  skills: SkillPickerItem[],
): CapTag[] {
  const map = new Map(skills.map((s) => [s.name, s.label || s.name]))
  return names.map((id) => ({ id, label: map.get(id) || id }))
}

/**
 * Resolve tools for display.
 * Agent.tools empty/null means「未单独限制」→ show default catalog tools (not "none").
 */
export function resolveAgentToolsDisplay(
  agent: AgentPickerRow | null | undefined,
  catalog: WorkflowToolItem[],
  max = 24,
): {
  mode: 'explicit' | 'default'
  tags: CapTag[]
  total: number
  more: number
} {
  const explicit = normalizeAgentNameList(agent?.tools)
  const labelOf = (name: string) =>
    catalog.find((t) => t.value === name)?.label || name

  if (explicit.length) {
    const tags = explicit.slice(0, max).map((id) => ({ id, label: labelOf(id) }))
    return {
      mode: 'explicit',
      tags,
      total: explicit.length,
      more: Math.max(0, explicit.length - max),
    }
  }

  const defaults = catalog.filter(
    (t) => t.value && DEFAULT_TOOL_TIERS.has(t.tier) && t.tier !== 'retired',
  )
  // Prefer ordered catalog; fall back if metadata missing
  const pool = defaults.length
    ? defaults
    : catalog.filter((t) => t.value && t.tier !== 'retired').slice(0, max)
  const tags = pool.slice(0, max).map((t) => ({ id: t.value, label: t.label || t.value }))
  return {
    mode: 'default',
    tags,
    total: pool.length,
    more: Math.max(0, pool.length - max),
  }
}
