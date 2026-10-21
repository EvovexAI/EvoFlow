/**
 * Config reload policy: soft (in-process cache refresh) vs hard (sidecar kill+spawn).
 * Hard keys are those that bind listen port / storage engine — process restart required.
 */

/** Dot-path prefixes that require process restart after write_evoflow_config. */
export const HARD_RELOAD_KEY_PREFIXES = Object.freeze([
  'gateway.port',
  'gateway.mode',
  'gateway.bind',
  'gateway.host',
  'checkpointer',
  'storage',
])

/**
 * @param {unknown} value
 * @param {string} [prefix]
 * @returns {string[]}
 */
export function flattenConfigPaths(value, prefix = '') {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : []
  }
  const out = []
  for (const [k, v] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (v != null && typeof v === 'object' && !Array.isArray(v)) {
      const nested = flattenConfigPaths(v, path)
      if (nested.length) out.push(...nested)
      else out.push(path)
    } else {
      out.push(path)
    }
  }
  return out
}

/**
 * @param {unknown} prev
 * @param {unknown} next
 * @returns {{ hard: boolean, changedHardKeys: string[], changedPaths: string[] }}
 */
export function classifyConfigReload(prev, next) {
  const prevPaths = new Set(flattenConfigPaths(prev))
  const nextPaths = flattenConfigPaths(next)
  const changed = []
  const allKeys = new Set([...prevPaths, ...nextPaths])
  for (const path of allKeys) {
    const a = _atPath(prev, path)
    const b = _atPath(next, path)
    if (!_deepEqual(a, b)) changed.push(path)
  }
  const changedHardKeys = changed.filter((path) =>
    HARD_RELOAD_KEY_PREFIXES.some((p) => path === p || path.startsWith(`${p}.`)),
  )
  return {
    hard: changedHardKeys.length > 0,
    changedHardKeys,
    changedPaths: changed,
  }
}

function _atPath(obj, path) {
  if (obj == null) return undefined
  const parts = String(path).split('.')
  let cur = obj
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[p]
  }
  return cur
}

function _deepEqual(a, b) {
  if (a === b) return true
  if (a == null || b == null) return a === b
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return a === b
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}
