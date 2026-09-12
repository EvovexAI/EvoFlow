/**
 * 子任务卡片跑马灯：优先自然语言，弱化工具 JSON 块。
 */

/**
 * @param {string} full
 * @returns {string}
 */
export function latestLiveSegmentForTicker(full) {
  const t = String(full || '').trim()
  if (!t) return ''
  const sep = '\n\n───\n\n'
  if (!t.includes(sep)) return t
  const parts = t.split(sep)
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = String(parts[i] || '').trim()
    if (!seg) continue
    if (seg === '【完成】') continue
    if (seg.startsWith('【完成】\n')) {
      const body = seg.replace(/^【完成】\n+/, '').trim()
      if (body) return body
      continue
    }
    return seg
  }
  return t
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function isToolJsonNoiseLine(line) {
  const s = String(line || '').trim()
  if (!s) return true
  if (/^\s*\{/.test(s) && (s.includes('"ok"') || s.includes('"action"'))) return true
  if (s.startsWith('工具：') && s.length < 120 && !/[\u4e00-\u9fff]{4,}/.test(s)) return true
  if (s.startsWith('Checklist item') && s.includes('not found')) return true
  return false
}

/**
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeSubtaskLiveTicker(raw) {
  const t = String(raw || '').trim()
  if (!t) return ''
  const lines = t.split(/\n+/).map((l) => l.trim()).filter(Boolean)
  const prose = lines.filter((l) => !isToolJsonNoiseLine(l))
  if (prose.length) {
    const last = prose[prose.length - 1]
    return last.length > 600 ? `${last.slice(0, 600)}…` : last
  }
  const segmented = latestLiveSegmentForTicker(t)
  if (segmented && !isToolJsonNoiseLine(segmented)) {
    return segmented.length > 600 ? `${segmented.slice(0, 600)}…` : segmented
  }
  return ''
}
