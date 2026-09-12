import { useCallback, useEffect, useMemo, useState } from 'react'
import { navigate } from '../../router.js'
import {
  WORK_PROCESS_FILTERS,
  WORK_PROCESS_STATUS_FILTERS,
  annotateLiveWorkProcessEvents,
  buildWorkProcessEvents,
  summarizeWorkProcess,
  filterWorkProcessEvents,
  filterWorkProcessInternalEvents,
  formatWorkProcessLiveBanner,
  pickLatestWorkProcessLive,
  collectWorkProcessMatchIds,
  buildWorkProcessRunPath,
  fmtWorkProcessDateTime,
  fmtWorkProcessDuration,
  formatRunIdDisplay,
} from '../../lib/proactive-work-process.js'
import {
  WorkProcessExportActions,
  WorkProcessSummaryBar,
  WorkProcessEventList,
  WorkProcessLiveNow,
  type StatFilterKey,
} from './ProactiveWorkProcessViews.js'

export type WorkProcessRunMeta = {
  id: string
  taskId: string
  taskName: string
  runId: string
  runIdDisplay?: string
  hasValidRunId?: boolean
  attempt: number
  attemptTotal: number
  attempts: Array<{
    attempt: number
    runId: string
    taskId: string
    taskName: string
    status: string
    createdAt: string
    isCurrent: boolean
  }>
  triggerType: string
  executorId: string
  executorName: string
  status: string
  runStatus?: string
  taskStatusLabel?: string
  taskStatus?: string
  startedAt: number | null
  completedAt: number | null
  duration: number | null
  sourceEmployee: string
  sourceSession: string
  deliverableCount?: number | null
}

export type ProactiveWorkProcessPageProps = {
  runId: string
  agentCode: string
  run: WorkProcessRunMeta | null
  rows: any[]
  loading?: boolean
  roundTokens?: number | null
  onBack?: () => void
  showInternals?: boolean
  onShowInternalsChange?: (next: boolean) => void
}

/**
 * 工作过程完整页：紧凑页头 + 核心指标 + 扁平事件时间线。
 */
export function ProactiveWorkProcessPage({
  runId,
  agentCode,
  run,
  rows,
  loading = false,
  roundTokens = null,
  onBack,
  showInternals = false,
  onShowInternalsChange,
}: ProactiveWorkProcessPageProps) {
  const [kind, setKind] = useState<string>('all')
  const [statusKey, setStatusKey] = useState<string>('all')
  const [query, setQuery] = useState('')
  const [timeFrom, setTimeFrom] = useState('')
  const [timeTo, setTimeTo] = useState('')
  const [matchIdx, setMatchIdx] = useState(0)
  const [moreOpen, setMoreOpen] = useState(false)
  const [techOpen, setTechOpen] = useState(false)

  const live = useMemo(() => {
    const raw = `${run?.taskStatus || ''} ${run?.runStatus || ''}`.toLowerCase()
    if (/\b(running|executing|planning|in_progress)\b/.test(raw)) return true
    const zh = `${run?.status || ''} ${run?.taskStatusLabel || ''}`
    return /执行中|进行中|规划中/.test(zh)
  }, [run?.taskStatus, run?.status, run?.runStatus, run?.taskStatusLabel])

  const events = useMemo(
    () =>
      annotateLiveWorkProcessEvents(
        filterWorkProcessInternalEvents(buildWorkProcessEvents(rows), { showInternals }),
        { live },
      ),
    [rows, showInternals, live],
  )
  const liveLine = useMemo(
    () => formatWorkProcessLiveBanner(pickLatestWorkProcessLive(events), { live }),
    [events, live],
  )
  const stats = useMemo(
    () => summarizeWorkProcess(events, rows, roundTokens, run?.deliverableCount ?? null),
    [events, rows, roundTokens, run?.deliverableCount],
  )

  const timeFromMs = timeFrom ? new Date(timeFrom).getTime() : null
  const timeToMs = timeTo ? new Date(timeTo).getTime() : null

  const filtered = useMemo(
    () =>
      filterWorkProcessEvents(events, {
        kind,
        statusKey,
        query,
        timeFrom: Number.isFinite(timeFromMs as number) ? timeFromMs : null,
        timeTo: Number.isFinite(timeToMs as number) ? timeToMs : null,
      }),
    [events, kind, statusKey, query, timeFromMs, timeToMs],
  )

  const matchIds = useMemo(() => collectWorkProcessMatchIds(filtered, query), [filtered, query])
  const activeMatchId = matchIds.length ? matchIds[Math.min(matchIdx, matchIds.length - 1)] : null

  useEffect(() => {
    setMatchIdx(0)
  }, [query, kind, statusKey, timeFrom, timeTo])

  useEffect(() => {
    if (!moreOpen) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest?.('.pro-wp-more-filter')) return
      setMoreOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [moreOpen])

  const goMatch = useCallback(
    (delta: number) => {
      if (!matchIds.length) return
      setMatchIdx((i) => (i + delta + matchIds.length) % matchIds.length)
    },
    [matchIds.length],
  )

  const onStatFilter = (key: StatFilterKey) => {
    if (key === 'outputs') setKind('file')
    else if (key === 'all') setKind('all')
    else setKind(key)
    setStatusKey(key === 'error' ? 'failed' : 'all')
  }

  const taskName = run?.taskName || '工作过程'
  const meta = run
  const runIdShown = meta?.runIdDisplay || formatRunIdDisplay(meta?.runId || runId)
  const durationLabel =
    meta?.duration != null && Number.isFinite(meta.duration)
      ? fmtWorkProcessDuration(meta.duration)
      : fmtWorkProcessDuration(stats.durationMs)
  const timeRange = [
    fmtWorkProcessDateTime(meta?.startedAt ?? null),
    meta?.completedAt != null ? fmtWorkProcessDateTime(meta.completedAt) : null,
  ]
    .filter((x) => x && x !== '—')
    .join(' – ')

  const switchAttempt = (attemptRunId: string, taskId: string) => {
    const code = String(agentCode || '').trim()
    if (!code || !attemptRunId) return
    navigate(buildWorkProcessRunPath(code, attemptRunId, taskId))
  }

  const goBack = () => {
    if (onBack) onBack()
    else if (meta?.taskId) navigate(`/task/${encodeURIComponent(meta.taskId)}`)
    else if (agentCode) navigate(`/proactive/${encodeURIComponent(agentCode)}`)
    else navigate('/proactive')
  }

  return (
    <div className="page pro-wp-page">
      <header className="pro-wp-page__head">
        <div className="pro-wp-page__title">
          <button
            type="button"
            className="btn btn-sm btn-ghost pro-wp-page__back"
            onClick={goBack}
            title="返回"
            aria-label="返回"
          >
            ←
          </button>
          <div className="pro-wp-page__heading">
            <div className="pro-wp-page__heading-row">
              <h1 title={taskName}>{taskName}</h1>
              {meta?.status ? <span className="pro-wp-page__status">{meta.status}</span> : null}
            </div>
            <p className="pro-wp-page__meta-line">
              <span>{meta?.executorName || agentCode || '—'}</span>
              <span>
                第 {meta?.attempt || 1} 次
                {meta?.attemptTotal && meta.attemptTotal > 1 ? ` / ${meta.attemptTotal}` : ''}
              </span>
              {timeRange ? <span>{timeRange}</span> : null}
              {durationLabel && durationLabel !== '—' ? <span>{durationLabel}</span> : null}
              {meta?.triggerType ? <span>{meta.triggerType}</span> : null}
              {meta?.taskId ? (
                <button
                  type="button"
                  className="pro-wp-page__meta-link"
                  onClick={() => navigate(`/task/${encodeURIComponent(meta.taskId)}`)}
                >
                  任务详情
                </button>
              ) : null}
              <button
                type="button"
                className="pro-wp-page__meta-link"
                onClick={() => setTechOpen((v) => !v)}
                aria-expanded={techOpen}
              >
                {techOpen ? '收起' : '更多'}
              </button>
            </p>
            {techOpen ? (
              <div className="pro-wp-page__tech">
                <span title={meta?.taskId || ''}>taskId · {meta?.taskId || '—'}</span>
                <span title={runIdShown}>runId · {runIdShown}</span>
                {meta?.runStatus ? <span>运行 · {meta.runStatus}</span> : null}
                {meta?.taskStatusLabel ? <span>任务 · {meta.taskStatusLabel}</span> : null}
                {meta?.sourceEmployee ? <span>来源 · {meta.sourceEmployee}</span> : null}
              </div>
            ) : null}
            {meta?.attempts && meta.attempts.length > 1 ? (
              <div className="pro-wp-attempts" aria-label="切换运行实例">
                {meta.attempts.map((a) => (
                  <button
                    key={`${a.runId}-${a.attempt}`}
                    type="button"
                    className={`pro-wp-attempt${a.isCurrent ? ' is-active' : ''}`}
                    onClick={() => switchAttempt(a.runId, a.taskId)}
                  >
                    第 {a.attempt} 次
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <div className="pro-wp-page__head-actions">
          <WorkProcessExportActions
            events={events}
            title={taskName}
            summaryAgent={meta?.executorName || agentCode}
            statusLabel={meta?.status || ''}
            taskId={meta?.taskId}
            runId={meta?.hasValidRunId === false ? '' : meta?.runId || runId}
            taskName={taskName}
          />
        </div>
      </header>

      <WorkProcessSummaryBar stats={stats} onStatFilter={onStatFilter} compact />

      <WorkProcessLiveNow line={liveLine} live={live} />

      <div className="pro-wp-page__toolbar">
        <div className="pro-wp-search">
          <div className="pro-wp-search__field">
            <svg className="pro-wp-search__icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
              <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path d="M12.8 12.8 L17 17" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              className="pro-wp-search__input"
              placeholder="搜索工具、文件、错误…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && query.trim()) {
                  e.preventDefault()
                  goMatch(e.shiftKey ? -1 : 1)
                }
              }}
            />
          </div>
          {!query.trim() ? (
            <span className="pro-wp-search__count">{filtered.length}</span>
          ) : (
            <>
              <span className="pro-wp-search__count">
                {matchIds.length ? matchIdx + 1 : 0}/{matchIds.length}
              </span>
              <button type="button" className="btn btn-sm btn-ghost" disabled={!matchIds.length} onClick={() => goMatch(-1)}>
                上一个
              </button>
              <button type="button" className="btn btn-sm btn-ghost" disabled={!matchIds.length} onClick={() => goMatch(1)}>
                下一个
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  setQuery('')
                  setMatchIdx(0)
                }}
              >
                清除
              </button>
            </>
          )}
          {onShowInternalsChange ? (
            <label className="pro-wp-internals-toggle" title="显示值班内部 brief（看板规则 / 工具语法）">
              <input
                type="checkbox"
                checked={showInternals}
                onChange={(e) => onShowInternalsChange(Boolean(e.target.checked))}
              />
              <span>显示内部指令</span>
            </label>
          ) : null}
        </div>

        <div className="pro-wp-filters-row">
          <div className="pro-wp-filters" role="tablist" aria-label="筛选">
            {WORK_PROCESS_FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                className={`pro-wp-filter${kind === f.key ? ' is-active' : ''}`}
                onClick={() => setKind(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="pro-wp-more-filter">
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMoreOpen((v) => !v)}>
              更多{(statusKey !== 'all' || timeFrom || timeTo) ? ' ·' : ''}
            </button>
            {moreOpen ? (
              <div className="pro-wp-more-filter__panel">
                <div className="pro-wp-more-filter__label">状态</div>
                <div className="pro-wp-filters">
                  {WORK_PROCESS_STATUS_FILTERS.map((f) => (
                    <button
                      key={f.key}
                      type="button"
                      className={`pro-wp-filter${statusKey === f.key ? ' is-active' : ''}`}
                      onClick={() => setStatusKey(f.key)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
                <div className="pro-wp-more-filter__label">时间范围</div>
                <div className="pro-wp-time-range">
                  <label>
                    从
                    <input type="datetime-local" value={timeFrom} onChange={(e) => setTimeFrom(e.target.value)} />
                  </label>
                  <label>
                    到
                    <input type="datetime-local" value={timeTo} onChange={(e) => setTimeTo(e.target.value)} />
                  </label>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      setTimeFrom('')
                      setTimeTo('')
                      setStatusKey('all')
                    }}
                  >
                    重置
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="pro-wp-page__body">
        <WorkProcessEventList
          events={filtered}
          query={query}
          activeMatchId={activeMatchId}
          emptyText={loading ? '正在加载工作过程…' : '暂无匹配事件'}
        />
      </div>
    </div>
  )
}
