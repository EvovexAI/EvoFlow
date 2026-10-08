/**
 * ZCode v4 风格的 useConversationProjection hook。
 *
 * ZCode 源码：
 *   ``ZCode/packages/ui/src/v4/useConversationProjection.ts`` (29 行)
 *
 * EvoFlow 适配 — 增加 ``signal`` for cleanup；``initialState`` 用于 SSR/test。
 */

import { useSyncExternalStore } from 'react'
import type { ConversationProjectionStore, ProjectionState } from './conversationProjectionStore'

const CLOSED_STATE: ProjectionState = {
  status: 'closed',
  snapshot: null,
  lastError: null,
  subscriptionId: null,
  optimisticCommands: [],
  recoveryDeadline: null,
}

export function useConversationProjection(
  store: ConversationProjectionStore | null | undefined,
): ProjectionState {
  return useSyncExternalStore(
    (listener) => store?.subscribe(listener) ?? (() => {}),
    () => store?.getState() ?? CLOSED_STATE,
    () => CLOSED_STATE,
  )
}