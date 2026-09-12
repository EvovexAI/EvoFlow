/**
 * Debug toggle utility — tag-based debug logging that can be turned on/off
 * without removing console.log calls.
 *
 * Usage:
 *   import { dbg } from '@/lib/debug-toggle'
 *   dbg('clarify', 'detectAndSchedule called', { targetSk, ... })
 *
 * Enable tags at runtime:
 *   localStorage.setItem('debug-tags', 'clarify,plan,stream')
 *   // or via URL: ?debug=clarify,plan
 *
 * Disable all: clear localStorage or set ?debug=
 */

const _TAGS = new Set<string>()

function _loadTags(): void {
  try {
    const url = new URL(window.location.href)
    const urlTags = url.searchParams.get('debug')
    if (urlTags !== null) {
      _TAGS.clear()
      for (const t of urlTags.split(',').map((s) => s.trim()).filter(Boolean)) _TAGS.add(t)
      return
    }
    const stored = localStorage.getItem('debug-tags')
    if (stored !== null) {
      _TAGS.clear()
      for (const t of stored.split(',').map((s) => s.trim()).filter(Boolean)) _TAGS.add(t)
    }
  } catch {
    /* SSR or no window */
  }
}

// Auto-load on module import
if (typeof window !== 'undefined') {
  _loadTags()
  // Reload when other tabs change localStorage
  window.addEventListener('storage', (e) => {
    if (e.key === 'debug-tags') _loadTags()
  })
}

/** Check if a debug tag is enabled */
export function isDebugEnabled(tag: string): boolean {
  return _TAGS.has(tag) || _TAGS.has('*')
}

/** Tag-based debug logger — no-op unless the tag is enabled */
export function dbg(tag: string, ...args: unknown[]): void {
  if (isDebugEnabled(tag)) {
    console.log(`[${tag}]`, ...args)
  }
}

/** Enable a debug tag at runtime */
export function enableDebug(tag: string): void {
  _TAGS.add(tag)
  try {
    localStorage.setItem('debug-tags', Array.from(_TAGS).join(','))
  } catch {
    /* ignore */
  }
}

/** Disable a debug tag at runtime */
export function disableDebug(tag: string): void {
  _TAGS.delete(tag)
  try {
    localStorage.setItem('debug-tags', Array.from(_TAGS).join(','))
  } catch {
    /* ignore */
  }
}

/** List all currently enabled debug tags */
export function listDebugTags(): string[] {
  return Array.from(_TAGS)
}
