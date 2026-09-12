/** Format compaction metadata on observability model rows (usage_json.compaction). */

/**
 * @param {unknown} usageObj parsed usage_json
 * @returns {Record<string, unknown> | null}
 */
export function compactionMetaFromUsage(usageObj) {
  if (!usageObj || typeof usageObj !== 'object') return null
  const c = /** @type {Record<string, unknown>} */ (usageObj).compaction
  if (!c || typeof c !== 'object') return null
  return /** @type {Record<string, unknown>} */ (c)
}

/**
 * @param {number} n
 * @returns {string}
 */
function fmtTok(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return ''
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`
  return String(Math.round(v))
}

/**
 * @param {unknown} usageObj
 * @param {string} inputTokFormatted already formatted input token cell
 * @returns {{ cellHtml: string, title: string }}
 */
export function formatModelInputTokensWithCompaction(usageObj, inputTokFormatted) {
  const meta = compactionMetaFromUsage(usageObj)
  const base = inputTokFormatted && inputTokFormatted !== '—' ? inputTokFormatted : '—'
  if (!meta || !meta.compaction_applied) {
    return { cellHtml: base, title: '' }
  }
  const before = Number(meta.compaction_before_gate_tokens)
  const after = Number(meta.compaction_after_gate_tokens)
  const saved = Number(meta.compaction_saved_gate_tokens)
  const pct = meta.compaction_saved_pct
  const passes = Array.isArray(meta.compaction_passes) ? meta.compaction_passes.join(', ') : ''
  const note = String(meta.compaction_note || '').trim()
  if (!Number.isFinite(before) || before <= 0 || !Number.isFinite(saved) || saved <= 0) {
    return { cellHtml: base, title: '' }
  }
  const beforeS = fmtTok(before)
  const savedS = fmtTok(saved)
  const title = [
    `压缩前 gate ≈ ${beforeS}`,
    `压缩后 gate ≈ ${fmtTok(after) || base}`,
    `节省 ≈ ${savedS}${pct != null ? ` (${pct}%)` : ''}`,
    passes ? `passes: ${passes}` : '',
    note ? `note: ${note}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  const delta = `<span class="el-obs-compaction-delta" title="${title.replace(/"/g, '&quot;')}">↓${savedS}</span>`
  return {
    cellHtml: `${base} ${delta}`,
    title,
  }
}

/**
 * @param {unknown} usageObj
 * @returns {string}
 */
export function formatCompressPassLabel(usageObj) {
  if (!usageObj || typeof usageObj !== 'object') return ''
  const pass = /** @type {Record<string, unknown>} */ (usageObj).compaction_pass
  return pass ? String(pass) : ''
}

/**
 * @param {number | null | undefined} cacheRead
 * @param {number | null | undefined} cacheMiss
 * @returns {{ cellHtml: string, title: string }}
 */
export function formatCacheHitTokens(cacheRead, cacheMiss) {
  const hit = Number(cacheRead)
  if (!Number.isFinite(hit) || hit <= 0) {
    return { cellHtml: '—', title: '' }
  }
  const miss = Number(cacheMiss)
  const missS = Number.isFinite(miss) && miss > 0 ? fmtTok(miss) : ''
  const title = missS ? `缓存命中 ${fmtTok(hit)} · 未命中 ${missS}` : `缓存命中 ${fmtTok(hit)}`
  return { cellHtml: `⚡${fmtTok(hit)}`, title }
}
