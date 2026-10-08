/**
 * ZCode v4 风格 ConversationTransport interface — EvoFlow 简化版。
 *
 * ZCode 完整 ``ConversationTransport`` 有 ~15 个方法（subscribe / activate / sendCommand /
 * queryCommands / rowsRange / plans / workflowRunEvents / attachmentPut / ...）；H1 demo 路由
 * 表只覆盖前 4 个；其他留在 H3。
 *
 * EvoFlowV4Transport 适配 ``H1V4Client`` 到该接口；H2.5 接 WebSocket 后整段换。
 */

import type { ConversationTopicFrame } from '../protocol/types'

export interface SubscribeParams {
  /** session id; H1 demo 用 `demo-xxx`. */
  sessionId: string
  /** Optional: 重订阅时携 base seq; 缺省全量 snapshot. */
  baseSeq?: number
}

export interface V4ConversationSubscribeResult {
  subscriptionId: string
  logEpoch: string
  mode: 'snapshot' | 'resume'
  initial: ConversationTopicFrame | null
}

export interface CommandEnvelope {
  type: 'sendText' | 'abort' | 'fork' | 'editUserQuery' | 'switchSession'
  commandId: string
  sessionId: string
  payload?: unknown
}

export interface CommandAck {
  commandId: string
  accepted: boolean
  reason?: string
}

export interface ConversationTransport {
  subscribe(params: SubscribeParams): Promise<V4ConversationSubscribeResult>
  /** Mark subscription active (在 H1 demo 里是 no-op, 后端已推送 frame 之前). */
  activate(subscriptionId: string): void
  unsubscribe(subscriptionId: string): Promise<void>
  sendCommand(envelope: CommandEnvelope): Promise<CommandAck>
  /** Frame listener (Deltas + Snapshot 流). */
  onFrame(
    listener: (frame: import('../protocol/types').ConversationTopicFrame) => void,
  ): () => void
}