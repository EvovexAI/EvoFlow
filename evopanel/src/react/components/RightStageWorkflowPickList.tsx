/**
 * 右栏「工作流」选择器：可搜索下拉 — 先选 App，再选该 App 下某一次运行。
 */
import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/tauri-api.js'
import { RUN_STATUS } from '../../lib/app-run-inspect.js'
import { formatTaskStatusZh } from '../../lib/task-status-label.js'
import { DropdownSelect, type DropdownSelectOption } from './DropdownSelect.js'

export type RightStageWorkflowPickOption = {
  taskId: string
  title: string
  status: string
  statusLabel: string
  leadThreadId?: string
  badge?: string
  appId?: string
  runId?: string
}

type AppRow = {
  id: string
  name: string
  status: string
  totalRuns: number
  description: string
}

type RunRow = {
  id: string
  taskId: string
  status: string
  statusLabel: string
  createdLabel: string
  progress: number
  threadId: string
  live: boolean
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function appFromRow(raw: unknown): AppRow | null {
  const row = asRecord(raw)
  const id = String(row.id || row.app_id || '').trim()
  if (!id) return null
  return {
    id,
    name: String(row.name || row.title || id).trim() || id,
    status: String(row.status || '').trim().toLowerCase(),
    totalRuns: Math.max(0, Number(row.total_runs ?? row.totalRuns) || 0),
    description: String(row.description || row.goal || '').trim(),
  }
}

function runStatusMeta(status: string): { label: string; live: boolean } {
  const key = String(status || '').trim().toLowerCase()
  const known = (RUN_STATUS as Record<string, { label?: string }>)[key]
  const label =
    String(known?.label || '').trim() ||
    formatTaskStatusZh(status, { fallback: status || '未知' })
  const live = ['running', 'executing', 'paused', 'pausing', 'interrupted', 'plan_ready', 'planned'].includes(
    key,
  )
  return { label, live }
}

function formatWhen(raw: unknown): string {
  if (raw == null || raw === '') return '—'
  const n = typeof raw === 'number' ? raw : Date.parse(String(raw))
  if (!Number.isFinite(n)) return '—'
  try {
    return new Date(n).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return '—'
  }
}

function runFromRow(raw: unknown): RunRow | null {
  const row = asRecord(raw)
  const id = String(row.id || row.run_id || '').trim()
  const taskId = String(row.task_id || row.taskId || '').trim()
  if (!id && !taskId) return null
  const status = String(row.status || '').trim()
  const meta = runStatusMeta(status)
  return {
    id: id || taskId,
    taskId,
    status,
    statusLabel: meta.label,
    createdLabel: formatWhen(row.created_at ?? row.started_at ?? row.updated_at),
    progress: Math.max(0, Math.min(100, Math.round(Number(row.progress) || 0))),
    threadId: String(row.thread_id || row.lead_thread_id || '').trim(),
    live: meta.live,
  }
}

function statusLabelZh(status: string): string {
  if (status === 'published') return '已发布'
  if (status === 'archived') return '已归档'
  return '草稿'
}

export function RightStageWorkflowPickList({
  currentTaskId = '',
  onPick,
}: {
  currentTaskId?: string
  onPick: (opt: RightStageWorkflowPickOption) => void
}) {
  const curTask = String(currentTaskId || '').trim()
  const [apps, setApps] = useState<AppRow[]>([])
  const [appsLoading, setAppsLoading] = useState(true)
  const [appsError, setAppsError] = useState('')
  const [appId, setAppId] = useState('')
  const [runs, setRuns] = useState<RunRow[]>([])
  const [runsLoading, setRunsLoading] = useState(false)
  const [runsError, setRunsError] = useState('')
  const [runId, setRunId] = useState('')

  useEffect(() => {
    let cancelled = false
    setAppsLoading(true)
    setAppsError('')
    void (async () => {
      try {
        const list = await api.listApps()
        if (cancelled) return
        const rows = (Array.isArray(list) ? list : [])
          .map(appFromRow)
          .filter(Boolean) as AppRow[]
        rows.sort((a, b) => {
          if (b.totalRuns !== a.totalRuns) return b.totalRuns - a.totalRuns
          return a.name.localeCompare(b.name, 'zh')
        })
        setApps(rows)
      } catch (e) {
        if (cancelled) return
        setAppsError(e instanceof Error ? e.message : String(e || '加载失败'))
        setApps([])
      } finally {
        if (!cancelled) setAppsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!appId) {
      setRuns([])
      setRunId('')
      setRunsError('')
      setRunsLoading(false)
      return
    }
    let cancelled = false
    setRunsLoading(true)
    setRunsError('')
    setRuns([])
    setRunId('')
    void (async () => {
      try {
        const data = await api.listAppRuns(appId, 40, { page: 1, pageSize: 40 })
        if (cancelled) return
        const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : []
        const rows = (items as unknown[])
          .map(runFromRow)
          .filter(Boolean) as RunRow[]
        rows.sort((a, b) => {
          if (a.live !== b.live) return a.live ? -1 : 1
          if (curTask && a.taskId === curTask) return -1
          if (curTask && b.taskId === curTask) return 1
          return 0
        })
        setRuns(rows)
        const preferred =
          rows.find((r) => curTask && r.taskId === curTask && r.taskId) ||
          rows.find((r) => r.live && r.taskId) ||
          rows.find((r) => r.taskId)
        if (preferred) setRunId(preferred.id)
      } catch (e) {
        if (cancelled) return
        setRunsError(e instanceof Error ? e.message : String(e || '加载失败'))
        setRuns([])
      } finally {
        if (!cancelled) setRunsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [appId, curTask])

  const selectedApp = useMemo(() => apps.find((a) => a.id === appId) || null, [apps, appId])
  const selectedRun = useMemo(() => runs.find((r) => r.id === runId) || null, [runs, runId])

  const appOptions: DropdownSelectOption[] = useMemo(
    () =>
      apps.map((app) => ({
        value: app.id,
        label: app.name,
        description: [
          statusLabelZh(app.status),
          app.totalRuns > 0 ? `${app.totalRuns} 次运行` : '尚无运行',
          app.description || '',
        ]
          .filter(Boolean)
          .join(' · '),
      })),
    [apps],
  )

  const runOptions: DropdownSelectOption[] = useMemo(
    () =>
      runs.map((run) => {
        const bits = [
          run.live ? '进行中' : '',
          curTask && run.taskId === curTask ? '当前会话' : '',
          run.createdLabel,
          run.progress > 0 ? `${run.progress}%` : '',
          run.taskId ? `任务 ${run.taskId.slice(0, 8)}` : '无任务',
        ].filter(Boolean)
        return {
          value: run.id,
          label: run.statusLabel,
          description: bits.join(' · '),
          disabled: !run.taskId,
        }
      }),
    [runs, curTask],
  )

  const canOpen = !!(selectedApp && selectedRun?.taskId)

  const openSelected = () => {
    if (!selectedApp || !selectedRun?.taskId) return
    onPick({
      taskId: selectedRun.taskId,
      title: `${selectedApp.name} · ${selectedRun.statusLabel}`,
      status: selectedRun.status,
      statusLabel: selectedRun.statusLabel,
      leadThreadId: selectedRun.threadId || undefined,
      badge: selectedRun.live ? '进行中' : undefined,
      appId: selectedApp.id,
      runId: selectedRun.id,
    })
  }

  if (appsLoading) {
    return <div className="px-1 py-4 text-center text-ui-sm text-foreground-subtlest">加载应用…</div>
  }
  if (appsError) {
    return (
      <div className="px-1 py-4 text-center text-ui-sm text-foreground-subtlest">
        加载失败：{appsError}
      </div>
    )
  }
  if (!apps.length) {
    return (
      <div className="px-1 py-4 text-center text-ui-sm text-foreground-subtlest">
        暂无应用。先到「工作流」页创建一个 App。
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 px-1 pb-1">
      {curTask ? (
        <button
          type="button"
          className="self-start text-ui-sm text-foreground-subtle underline-offset-2 hover:text-foreground hover:underline"
          onClick={() =>
            onPick({
              taskId: curTask,
              title: '当前会话工作流',
              status: 'running',
              statusLabel: '当前会话',
              badge: '当前会话',
            })
          }
        >
          打开当前会话工作流
        </button>
      ) : null}

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-foreground-subtle">应用</span>
        <DropdownSelect
          className="ef-dropdown-select--fill"
          variant="field"
          portal
          searchable
          searchPlaceholder="搜索应用名称…"
          value={appId}
          onChange={setAppId}
          options={appOptions}
          placeholder="选择 App…"
          aria-label="选择应用"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-foreground-subtle">运行记录</span>
        <DropdownSelect
          className="ef-dropdown-select--fill"
          variant="field"
          portal
          searchable
          searchPlaceholder="搜索状态 / 时间 / 任务…"
          value={runId}
          onChange={setRunId}
          options={runOptions}
          disabled={!appId || runsLoading}
          placeholder={
            !appId
              ? '先选择应用'
              : runsLoading
                ? '加载运行中…'
                : runsError
                  ? '加载失败'
                  : '选择一次运行…'
          }
          emptyLabel={runsError || '暂无运行'}
          aria-label="选择运行记录"
        />
        {!appId ? (
          <span className="text-[11px] text-foreground-subtlest">选好 App 后可挑选某次运行</span>
        ) : runsLoading ? (
          <span className="text-[11px] text-foreground-subtlest">正在拉取运行记录…</span>
        ) : runsError ? (
          <span className="text-[11px] text-foreground-subtlest">{runsError}</span>
        ) : !runs.length ? (
          <span className="text-[11px] text-foreground-subtlest">这个应用还没有运行记录</span>
        ) : null}
      </label>

      <button
        type="button"
        className="react-chat-stage-open-tab-button justify-center font-medium"
        disabled={!canOpen}
        onClick={openSelected}
      >
        打开任务图
      </button>
    </div>
  )
}
