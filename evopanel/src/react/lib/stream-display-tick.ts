/** Live message-list tick: bumps without re-rendering ChatApp. */

import { noteDisplayTickBump } from './client-perf.js'

let tick = 0
const listeners = new Set<() => void>()

export function subscribeStreamDisplayTick(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange)
  return () => {
    listeners.delete(onStoreChange)
  }
}

export function getStreamDisplayTick(): number {
  return tick
}

export function bumpStreamDisplayTick(): void {
  tick += 1
  noteDisplayTickBump()
  for (const cb of listeners) cb()
}

export function resetStreamDisplayTick(): void {
  tick = 0
  for (const cb of listeners) cb()
}
