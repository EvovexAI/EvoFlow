import { createPortal } from 'react-dom'
import { useEffect, useMemo, useState } from 'react'
import { useModalEscapeClose } from '../hooks/useModalEscapeClose.js'
import {
  annotateLiveWorkProcessEvents,
  buildWorkProcessEvents,
  filterWorkProcessInternalEvents,
  formatWorkProcessLiveBanner,
  pickLatestWorkProcessLive,
  summarizeWorkProcess,
  aggregateWorkProcessErrors,
  collectWorkProcessMatchIds,
} from '../../lib/proactive-work-process.js'
import {
  WorkProcessEventList,
  WorkProcessErrorGroups,
  WorkProcessExportActions,
  WorkProcessLiveNow,
  WorkProcessSummaryBar,
  type StatFilterKey,
} from './ProactiveWorkProcessViews.js'

export type DrawerRunMeta = {
  taskName?: string
  attempt?: number
  attemptTotal?: number
  executorName?: string
  status?: string
  taskId?: string
  deliverableCount?: number | null
}

export type ProactiveWorkProcessModalProps = {
  open: boolean
  title: string
  summaryAgent: string
  statusLabel: string
  busy?: boolean
  rows: any[]
  loading?: boolean
  roundTokens?: number | null
  agentCode?: string
  roundId?: string
  runMeta?: DrawerRunMeta | null
  onClose: () => void
}

/**
 * 工作过程历史抽屉：任务详情 / 任务中心 / 智能体员工共用。
 * 展示完整事件时间线，不再跳转独立页面。
 */
export function ProactiveWorkProcessModal({
  open,
  title,
  summaryAgent,
  statusLabel,
  busy = false,
  rows,
  loading = false,
  roundTokens = null,
  agentCode = '',
  roundId = '',
  runMeta = null,
  onClose,
}: ProactiveWorkProcessModalProps) {
  const [statFilter, setStatFilter] = useState<StatFilterKey>('all')
  const [query, setQuery] = useState('')
  const [matchIdx, setMatchIdx] = useState(0)

  useModalEscapeClose(onClose, { open, deferToNestedModal: true })

  useEffect(() => {
    if (!open) {
      setQuery('')
      setMatchIdx(0)
      setStatFilter('all')
    }
  }, [open])

  useEffect(() => {
    setMatchIdx(0)
  }, [query, statFilter])

  const events = useMemo(
    () =>
      annotateLiveWorkProcessEvents(
        filterWorkProcessInternalEvents(buildWorkProcessEvents(rows), { showInternals: false }),
        { live: busy },
      ),
    [rows, busy],
  )
  const stats = useMemo(
    () => summarizeWorkProcess(events, rows, roundTokens, runMeta?.deliverableCount ?? null),
    [events, rows, roundTokens, runMeta?.deliverableCount],
  )
  const errorGroups = useMemo(() => aggregateWorkProcessErrors(events), [events])
  const liveLine = useMemo(
    () => formatWorkProcessLiveBanner(pickLatestWorkProcessLive(events), { live: busy }),
    [events, busy],
  )

  const filtered = useMemo(() => {
    let list = events
    if (statFilter === 'tool') list = events.filter((e) => e.kind === 'tool' || e.kind === 'file')
    else if (statFilter === 'file') list = events.filter((e) => e.kind === 'file')
    else if (statFilter === 'error') list = events.filter((e) => e.isError || e.kind === 'error')
    else if (statFilter === 'model' || statFilter === 'outputs') list = events.filter((e) => e.kind === 'model')
    const q = query.trim().toLowerCase()
    if (q) {
      list = list.filter((e) => {
        const blob = String(e.searchBlob || `${e.title || ''} ${e.summary || ''} ${e.action || ''} ${e.output || ''}`).toLowerCase()
        return blob.includes(q)
      })
    }
    // 最新在上，完整历史都在弹窗里看
    return [...list].reverse()
  }, [events, statFilter, query])

  const matchIds = useMemo(() => collectWorkProcessMatchIds(filtered, query), [filtered, query])
  const activeMatchId = matchIds.length ? matchIds[Math.min(matchIdx, matchIds.length - 1)] : null

  const goMatch = (delta: number) => {
    if (!matchIds.length) return
    setMatchIdx((i) => (i + delta + matchIds.length) % matchIds.length)
  }

  const taskName = String(runMeta?.taskName || title || '工作过程').trim()
  const attempt = runMeta?.attempt || 1
  const attemptTotal = runMeta?.attemptTotal || 1
  const executor = String(runMeta?.executorName || summaryAgent || '').trim()
  const compositeStatus = String(runMeta?.status || statusLabel || '').trim()
  const showErrors = errorGroups.length > 0

  if (!open) return null
  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      className="pro-wp-overlay pro-wp-overlay--drawer"
      role="dialog"
      aria-modal="true"
      aria-label={taskName}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <aside className="pro-wp-drawer">
        <header className="pro-wp-head">
          <div className="pro-wp-head__main">
            <h2 title={taskName}>{taskName}</h2>
            <p className="pro-wp-head__meta">
              <span>第 {attempt} 次运行{attemptTotal > 1 ? ` / 共 ${attemptTotal} 次` : ''}</span>
              {executor ? <span>执行者：{executor}</span> : null}
              <span className="pro-wp-head__status">
                {compositeStatus}
                {busy && !/执行中/.test(compositeStatus) ? ' · 进行中' : ''}
                {loading ? ' · 加载中' : ''}
              </span>
            </p>
          </div>
          <button type="button" className="btn btn-sm btn-ghost pro-wp-head__close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <WorkProcessSummaryBar stats={stats} onStatFilter={setStatFilter} compact />

        <WorkProcessLiveNow line={liveLine} live={busy} />

        {showErrors ? (
          <div className="pro-wp-drawer__section">
            <div className="pro-wp-drawer__section-head">
              <h3>异常</h3>
              <span>
                {errorGroups.length} 类 / {stats.errors} 次
              </span>
            </div>
            <WorkProcessErrorGroups groups={errorGroups.slice(0, 5)} compact />
          </div>
        ) : null}

        <div className="pro-wp-drawer__toolbar">
          <div className="pro-wp-search">
            <div className="pro-wp-search__field">
              <svg className="pro-wp-search__icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
                <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
                <path d="M12.8 12.8 L17 17" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              <input
                type="search"
                className="pro-wp-search__input"
                placeholder="搜索工具、文件、回复…"
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
              </>
            )}
          </div>
        </div>

        <div className="pro-wp-drawer__section pro-wp-drawer__section--grow">
          <div className="pro-wp-drawer__section-head">
            <h3>执行历史</h3>
            <span>
              {statFilter !== 'all' ? '筛选 · ' : ''}
              {filtered.length} / {events.length}
            </span>
          </div>
          <div className="pro-wp-body">
            <WorkProcessEventList
              events={filtered}
              query={query}
              activeMatchId={activeMatchId}
              emptyText={
                loading
                  ? '正在加载工作过程…'
                  : query.trim()
                    ? '无匹配事件'
                    : '暂无结构化记录。开始执行后，工具调用与模型回复会显示在这里。'
              }
            />
          </div>
        </div>

        <footer className="pro-wp-drawer__foot">
          <WorkProcessExportActions
            events={events}
            title={taskName}
            summaryAgent={executor || agentCode}
            statusLabel={compositeStatus}
            taskId={runMeta?.taskId || ''}
            runId={roundId}
            taskName={taskName}
          />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            关闭
          </button>
        </footer>
      </aside>
    </div>,
    document.body,
  )
}
