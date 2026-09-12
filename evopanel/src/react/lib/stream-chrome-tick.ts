/** Chrome/composer/sidebar tick: bumps without re-rendering the full ChatApp tree. */

let tick = 0
const listeners = new Set<() => void>()

export function subscribeStreamChromeTick(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange)
  return () => {
    listeners.delete(onStoreChange)
  }
}

export function getStreamChromeTick(): number {
  return tick
}

export function bumpStreamChromeTick(): void {
  tick += 1
  for (const cb of listeners) cb()
}

export function resetStreamChromeTick(): void {
  tick = 0
  for (const cb of listeners) cb()
}
