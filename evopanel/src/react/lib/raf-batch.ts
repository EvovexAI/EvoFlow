/**
 * Coalesce items into one flush per animation frame (Reasonix-style).
 * Non-text / structural events should call drain() first so ordering is preserved.
 */

type Flush<T> = (batch: T[]) => void

export type RafBatchHandle<T> = {
  push: (item: T) => void
  drain: () => void
  size: () => number
  dispose: () => void
}

export function createRafBatch<T>(flush: Flush<T>): RafBatchHandle<T> {
  let buffer: T[] = []
  let scheduled: number | null = null

  const run = () => {
    scheduled = null
    const out = buffer
    buffer = []
    if (out.length > 0) flush(out)
  }

  return {
    push(item: T) {
      buffer.push(item)
      if (scheduled !== null) return
      if (typeof requestAnimationFrame !== 'undefined') {
        scheduled = requestAnimationFrame(run)
        return
      }
      // SSR / happy-dom: microtask fallback
      scheduled = 1
      Promise.resolve().then(run)
    },
    drain() {
      if (scheduled !== null) {
        if (typeof cancelAnimationFrame !== 'undefined' && scheduled !== 1) {
          cancelAnimationFrame(scheduled)
        }
        scheduled = null
      }
      run()
    },
    size() {
      return buffer.length
    },
    dispose() {
      if (scheduled !== null) {
        if (typeof cancelAnimationFrame !== 'undefined' && scheduled !== 1) {
          cancelAnimationFrame(scheduled)
        }
        scheduled = null
      }
      buffer = []
    },
  }
}
