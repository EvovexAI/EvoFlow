/**
 * EvoFlowV4Transport — 适配 ``H1V4Client`` 到 ``ConversationTransport`` interface。
 *
 * - subscribe: POST /api/v4/demo/new_session + GET /api/v4/demo/snapshot/{sid}
 * - onFrame:  后台起一个 SSE consumer; 每帧通过 listener 推出去
 * - sendCommand: POST /api/v4/demo/send_text
 *
 * H2.5 会接 WebSocket 替代 SSE consumer；H1 demo 维持 HTTP+SSE。
 */

import { h1V4Client } from '../../v4_demo/client'
import type {
  CommandAck,
  CommandEnvelope,
  ConversationTransport,
  SubscribeParams,
  V4ConversationSubscribeResult,
} from './transport'
import type { ConversationTopicFrame } from '../protocol/types'

export interface EvoFlowV4TransportOptions {
  /** Optional override for client (eg. unit test). */
  client?: typeof h1V4Client
}

export class EvoFlowV4Transport implements ConversationTransport {
  private readonly client: typeof h1V4Client
  private readonly listeners = new Set<(frame: ConversationTopicFrame) => void>
  private readonly activeStreams = new Map<string, AbortController>()

  constructor(opts: EvoFlowV4TransportOptions = {}) {
    this.client = opts.client ?? h1V4Client
  }

  async subscribe(params: SubscribeParams): Promise<V4ConversationSubscribeResult> {
    const handle = await this.client.newSession()
    // 立即拿 snapshot 作为 initial frame
    const snap = await this.client.snapshot(handle.sessionId)
    // 后台启动 SSE consumer
    const ac = new AbortController()
    this.activeStreams.set(handle.subscriptionId, ac)
    void this._consumeStream(handle.sessionId, handle.subscriptionId, ac.signal)

    // ZCode 风格 `initial` 字段：第一帧就是 snapshot
    return {
      subscriptionId: handle.subscriptionId,
      logEpoch: snap.logEpoch,
      mode: params.baseSeq != null ? 'resume' : 'snapshot',
      initial: snap,
    }
  }

  activate(_subscriptionId: string): void {
    // H1 demo: 已在 subscribe 内激活。ZCode 大版本下 transition to active 用于按序释放
    // ACK 前的 notification; 这里 no-op.
  }

  async unsubscribe(subscriptionId: string): Promise<void> {
    const ac = this.activeStreams.get(subscriptionId)
    if (ac) {
      ac.abort()
      this.activeStreams.delete(subscriptionId)
    }
  }

  async sendCommand(envelope: CommandEnvelope): Promise<CommandAck> {
    try {
      if (envelope.type === 'sendText') {
        const { turnId } = await this.client.sendText(
          envelope.sessionId,
          String((envelope.payload as { text: string } | undefined)?.text ?? ''),
        )
        return { commandId: envelope.commandId, accepted: true, reason: `turnId=${turnId}` }
      }
      // 其他 command 类型 (abort/fork/editUserQuery/switchSession) H1 demo 未实现
      return {
        commandId: envelope.commandId,
        accepted: false,
        reason: `command type ${envelope.type} not yet supported in H1 demo`,
      }
    } catch (err) {
      return {
        commandId: envelope.commandId,
        accepted: false,
        reason: String(err),
      }
    }
  }

  onFrame(listener: (frame: ConversationTopicFrame) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private async _consumeStream(
    sessionId: string,
    subscriptionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      for await (const frame of this.client.stream(sessionId, signal)) {
        // 过滤掉非本订阅的 frame (defensive)
        if (frame.subscriptionId !== subscriptionId) continue
        for (const l of this.listeners) {
          try {
            l(frame)
          } catch {
            // ignore listener errors
          }
        }
      }
    } catch (err) {
      if (!signal.aborted) {
        // eslint-disable-next-line no-console
        console.warn('[EvoFlowV4Transport] stream error', err)
      }
    }
  }
}

export const evoflowV4Transport = new EvoFlowV4Transport()