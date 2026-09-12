import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiThreadsToRecords, timelineToTraceSteps } from '../data/adapter'
import { fetchObsThreadTimeline, fetchObsThreadsSummary } from '../lib/obs-api'
import { fmtMs } from '../lib/obs-formatters'
import type { TraceRecord, TraceStep } from '../types'
import {
  ObsBanner,
  ObsEmpty,
  ObsPage,
  ObsSection,
  ObsSegmentTabs,
  ObsStatItem,
  ObsStatStrip,
} from '../components/ObsLayout'
import { StatusBadge } from '../components/StatusBadge'
import { TopFilterBar } from '../components/TopFilterBar'
import { ThreadLabel, useRegisterThreadIds } from '../components/ThreadLabel'
import { useThreadTitles } from '../hooks/useThreadTitles'
import { useObsCachedFetch } from '../hooks/useObsCachedFetch'

// ── CapCut-style horizontal timeline ──────────────────────────────────────

const PX_PER_MS_BASE = 0.3 // base scale: 0.3px per ms → 1s = 300px
const MIN_SCALE = 0.02
const MAX_SCALE = 8
const TRACK_HEIGHT = 44
const RULER_HEIGHT = 28

function niceTickStep(spanMs: number, targetTicks: number): number {
  const raw = spanMs / targetTicks
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 30000, 60000, 300000, 600000]
  for (const s of steps) if (s >= raw) return s
  return raw
}

type DragState = { startX: number; startScroll: number } | null

export function TimelineTrack({ trace }: { trace: TraceRecord }) {
  const items = trace.items
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [drag, setDrag] = useState<DragState>(null)
  const [hovered, setHovered] = useState<string | null>(null)

  const tsList = useMemo(
    () => items.flatMap((s) => [s.tsMs, s.endedMs]).filter((x): x is number => x != null),
    [items],
  )

  const { minTs, span } = useMemo(() => {
    if (!tsList.length) return { minTs: 0, span: 1 }
    const lo = Math.min(...tsList)
    const hi = Math.max(...tsList)
    return { minTs: lo, span: Math.max(hi - lo, 1) }
  }, [tsList])

  // Append 5% padding so last clip isn't flush against edge
  const totalWidth = Math.ceil((span * 1.05) * PX_PER_MS_BASE * scale)
  const msToX = useCallback((ms: number) => (ms - minTs) * PX_PER_MS_BASE * scale, [minTs, scale])

  // Wheel: ctrl/cmd+wheel → zoom at cursor; plain wheel → horizontal scroll
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      const el = scrollRef.current
      if (!el) return
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const delta = -e.deltaY * 0.002
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * (1 + delta)))
        // Zoom toward cursor position
        const rect = el.getBoundingClientRect()
        const cursorX = e.clientX - rect.left + el.scrollLeft
        const ratio = cursorX / Math.max(totalWidth, 1)
        setScale(next)
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollLeft = ratio * (span * 1.05 * PX_PER_MS_BASE * next) - (e.clientX - rect.left)
        })
      } else {
        // Let native horizontal scroll work; if trackpad sends deltaY, convert
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.shiftKey) {
          el.scrollLeft += e.deltaY
        }
      }
    },
    [scale, span, totalWidth],
  )

  // Drag to pan
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const el = scrollRef.current
    if (!el) return
    // Don't start drag when clicking on a clip
    if ((e.target as HTMLElement).closest('[data-clip]')) return
    setDrag({ startX: e.clientX, startScroll: el.scrollLeft })
  }, [])

  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!drag) return
      const el = scrollRef.current
      if (!el) return
      el.scrollLeft = drag.startScroll - (e.clientX - drag.startX)
    },
    [drag],
  )

  const endDrag = useCallback(() => setDrag(null), [])

  if (!tsList.length) {
    return (
      <div className="trace-timeline">
        {items.map((step, index) => (
          <div className="trace-step" key={step.id}>
            <div className="trace-index">{index + 1}</div>
            <div className="trace-node">
              <div className="trace-step-head">
                <strong>{step.title}</strong>
                <StatusBadge status={step.status} />
              </div>
              <p>
                {step.type} · {step.duration} · {step.meta}
              </p>
            </div>
          </div>
        ))}
      </div>
    )
  }

  // Ruler ticks
  const tickStep = niceTickStep(span, Math.max(totalWidth / 120, 4))
  const ticks: number[] = []
  for (let t = 0; t <= span; t += tickStep) ticks.push(t)

  const zoomIn = () => setScale((s) => Math.min(MAX_SCALE, s * 1.4))
  const zoomOut = () => setScale((s) => Math.max(MIN_SCALE, s / 1.4))
  const fitAll = () => {
    const el = scrollRef.current
    if (!el) return
    const availW = el.clientWidth - 20
    setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, availW / (span * 1.05 * PX_PER_MS_BASE))))
  }

  const clipColor = (step: TraceStep) =>
    step.status === 'failed'
      ? 'var(--obs-red,#ef4444)'
      : step.type === 'model'
        ? 'var(--obs-blue,#3b82f6)'
        : step.type === 'tool'
          ? 'var(--obs-green,#10b981)'
          : 'var(--obs-gray,#6b7280)'

  return (
    <div className="timeline-track-wrap" style={{ userSelect: drag ? 'none' : 'auto' }}>
      <style>{`@keyframes wf-pulse{0%,100%{opacity:1}50%{opacity:.4}}.timeline-clip{transition:filter .15s,transform .15s}.timeline-clip:hover{filter:brightness(1.25);transform:translateY(-1px)}`}</style>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px', fontSize: '12px' }}>
        <button type="button" onClick={zoomOut} style={{ padding: '2px 8px', borderRadius: '4px', cursor: 'pointer' }}>−</button>
        <span style={{ minWidth: '48px', textAlign: 'center', color: 'var(--obs-text-dim,#888)' }}>{Math.round(scale * 100)}%</span>
        <button type="button" onClick={zoomIn} style={{ padding: '2px 8px', borderRadius: '4px', cursor: 'pointer' }}>+</button>
        <button type="button" onClick={fitAll} style={{ padding: '2px 8px', borderRadius: '4px', cursor: 'pointer' }}>适配</button>
        <span style={{ marginLeft: 'auto', color: 'var(--obs-text-dim,#888)' }}>滚轮缩放 · 拖拽平移 · 点击查看</span>
      </div>
      {/* Scrollable track area */}
      <div
        ref={scrollRef}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
        style={{
          overflowX: 'auto',
          overflowY: 'hidden',
          cursor: drag ? 'grabbing' : 'grab',
          background: 'var(--obs-bg-dim,rgba(255,255,255,.02))',
          borderRadius: '6px',
          border: '1px solid var(--obs-border,#333)',
        }}
      >
        <div style={{ width: Math.max(totalWidth, 400), position: 'relative' }}>
          {/* Ruler */}
          <div
            style={{
              height: RULER_HEIGHT,
              position: 'relative',
              borderBottom: '1px solid var(--obs-border,#333)',
              background: 'var(--obs-bg-dim,rgba(0,0,0,.15))',
            }}
          >
            {ticks.map((t) => (
              <div
                key={t}
                style={{
                  position: 'absolute',
                  left: msToX(t),
                  top: 0,
                  bottom: 0,
                  borderLeft: '1px solid var(--obs-border-dim,rgba(255,255,255,.08))',
                }}
              >
                <span style={{ fontSize: '10px', color: 'var(--obs-text-dim,#888)', paddingLeft: '3px', lineHeight: `${RULER_HEIGHT}px` }}>
                  {fmtMs(t)}
                </span>
              </div>
            ))}
          </div>
          {/* Track lane */}
          <div style={{ height: TRACK_HEIGHT, position: 'relative' }}>
            {items.map((step) => {
              const x = msToX(step.tsMs ?? 0)
              const isRunning = step.statusRaw === 'running'
              const w = Math.max(
                isRunning ? 20 : msToX(step.endedMs ?? step.tsMs ?? 0) - x,
                3,
              )
              const isHovered = hovered === step.id
              return (
                <div
                  key={step.id}
                  data-clip
                  onClick={(e) => {
                    e.stopPropagation()
                    setHovered(hovered === step.id ? null : step.id)
                  }}
                  className="timeline-clip"
                  style={{
                    position: 'absolute',
                    left: x,
                    width: w,
                    top: 4,
                    bottom: 4,
                    backgroundColor: clipColor(step),
                    borderRadius: '4px',
                    opacity: step.status === 'failed' ? 0.55 : 0.88,
                    animation: isRunning ? 'wf-pulse 1.5s ease-in-out infinite' : undefined,
                    overflow: 'hidden',
                    display: 'flex',
                    alignItems: 'center',
                    cursor: 'pointer',
                    boxShadow: isHovered ? '0 0 0 2px rgba(255,255,255,.4)' : undefined,
                    zIndex: isHovered ? 10 : 1,
                  }}
                  title={`${step.title} · ${step.duration}`}
                >
                  <span
                    style={{
                      fontSize: '10px',
                      color: 'rgba(255,255,255,.9)',
                      padding: '0 5px',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      textShadow: '0 1px 2px rgba(0,0,0,.5)',
                      fontWeight: 500,
                    }}
                  >
                    {step.title}
                  </span>
                </div>
              )
            })}
          </div>
          {/* Tooltip for hovered clip */}
          {hovered && (() => {
            const step = items.find((s) => s.id === hovered)
            if (!step) return null
            const x = msToX(step.tsMs ?? 0)
            return (
              <div
                style={{
                  position: 'absolute',
                  left: Math.min(x, totalWidth - 220),
                  top: RULER_HEIGHT + TRACK_HEIGHT + 4,
                  zIndex: 20,
                  background: 'var(--obs-bg-card,#1a1a2e)',
                  border: '1px solid var(--obs-border,#333)',
                  borderRadius: '6px',
                  padding: '8px 12px',
                  fontSize: '12px',
                  maxWidth: '240px',
                  boxShadow: '0 4px 12px rgba(0,0,0,.4)',
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: '4px' }}>{step.title}</div>
                <div style={{ color: 'var(--obs-text-dim,#aaa)' }}>
                  类型 {step.type} · 耗时 {step.duration}
                </div>
                {step.meta && <div style={{ color: 'var(--obs-text-dim,#aaa)', marginTop: '2px' }}>{step.meta}</div>}
                <div style={{ marginTop: '4px' }}>
                  <StatusBadge status={step.status} />
                </div>
              </div>
            )
          })()}
        </div>
      </div>
    </div>
  )
}

/** Group timeline items into rounds by model invocations.
 * Each `model` item starts a new round; non-model items attach to the
 * current round. Items before the first model go into "Round 0" (pre-round).
 */
function groupByRounds(items: TraceStep[]): { round: number; startTsMs?: number; steps: TraceStep[] }[] {
  const rounds: { round: number; startTsMs?: number; steps: TraceStep[] }[] = []
  let current: { round: number; startTsMs?: number; steps: TraceStep[] } | null = null
  let roundNum = 0
  for (const step of items) {
    if (step.type === 'model') {
      roundNum++
      current = { round: roundNum, startTsMs: step.tsMs, steps: [] }
      rounds.push(current)
    }
    if (!current) {
      current = { round: 0, startTsMs: step.tsMs, steps: [] }
      rounds.push(current)
    }
    current.steps.push(step)
  }
  return rounds
}

function fmtTimeOfDay(ms?: number): string {
  if (ms == null) return '—'
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function TraceTimeline({ trace }: { trace: TraceRecord }) {
  const items = trace.items
  const tsList = items.flatMap((s) => [s.tsMs, s.endedMs]).filter((x): x is number => x != null)

  // Fallback: no timestamp data — render as simple list
  if (!tsList.length) {
    return (
      <div className="trace-timeline">
        {items.map((step, index) => (
          <div className="trace-step" key={step.id}>
            <div className="trace-index">{index + 1}</div>
            <div className="trace-node">
              <div className="trace-step-head">
                <strong>{step.title}</strong>
                <StatusBadge status={step.status} />
              </div>
              <p>
                {step.type} · {step.duration} · {step.meta}
              </p>
            </div>
          </div>
        ))}
      </div>
    )
  }

  const minTs = Math.min(...tsList)
  const maxTs = Math.max(...tsList)
  const span = Math.max(maxTs - minTs, 1)
  const pct = (ts: number | undefined) => (ts == null ? 0 : ((ts - minTs) / span) * 100)

  const rounds = groupByRounds(items)

  return (
    <div className="trace-waterfall">
      <style>{`@keyframes wf-pulse{0%,100%{opacity:1}50%{opacity:.35}}`}</style>
      {/* Time axis */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          padding: '4px 140px 4px 160px',
          fontSize: '11px',
          color: 'var(--obs-text-dim,#888)',
          borderBottom: '1px solid var(--obs-border,#333)',
        }}
      >
        <span>0ms</span>
        <span>{fmtMs(span)}</span>
      </div>
      {rounds.map((rd) => {
        const rdTs = rd.steps.flatMap((s) => [s.tsMs, s.endedMs]).filter((x): x is number => x != null)
        const rdMin = rdTs.length ? Math.min(...rdTs) : 0
        const rdMax = rdTs.length ? Math.max(...rdTs) : 0
        const rdSpan = Math.max(rdMax - rdMin, 0)
        const isPreRound = rd.round === 0
        return (
          <div key={`round-${rd.round}`} style={{ marginBottom: '6px' }}>
            {/* Round header */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '4px 0 2px',
                fontSize: '11px',
                fontWeight: 600,
                color: 'var(--obs-text-dim,#aaa)',
                borderBottom: '1px dashed var(--obs-border-dim,rgba(255,255,255,.06))',
              }}
            >
              <span
                style={{
                  display: 'inline-block',
                  padding: '1px 7px',
                  borderRadius: '8px',
                  fontSize: '10px',
                  background: isPreRound
                    ? 'var(--obs-gray-dim,rgba(107,114,128,.2))'
                    : 'var(--obs-blue-dim,rgba(59,130,246,.15))',
                  color: isPreRound ? 'var(--obs-text-dim,#888)' : 'var(--obs-blue,#60a5fa)',
                }}
              >
                {isPreRound ? '轮前' : `第 ${rd.round} 轮`}
              </span>
              <span>{fmtTimeOfDay(rd.startTsMs)}</span>
              {rdSpan > 0 && <span style={{ color: 'var(--obs-text-dim,#666)' }}>· 耗时 {fmtMs(rdSpan)}</span>}
              <span style={{ color: 'var(--obs-text-dim,#555)' }}>· {rd.steps.length} 个事件</span>
            </div>
            {/* Steps in this round */}
            {rd.steps.map((step, idx) => {
              const left = pct(step.tsMs)
              const isRunning = step.statusRaw === 'running'
              const right = isRunning ? 100 : pct(step.endedMs ?? step.tsMs)
              const width = Math.max(right - left, 1.5)
              const barColor =
                step.type === 'model'
                  ? 'var(--obs-blue,#3b82f6)'
                  : step.type === 'tool'
                    ? 'var(--obs-green,#10b981)'
                    : 'var(--obs-gray,#6b7280)'
              return (
                <div
                  key={step.id}
                  style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 0', fontSize: '12px' }}
                >
                  <span style={{ width: '20px', textAlign: 'right', color: 'var(--obs-text-dim,#888)', flexShrink: 0 }}>
                    {idx + 1}
                  </span>
                  <span
                    style={{ width: '130px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }}
                    title={step.title}
                  >
                    {step.title}
                  </span>
                  <div
                    style={{
                      flex: 1,
                      position: 'relative',
                      height: '16px',
                      background: 'var(--obs-bg-dim,rgba(255,255,255,.03))',
                      borderRadius: '3px',
                    }}
                  >
                    <div
                      style={{
                        position: 'absolute',
                        left: `${left}%`,
                        width: `${width}%`,
                        height: '100%',
                        backgroundColor: barColor,
                        borderRadius: '3px',
                        opacity: step.status === 'failed' ? 0.5 : 0.85,
                        animation: isRunning ? 'wf-pulse 1.5s ease-in-out infinite' : undefined,
                      }}
                    />
                  </div>
                  <span style={{ width: '56px', textAlign: 'right', color: 'var(--obs-text-dim,#888)', flexShrink: 0 }}>
                    {step.duration}
                  </span>
                  <span style={{ width: '60px', flexShrink: 0 }}>
                    <StatusBadge status={step.status} />
                  </span>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

export function Trace() {
  const { displayLabel } = useThreadTitles()
  const [selected, setSelected] = useState<TraceRecord | null>(null)
  const [viewMode, setViewMode] = useState<'waterfall' | 'timeline'>('waterfall')

  const { data: traces, loading, error } = useObsCachedFetch<TraceRecord[]>({
    scope: 'trace-threads',
    fetcher: async (query) => {
      const res = await fetchObsThreadsSummary({ ...query, page: 1, pageSize: 30 })
      if ((res as { enabled?: boolean })?.enabled === false) throw new Error('观测数据未启用')
      const items = (res as { items?: unknown[] })?.items
      return Array.isArray(items) ? apiThreadsToRecords(items) : []
    },
  })

  const safeTraces = traces ?? []

  useEffect(() => {
    if (safeTraces.length === 0) {
      queueMicrotask(() => setSelected(null))
      return
    }
    queueMicrotask(() => setSelected((prev) => {
      if (prev && safeTraces.some((t) => t.id === prev.id)) return prev
      return safeTraces[0] ?? null
    }))
  }, [safeTraces])

  useEffect(() => {
    if (!selected?.threadId) return
    void fetchObsThreadTimeline(selected.threadId, 200).then((res) => {
      const items = (res as { items?: unknown[] })?.items
      if (!Array.isArray(items)) return
      setSelected((prev) =>
        prev
          ? {
              ...prev,
              items: timelineToTraceSteps(items),
              steps: items.length,
            }
          : prev,
      )
    })
  }, [selected?.threadId])

  useRegisterThreadIds(safeTraces.map((trace) => trace.threadId))

  const active = selected ?? safeTraces[0]

  const stats = useMemo(() => {
    const failed = safeTraces.filter((t) => t.status === 'failed').length
    const totalSteps = safeTraces.reduce((sum, t) => sum + t.steps, 0)
    return { count: safeTraces.length, failed, totalSteps }
  }, [safeTraces])

  return (
    <>
      <TopFilterBar title="会话追踪" subtitle="Thread 会话链路、模型/工具事件时间线" />
      {loading && !traces && <ObsBanner>加载 Trace 数据…</ObsBanner>}
      {error && !loading && <ObsBanner tone="error">{error}</ObsBanner>}

      <ObsPage className="trace-layout">
        <ObsStatStrip>
          <ObsStatItem label="会话数" value={stats.count} hint="当前窗口" variant="accent" />
          <ObsStatItem label="失败" value={stats.failed} hint="需关注" variant="danger" />
          <ObsStatItem label="总步骤" value={stats.totalSteps} hint="所有会话" />
        </ObsStatStrip>

        <ObsSection title="Trace 列表" className="trace-list-panel">
          <div className="trace-search">
            <input placeholder="搜索 trace_id / thread_id / request_id" />
          </div>
          {safeTraces.length === 0 && !loading ? (
            <ObsEmpty>暂无 Trace 数据</ObsEmpty>
          ) : (
            <div className="trace-list">
              {safeTraces.map((trace) => (
                <button
                  type="button"
                  className={active?.id === trace.id ? 'trace-list-item active' : 'trace-list-item'}
                  key={trace.id}
                  onClick={() => setSelected(trace)}
                >
                  <div>
                    <strong>{trace.id}</strong>
                    <StatusBadge status={trace.status} />
                  </div>
                  <p>{trace.summary}</p>
                  <span>
                    <ThreadLabel threadId={trace.threadId} /> · {trace.agent} · {trace.duration} · {trace.steps} steps
                  </span>
                </button>
              ))}
            </div>
          )}
        </ObsSection>

        {active && (
          <ObsSection
            title={`Trace: ${active.id}`}
            subtitle={`${active.agent} · ${displayLabel(active.threadId)} · ${active.startedAt}`}
            className="trace-detail-card"
            actions={
              <>
                <ObsSegmentTabs
                  value={viewMode}
                  options={[
                    { value: 'timeline' as const, label: '时间轴' },
                    { value: 'waterfall' as const, label: '瀑布图' },
                  ]}
                  onChange={setViewMode}
                />
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => {
                    window.location.hash = `#/debug/agent-trace?thread_id=${encodeURIComponent(active.threadId)}`
                  }}
                >
                  深度调试
                </button>
              </>
            }
          >
            <div className="trace-summary-strip">
              <span>
                耗时 <strong>{active.duration}</strong>
              </span>
              <span>
                步骤 <strong>{active.steps}</strong>
              </span>
              <span>
                轮次 <strong>{active.items.filter((s) => s.type === 'model').length}</strong>
              </span>
              <span>
                状态 <StatusBadge status={active.status} />
              </span>
              <span>
                Agent <strong>{active.agent}</strong>
              </span>
            </div>
            {viewMode === 'timeline' ? <TimelineTrack key={active.id} trace={active} /> : <TraceTimeline trace={active} />}
          </ObsSection>
        )}
      </ObsPage>
    </>
  )
}
