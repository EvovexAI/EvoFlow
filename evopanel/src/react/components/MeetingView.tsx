/**
 * MeetingView - multi-agent group meeting chat view.
 *
 * Renders a group chat timeline where multiple AI employee agents speak
 * in sequence on a shared topic. Each agent's reply streams in via A2A SSE.
 *
 * Two interaction modes:
 * - Discuss: orchestrator serially dispatches the topic to all participants
 * - Mention: user @tags a specific agent for a targeted question
 *
 * UI: sci-fi round-table meeting room (三栏式布局).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { A2AClient, type MeetingMessage, type MeetingParticipant } from '../../lib/a2a-client'
import { useGatewayBaseUrl } from '../hooks/useGatewayBaseUrl'
import { resolveInitial, hashColor } from '../lib/agent-avatar'

// ── Props ──────────────────────────────────────────────────

export interface MeetingViewProps {
  meetingId: string
  participants: MeetingParticipant[]
  onClose?: () => void
  baseUrl?: string
}

// ── Component ──────────────────────────────────────────────

export const MeetingView: React.FC<MeetingViewProps> = ({
  meetingId,
  participants: initialParticipants,
  onClose,
  baseUrl: baseUrlProp,
}) => {
  const { baseUrl: gatewayBase, ready: gatewayReady } = useGatewayBaseUrl(baseUrlProp)
  const [messages, setMessages] = useState<MeetingMessage[]>([])
  const [participants] = useState(initialParticipants)
  const [topic, setTopic] = useState('')
  const [sending, setSending] = useState(false)
  const [mentionTarget, setMentionTarget] = useState<string>('')
  const [volumeOn, setVolumeOn] = useState(true)
  const [fullscreen, setFullscreen] = useState(false)
  const clientRef = useRef<A2AClient | null>(null)
  const unsubscribersRef = useRef<Map<string, () => void>>(new Map())
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Initialize A2A client when gateway is ready
  useEffect(() => {
    if (!gatewayReady) return
    if (!clientRef.current) {
      clientRef.current = new A2AClient(gatewayBase)
    } else {
      clientRef.current.setBaseUrl(gatewayBase)
    }
  }, [gatewayBase, gatewayReady])

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Cleanup subscriptions on unmount
  useEffect(() => {
    return () => {
      unsubscribersRef.current.forEach((unsub) => unsub())
      unsubscribersRef.current.clear()
    }
  }, [])

  // Fullscreen toggle
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onFsChange = () => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])

  // ── Helpers ────────────────────────────────────────────

  const addMessage = useCallback((msg: MeetingMessage) => {
    setMessages((prev) => [...prev, msg])
  }, [])

  const updateStreamingMessage = useCallback(
    (speakerAgentCode: string, delta: string) => {
      setMessages((prev) => {
        const idx = prev.findIndex(
          (m) => m.speakerAgentCode === speakerAgentCode && m.streaming,
        )
        if (idx >= 0) {
          const updated = [...prev]
          updated[idx] = {
            ...updated[idx],
            text: updated[idx].text + delta,
          }
          return updated
        }
        // New streaming message
        const participant = participants.find((p) => p.agent_code === speakerAgentCode)
        return [
          ...prev,
          {
            id: `${speakerAgentCode}-${Date.now()}`,
            speakerAgentCode,
            speakerRoleName: participant?.role_name || speakerAgentCode,
            text: delta,
            timestamp: Date.now(),
            streaming: true,
          },
        ]
      })
    },
    [participants],
  )

  const finalizeMessage = useCallback(
    (speakerAgentCode: string, finalText: string) => {
      setMessages((prev) => {
        const idx = prev.findIndex(
          (m) => m.speakerAgentCode === speakerAgentCode && m.streaming,
        )
        if (idx >= 0) {
          const updated = [...prev]
          updated[idx] = {
            ...updated[idx],
            text: finalText || updated[idx].text,
            streaming: false,
          }
          return updated
        }
        return prev
      })
    },
    [],
  )

  const addArtifact = useCallback(
    (speakerAgentCode: string, name: string, content: string) => {
      setMessages((prev) => {
        const idx = prev.findIndex(
          (m) => m.speakerAgentCode === speakerAgentCode && m.streaming,
        )
        if (idx >= 0) {
          const updated = [...prev]
          const artifacts = updated[idx].artifacts || []
          artifacts.push({ name, content })
          updated[idx] = { ...updated[idx], artifacts }
          return updated
        }
        return prev
      })
    },
    [],
  )

  const addErrorMessage = useCallback(
    (speakerAgentCode: string, error: string) => {
      const participant = participants.find((p) => p.agent_code === speakerAgentCode)
      setMessages((prev) => [
        ...prev,
        {
          id: `error-${speakerAgentCode}-${Date.now()}`,
          speakerAgentCode,
          speakerRoleName: participant?.role_name || speakerAgentCode,
          text: `⚠️ ${error}`,
          timestamp: Date.now(),
          error: true,
        },
      ])
    },
    [participants],
  )

  // ── Actions ────────────────────────────────────────────

  const handleDiscuss = useCallback(async () => {
    const client = clientRef.current
    if (!client || !topic.trim() || sending) return

    setSending(true)

    // Add user message
    addMessage({
      id: `user-${Date.now()}`,
      speakerAgentCode: null,
      speakerRoleName: null,
      text: topic.trim(),
      timestamp: Date.now(),
    })

    // Add orchestrator message
    const names = participants.map((p) => p.role_name || p.agent_code).join('、')
    addMessage({
      id: `orch-${Date.now()}`,
      speakerAgentCode: null,
      speakerRoleName: '小V · 主持人',
      text: `好的，我依次邀请 ${names} 发言`,
      timestamp: Date.now(),
    })

    try {
      await client.startDiscussion(meetingId, topic.trim())

      // Poll meeting tasks to track each speaker's progress
      const pollInterval = setInterval(async () => {
        try {
          const tasksData = (await client.listMeetingTasks(meetingId)) as {
            tasks: Array<{
              task_id: string
              agent_code: string
              state: string
              result_text: string
            }>
          }
          for (const task of tasksData.tasks || []) {
            if (task.state === 'completed' && task.result_text) {
              const existing = messages.find(
                (m) => m.taskId === task.task_id && !m.streaming,
              )
              if (!existing) {
                finalizeMessage(task.agent_code, task.result_text)
                if (task.task_id && unsubscribersRef.current.has(task.task_id)) {
                  unsubscribersRef.current.get(task.task_id)!()
                  unsubscribersRef.current.delete(task.task_id)
                }
              }
            }
          }
          // Check if all turns completed
          const turnsData = (await client.listTurns(meetingId)) as {
            turns: Array<{ status: string }>
          }
          const allDone = (turnsData.turns || []).every(
            (t) => t.status === 'completed',
          )
          if (allDone && (turnsData.turns || []).length > 0) {
            clearInterval(pollInterval)
            setSending(false)
            // Add summary
            addMessage({
              id: `summary-${Date.now()}`,
              speakerAgentCode: null,
              speakerRoleName: '小V · 主持人',
              text: '讨论结束，以上是所有参会人的发言。',
              timestamp: Date.now(),
            })
          }
        } catch {
          // ignore poll errors
        }
      }, 3000)

      setTopic('')
    } catch (err) {
      setSending(false)
      addMessage({
        id: `err-${Date.now()}`,
        speakerAgentCode: null,
        speakerRoleName: null,
        text: `⚠️ 讨论启动失败: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
        error: true,
      })
    }
  }, [clientRef, topic, sending, meetingId, participants, addMessage, finalizeMessage, messages])

  const handleMention = useCallback(async () => {
    const client = clientRef.current
    if (!client || !topic.trim() || !mentionTarget || sending) return

    setSending(true)

    // Add user message
    addMessage({
      id: `user-${Date.now()}`,
      speakerAgentCode: null,
      speakerRoleName: null,
      text: `@${mentionTarget} ${topic.trim()}`,
      timestamp: Date.now(),
    })

    try {
      const result = await client.mentionParticipant(
        meetingId,
        mentionTarget,
        topic.trim(),
      )

      const task = result.task
      if (task) {
        // Subscribe to SSE
        const unsub = client.subscribeToTask(mentionTarget, task.id, {
          onMessage: (delta) => updateStreamingMessage(mentionTarget, delta),
          onArtifact: (name, content) =>
            addArtifact(mentionTarget, name, content),
          onComplete: (finalText) => {
            finalizeMessage(mentionTarget, finalText)
            unsubscribersRef.current.delete(task.id)
            setSending(false)
          },
          onError: (error) => {
            addErrorMessage(mentionTarget, error)
            unsubscribersRef.current.delete(task.id)
            setSending(false)
          },
        })
        unsubscribersRef.current.set(task.id, unsub)
      }

      setTopic('')
      setMentionTarget('')
    } catch (err) {
      setSending(false)
      addMessage({
        id: `err-${Date.now()}`,
        speakerAgentCode: null,
        speakerRoleName: null,
        text: `⚠️ @点名失败: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
        error: true,
      })
    }
  }, [
    clientRef,
    topic,
    mentionTarget,
    sending,
    meetingId,
    addMessage,
    updateStreamingMessage,
    addArtifact,
    finalizeMessage,
    addErrorMessage,
  ])

  const handleSend = useCallback(() => {
    if (mentionTarget) {
      void handleMention()
    } else {
      void handleDiscuss()
    }
  }, [mentionTarget, handleDiscuss, handleMention])

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    if (document.fullscreenElement) {
      void document.exitFullscreen()
    } else {
      void el.requestFullscreen()
    }
  }, [])

  const handleQuickTag = useCallback((tag: string) => {
    setTopic((prev) => {
      if (!prev) return tag
      return `${prev} ${tag}`
    })
  }, [])

  // ── Derived state (UI only) ────────────────────────────

  // Current speaker = the streaming message, or the most recent non-user message
  const currentSpeaker = useMemo(() => {
    const streaming = messages.find((m) => m.streaming && m.speakerAgentCode)
    if (streaming) return streaming
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.speakerAgentCode) return m
    }
    return null
  }, [messages])

  const isSpeaking = useMemo(() => {
    return messages.some((m) => m.streaming && m.speakerAgentCode)
  }, [messages])

  // Consensus list = last message from each agent speaker (simple aggregation)
  const consensus = useMemo(() => {
    const map = new Map<string, MeetingMessage>()
    for (const m of messages) {
      if (m.speakerAgentCode && !m.error) {
        map.set(m.speakerAgentCode, m)
      }
    }
    return Array.from(map.values())
  }, [messages])

  const liveMessages = useMemo(() => {
    // Messages not from the user/orchestrator (agent speech + orchestrator)
    return messages.filter((m) => m.speakerAgentCode || !!m.speakerRoleName)
  }, [messages])

  // Seating arrangement: participants in a semicircular arc above the table
  const seatLayout = useMemo(() => {
    const count = participants.length
    const baseAngle = Math.PI // semicircle
    return participants.map((p, i) => {
      const angle = baseAngle * (count === 1 ? 0.5 : i / (count - 1))
      // x from left(-) to right(+) across the top arc
      const x = Math.cos(Math.PI - angle) // -1..1
      const y = Math.sin(angle) // 0..1
      return { participant: p, x, y, angle, index: i, total: count }
    })
  }, [participants])

  if (!gatewayReady) {
    return (
      <div className="rv-loading">
        <div className="rv-loading-spinner" />
        <p>正在连接服务器...</p>
      </div>
    )
  }

  return (
    <div className="rv-root" ref={containerRef}>
      <div className="rv-bg-grid" />
      <div className="rv-bg-glow rv-bg-glow-1" />
      <div className="rv-bg-glow rv-bg-glow-2" />

      <div className="rv-shell">
        {/* ── Header ── */}
        <header className="rv-header">
          <div className="rv-header-left">
            <div className="rv-brand">
              <svg
                className="rv-brand-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" />
                <path d="M20 2v4" />
                <path d="M22 4h-4" />
                <circle cx="4" cy="20" r="2" />
              </svg>
              <span className="rv-brand-title">AI员工聊天室</span>
            </div>
            <div className="rv-header-meta">
              <span className="rv-meta-dot" />
              <span className="rv-meta-text">
                {participants.length} 位参会人 · 协议 A2A v0.3
              </span>
              <span className="rv-live-tag">
                <span className="rv-live-dot" />
                LIVE
              </span>
            </div>
          </div>
          <div className="rv-header-actions">
            <button
              className={`rv-icon-btn ${volumeOn ? '' : 'rv-icon-btn-off'}`}
              title={volumeOn ? '静音' : '取消静音'}
              onClick={() => setVolumeOn((v) => !v)}
            >
              {volumeOn ? '🔊' : '🔇'}
            </button>
            <button
              className="rv-icon-btn"
              title="全屏"
              onClick={toggleFullscreen}
            >
              {fullscreen ? '🗗' : '⛶'}
            </button>
            <button className="rv-icon-btn" title="设置">
              ⚙️
            </button>
            {onClose && (
              <button className="rv-icon-btn rv-icon-btn-close" title="退出" onClick={onClose}>
                ✕
              </button>
            )}
          </div>
        </header>

        {/* ── Body ── */}
        <div className="rv-body">
          {/* ── Center column ── */}
          <main className="rv-center">
            {/* Topic bar */}
            <div className="rv-topic-bar">
              <span className="rv-topic-label">
                <span className="rv-topic-label-ic">🛰</span>
                CURRENT TOPIC
              </span>
              <input
                className="rv-topic-input"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="输入当前讨论话题..."
                disabled={sending}
              />
              <button className="rv-topic-edit" title="编辑话题">✎</button>
            </div>

            {/* Round table */}
            <div className="rv-stage">
              <div className="rv-stage-inner">
                {/* Seat avatars */}
                {seatLayout.map(({ participant, x, y }) => {
                  const color = hashColor(participant.agent_code)
                  const isCur = currentSpeaker?.speakerAgentCode === participant.agent_code
                  const isUserP = false
                  return (
                    <div
                      key={participant.agent_code}
                      className="rv-seat"
                      style={{
                        left: `${48 + x * 40}%`,
                        top: `${isUserP ? 88 : 14 + y * 42}%`,
                      }}
                    >
                      <div
                        className={`rv-seat-avatar-wrap ${isCur ? 'rv-seat-speaking' : ''} ${
                          isUserP ? 'rv-seat-user' : ''
                        }`}
                        style={isCur ? { '--seat-glow': color } as React.CSSProperties : undefined}
                      >
                        {isUserP && <span className="rv-crown">👑</span>}
                        <div
                          className="rv-seat-avatar"
                          style={{ backgroundColor: color }}
                        >
                          {resolveInitial({
                            agent_name: participant.role_name,
                            agent_code: participant.agent_code,
                          })}
                          {isCur && (
                            <div className="rv-soundwave">
                              <i /><i /><i /><i />
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="rv-seat-name">{participant.role_name || participant.agent_code}</div>
                      <div className={`rv-seat-status ${isCur ? 'rv-seat-status-speaking' : ''}`}>
                        {isCur ? (
                          <>
                            <span className="rv-status-badge">正在发言</span>
                            <span className="rv-wave-bars"><i /><i /><i /></span>
                          </>
                        ) : (
                          <>
                            <span className="rv-thinking-dot" />
                            <span className="rv-status-text">倾听中</span>
                          </>
                        )}
                      </div>
                      {isUserP && <div className="rv-seat-tag">YOU / 主持人</div>}
                    </div>
                  )
                })}

                {/* Round table */}
                <div className="rv-table">
                  <div className="rv-table-ellipse" />
                  <div className="rv-table-inner" />
                  <div className="rv-table-center-label">⚡ ROUNDTABLE</div>
                </div>

                {/* Center speech bubble */}
                <div className="rv-speech">
                  {currentSpeaker ? (
                    <>
                      <div className="rv-speech-header">
                        <span
                          className="rv-speech-avatar"
                          style={{ backgroundColor: hashColor(currentSpeaker.speakerAgentCode || '') }}
                        >
                          {resolveInitial({
                            agent_name: currentSpeaker.speakerRoleName,
                            agent_code: currentSpeaker.speakerAgentCode,
                          })}
                        </span>
                        <span className="rv-speech-name">
                          {currentSpeaker.speakerRoleName || currentSpeaker.speakerAgentCode}
                        </span>
                        {currentSpeaker.streaming && (
                          <span className="rv-speech-live">
                            <span className="rv-wave-bars"><i /><i /><i /></span>
                            正在发言
                          </span>
                        )}
                      </div>
                      <p className={`rv-speech-text ${currentSpeaker.streaming ? 'rv-speech-streaming' : ''}`}>
                        {currentSpeaker.text}
                        {currentSpeaker.streaming && <span className="rv-stream-cursor" />}
                      </p>
                    </>
                  ) : (
                    <div className="rv-speech-empty">
                      <p>🛰 聊天室已就绪，等待话题…</p>
                      <p className="rv-speech-empty-hint">在下方输入话题，开始 AI员工聊天</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </main>

          {/* ── Right panel ── */}
          <aside className="rv-side">
            {/* Live discussion */}
            <div className="rv-panel rv-panel-live">
              <div className="rv-panel-head">
                <span className="rv-panel-title">
                  <span className="rv-live-dot" /> 实时讨论
                </span>
                <span className="rv-panel-count">{liveMessages.length}</span>
              </div>
              <div className="rv-panel-scroll">
                {liveMessages.length === 0 && (
                  <div className="rv-panel-empty">暂无讨论消息</div>
                )}
                {liveMessages.map((msg) => (
                  <MeetingMessageBubble key={msg.id} message={msg} isActive={msg.speakerAgentCode === currentSpeaker?.speakerAgentCode && msg.streaming} />
                ))}
                <div ref={messagesEndRef} />
              </div>
            </div>

            {/* Consensus */}
            <div className="rv-panel rv-panel-consensus">
              <div className="rv-panel-head">
                <span className="rv-panel-title">
                  <span className="rv-consensus-ic">◈</span> 本轮共识
                </span>
                <span className="rv-panel-count">{consensus.length}</span>
              </div>
              <div className="rv-panel-scroll rv-panel-scroll-consensus">
                {consensus.length === 0 && (
                  <div className="rv-panel-empty">暂无共识</div>
                )}
                {consensus.map((c) => (
                  <div key={c.id} className="rv-consensus-item">
                    <span
                      className="rv-consensus-avatar"
                      style={{ backgroundColor: hashColor(c.speakerAgentCode || '') }}
                    >
                      {resolveInitial({
                        agent_name: c.speakerRoleName,
                        agent_code: c.speakerAgentCode,
                      })}
                    </span>
                    <div className="rv-consensus-body">
                      <div className="rv-consensus-name">{c.speakerRoleName || c.speakerAgentCode}</div>
                      <div className="rv-consensus-text">
                        {c.text.slice(0, 60)}
                        {c.text.length > 60 ? '…' : ''}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </div>

        {/* ── Composer ── */}
        <footer className="rv-composer">
          <div className="rv-composer-row">
            <span className="rv-composer-star">✦</span>
            <div className="rv-quick-tags">
              {['深度分析', '头脑风暴', '方案制定', '用户视角'].map((tag) => (
                <button
                  key={tag}
                  className="rv-quick-tag"
                  onClick={() => handleQuickTag(tag)}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>
          <div className="rv-composer-main">
            <select
              value={mentionTarget}
              onChange={(e) => setMentionTarget(e.target.value)}
              className="rv-mention-select"
            >
              <option value="">所有人（讨论）</option>
              {participants.map((p) => (
                <option key={p.agent_code} value={p.agent_code}>
                  @{p.role_name || p.agent_code}
                </option>
              ))}
            </select>
            <input
              type="text"
              className="rv-input"
              placeholder={
                mentionTarget
                  ? `@${mentionTarget} 说点什么...`
                  : '输入讨论话题，邀请员工展开讨论...'
              }
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSend()
                }
              }}
              disabled={sending}
            />
            <button
              className="rv-btn rv-btn-mention"
              onClick={() => {
                if (!mentionTarget && participants.length > 0) {
                  setMentionTarget(participants[0].agent_code)
                } else if (mentionTarget) {
                  handleMention()
                }
              }}
              disabled={sending}
              title="点名发言"
            >
              <span className="rv-btn-ic">👤</span> 点名发言
            </button>
            <button
              className="rv-btn rv-btn-discuss"
              onClick={handleSend}
              disabled={sending || !topic.trim()}
            >
              <span className="rv-btn-ic">✈</span>
              {sending ? '讨论中…' : '开始讨论'}
            </button>
          </div>
        </footer>
      </div>

      <style>{`
        /* ── Root / background ── */
        .rv-root {
          position: relative;
          height: 100%;
          min-width: 800px;
          min-height: 640px;
          background: radial-gradient(ellipse at 20% 0%, #1a2350 0%, #101233 45%, #0a0c24 100%);
          color: #f0f2ff;
          border-radius: 14px;
          overflow: hidden;
          font-family: 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif;
        }
        .rv-bg-grid {
          position: absolute;
          inset: 0;
          pointer-events: none;
          background-image:
            radial-gradient(circle at 1px 1px, rgba(124, 77, 255, 0.12) 1px, transparent 1px);
          background-size: 26px 26px;
          opacity: 0.5;
          mask-image: radial-gradient(ellipse at center, rgba(0,0,0,0.9), transparent 80%);
        }
        .rv-bg-glow {
          position: absolute;
          border-radius: 50%;
          filter: blur(90px);
          opacity: 0.35;
          pointer-events: none;
        }
        .rv-bg-glow-1 { width: 420px; height: 420px; background: #4a6cf7; top: -120px; left: -80px; }
        .rv-bg-glow-2 { width: 380px; height: 380px; background: #7c4dff; bottom: -140px; right: -60px; }
        .rv-shell {
          position: relative;
          z-index: 1;
          display: flex;
          flex-direction: column;
          height: 100%;
        }

        /* ── Header ── */
        .rv-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 20px;
          background: rgba(20, 24, 58, 0.55);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border-bottom: 1px solid rgba(124, 77, 255, 0.25);
          box-shadow: 0 2px 24px rgba(74, 108, 247, 0.15);
        }
        .rv-header-left { display: flex; align-items: center; gap: 16px; }
        .rv-brand { display: flex; align-items: center; gap: 10px; }
        .rv-brand-icon {
          width: 22px;
          height: 22px;
          flex-shrink: 0;
          color: #a67cff;
          filter: drop-shadow(0 0 6px rgba(166, 124, 255, 0.8));
          animation: rv-sparkle-pulse 2.5s ease-in-out infinite;
        }
        @keyframes rv-sparkle-pulse {
          0%, 100% {
            transform: scale(1);
            filter: drop-shadow(0 0 6px rgba(166, 124, 255, 0.8));
          }
          50% {
            transform: scale(1.1);
            filter: drop-shadow(0 0 12px rgba(166, 124, 255, 1));
          }
        }
        .rv-brand-title {
          font-size: 17px;
          font-weight: 700;
          letter-spacing: 0.5px;
          background: linear-gradient(90deg, #6ea8ff, #a67cff);
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
        }
        .rv-header-meta { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: #9aa3d6; }
        .rv-meta-dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 8px #4ade80; }
        .rv-live-tag {
          display: inline-flex; align-items: center; gap: 5px;
          padding: 2px 8px; border-radius: 20px; font-size: 11px; font-weight: 700;
          color: #ff5c8a;
          background: rgba(255, 92, 138, 0.12);
          border: 1px solid rgba(255, 92, 138, 0.35);
        }
        .rv-live-dot { width: 6px; height: 6px; border-radius: 50%; background: #ff5c8a; box-shadow: 0 0 6px #ff5c8a; animation: rv-live-blink 1.4s infinite; }
        @keyframes rv-live-blink { 0%,100% {opacity:1;} 50% {opacity:0.35;} }
        .rv-header-actions { display: flex; align-items: center; gap: 8px; }
        .rv-icon-btn {
          width: 34px; height: 34px; display: flex; align-items: center; justify-content: center;
          border: 1px solid rgba(124, 77, 255, 0.3);
          background: rgba(124, 77, 255, 0.08);
          color: #d6d9ff; border-radius: 9px; font-size: 15px; cursor: pointer;
          transition: all 0.2s;
        }
        .rv-icon-btn:hover { background: rgba(124, 77, 255, 0.22); box-shadow: 0 0 12px rgba(124,77,255,0.4); }
        .rv-icon-btn-off { opacity: 0.55; }
        .rv-icon-btn-close:hover { background: rgba(255, 92, 138, 0.2); border-color: rgba(255,92,138,0.5); }

        /* ── Body layout ── */
        .rv-body {
          flex: 1;
          display: flex;
          min-height: 0;
        }
        .rv-center {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          padding: 14px 18px 14px 18px;
          gap: 12px;
        }

        /* ── Topic bar ── */
        .rv-topic-bar {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 10px 14px;
          border-radius: 12px;
          background: rgba(30, 34, 78, 0.5);
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
          border: 1px solid rgba(124, 77, 255, 0.35);
          box-shadow: 0 0 18px rgba(74, 108, 247, 0.2), inset 0 0 12px rgba(74,108,247,0.08);
        }
        .rv-topic-label {
          display: inline-flex; align-items: center; gap: 7px;
          font-size: 12px; font-weight: 800; letter-spacing: 1.5px;
          color: #8ea4ff; white-space: nowrap;
        }
        .rv-topic-label-ic { font-size: 14px; }
        .rv-topic-input {
          flex: 1; min-width: 0;
          background: transparent; border: none; outline: none;
          color: #eef0ff; font-size: 15px; font-weight: 600;
          padding: 4px 2px;
        }
        .rv-topic-input::placeholder { color: #6b74a8; font-weight: 400; }
        .rv-topic-edit {
          background: none; border: none; color: #8ea4ff; cursor: pointer; font-size: 14px;
          padding: 2px 6px; border-radius: 6px;
        }
        .rv-topic-edit:hover { background: rgba(124,77,255,0.15); }

        /* ── Stage (round table) ── */
        .rv-stage {
          flex: 1;
          min-height: 0;
          position: relative;
          border-radius: 16px;
          background: radial-gradient(circle at 50% 45%, rgba(74,108,247,0.14) 0%, rgba(16,18,51,0.4) 70%);
          border: 1px solid rgba(124, 77, 255, 0.2);
          overflow: hidden;
        }
        .rv-stage-inner { position: relative; width: 100%; height: 100%; }

        /* seats */
        .rv-seat {
          position: absolute;
          transform: translate(-50%, -50%);
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 5px;
          width: 96px;
        }
        .rv-seat-avatar-wrap {
          position: relative;
          width: 58px; height: 58px;
          border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          transition: transform 0.3s ease;
        }
        .rv-seat-avatar-wrap.rv-seat-speaking {
          animation: rv-breathe 2.2s ease-in-out infinite;
        }
        @keyframes rv-breathe {
          0%, 100% { box-shadow: 0 0 0 0 rgba(124,77,255,0.6), 0 0 18px 4px var(--seat-glow, #7c4dff); }
          50% { box-shadow: 0 0 0 8px rgba(124,77,255,0.18), 0 0 30px 10px var(--seat-glow, #7c4dff); }
        }
        .rv-seat-avatar {
          width: 56px; height: 56px;
          border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          font-size: 22px; font-weight: 800; color: white;
          text-shadow: 0 1px 3px rgba(0,0,0,0.4);
          position: relative;
          border: 2px solid rgba(255,255,255,0.25);
          box-shadow: 0 4px 14px rgba(0,0,0,0.4);
        }
        .rv-seat-name {
          font-size: 12px; font-weight: 600; color: #c8cdf5;
          max-width: 96px; text-align: center;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .rv-seat-status {
          display: flex; align-items: center; gap: 5px;
          font-size: 11px; color: #8fd6a0;
        }
        .rv-seat-status.rv-seat-status-speaking { color: #b18cff; font-weight: 700; }
        .rv-thinking-dot { width: 7px; height: 7px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 6px #4ade80; }
        .rv-status-text { color: #7f8ab8; }
        .rv-status-badge {
          padding: 1px 8px; border-radius: 10px; font-size: 10.5px;
          background: linear-gradient(90deg, #7c4dff, #a67cff);
          box-shadow: 0 0 10px rgba(124,77,255,0.6);
        }
        .rv-wave-bars { display: inline-flex; align-items: center; gap: 2px; height: 12px; }
        .rv-wave-bars i {
          width: 2.5px; border-radius: 2px; background: #b18cff;
          animation: rv-wave 0.9s ease-in-out infinite;
        }
        .rv-wave-bars i:nth-child(1){ height: 6px; }
        .rv-wave-bars i:nth-child(2){ height: 11px; animation-delay: 0.15s; }
        .rv-wave-bars i:nth-child(3){ height: 8px; animation-delay: 0.3s; }
        @keyframes rv-wave { 0%,100% { transform: scaleY(0.5);} 50% { transform: scaleY(1.3);} }

        /* soundwave around avatar */
        .rv-soundwave {
          position: absolute; inset: -8px;
          border-radius: 50%;
          pointer-events: none;
          border: 1px solid rgba(167,139,250,0.5);
          animation: rv-ping 1.8s ease-out infinite;
        }
        .rv-soundwave i { display: none; }
        @keyframes rv-ping {
          0% { transform: scale(0.85); opacity: 0.9; }
          100% { transform: scale(1.35); opacity: 0; }
        }

        .rv-crown { position: absolute; top: -14px; left: 50%; transform: translateX(-50%); font-size: 18px; z-index: 2; filter: drop-shadow(0 0 4px rgba(255,200,80,0.8)); }
        .rv-seat-user .rv-seat-avatar { border-color: #ffd166; box-shadow: 0 0 16px rgba(255,209,102,0.5); }
        .rv-seat-tag {
          font-size: 10px; font-weight: 700; color: #ffd166;
          padding: 1px 8px; border-radius: 8px;
          background: rgba(255, 209, 102, 0.12);
          border: 1px solid rgba(255,209,102,0.4);
        }

        /* table */
        .rv-table {
          position: absolute;
          left: 50%; top: 50%;
          transform: translate(-50%, -50%);
          width: 340px; height: 150px;
          pointer-events: none;
        }
        .rv-table-ellipse {
          position: absolute; inset: 0;
          border-radius: 50%;
          background: radial-gradient(circle at 50% 50%, rgba(124,77,255,0.35) 0%, rgba(74,108,247,0.15) 60%, rgba(74,108,247,0.05) 100%);
          border: 1px solid rgba(124, 77, 255, 0.55);
          box-shadow:
            0 0 40px rgba(124,77,255,0.4),
            inset 0 0 30px rgba(124,77,255,0.25),
            0 0 80px rgba(74,108,247,0.2);
        }
        .rv-table-inner {
          position: absolute; inset: 18px;
          border-radius: 50%;
          border: 1px dashed rgba(167, 139, 250, 0.4);
        }
        .rv-table-center-label {
          position: absolute; left: 50%; top: 50%;
          transform: translate(-50%, -50%);
          font-size: 11px; font-weight: 800; letter-spacing: 2px;
          color: rgba(190, 170, 255, 0.9);
          text-shadow: 0 0 8px rgba(124,77,255,0.8);
          white-space: nowrap;
        }

        /* center speech bubble */
        .rv-speech {
          position: absolute;
          left: 50%; top: 50%;
          transform: translate(-50%, 6%);
          width: min(440px, 70%);
          max-height: 34%;
          overflow-y: auto;
          padding: 12px 16px;
          border-radius: 14px;
          background: rgba(24, 28, 68, 0.72);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          border: 1px solid rgba(124, 77, 255, 0.45);
          box-shadow: 0 0 24px rgba(74,108,247,0.3), inset 0 0 16px rgba(74,108,247,0.08);
        }
        .rv-speech-header { display: flex; align-items: center; gap: 9px; margin-bottom: 7px; }
        .rv-speech-avatar {
          width: 30px; height: 30px; border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          font-size: 14px; font-weight: 700; color: white;
          border: 1px solid rgba(255,255,255,0.25);
        }
        .rv-speech-name { font-size: 13px; font-weight: 700; color: #e3e6ff; }
        .rv-speech-live {
          display: inline-flex; align-items: center; gap: 5px;
          font-size: 11px; font-weight: 700; color: #b18cff;
          margin-left: auto;
        }
        .rv-speech-text { font-size: 13.5px; line-height: 1.6; color: #dfe2ff; margin: 0; word-break: break-word; }
        .rv-speech-streaming { color: #f0e9ff; }
        .rv-stream-cursor {
          display: inline-block; width: 2px; height: 14px;
          background: #a67cff; margin-left: 3px; vertical-align: -2px;
          animation: rv-blink 0.8s infinite;
        }
        @keyframes rv-blink { 0%,50% {opacity:1;} 51%,100% {opacity:0;} }
        .rv-speech-empty { text-align: center; padding: 4px 0; }
        .rv-speech-empty p { margin: 0; font-size: 14px; color: #aab1e0; font-weight: 600; }
        .rv-speech-empty-hint { font-size: 12px; color: #6b74a8; margin-top: 4px; font-weight: 400; }

        /* ── Right panel ── */
        .rv-side {
          width: 330px;
          min-width: 330px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          padding: 14px 16px 14px 4px;
          overflow: hidden;
        }
        .rv-panel {
          display: flex;
          flex-direction: column;
          background: rgba(22, 26, 62, 0.5);
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
          border: 1px solid rgba(124, 77, 255, 0.25);
          border-radius: 14px;
          box-shadow: 0 0 18px rgba(74,108,247,0.12), inset 0 0 10px rgba(74,108,247,0.05);
          min-height: 0;
        }
        .rv-panel-live { flex: 1.3; }
        .rv-panel-consensus { flex: 1; }
        .rv-panel-head {
          display: flex; align-items: center; justify-content: space-between;
          padding: 12px 14px 8px;
        }
        .rv-panel-title {
          display: inline-flex; align-items: center; gap: 7px;
          font-size: 13px; font-weight: 700; color: #c8cdf5;
        }
        .rv-consensus-ic { color: #a67cff; }
        .rv-panel-count {
          font-size: 11px; color: #8ea4ff; font-weight: 700;
          padding: 1px 8px; border-radius: 10px;
          background: rgba(124,77,255,0.15);
        }
        .rv-panel-scroll {
          flex: 1; min-height: 0; overflow-y: auto;
          padding: 4px 10px 12px;
          display: flex; flex-direction: column; gap: 8px;
        }
        .rv-panel-empty { font-size: 12.5px; color: #6b74a8; text-align: center; padding: 20px 0; }

        /* ── Message bubbles ── */
        .rv-msg {
          display: flex; gap: 9px;
          padding: 9px 11px;
          border-radius: 12px;
          background: rgba(30, 34, 78, 0.55);
          border: 1px solid rgba(124, 77, 255, 0.18);
          animation: rv-fade-in 0.35s ease;
          position: relative;
        }
        .rv-msg.rv-msg-active {
          border-color: rgba(167, 139, 250, 0.55);
          background: rgba(124, 77, 255, 0.14);
          box-shadow: 0 0 16px rgba(124,77,255,0.3);
        }
        @keyframes rv-fade-in {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .rv-msg-avatar {
          width: 30px; height: 30px; flex-shrink: 0;
          border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          font-size: 13px; font-weight: 700; color: white;
          border: 1px solid rgba(255,255,255,0.2);
        }
        .rv-msg-body { min-width: 0; flex: 1; }
        .rv-msg-meta { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; }
        .rv-msg-name { font-size: 12px; font-weight: 700; color: #d6d9ff; }
        .rv-msg-time { font-size: 10.5px; color: #6b74a8; margin-left: auto; }
        .rv-msg-sound {
          width: 9px; height: 9px; flex-shrink: 0;
          border-radius: 50%; background: #a67cff;
          box-shadow: 0 0 6px #a67cff;
          animation: rv-live-blink 1.2s infinite;
        }
        .rv-msg-text { font-size: 12.5px; line-height: 1.5; color: #d8dcff; word-break: break-word; }
        .rv-msg.rv-msg-orch { align-self: center; background: rgba(124,77,255,0.1); border-color: rgba(124,77,255,0.25); }
        .rv-msg.rv-msg-error { border-color: rgba(255,92,138,0.4); background: rgba(255,92,138,0.1); }
        .rv-msg-error .rv-msg-text { color: #ff9cb4; }
        .rv-msg-artifacts { margin-top: 6px; }
        .rv-msg-artifacts summary { font-size: 11px; color: #8ea4ff; cursor: pointer; }
        .rv-artifact-item { font-size: 11px; color: #9aa3d6; padding: 2px 0; }

        /* ── Consensus ── */
        .rv-consensus-item {
          display: flex; gap: 9px; align-items: flex-start;
          padding: 8px 10px;
          border-radius: 10px;
          background: rgba(124, 77, 255, 0.07);
          border: 1px solid rgba(124, 77, 255, 0.14);
        }
        .rv-consensus-avatar {
          width: 26px; height: 26px; flex-shrink: 0;
          border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          font-size: 12px; font-weight: 700; color: white;
        }
        .rv-consensus-body { min-width: 0; }
        .rv-consensus-name { font-size: 11.5px; font-weight: 700; color: #c8cdf5; }
        .rv-consensus-text { font-size: 11.5px; color: #9aa3d6; line-height: 1.4; margin-top: 2px; word-break: break-word; }

        /* ── Composer ── */
        .rv-composer {
          padding: 12px 18px 14px;
          background: rgba(20, 24, 58, 0.6);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border-top: 1px solid rgba(124, 77, 255, 0.25);
        }
        .rv-composer-row { display: flex; align-items: center; gap: 12px; margin-bottom: 9px; }
        .rv-composer-star { font-size: 15px; color: #ffd166; filter: drop-shadow(0 0 6px rgba(255,209,102,0.6)); }
        .rv-quick-tags { display: flex; gap: 8px; flex-wrap: wrap; }
        .rv-quick-tag {
          padding: 4px 12px; border-radius: 16px;
          font-size: 11.5px; color: #b9c0f0;
          background: rgba(124, 77, 255, 0.1);
          border: 1px solid rgba(124, 77, 255, 0.3);
          cursor: pointer;
          transition: all 0.2s;
        }
        .rv-quick-tag:hover { background: rgba(124,77,255,0.25); color: #fff; box-shadow: 0 0 10px rgba(124,77,255,0.3); }
        .rv-composer-main { display: flex; align-items: center; gap: 10px; }
        .rv-mention-select {
          background: rgba(30, 34, 78, 0.8);
          color: #d6d9ff; border: 1px solid rgba(124,77,255,0.35);
          border-radius: 10px; padding: 10px 10px; font-size: 12.5px;
          cursor: pointer; max-width: 150px; outline: none;
        }
        .rv-input {
          flex: 1; min-width: 0;
          padding: 11px 14px;
          font-size: 14px; color: #eef0ff;
          background: rgba(30, 34, 78, 0.7);
          border: 1px solid rgba(124, 77, 255, 0.4);
          border-radius: 12px;
          outline: none;
          transition: all 0.25s;
          box-shadow: inset 0 0 8px rgba(74,108,247,0.08);
        }
        .rv-input::placeholder { color: #6b74a8; }
        .rv-input:focus {
          border-color: #a67cff;
          box-shadow: 0 0 18px rgba(124,77,255,0.35), inset 0 0 8px rgba(74,108,247,0.12);
        }
        .rv-input:disabled { opacity: 0.6; }
        .rv-btn {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 10px 16px;
          border-radius: 12px;
          font-size: 13px; font-weight: 700; cursor: pointer;
          white-space: nowrap; border: none;
          transition: all 0.2s;
        }
        .rv-btn-ic { font-size: 14px; }
        .rv-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .rv-btn-mention {
          background: rgba(124, 77, 255, 0.12);
          color: #c8cdf5;
          border: 1px solid rgba(124, 77, 255, 0.4);
        }
        .rv-btn-mention:hover:not(:disabled) { background: rgba(124,77,255,0.25); }
        .rv-btn-discuss {
          background: linear-gradient(90deg, #4a6cf7, #7c4dff);
          color: #fff;
          box-shadow: 0 4px 18px rgba(124, 77, 255, 0.5);
        }
        .rv-btn-discuss:hover:not(:disabled) {
          box-shadow: 0 6px 26px rgba(124,77,255,0.7);
          transform: translateY(-1px);
        }

        /* scrollbars */
        .rv-panel-scroll::-webkit-scrollbar,
        .rv-speech::-webkit-scrollbar { width: 6px; }
        .rv-panel-scroll::-webkit-scrollbar-thumb,
        .rv-speech::-webkit-scrollbar-thumb { background: rgba(124,77,255,0.4); border-radius: 4px; }
        .rv-panel-scroll::-webkit-scrollbar-track,
        .rv-speech::-webkit-scrollbar-track { background: transparent; }

        /* loading */
        .rv-loading {
          height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center;
          gap: 14px; color: #9aa3d6; background: #0a0c24;
        }
        .rv-loading-spinner {
          width: 40px; height: 40px;
          border: 3px solid rgba(124,77,255,0.2);
          border-top-color: #a67cff;
          border-radius: 50%;
          animation: rv-spin 0.9s linear infinite;
        }
        @keyframes rv-spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}

// ── Message bubble sub-component ───────────────────────────

const MeetingMessageBubble: React.FC<{
  message: MeetingMessage
  isActive?: boolean
}> = ({ message, isActive }) => {
  const isUser = message.speakerAgentCode === null && !message.speakerRoleName
  const isOrchestrator = message.speakerAgentCode === null && !!message.speakerRoleName
  const isError = message.error

  const className = [
    'rv-msg',
    isError ? 'rv-msg-error' : '',
    isOrchestrator ? 'rv-msg-orch' : '',
    isActive ? 'rv-msg-active' : '',
  ]
    .filter(Boolean)
    .join(' ')

  const avatarColor = message.speakerAgentCode
    ? hashColor(message.speakerAgentCode)
    : undefined

  return (
    <div className={className}>
      {!isUser && (
        <span
          className="rv-msg-avatar"
          style={avatarColor ? { backgroundColor: avatarColor } : undefined}
        >
          {resolveInitial({ agent_name: message.speakerRoleName, agent_code: message.speakerAgentCode })}
        </span>
      )}
      <div className="rv-msg-body">
        <div className="rv-msg-meta">
          <span className="rv-msg-name">{message.speakerRoleName || (isUser ? '我' : '')}</span>
          {isActive && <span className="rv-msg-sound" />}
          <span className="rv-msg-time">
            {new Date(message.timestamp).toLocaleTimeString('zh-CN', {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        </div>
        <div className="rv-msg-text">
          {message.text}
          {message.streaming && <span className="rv-stream-cursor" />}
        </div>
        {message.artifacts && message.artifacts.length > 0 && (
          <details className="rv-msg-artifacts">
            <summary>📎 工具调用 ({message.artifacts.length})</summary>
            {message.artifacts.map((a, i) => (
              <div key={i} className="rv-artifact-item">
                <strong>{a.name}</strong>: {a.content.slice(0, 200)}
                {a.content.length > 200 ? '...' : ''}
              </div>
            ))}
          </details>
        )}
      </div>
    </div>
  )
}

export default MeetingView
