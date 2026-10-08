/**
 * EvoFlow v4 SessionPane — **minimal 适配**（不是 verbatim copy）。
 *
 * 与 ZCode 的 ``SessionPane.tsx`` (4723 行) 区别：
 *  - 复用 verbatim zcode-protocol-v4 类型与 apply；
 *  - 复用 EvoFlowV4Transport (H1 demo SSE backend)；
 *  - UI 渲染：v4_demo 的 MiniSessionPane (H1 样式) — H2.5 不复制 ZCode UI 样式系统。
 *
 * 完整 ``SessionPane`` 复刻留到 H3 后端 SSE 重写完成 + EvoFlow 样式可承载。
 */
import { useEffect, useRef, useState } from 'react'
import {
  ConversationProjectionStore,
  EvoFlowV4Transport,
  useConversationProjection,
  type V4ConversationSubscribeResult,
} from './index'

export interface EvoFlowV4SessionPaneProps {
  sessionId?: string
  transport?: EvoFlowV4Transport
}

export function EvoFlowV4SessionPane({
  sessionId: providedId,
  transport = new EvoFlowV4Transport(),
}: EvoFlowV4SessionPaneProps): JSX.Element {
  const [store] = useState(() => new ConversationProjectionStore({ topic: providedId ?? 'default' }))
  const [subscription, setSubscription] = useState<V4ConversationSubscribeResult | null>(null)
  const state = useConversationProjection(store)
  const sessionIdRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async (): Promise<void> => {
      const ack = await transport.subscribe({})
      if (cancelled) return
      sessionIdRef.current = ack.initial.sessionId
      setSubscription(ack)
      store.ackSubscribe(ack.subscriptionId, ack.logEpoch, ack.mode)
      store.applySnapshotFrame({
        subscriptionId: ack.subscriptionId,
        logEpoch: ack.logEpoch,
        fromSeq: ack.initial.seq,
        toSeq: ack.initial.seq,
        payload: ack.initial,
      })
      const unsub = transport.onFrame((frame) => store.handleFrame(frame))
      return () => {
        unsub()
        void transport.unsubscribe(ack.subscriptionId)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [store, transport])

  // 极简渲染: 仅 v4 rows 文本
  const rows = state.snapshot?.rows ?? []
  return (
    <div className="evoflow-v4-session-pane" data-status={state.status}>
      <div className="evoflow-v4-status">
        status={state.status} · seq={state.snapshot?.seq ?? 0} · rows={rows.length}
        {state.lastError ? ` · error=${state.lastError}` : ''}
      </div>
      <div className="evoflow-v4-rows">
        {rows.map((row) => (
          <div key={row.rowId} className={`evoflow-v4-row kind-${row.kind}`}>
            <span className="rid">#{row.rowId}</span>{' '}
            <span className="kind">{row.kind}</span>
            {' · '}
            {row.kind === 'userInput' && <span>{row.text}</span>}
            {row.kind === 'assistantText' && <span>{row.text}</span>}
            {row.kind === 'reasoning' && <span>{row.text}</span>}
            {row.kind === 'turnHeader' && <span>state={row.state}</span>}
            {row.kind === 'toolCall' && <span>{row.toolName} ({row.status})</span>}
          </div>
        ))}
      </div>
      {subscription && (
        <input
          className="evoflow-v4-input"
          placeholder="H2.5 placeholder — wire to Composer later"
          onKeyDown={async (e) => {
            if (e.key !== 'Enter') return
            const text = (e.target as HTMLInputElement).value.trim()
            if (!text) return
            await transport.sendCommand({
              commandId: `c-${Date.now()}`,
              type: 'sendText',
              sessionId: subscription.initial.sessionId,
              payload: { text },
            } as unknown as Parameters<typeof transport.sendCommand>[0])
            ;(e.target as HTMLInputElement).value = ''
          }}
        />
      )}
    </div>
  )
}