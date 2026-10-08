/**
 * H1 demo: MiniSessionPane (v4 shell preview).
 *
 * 直接使用 v4 store + EvoFlowV4Transport，不走 SessionDataLayer（multi-pane 共享)；
 * H2.5 才会把 SessionDataLayer 接入。
 *
 * 架构:
 *  - EvoFlowV4Transport → 后端 /api/v4/demo
 *  - ConversationProjectionStore (useSyncExternalStore) → 单一原子 store
 *  - 渲染: row 列表 + composer
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ConversationProjectionStore,
  EvoFlowV4Transport,
  useConversationProjection,
} from '../v4'
import { H1CssBootstrap } from './index'

const transport = new EvoFlowV4Transport()

function RowView({ row }: { row: import('../v4').ConversationRow }) {
  if (row.kind === 'turnHeader') {
    return (
      <div className="h1-row h1-turn-header">
        <span className="h1-tag">turnHeader</span>
        <span className="h1-state">{row.state}</span>
        {row.endedAt ? (
          <span className="h1-elapsed">{row.endedAt - row.startedAt}ms</span>
        ) : null}
      </div>
    )
  }
  if (row.kind === 'userInput') {
    return (
      <div className="h1-row h1-user">
        <span className="h1-tag">user</span>
        <pre className="h1-text">{row.text}</pre>
      </div>
    )
  }
  if (row.kind === 'reasoning') {
    return (
      <div className="h1-row h1-reasoning">
        <span className="h1-tag">reasoning·{row.state}</span>
        <pre className="h1-text">{row.text || <span className="h1-empty">(空)</span>}</pre>
      </div>
    )
  }
  if (row.kind === 'assistantText') {
    return (
      <div className="h1-row h1-assistant">
        <span className="h1-tag">assistant·{row.state}</span>
        <pre className="h1-text">{row.text || <span className="h1-empty">(streaming…)</span>}</pre>
      </div>
    )
  }
  return (
    <div className="h1-row h1-tool">
      <span className="h1-tag">tool·{row.status}</span>
      <span className="h1-tool-name">{row.toolName}</span>
      <pre className="h1-text">{row.argsSummary}</pre>
      {row.resultSummary ? <pre className="h1-result">{row.resultSummary}</pre> : null}
    </div>
  )
}

export interface MiniSessionPaneProps {
  /** dev / opt-in flag: set to ``true`` to mount the demo view. */
  enabled: boolean
}

export function MiniSessionPane({ enabled }: MiniSessionPaneProps) {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [streamingError, setStreamingError] = useState<string | null>(null)

  const storeRef = useRef<ConversationProjectionStore | null>(null)
  if (!storeRef.current) storeRef.current = new ConversationProjectionStore({ topic: 'demo' })

  const state = useConversationProjection(storeRef.current)
  const offFrameRef = useRef<(() => void) | null>(null)

  const startSession = useCallback(async () => {
    setStreamingError(null)
    offFrameRef.current?.()
    offFrameRef.current = null

    // reset store
    storeRef.current = new ConversationProjectionStore({ topic: 'demo' })

    try {
      const sub = await transport.subscribe({ sessionId: 'init' })
      setSessionId(sub.subscriptionId)
      // apply initial frame (snapshot)
      if (sub.initial) {
        storeRef.current.handleFrame(sub.initial)
      }
      // register frame listener for subsequent deltas
      const off = transport.onFrame((frame) => {
        if (storeRef.current && frame.subscriptionId === sub.subscriptionId) {
          storeRef.current.handleFrame(frame)
        }
      })
      offFrameRef.current = off
    } catch (err) {
      setStreamingError(String(err))
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    void startSession()
    return () => {
      offFrameRef.current?.()
      offFrameRef.current = null
    }
  }, [enabled, startSession])

  const handleSend = useCallback(async () => {
    if (!sessionId) return
    const text = input.trim()
    if (!text) return
    setInput('')
    try {
      await transport.sendCommand({
        type: 'sendText',
        commandId: `cmd-${Date.now()}`,
        sessionId,
        payload: { text },
      })
    } catch (err) {
      setStreamingError(String(err))
    }
  }, [sessionId, input])

  const rows = useMemo(() => state.snapshot?.rows ?? [], [state.snapshot])

  if (!enabled) return null

  return (
    <>
      <H1CssBootstrap />
      <div className="h1-mini-session-pane" data-h1-status={state.status}>
        <header className="h1-header">
          <strong>H1 v4 demo</strong>
          <span className="h1-status">{state.status}</span>
          {state.snapshot ? (
            <>
              <span className="h1-seq">seq={state.snapshot.seq}</span>
              <span className="h1-rows">rows={rows.length}</span>
              <span className="h1-session">sub={state.subscriptionId ?? '-'}</span>
            </>
          ) : null}
          <button
            type="button"
            onClick={() => {
              offFrameRef.current?.()
              offFrameRef.current = null
              storeRef.current = new ConversationProjectionStore({ topic: 'demo' })
              setSessionId(null)
            }}
            className="h1-reset"
          >
            reset
          </button>
        </header>
        {streamingError ? <div className="h1-error">{streamingError}</div> : null}
        <ol className="h1-rows-list">
          {rows.map((row) => (
            <li key={row.rowId}>
              <RowView row={row} />
            </li>
          ))}
        </ol>
        <footer className="h1-composer">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleSend()
              }
            }}
            placeholder="发条消息试 v4 协议"
            disabled={state.status === 'closed'}
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={!input.trim()}
          >
            send
          </button>
        </footer>
      </div>
    </>
  )
}