/** Parse / strip ``<evo-asset-citation>`` blocks from assistant replies. */

export type EvoAssetCitationEntry = {
  path: string
  lineStart?: number | null
  lineEnd?: number | null
  note: string
}

const CITATION_BLOCK_RE =
  /<evo-asset-citation>\s*([\s\S]*?)\s*<\/evo-asset-citation>/gi
const ENTRIES_RE = /<citation_entries>\s*([\s\S]*?)\s*<\/citation_entries>/i
const ENTRY_LINE_RE =
  /^(?<path>[^:\s][^:]*?)(?::(?<start>\d+)-(?<end>\d+))?(?:\|note=\[(?<note>.*?)\])?\s*$/

export function parseCitationEntries(blockInner: string): EvoAssetCitationEntry[] {
  const m = String(blockInner || '').match(ENTRIES_RE)
  const body = m ? m[1] : String(blockInner || '')
  const entries: EvoAssetCitationEntry[] = []
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('<')) continue
    const em = line.match(ENTRY_LINE_RE)
    if (!em?.groups?.path) continue
    entries.push({
      path: em.groups.path.trim(),
      lineStart: em.groups.start ? Number(em.groups.start) : null,
      lineEnd: em.groups.end ? Number(em.groups.end) : null,
      note: String(em.groups.note || '').trim(),
    })
  }
  return entries
}

export function extractEvoAssetCitations(text: string): {
  text: string
  entries: EvoAssetCitationEntry[]
} {
  const raw = String(text || '')
  const entries: EvoAssetCitationEntry[] = []
  const cleaned = raw
    .replace(CITATION_BLOCK_RE, (_full, inner: string) => {
      entries.push(...parseCitationEntries(inner))
      return ''
    })
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trimEnd()

  const seen = new Set<string>()
  const uniq: EvoAssetCitationEntry[] = []
  for (const e of entries) {
    const key = `${e.path}|${e.note}`
    if (seen.has(key)) continue
    seen.add(key)
    uniq.push(e)
  }
  return { text: cleaned, entries: uniq }
}

export function stripEvoAssetCitations(text: string): string {
  return extractEvoAssetCitations(text).text
}

/** Deep-link into Asset Center for a relative asset path. */
export function assetsHrefForPath(
  path: string,
  opts?: { entityType?: string; entityId?: string },
): string {
  const rel = String(path || '').replace(/\\/g, '/').replace(/^\//, '')
  const params = new URLSearchParams()
  params.set('tab', rel.startsWith('craft/') ? 'craft' : 'memory')
  if (rel.startsWith('memory/episodic/')) params.set('memoryKind', 'episodic')
  else if (rel.startsWith('memory/facts/') || rel === 'memory/MEMORY.md') params.set('memoryKind', 'facts')
  else if (rel.includes('standing')) params.set('memoryKind', 'standing')
  if (opts?.entityType) params.set('entityType', opts.entityType)
  if (opts?.entityId) params.set('entityId', opts.entityId)
  if (rel) params.set('path', rel)
  return `#/assets?${params.toString()}`
}
