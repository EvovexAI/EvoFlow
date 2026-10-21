/**
 * 员工工作空间：在当前员工下切换 / 新开对话会话（duty·task·chat）。
 */
import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/tauri-api.js'
import { DropdownSelect, type DropdownSelectGroup } from './DropdownSelect.js'
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

function rowLabel(r: EmployeeConversationRow, preferTaskId?: boolean): string {
  const title = preferTaskId
    ? r.title || r.task_id || r.session_key
    : r.title || r.session_key
  const running = r.run_status === 'running' ? ' · 运行中' : ''
  return `[${kindLabel(r.kind)}] ${title}${running}`
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

  const groups = useMemo(() => {
    const taskRows = rows.filter((r) => r.kind === 'task')
    const otherRows = rows.filter((r) => r.kind !== 'task')
    const out: DropdownSelectGroup[] = []
    if (taskRows.length) {
      out.push({
        label: '任务会话',
        options: taskRows.map((r) => ({
          value: r.session_key,
          label: rowLabel(r, true),
        })),
      })
    }
    if (otherRows.length) {
      out.push({
        label: '其他',
        options: otherRows.map((r) => ({
          value: r.session_key,
          label: rowLabel(r),
        })),
      })
    }
    return out
  }, [rows])

  if (!code) return null

  return (
    <div className="employee-workspace-switcher" title="该员工工作空间下的会话">
      <label className="employee-workspace-switcher-label">
        <span className="sr-only">员工会话</span>
        <DropdownSelect
          variant="pill"
          placement="up"
          portal
          disabled={loading}
          className="employee-workspace-dropdown"
          value={activeSessionKey || ''}
          placeholder="选择会话…"
          aria-label="员工会话"
          options={[
            { value: '', label: '选择会话…' },
            { value: '__new_chat__', label: '＋ 新开对话' },
          ]}
          groups={groups}
          onChange={(v) => {
            const next = String(v || '').trim()
            if (next === '__new_chat__') {
              const stamp = mintEmployeeChatEpisodeId().replace(/^chat:/, '')
              const sk = `proactive:${code}:chat:${stamp.replace(/[:/\\]/g, '-')}`
              onNewChatSession(sk)
              return
            }
            if (next) onSelectSession(next)
          }}
        />
      </label>
    </div>
  )
}
