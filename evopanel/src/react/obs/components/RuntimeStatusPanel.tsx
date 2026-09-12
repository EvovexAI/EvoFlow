import { useEffect, useState } from 'react'
import { fetchObsRuntimeStatus } from '../lib/obs-api'
import { Card } from './Card'

interface RuntimeStatus {
  timestamp?: string
  automation_scheduler?: {
    backend_loop_running?: boolean
    last_tick?: {
      task_count?: number
      active_tasks?: number
      fired_task_ids?: string[]
    }
    error?: string
  }
  task_queue?: {
    backend_loop_running?: boolean
    active_unattended?: number
    in_progress?: number
    queued_candidates?: number
    max_concurrent?: number
    error?: string
  }
  active_sessions?: {
    count?: number
    sessions?: Array<{
      thread_id?: string
      run_status?: string
      updated_at?: string
    }>
    error?: string
  }
  active_streams?: {
    count?: number
    streams?: Array<{
      thread_id?: string
      duration_seconds?: number
    }>
    error?: string
  }
  background_workers?: {
    total?: number
    active?: number
    workers?: Array<{
      thread_id?: string
      is_alive?: boolean
    }>
    error?: string
  }
  channel_service?: {
    running?: boolean
    channels?: Array<{
      name?: string
      enabled?: boolean
      running?: boolean
    }>
    error?: string
  }
  agent_activities?: {
    total?: number
    active_count?: number
    agents?: Array<{
      invocation_kind: string
      thread_id: string
      model: string
      requested_at: string
      latency_ms: number
      stage: string
      collab_phase: string
      is_active: boolean
      recent_calls_5min: number
    }>
    error?: string
  }
  summary?: {
    automation_running?: boolean
    task_queue_running?: boolean
    active_sessions_count?: number
    active_streams_count?: number
    active_workers_count?: number
    channel_service_running?: boolean
    active_agents_count?: number
  }
}

const AGENT_KIND_LABELS: Record<string, { label: string; icon: string }> = {
  main: { label: '主对话', icon: '💬' },
  subagent: { label: '子代理', icon: '🤖' },
  title: { label: '标题生成', icon: '📝' },
  mission_state: { label: '意图分析', icon: '🎯' },
  memory: { label: '长期记忆', icon: '🧠' },
  compress: { label: '上下文压缩', icon: '📦' },
  tool_summary: { label: '工具摘要', icon: '🔧' },
  hosted: { label: '目标对话', icon: '🏠' },
  hosted_panel: { label: '目标面板', icon: '📋' },
  hosted_closure: { label: '目标小结', icon: '📊' },
  session_intent: { label: '会话意图', icon: '💡' },
  auxiliary: { label: '辅助', icon: '⚙️' },
}

function formatTimeAgo(isoStr: string): string {
  if (!isoStr) return '-'
  const then = new Date(isoStr).getTime()
  const now = Date.now()
  const diff = now - then
  if (diff < 0) return '刚刚'
  if (diff < 60_000) return `${Math.floor(diff / 1000)}秒前`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`
  return `${Math.floor(diff / 86_400_000)}天前`
}

function StatusDot({ running }: { running: boolean }) {
  return (
    <span className={`runtime-status-dot ${running ? 'running' : 'stopped'}`}>
      {running ? '●' : '○'}
    </span>
  )
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

function AgentActivityCards({
  agents,
  activeCount,
  total,
  hero = false,
}: {
  agents: NonNullable<RuntimeStatus['agent_activities']>['agents']
  activeCount: number
  total: number
  hero?: boolean
}) {
  if (!agents?.length) {
    return <div className="obs-empty-state">暂无 Agent 类型记录</div>
  }

  return (
    <div className={`runtime-agent-grid ${hero ? 'hero-agent-grid' : ''}`}>
      {!hero && (
        <div className="runtime-section-header">
          <h4 className="runtime-section-title">Agent 工作状态</h4>
          <div className="runtime-section-stats">
            <span className="stat-badge active">
              <span className="stat-dot"></span>
              {activeCount} 活跃
            </span>
            <span className="stat-badge total">共 {total} 个</span>
          </div>
        </div>
      )}
      <div className={`runtime-agent-cards ${hero ? 'hero-agent-cards' : ''}`}>
        {agents.map((agent) => {
          const kindInfo = AGENT_KIND_LABELS[agent.invocation_kind] || { label: agent.invocation_kind, icon: '⚙️' }
          return (
            <div key={agent.invocation_kind} className={`runtime-agent-card ${agent.is_active ? 'active' : 'idle'}`}>
              {agent.is_active && <div className="agent-pulse-ring"></div>}
              <div className="runtime-agent-header">
                <div className="agent-icon-wrapper">
                  <span className="runtime-agent-icon">{kindInfo.icon}</span>
                </div>
                <div className="agent-title-group">
                  <span className="runtime-agent-name">{kindInfo.label}</span>
                  <span className={`agent-status-tag ${agent.is_active ? 'active' : 'idle'}`}>
                    {agent.is_active ? '运行中' : '空闲'}
                  </span>
                </div>
              </div>
              <div className="runtime-agent-details">
                {agent.is_active ? (
                  <>
                    <div className="runtime-agent-row">
                      <span className="row-label">对话</span>
                      <span className="row-value mono" title={agent.thread_id}>
                        {agent.thread_id ? `${agent.thread_id.slice(0, 8)}...` : '-'}
                      </span>
                    </div>
                    <div className="runtime-agent-row">
                      <span className="row-label">模型</span>
                      <span className="row-value">{agent.model || '-'}</span>
                    </div>
                    {agent.collab_phase && agent.collab_phase !== 'idle' && (
                      <div className="runtime-agent-row">
                        <span className="row-label">阶段</span>
                        <span className="row-value phase-tag">{agent.collab_phase}</span>
                      </div>
                    )}
                    <div className="agent-activity-bar">
                      <div
                        className="activity-bar-fill"
                        style={{ width: `${Math.min(100, agent.recent_calls_5min * 10)}%` }}
                      ></div>
                      <span className="activity-bar-label">{agent.recent_calls_5min} 次/5分钟</span>
                    </div>
                  </>
                ) : (
                  <div className="agent-idle-info">
                    <div className="idle-icon">◷</div>
                    <div className="idle-text">
                      <span className="idle-label">上次活动</span>
                      <span className="idle-value">{formatTimeAgo(agent.requested_at)}</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function RuntimeSummaryGrid({ status, summary }: { status: RuntimeStatus | null; summary: RuntimeStatus['summary'] }) {
  return (
    <div className="runtime-summary-grid">
      <div className={`runtime-summary-card ${summary?.automation_running ? 'active' : ''}`}>
        <StatusDot running={summary?.automation_running ?? false} />
        <div className="runtime-summary-info">
          <span className="runtime-summary-label">自动化调度</span>
          <span className="runtime-summary-value">{summary?.automation_running ? '运行中' : '已停止'}</span>
        </div>
      </div>
      <div className={`runtime-summary-card ${summary?.task_queue_running ? 'active' : ''}`}>
        <StatusDot running={summary?.task_queue_running ?? false} />
        <div className="runtime-summary-info">
          <span className="runtime-summary-label">任务队列</span>
          <span className="runtime-summary-value">{summary?.task_queue_running ? '运行中' : '已停止'}</span>
        </div>
      </div>
      <div className={`runtime-summary-card ${summary?.channel_service_running ? 'active' : ''}`}>
        <StatusDot running={summary?.channel_service_running ?? false} />
        <div className="runtime-summary-info">
          <span className="runtime-summary-label">Channel 服务</span>
          <span className="runtime-summary-value">{summary?.channel_service_running ? '运行中' : '已停止'}</span>
        </div>
      </div>
      <div className="runtime-summary-card active">
        <span className="runtime-count-badge">{summary?.active_sessions_count ?? 0}</span>
        <div className="runtime-summary-info">
          <span className="runtime-summary-label">活跃会话</span>
          <span className="runtime-summary-value">正在对话</span>
        </div>
      </div>
      <div className="runtime-summary-card active">
        <span className="runtime-count-badge">{summary?.active_workers_count ?? 0}</span>
        <div className="runtime-summary-info">
          <span className="runtime-summary-label">后台工作器</span>
          <span className="runtime-summary-value">处理中</span>
        </div>
      </div>
      <div className="runtime-summary-card active">
        <span className="runtime-count-badge">{status?.task_queue?.in_progress ?? 0}</span>
        <div className="runtime-summary-info">
          <span className="runtime-summary-label">任务中心</span>
          <span className="runtime-summary-value">执行中</span>
        </div>
      </div>
      <div className={`runtime-summary-card ${(summary?.active_agents_count ?? 0) > 0 ? 'active' : ''}`}>
        <span className="runtime-count-badge">{summary?.active_agents_count ?? 0}</span>
        <div className="runtime-summary-info">
          <span className="runtime-summary-label">Agent 活跃</span>
          <span className="runtime-summary-value">工作中</span>
        </div>
      </div>
    </div>
  )
}

function RuntimeDetailGrid({ status }: { status: RuntimeStatus | null }) {
  return (
    <div className="runtime-detail-grid">
      <div className="runtime-detail-section">
        <h4>自动化调度器</h4>
        {status?.automation_scheduler?.error ? (
          <div className="runtime-detail-error">{status.automation_scheduler.error}</div>
        ) : (
          <div className="runtime-detail-content">
            <div className="runtime-detail-row">
              <span>任务总数:</span>
              <strong>{status?.automation_scheduler?.last_tick?.task_count ?? 0}</strong>
            </div>
            <div className="runtime-detail-row">
              <span>活跃任务:</span>
              <strong>{status?.automation_scheduler?.last_tick?.active_tasks ?? 0}</strong>
            </div>
          </div>
        )}
      </div>
      <div className="runtime-detail-section">
        <h4>任务队列</h4>
        {status?.task_queue?.error ? (
          <div className="runtime-detail-error">{status.task_queue.error}</div>
        ) : (
          <div className="runtime-detail-content">
            <div className="runtime-detail-row">
              <span>最大并发:</span>
              <strong>{status?.task_queue?.max_concurrent ?? 0}</strong>
            </div>
            <div className="runtime-detail-row">
              <span>排队候选:</span>
              <strong>{status?.task_queue?.queued_candidates ?? 0}</strong>
            </div>
            <div className="runtime-detail-row">
              <span>执行中:</span>
              <strong className={status?.task_queue?.in_progress ? 'text-highlight' : ''}>
                {status?.task_queue?.in_progress ?? 0}
              </strong>
            </div>
          </div>
        )}
      </div>
      <div className="runtime-detail-section">
        <h4>活跃会话</h4>
        {status?.active_sessions?.error ? (
          <div className="runtime-detail-error">{status.active_sessions.error}</div>
        ) : status?.active_sessions?.sessions && status.active_sessions.sessions.length > 0 ? (
          <div className="runtime-session-list">
            {status.active_sessions.sessions.slice(0, 5).map((session, idx) => (
              <div key={idx} className="runtime-session-item">
                <span className="runtime-session-id">{session.thread_id?.slice(0, 8) ?? '...'}...</span>
                <span className={`runtime-session-status ${session.run_status}`}>{session.run_status}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="runtime-detail-empty">暂无活跃会话</div>
        )}
      </div>
      <div className="runtime-detail-section">
        <h4>活跃流</h4>
        {status?.active_streams?.error ? (
          <div className="runtime-detail-error">{status.active_streams.error}</div>
        ) : status?.active_streams?.streams && status.active_streams.streams.length > 0 ? (
          <div className="runtime-stream-list">
            {status.active_streams.streams.slice(0, 5).map((stream, idx) => (
              <div key={idx} className="runtime-stream-item">
                <span className="runtime-stream-id">{stream.thread_id?.slice(0, 8) ?? '...'}...</span>
                <span className="runtime-stream-duration">
                  {stream.duration_seconds ? formatDuration(stream.duration_seconds) : '-'}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="runtime-detail-empty">暂无活跃流</div>
        )}
      </div>
      <div className="runtime-detail-section">
        <h4>Channel 服务</h4>
        {status?.channel_service?.error ? (
          <div className="runtime-detail-error">{status.channel_service.error}</div>
        ) : status?.channel_service?.channels && status.channel_service.channels.length > 0 ? (
          <div className="runtime-channel-list">
            {status.channel_service.channels.map((ch, idx) => (
              <div key={idx} className="runtime-channel-item">
                <span className="runtime-channel-name">{ch.name}</span>
                <span className={`runtime-channel-status ${ch.running ? 'running' : 'stopped'}`}>
                  {ch.running ? '运行中' : '已停止'}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="runtime-detail-empty">暂无 Channel</div>
        )}
      </div>
    </div>
  )
}

export function RuntimeStatusPanel({ variant = 'full' }: { variant?: 'hero' | 'full' }) {
  const [status, setStatus] = useState<RuntimeStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)

  const fetchStatus = async (opts?: { initial?: boolean }) => {
    const isInitial = opts?.initial === true
    try {
      if (isInitial) setLoading(true)
      const res = await fetchObsRuntimeStatus()
      setStatus(res as RuntimeStatus)
      setError(null)
      setLastUpdate(new Date())
    } catch (e) {
      setError(e instanceof Error ? e.message : '获取状态失败')
    } finally {
      if (isInitial) setLoading(false)
    }
  }

  useEffect(() => {
    queueMicrotask(() => void fetchStatus({ initial: true }))
    const interval = setInterval(() => void fetchStatus(), 5000)
    return () => clearInterval(interval)
  }, [])

  const summary = status?.summary
  const agentActivities = status?.agent_activities
  const activeCount = agentActivities?.active_count ?? summary?.active_agents_count ?? 0
  const agentTotal = agentActivities?.total ?? agentActivities?.agents?.length ?? 0
  const isHero = variant === 'hero'

  const actions = (
    <div className="runtime-status-actions">
      {lastUpdate && (
        <span className="runtime-status-time">更新于 {lastUpdate.toLocaleTimeString()} · 5s 轮询</span>
      )}
      <button type="button" className="mini-btn" onClick={() => void fetchStatus()} disabled={loading}>
        {loading ? '...' : '↻ 刷新'}
      </button>
    </div>
  )

  if (isHero) {
    return (
      <Card
        title="Agent 实时状态"
        className="span-3 agent-live-hero runtime-status-panel"
        actions={actions}
      >
        {error && <div className="runtime-status-error">{error}</div>}

        <div className="agent-live-hero-head">
          <div className={`agent-live-hero-stat ${activeCount > 0 ? 'is-live' : ''}`}>
            <span className="agent-live-pulse-dot" aria-hidden />
            <div>
              <strong className="agent-live-count">{activeCount}</strong>
              <span className="agent-live-label">Agent 运行中</span>
            </div>
            <em className="agent-live-sub">/ 共 {agentTotal} 类 · 会话 {summary?.active_sessions_count ?? 0} · 流 {summary?.active_streams_count ?? 0}</em>
          </div>
          <div className="agent-live-pills">
            <span className={summary?.task_queue_running ? 'pill live' : 'pill'}>
              任务队列 {summary?.task_queue_running ? 'ON' : 'OFF'}
            </span>
            <span className="pill">执行中 {status?.task_queue?.in_progress ?? 0}</span>
            <span className="pill">排队 {status?.task_queue?.queued_candidates ?? 0}</span>
            <span className={summary?.channel_service_running ? 'pill live' : 'pill'}>
              Channel {summary?.channel_service_running ? 'ON' : 'OFF'}
            </span>
          </div>
        </div>

        {agentActivities && !agentActivities.error ? (
          <AgentActivityCards
            agents={agentActivities.agents}
            activeCount={activeCount}
            total={agentTotal}
            hero
          />
        ) : (
          <div className="obs-empty-state">{agentActivities?.error || '暂无 Agent 活动数据'}</div>
        )}

        <details className="agent-live-details">
          <summary>系统运行详情</summary>
          <RuntimeDetailGrid status={status} />
        </details>
      </Card>
    )
  }

  return (
    <Card
      title="实时运行状态"
      className="span-3 runtime-status-panel"
      actions={actions}
    >
      {error && <div className="runtime-status-error">{error}</div>}
      <RuntimeSummaryGrid status={status} summary={summary} />
      {agentActivities && !agentActivities.error && (agentActivities.agents?.length ?? 0) > 0 && (
        <AgentActivityCards
          agents={agentActivities.agents}
          activeCount={activeCount}
          total={agentTotal}
        />
      )}
      <RuntimeDetailGrid status={status} />
    </Card>
  )
}
