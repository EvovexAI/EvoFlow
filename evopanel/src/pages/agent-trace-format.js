/** 调试页：耗时统一为秒（如 1.23s） */

const EM_DASH = '—'

/**
 * @param {unknown} ms 毫秒
 * @returns {string}
 */
export function formatDurationSec(ms) {
  if (ms == null || ms === '') return EM_DASH
  const n = Number(ms)
  if (!Number.isFinite(n)) return String(ms)
  return `${(n / 1000).toFixed(2)}s`
}
