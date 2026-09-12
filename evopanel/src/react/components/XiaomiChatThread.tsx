import { useEffect, useRef, useState } from 'react'
import { MessageRow } from './MessageRow.js'
import { getState, subscribe } from '../../components/global-assistant/assistant-store.js'
import type { DisplayRow } from '../chat-types.js'
import type { AgentAvatarAgent } from '../lib/agent-avatar.js'
import { api } from '../../lib/tauri-api.js'

type XiaomiUiMessage = {
  id?: string
  role?: string
  text?: string
  kind?: string
  streaming?: boolean
  pending?: boolean
  tools?: unknown[]
  segments?: DisplayRow['segments']
  reasoning?: string
  reasoningPreview?: string | null
  reasoningSegments?: string[]
  systemActivity?: string | null
  runId?: string
  aguiTurn?: DisplayRow['aguiTurn']
}

function reasoningOneLine(text: unknown, maxLen = 160): string {
  const flat = String(text || '')
    .replace(/\n+/g, ' ')
    .trim()
  if (!flat) return ''
  return flat.length > maxLen ? `…${flat.slice(-(maxLen - 1))}` : flat
}

function toDisplayRow(m: XiaomiUiMessage): DisplayRow | null {
  const role = String(m.role || '').toLowerCase()
  if (role === 'system' || m.kind === 'error') {
    return {
      role: 'system',
      text: String(m.text || ''),
      messageId: String(m.id || ''),
    }
  }
  if (role === 'user') {
    return {
      role: 'user',
      text: String(m.text || ''),
      messageId: String(m.id || ''),
    }
  }
  if (role !== 'assistant' && role !== 'ai') return null
  const streaming = !!(m.streaming || m.pending)
  const reasoningPreview =
    m.reasoningPreview != null && String(m.reasoningPreview).trim()
      ? String(m.reasoningPreview)
      : reasoningOneLine(m.reasoning)
  return {
    role: streaming ? '_stream' : 'assistant',
    text: String(m.text || ''),
    tools: Array.isArray(m.tools) ? m.tools : [],
    segments: Array.isArray(m.segments) ? m.segments : undefined,
    reasoningPreview: reasoningPreview || null,
    reasoningSegments: Array.isArray(m.reasoningSegments) ? m.reasoningSegments : undefined,
    systemActivity: m.systemActivity ?? (streaming && !String(m.text || '').trim() ? '正在处理' : null),
    runId: m.runId ? String(m.runId) : undefined,
    messageId: String(m.id || ''),
    aguiTurn: m.aguiTurn ?? null,
  }
}

function pickXiaomiAgent(raw: unknown): AgentAvatarAgent | null {
  const row = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  const agent =
    row && typeof row.agent === 'object' && row.agent
      ? (row.agent as Record<string, unknown>)
      : row
  if (!agent) return null
  const code = String(agent.agent_code || agent.name || 'xiaomi').trim() || 'xiaomi'
  return {
    agent_code: code,
    agent_name: String(agent.agent_name || agent.name || '小V').trim() || '小V',
    avatar: (agent.avatar as string | null | undefined) ?? null,
    avatar_meta: (agent.avatar_meta as AgentAvatarAgent['avatar_meta']) ?? null,
    has_avatar_file: agent.has_avatar_file as boolean | undefined,
    avatar_rev: (agent.avatar_rev as string | null | undefined) ?? null,
  }
}

/**
 * 小V 面板内嵌主对话 MessageRow 列表（与主会话同一套气泡 UI）。
 */
export function XiaomiChatThread({ sessionKey = '' }: { sessionKey?: string }) {
  const [tick, setTick] = useState(0)
  const [xiaomiAgent, setXiaomiAgent] = useState<AgentAvatarAgent | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    return subscribe(() => setTick((n) => n + 1))
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const data = await api.getAgent('xiaomi')
        if (cancelled) return
        setXiaomiAgent(pickXiaomiAgent(data) || { agent_code: 'xiaomi', agent_name: '小V' })
      } catch {
        if (!cancelled) setXiaomiAgent({ agent_code: 'xiaomi', agent_name: '小V' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const st = getState()
  const messages = (Array.isArray(st.messages) ? st.messages : []) as XiaomiUiMessage[]
  const sk = String(sessionKey || st.sessionKey || '')
  const agentLabel = String(xiaomiAgent?.agent_name || '').trim() || '小V'

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [tick, messages.length, st.streaming])

  if (!messages.length) {
    return (
      <p className="xm-empty">
        在左侧浏览页面，在这里让小V帮你创建、改参数或查询；也可点上方快捷语开始。
      </p>
    )
  }

  return (
    <div className="react-chat-conversation-col xm-react-thread">
      <div className="msg-list xm-react-msg-list">
        {messages.map((m, i) => {
          const row = toDisplayRow(m)
          if (!row) return null
          const key = String(m.id || `${row.role}-${i}`)
          const isStreaming = !!(m.streaming || m.pending)
          return (
            <MessageRow
              key={key}
              row={row}
              isStreaming={isStreaming}
              sessionKey={sk}
              assistantAgent={xiaomiAgent}
              assistantAgentLabel={agentLabel}
              interactiveToolApproval={false}
              showToolTiming={false}
            />
          )
        })}
        <div ref={bottomRef} aria-hidden />
      </div>
    </div>
  )
}
