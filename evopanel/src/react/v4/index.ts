/**
 * EvoFlow v4 entry. **H2.5: verbatim re-export of the ZCode v4 protocol**.
 *
 *  - protocol/zcode-protocol-v4: snapshot/deltas/rows/apply pure functions
 *  - conversationProjectionStore: verbatim-equivalent store + status machine
 *  - useConversationProjection: React hook via useSyncExternalStore
 *  - sessionDataLayer: per-session acquire/release + keep-warm (ZCode 风格)
 *  - transport/transport: ConversationTransport interface
 *  - transport/evoflowTransport: EvoFlowV4Transport 适配 H1 demo backend
 *
 * H2.5 之后下一步：把 SessionPane.tsx + Timeline/RowView 组件树 (ZCode 4K 行) 复制过来。
 */

export * from './protocol/types'

export {
  ConversationProjectionStore,
  PROTOCOL_V4_RECOVERY_DELAYS_MS,
  type ProjectionSnapshot,
  type ProjectionState,
  type ProjectionStatus,
} from './conversationProjectionStore'

export { useConversationProjection } from './useConversationProjection'

export {
  SessionDataLayer,
  type SessionDataLayerOptions,
  type SessionLease,
} from './sessionDataLayer'

export type {
  CommandAck,
  CommandEnvelope,
  ConversationTransport,
  SubscribeParams,
  V4ConversationSubscribeResult,
} from './transport/transport'

export { EvoFlowV4Transport, evoflowV4Transport } from './transport/evoflowTransport'

export { EvoFlowV4SessionPane, type EvoFlowV4SessionPaneProps } from './EvoFlowV4SessionPane'
