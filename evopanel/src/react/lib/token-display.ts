export type ParsedTokenDisplay = {
  input: number
  output: number
  total: number
  cacheRead: number
  mode: 'io' | 'total_only'
}

/** 解析 `↑123 ↓456 · ⚡80` 或 `789 tokens` 展示串。 */
export function parseTokenDisplayString(raw: string): ParsedTokenDisplay | null {
  const s = String(raw || '').trim()
  if (!s) return null
  const io = s.match(/^↑\s*(\d+)\s*↓\s*(\d+)(?:\s*·\s*⚡\s*(\d+))?/)
  if (io) {
    const input = Number(io[1]) || 0
    const output = Number(io[2]) || 0
    const cacheRead = Number(io[3]) || 0
    return { input, output, total: input + output, cacheRead, mode: 'io' }
  }
  const totalOnly = s.match(/^(\d+)\s*tokens?$/i)
  if (totalOnly) {
    const total = Number(totalOnly[1]) || 0
    return { input: 0, output: 0, total, cacheRead: 0, mode: 'total_only' }
  }
  return null
}
