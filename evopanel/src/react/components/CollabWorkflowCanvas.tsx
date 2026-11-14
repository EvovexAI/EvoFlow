import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  AgentInfo,
  CollabSubtaskSnapshot,
  SubagentStreamTaskMap,
  SubtaskTranscriptModalPayload,
} from '../chat-types.js'
import { useSoftProgressDisplay } from '../hooks/useSoftProgressDisplay.js'
import { layoutSubtaskDagCanvas, subtaskDagEdgePath, buildSubtaskDagIndex } from '../../lib/collab-subtask-dag.js'
import { collabDagDebug } from '../../lib/collab-dag-debug.js'
import { resolveAssignedAgentDisplayName } from '../../lib/tool-display.js'
import {
  isGenericSubtaskWaitHint,
  resolveSubtaskLivePreview,
} from '../../lib/subtask-preview-text.js'
import { findSubagentTaskForCollabSubtask } from '../../lib/subtask-stream-bind.js'
import { resolveNodeActivity } from '../../lib/workflow-node-activity.js'
import { logWorkflowNodeState } from '../../lib/workflow-node-log.js'
import { formatTaskStatusZh, taskStatusBadgeClass } from '../../lib/task-status-label.js'
import { formatSubtaskObsLine } from '../../lib/task-observability-format.js'
import { HoverBubble, HoverBubbleProvider } from './HoverBubble.js'
import { WorkflowAgentFace } from '@zcode/ui/components/workflow-timeline/WorkflowAgentFace.js'
import type { StepRunStatus } from '@zcode/ui/components/workflow-graph/types.js'

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

/** collab 节点态 → 瓦片脸表情用的 StepRunStatus */
function toFaceStatus(status?: string): StepRunStatus {
  const s = normalizeStatus(status)
  if (isRunningStatus(s)) return 'running'
  if (s === 'failed' || s === 'error' || s === 'timed_out') return 'failed'
  if (isCompletedStatus(s)) return 'done'
  return 'pending'
}

/** 按节点身份取色：同 Agent 多节点也要错开，别整图一种颜色。 */
function faceAvatarIndex(...parts: Array<string | number | null | undefined>): number {
  const seed = parts.map((p) => String(p ?? '').trim()).filter(Boolean).join('\0') || 'node'
  let hash = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash) % 9
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

/** 节点只展示一行：压平空白，超出靠 CSS ellipsis。 */
function oneLineText(text: string): string {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function resolveTaskResult(s: CollabSubtaskSnapshot): string {
  const raw = String(s.taskReport || s.result || s.outputSummary || '').trim()
  return oneLineText(raw.replace(/^【完成】[\s\n]*/u, ''))
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
  taskName,
  leadThreadId,
  agents,
  onOpen,
  obsMetrics,
}: {
  s: CollabSubtaskSnapshot
  layout: { x: number; y: number; w: number; h: number }
  subagentTasks?: SubagentStreamTaskMap
  mainTaskId: string
  /** 主任务名（日志里标出「是哪个任务」） */
  taskName?: string
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
  const storedProgress = toProgressPct(s)
  const startedAt =
    (s as { startedAt?: string }).startedAt ||
    (s as { started_at?: string }).started_at ||
    null
  const progressPct = useSoftProgressDisplay(
    String(s.subtaskId || ''),
    displayStatus,
    storedProgress,
    startedAt,
  )
  const taskResult = useMemo(() => resolveTaskResult(s), [s])
  const statusHint = String(
    (s as { currentStep?: string }).currentStep ||
      (s as { current_step?: string }).current_step ||
      '',
  ).trim()
  /** 后端落库的实时正文（刷新后 / 从别的工作流打开时兜底） */
  const apiPreview = String(
    (s as { executionPreview?: string }).executionPreview ||
      (s as { execution_preview?: string }).execution_preview ||
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

  /**
   * 实时工具轨迹 + 正文：直接从 stream task 取原始 tools[]，
   * 不走 sanitizeSubtaskLiveTicker（那个函数刻意过滤工具行，
   * 导致节点永远看不到「此刻在跑什么工具」）。
   */
  const streamTask = useMemo(
    () => findSubagentTaskForCollabSubtask(subagentTasks, String(s.subtaskId || ''), title),
    [subagentTasks, s.subtaskId, title],
  )
  // Prefer transcript preview over current_step. Dispatch-time 「子任务已派发」
  // must not mask real preview or completed taskReport (progress can still update).
  const apiActivityText = useMemo(() => {
    const preview = apiPreview && !isGenericSubtaskWaitHint(apiPreview) ? apiPreview : ''
    const step = statusHint && !isGenericSubtaskWaitHint(statusHint) ? statusHint : ''
    return preview || step
  }, [apiPreview, statusHint])
  const activity = useMemo(
    () =>
      resolveNodeActivity({
        tools: streamTask?.tools,
        liveOutput: streamTask?.liveOutput,
        progressHint: streamTask?.progressHint,
        // 兜底：当前会话没有 WS 流时（刷新后 / 从别的工作流打开），
        // 用后端落库的实时正文 / current_step。
        apiText: apiActivityText,
        running,
      }),
    [streamTask?.tools, streamTask?.liveOutput, streamTask?.progressHint, apiActivityText, running],
  )

  /** 只显示最新一条活动（工具或正文），单行 + … */
  const liveText = oneLineText(activity.latest?.text || livePreview.previewText || '')
  const activityText = oneLineText(activity.latest?.text || '')
  const showLiveTicker = running || (livePreview.hasLiveContent && !terminal)

  // 任务名在前：节点主标题是步骤/任务，执行者只作次要信息
  const fullTitle =
    agentName && agentName !== '未分配' ? `${title} · ${agentName}` : title
  const obsLine = useMemo(() => formatSubtaskObsLine(obsMetrics), [obsMetrics])

  const handleOpen = () => {
    const mid = String(mainTaskId || s.parentTaskId || '').trim()
    const sid = String(s.subtaskId || '').trim()
    const lead = String(leadThreadId || '').trim()
    const subThread = String(s.subtaskThreadId || '').trim()
    // V4 pane resolves thread/outcome itself — do not prefetch modal rows.
    onOpen({
      subtaskId: sid,
      mainTaskId: mid,
      leadThreadId: lead,
      subtaskThreadId: subThread || undefined,
      assignedAgent: code || undefined,
      description: String(s.description || '').trim() || undefined,
      title: fullTitle,
      status: displayStatus,
    })
  }

  const hoverBody = [
    activity.activeToolLabel ? `正在执行：${activity.activeToolLabel}` : '',
    liveText,
    livePreview.previewText && liveText !== livePreview.previewText ? livePreview.previewText : '',
    obsLine,
    statusLabel,
  ]
    .filter(Boolean)
    .join('\n')

  /**
   * 节点状态日志：把「节点上显示什么」原样打进控制台。
   * 依赖里只放真正影响显示的字段 —— 2s 轮询下不会重复刷屏（logger 内部还有去重）。
   */
  const nodeDisplayText = activity.latest?.text || (showLiveTicker ? liveText : '') || ''
  const nodeDisplayKind: 'tool' | 'text' | 'none' = activity.latest
    ? activity.latest.isTool
      ? 'tool'
      : 'text'
    : nodeDisplayText
      ? 'text'
      : 'none'
  useEffect(() => {
    logWorkflowNodeState({
      taskName: String(taskName || '').trim(),
      taskId: String(mainTaskId || '').trim(),
      nodeName: title,
      subtaskId: String(s.subtaskId || '').trim(),
      status: displayStatus,
      statusLabel,
      progress: progressPct,
      display: nodeDisplayText,
      kind: nodeDisplayKind,
      activeTool: activity.activeToolLabel,
    })
  }, [
    taskName,
    mainTaskId,
    title,
    s.subtaskId,
    displayStatus,
    statusLabel,
    progressPct,
    nodeDisplayText,
    nodeDisplayKind,
    activity.activeToolLabel,
  ])

  return (
    <HoverBubble
      variant="rich"
      title={fullTitle}
      body={hoverBody}
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
        <div className="collab-wf-node-title-row">
          <HoverBubble text={statusLabel} side="top" align="center" maxWidth={200} asChild>
            <span
              className={`react-chat-subtask-status-light ${statusClass}`}
              aria-label={statusLabel}
            />
          </HoverBubble>
          <span className="collab-wf-node-task-title">{title}</span>
          <HoverBubble text={agentName} side="top" align="center" maxWidth={200} asChild>
            <span className="collab-wf-node-agent-ico" aria-hidden>
              <WorkflowAgentFace
                avatarIndex={faceAvatarIndex(
                  s.subtaskId,
                  s.ref,
                  code,
                  agentName,
                  title,
                )}
                className="size-[13px]"
                name={agentName || code || title}
                status={toFaceStatus(displayStatus)}
              />
            </span>
          </HoverBubble>
          {refLabel ? <span className="collab-wf-node-ref">#{refLabel}</span> : null}
          {/* 百分比提到顶部（不再有底部总体进度条）；运行中用转圈表示 */}
          {progressPct != null ? (
            <span
              className={`collab-wf-node-progress-pct${running ? ' is-running' : ''}`}
              title={`进度 ${progressPct}%`}
            >
              {progressPct}%
            </span>
          ) : null}
          {running ? (
            <span
              className="collab-wf-node-running-badge"
              title={activity.activeToolLabel ? `运行中 · ${activity.activeToolLabel}` : '运行中'}
              aria-label="运行中"
            >
              <span className="collab-wf-node-spinner" aria-hidden />
            </span>
          ) : null}
        </div>
        {activity.latest && activityText ? (
          <div
            className={`collab-wf-node-activity${activity.latest.running ? ' is-running' : ''}${activity.latest.failed ? ' is-failed' : ''}${activity.latest.isTool ? ' is-tool' : ''}`}
          >
            {activity.latest.isTool ? (
              <span className="collab-wf-node-activity-dot" aria-hidden />
            ) : null}
            <span className="collab-wf-node-activity-text" title={activityText}>
              {activityText}
            </span>
          </div>
        ) : showLiveTicker && liveText ? (
          <div className={`collab-wf-node-activity${running ? ' is-running' : ''}`}>
            <span className="collab-wf-node-activity-text" title={liveText}>
              {liveText}
            </span>
          </div>
        ) : !running && taskResult ? (
          <div className="collab-wf-node-result" title={taskResult}>
            {taskResult}
          </div>
        ) : null}
      </button>
    </HoverBubble>
  )
}

export interface CollabWorkflowCanvasProps {
  subtasks: CollabSubtaskSnapshot[]
  mainTaskId: string
  /** 主任务名（日志里标出「是哪个任务」） */
  taskName?: string
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
  taskName,
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
            taskName={taskName}
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
