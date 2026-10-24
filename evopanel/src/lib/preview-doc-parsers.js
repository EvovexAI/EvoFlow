/**
 * 预览用的纯解析工具（CSV / TSV、JSON 格式化、Mermaid 源码清洗）。
 * 不依赖 React / DOM，便于单测。
 */

/**
 * 按首行出现的分隔符猜 CSV 分隔符（.tsv 直接给 tab）。
 * @param {string} text
 * @param {string} [extHint] 扩展名（csv / tsv）
 * @returns {string}
 */
export function detectCsvDelimiter(text, extHint = '') {
  if (String(extHint || '').toLowerCase() === 'tsv') return '\t'
  const firstLine = String(text || '').split(/\r?\n/, 1)[0] || ''
  const counts = [
    [',', (firstLine.match(/,/g) || []).length],
    ['\t', (firstLine.match(/\t/g) || []).length],
    [';', (firstLine.match(/;/g) || []).length],
    ['|', (firstLine.match(/\|/g) || []).length],
  ]
  counts.sort((a, b) => b[1] - a[1])
  return counts[0][1] > 0 ? String(counts[0][0]) : ','
}

/**
 * 解析 CSV / TSV 为二维数组（RFC 4180 风格：支持引号包裹、"" 转义、字段内换行）。
 * 不做类型推断，一律返回字符串。
 * @param {string} text
 * @param {{ delimiter?: string }} [opts]
 * @returns {string[][]}
 */
export function parseCsvRows(text, { delimiter = ',' } = {}) {
  const src = String(text || '')
  if (!src.trim()) return []
  const sep = String(delimiter || ',')
  /** @type {string[][]} */
  const rows = []
  /** @type {string[]} */
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"' && field === '') {
      inQuotes = true
      continue
    }
    if (ch === sep) {
      row.push(field)
      field = ''
      continue
    }
    if (ch === '\r') {
      // 交给 \n 统一处理，避免 CRLF 产生空行
      if (src[i + 1] === '\n') continue
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      continue
    }
    if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      continue
    }
    field += ch
  }
  row.push(field)
  rows.push(row)
  // 去掉完全空白的尾行
  return rows.filter((r) => r.length > 1 || String(r[0] || '').trim() !== '')
}

/**
 * 表格预览会截断超大 CSV，返回值说明被截断的行数。
 * @param {string[][]} rows
 * @param {{ maxRows?: number; maxCols?: number }} [opts]
 */
export function clipTable(rows, { maxRows = 500, maxCols = 60 } = {}) {
  const list = Array.isArray(rows) ? rows : []
  const head = list[0] || []
  const colCount = Math.min(
    Math.max(...list.map((r) => r.length), head.length, 0),
    maxCols,
  )
  const clippedRows = list.slice(0, maxRows).map((r) => {
    const out = r.slice(0, colCount)
    while (out.length < colCount) out.push('')
    return out
  })
  return {
    rows: clippedRows,
    columns: colCount,
    truncatedRows: Math.max(0, list.length - maxRows),
    truncatedCols: Math.max(0, Math.max(...list.map((r) => r.length), head.length, 0) - maxCols),
  }
}

/**
 * JSON 文本 → 格式化文本。解析失败时返回 ok=false（调用方回退到源码视图）。
 * @param {string} text
 * @returns {{ ok: boolean; text: string; error?: string }}
 */
export function formatJsonPreview(text) {
  const raw = String(text || '')
  if (!raw.trim()) return { ok: false, text: raw, error: '空文件' }
  try {
    const value = JSON.parse(raw)
    return { ok: true, text: JSON.stringify(value, null, 2) }
  } catch (e) {
    return { ok: false, text: raw, error: String((e && e.message) || e || 'JSON 解析失败') }
  }
}

/** Mermaid 源码可能是 ```mermaid 围栏形式，剥掉围栏后再交给渲染器。 */
export function stripMermaidFence(text) {
  const raw = String(text || '')
  const m = raw.match(/^\s*```(?:mermaid|mmd)?\s*\n([\s\S]*?)\n?```\s*$/)
  return m ? m[1] : raw
}

/** Mermaid 渲染用：套一层 markdown 代码围栏，复用既有 mermaid 插件。 */
export function toMermaidMarkdown(text) {
  const body = stripMermaidFence(text).trim()
  if (!body) return ''
  return ['```mermaid', body, '```'].join('\n')
}
