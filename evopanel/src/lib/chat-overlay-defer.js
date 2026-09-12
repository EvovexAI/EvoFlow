/** Track overlays / side panels that should defer live stream UI bumps. */

/** @type {Set<string>} */
const _active = new Set()

/**
 * @param {string} key
 * @param {boolean} active
 */
export function setChatOverlayDefer(key, active) {
  const k = String(key || '').trim()
  if (!k) return
  if (active) _active.add(k)
  else _active.delete(k)
}

export function isChatOverlayDeferActive() {
  return _active.size > 0
}

export function clearChatOverlayDefer(key) {
  setChatOverlayDefer(key, false)
}
