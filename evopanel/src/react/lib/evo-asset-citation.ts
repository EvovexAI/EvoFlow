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

/**
 * Normalize a citation path for Asset Center deep-links.
 * Models often emit markdown list markers (``- memory/…``) which must not become the path.
 */
export function normalizeAssetCitationPath(path: string): string {
  let p = String(path || '')
    .replace(/\\/g, '/')
    .trim()
  // Strip markdown list / ordered-list prefixes the model may glue onto the path.
  p = p.replace(/^[-*+]\s+/, '')
  p = p.replace(/^\d+[.)]\s+/, '')
  return p.replace(/^\//, '').trim()
}

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
  // Normalize before RE so ``- memory/foo.md | note=[…]`` still matches.
  let cleaned = normalizeAssetCitationPath(line)
  // Models sometimes write ``path.md — prose note`` instead of ``| note=[…]``.
  let proseNote = ''
  if (!/\|\s*note\s*=/i.test(cleaned)) {
    const prose = cleaned.match(/^(.*?\.md(?::\d+-\d+)?)\s+[—–-]\s+(.+)$/u)
    if (prose) {
      cleaned = prose[1]!.trim()
      proseNote = prose[2]!.trim()
    }
  }
  const em = cleaned.match(ENTRY_LINE_RE)
  if (!em?.groups?.path) return null
  const path = normalizeAssetCitationPath(em.groups.path)
  if (!path) return null
  return {
    path,
    lineStart: em.groups.start ? Number(em.groups.start) : null,
    lineEnd: em.groups.end ? Number(em.groups.end) : null,
    note: String(em.groups.note || proseNote || '').trim(),
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
  const p = normalizeAssetCitationPath(path)
  if (!p) return false
  if (/^kb_[a-z0-9]+$/i.test(p)) return false
  if (/^[a-z]+_[a-f0-9]{16,}$/i.test(p) && !p.includes('/')) return false
  return true
}

/**
 * Entity-vault relative path patterns (memory / craft / profile).
 * Used to stop Markdown from joining these onto the chat workspace root.
 */
const ENTITY_ASSET_REL_RE =
  /^(?:memory\/(?:_inbox|facts|episodic|journal)(?:\/|$)|memory\/(?:standing\.md|MEMORY\.md)$|craft\/[^/]+(?:\.md)?$|profile\/[^/]+\.md$)/i

/** Absolute / workspace-joined path → peel trailing entity-asset suffix. */
const ENTITY_ASSET_ABS_PEEL_RE =
  /\/(memory\/(?:_inbox|facts|episodic|journal)\/.+|memory\/(?:standing\.md|MEMORY\.md)|craft\/[^/]+(?:\.md)?|profile\/[^/]+\.md)$/i

/**
 * If ``raw`` is (or ends with) an entity asset vault path, return the vault-relative path.
 * Otherwise null — treat as a normal workspace file link.
 */
export function extractEntityAssetRelPath(raw: string): string | null {
  const p = normalizeAssetCitationPath(raw).replace(/\\/g, '/')
  if (!p) return null
  if (ENTITY_ASSET_REL_RE.test(p)) return p
  // Broader relative: memory/… craft/… profile/… (agents often omit the subtype folder)
  if (/^(memory|craft|profile)\/.+\.[a-z0-9]{1,12}$/i.test(p)) return p
  const peeled = p.match(ENTITY_ASSET_ABS_PEEL_RE)
  if (peeled?.[1]) return peeled[1]
  // Absolute with any memory|craft|profile segment after a drive/root
  const loose = p.match(/\/((?:memory|craft|profile)\/.+)$/i)
  if (loose?.[1] && /\.[a-z0-9]{1,12}$/i.test(loose[1])) return loose[1]
  return null
}

/** Deep-link into Asset Center for a relative asset path. */
export function assetsHrefForPath(
  path: string,
  opts?: { entityType?: string; entityId?: string },
): string {
  const rel = normalizeAssetCitationPath(path)
  const params = new URLSearchParams()
  // Tab ids must match Asset Center IA (``experience`` owns craft/, not ``craft``).
  if (rel.startsWith('craft/')) params.set('tab', 'experience')
  else if (rel.startsWith('memory/journal/')) params.set('tab', 'journal')
  else if (rel === 'profile/affect.md' || rel.endsWith('/affect.md')) params.set('tab', 'affect')
  else if (rel.startsWith('profile/')) params.set('tab', 'profile')
  else params.set('tab', 'memory')
  if (rel.startsWith('memory/episodic/')) params.set('memoryKind', 'episodic')
  else if (rel.startsWith('memory/facts/') || rel === 'memory/MEMORY.md') params.set('memoryKind', 'facts')
  else if (/(^|\/)standing(\.md)?$/i.test(rel) || rel.includes('/standing.'))
    params.set('memoryKind', 'standing')
  // memory/_inbox/… and other non-kind roots: omit memoryKind so the center can open the parent dir.
  if (opts?.entityType) params.set('entityType', opts.entityType)
  if (opts?.entityId) params.set('entityId', opts.entityId)
  if (rel) params.set('path', rel)
  return `#/assets?${params.toString()}`
}
