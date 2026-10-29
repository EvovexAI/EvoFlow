/**
 * Boot polyfills — must be the first static import from main.js so they run
 * before any business chunk evaluates.
 *
 * COMPAT(macOS12-JSC): Safari < 16.4 / macOS 12 WKWebView cannot parse
 * lookbehind assertions. esbuild does not transpile regexes, so
 * `new RegExp("(?<=...)")` (and some deps) throw at runtime. When unsupported,
 * wrap global RegExp: strip outer lookbehinds to non-capturing groups, or
 * degrade to never-matching `(?!)` when stripping would shift backrefs.
 *
 * Regex *literals* with lookbehind still fail at parse time — those must be
 * rewritten in first-party code or patched in dependencies (see issue #95).
 */

;(function installMacOs12SafeRegExp() {
  const NativeRegExp = globalThis.RegExp
  try {
    // Feature probe used by issue #95 / Safari < 16.4 JSC.
    new NativeRegExp('(?<=a)b')
    return
  } catch {
    // continue — install SafeRegExp
  }

  /**
   * @param {string} pattern
   * @param {number} openIndex index of '('
   */
  function findMatchingParen(pattern, openIndex) {
    let depth = 0
    let inClass = false
    for (let i = openIndex; i < pattern.length; i += 1) {
      const ch = pattern[i]
      if (ch === '\\' && i + 1 < pattern.length) {
        i += 1
        continue
      }
      if (ch === '[' && !inClass) {
        inClass = true
        continue
      }
      if (ch === ']' && inClass) {
        inClass = false
        continue
      }
      if (inClass) continue
      if (ch === '(') depth += 1
      else if (ch === ')') {
        depth -= 1
        if (depth === 0) return i
      }
    }
    return -1
  }

  /** @param {string} pattern @param {number} i */
  function isNonCapturingOpen(pattern, i) {
    if (pattern[i + 1] !== '?') return false
    const c2 = pattern[i + 2]
    return c2 === ':' || c2 === '=' || c2 === '!' || c2 === '<'
  }

  /** @param {string} inner */
  function hasCapturingGroup(inner) {
    let inClass = false
    for (let i = 0; i < inner.length; i += 1) {
      const ch = inner[i]
      if (ch === '\\' && i + 1 < inner.length) {
        i += 1
        continue
      }
      if (ch === '[' && !inClass) {
        inClass = true
        continue
      }
      if (ch === ']' && inClass) {
        inClass = false
        continue
      }
      if (inClass) continue
      if (ch === '(' && !isNonCapturingOpen(inner, i)) return true
    }
    return false
  }

  /**
   * @param {string} pattern
   * @returns {string | null} stripped pattern, or null if unsafe to strip
   */
  function stripLookbehinds(pattern) {
    let out = ''
    let i = 0
    let inClass = false

    while (i < pattern.length) {
      const ch = pattern[i]

      if (ch === '\\' && i + 1 < pattern.length) {
        out += pattern.slice(i, i + 2)
        i += 2
        continue
      }

      if (ch === '[' && !inClass) {
        inClass = true
        out += ch
        i += 1
        continue
      }
      if (ch === ']' && inClass) {
        inClass = false
        out += ch
        i += 1
        continue
      }

      if (!inClass && ch === '(' && pattern.startsWith('(?<=', i)) {
        const closed = findMatchingParen(pattern, i)
        if (closed < 0) return null
        const inner = pattern.slice(i + 4, closed)
        if (hasCapturingGroup(inner)) return null
        out += `(?:${inner})`
        i = closed + 1
        continue
      }
      if (!inClass && ch === '(' && pattern.startsWith('(?<!', i)) {
        const closed = findMatchingParen(pattern, i)
        if (closed < 0) return null
        const inner = pattern.slice(i + 4, closed)
        if (hasCapturingGroup(inner)) return null
        out += `(?:${inner})`
        i = closed + 1
        continue
      }

      out += ch
      i += 1
    }

    return out
  }

  /**
   * @param {string | RegExp} pattern
   * @param {string} [flags]
   */
  function SafeRegExp(pattern, flags) {
    if (pattern instanceof NativeRegExp) {
      return flags === undefined
        ? new NativeRegExp(pattern)
        : new NativeRegExp(pattern, flags)
    }
    if (typeof pattern !== 'string') {
      return flags === undefined
        ? new NativeRegExp(pattern)
        : new NativeRegExp(pattern, flags)
    }
    if (!/\(\?<[=!]/.test(pattern)) {
      return flags === undefined
        ? new NativeRegExp(pattern)
        : new NativeRegExp(pattern, flags)
    }
    const stripped = stripLookbehinds(pattern)
    const safe = stripped == null ? '(?!)' : stripped
    try {
      return flags === undefined
        ? new NativeRegExp(safe)
        : new NativeRegExp(safe, flags)
    } catch {
      return flags === undefined
        ? new NativeRegExp('(?!)')
        : new NativeRegExp('(?!)', flags)
    }
  }

  SafeRegExp.prototype = NativeRegExp.prototype
  Object.defineProperty(SafeRegExp, 'name', { value: 'RegExp' })
  Object.setPrototypeOf(SafeRegExp, NativeRegExp)
  SafeRegExp[Symbol.hasInstance] = (value) => value instanceof NativeRegExp
  for (const key of Reflect.ownKeys(NativeRegExp)) {
    if (key === 'prototype' || key === 'name' || key === 'length' || key === Symbol.hasInstance) {
      continue
    }
    try {
      const desc = Object.getOwnPropertyDescriptor(NativeRegExp, key)
      if (desc) Object.defineProperty(SafeRegExp, key, desc)
    } catch {
      // ignore non-configurable
    }
  }

  globalThis.RegExp = SafeRegExp
})()
