import { memo, useEffect, useRef, useState } from 'react'
import { MessageRow } from './MessageRow.js'
import { getState, subscribe } from '../../components/global-assistant/assistant-store.js'
import { getXiaomiRunStartedAtMs } from '../../components/global-assistant/assistant-session.js'
import { resolveLiveStreamActivity } from '../lib/resolve-live-stream-activity.js'
import type { DisplayRow } from '../chat-types.js'
import type { AgentAvatarAgent } from '../lib/agent-avatar.js'
import { api } from '../../lib/tauri-api.js'

/** 与主对话 MessageVirtualList 同值：流式尾部齿轮绝对定位 bottom:-18px，需要底部留白才可见 */
const streamFollowBottomInsetPx = 36

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
  /** 本轮耗时（finishXiaomiAssistantRun 收尾写入；「已工作 X」折叠头用） */
  durationStr?: string
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
  // MessageRow 的单一真相源是 row.state（'streaming'/'closed'），
  // 只设 role: '_stream' 而不标 state 会让齿轮/工作中计时/生成中转圈全部不渲染。
  if (streaming) {
    return {
      role: '_stream',
      state: 'streaming',
      text: String(m.text || ''),
      tools: Array.isArray(m.tools) ? m.tools : [],
      segments: Array.isArray(m.segments) ? m.segments : undefined,
      reasoningPreview: reasoningPreview || null,
      reasoningSegments: Array.isArray(m.reasoningSegments) ? m.reasoningSegments : undefined,
      systemActivity: m.systemActivity ?? (!String(m.text || '').trim() ? '正在处理' : null),
      runId: m.runId ? String(m.runId) : undefined,
      messageId: String(m.id || ''),
      aguiTurn: m.aguiTurn ?? null,
    }
  }
  return {
    role: 'assistant',
    state: 'closed',
    text: String(m.text || ''),
    tools: Array.isArray(m.tools) ? m.tools : [],
    segments: Array.isArray(m.segments) ? m.segments : undefined,
    reasoningPreview: reasoningPreview || null,
    reasoningSegments: Array.isArray(m.reasoningSegments) ? m.reasoningSegments : undefined,
    systemActivity: m.systemActivity ?? null,
    runId: m.runId ? String(m.runId) : undefined,
    messageId: String(m.id || ''),
    durationStr: m.durationStr ? String(m.durationStr) : undefined,
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

type XiaomiHistoryRowProps = {
  message: XiaomiUiMessage
  sessionKey: string
  assistantAgent: AgentAvatarAgent | null
  assistantAgentLabel: string
}

/**
 * 历史行：store 每次流式 patch 都会触发整列表 re-render，但历史消息对象身份
 * 在当前轮内稳定（只有尾行被原地修改），memo 命中即可跳过大部分 MessageRow 重渲。
 */
const XiaomiHistoryRow = memo(function XiaomiHistoryRow({
  message,
  sessionKey,
  assistantAgent,
  assistantAgentLabel,
}: XiaomiHistoryRowProps) {
  const row = toDisplayRow(message)
  if (!row) return null
  return (
    <MessageRow
      row={row}
      sessionKey={sessionKey}
      assistantAgent={assistantAgent}
      assistantAgentLabel={assistantAgentLabel}
      showToolTiming
    />
  )
})

/**
 * 小V 面板内嵌主对话 MessageRow 列表（与主会话同一套气泡 UI）。
 * 流式行实时重渲，并接入主对话同款流式 chrome：
 * 齿轮/「工作中 Xs」折叠头由 row.state 驱动；活动标签与耗时由
 * resolveLiveStreamActivity + 运行起点（assistant-session）每秒滴答。
 */
export function XiaomiChatThread({ sessionKey = '' }: { sessionKey?: string }) {
  const [tick, setTick] = useState(0)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [xiaomiAgent, setXiaomiAgent] = useState<AgentAvatarAgent | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    // rAF 合帧：AG-UI delta 可能每秒数十个，逐 patch 重渲会让 MarkdownHtml
    // 全量重解析挤占主线程（CSS 转圈动画卡顿的来源）。对齐主对话的帧级提交节奏。
    let frame = 0
    const unsub = subscribe(() => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setTick((n) => n + 1)
      })
    })
    return () => {
      if (frame) cancelAnimationFrame(frame)
      unsub()
    }
  }, [])

  const st = getState()
  const streaming = !!st.streaming
  const runStartedAtMs = streaming ? getXiaomiRunStartedAtMs() : 0

  useEffect(() => {
    if (!streaming || !runStartedAtMs) return
    setNowMs(Date.now())
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [streaming, runStartedAtMs])

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

  const messages = (Array.isArray(st.messages) ? st.messages : []) as XiaomiUiMessage[]
  const sk = String(sessionKey || st.sessionKey || '')
  const agentLabel = String(xiaomiAgent?.agent_name || '').trim() || '小V'

  // 当前流式行（发送占位 / run 中都满足 streaming||pending）
  let liveIndex = -1
  if (streaming) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (String(m.role || '').toLowerCase() !== 'assistant' && String(m.role || '').toLowerCase() !== 'ai') continue
      if (m.streaming || m.pending) {
        liveIndex = i
        break
      }
      break
    }
  }

  // 与主对话 composer dock / 会话列表同源的活动标签（调用：xxx · 42s）
  const liveMessage = liveIndex >= 0 ? messages[liveIndex] : null
  const liveElapsedSec =
    streaming && runStartedAtMs
      ? Math.max(0, Math.floor((Math.max(nowMs, runStartedAtMs) - runStartedAtMs) / 1000))
      : undefined
  const liveActivityDockLabel = liveMessage
    ? resolveLiveStreamActivity({
        activityKind: Array.isArray(liveMessage.tools) && liveMessage.tools.length ? 'tools' : 'thinking',
        activityDetail: String(liveMessage.systemActivity || ''),
        streamSystemActivity: String(liveMessage.systemActivity || ''),
        toolCalls: Array.isArray(liveMessage.tools) ? liveMessage.tools : [],
        elapsedSec: liveElapsedSec,
        activeTurn: true,
      }).dockLabel
    : undefined

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
      <div
        className="msg-list xm-react-msg-list"
        style={streaming ? { paddingBottom: streamFollowBottomInsetPx } : undefined}
      >
        {messages.map((m, i) => {
          const key = String(m.id || `${String(m.role || '').toLowerCase()}-${i}`)
          if (i === liveIndex) {
            const row = toDisplayRow(m)
            if (!row) return null
            return (
              <MessageRow
                key={key}
                row={row}
                threadBusy={streaming}
                sessionKey={sk}
                assistantAgent={xiaomiAgent}
                assistantAgentLabel={agentLabel}
                showToolTiming
                liveActivityDockLabel={liveActivityDockLabel}
                liveTurnElapsedSec={liveElapsedSec}
              />
            )
          }
          return (
            <XiaomiHistoryRow
              key={key}
              message={m}
              sessionKey={sk}
              assistantAgent={xiaomiAgent}
              assistantAgentLabel={agentLabel}
            />
          )
        })}
        <div ref={bottomRef} aria-hidden />
      </div>
    </div>
  )
}
