/**
 * MeetingLauncher - modal for creating a new group meeting.
 *
 * Lists available A2A agents, lets the user pick participants + enter a title,
 * then calls createMeeting() and hands off to MeetingView.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { A2AClient, type AgentCard, type MeetingParticipant } from '../../lib/a2a-client'
import { useGatewayBaseUrl } from '../hooks/useGatewayBaseUrl'
import { resolveInitial, hashColor } from '../lib/agent-avatar'

// ── Props ──────────────────────────────────────────────────

export interface MeetingLauncherProps {
  open: boolean
  onClose: () => void
  /** Called after a meeting is successfully created. */
  onMeetingCreated: (meetingId: string, participants: MeetingParticipant[]) => void
  /** Optional: pre-select these agent codes. */
  preselectedAgents?: string[]
}

// ── Component ──────────────────────────────────────────────

export const MeetingLauncher: React.FC<MeetingLauncherProps> = ({
  open,
  onClose,
  onMeetingCreated,
  preselectedAgents,
}) => {
  const { baseUrl, ready } = useGatewayBaseUrl()
  const clientRef = useRef<A2AClient | null>(null)
  const [agents, setAgents] = useState<AgentCard[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set(preselectedAgents ?? []))
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  // Init / update client
  useEffect(() => {
    if (!ready) return
    if (!clientRef.current) {
      clientRef.current = new A2AClient(baseUrl)
    } else {
      clientRef.current.setBaseUrl(baseUrl)
    }
  }, [baseUrl, ready])

  // Fetch agents when modal opens
  useEffect(() => {
    if (!open || !ready || !clientRef.current) return
    setLoading(true)
    setError('')
    clientRef.current
      .listAgentsPanel()
      .then((cards) => {
        setAgents(cards)
        // Pre-select all if none pre-selected and list is small
        if (!preselectedAgents?.length && cards.length > 0 && selected.size === 0) {
          // Don't auto-select; let user pick
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ready])

  const toggleAgent = useCallback((code: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })
  }, [])

  const handleCreate = useCallback(async () => {
    if (!clientRef.current || selected.size === 0) return
    setCreating(true)
    setError('')
    try {
      const result = await clientRef.current.createMeeting(
        title.trim() || '群聊会议',
        Array.from(selected),
      )
      onMeetingCreated(result.meeting_id, result.participants)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }, [title, selected, agents, onMeetingCreated])

  if (!open) return null

  return (
    <div className="rv-launcher-overlay" onClick={onClose}>
      <div className="rv-launcher-bg-grid" />
      <div className="rv-launcher-bg-glow rv-launcher-bg-glow-1" />
      <div className="rv-launcher-bg-glow rv-launcher-bg-glow-2" />
      <div className="rv-launcher-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="rv-launcher-header">
          <div className="rv-launcher-title-wrap">
            <span className="rv-launcher-icon">⚡</span>
            <h3 className="rv-launcher-title">发起 AI员工聊天</h3>
          </div>
          <div className="rv-launcher-subtitle">
            选择参会员工，开启多智能体协作讨论
          </div>
          <button type="button" className="rv-launcher-close" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="rv-launcher-body">
          {/* Title input */}
          <div className="rv-launcher-field">
            <label className="rv-launcher-label">
              <span className="rv-launcher-label-ic">🛰</span>
              会议主题
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="输入会议主题，例如：如何让产品在抖音获得第一批用户？"
              className="rv-launcher-input"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !creating && selected.size > 0) {
                  void handleCreate()
                }
              }}
            />
          </div>

          {/* Agent selection */}
          <div className="rv-launcher-field">
            <label className="rv-launcher-label">
              <span className="rv-launcher-label-ic">👥</span>
              选择参会员工
              <span className="rv-launcher-count">
                {loading ? '加载中…' : `${agents.length} 个可用 · 已选 ${selected.size}`}
              </span>
            </label>
            {error && <div className="rv-launcher-error">{error}</div>}
            <div className="rv-launcher-agent-list">
              {agents.map((agent) => {
                const isSelected = selected.has(agent.agent_code)
                const color = hashColor(agent.name || agent.agent_code)
                return (
                  <div
                    key={agent.agent_code}
                    className={`rv-launcher-agent-card${isSelected ? ' selected' : ''}`}
                    onClick={() => toggleAgent(agent.agent_code)}
                    style={isSelected ? { '--card-glow': color } as React.CSSProperties : undefined}
                  >
                    <div className="rv-launcher-avatar-wrap">
                      <div
                        className="rv-launcher-avatar"
                        style={{ backgroundColor: color }}
                      >
                        {resolveInitial({ agent_code: agent.agent_code, agent_name: agent.name })}
                      </div>
                      {isSelected && (
                        <div className="rv-launcher-check-ring">
                          <span>✓</span>
                        </div>
                      )}
                    </div>
                    <div className="rv-launcher-agent-info">
                      <div className="rv-launcher-agent-name">{agent.name}</div>
                      <div className="rv-launcher-agent-desc">
                        <span className="rv-launcher-agent-dept">{agent.department || '通用'}</span>
                        <span className="rv-launcher-agent-bio">
                          {agent.description?.slice(0, 50) || '智能体员工'}
                        </span>
                      </div>
                    </div>
                  </div>
                )
              })}
              {!loading && agents.length === 0 && !error && (
                <div className="rv-launcher-empty">
                  <span className="rv-launcher-empty-ic">🤖</span>
                  <p>暂无可用员工</p>
                  <p className="rv-launcher-empty-hint">请先在「角色管理」中创建智能体员工</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="rv-launcher-footer">
          <button
            type="button"
            className="rv-launcher-btn rv-launcher-btn-cancel"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="rv-launcher-btn rv-launcher-btn-create"
            disabled={creating || selected.size === 0}
            onClick={() => void handleCreate()}
          >
            <span className="rv-launcher-btn-ic">✈</span>
            {creating ? '创建中…' : `开始聊天${selected.size > 0 ? `（${selected.size}人）` : ''}`}
          </button>
        </div>

        <style>{`
          .rv-launcher-overlay {
            position: fixed; inset: 0;
            background: rgba(8, 10, 30, 0.75);
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            display: flex; align-items: center; justify-content: center;
            z-index: 9999;
            animation: rv-overlay-in 0.25s ease;
          }
          @keyframes rv-overlay-in { from { opacity: 0; } to { opacity: 1; } }
          .rv-launcher-bg-grid {
            position: absolute; inset: 0; pointer-events: none;
            background-image:
              radial-gradient(circle at 1px 1px, rgba(124, 77, 255, 0.1) 1px, transparent 1px);
            background-size: 28px 28px;
            opacity: 0.6;
            mask-image: radial-gradient(ellipse at center, rgba(0,0,0,0.9), transparent 80%);
          }
          .rv-launcher-bg-glow {
            position: absolute; border-radius: 50%;
            filter: blur(120px); opacity: 0.3; pointer-events: none;
          }
          .rv-launcher-bg-glow-1 { width: 500px; height: 500px; background: #4a6cf7; top: -150px; left: -100px; }
          .rv-launcher-bg-glow-2 { width: 450px; height: 450px; background: #7c4dff; bottom: -180px; right: -80px; }

          .rv-launcher-modal {
            position: relative;
            width: min(720px, 92vw);
            max-height: 85vh;
            display: flex; flex-direction: column;
            background: linear-gradient(160deg, rgba(26, 32, 72, 0.85), rgba(14, 16, 46, 0.9));
            border: 1px solid rgba(124, 77, 255, 0.35);
            border-radius: 18px;
            box-shadow:
              0 20px 60px rgba(0, 0, 0, 0.5),
              0 0 40px rgba(74, 108, 247, 0.2),
              inset 0 1px 0 rgba(255, 255, 255, 0.06);
            overflow: hidden;
            animation: rv-modal-in 0.35s cubic-bezier(0.16, 1, 0.3, 1);
          }
          @keyframes rv-modal-in {
            from { opacity: 0; transform: translateY(20px) scale(0.96); }
            to { opacity: 1; transform: translateY(0) scale(1); }
          }

          /* header */
          .rv-launcher-header {
            position: relative;
            padding: 22px 28px 18px;
            border-bottom: 1px solid rgba(124, 77, 255, 0.2);
            background: linear-gradient(180deg, rgba(74, 108, 247, 0.1), transparent);
          }
          .rv-launcher-title-wrap { display: flex; align-items: center; gap: 10px; }
          .rv-launcher-icon {
            font-size: 22px;
            filter: drop-shadow(0 0 8px rgba(124, 77, 255, 0.8));
          }
          .rv-launcher-title {
            margin: 0;
            font-size: 20px; font-weight: 800;
            background: linear-gradient(90deg, #6ea8ff, #a67cff);
            -webkit-background-clip: text;
            background-clip: text;
            -webkit-text-fill-color: transparent;
            letter-spacing: 0.5px;
          }
          .rv-launcher-subtitle {
            margin-top: 6px;
            font-size: 13px; color: #8ea4ff;
          }
          .rv-launcher-close {
            position: absolute; top: 18px; right: 22px;
            width: 34px; height: 34px;
            display: flex; align-items: center; justify-content: center;
            background: rgba(124, 77, 255, 0.08);
            border: 1px solid rgba(124, 77, 255, 0.3);
            color: #b9c0f0;
            border-radius: 10px; font-size: 16px; cursor: pointer;
            transition: all 0.2s;
          }
          .rv-launcher-close:hover {
            background: rgba(255, 92, 138, 0.18);
            border-color: rgba(255, 92, 138, 0.5);
            color: #ff9cb4;
          }

          /* body */
          .rv-launcher-body {
            flex: 1; min-height: 0;
            overflow-y: auto;
            padding: 20px 28px;
            display: flex; flex-direction: column; gap: 18px;
          }
          .rv-launcher-body::-webkit-scrollbar { width: 6px; }
          .rv-launcher-body::-webkit-scrollbar-thumb { background: rgba(124,77,255,0.4); border-radius: 4px; }

          .rv-launcher-field { display: flex; flex-direction: column; gap: 8px; }
          .rv-launcher-label {
            display: flex; align-items: center; gap: 8px;
            font-size: 13px; font-weight: 700; color: #c8cdf5;
          }
          .rv-launcher-label-ic { font-size: 14px; }
          .rv-launcher-count {
            margin-left: auto;
            font-size: 11.5px; font-weight: 600; color: #8ea4ff;
            padding: 2px 10px; border-radius: 10px;
            background: rgba(124, 77, 255, 0.12);
          }
          .rv-launcher-input {
            padding: 12px 16px;
            font-size: 14px; color: #eef0ff;
            background: rgba(30, 34, 78, 0.6);
            border: 1px solid rgba(124, 77, 255, 0.35);
            border-radius: 12px;
            outline: none;
            transition: all 0.25s;
            box-shadow: inset 0 0 8px rgba(74, 108, 247, 0.06);
          }
          .rv-launcher-input::placeholder { color: #6b74a8; }
          .rv-launcher-input:focus {
            border-color: #a67cff;
            box-shadow: 0 0 18px rgba(124, 77, 255, 0.3), inset 0 0 8px rgba(74, 108, 247, 0.1);
          }
          .rv-launcher-error {
            padding: 10px 14px;
            font-size: 13px; color: #ff9cb4;
            background: rgba(255, 92, 138, 0.1);
            border: 1px solid rgba(255, 92, 138, 0.35);
            border-radius: 10px;
          }

          /* agent list */
          .rv-launcher-agent-list {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
            gap: 10px;
            max-height: 380px;
            overflow-y: auto;
            padding-right: 4px;
          }
          .rv-launcher-agent-list::-webkit-scrollbar { width: 6px; }
          .rv-launcher-agent-list::-webkit-scrollbar-thumb { background: rgba(124,77,255,0.4); border-radius: 4px; }

          .rv-launcher-agent-card {
            display: flex; align-items: center; gap: 12px;
            padding: 12px 14px;
            background: rgba(30, 34, 78, 0.5);
            border: 1px solid rgba(124, 77, 255, 0.2);
            border-radius: 12px;
            cursor: pointer;
            transition: all 0.25s ease;
            position: relative;
          }
          .rv-launcher-agent-card:hover {
            border-color: rgba(124, 77, 255, 0.5);
            background: rgba(124, 77, 255, 0.1);
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(74, 108, 247, 0.2);
          }
          .rv-launcher-agent-card.selected {
            border-color: var(--card-glow, #7c4dff);
            background: rgba(124, 77, 255, 0.18);
            box-shadow: 0 0 18px rgba(124, 77, 255, 0.35), inset 0 0 12px rgba(124, 77, 255, 0.1);
          }
          .rv-launcher-avatar-wrap {
            position: relative;
            width: 44px; height: 44px; flex-shrink: 0;
          }
          .rv-launcher-avatar {
            width: 44px; height: 44px;
            border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            font-size: 17px; font-weight: 800; color: white;
            border: 2px solid rgba(255, 255, 255, 0.25);
            box-shadow: 0 3px 10px rgba(0, 0, 0, 0.3);
          }
          .rv-launcher-check-ring {
            position: absolute;
            top: -4px; right: -4px;
            width: 20px; height: 20px;
            border-radius: 50%;
            background: linear-gradient(135deg, #4ade80, #22c55e);
            display: flex; align-items: center; justify-content: center;
            font-size: 11px; color: white; font-weight: 900;
            box-shadow: 0 0 10px rgba(74, 222, 128, 0.7);
            animation: rv-pop 0.3s ease;
          }
          @keyframes rv-pop {
            0% { transform: scale(0); }
            70% { transform: scale(1.2); }
            100% { transform: scale(1); }
          }
          .rv-launcher-agent-info { min-width: 0; flex: 1; }
          .rv-launcher-agent-name {
            font-size: 13.5px; font-weight: 700; color: #e3e6ff;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          }
          .rv-launcher-agent-desc {
            margin-top: 3px;
            display: flex; flex-direction: column; gap: 2px;
          }
          .rv-launcher-agent-dept {
            font-size: 11px; color: #8ea4ff; font-weight: 600;
          }
          .rv-launcher-agent-bio {
            font-size: 11px; color: #7f8ab8;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          }

          .rv-launcher-empty {
            grid-column: 1 / -1;
            text-align: center;
            padding: 40px 20px;
            color: #6b74a8;
          }
          .rv-launcher-empty-ic { font-size: 36px; }
          .rv-launcher-empty p { margin: 8px 0 0; font-size: 14px; font-weight: 600; color: #9aa3d6; }
          .rv-launcher-empty-hint { font-size: 12px; color: #6b74a8; font-weight: 400; }

          /* footer */
          .rv-launcher-footer {
            display: flex; justify-content: flex-end; gap: 12px;
            padding: 16px 28px 22px;
            border-top: 1px solid rgba(124, 77, 255, 0.2);
            background: linear-gradient(0deg, rgba(74, 108, 247, 0.08), transparent);
          }
          .rv-launcher-btn {
            display: inline-flex; align-items: center; gap: 8px;
            padding: 11px 22px;
            border-radius: 12px;
            font-size: 14px; font-weight: 700; cursor: pointer;
            border: none;
            transition: all 0.2s;
          }
          .rv-launcher-btn:disabled { opacity: 0.5; cursor: not-allowed; }
          .rv-launcher-btn-cancel {
            background: rgba(124, 77, 255, 0.1);
            color: #b9c0f0;
            border: 1px solid rgba(124, 77, 255, 0.35);
          }
          .rv-launcher-btn-cancel:hover { background: rgba(124, 77, 255, 0.2); }
          .rv-launcher-btn-create {
            background: linear-gradient(90deg, #4a6cf7, #7c4dff);
            color: #fff;
            box-shadow: 0 4px 20px rgba(124, 77, 255, 0.5);
          }
          .rv-launcher-btn-create:hover:not(:disabled) {
            box-shadow: 0 6px 28px rgba(124, 77, 255, 0.7);
            transform: translateY(-1px);
          }
          .rv-launcher-btn-ic { font-size: 15px; }
        `}</style>
      </div>
    </div>
  )
}
