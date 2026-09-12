import { useSyncExternalStore } from 'react'
import {
  getChatSurfaceVisible,
  subscribeChatSurfaceVisible,
} from '../lib/client-perf.js'

/** True when `#/chat` host is visible (router toggles via setChatSurfaceVisible). */
export function useChatSurfaceVisible(): boolean {
  return useSyncExternalStore(subscribeChatSurfaceVisible, getChatSurfaceVisible, () => true)
}
