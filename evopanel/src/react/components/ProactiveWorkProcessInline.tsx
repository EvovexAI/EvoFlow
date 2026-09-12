import { useEffect, useMemo, useState } from 'react'
import { messagesToSubtaskModalRows } from '../../lib/subtask-modal-rows.js'
import { fetchProactiveTranscript } from '../../lib/proactive-session-messages.js'
import {
  annotateLiveWorkProcessEvents,
  buildWorkProcessEvents,
  filterWorkProcessInternalEvents,
  formatWorkProcessLiveBanner,
  pickLatestWorkProcessLive,
  summarizeWorkProcess,
  aggregateWorkProcessErrors,
} from '../../lib/proactive-work-process.js'
import {
  WorkProcessEventList,
  WorkProcessErrorGroups,
  WorkProcessLiveNow,
  WorkProcessSummaryBar,
  type StatFilterKey,
} from './ProactiveWorkProcessViews.js'

export type ProactiveWorkProcessInlineProps = {
  agentCode: string
  roundId?: string
  taskId?: string
  taskName?: string
  pollMs?: number
  live?: boolean
  currentStep?: string
  /** 打开与员工页同款的工作过程历史弹窗 */
  onOpenHistory?: () => void
}

const INLINE_EVENT_LIMIT = 10

/**
 * 任务详情「执行过程」内嵌：最新进度 + 最近几条；完整历史走弹窗。
 */
export function ProactiveWorkProcessInline({
  agentCode,
  roundId = '',
  taskId = '',
  pollMs = 4000,
  live = false,
  currentStep = '',
  onOpenHistory,
}: ProactiveWorkProcessInlineProps) {
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState('')
  const [roundTokens, setRoundTokens] = useState<number | null>(null)
  const [kind, setKind] = useState<StatFilterKey>('all')

  const code = String(agentCode || '').trim()
  const rid = String(roundId || '').trim()
  const tid = String(taskId || '').trim()
  const intervalMs = Math.max(800, Number(pollMs) || 4000)

  useEffect(() => {
    if (!code) {
      queueMicrotask(() => {
        setRows([])
        setLoading(false)
        setFetchError('缺少员工标识')
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
    const timer = window.setInterval(() => void load(), intervalMs)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [code, rid, tid, intervalMs])

  const events = useMemo(
    () =>
      annotateLiveWorkProcessEvents(
        filterWorkProcessInternalEvents(buildWorkProcessEvents(rows), { showInternals: false }),
        { live },
      ),
    [rows, live],
  )
  const stats = useMemo(
    () => summarizeWorkProcess(events, rows, roundTokens, null),
    [events, rows, roundTokens],
  )
  const errorGroups = useMemo(() => aggregateWorkProcessErrors(events), [events])
  const liveEv = useMemo(() => pickLatestWorkProcessLive(events), [events])
  const liveLine = useMemo(() => {
    const fromEvents = formatWorkProcessLiveBanner(liveEv, { live })
    const step = String(currentStep || '').trim()
    if (liveEv?.statusKey === 'running' && fromEvents) return fromEvents
    if (live && step && (!fromEvents || fromEvents === '正在执行…')) return `正在推进 · ${step}`
    return fromEvents
  }, [liveEv, live, currentStep])

  const filtered = useMemo(() => {
    let list = events
    if (kind === 'tool') list = events.filter((e) => e.kind === 'tool' || e.kind === 'file')
    else if (kind === 'file') list = events.filter((e) => e.kind === 'file')
    else if (kind === 'error') list = events.filter((e) => e.isError || e.kind === 'error')
    else if (kind === 'model' || kind === 'outputs') list = events.filter((e) => e.kind === 'model')
    // 最新在上，只留最近几条；完整历史走弹窗
    return [...list].reverse().slice(0, INLINE_EVENT_LIMIT)
  }, [events, kind])

  const openHistory = () => {
    if (!code) return
    onOpenHistory?.()
  }

  const onStatFilter = (key: StatFilterKey) => {
    if (key === 'outputs') setKind('file')
    else setKind(key)
  }

  return (
    <div className="td-wp-inline">
      <div className="td-wp-inline__toolbar">
        {loading || fetchError ? (
          <span className="td-wp-inline__label">
            {loading ? '加载中…' : fetchError}
          </span>
        ) : (
          <span className="td-wp-inline__label" />
        )}
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={!code || !onOpenHistory}
          onClick={openHistory}
        >
          查看完整历史
        </button>
      </div>

      <WorkProcessSummaryBar stats={stats} onStatFilter={onStatFilter} compact />

      <WorkProcessLiveNow line={liveLine} live={live} />

      {errorGroups.length > 0 ? (
        <div className="td-wp-inline__errors">
          <div className="td-wp-inline__errors-head">
            <strong>异常</strong>
            <span>
              {errorGroups.length} 类 / {stats.errors} 次
            </span>
          </div>
          <WorkProcessErrorGroups groups={errorGroups.slice(0, 5)} compact />
        </div>
      ) : null}

      <WorkProcessEventList
        events={filtered}
        emptyText={
          loading
            ? '正在加载上班轨迹…'
            : fetchError
              ? `无法加载：${fetchError}`
              : live
                ? '员工正在执行，工具调用与模型回复会显示在上方实时进度里。'
                : '本轮暂无结构化记录。员工开始执行后，工具调用与模型回复会显示在这里。'
        }
      />
    </div>
  )
}
