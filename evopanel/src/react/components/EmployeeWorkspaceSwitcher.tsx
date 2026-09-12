/**
 * 员工工作空间：在当前员工下切换 / 新开对话会话（duty·task·chat）。
 */
import { useEffect, useState } from 'react'
import { api } from '../../lib/tauri-api.js'
import {
  mintEmployeeChatEpisodeId,
  type EmployeeTalkMode,
} from './EmployeeTalkModeBar.js'

export type EmployeeConversationRow = {
  session_key: string
  title?: string
  kind?: string
  task_id?: string | null
  run_status?: string
  updated_at?: string
  legacy?: boolean
}

export type EmployeeWorkspaceSwitcherProps = {
  agentCode: string
  activeSessionKey: string
  onSelectSession: (sessionKey: string) => void
  onNewChatSession: (sessionKey: string) => void
  talkMode?: EmployeeTalkMode
}

function kindLabel(kind: string | undefined): string {
  const k = String(kind || '').trim()
  if (k === 'task') return '任务'
  if (k === 'duty') return '值班'
  if (k === 'chat') return '对话'
  if (k === 'legacy') return '旧会话'
  return k || '会话'
}

export function EmployeeWorkspaceSwitcher({
  agentCode,
  activeSessionKey,
  onSelectSession,
  onNewChatSession,
}: EmployeeWorkspaceSwitcherProps) {
  const [rows, setRows] = useState<EmployeeConversationRow[]>([])
  const [loading, setLoading] = useState(false)
  const code = String(agentCode || '').trim()

  useEffect(() => {
    let cancelled = false
    if (!code) {
      setRows([])
      return
    }
    setLoading(true)
    void (async () => {
      try {
        const res = await api.proactiveListConversations(code, { limit: 40 })
        if (cancelled) return
        const list = Array.isArray(res?.conversations) ? res.conversations : []
        setRows(list)
      } catch {
        if (!cancelled) setRows([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code, activeSessionKey])

  if (!code) return null

  const taskRows = rows.filter((r) => r.kind === 'task')
  const otherRows = rows.filter((r) => r.kind !== 'task')

  return (
    <div className="employee-workspace-switcher" title="该员工工作空间下的会话">
      <label className="employee-workspace-switcher-label">
        <span className="sr-only">员工会话</span>
        <select
          className="employee-talk-resume-select"
          value={activeSessionKey || ''}
          disabled={loading}
          onChange={(e) => {
            const v = String(e.target.value || '').trim()
            if (v === '__new_chat__') {
              const stamp = mintEmployeeChatEpisodeId().replace(/^chat:/, '')
              const sk = `proactive:${code}:chat:${stamp.replace(/[:/\\]/g, '-')}`
              onNewChatSession(sk)
              return
            }
            if (v) onSelectSession(v)
          }}
        >
          <option value="">选择会话…</option>
          <option value="__new_chat__">＋ 新开对话</option>
          {taskRows.length ? (
            <optgroup label="任务会话">
              {taskRows.map((r) => (
                <option key={r.session_key} value={r.session_key}>
                  [{kindLabel(r.kind)}] {r.title || r.task_id || r.session_key}
                  {r.run_status === 'running' ? ' · 运行中' : ''}
                </option>
              ))}
            </optgroup>
          ) : null}
          {otherRows.length ? (
            <optgroup label="其他">
              {otherRows.map((r) => (
                <option key={r.session_key} value={r.session_key}>
                  [{kindLabel(r.kind)}] {r.title || r.session_key}
                  {r.run_status === 'running' ? ' · 运行中' : ''}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
      </label>
    </div>
  )
}
