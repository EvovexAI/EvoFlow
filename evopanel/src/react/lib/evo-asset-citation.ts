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
const ORPHAN_ENTRIES_RE =
  /<citation_entries>\s*([\s\S]*?)\s*<\/citation_entries>/gi
/** Proper entry line; tolerate spaces around ``|note=``. */
const ENTRY_LINE_RE =
  /^(?<path>[^:\s|][^:|\n]*?)(?::(?<start>\d+)-(?<end>\d+))?(?:\s*\|\s*note\s*=\s*\[(?<note>.*?)\])?\s*$/i
/** Model leak: ``citation_entries: path | note=[…]`` (no XML wrapper). */
const LOOSE_ENTRIES_LABEL_RE = /^\s*citation_entries\s*:\s*(.*)$/i

export function parseCitationEntries(blockInner: string): EvoAssetCitationEntry[] {
  const m = String(blockInner || '').match(ENTRIES_RE)
  const body = m ? m[1] : String(blockInner || '')
  const entries: EvoAssetCitationEntry[] = []
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('<')) continue
    const parsed = parseEntryLine(line)
    if (parsed) entries.push(parsed)
  }
  return entries
}

function parseEntryLine(line: string): EvoAssetCitationEntry | null {
  const em = line.match(ENTRY_LINE_RE)
  if (!em?.groups?.path) return null
  return {
    path: em.groups.path.trim(),
    lineStart: em.groups.start ? Number(em.groups.start) : null,
    lineEnd: em.groups.end ? Number(em.groups.end) : null,
    note: String(em.groups.note || '').trim(),
  }
}

function dedupeEntries(entries: EvoAssetCitationEntry[]): EvoAssetCitationEntry[] {
  const seen = new Set<string>()
  const uniq: EvoAssetCitationEntry[] = []
  for (const e of entries) {
    const key = `${e.path}|${e.note}`
    if (seen.has(key)) continue
    seen.add(key)
    uniq.push(e)
  }
  return uniq
}

/**
 * Strip model-leaked citation metadata that never got the XML wrapper.
 * Examples:
 *   citation_entries: kb_abc | note=[foo]
 *   citation_entries:
 *   memory/foo.md:1-2|note=[bar]
 */
function stripLooseCitationEntryLeaks(raw: string): {
  text: string
  entries: EvoAssetCitationEntry[]
} {
  const entries: EvoAssetCitationEntry[] = []
  const lines = String(raw || '').split(/\r?\n/)
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const label = line.match(LOOSE_ENTRIES_LABEL_RE)
    if (!label) {
      out.push(line)
      i += 1
      continue
    }
    const rest = String(label[1] || '').trim()
    if (rest) {
      const parsed = parseEntryLine(rest)
      if (parsed) entries.push(parsed)
      i += 1
      continue
    }
    // Bare ``citation_entries:`` — consume following entry-shaped lines.
    i += 1
    while (i < lines.length) {
      const next = lines[i]!.trim()
      if (!next) break
      if (next.startsWith('<')) break
      if (LOOSE_ENTRIES_LABEL_RE.test(next)) break
      const parsed = parseEntryLine(next)
      if (!parsed) break
      entries.push(parsed)
      i += 1
    }
  }
  const text = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trimEnd()
  return { text, entries }
}

export function extractEvoAssetCitations(text: string): {
  text: string
  entries: EvoAssetCitationEntry[]
} {
  const raw = String(text || '')
  const entries: EvoAssetCitationEntry[] = []

  let cleaned = raw.replace(CITATION_BLOCK_RE, (_full, inner: string) => {
    entries.push(...parseCitationEntries(inner))
    return ''
  })

  // Orphan ``<citation_entries>`` without outer ``<evo-asset-citation>``.
  cleaned = cleaned.replace(ORPHAN_ENTRIES_RE, (_full, inner: string) => {
    entries.push(...parseCitationEntries(String(inner || '')))
    return ''
  })

  cleaned = cleaned
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trimEnd()

  const loose = stripLooseCitationEntryLeaks(cleaned)
  entries.push(...loose.entries)

  return { text: loose.text, entries: dedupeEntries(entries) }
}

export function stripEvoAssetCitations(text: string): string {
  return extractEvoAssetCitations(text).text
}

/** Paths that are safe to deep-link into Asset Center (not bare kb_/vault ids). */
export function isDisplayableAssetCitationPath(path: string): boolean {
  const p = String(path || '')
    .replace(/\\/g, '/')
    .replace(/^\//, '')
    .trim()
  if (!p) return false
  if (/^kb_[a-z0-9]+$/i.test(p)) return false
  if (/^[a-z]+_[a-f0-9]{16,}$/i.test(p) && !p.includes('/')) return false
  return true
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
