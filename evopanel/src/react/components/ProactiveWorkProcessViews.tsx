import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { copyToClipboard } from '../../lib/subtask-transcript-display.js'
import { toast } from '../../components/toast.js'
import {
  WORK_PROCESS_KIND_ICON,
  fmtWorkProcessDuration,
  fmtWorkProcessTokens,
  highlightWorkProcessText,
  downloadWorkProcessText,
  exportWorkProcessAsJson,
  exportWorkProcessAsMarkdown,
  copyWorkProcessPlain,
} from '../../lib/proactive-work-process.js'

export type WorkProcessEventView = {
  id: string
  kind: string
  timeLabel: string
  action: string
  title?: string
  toolTitle?: string
  status: string
  statusKey?: 'completed' | 'running' | 'failed' | 'other' | string
  durationMs: number | null
  isError: boolean
  input: string
  output: string
  errorText: string
  summary: string
  primaryAction?: string
  filePath: string
  command: string
  isSystemPrompt?: boolean
  errorInsight?: {
    what: string
    step: string
    impact: string
    recommend: string
  } | null
}

export type WorkProcessStepView = {
  id: string
  index: number
  name: string
  status: string
  statusKey: string
  eventCount: number
  errorCount: number
  durationMs: number | null
  events: WorkProcessEventView[]
  hasRunning: boolean
  hasError: boolean
}

export type WorkProcessStats = {
  durationMs: number | null
  toolCalls: number
  fileReads: number
  errors: number
  errorGroupCount?: number
  errorsLabel?: string
  modelCalls?: number
  outputs?: number
  outputsLabel?: string
  tokens?: number | null
  cost?: string | number
}

export type StatFilterKey = 'all' | 'tool' | 'file' | 'error' | 'model' | 'outputs'

type HighlightProps = { text: string; query?: string }

export function WorkProcessHighlight({ text, query = '' }: HighlightProps) {
  const parts = useMemo(() => highlightWorkProcessText(text, query), [text, query])
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="pro-wp-hit">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  )
}

type SummaryProps = {
  stats: WorkProcessStats
  onStatFilter?: (key: StatFilterKey) => void
  compact?: boolean
}

export function WorkProcessSummaryBar({ stats, onStatFilter, compact }: SummaryProps) {
  // 完整页与侧栏统一：只留核心数字，避免七格挤满 + 长文案
  const items: { key: StatFilterKey; value: ReactNode; label: string }[] = [
    { key: 'all', value: fmtWorkProcessDuration(stats.durationMs), label: '时长' },
    { key: 'model', value: stats.modelCalls ?? 0, label: '模型' },
    { key: 'tool', value: stats.toolCalls, label: '工具' },
    { key: 'outputs', value: stats.outputs ?? 0, label: stats.outputsLabel === '交付物' ? '交付' : '产出' },
    { key: 'error', value: stats.errors ?? 0, label: '异常' },
    {
      key: 'model',
      value: fmtWorkProcessTokens(stats.tokens ?? null),
      label: 'Token',
    },
  ]
  return (
    <div className="pro-wp-summary is-compact" aria-label="运行摘要">
      {items.map((it, idx) => (
        <button
          key={`${it.label}-${idx}`}
          type="button"
          className="pro-wp-summary__item"
          title={
            it.label === 'Token' && stats.tokens != null && Number(stats.tokens) > 0
              ? `模型 Token 消耗：${Number(stats.tokens).toLocaleString()}`
              : onStatFilter
                ? `筛选：${it.label}`
                : undefined
          }
          onClick={() => onStatFilter?.(it.key)}
        >
          <strong>{it.value}</strong>
          <span>{it.label}</span>
        </button>
      ))}
    </div>
  )
}

type ExportProps = {
  events: WorkProcessEventView[]
  title: string
  summaryAgent: string
  statusLabel: string
  taskId?: string
  runId?: string
  taskName?: string
}

export function WorkProcessExportActions({
  events,
  title,
  summaryAgent,
  statusLabel,
  taskId = '',
  runId = '',
  taskName = '',
}: ExportProps) {
  const [open, setOpen] = useState(false)
  const meta = { title, summaryAgent, statusLabel, taskId, runId, taskName }

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest?.('.pro-wp-export__menu')) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <div className="pro-wp-export">
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        onClick={() => {
          void copyToClipboard(copyWorkProcessPlain(events) || '暂无日志')
          toast('已复制全部日志', 'success')
        }}
      >
        复制全部
      </button>
      <div className="pro-wp-export__menu">
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen((v) => !v)}>
          导出日志 ▾
        </button>
        {open ? (
          <div className="pro-wp-export__dropdown" role="menu">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                downloadWorkProcessText(
                  exportWorkProcessAsMarkdown(events, meta),
                  `work-process-${Date.now()}.md`,
                  'text/markdown;charset=utf-8',
                )
                setOpen(false)
              }}
            >
              Markdown
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                downloadWorkProcessText(
                  exportWorkProcessAsJson(events, meta),
                  `work-process-${Date.now()}.json`,
                  'application/json;charset=utf-8',
                )
                setOpen(false)
              }}
            >
              JSON
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** 详情正文（仅模型回复 / 错误需要） */
function DetailBody({ text, query }: { text: string; query?: string }) {
  if (!text) return null
  return (
    <pre className="pro-wp-detail__pre">
      <WorkProcessHighlight text={text} query={query} />
    </pre>
  )
}

type EventCardProps = {
  ev: WorkProcessEventView
  query?: string
  active?: boolean
  /** 侧栏：只显示时间 + 标题，不展开正文 */
  compact?: boolean
}

export function WorkProcessEventCard({
  ev,
  query = '',
  active = false,
  compact = false,
}: EventCardProps) {
  const [open, setOpen] = useState(false)
  const isErr = ev.isError || ev.kind === 'error'
  const isLive = ev.statusKey === 'running' && !isErr
  const icon = WORK_PROCESS_KIND_ICON[ev.kind as keyof typeof WORK_PROCESS_KIND_ICON] || '•'
  const isModel = ev.kind === 'model'
  const isInternal = Boolean(ev.isSystemPrompt)
  const isBeat = ev.action === '值班节拍'
  const hint = String(ev.summary || '').trim()
  // 模型事件用首句当标题，避免整屏「模型回复」同质化；节拍用首行
  const title = isModel && hint ? hint : ev.title || ev.action
  const detailText = isModel
    ? ev.output
    : isErr
      ? ev.errorText || ev.output
      : isInternal || isBeat
        ? ev.input
        : ''
  const canExpand = !compact && Boolean(detailText) && detailText !== title
  const showBody = canExpand && (open || (active && Boolean(query.trim())))

  useEffect(() => {
    if (active && canExpand && query.trim()) setOpen(true)
  }, [active, canExpand, query])

  return (
    <div
      id={`pro-wp-${ev.id}`}
      className={`pro-wp-event${compact ? ' is-compact' : ''}${isErr ? ' is-error' : ''}${isLive ? ' is-live' : ''}${active ? ' is-match' : ''}${showBody ? ' is-open' : ''}${isInternal ? ' is-internal' : ''}`}
    >
      <div className="pro-wp-event__row">
        <span className="pro-wp-event__time" title="执行时间">
          {ev.timeLabel || '—'}
        </span>
        <span className="pro-wp-event__icon" aria-hidden>
          {icon}
        </span>
        <div className="pro-wp-event__main">
          {canExpand ? (
            <button
              type="button"
              className="pro-wp-event__head is-button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={showBody}
            >
              <span className="pro-wp-event__title" title={title}>
                {isInternal ? <span className="pro-wp-event__tag">内部</span> : null}
                {isLive ? <span className="pro-wp-event__tag is-live">进行中</span> : null}
                <WorkProcessHighlight text={title} query={query} />
              </span>
              {ev.durationMs != null && Number.isFinite(ev.durationMs) && ev.durationMs > 0 ? (
                <span className="pro-wp-event__dur">耗时 {fmtWorkProcessDuration(ev.durationMs)}</span>
              ) : null}
              <span className="pro-wp-event__chev" aria-hidden>
                {showBody ? '▾' : '▸'}
              </span>
            </button>
          ) : (
            <div className="pro-wp-event__head">
              <div className="pro-wp-event__title" title={title}>
                {isInternal ? <span className="pro-wp-event__tag">内部</span> : null}
                {isLive ? <span className="pro-wp-event__tag is-live">进行中</span> : null}
                <WorkProcessHighlight text={title} query={query} />
              </div>
              {ev.durationMs != null && Number.isFinite(ev.durationMs) && ev.durationMs > 0 ? (
                <span className="pro-wp-event__dur">耗时 {fmtWorkProcessDuration(ev.durationMs)}</span>
              ) : null}
            </div>
          )}
          {!isModel && !isInternal && hint && hint !== title ? (
            <p className="pro-wp-event__summary pro-wp-event__summary--clamp">
              <WorkProcessHighlight text={hint} query={query} />
            </p>
          ) : null}
          {showBody ? <DetailBody text={detailText} query={query} /> : null}
        </div>
      </div>
    </div>
  )
}

type LiveNowProps = {
  line: string
  live?: boolean
}

/** 钉在时间线上方的最新进度，证明当前仍在推进。 */
export function WorkProcessLiveNow({ line, live = false }: LiveNowProps) {
  const text = String(line || '').trim()
  if (!text) return null
  return (
    <div className={`td-wp-live${live ? ' is-active' : ''}`} role="status" aria-live="polite">
      {live ? <span className="td-wp-live__pulse" aria-hidden="true" /> : null}
      <span className="td-wp-live__kicker">{live ? '实时进度' : '最新进度'}</span>
      <span className="td-wp-live__text">{text}</span>
    </div>
  )
}

type EventListProps = {
  events: WorkProcessEventView[]
  query?: string
  activeMatchId?: string | null
  emptyText?: string
  compact?: boolean
}

export function WorkProcessEventList({
  events,
  query = '',
  activeMatchId = null,
  emptyText = '暂无结构化记录',
  compact = false,
}: EventListProps) {
  useEffect(() => {
    if (!activeMatchId) return
    document.getElementById(`pro-wp-${activeMatchId}`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    })
  }, [activeMatchId])

  if (!events.length) return <div className="pro-wp-empty">{emptyText}</div>
  return (
    <div className={`pro-wp-events${compact ? ' is-compact' : ''}`}>
      {events.map((ev) => (
        <WorkProcessEventCard
          key={ev.id}
          ev={ev}
          query={query}
          active={activeMatchId === ev.id}
          compact={compact}
        />
      ))}
    </div>
  )
}

type StepListProps = {
  steps: WorkProcessStepView[]
  query?: string
  activeMatchId?: string | null
  emptyText?: string
}

/** 兼容旧调用：阶段折叠已废弃，改为扁平事件列表 */
export function WorkProcessStepList({
  steps,
  query = '',
  activeMatchId = null,
  emptyText = '暂无结构化记录',
}: StepListProps) {
  const flat = useMemo(() => steps.flatMap((s) => s.events), [steps])
  return (
    <WorkProcessEventList
      events={flat}
      query={query}
      activeMatchId={activeMatchId}
      emptyText={emptyText}
    />
  )
}

type ErrorGroupProps = {
  groups: Array<{
    id: string
    typeLabel: string
    summary: string
    count: number
    firstTimeLabel?: string
    lastTimeLabel?: string
    scope: string
    events: WorkProcessEventView[]
  }>
  compact?: boolean
}

export function WorkProcessErrorGroups({ groups, compact = false }: ErrorGroupProps) {
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({})
  if (!groups.length) return <div className="pro-wp-empty pro-wp-empty--sm">暂无异常</div>
  return (
    <div className={`pro-wp-error-groups${compact ? ' is-compact' : ''}`}>
      {groups.map((g) => {
        const open = !compact && openMap[g.id] === true
        const label = g.typeLabel && g.summary.startsWith(g.typeLabel)
          ? g.summary
          : `${g.typeLabel} · ${g.summary}`
        return (
          <div key={g.id} className="pro-wp-error-group">
            {compact ? (
              <div className="pro-wp-error-group__head is-static" title={label}>
                <strong>{label}</strong>
                <span>{g.count} 次</span>
              </div>
            ) : (
              <button
                type="button"
                className="pro-wp-error-group__head"
                onClick={() => setOpenMap((s) => ({ ...s, [g.id]: !openMap[g.id] }))}
              >
                <strong>{label}</strong>
                <span>
                  {g.count} 次 · 首次 {g.firstTimeLabel || '—'} · 最近 {g.lastTimeLabel || '—'}
                </span>
              </button>
            )}
            {open ? (
              <div className="pro-wp-error-group__body">
                <WorkProcessEventList events={g.events} compact />
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
