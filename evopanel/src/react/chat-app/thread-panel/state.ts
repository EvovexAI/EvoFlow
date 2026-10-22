/**
 * ThreadPanelState factory / patch helpers.
 * Extracted from ChatApp.tsx module-top helpers (P0).
 */
import {
  isClarificationPreviewRenderable,
  isStaleClarificationPreview,
} from '../../lib/clarify-chat-display.js'
import {
  EMPTY_PRIOR_TURN_STRIP,
  stripThreadPanelReasoningPreview,
  type PriorTurnStripBundle,
} from '../../lib/turn-text-isolation.js'
import type { ThreadPanelState } from '../../chat-types.js'

export function emptyThreadPanel(): ThreadPanelState {
  return {
    title: null,
    todos: [],
    activityKind: 'idle',
    activityDetail: '',
    reasoningPreview: null,
    clarification: null,
    goalProposal: null,
    subagentTasks: {},
    collabTask: null,
    collabSubtasks: [],
    supervisorSteps: [],
    collabPhase: null,
    boundTaskId: null,
  }
}

/** 停止生成后仅清活动态，保留 TODO / 协作 / 澄清等侧栏上下文。 */
export function clearThreadPanelActivity(prev: ThreadPanelState): ThreadPanelState {
  return {
    ...prev,
    activityKind: 'idle',
    activityDetail: '',
    reasoningPreview: null,
    subagentTasks: {},
  }
}

export function applyThreadStatePanelPatch(
  prev: ThreadPanelState,
  p: Record<string, unknown>,
  flashMode: boolean,
  priorStrip: PriorTurnStripBundle = EMPTY_PRIOR_TURN_STRIP,
  opts?: { preserveActivityWhileSending?: boolean },
): ThreadPanelState {
  const newTodos = Array.isArray(p.todos) ? p.todos : prev.todos
  const rawReasoning =
    !flashMode && typeof p.reasoningPreview === 'string' ? p.reasoningPreview : null
  const incomingKind = String(p.activityKind || 'idle').trim().toLowerCase()
  const incomingDetail = String(p.activityDetail || '').trim()
  let activityKind = incomingKind
  let activityDetail = incomingDetail
  if (opts?.preserveActivityWhileSending) {
    const prevKind = String(prev.activityKind || 'idle').trim().toLowerCase()
    const prevBusy = prevKind !== 'idle' && !!String(prev.activityDetail || '').trim()
    const incomingIdle = incomingKind === 'idle' || !incomingDetail
    const incomingOverrides =
      incomingKind === 'thinking' ||
      incomingKind === 'clarification' ||
      incomingKind === 'tool_approval' ||
      incomingKind === 'compacting' ||
      incomingKind === 'retrying'
    if (prevBusy && incomingIdle && !incomingOverrides) {
      activityKind = prevKind
      activityDetail = String(prev.activityDetail || '').trim()
    }
  }
  return {
    title: prev.title,
    todos: newTodos,
    activityKind,
    activityDetail,
    reasoningPreview: rawReasoning
      ? stripThreadPanelReasoningPreview(rawReasoning, priorStrip)
      : null,
    clarification:
      prev.collabPhase === 'plan_ready' || prev.collabTask?.boundPlanReady
        ? null
        : p.clarification
          ? (() => {
              const clar = p.clarification as Record<string, unknown>
              const preview = String(clar.preview || clar.content || '').trim()
              const toolCallId = String(clar.toolCallId || clar.tool_call_id || '').trim() || undefined
              const next = {
                toolCallId,
                preview: preview || undefined,
              }
              if (preview && isClarificationPreviewRenderable(preview)) return next
              if (preview && isStaleClarificationPreview(preview)) return next
              if (toolCallId && prev.clarification?.preview) return prev.clarification
              if (toolCallId) return next
              return prev.clarification
            })()
          : prev.clarification,
    goalProposal: prev.goalProposal,
    subagentTasks: prev.subagentTasks,
    collabTask: prev.collabTask,
    collabSubtasks: prev.collabSubtasks,
    supervisorSteps: prev.supervisorSteps,
    collabPhase: prev.collabPhase,
    boundTaskId: prev.boundTaskId,
    planInputFallback: prev.planInputFallback,
  }
}
