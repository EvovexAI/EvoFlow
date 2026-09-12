import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/tauri-api.js'
import { messagesToSubtaskModalRows } from '../../lib/subtask-modal-rows.js'
import { fetchProactiveTranscript } from '../../lib/proactive-session-messages.js'
import {
  decodeWorkProcessRunId,
  buildWorkProcessEvents,
  filterWorkProcessInternalEvents,
  buildWorkProcessRunRecord,
} from '../../lib/proactive-work-process.js'
import { ProactiveWorkProcessPage } from './ProactiveWorkProcessPage.js'

export type ProactiveWorkProcessPageHostProps = {
  runId: string
}

function preferredTaskFromHash() {
  try {
    const hash = window.location.hash.slice(1) || ''
    const q = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : ''
    return String(new URLSearchParams(q).get('task') || '').trim()
  } catch {
    return ''
  }
}

/**
 * 完整工作过程页：按 runId（agentCode::roundId）拉取消息与任务归属。
 */
export function ProactiveWorkProcessPageHost({ runId }: ProactiveWorkProcessPageHostProps) {
  const decoded = useMemo(() => decodeWorkProcessRunId(runId), [runId])
  const code = decoded.agentCode
  const rid = decoded.roundId
  const preferredTaskId = preferredTaskFromHash()

  const [rows, setRows] = useState<any[]>([])
  const [tasks, setTasks] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [fetchError, setFetchError] = useState('')
  const [roundTokens, setRoundTokens] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [roleName, setRoleName] = useState('')
  const [sessionKey, setSessionKey] = useState('')
  const [showInternals, setShowInternals] = useState(false)

  useEffect(() => {
    if (!code) return
    let cancelled = false
    void (async () => {
      try {
        const [role, board, busyRes] = await Promise.all([
          api.proactiveGetRole(code).catch(() => null),
          api.proactiveRoleWorkBoard(code, 200).catch(() => null),
          api.proactiveRoleBusy(code).catch(() => null),
        ])
        if (cancelled) return
        const name = String(role?.role_name || role?.name || '').trim()
        if (name) setRoleName(name)
        const taskList = Array.isArray(board?.tasks) ? board.tasks : []
        setTasks(taskList)
        const isBusy = Boolean(busyRes?.busy || busyRes?.is_busy)
        const st = String(role?.status || role?.work_status || '').toLowerCase()
        setBusy(isBusy || /running|busy|working|executing|patrol/i.test(st))
      } catch {
        /* optional */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code])

  useEffect(() => {
    if (!code) {
      queueMicrotask(() => {
        setRows([])
        setFetchError('无效的运行 ID')
        setLoading(false)
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
          taskId: preferredTaskId,
          roundId: rid,
        })
        if (cancelled) return
        const msgs = Array.isArray(res?.messages) ? res.messages : []
        setRows(messagesToSubtaskModalRows(msgs))
        setSessionKey(String(res?.session_key || `proactive:${code}`))
        const tok = res?.cost?.total_tokens
        setRoundTokens(tok != null && Number.isFinite(Number(tok)) ? Number(tok) : null)
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
    const timer = window.setInterval(() => void load(), busy ? 1400 : 4000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [code, rid, busy, preferredTaskId])

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

  const events = useMemo(
    () => filterWorkProcessInternalEvents(buildWorkProcessEvents(displayRows), { showInternals }),
    [displayRows, showInternals],
  )

  const run = useMemo(
    () =>
      buildWorkProcessRunRecord({
        agentCode: code,
        roleName,
        roundId: rid,
        preferredTaskId,
        tasks,
        events,
        busy,
        sessionKey,
      }),
    [code, roleName, rid, preferredTaskId, tasks, events, busy, sessionKey],
  )

  return (
    <ProactiveWorkProcessPage
      runId={runId}
      agentCode={code}
      run={run}
      rows={displayRows}
      loading={loading && !rows.length}
      roundTokens={roundTokens}
      showInternals={showInternals}
      onShowInternalsChange={setShowInternals}
    />
  )
}
