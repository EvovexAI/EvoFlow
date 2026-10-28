/**
 * Bound-buffer helper: push an item, drop the oldest beyond `max`.
 * Returns how many items were dropped. See tests/bounded-buffer.test.js.
 */
export function pushBounded(buf, item, max) {
  buf.push(item)
  if (!Number.isFinite(max) || max <= 0 || buf.length <= max) return 0
  const drop = buf.length - max
  buf.splice(0, drop)
  return drop
}
