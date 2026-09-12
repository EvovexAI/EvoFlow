import { normalizeStreamActivityDetail } from '../../lib/tool-display.js'
import { normalizeStreamStatusLabel } from './stream-status-label.js'
import { formatTurnElapsedSuffix } from './turn-timing.js'

/** 会话 executing 且无更细 activity 时的侧栏/预览文案 */
export const SESSION_RUNNING_ACTIVITY_LABEL = '运行中'

export type ResolveLiveStreamActivityInput = {
  activityKind?: string | null
  activityDetail?: string | null
  streamSystemActivity?: string | null
  toolName?: string
  toolCalls?: unknown[]
  /** Optional elapsed seconds suffix for composer dock copy */
  elapsedSec?: number
  /** 会话仍在 executing（turn busy / DB run）；为 false 时不展示「运行中」兜底 */
  activeTurn?: boolean
}

export type ResolvedLiveStreamActivity = {
  kind: string
  detail: string
  /** Same text as dockLabel except trailing … stripped (legacy) */
  cursorLabel: string
  /** Session list / message status / composer dock — one source of truth */
  dockLabel: string
  runningPreview: string
  runningToolSummary: string
  /**
   * Raw turn elapsed seconds used to build the dock suffix.
   * Consumers that need a duration label should format this — do not parse dockLabel.
   */
  elapsedSec?: number
}

function shouldHideGenericSupervisor(kind: string, detail: string): boolean {
  return (
    kind === 'tools' &&
    (detail.startsWith('调用：supervisor') || detail.toLowerCase().includes('supervisor'))
  )
}

/** @deprecated Use ``formatTurnElapsedSuffix`` — kept for call-site compatibility. */
export function formatStreamElapsedSuffix(elapsedSec?: number): string {
  return formatTurnElapsedSuffix(elapsedSec)
}

function appendElapsedLabel(base: string, elapsedSec?: number): string {
  // 展示用：去掉末尾 … / ...，保留文案本身（动画点由 CSS 负责）
  const core = normalizeStreamStatusLabel(base)
  const suffix = formatTurnElapsedSuffix(elapsedSec)
  if (!suffix) return core
  return core ? `${core}${suffix}` : suffix.trim()
}

function fallbackBusyLabel(kind: string): string {
  if (kind === 'compacting') return '正在压缩上下文…'
  if (kind === 'retrying') return '系统重试中…'
  if (kind === 'pre_model') return '准备中…'
  if (kind === 'model') return '生成中…'
  if (kind === 'tool_approval') return '等待工具授权…'
  if (kind !== 'idle') return SESSION_RUNNING_ACTIVITY_LABEL
  return ''
}

/** Unified merge for session list, stream row status, and composer dock (``dockLabel``). */
export function resolveLiveStreamActivity(
  input: ResolveLiveStreamActivityInput,
): ResolvedLiveStreamActivity {
  const panelKind = String(input.activityKind || 'idle').trim().toLowerCase()
  const panelDetailRaw = String(input.activityDetail || '').trim()
  const streamActRaw = String(input.streamSystemActivity || '').trim()
  const streamActIsToolLine =
    streamActRaw.startsWith('调用：') || /^calling:/i.test(streamActRaw)
  const streamAct =
    streamActIsToolLine && panelKind !== 'tools' ? '' : streamActRaw

  const panelDetail =
    panelDetailRaw && panelKind !== 'idle'
      ? normalizeStreamActivityDetail(panelDetailRaw, {
          toolName: input.toolName,
          toolCalls: input.toolCalls,
        })
      : panelDetailRaw

  // 实时 activity 事件（来自后端 _emit_content_activity / 中间件 agent_activity）
  // 优先于 thread_state 的 panelDetail（后者基于累积 messages 推断，可能过时）
  const detail =
    streamAct ||
    (panelKind !== 'idle' && panelDetail) ||
    (panelKind === 'thinking' ? panelDetailRaw || '推理中' : panelDetail) ||
    ''

  const kind =
    panelKind !== 'idle' ? panelKind : streamAct || detail ? 'thinking' : 'idle'

  const hideSupervisor = shouldHideGenericSupervisor(kind, detail)

  const activeTurn = !!input.activeTurn
  const showBusyFallback =
    activeTurn &&
    (!detail || kind === 'idle') &&
    !streamAct &&
    kind !== 'compacting' &&
    kind !== 'retrying'

  const rawElapsedSec =
    input.elapsedSec != null && Number.isFinite(input.elapsedSec) ? input.elapsedSec : undefined

  if (kind === 'compacting') {
    const compactDock = detail || '正在压缩上下文…'
    const compactCursor = normalizeStreamStatusLabel(compactDock)
    return {
      kind,
      detail,
      cursorLabel: appendElapsedLabel(compactCursor, input.elapsedSec),
      dockLabel: appendElapsedLabel(compactDock, input.elapsedSec),
      runningPreview: compactCursor,
      runningToolSummary: '',
      ...(rawElapsedSec != null ? { elapsedSec: rawElapsedSec } : {}),
    }
  }

  if (kind === 'retrying') {
    const retryDock = detail || '系统重试中…'
    const retryCursor = normalizeStreamStatusLabel(retryDock)
    return {
      kind,
      detail,
      cursorLabel: appendElapsedLabel(retryCursor, input.elapsedSec),
      dockLabel: appendElapsedLabel(retryDock, input.elapsedSec),
      runningPreview: retryCursor,
      runningToolSummary: '',
      ...(rawElapsedSec != null ? { elapsedSec: rawElapsedSec } : {}),
    }
  }

  const showDetail =
    !!detail &&
    (kind === 'tools' ||
      kind === 'thinking' ||
      kind === 'pre_model' ||
      kind === 'tool_approval' ||
      kind === 'retrying') &&
    !hideSupervisor

  const busyFallback = showBusyFallback ? SESSION_RUNNING_ACTIVITY_LABEL : fallbackBusyLabel(kind)
  const baseDock = showDetail ? detail : busyFallback
  const baseCursor = normalizeStreamStatusLabel(baseDock)

  // Pending approval is a pause, not an active run — never append elapsed "运行中" timer.
  const elapsedForLabel = kind === 'tool_approval' ? undefined : input.elapsedSec
  const dockLabel = appendElapsedLabel(baseDock, elapsedForLabel)
  const cursorLabel = appendElapsedLabel(baseCursor, elapsedForLabel)

  let runningPreview = ''
  let runningToolSummary = ''
  if (detail) {
    if (kind === 'tools') runningToolSummary = cursorLabel
    else runningPreview = cursorLabel
  } else if (showBusyFallback || input.elapsedSec != null) {
    runningPreview = cursorLabel
  }

  return {
    kind,
    detail,
    cursorLabel,
    dockLabel,
    runningPreview,
    runningToolSummary,
    ...(rawElapsedSec != null ? { elapsedSec: rawElapsedSec } : {}),
  }
}

/** Apply resolved activity over base sidebar previews (partial text / tool name). */
export function mergeRunningSessionPreview(
  base: { runningPreview?: string; runningToolSummary?: string },
  resolved: ResolvedLiveStreamActivity,
): { runningPreview: string; runningToolSummary: string } {
  if (resolved.detail) {
    return {
      runningPreview: resolved.runningPreview,
      runningToolSummary: resolved.runningToolSummary,
    }
  }
  let runningPreview = String(base.runningPreview || '').trim()
  let runningToolSummary = String(base.runningToolSummary || '').trim()
  if (resolved.runningPreview) runningPreview = resolved.runningPreview
  else if (resolved.runningToolSummary) runningToolSummary = resolved.runningToolSummary
  return { runningPreview, runningToolSummary }
}

export type ComposerDockActivityInput = {
  activityKind?: string | null
  activityDetail?: string | null
  streamSystemActivity?: string | null
  elapsedSec?: number
  /** 默认 true；为 false 时 idle 且无 detail 不展示「运行中」 */
  activeTurn?: boolean
}

/** Composer dock + session list preview: one source of truth (``dockLabel``). */
export function resolveComposerDockActivity(
  input: ComposerDockActivityInput,
): ResolvedLiveStreamActivity {
  return resolveLiveStreamActivity({
    activityKind: input.activityKind,
    activityDetail: input.activityDetail,
    streamSystemActivity: input.streamSystemActivity,
    elapsedSec: input.elapsedSec,
    activeTurn: input.activeTurn ?? true,
  })
}