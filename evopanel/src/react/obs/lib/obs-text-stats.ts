/** Client-side char/token estimates for observability debug panels (fallback when DB has no stats). */

export type ContentStats = {
  chars: number
  tokens: number
}

export type ToolContentStat = ContentStats & {
  name: string
}

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/
const CHARS_PER_TOKEN = 4

function heuristicTokenCount(text: string): number {
  if (!text) return 0
  let cjkChars = 0
  let codeChars = 0
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjkChars += 1
    if ('{}[]();=<>'.includes(ch)) codeChars += 1
  }
  const otherChars = text.length - cjkChars
  let base = Math.floor(cjkChars * 1.3) + Math.floor(otherChars / CHARS_PER_TOKEN)
  if (codeChars > text.length * 0.03) {
    base = Math.floor(base * 1.15)
  }
  return Math.max(1, base)
}

export function estimateTextStats(text: string | null | undefined): ContentStats | null {
  const body = String(text || '')
  if (!body) return null
  return { chars: body.length, tokens: heuristicTokenCount(body) }
}

export function parseContentStats(value: unknown): ContentStats | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const chars = Number(row.chars)
  const tokens = Number(row.tokens)
  if (!Number.isFinite(chars) || !Number.isFinite(tokens)) return null
  return { chars: Math.round(chars), tokens: Math.round(tokens) }
}

export function parseToolContentStats(value: unknown): ToolContentStat[] {
  if (!Array.isArray(value)) return []
  const out: ToolContentStat[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const name = String(row.name || '').trim()
    const stats = parseContentStats(row)
    if (!name || !stats) continue
    out.push({ name, ...stats })
  }
  return out
}

export function wireToolBlob(tool: Record<string, unknown>): string {
  try {
    return JSON.stringify(tool)
  } catch {
    return String(tool)
  }
}

/** Estimate per-tool schema size from a vendor ``tools[]`` entry (full wire JSON). */
export function toolStatsFromWireTools(tools: unknown): ToolContentStat[] {
  if (!Array.isArray(tools)) return []
  const out: ToolContentStat[] = []
  const seen = new Set<string>()
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue
    const row = tool as Record<string, unknown>
    const fn = row.function
    let name = ''
    if (fn && typeof fn === 'object') {
      name = String((fn as { name?: unknown }).name || '').trim()
    } else {
      name = String(row.name || '').trim()
    }
    if (!name || seen.has(name)) continue
    seen.add(name)
    const blob = wireToolBlob(row)
    out.push({
      name,
      chars: blob.length,
      tokens: heuristicTokenCount(blob),
    })
  }
  return out
}

export function sumContentStats(rows: ContentStats[]): ContentStats {
  return rows.reduce(
    (acc, row) => ({ chars: acc.chars + row.chars, tokens: acc.tokens + row.tokens }),
    { chars: 0, tokens: 0 },
  )
}

export function resolveContentStats(
  stored: ContentStats | null | undefined,
  text: string | null | undefined,
): ContentStats | null {
  if (stored) return stored
  return estimateTextStats(text)
}

export function fmtContentStats(stats: ContentStats | null | undefined): string {
  if (!stats) return ''
  return `${stats.chars.toLocaleString()} 字符 · ~${stats.tokens.toLocaleString()} tok`
}

export function fmtContentStatsShort(stats: ContentStats | null | undefined): string {
  if (!stats) return ''
  return `~${stats.tokens.toLocaleString()} tok`
}
