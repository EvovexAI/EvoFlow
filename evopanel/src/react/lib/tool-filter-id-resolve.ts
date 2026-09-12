import { findToolRowByCallId } from '../../lib/chat-normalize.js'
import {
  collectWorkerInnerDisplayTools,
  collectWorkerSearchTools,
  isWorkerParentTool,
  tagWorkerDisplayExpand,
} from '../worker-file-tools.js'

/** filter id 与 tool_call_id 的等价别名（worker :search:N、subagent 冒号后缀等） */
export function toolFilterIdAliases(id: string): string[] {
  const want = String(id || '').trim()
  if (!want) return []
  const out = new Set<string>([want])
  out.add(want.replace(/:search:\d+$/, ''))
  out.add(want.replace(/:post-search-read:.*$/, ''))
  const colon = want.indexOf(':')
  if (colon > 0) out.add(want.slice(0, colon))
  const nested = want.match(/^(.+):[^:]+:\d+$/)
  if (nested?.[1]) out.add(nested[1])
  return [...out]
}

export function toolIdsMatchFilter(filterId: string, toolId: string): boolean {
  const a = String(filterId || '').trim()
  const b = String(toolId || '').trim()
  if (!a || !b) return false
  if (a === b) return true
  for (const alias of toolFilterIdAliases(a)) {
    if (alias === b || b.startsWith(`${alias}:`)) return true
  }
  for (const alias of toolFilterIdAliases(b)) {
    if (alias === a || a.startsWith(`${alias}:`)) return true
  }
  const aTail = a.length >= 6 ? a.slice(-8) : a
  const bTail = b.length >= 6 ? b.slice(-8) : b
  return Boolean(aTail && bTail && aTail === bTail)
}

function toolRowIds(tool: unknown): string[] {
  const t = tool as Record<string, unknown>
  const rid = t.id != null && String(t.id).trim() !== '' ? String(t.id).trim() : ''
  const rtc =
    t.tool_call_id != null && String(t.tool_call_id).trim() !== ''
      ? String(t.tool_call_id).trim()
      : ''
  return [rid, rtc].filter(Boolean)
}

export function registerToolInFilterMap(map: Map<string, unknown>, tool: unknown): void {
  for (const id of toolRowIds(tool)) {
    map.set(id, tool)
    for (const alias of toolFilterIdAliases(id)) {
      if (!map.has(alias)) map.set(alias, tool)
    }
    const colon = id.indexOf(':')
    if (colon > 0) {
      const prefix = id.slice(0, colon)
      if (prefix && !map.has(prefix)) map.set(prefix, tool)
    }
  }
}

/** 为 filter 解析注入 worker 派生的 synthetic search 行 */
export function expandToolsForFilterResolution(tools: unknown[]): unknown[] {
  const out: unknown[] = [...(tools || [])]
  const seen = new Set<string>()
  for (const raw of tools || []) {
    for (const id of toolRowIds(raw)) seen.add(id)
  }
  const push = (tool: unknown) => {
    const ids = toolRowIds(tool)
    if (!ids.length || ids.some((id) => seen.has(id))) return
    for (const id of ids) seen.add(id)
    out.push(tagWorkerDisplayExpand(tool))
  }
  for (const raw of tools || []) {
    if (!isWorkerParentTool(raw)) continue
    for (const synth of collectWorkerSearchTools(raw as Record<string, unknown>, tools)) {
      push(synth)
    }
    for (const inner of collectWorkerInnerDisplayTools(raw as Record<string, unknown>, tools)) {
      push(inner)
    }
  }
  return out
}

export function resolveToolByFilterId(
  tools: unknown[],
  filterId: string,
  map?: Map<string, unknown>,
): unknown | undefined {
  const want = String(filterId || '').trim()
  if (!want) return undefined

  const lookup = map ?? buildToolFilterMap(tools)
  for (const alias of toolFilterIdAliases(want)) {
    const hit = lookup.get(alias)
    if (hit) return hit
  }

  const direct = findToolRowByCallId(tools, want)
  if (direct) return direct

  for (const alias of toolFilterIdAliases(want)) {
    const hit = findToolRowByCallId(tools, alias)
    if (hit) return hit
  }

  const searchParent = want.replace(/:search:\d+$/, '')
  if (searchParent !== want) {
    const parent = findToolRowByCallId(tools, searchParent)
    if (parent && isWorkerParentTool(parent)) {
      for (const synth of collectWorkerSearchTools(parent as Record<string, unknown>, tools)) {
        for (const id of toolRowIds(synth)) {
          if (toolIdsMatchFilter(want, id)) return synth
        }
      }
    }
  }

  const wantTail = want.length >= 6 ? want.slice(-8) : want
  for (const [key, tool] of lookup.entries()) {
    const keyTail = key.length >= 6 ? key.slice(-8) : key
    if (wantTail && keyTail && wantTail === keyTail) return tool
    if (key.endsWith(want) || want.endsWith(key)) return tool
  }

  return undefined
}

export function buildToolFilterMap(tools: unknown[]): Map<string, unknown> {
  const expanded = expandToolsForFilterResolution(tools)
  const map = new Map<string, unknown>()
  for (const tool of expanded) registerToolInFilterMap(map, tool)
  return map
}

export function filterIdMatchedInList(filterId: string, list: unknown[]): boolean {
  const want = String(filterId || '').trim()
  if (!want) return false
  for (const tool of list) {
    for (const id of toolRowIds(tool)) {
      if (toolIdsMatchFilter(want, id)) return true
    }
  }
  return false
}
