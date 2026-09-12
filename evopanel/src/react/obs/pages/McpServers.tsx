import { useEffect, useState } from 'react'
import { fetchObsMcpStatus } from '../lib/obs-api'

interface McpTool {
  name: string
  full_name: string
  description: string
}

interface McpServer {
  name: string
  enabled: boolean
  transport: string
  load_status: 'disabled' | 'pending' | 'ready' | 'error'
  error?: string | null
  tool_count: number
  tools: McpTool[]
  command?: string
  args?: string[]
  url?: string
}

interface McpStatus {
  config_path: string
  config_exists: boolean
  config_stale?: boolean
  cache_initialized: boolean
  init_error?: string | null
  total_tools: number
  servers: McpServer[]
}

type LoadStatus = McpServer['load_status']

function StatusDot({ status }: { status: LoadStatus }) {
  const className =
    status === 'ready'
      ? 'obs-status-dot obs-status-success'
      : status === 'error'
        ? 'obs-status-dot obs-status-error'
        : status === 'pending'
          ? 'obs-status-dot obs-status-warning'
          : 'obs-status-dot obs-status-disabled'
  const title =
    status === 'ready'
      ? 'Connected — tools loaded'
      : status === 'error'
        ? 'Failed to load'
        : status === 'pending'
          ? 'Loading…'
          : 'Disabled in config'
  return <span className={className} title={title} aria-label={title} />
}

function StatusLabel({ status, error }: { status: LoadStatus; error?: string | null }) {
  if (status === 'ready') {
    return <span className="obs-status-badge obs-status-success">Available</span>
  }
  if (status === 'error') {
    return <span className="obs-status-badge obs-status-error" title={error || undefined}>Failed</span>
  }
  if (status === 'pending') {
    return <span className="obs-status-badge obs-status-warning">Loading</span>
  }
  return <span className="obs-status-badge obs-status-disabled">Disabled</span>
}

function ServerIcon({ name }: { name: string }) {
  const initial = (name[0] || '?').toUpperCase()
  const colors: Record<string, string> = {
    b: '#4ade80',
    e: '#60a5fa',
    f: '#f472b6',
    s: '#fbbf24',
    t: '#c084fc',
    p: '#fb923c',
    d: '#2dd4bf',
    m: '#f87171',
    g: '#a3e635',
    h: '#38bdf8',
  }
  const color = colors[initial.toLowerCase()] || '#94a3b8'
  return (
    <div
      style={{
        width: 28,
        height: 28,
        borderRadius: 6,
        background: `${color}18`,
        border: `1px solid ${color}40`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 13,
        fontWeight: 700,
        color,
        flexShrink: 0,
      }}
    >
      {initial}
    </div>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      aria-label={checked ? 'Disable' : 'Enable'}
      style={{
        width: 36,
        height: 20,
        borderRadius: 10,
        border: 'none',
        background: checked ? '#3b82f6' : '#475569',
        cursor: 'pointer',
        position: 'relative',
        transition: 'background 0.2s',
        flexShrink: 0,
        padding: 0,
      }}
    >
      <div
        style={{
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: '#fff',
          position: 'absolute',
          top: 2,
          left: checked ? 18 : 2,
          transition: 'left 0.2s',
          boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
        }}
      />
    </button>
  )
}

function ToolCountBadge({ count, status }: { count: number; status: LoadStatus }) {
  if (status === 'disabled') {
    return <span style={{ color: '#64748b', fontSize: 12 }}>disabled in config</span>
  }
  if (status === 'pending') {
    return <span style={{ color: '#f59e0b', fontSize: 12 }}>waiting for load…</span>
  }
  if (status === 'error') {
    return <span style={{ color: '#ef4444', fontSize: 12 }}>load failed</span>
  }
  return (
    <span style={{ color: '#94a3b8', fontSize: 12 }}>
      {count} tool{count !== 1 ? 's' : ''} loaded
    </span>
  )
}

export function McpServers() {
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedServer, setExpandedServer] = useState<string | null>(null)

  useEffect(() => {
    loadStatus()
  }, [])

  async function loadStatus() {
    try {
      setLoading(true)
      setError(null)
      const data = await fetchObsMcpStatus()
      setStatus(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load MCP status')
    } finally {
      setLoading(false)
    }
  }

  function handleToggle(_serverName: string) {
    // TODO: call backend to toggle server enabled state
    // For now just visual feedback
  }

  if (loading) {
    return (
      <div className="obs-page">
        <div className="obs-loading">Loading MCP servers…</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="obs-page">
        <div className="obs-error">Error: {error}</div>
      </div>
    )
  }

  if (!status) return null

  const pendingCount = status.servers.filter((s) => s.load_status === 'pending').length
  const errorCount = status.servers.filter((s) => s.load_status === 'error').length
  const readyCount = status.servers.filter((s) => s.load_status === 'ready').length

  return (
    <div className="obs-page">
      <div className="obs-page-header">
        <h1 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>MCP Servers</h1>
        <button className="obs-btn" onClick={loadStatus} style={{ fontSize: 12, padding: '4px 10px' }}>
          ↻ Refresh
        </button>
      </div>

      {status.config_stale && (
        <div
          style={{
            marginBottom: 12,
            padding: '8px 12px',
            fontSize: 12,
            color: '#fbbf24',
            background: 'rgba(245, 158, 11, 0.08)',
            border: '1px solid rgba(245, 158, 11, 0.2)',
            borderRadius: 8,
          }}
        >
          mcp.json changed on disk — reload will run on next agent request or after Gateway restart. Refresh this page shortly.
        </div>
      )}

      {!status.cache_initialized && status.servers.some((s) => s.enabled) && (
        <div
          style={{
            marginBottom: 12,
            padding: '8px 12px',
            fontSize: 12,
            color: '#fbbf24',
            background: 'rgba(245, 158, 11, 0.08)',
            border: '1px solid rgba(245, 158, 11, 0.2)',
            borderRadius: 8,
          }}
        >
          Gateway is loading MCP servers in the background. Cards show yellow until each server connects.
        </div>
      )}

      {status.init_error && (
        <div
          style={{
            marginBottom: 12,
            padding: '8px 12px',
            fontSize: 12,
            color: '#fca5a5',
            background: 'rgba(239, 68, 68, 0.08)',
            border: '1px solid rgba(239, 68, 68, 0.2)',
            borderRadius: 8,
          }}
        >
          {status.init_error}
        </div>
      )}

      {status.cache_initialized && errorCount > 0 && (
        <div
          style={{
            marginBottom: 12,
            padding: '8px 12px',
            fontSize: 12,
            color: '#fca5a5',
            background: 'rgba(239, 68, 68, 0.06)',
            border: '1px solid rgba(239, 68, 68, 0.15)',
            borderRadius: 8,
          }}
        >
          {errorCount} server{errorCount !== 1 ? 's' : ''} failed to load
          {readyCount > 0 ? ` · ${readyCount} available` : ''}
        </div>
      )}

      {status.servers.length === 0 ? (
        <div
          style={{
            textAlign: 'center',
            padding: 40,
            color: '#64748b',
            fontSize: 13,
          }}
        >
          No MCP servers configured
          <div style={{ marginTop: 8, fontSize: 12, color: '#475569' }}>
            Edit <code style={{ background: '#1e293b', padding: '2px 6px', borderRadius: 4 }}>mcp.json</code> to add servers
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {status.servers.map((server) => {
            const isExpanded = expandedServer === server.name
            const borderAccent =
              server.load_status === 'ready'
                ? 'rgba(16, 185, 129, 0.35)'
                : server.load_status === 'error'
                  ? 'rgba(239, 68, 68, 0.35)'
                  : server.load_status === 'pending'
                    ? 'rgba(245, 158, 11, 0.35)'
                    : 'rgba(255,255,255,0.06)'
            return (
              <div key={server.name}>
                <div
                  onClick={() => setExpandedServer(isExpanded ? null : server.name)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '10px 12px',
                    cursor: 'pointer',
                    borderBottom: '1px solid rgba(255,255,255,0.06)',
                    borderLeft: `3px solid ${borderAccent}`,
                    background: isExpanded ? 'rgba(59,130,246,0.06)' : 'transparent',
                    transition: 'background 0.15s',
                  }}
                >
                  <StatusDot status={server.load_status} />
                  <ServerIcon name={server.name} />

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {server.name}
                      </div>
                      <StatusLabel status={server.load_status} error={server.error} />
                    </div>
                    <div style={{ marginTop: 2 }}>
                      <ToolCountBadge count={server.tool_count} status={server.load_status} />
                    </div>
                  </div>

                  {/* Expand indicator */}
                  <span
                    style={{
                      color: '#64748b',
                      fontSize: 14,
                      transform: isExpanded ? 'rotate(180deg)' : 'none',
                      transition: 'transform 0.2s',
                      flexShrink: 0,
                    }}
                  >
                    
                  </span>

                  {/* Toggle */}
                  <Toggle checked={server.enabled} onChange={() => handleToggle(server.name)} />
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div
                    style={{
                      padding: '8px 12px 12px 52px',
                      borderBottom: '1px solid rgba(255,255,255,0.06)',
                      background: 'rgba(0,0,0,0.15)',
                    }}
                  >
                    {server.load_status === 'error' && server.error && (
                      <div
                        style={{
                          marginBottom: 10,
                          padding: '8px 10px',
                          fontSize: 12,
                          color: '#fca5a5',
                          background: 'rgba(239, 68, 68, 0.08)',
                          borderRadius: 6,
                          fontFamily: 'monospace',
                          wordBreak: 'break-word',
                        }}
                      >
                        {server.error}
                      </div>
                    )}
                    {server.tools.length > 0 && (
                      <>
                        <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
                          Tools
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {server.tools.map((tool) => (
                            <div
                              key={tool.full_name}
                              style={{
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: 8,
                                padding: '6px 8px',
                                borderRadius: 6,
                                background: 'rgba(255,255,255,0.03)',
                              }}
                            >
                              <span style={{ color: '#60a5fa', fontSize: 12, fontFamily: 'monospace', flexShrink: 0 }}>
                                {tool.name}
                              </span>
                              {tool.description && (
                                <span style={{ color: '#64748b', fontSize: 12, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                                  {tool.description}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                    {server.load_status === 'ready' && server.tools.length === 0 && (
                      <div style={{ fontSize: 12, color: '#64748b' }}>Connected — no tools exposed by this server.</div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Footer info */}
      <div style={{ marginTop: 16, padding: '10px 12px', fontSize: 11, color: '#475569', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <span>
          {status.config_exists ? '✓' : ''} {status.config_path}
        </span>
        <span>
          {readyCount} ready · {pendingCount} loading · {errorCount} failed · {status.total_tools} tools
        </span>
      </div>
    </div>
  )
}
