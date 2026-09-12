import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/tauri-api.js'
import { messagesToSubtaskModalRows } from '../../lib/subtask-modal-rows.js'
import { fetchProactiveTranscript } from '../../lib/proactive-session-messages.js'
import { SubtaskExecutionDrawer } from './SubtaskExecutionDrawer.js'

export type ProactiveLiveProcessHostProps = {
  open: boolean
  agentCode: string
  roleName?: string
  busy?: boolean
  title?: string
  roundId?: string
  taskId?: string
  pollMs?: number
  onClose: () => void
}

function rowsToPlainText(rows: any[]): string {
  return (Array.isArray(rows) ? rows : [])
    .map((r) => {
      const role = String(r?.role || '').trim()
      const text = String(r?.text || r?.reasoningPreview || '').trim()
      const tools = Array.isArray(r?.tools) ? r.tools : []
      const toolLine = tools
        .map((t: any) => {
          const name = String(t?.name || t?.tool || '工具').trim()
          const out = String(t?.output || t?.result || '').trim()
          return out ? `[工具 ${name}]\n${out}` : `[工具 ${name}]`
        })
        .join('\n')
      const parts = [role ? `[${role}]` : '', text, toolLine].filter(Boolean)
      return parts.join('\n')
    })
    .filter(Boolean)
    .join('\n\n')
}

/**
 * 智能体员工 / 任务「执行过程」：与主对话子任务/自代理同款居中历史弹窗（SubtaskExecutionDrawer）。
 * 不再使用 rowTimeLeft 轨迹布局，避免每个工具返回单独显示时间。
 */
export function ProactiveLiveProcessHost({
  open,
  agentCode,
  roleName = '',
  busy = false,
  title,
  roundId,
  taskId = '',
  pollMs = 1400,
  onClose,
}: ProactiveLiveProcessHostProps) {
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [fetchError, setFetchError] = useState('')
  const [resolvedRoleName, setResolvedRoleName] = useState(roleName)
  const [sessionKey, setSessionKey] = useState('')

  const code = String(agentCode || '').trim()
  const rid = String(roundId || '').trim()
  const tid = String(taskId || '').trim()

  useEffect(() => {
    setResolvedRoleName(roleName)
  }, [roleName])

  useEffect(() => {
    if (!open || !code) return
    let cancelled = false
    void (async () => {
      try {
        const role = await api.proactiveGetRole(code).catch(() => null)
        if (cancelled) return
        const name = String(role?.role_name || role?.name || roleName || '').trim()
        if (name) setResolvedRoleName(name)
      } catch {
        /* optional */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, code, roleName])

  useEffect(() => {
    if (!open || !code) {
      queueMicrotask(() => {
        setRows([])
        setFetchError('')
        setLoading(false)
        setSessionKey('')
      })
      return
    }

    let cancelled = false
    let first = true

    const load = async () => {
      if (first) setLoading(true)
      try {
        const res = await fetchProactiveTranscript({
          agentCode: code,
          taskId: tid,
          roundId: rid,
        })
        if (cancelled) return
        const msgs = Array.isArray(res?.messages) ? res.messages : []
        setRows(messagesToSubtaskModalRows(msgs))
        setSessionKey(String(res?.session_key || '').trim())
        setFetchError(String(res?.error || '').trim())
      } catch (e: any) {
        if (!cancelled) setFetchError(String(e?.message || e || '加载失败'))
      } finally {
        if (!cancelled) {
          setLoading(false)
          first = false
        }
      }
    }

    void load()
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void load()
    }, Math.max(800, Number(pollMs) || 1400))
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [open, code, rid, tid, pollMs])

  const displayRows = useMemo(() => {
    if (rows.length || loading) return rows
    if (fetchError) {
      return [
        {
          role: 'assistant',
          text: `无法加载会话：${fetchError}`,
          tools: [],
          segments: [{ kind: 'text', text: `无法加载会话：${fetchError}` }],
        },
      ]
    }
    return []
  }, [rows, loading, fetchError])

  const summaryAgent = String(resolvedRoleName || roleName || code).trim()
  const shortTitle = String(title || '').trim() || (busy ? '执行过程 · 进行中' : '执行过程')
  const statusLabel = busy
    ? '执行中'
    : loading
      ? '加载中'
      : displayRows.length
        ? '已完成'
        : '暂无记录'
  const statusClass = busy
    ? 'react-chat-subtask-status-light--run'
    : displayRows.length
      ? 'react-chat-subtask-status-light--ok'
      : 'react-chat-subtask-status-light--muted'

  if (!open || !code) return null

  return (
    <SubtaskExecutionDrawer
      open
      mode="modal"
      subtaskId={String(tid || rid || code)}
      sessionKey={sessionKey}
      statusClass={statusClass}
      statusLabel={statusLabel}
      summaryAgent={summaryAgent}
      shortTitle={shortTitle}
      rows={displayRows}
      streamActive={busy}
      sending={false}
      canCompose={false}
      composeText=""
      composeError=""
      copyPlainText={rowsToPlainText(displayRows) || '暂无记录'}
      showDetailButton={false}
      onClose={onClose}
      onComposeTextChange={() => {}}
      onSend={() => {}}
    />
  )
}
