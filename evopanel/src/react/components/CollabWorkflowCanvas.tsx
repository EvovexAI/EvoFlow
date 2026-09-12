import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  AgentInfo,
  CollabSubtaskSnapshot,
  SubagentStreamTaskMap,
  SubtaskTranscriptModalPayload,
} from '../chat-types.js'
import { fetchSubtaskConversationHistory } from '../../lib/subtask-conversation-history.js'
import { layoutSubtaskDagCanvas, subtaskDagEdgePath, buildSubtaskDagIndex } from '../../lib/collab-subtask-dag.js'
import { collabDagDebug } from '../../lib/collab-dag-debug.js'
import { resolveAssignedAgentDisplayName } from '../../lib/tool-display.js'
import { resolveSubtaskLivePreview } from '../../lib/subtask-preview-text.js'
import { formatTaskStatusZh, taskStatusBadgeClass } from '../../lib/task-status-label.js'
import { formatSubtaskObsLine } from '../../lib/task-observability-format.js'
import { SubtaskLiveTicker } from './SubtaskLiveTicker.js'
import { HoverBubble, HoverBubbleProvider } from './HoverBubble.js'
import { AssignedAgentAvatar } from './AssignedAgentAvatar.js'

function normalizeStatus(status?: string): string {
  return String(status || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')
}

function isRunningStatus(status?: string): boolean {
  const s = normalizeStatus(status)
  return s === 'in_progress' || s === 'running' || s === 'executing' || s === 'active'
}

function isCompletedStatus(status?: string): boolean {
  const s = normalizeStatus(status)
  return s === 'completed' || s === 'done'
}

function resolveNodeDisplayStatus(collabStatus: string | undefined): string {
  const raw = String(collabStatus || '').trim()
  return raw || 'pending'
}

function subtaskTitle(s: CollabSubtaskSnapshot): string {
  const raw = (s.name || s.description || s.subtaskId || '').trim() || '子任务'
  if (raw.startsWith('Subtask_') || raw.startsWith('Task_')) {
    const parts = raw.split('_')
    if (parts.length >= 3) {
      return `子任务 #${parts[parts.length - 1].slice(0, 6)}`
    }
  }
  return raw
}

function clipText(text: string, max: number): string {
  const t = String(text || '').trim()
  if (!t) return ''
  if (t.length <= max) return t
  return `${t.slice(0, Math.max(0, max - 1))}…`
}

function resolveTaskResult(s: CollabSubtaskSnapshot): string {
  const raw = String(s.taskReport || s.result || s.outputSummary || '').trim()
  return raw.replace(/^【完成】[\s\n]*/u, '').trim()
}

function toProgressPct(s: CollabSubtaskSnapshot): number | null {
  if (typeof s.progress === 'number' && !Number.isNaN(s.progress)) {
    return Math.min(100, Math.max(0, Math.round(s.progress)))
  }
  return null
}

function WorkflowNode({
  s,
  layout,
  subagentTasks,
  mainTaskId,
  leadThreadId,
  agents,
  onOpen,
  obsMetrics,
}: {
  s: CollabSubtaskSnapshot
  layout: { x: number; y: number; w: number; h: number }
  subagentTasks?: SubagentStreamTaskMap
  mainTaskId: string
  leadThreadId?: string | null
  agents?: AgentInfo[]
  onOpen: (payload: SubtaskTranscriptModalPayload) => void
  obsMetrics?: Record<string, unknown> | null
}) {
  const title = subtaskTitle(s)
  const displayStatus = useMemo(() => resolveNodeDisplayStatus(s.status), [s.status])
  const statusLabel = formatTaskStatusZh(displayStatus, { fallback: '待处理' })
  const statusClass = taskStatusBadgeClass(displayStatus)
  const running = isRunningStatus(displayStatus)
  const done = isCompletedStatus(displayStatus)
  const code = (s.assignedAgent || '').trim()
  const agentName =
    String(s.assignedAgentDisplay || '').trim() ||
    (code ? resolveAssignedAgentDisplayName(code, agents) : '') ||
    '未分配'
  const refLabel = String(s.ref || '').trim()
  const progressPct = toProgressPct(s)
  const buffering = running && progressPct != null && progressPct < 100
  const taskResult = useMemo(() => resolveTaskResult(s), [s])
  const statusHint = String(
    (s as { currentStep?: string }).currentStep ||
      (s as { current_step?: string }).current_step ||
      '',
  ).trim()
  const terminal = isCompletedStatus(displayStatus) || normalizeStatus(displayStatus) === 'failed'

  const livePreview = useMemo(
    () =>
      resolveSubtaskLivePreview({
        subtaskId: String(s.subtaskId || ''),
        fallbackTitle: title,
        running,
        terminal,
        subagentTasks,
        statusHint,
        terminalFallback: taskResult,
      }),
    [s.subtaskId, title, running, terminal, subagentTasks, statusHint, taskResult],
  )

  const showLiveTicker = running || (livePreview.hasLiveContent && !terminal)

  const fullTitle = `${agentName} · ${title}`
  const obsLine = useMemo(() => formatSubtaskObsLine(obsMetrics), [obsMetrics])

  const handleOpen = () => {
    const mid = String(mainTaskId || s.parentTaskId || '').trim()
    const sid = String(s.subtaskId || '').trim()
    const lead = String(leadThreadId || '').trim()
    if (!mid || !sid) {
      onOpen({ subtaskId: sid, mainTaskId: mid, leadThreadId: lead, title: fullTitle, status: displayStatus, rows: [] })
      return
    }
    void fetchSubtaskConversationHistory({
      mainTaskId: mid,
      subtaskId: sid,
      leadThreadId: lead,
      subtaskSnapshot: s as unknown as Record<string, unknown>,
    })
      .then((resp) => {
        onOpen({
          subtaskId: sid,
          mainTaskId: mid,
          leadThreadId: lead,
          title: fullTitle,
          status: displayStatus,
          initialText: '',
          rows: resp.rows,
          emptyConversation: resp.emptyConversation,
          outcome: resp.outcome,
        })
      })
      .catch(() => {
        onOpen({
          subtaskId: sid,
          mainTaskId: mid,
          leadThreadId: lead,
          title: fullTitle,
          status: displayStatus,
          rows: [],
        })
      })
  }

  return (
    <HoverBubble
      variant="rich"
      title={fullTitle}
      body={[livePreview.previewText, statusLabel].filter(Boolean).join('\n')}
      side="bottom"
      align="start"
      maxWidth={560}
      maxHeight={260}
      asChild
    >
      <button
        type="button"
        className={`collab-wf-node ${statusClass}${running ? ' is-running' : ''}${done ? ' is-done' : ''}`}
        style={{ left: layout.x, top: layout.y, width: layout.w, height: layout.h }}
        onClick={handleOpen}
      >
        <div className="collab-wf-node-agent-row">
          <HoverBubble text={statusLabel} side="top" align="center" maxWidth={200} asChild>
            <span
              className={`react-chat-subtask-status-light ${statusClass}`}
              aria-label={statusLabel}
            />
          </HoverBubble>
          <span className="collab-wf-node-agent-ico" aria-hidden>
            <AssignedAgentAvatar agentCode={code} agents={agents} size={16} busy={running} />
          </span>
          <span className="collab-wf-node-agent-name">{agentName}</span>
        </div>
        {progressPct != null ? (
          <div className="collab-wf-node-status-row">
            {refLabel ? <span className="collab-wf-node-ref">#{refLabel}</span> : null}
            <div className="collab-wf-node-progress-bar" aria-hidden>
              <span className={`collab-wf-node-progress-fill${buffering ? ' is-buffering' : ''}`} style={{ width: `${progressPct}%` }} />
            </div>
            <span className="collab-wf-node-progress-pct">{progressPct}%</span>
          </div>
        ) : refLabel ? (
          <span className="collab-wf-node-ref">#{refLabel}</span>
        ) : null}
        <div className="collab-wf-node-task-text">{title}</div>
        {obsLine ? (
          <HoverBubble text="该子任务线程的模型/工具/Token 统计" side="top" align="start" maxWidth={280}>
            <div className="collab-wf-node-obs">{obsLine}</div>
          </HoverBubble>
        ) : null}
        {showLiveTicker && livePreview.previewText ? (
          <div className={`collab-wf-node-live${running ? ' is-live' : ''}`}>
            <SubtaskLiveTicker text={livePreview.previewText} className="collab-wf-node-ticker" />
          </div>
        ) : !running && taskResult ? (
          <div className="collab-wf-node-result">{clipText(taskResult, 88)}</div>
        ) : null}
      </button>
    </HoverBubble>
  )
}

export interface CollabWorkflowCanvasProps {
  subtasks: CollabSubtaskSnapshot[]
  mainTaskId: string
  /** LangGraph lead thread uuid for subtask transcript lookup */
  leadThreadId?: string | null
  subagentTasks?: SubagentStreamTaskMap
  agents?: AgentInfo[]
  onSubtaskTranscriptOpen: (payload: SubtaskTranscriptModalPayload) => void
  subtaskObservability?: Record<string, Record<string, unknown>>
  /** 缩放画布以适应容器（工作流页） */
  fillContainer?: boolean
}

function fitCanvasInBox(
  boxWidth: number,
  boxHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  padding = 32,
): { scale: number; offsetX: number; offsetY: number } {
  const availW = Math.max(0, boxWidth - padding)
  const availH = Math.max(0, boxHeight - padding)
  if (!availW || !availH || !canvasWidth || !canvasHeight) {
    return { scale: 1, offsetX: 0, offsetY: 0 }
  }
  const rawScale = Math.min(availW / canvasWidth, availH / canvasHeight)
  // 初始适应：只缩小不放大，避免大屏节点被撑得过大
  const safeScale = Math.max(0.25, Math.min(rawScale, 1))
  return {
    scale: safeScale,
    offsetX: Math.max(0, (boxWidth - canvasWidth * safeScale) / 2),
    offsetY: Math.max(0, (boxHeight - canvasHeight * safeScale) / 2),
  }
}

const VIEW_SCALE_MIN = 0.25
const VIEW_SCALE_MAX = 2.5

function clampViewScale(scale: number): number {
  return Math.max(VIEW_SCALE_MIN, Math.min(VIEW_SCALE_MAX, scale))
}

function scaleFromWheel(deltaY: number, current: number): number {
  if (!deltaY) return current
  const factor = Math.exp(-deltaY * 0.0025)
  return clampViewScale(current * factor)
}

function centerCanvasInBox(
  boxWidth: number,
  boxHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  scale: number,
): { x: number; y: number } {
  return {
    x: Math.max(0, (boxWidth - canvasWidth * scale) / 2),
    y: Math.max(0, (boxHeight - canvasHeight * scale) / 2),
  }
}

export function CollabWorkflowCanvas({
  subtasks,
  mainTaskId,
  leadThreadId,
  subagentTasks,
  agents,
  onSubtaskTranscriptOpen,
  subtaskObservability,
  fillContainer = false,
}: CollabWorkflowCanvasProps) {
  const dag = useMemo(() => buildSubtaskDagIndex(subtasks), [subtasks])
  const canvas = useMemo(() => layoutSubtaskDagCanvas(dag), [dag])

  useEffect(() => {
    if (!subtasks.length) return
    collabDagDebug('workflow_layout', {
      nodeCount: subtasks.length,
      edgeCount: canvas.edges.length,
      roots: dag.roots,
      edges: canvas.edges,
      positions: [...canvas.positions.entries()].map(([id, p]) => ({
        id,
        x: p.x,
        y: p.y,
        dependsOn: subtasks.find((s) => String(s.subtaskId || '').trim() === id)?.dependsOn ?? [],
      })),
    })
  }, [subtasks, dag.roots, canvas.edges, canvas.positions])
  const runningSet = useMemo(() => {
    const s = new Set<string>()
    for (const sub of subtasks) {
      if (isRunningStatus(sub.status)) s.add(String(sub.subtaskId || '').trim())
    }
    return s
  }, [subtasks])

  const activeEdgeKeys = useMemo(() => {
    const s = new Set<string>()
    for (const e of canvas.edges) {
      if (runningSet.has(e.to)) s.add(`${e.from}-${e.to}`)
    }
    return s
  }, [canvas.edges, runningSet])

  const [expanded, setExpanded] = useState(false)
  const [expandScale, setExpandScale] = useState(1)
  const [expandPan, setExpandPan] = useState({ x: 0, y: 0 })
  const [expandBodySize, setExpandBodySize] = useState({ w: 0, h: 0 })
  const expandPanning = useRef(false)
  const expandPanStart = useRef({ x: 0, y: 0 })
  const expandPanOffset = useRef({ x: 0, y: 0 })
  const bodyRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [inlineScale, setInlineScale] = useState(1)
  const [inlinePan, setInlinePan] = useState({ x: 0, y: 0 })
  const [wrapSize, setWrapSize] = useState({ w: 0, h: 0 })
  const inlinePanning = useRef(false)
  const inlinePanStart = useRef({ x: 0, y: 0 })
  const inlinePanOffset = useRef({ x: 0, y: 0 })

  const expandCenter = useMemo(
    () => centerCanvasInBox(expandBodySize.w, expandBodySize.h, canvas.width, canvas.height, expandScale),
    [expandBodySize.w, expandBodySize.h, canvas.width, canvas.height, expandScale],
  )

  const inlineCenter = useMemo(
    () => centerCanvasInBox(wrapSize.w, wrapSize.h, canvas.width, canvas.height, inlineScale),
    [wrapSize.w, wrapSize.h, canvas.width, canvas.height, inlineScale],
  )

  const applyExpandFit = useCallback(() => {
    const body = bodyRef.current
    if (!body) return
    const fit = fitCanvasInBox(body.clientWidth, body.clientHeight, canvas.width, canvas.height)
    setExpandBodySize({ w: body.clientWidth, h: body.clientHeight })
    setExpandScale(fit.scale)
    setExpandPan({ x: 0, y: 0 })
  }, [canvas.width, canvas.height])

  const applyInlineFit = useCallback(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const fit = fitCanvasInBox(wrap.clientWidth, wrap.clientHeight, canvas.width, canvas.height, 16)
    setWrapSize({ w: wrap.clientWidth, h: wrap.clientHeight })
    setInlineScale(fit.scale)
    setInlinePan({ x: 0, y: 0 })
  }, [canvas.width, canvas.height])

  useEffect(() => {
    if (!fillContainer) {
      queueMicrotask(() => {
        setInlineScale(1)
        setInlinePan({ x: 0, y: 0 })
        setWrapSize({ w: 0, h: 0 })
      })
      return
    }
    const wrap = wrapRef.current
    if (!wrap) return
    const syncSize = () => {
      setWrapSize({ w: wrap.clientWidth, h: wrap.clientHeight })
    }
    syncSize()
    applyInlineFit()
    const ro = new ResizeObserver(() => syncSize())
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [fillContainer, applyInlineFit, canvas.width, canvas.height])

  useEffect(() => {
    if (!fillContainer) return
    const el = wrapRef.current
    if (!el) return
    let pendingDeltaY = 0
    let rafId = 0
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      pendingDeltaY += e.deltaY
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        const dy = pendingDeltaY
        pendingDeltaY = 0
        setInlineScale((s) => scaleFromWheel(dy, s))
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      el.removeEventListener('wheel', onWheel)
    }
  }, [fillContainer])

  const handleOpenExpand = useCallback(() => {
    setExpanded(true)
    requestAnimationFrame(() => applyExpandFit())
  }, [applyExpandFit])

  useEffect(() => {
    if (!expanded) return
    applyExpandFit()
    const body = bodyRef.current
    if (!body) return
    const syncSize = () => {
      setExpandBodySize({ w: body.clientWidth, h: body.clientHeight })
    }
    syncSize()
    const ro = new ResizeObserver(() => syncSize())
    ro.observe(body)
    return () => ro.disconnect()
  }, [expanded, applyExpandFit])

  useEffect(() => {
    if (!expanded) return
    const el = bodyRef.current
    if (!el) return
    let pendingDeltaY = 0
    let rafId = 0
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      pendingDeltaY += e.deltaY
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        const dy = pendingDeltaY
        pendingDeltaY = 0
        setExpandScale((s) => scaleFromWheel(dy, s))
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      el.removeEventListener('wheel', onWheel)
    }
  }, [expanded])

  // ESC 关闭弹窗
  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [expanded])

  const handleExpandMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('.collab-wf-node')) return
    expandPanning.current = true
    expandPanStart.current = { x: e.clientX, y: e.clientY }
    expandPanOffset.current = { x: expandPan.x, y: expandPan.y }
  }, [expandPan])

  const handleExpandMouseMove = useCallback((e: React.MouseEvent) => {
    if (!expandPanning.current) return
    setExpandPan({
      x: expandPanOffset.current.x + (e.clientX - expandPanStart.current.x),
      y: expandPanOffset.current.y + (e.clientY - expandPanStart.current.y),
    })
  }, [])

  const handleExpandMouseUp = useCallback(() => {
    expandPanning.current = false
  }, [])

  const handleInlineMouseDown = useCallback((e: React.MouseEvent) => {
    if (!fillContainer || e.button !== 0) return
    if ((e.target as HTMLElement).closest('.collab-wf-node')) return
    inlinePanning.current = true
    inlinePanStart.current = { x: e.clientX, y: e.clientY }
    inlinePanOffset.current = { x: inlinePan.x, y: inlinePan.y }
  }, [fillContainer, inlinePan])

  const handleInlineMouseMove = useCallback((e: React.MouseEvent) => {
    if (!inlinePanning.current) return
    setInlinePan({
      x: inlinePanOffset.current.x + (e.clientX - inlinePanStart.current.x),
      y: inlinePanOffset.current.y + (e.clientY - inlinePanStart.current.y),
    })
  }, [])

  const handleInlineMouseUp = useCallback(() => {
    inlinePanning.current = false
  }, [])

  const edgesSvg = (
    <svg className="collab-wf-edges" width={canvas.width} height={canvas.height} aria-hidden>
      {canvas.edges.map(({ from, to }) => {
        const a = canvas.positions.get(from)
        const b = canvas.positions.get(to)
        if (!a || !b) return null
        const key = `${from}-${to}`
        const active = activeEdgeKeys.has(key)
        return (
          <path
            key={key}
            className={`collab-wf-edge${active ? ' collab-wf-edge--active' : ''}`}
            d={subtaskDagEdgePath(a, b)}
            fill="none"
          />
        )
      })}
    </svg>
  )

  const nodesDiv = (
    <div className="collab-wf-nodes">
      {subtasks.map((s) => {
        const id = String(s.subtaskId || '').trim()
        const layout = canvas.positions.get(id)
        if (!layout) return null
        return (
          <WorkflowNode
            key={id}
            s={s}
            layout={layout}
            subagentTasks={subagentTasks}
            mainTaskId={mainTaskId}
            leadThreadId={leadThreadId}
            agents={agents}
            onOpen={onSubtaskTranscriptOpen}
            obsMetrics={subtaskObservability?.[id] ?? null}
          />
        )
      })}
    </div>
  )

  const expandedContent = (
    <div
      style={{
        position: 'absolute',
        top: expandCenter.y,
        left: expandCenter.x,
        width: canvas.width,
        height: canvas.height,
        transform: `translate3d(${expandPan.x}px, ${expandPan.y}px, 0) scale(${expandScale})`,
        transformOrigin: '0 0',
        willChange: 'transform',
      }}
    >
      <svg width={canvas.width} height={canvas.height} style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }} aria-hidden>
        {canvas.edges.map(({ from, to }) => {
          const a = canvas.positions.get(from)
          const b = canvas.positions.get(to)
          if (!a || !b) return null
          const key = `${from}-${to}`
          const active = activeEdgeKeys.has(key)
          return (
            <path
              key={key}
              d={subtaskDagEdgePath(a, b)}
              fill="none"
              className={active ? 'collab-wf-edge--active' : undefined}
              stroke={active ? undefined : 'var(--border, #94a3b8)'}
              strokeWidth="1.5"
              opacity="0.85"
            />
          )
        })}
      </svg>
      {nodesDiv}
    </div>
  )

  const canvasLayer = (
    <>
      {edgesSvg}
      {nodesDiv}
    </>
  )

  const inlineViewportStyle = fillContainer
    ? {
        position: 'absolute' as const,
        top: inlineCenter.y,
        left: inlineCenter.x,
        width: canvas.width,
        height: canvas.height,
        transform: `translate3d(${inlinePan.x}px, ${inlinePan.y}px, 0) scale(${inlineScale})`,
        transformOrigin: '0 0',
        willChange: 'transform',
      }
    : undefined

  return (
    <HoverBubbleProvider>
    <div
      ref={wrapRef}
      className={`collab-wf-canvas-wrap${fillContainer ? ' collab-wf-canvas-wrap--fit collab-wf-canvas-wrap--interactive' : ''}`}
      onMouseDown={fillContainer ? handleInlineMouseDown : undefined}
      onMouseMove={fillContainer ? handleInlineMouseMove : undefined}
      onMouseUp={fillContainer ? handleInlineMouseUp : undefined}
      onMouseLeave={fillContainer ? handleInlineMouseUp : undefined}
    >
      <div className="collab-wf-canvas-toolbar">
        {fillContainer ? (
          <div className="collab-wf-canvas-zoom" aria-label="画布缩放">
            <button
              type="button"
              className="collab-wf-expand-zoom-btn"
              onClick={() => setInlineScale((s) => clampViewScale(s * 0.9))}
              title="缩小"
            >
              −
            </button>
            <span className="collab-wf-expand-zoom-label">{Math.round(inlineScale * 100)}%</span>
            <button
              type="button"
              className="collab-wf-expand-zoom-btn"
              onClick={() => setInlineScale((s) => clampViewScale(s * 1.1))}
              title="放大"
            >
              +
            </button>
            <button
              type="button"
              className="collab-wf-expand-zoom-btn"
              onClick={() => applyInlineFit()}
              title="适应窗口"
              style={{ fontSize: 11, fontWeight: 600 }}
            >
              ⟲
            </button>
          </div>
        ) : null}
        <button
          type="button"
          className="collab-wf-expand-btn"
          title="全屏查看"
          onClick={handleOpenExpand}
          aria-label="全屏查看工作流"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 3 21 3 21 9" />
            <polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="14" y2="10" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        </button>
      </div>
      {fillContainer ? (
        <div className="collab-wf-canvas-scaler" style={inlineViewportStyle}>
          <div
            className="collab-wf-canvas"
            style={{
              width: canvas.width,
              height: canvas.height,
              minWidth: canvas.width,
              minHeight: canvas.height,
            }}
          >
            {canvasLayer}
          </div>
        </div>
      ) : (
        <div className="collab-wf-canvas-scaler">
          <div
            className="collab-wf-canvas"
            style={{
              width: canvas.width,
              height: canvas.height,
              minWidth: canvas.width,
              minHeight: canvas.height,
            }}
          >
            {canvasLayer}
          </div>
        </div>
      )}
      {expanded && typeof document !== 'undefined'
        ? createPortal(
            <div className="react-chat-modal-overlay collab-wf-expand-overlay" onClick={(e) => { if (e.target === e.currentTarget) setExpanded(false) }}>
              <div className="collab-wf-expand-card">
                <div className="collab-wf-expand-card-header">
                  <span className="collab-wf-expand-card-title">工作流视图</span>
                  <div className="collab-wf-expand-card-zoom">
                    <button type="button" className="collab-wf-expand-zoom-btn" onClick={() => setExpandScale((s) => clampViewScale(s * 0.9))} title="缩小">−</button>
                    <span className="collab-wf-expand-zoom-label">{Math.round(expandScale * 100)}%</span>
                    <button type="button" className="collab-wf-expand-zoom-btn" onClick={() => setExpandScale((s) => clampViewScale(s * 1.1))} title="放大">+</button>
                    <button type="button" className="collab-wf-expand-zoom-btn" onClick={() => applyExpandFit()} title="适应窗口" style={{ fontSize: 11, fontWeight: 600 }}>⟲</button>
                    <button type="button" className="react-chat-modal-close" onClick={() => setExpanded(false)} style={{ marginLeft: 4 }}>×</button>
                  </div>
                </div>
                <div
                  ref={bodyRef}
                  className="collab-wf-expand-card-body"
                  onMouseDown={handleExpandMouseDown}
                  onMouseMove={handleExpandMouseMove}
                  onMouseUp={handleExpandMouseUp}
                  onMouseLeave={handleExpandMouseUp}
                >
                  {expandedContent}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
    </HoverBubbleProvider>
  )
}
