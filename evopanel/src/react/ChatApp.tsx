import type {
  CSSProperties,
  Dispatch,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  SetStateAction,
} from 'react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  startTransition,
} from 'react'
import { createPortal, flushSync } from 'react-dom'
import {
  wsClient,
  enqueuePendingInject,
  getPendingInjectStatus,
  restorePendingInjects,
  subscribeCollabThreadWs,
  dispatchCollabCustomEvent,
  collabSnapshotFromTaskRow,
  evoflowInvokeGatewayJson,
} from '../lib/ws-client.js'
import { getPanelSetting, getVoiceReplyEnabled, patchPanelSettings } from '../lib/panel-settings.js'
import { shouldArmVoiceReply, voiceReplyModeToSettingsPatch } from '../lib/voice-reply-mode.js'
import { isChatOverlayDeferActive, setChatOverlayDefer } from '../lib/chat-overlay-defer.js'
import { composerPlaceholderExtras } from '../lib/keyboard-shortcuts.js'
import {
  upsertTool,
  extractChatContent,
  normalizeChatToolPayloadToEntries,
  parseUsageToStats,
  formatUsageTokenStr,
  flattenStreamDisplayText,
  mediaToolStatusFromOutput,
  inferMediaAssetsFromToolEntries,
  assistantBodiesLooselySame,
  pickDisplayChatSceneFromScenarioResult,
  isGoalProposalToolName,
} from '../lib/chat-normalize.js'
import {
  MODE_TO_SCENARIO,
  DEFAULT_SESSION_MODES,
  SHOW_SESSION_MODE_COLLAB_UI,
  modeLabel,
  parseSceneFromModelPayload,
  getSessionModeFromMeta,
  setSessionModeInMeta,
  resolvedActivatedScenariosForOpenSession,
  resolveSessionModeForSession,
  consumeLatestScenarioToolForSession,
  chatSceneToSessionMode,
  type SessionMode,
  type ChatSceneId,
} from './lib/session-mode.js'
import { ModelCatalogMenu } from './components/ModelCatalogMenu.js'
import { PermissionPresetMenu } from './components/PermissionPresetMenu.js'
import {
  buildModelConnNameMap,
  defaultModelFromCatalog,
  modelDisplayLabel,
  normalizeModelCatalogRows,
  type ModelCatalogEntry,
} from './lib/model-catalog.js'
import { setChatWorkspaceRoot } from '../lib/chat-workspace-context.js'
import { effectiveLocalWorkspaceRoot } from '../lib/workspace-api-scope.js'
import { useThreadHistory, markResumeAnchorAssistantIncomplete } from './hooks/useThreadHistory.js'
import { useSessionList } from './hooks/useSessionList.js'
import { ShellSessionListHost } from './components/ShellSessionListHost.js'
import { getActivityHint } from './lib/activity-hints.js'
import {
  isPlaceholderSessionTitle,
  isReplaceableSessionTitle,
  persistProvisionalSessionTitleFromMessage,
  persistSessionTitleIfMissing,
  pickSessionRowTitle,
  provisionalSessionTitleFromUserText,
  setSessionTitle,
  getDisplayLabel,
} from './lib/session-list/display.js'
import {
  patchSessionPinInRows,
  patchSessionTitleInRows,
  prependNewSessionToList,
  sessionRowFromApi,
  sortSessionsForSidebar,
  stripDefaultMainSessionRows,
} from './lib/session-list/utils.js'
import { markSessionPinPending } from './lib/session-list/session-pin-pending.js'
import { SESSION_LIST_PAGE_SIZE } from './lib/session-list/constants.js'
import {
  loadExpandedWorkspaceKeys,
  saveExpandedWorkspaceKeys,
} from './lib/session-list/expanded-workspaces-storage.js'
import type { ShellWorkspaceGroup } from './lib/session-list/types.js'
import {
  isProactiveSessionKey,
  isSpecialWorkspaceGroupKey,
  normalizeWorkspacePathKey,
  parseProactiveSessionKey,
  proactiveAgentCodeFromSessionKey,
  resolveShellGroupWorkspacePath,
  WORKSPACE_GROUP_UNBOUND,
} from './lib/session-list/workspace-groups.js'
import { useCollabSubtasksFromApi } from './hooks/useCollabSubtasksFromApi.js'
import { skTail, ssLog } from '../lib/session-list-debug.js'
import { ChatMessageStreamPane } from './components/ChatMessageStreamPane.js'
import { HistoryFetchSpinner } from './components/HistoryFetchSpinner.js'
import { ChatComposer, type WorkspaceMentionConfig, type MentionEmployeeOption } from './components/ChatComposer.js'
import { PendingSteersStrip } from './components/PendingSteersStrip.js'
import { mergeInterruptedComposerDraft } from './lib/merge-interrupted-composer-draft.js'
import { composeAttachDragOver, parseComposeDataTransfer } from './lib/compose-attach.js'
import { basenameFromPath } from './lib/workspace-mention.js'
import { GoalModePanel } from './components/GoalModePanel.js'
import { GoalProposalDock } from './components/GoalProposalDock.js'
import { SkillPickerModal, type SkillSelection } from './components/SkillPickerModal.js'
import { ShareSessionModal } from './components/ShareSessionModal.js'
import { AgentPickerModal } from './components/AgentPickerModal.js'
import { PlanExecConfirm } from './components/PlanExecConfirmDock.js'
import { ClarificationConfirmDock } from './components/ClarificationConfirmDock.js'
import type { PlanExecConfirmAnchor } from './components/ToolCallList.js'
import { setAgentsDisplayCache } from '../lib/agents-display-cache.js'
import {
  collectPendingApprovalsForDock,
  patchToolsApprovalStatus,
  rowHasPendingApprovalTools,
  buildToolApprovalReplayMessage,
  isHiddenToolApprovalUserMessage,
} from '../lib/tool-approval.js'
import {
  fetchGlobalToolApprovalPolicy,
  fetchSessionToolApprovalPolicy,
  isEffectiveToolApprovalGrantAll,
  // @ts-ignore
  isEffectiveToolApprovalSession,
  TOOL_APPROVAL_POLICY_CHANGED,
  TOOL_APPROVAL_SESSION_POLICY_CHANGED,
  // @ts-ignore
  TOOL_APPROVAL_POLICY_GRANT_ALL,
  // @ts-ignore
  TOOL_APPROVAL_POLICY_SESSION,
  // @ts-ignore
  TOOL_APPROVAL_POLICY_PROMPT,
} from '../lib/tool-approval-settings.js'
import {
  resolvePermissionPreset,
  permissionPresetToast,
} from '../lib/permission-tier.js'
import {
  logToolApprovalPendingDetected,
  logToolApprovalStreamFinal,
  logToolApprovalUserAction,
} from '../lib/tool-approval-trace.js'
import { CollabExecutionPanel } from './components/CollabExecutionPanel.js'
import { KnowledgeMapPanel } from './components/KnowledgeMapPanel.js'
import { RightStageShell } from './components/RightStageShell.js'
import {
  ChatWorkspaceInfoRail,
  type InfoRailTab,
  type EmployeeRailInfo,
} from './components/ChatWorkspaceInfoRail.js'
import { RightStageExtensionsToolbar } from './components/RightStageExtensionsToolbar.js'
import { SidePanelBootShell } from './components/SidePanelBootShell.js'
import { applyRightStageAgUiCustom, applyStageSetFromToolCall, STAGE_SET_APPLIED_EVENT, type StageSetPayload } from '../lib/right-stage/right-stage-agui.js'
import { hideRightStageIfKind, rightStageStore } from '../lib/right-stage/right-stage-store.js'
import {
  normalizeWriteStreamMode,
  shouldOpenWriteStreamPanel,
  isAutoWorkPreviewEnabled,
  type WriteStreamMode,
} from '../lib/right-stage/write-stream-mode.js'
import { applyDecideRightStage } from '../lib/right-stage/apply-decide-right-stage.js'
import { applyPlatformFeedbackFromToolResult, latestPlatformRunEntryId, openPlatformFeedbackFromTool, platformRunEntriesFromChatArtifacts, syncPlatformFeedbackFromTools, type PlatformRunEntry } from '../lib/right-stage/platform-feedback.js'
import { registerPlatformFeedbackOpenHandler } from '../lib/right-stage/platform-feedback-bridge.js'
import { normalizeRightStageKind } from '../lib/right-stage/right-stage-types.js'
import type { RightStageKind } from '../lib/right-stage/right-stage-types.js'
import type { RightStageSurface } from '../lib/right-stage/right-stage-types.js'
import {
  isUserStageExtensionKind,
  titleForUserStageExtension,
  type UserStageExtensionKind,
} from '../lib/right-stage/right-stage-extensions.js'
import { useRightStageChatBridge } from './hooks/useRightStageChatBridge.js'
import { useObsEnabled } from './hooks/useObsEnabled.js'
import { ensureRightStageKindsRegistered } from './right-stage/register-kinds.js'
import { PanelResizeHandle } from './components/PanelResizeHandle.js'
import { useDragResize } from './hooks/useDragResize.js'
import {
  clampBottomDockHeight,
  clampRightPanelWidth,
  defaultRightPanelWidth,
  loadChatLayoutPrefs,
  applyBottomAreaHeightDelta,
  measureBottomAreaNaturalHeight,
  saveChatLayoutPrefs,
} from '../lib/chat-layout-storage.js'
import { SessionSidebar, type SubtaskTranscriptModalPayload } from './components/SessionSidebar.js'
import { WorkspaceFileTree, type ContextFileEntry } from './components/WorkspaceFileTree.js'
import { MemoryRecallChip } from './components/MemoryRecallChip.js'
import { WorkspaceFilePreviewModal } from './components/WorkspaceFilePreviewModal.js'
import { ImagePreviewModal, type ImagePreviewItem } from './components/ImagePreviewModal.js'
import { isImagePathLike, resolveChatImageSrc } from '../lib/chat-image-src.js'
import {
  detectLatestWritePreviewFromTools,
  detectStreamingWritePreview,
  isActiveWriteTool,
  isStreamAutoPreviewPath,
  isWriteToolInFlight,
  resolveOpenableWorkspaceFile,
  resolveWorkspacePreviewTarget,
  shouldSuppressStreamDeliveredFiles,
  workspacePreviewTargetFromUrl,
} from '../lib/workspace-preview-path.js'
import { TauriWindowControls } from './components/TauriWindowControls.js'
import { toast } from '../components/toast.js'
import { toUserFacingError } from '../lib/user-facing-error.js'
import { loadSkillCatalog, subscribeSkillCatalog } from '../lib/skill-catalog.js'
import { notifyDesktopCompletion } from '../lib/desktop-notification.js'
import {
  registerVoiceSendHandler,
  unregisterVoiceSendHandler,
  registerVoicePartialBeginHandler,
  registerVoicePartialEndHandler,
  registerVoicePartialHandler,
  unregisterVoicePartialBeginHandler,
  unregisterVoicePartialEndHandler,
  unregisterVoicePartialHandler,
} from '../lib/background-voice-bridge.js'
import { setVoiceTrayState } from '../lib/background-voice.js'
import {
  resolveVoiceSpeechBodyFromParts,
  shouldAdvanceVoiceSpeechSync,
  toVoiceSpeechPlain,
} from '../lib/voice-reply-speech.js'
import { normalizeStreamActivityDetail, formatActivityDetailFromRunningToolCalls, resolveAssignedAgentDisplayName } from '../lib/tool-display.js'
import {
  resolveComposerDockActivity,
  type ResolvedLiveStreamActivity,
} from './lib/resolve-live-stream-activity.js'
import {
  anySessionHasLiveTurnTiming,
  computeTurnElapsedSec,
  formatTurnDurationStr,
  isTurnTimingLive,
  parseTurnTimestampMs,
} from './lib/turn-timing.js'
import { showConfirm, showModal, suppressModalBackdropDismiss } from '../components/modal.js'
import {
  getShellAsideCollapsed,
  setShellAsideCollapsed,
  toggleShellAsideCollapsed,
} from '../components/shell-aside.js'
import { useGoalMode } from './hooks/useGoalMode.js'
import {
  formatAskClarificationForHosted,
  isStaleClarificationPreview,
  isClarificationPreviewRenderable,
  isUserExecutionStartIntent,
  clarificationPreviewFromTool,
} from './lib/clarify-chat-display.js'
import {
  findAskClarificationAwaitingUserInRows,
  isAskClarificationToolPending,
} from '../lib/clarify-preview-resolve.js'
import {
  latchClarificationToolCall,
  clearClarificationLatch,
  peekClarificationLatch,
  resolveClarificationPanelAuthoritative,
} from './lib/clarify-tool-fetch.js'
import { pushGoalClosureNotification } from './lib/session-notifications.js'
import { getUseVirtualPaths } from '../lib/path-mode.js'
import {
  getWorkspaceIndexWatchEnabled,
  setWorkspaceIndexWatchEnabled,
} from '../lib/workspace-index-watch.js'
import { resolveLanggraphLeadThreadId } from '../lib/collab-thread-ids.js'
import { agentCapabilitySummary, normalizeAgentTags, type AgentPickerRow } from './lib/agent-tags.js'

// ========== 任务进度可视化系统集成 ==========
import { tasksAPI } from '../lib/api-client.js'
import { fetchCollabSubtasksForMainTask, preferPersistedCollabSubtasks } from '../lib/collab-subtasks-from-api.js'
import { stabilizeCollabSubtasksByStreamPhase as stabilizeCollabSubtasksByStreamPhaseLib } from '../lib/collab-subtask-stream-status.js'
import {
  buildCollabSidebarFromTools,
  collectAssistantToolArraysFromRows,
  extractLastPlanToolSuccessFromArrays,
  findLastSuccessfulPlanToolCallId,
  isPendingSubtaskKey,
  mergeAssistantToolsFromRows,
  pruneSupersededPendingSubtasks,
  toolsFromLastAssistantRow,
} from '../lib/collab-sidebar-from-tools.js'
import {
  computePlanExecStripUi,
  isPlanExecutionConfirmationClarification,
  resolvePlanBoundTaskId,
} from '../lib/plan-exec-ui.js'
import {
  isActiveExecTaskStatus,
  shouldAutoOpenCollabExecPanel,
  shouldShowCollabSubtaskSidebar,
  shouldShowCollabWorkflowPanel,
} from '../lib/plan-task-status.js'
import {
  mergePlanToolsForDetection,
  mergeToolsForPlanDetection,
  analyzePlanTools,
  enrichToolsWithCachedPlanInput,
  absorbPlanInputFromTools,
  historyPastPlanExecutionGate,
} from '../lib/plan-pipeline.js'
import {
  invalidatePlanApiCache,
  syncPlanDockStateFromApi,
} from '../lib/plan-from-api.js'
import {
  resolveSessionTaskId,
} from '../lib/session-task-api-gate.js'
import { planDockApiHide, planDockApiShow, tracePlanDockApi } from '../lib/plan-dock-api.js'
import { readAskClarificationInput } from '../lib/clarify-preview-resolve.js'
import {
  pickRicherStructuredPlanInput,
  planStructuredStepCount,
} from '../lib/plan-from-task.js'
import { tracePlanPipeline, resetPlanTrace } from '../lib/plan-trace.js'
import type { StructuredPlanInput } from './components/PlanDetailView.js'
// ============================================

import type {
  ChatAttachment,
  ChatSessionRow,
  ChatWsPayload,
  DisplayRow,
  MessageSegment,
  StreamState,
  SubagentStreamTask,
  TerminalStreamTask,
  CollabTaskSnapshot,
  CollabSubtaskSnapshot,
  SupervisorStepSnapshot,
  ThreadGoalProposal,
  ThreadPanelState,
  TokenTotals,
} from './chat-types.js'
import { HoverBubble, HoverBubbleProvider } from './components/HoverBubble.js'
import type { ContextUsageSnapshot } from './lib/context-usage.js'
import {
  mergeChatArtifacts,
  normalizeChatArtifacts,
  type ChatArtifact,
} from './lib/chat-artifact.js'
import {
  mergeContextUsageSnapshots,
  parseContextUsageFromSessionContext,
} from './lib/context-usage.js'
import { requestManualContextCompaction } from './lib/manual-context-compaction.js'
import { mergeSubagentStreamEvent, normalizeSubagentStreamEvent } from './subagent-stream-merge.js'
import { cloneTerminalStreamTask, cloneTerminalStreamsMap, mergeTerminalIntoTool, mergeTerminalStreamEvent } from './terminal-stream-merge.js'
import { collabDagDebug, collabDagDebugBannerOnce } from '../lib/collab-dag-debug.js'
import { isSubtaskStreamDebugEnabled, subtaskStreamDebugBannerOnce } from '../lib/subtask-stream-debug.js'
import { resetStreamMirrorDedupe } from './stream-console-mirror.js'
import {
  reduceStreamTurn,
  finalizeStreamTurn,
  streamDeltaShouldMergeTools,
  shouldAcceptStreamTextPiece,
  shouldKeepStreamDeltaAfterStrip,
  streamTurnHasVisibleContent,
  collectToolCallIdsFromTurn,
  filterStaleToolEntries,
  drainStreamTurnRoundBuffer,
  shouldReleaseStreamBufferBeforeEvent,
  finalizedTurnToCompactedPart,
  mergeCompactedPartsIntoTurn,
  staleToolIdsExcludingTurnTools,
  type StreamReleaseTrigger,
  type StreamTurnEvent,
  type StreamTurnState,
} from './lib/stream-turn-engine.js'
import { parseStreamBlockWire, enforceSegmentDisplayOrder, type StreamBlockWire } from './lib/content-blocks.js'
import { createStreamBumpScheduler } from './lib/stream-bump-scheduler.js'
import { resolveStreamBumpMinIntervalMs, STREAM_BUMP_INTERVAL_MS, STREAM_REASONING_BUMP_INTERVAL_MS } from './lib/stream-bump-interval.js'
import { bumpStreamDisplayTick } from './lib/stream-display-tick.js'
import { bumpStreamChromeTick } from './lib/stream-chrome-tick.js'
import { isStreamThrottleEnabled } from './lib/stream-throttle-toggle.js'
import {
  endLiveStreamSession,
  isAgUiLiveTextEvent,
  isStreamTurnLiveTextEvent,
  prepareLiveStreamStructuralUpdate,
  publishLiveStreamNow,
  scheduleLiveStreamTextPublish,
  drainLiveStreamTextBatch,
  disposeLiveStreamUiBatch,
} from './lib/live-stream-ui.js'
import { deleteLiveStream, pruneLiveStreams } from './lib/live-stream-store.js'
import {
  endClientPerfTurn,
  getChatSurfaceVisible,
  setChatSurfaceVisible,
  startClientPerfTurn,
  subscribeChatSurfaceVisible,
} from './lib/client-perf.js'
import {
  emptyStream,
  isAgUiStreamActive,
  streamRefHasVisibleContent,
  streamProject,
} from './lib/stream-state.js'
import {
  applyAgUiEvent,
  cloneAgUiTurnState,
  emptyAgUiTurnState,
  projectAgUiToStreamTurnFields,
  sealOpenAgUiMessages,
  seedAgUiTurnBaseline,
  syncAgUiCompatProjection,
  syncStreamTurnFromAgUi,
  shouldReleaseAgUiBufferBeforeToolStart,
  drainAgUiCompletedRound,
  finalizeGhostRunningToolsBeforeNewRound,
  timelineWithOpenAgUiAssistantText,
} from './lib/agui-turn-reducer.js'
import type { AGUIEvent } from '@ag-ui/core'
import { EventType } from '@ag-ui/core'
import {
  commitActiveSessionRuntime,
  getSessionRuntime,
  bumpSessionRuntimeNotifyForKey,
  getExecutingListRuntimeEpoch,
  subscribeExecutingListRuntime,
  isSessionRuntimeLive,
  listBusySessionKeys,
  isSessionRuntimeStreamVisible,
  mountSessionRuntime,
  updateSessionRuntimeRows,
  dispatchSessionTurnEvent,
  isTurnBusy,
  deriveAttachState,
  setSessionActivity,
  noteSessionEvent,
  rtAddSeenRun,
  rtHasSeenRun,
  rtAddStoppedRun,
  rtIsStoppedRun,
  rtAddStaleToolCallIds,
  hydrateSessionRuntimeRowsIfIdle,
  resetRuntimeStream,
  resetSessionLiveStreamDisplay,
  replaceSessionRuntimeRowsFromHistory,
  markSessionResumeCatchupReplay,
  rowsAlreadyStopSealedForTurn,
  rowsBaseForSend,
  clearSessionRuntime,
  pruneSessionRuntimes,
  DEGRADED_SNAPSHOT_SYSTEM_TEXT,
  seenRunIdSet,
  EMPTY_PRIOR_TURN_STRIP as EMPTY_RT_PRIOR_STRIP,
  type SessionRuntime,
} from './lib/session-runtime-store.js'
import {
  assistantPlainForTurnStrip,
  commitPriorTurnStripFromStreamTurn,
  commitPriorTurnStripTextFromStreamTurn,
  EMPTY_PRIOR_TURN_STRIP,
  findAssistantRowAfterLastUser,
  findAssistantRowBeforeTrailingUser,
  filterStaleToolTimelineSegments,
  mergePriorTurnStripBundles,
  priorTurnStripBundleWithStream,
  seedSeenArtifactPathsFromRows,
  stripPriorTurnPollutants,
  stripPriorTurnReasoningFromStream,
  fixReasoningStreamText,
  stripLoosePriorBodyEcho,
  stripLoosePriorReasoningEcho,
  trimReasoningTextAgainstBody,
  stripThreadPanelReasoningPreview,
  sanitizeFinalizedTurnForPersist,
  type PriorTurnStripBundle,
} from './lib/turn-text-isolation.js'
import {
  bindActiveRun,
  chatRunIdsSameTurn,
  clearActiveRun,
  markRunSealing,
  shouldApplyChatEvent,
  isAgUiWireRunId,
} from './lib/run-turn-gate.js'
import {
  fetchSessionRuntimeStatus,
  maybeClearTurnSendingState,
  seedSessionRuntimeStatusIdle,
  invalidateSessionRuntimeStatusCache,
} from './lib/session-reattach.js'
import { useRunningSessionSummaries } from './hooks/useRunningSessionSummaries.js'
import { useStreamResume } from './hooks/useStreamResume.js'
import { srLog } from './lib/stream-resume-debug.js'
import {
  sfLog,
  sfWarn,
  sfSummarizeAgUi,
  sfSummarizeSegments,
  sfSummarizeRowsTail,
} from './lib/stream-final-debug.js'
import { shouldManualRefreshResumeStream } from './lib/stream-resume-gate.js'
import {
  clearStreamReattachCooldown,
  isSessionRecoveryCooldownActive,
} from './lib/stream-reattach-cooldown.js'
import {
  abortSessionTurnEnded,
  clearSessionExecutionStateForEnded,
  collectExecutingSessionKeys,
  clearSessionExecutionProbe,
  dispatchSessionRunEnded,
  fetchAndCacheSessionExecutionState,
  finalizeSessionTurnEnded,
  isSessionExecuting,
  isSessionGoalActive,
  isSessionWireActive,
  patchSessionListRunEnded,
  stopSessionExecution as runStopSessionExecution,
  type SessionStopHost,
} from './lib/session-execution/index.js'
import { useSessionExecutionState } from './hooks/useSessionExecutionState.js'
import { useSessionExecutionProbes } from './hooks/useSessionExecutionProbes.js'
import { buildHistoryViewFromRaw } from './lib/chatHistoryView.js'
import { fetchSessionHistoryTailMessages } from './hooks/fetchSessionHistory.js'
import { warmSessionHistoryPrefetch } from './lib/warm-session-history-prefetch.js'
import {
  displayRowsEquivalent,
  mergeDbOnlyHistoryRows,
  reconcileLastAssistantInRows,
} from './lib/reconcile-last-assistant-from-history.js'
import { buildStreamDisplayRow } from './lib/build-stream-display-row.js'
import { logStreamCompareAgUiDrain } from './lib/stream-compare-file-log.js'
import { resolveUserMessageSkillDisplay } from './lib/preferred-skill-display.js'
import { mergeStreamSnapIntoAssistantRow, mergeAssistantRowWithStreamRow } from './lib/merge-assistant-stream-row.js'
import {
  collapseSameTurnAssistantsInRows,
  shouldMergeFinalIntoPriorAssistant,
} from './lib/collapse-same-turn-assistants.js'

function turnBusyForSession(sessionKey: string | null | undefined): boolean {
  return isSessionWireActive(sessionKey)
}

const STORAGE_SESSION_META_KEY = 'evopanel-chat-session-meta'
const STORAGE_MODEL_KEY = 'evopanel-chat-selected-model'

/** 模型切换分隔线持久化标记前缀（存为 user 消息，回放时识别并转成 system 分隔行） */
export const MODEL_SWITCH_SEPARATOR_PREFIX = '[MODEL_SWITCH]'

type ThinkingLevel = 'auto' | 'off' | 'low' | 'medium' | 'high'

const THINKING_LEVEL_OPTIONS: { value: ThinkingLevel; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'off', label: '关闭' },
  { value: 'low', label: '轻度' },
  { value: 'medium', label: '中度' },
  { value: 'high', label: '深度' },
]

function blockWireFromChatPayload(payload: Record<string, unknown>): StreamBlockWire | undefined {
  return (
    parseStreamBlockWire({
      blockId: payload.blockId,
      blockKind: payload.blockKind,
      seq: payload.blockSeq ?? payload.seq,
    }) ?? undefined
  )
}

function flattenLiveSnapshotText(S: Parameters<typeof streamProject>[0]): string {
  const proj = streamProject(S)
  return flattenStreamDisplayText(proj.segments, proj.text)
}

function buildLiveRunSnapshotPayload(S: Parameters<typeof streamProject>[0]) {
  const proj = streamProject(S)
  const segments = Array.isArray(proj.segments) && proj.segments.length ? proj.segments : []
  return {
    partialText: flattenStreamDisplayText(proj.segments, proj.text),
    partialDisplaySegments: segments,
  }
}

function segmentTimelineHasTextBody(segments: MessageSegment[] | undefined): boolean {
  return !!(segments || []).some(
    (s) => s.kind === 'text' && String((s as { text?: string }).text || '').trim(),
  )
}

/** 工具段之后是否还有正文（值班总结等）；仅有工具前 plan 不算 */
function segmentTimelineHasPostToolText(segments: MessageSegment[] | undefined): boolean {
  const list = segments || []
  let lastTools = -1
  for (let i = 0; i < list.length; i++) {
    if (list[i]?.kind === 'tools') lastTools = i
  }
  if (lastTools < 0) return false
  return list
    .slice(lastTools + 1)
    .some((s) => s.kind === 'text' && String((s as { text?: string }).text || '').trim())
}

function segmentTimelineHasInterleavedTools(segments: MessageSegment[] | undefined): boolean {
  return !!(segments || []).some((s) => s.kind === 'tools')
}

function sortSegmentsBySeqIfPresent(segments: MessageSegment[]): MessageSegment[] {
  return enforceSegmentDisplayOrder(segments)
}

function mergeAuthoritativeDisplaySegments(
  fin: ReturnType<typeof finalizeStreamTurn>,
  authSegsRaw: MessageSegment[],
): MessageSegment[] {
  const authSegs = sortSegmentsBySeqIfPresent(authSegsRaw)
  if (!authSegs.length) return fin.segments || []
  const finSegs = sortSegmentsBySeqIfPresent(fin.segments || [])
  const authHasText = segmentTimelineHasTextBody(authSegs)
  const finHasText = segmentTimelineHasTextBody(finSegs)
  const authHasTools = segmentTimelineHasInterleavedTools(authSegs)
  const finHasTools = segmentTimelineHasInterleavedTools(finSegs)

  // Payload snapshot often has reasoning+text but omits interleaved tools; keep live timeline.
  if (authHasText && !authHasTools && finHasTools && finHasText) {
    return finSegs
  }

  if (!authHasText && finHasText) {
    const textSegs = finSegs.filter((s) => s.kind === 'text')
    return sortSegmentsBySeqIfPresent([...authSegs, ...textSegs])
  }
  if (authHasText) return authSegs
  if (finSegs.length) return finSegs
  return authSegs
}

function authoritativeFinalFromPayload(
  fin: ReturnType<typeof finalizeStreamTurn>,
  payload: Record<string, unknown>,
): ReturnType<typeof finalizeStreamTurn> {
  const authSegsRaw = payload.displaySegments ?? payload.display_segments
  if (
    !Array.isArray(authSegsRaw) ||
    !authSegsRaw.length ||
    !authSegsRaw.every((s) => s && typeof (s as MessageSegment).seq === 'number')
  ) {
    return fin
  }
  const reasoningSegments = Array.isArray(payload.reasoningSegments)
    ? (payload.reasoningSegments as string[]).map((s) => String(s || '')).filter(Boolean)
    : fin.reasoningSegments
  const reasoningPreview =
    typeof payload.reasoningPreview === 'string' && payload.reasoningPreview.trim()
      ? payload.reasoningPreview.trim()
      : fin.reasoningPreview
  const mergedSegments = mergeAuthoritativeDisplaySegments(fin, authSegsRaw as MessageSegment[])
  const payloadText = String(
    (payload.message as { content?: Array<{ type?: string; text?: string }> } | undefined)
      ?.content?.find((c) => c?.type === 'text')
      ?.text || '',
  ).trim()
  const textOut =
    fin.text ||
    (!segmentTimelineHasTextBody(mergedSegments) && payloadText ? payloadText : fin.text)
  return {
    ...fin,
    segments: mergedSegments,
    text: textOut,
    reasoningSegments,
    reasoningPreview,
  }
}

const LS_LAST_SELECTED_SESSION = 'evopanel_last_selected_session'

/** 路由未 cleanup 时可能残留多个 ChatApp；合并并发「新建会话」为一次 POST */
let globalCreateSessionInflight: Promise<string | null> | null = null

function coalesceCreateSession(work: () => Promise<string | null>): Promise<string | null> {
  if (globalCreateSessionInflight) return globalCreateSessionInflight
  globalCreateSessionInflight = work().finally(() => {
    globalCreateSessionInflight = null
  })
  return globalCreateSessionInflight
}

/**
 * 模型调用 ``propose_goal`` 且本轮流式 ``final`` 到达后的行为（localStorage ``evopanel_hosted_propose_action``）：
 * - dock / manual（默认）：仅显示输入区上方确认条，需用户点击后再写入/启动
 * - auto_fill / fill：写入目标面板并打开，不自动开跑
 * - auto_start / start / auto：写入并立即开始（飞书远程确认等场景可显式打开）
 */
function getGoalProposeActionMode(): 'dock' | 'auto_fill' | 'auto_start' {
  try {
    const v = String(getPanelSetting('goalProposeAction', 'ask' as never) || '').trim().toLowerCase()
    if (v === 'dock' || v === 'manual') return 'dock'
    if (v === 'auto_fill' || v === 'fill' || v === 'panel_only') return 'auto_fill'
    if (v === 'auto_start' || v === 'start' || v === 'auto') return 'auto_start'
  } catch {
    /* ignore */
  }
  return 'dock'
}

function goalProposalSuppressKey(p: ThreadGoalProposal | null | undefined): string {
  if (!p) return ''
  const id = String(p.toolCallId || '').trim()
  if (id) return `id:${id}`
  const g = String(p.goal || '').trim().slice(0, 200)
  return `goal:${g}`
}

function _pathBasename(p: string): string {
  const s = String(p || '').trim()
  if (!s) return ''
  const noSlash = s.replace(/[\\/]+$/, '')
  const parts = noSlash.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || noSlash
}

function isDesktopTauriRuntime(): boolean {
  return !!((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__)
}

/** WebView2：拖区须标在实际被命中的节点上；仅 header 有拖区时，子层盖住中间会导致只有上下 padding 一条能拖 */
const TAURI_HEADER_CELL_DRAG_PROPS = { 'data-tauri-drag-region': '' } as const

function promptWorkspacePath(current: string): Promise<string> {
  return new Promise((resolve) => {
    showModal({
      title: '设置工作空间目录',
      width: 360,
      fields: [
        {
          name: 'path',
          label: '本机工作空间目录（绝对路径）',
          value: current || '',
          placeholder: '例如：D:\\work\\project',
          hint: '提示：Web 模式请手动输入绝对路径；桌面端可直接选择系统目录。',
        },
      ],
      onConfirm: (result: any) => {
        resolve(String(result?.path || '').trim())
      },
    })
  })
}

// 状态过期时间：5 分钟（300 秒）
const THREAD_STATE_EXPIRY_MS = 5 * 60 * 1000

const QUICK_PROMPTS: Array<{ label: string; prompt: string }> = [
  { label: '开始创作', prompt: '开始创作：给我一个可直接执行的第一步方案，并附上下一步行动清单。' },
  {
    label: '文生视频',
    prompt:
      '请阅读 byted-ark-seedream-skill 与 media-production skill。你是制片：依次委派 screenwriter → visual-planner → artist → video-director，主题为[主题]。要求贴题、克制、镜头与口播衔接；每步验收 outputs/ 后再下一步；生图/生视频用 terminal 跑 provider 脚本。',
  },
  {
    label: '配音字幕短片',
    prompt:
      '请阅读 byted-ark-seedream-skill 与 media-production skill。你是制片：完整委派 screenwriter → visual-planner → artist → video-director → media-post，主题为[主题]。要求：贴题、克制不浮夸、画面与口播前后衔接、声画一致；每步验收 outputs/；主会话用 terminal 跑脚本，不要调用已废弃的 media_* 工具。',
  },
  { label: '写作', prompt: '撰写一篇关于[主题]的博客文章' },
  { label: '深入研究', prompt: '深入浅出的研究一下[主题]，并总结发现。' },
  { label: '收集', prompt: '从[来源]收集数据并创建报告。' },
  { label: '学习', prompt: '帮我学习[主题]：先给学习路线，再出练习题并批改。' },
  { label: '创建', prompt: '创建一个[类型]的作品：给方案、步骤和可交付物。' },
  { label: '创建角色', prompt: '我想新建一个能长期用的[类型]角色。' },
]

function debugSubtaskTooltipEnabled(): boolean {
  try {
    return localStorage.getItem('EVOFLOW_DEBUG_SUBTASK_TOOLTIP') === '1'
  } catch {
    return false
  }
}

function debugSubtaskFlowEnabled(): boolean {
  return isSubtaskStreamDebugEnabled()
}

function debugAssistantDedupEnabled(): boolean {
  try {
    return localStorage.getItem('EVOFLOW_DEBUG_ASSISTANT_DEDUP') === '1'
  } catch {
    return false
  }
}

function parseParentAndSubtaskIdFromComposite(taskId: string): { parentTaskId: string; subtaskId: string } | null {
  const raw = String(taskId || '').trim()
  if (!raw) return null
  const parts = raw.split('-').filter(Boolean)
  if (parts.length < 3) return null
  const a = parts[parts.length - 3] || ''
  const b = parts[parts.length - 2] || ''
  if (!/^[a-f0-9]{8}$/i.test(a) || !/^[a-f0-9]{8}$/i.test(b)) return null
  return { parentTaskId: a.toLowerCase(), subtaskId: b.toLowerCase() }
}

function shortLogText(v: unknown, maxLen = 220): string {
  const s = String(v ?? '').trim()
  if (!s) return ''
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s
}

function syncStreamMediaAssetsFromTools(S: StreamState) {
  const derived = inferMediaAssetsFromToolEntries(S.turn.tools || [])
  S.turn.images = derived.images
  if (derived.videos.length) S.turn.videos = derived.videos
  if (derived.audios.length) S.turn.audios = derived.audios
}

function applyStreamTurnEvent(S: StreamState, event: StreamTurnEvent): void {
  S.turn = reduceStreamTurn(S.turn, event)
}

function applyAgUiWireEvent(
  S: StreamState,
  event: AGUIEvent,
  priorStrip: PriorTurnStripBundle = EMPTY_PRIOR_TURN_STRIP,
): void {
  if (event.type === EventType.RUN_STARTED) {
    const incomingRunId = String((event as { runId?: string }).runId || '').trim()
    const threadId = String((event as { threadId?: string }).threadId || '').trim()
    const prevRunId = String(S.aguiTurn?.runId || S.runId || '').trim()
    if (incomingRunId && (!S.aguiTurn || (prevRunId && prevRunId !== incomingRunId))) {
      S.aguiTurn = emptyAgUiTurnState(incomingRunId, threadId)
      S.runId = incomingRunId
    }
  }
  if (!S.aguiTurn) {
    S.aguiTurn = emptyAgUiTurnState(String(S.runId || ''), '')
  }
  let wireEvent: AGUIEvent = event
  if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
    const delta = String((event as { delta?: string }).delta || '')
    if (delta) {
      const cleaned = stripLoosePriorBodyEcho(stripPriorTurnPollutants(delta, priorStrip), priorStrip.body)
      // 勿用 trim：独立 ``\n\n`` delta 是 markdown 段落分隔，trim 后会被误丢。
      if (!shouldKeepStreamDeltaAfterStrip(cleaned)) {
        sfWarn('agui delta stripped empty', {
          deltaPreview: delta.slice(0, 80),
          priorBodyLen: String(priorStrip.body || '').length,
        })
        return
      }
      if (cleaned !== delta) wireEvent = { ...event, delta: cleaned }
    }
  }
  if (event.type === EventType.REASONING_MESSAGE_CONTENT) {
    const delta = fixReasoningStreamText(String((event as { delta?: string }).delta || ''))
    if (delta) {
      const cleaned = stripLoosePriorReasoningEcho(
        stripPriorTurnReasoningFromStream(delta, priorStrip),
        priorStrip.reasoning,
      )
      if (!shouldKeepStreamDeltaAfterStrip(cleaned)) return
      if (cleaned !== delta) wireEvent = { ...event, delta: cleaned }
    }
  }
  S.aguiTurn = applyAgUiEvent(S.aguiTurn, wireEvent)
  const openBody = [...S.aguiTurn.messages.values()]
    .filter((m) => !m.closed && m.role === 'assistant')
    .map((m) => m.content)
    .join('')
  if (openBody.trim()) {
    const trimmed = cloneAgUiTurnState(S.aguiTurn)
    for (const msg of trimmed.messages.values()) {
      if (msg.closed || msg.role !== 'reasoning') continue
      msg.content = trimReasoningTextAgainstBody(msg.content, openBody)
    }
    S.aguiTurn = trimmed
  }
  S.turn = syncStreamTurnFromAgUi(S.turn, S.aguiTurn)
}

/** 去掉当前 user 轮内、尚未 final 的流式 partial assistant 行（多轮工具后已落库的中间段） */
function stripMidTurnPartialAssistantRows(rows: DisplayRow[]): DisplayRow[] {
  let lastUserIdx = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role === 'user') {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx < 0) return rows
  const head = rows.slice(0, lastUserIdx + 1)
  const tail = rows.slice(lastUserIdx + 1).filter((row) => {
    if (row.role !== 'assistant') return true
    if (row.durationStr || row.tokenStr) return true
    return row.incompleteStream === true && rowHasVisibleContent(row)
  })
  return [...head, ...tail]
}

/**
 * 下一条 SSE 处理前：封存已持久化段到 compactedParts，释放 turn 内存（仍合并进同一流式气泡）。
 */
function releaseStreamBufferIfNeeded(
  S: StreamState,
  rt: SessionRuntime,
  trigger: StreamReleaseTrigger,
  _applyRowsUpdate: (updater: (r: DisplayRow[]) => DisplayRow[]) => void,
  _runId?: string | null,
): boolean {
  if (S.aguiTurn) return false
  if (!shouldReleaseStreamBufferBeforeEvent(S.turn, trigger)) return false
  const { sealed, releasedToolIds, fresh } = drainStreamTurnRoundBuffer(S.turn)
  rtAddStaleToolCallIds(rt, releasedToolIds)
  if (streamTurnHasVisibleContent(sealed)) {
    const fin = finalizeStreamTurn(sealed, '')
    commitPriorTurnStripTextFromStreamTurn(rt, sealed)
    if (!S.compactedParts) S.compactedParts = []
    S.compactedParts.push(finalizedTurnToCompactedPart(fin))
  }
  S.turn = fresh
  return true
}

/** 用户停止 / aborted：把已收到的流式片段封存为一条 assistant 历史行 */
function buildPartialStreamAssistantRow(
  turn: StreamTurnState,
  runId?: string | null,
  priorStrip: PriorTurnStripBundle = EMPTY_PRIOR_TURN_STRIP,
): DisplayRow {
  const fin = sanitizeFinalizedTurnForPersist(finalizeStreamTurn(turn, ''), priorStrip)
  return {
    role: 'assistant',
    text: fin.text,
    segments: fin.segments,
    reasoningSegments: fin.reasoningSegments,
    reasoningPreview: fin.reasoningPreview,
    tools: [...fin.tools],
    images: [...fin.images],
    videos: [...fin.videos],
    audios: [...fin.audios],
    files: [...fin.files],
    timestamp: Date.now(),
    incompleteStream: true,
    ...(runId ? { runId: String(runId) } : {}),
  }
}



function sealStoppedStreamTurn(
  rt: SessionRuntime,
  turn: StreamTurnState,
  runId: string | null | undefined,
): void {
  rtAddStaleToolCallIds(rt, collectToolCallIdsFromTurn(turn))
  rtAddStoppedRun(rt, runId)
}

function filterStreamToolEntriesForRuntime(rt: SessionRuntime, entries: unknown[]): unknown[] {
  return filterStaleToolEntries(entries, rt.staleToolCallIds)
}

function priorStripForRuntime(rt: SessionRuntime): PriorTurnStripBundle {
  const s = rt.priorTurnStrip
  if (!s?.body && !s?.reasoning && !(s?.toolIds?.length)) return EMPTY_PRIOR_TURN_STRIP
  return { body: s.body, reasoning: s.reasoning, toolIds: s.toolIds || [] }
}

function stripBodyForRuntime(rt: SessionRuntime, text: string): string {
  return stripPriorTurnPollutants(String(text || ''), priorStripForRuntime(rt))
}

function buildVoiceSpeechBodyForRuntime(
  rt: SessionRuntime,
  parts: {
    hostedCaptureText?: string
    segments?: unknown[]
    text?: string
    canonicalOutText?: string
  },
): string {
  return stripBodyForRuntime(rt, resolveVoiceSpeechBodyFromParts(parts))
}

function emptyThreadPanel(): ThreadPanelState {
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
function clearThreadPanelActivity(prev: ThreadPanelState): ThreadPanelState {
  return {
    ...prev,
    activityKind: 'idle',
    activityDetail: '',
    reasoningPreview: null,
    subagentTasks: {},
  }
}

function applyThreadStatePanelPatch(
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

function parseClarificationFromTool(tool: unknown): { toolCallId?: string; preview?: string } | null {
  return clarificationPreviewFromTool(tool)
}

function rowHasVisibleContent(row: DisplayRow | undefined): boolean {
  if (!row) return false
  if (String(row.text || '').trim()) return true
  if ((row.tools || []).length) return true
  if ((row.images || []).length) return true
  if ((row.videos || []).length) return true
  if ((row.audios || []).length) return true
  if ((row.files || []).length) return true
  return false
}

function rowsHaveActionablePlan(rows: DisplayRow[]): boolean {
  if (!Array.isArray(rows) || !rows.length) return false
  if (historyPastPlanExecutionGate(rows)) return true
  const planHit = extractLastPlanToolSuccessFromArrays(collectAssistantToolArraysFromRows(rows))
  if (planHit?.boundPlanReady) return true
  if (planHit?.planInput) return true
  return false
}

function extractLatestClarificationFromRows(rows: DisplayRow[]): { toolCallId?: string; preview?: string } | null {
  if (!Array.isArray(rows) || !rows.length) return null
  if (rowsHaveActionablePlan(rows)) return null
  const awaiting = findAskClarificationAwaitingUserInRows(rows)
  if (!awaiting?.tool) return null
  const toolCallId =
    String((awaiting.tool as { id?: string; tool_call_id?: string }).id || (awaiting.tool as { tool_call_id?: string }).tool_call_id || '').trim() ||
    undefined
  const hit = parseClarificationFromTool(awaiting.tool)
  if (hit?.preview) {
    const input = readAskClarificationInput(awaiting.tool)
    if (isPlanExecutionConfirmationClarification(hit.preview, input)) return null
    return hit
  }
  if (!toolCallId) return null
  return { toolCallId }
}

function clarificationPreviewReady(hit: { toolCallId?: string; preview?: string; content?: string } | null | undefined): boolean {
  const preview = String(hit?.preview || hit?.content || '').trim()
  return !!(preview && isClarificationPreviewRenderable(preview))
}

function rowsAwaitUserReplyAfterSend(rows: DisplayRow[]): boolean {
  if (!Array.isArray(rows) || !rows.length) return false
  const last = rows[rows.length - 1]
  return last?.role === 'user' && rowHasVisibleContent(last)
}

function mergeThreadPanelClarification(
  prev: { toolCallId?: string; preview?: string; content?: string } | null | undefined,
  restored: { toolCallId?: string; preview?: string } | null,
  opts?: { preferPrevWhileSending?: boolean; rowsHaveAwaitingAsk?: boolean },
): { toolCallId?: string; preview?: string } | null {
  const prevId = String(prev?.toolCallId || '').trim()
  const restoredId = String(restored?.toolCallId || '').trim()
  const prevReady = clarificationPreviewReady(prev)
  const restoredReady = clarificationPreviewReady(restored)
  const awaiting = !!opts?.rowsHaveAwaitingAsk

  if (restoredReady && restored) return restored
  if (awaiting && opts?.preferPrevWhileSending && prevReady && prev && (!restoredId || restoredId === prevId)) {
    return { toolCallId: prev.toolCallId, preview: prev.preview || prev.content }
  }
  if (awaiting && prevReady && prev && (!restoredId || restoredId === prevId)) {
    return { toolCallId: prev.toolCallId, preview: prev.preview || prev.content }
  }
  if (awaiting && restored?.toolCallId) return restored
  return null
}

function clearThreadPanelClarification(prev: ThreadPanelState): ThreadPanelState {
  if (!prev.clarification) return prev
  return {
    ...prev,
    clarification: null,
    ...(String(prev.activityKind || '').toLowerCase() === 'clarification'
      ? { activityKind: 'idle' as const, activityDetail: '' }
      : {}),
  }
}

function shouldSuppressClarificationPanel(
  rows: DisplayRow[],
  prev: ThreadPanelState,
): boolean {
  if (findAskClarificationAwaitingUserInRows(rows)) return false
  if (rowsHaveActionablePlan(rows)) return true
  if (
    String(prev.collabPhase || '')
      .trim()
      .toLowerCase() === 'plan_ready'
  ) {
    return true
  }
  if (prev.collabTask?.boundPlanReady) return true
  return false
}

function readToolInputRecord(tool: unknown): Record<string, unknown> | null {
  const t = (tool && typeof tool === 'object' ? (tool as Record<string, unknown>) : null) || null
  if (!t) return null
  const raw = t.input ?? t.args ?? t.arguments ?? t.kwargs
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try {
      const o = JSON.parse(raw)
      return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  return null
}

/** 从单条工具解析 propose_goal 入参（与 useGoalMode / 后端字段对齐；兼容 propose_hosted_agent） */
function parseGoalProposalFromTool(tool: unknown): ThreadGoalProposal | null {
  const t = (tool && typeof tool === 'object' ? (tool as Record<string, unknown>) : null) || null
  if (!t) return null
  const name = String(t.name || t.tool || t.tool_name || '').trim().toLowerCase()
  if (!isGoalProposalToolName(name)) return null
  const input = readToolInputRecord(tool)
  if (!input) return null
  const goal = String(input.goal ?? input.task ?? input.prompt ?? '').trim()
  if (!goal) return null
  const toolCallId = String(t.id || t.tool_call_id || '').trim() || undefined
  let feishuPushOnComplete: boolean | undefined
  if (input.feishu_push_on_complete !== undefined && input.feishu_push_on_complete !== null) {
    feishuPushOnComplete = Boolean(input.feishu_push_on_complete)
  } else if (input.feishuPushOnComplete !== undefined && input.feishuPushOnComplete !== null) {
    feishuPushOnComplete = Boolean(input.feishuPushOnComplete)
  }
  const pushChannelRaw = input.push_channel ?? input.pushChannel
  const pushTargetIdRaw = input.push_target_id ?? input.pushTargetId
  const pushChannel =
    pushChannelRaw !== undefined && pushChannelRaw !== null ? String(pushChannelRaw).trim() : undefined
  const pushTargetId =
    pushTargetIdRaw !== undefined && pushTargetIdRaw !== null ? String(pushTargetIdRaw).trim() : undefined
  const stepDelayMsRaw = input.step_delay_ms ?? input.stepDelayMs
  const stepDelayMs =
    stepDelayMsRaw !== undefined && stepDelayMsRaw !== null
      ? Math.max(200, Math.min(120_000, Math.round(Number(stepDelayMsRaw))))
      : undefined
  const retryRaw = input.retry_limit ?? input.retryLimit
  const retryLimit =
    retryRaw !== undefined && retryRaw !== null ? Math.max(0, Math.min(20, Math.round(Number(retryRaw)))) : undefined
  const useEvolutionSkill =
    input.use_evolution_skill !== undefined
      ? Boolean(input.use_evolution_skill)
      : input.useEvolutionSkill !== undefined
        ? Boolean(input.useEvolutionSkill)
        : undefined
  return {
    toolCallId,
    goal,
    ...(feishuPushOnComplete !== undefined ? { feishuPushOnComplete } : {}),
    ...(pushChannel ? { pushChannel } : {}),
    ...(pushTargetId ? { pushTargetId } : {}),
    ...(stepDelayMs !== undefined ? { stepDelayMs } : {}),
    ...(retryLimit !== undefined ? { retryLimit } : {}),
    ...(useEvolutionSkill !== undefined ? { useEvolutionSkill } : {}),
  }
}

function extractGoalProposalFromTools(tools: unknown[]): ThreadGoalProposal | null {
  if (!Array.isArray(tools) || !tools.length) return null
  for (let i = tools.length - 1; i >= 0; i--) {
    const hit = parseGoalProposalFromTool(tools[i])
    if (hit) return hit
  }
  return null
}

function extractLatestGoalProposalFromRows(rows: DisplayRow[]): ThreadGoalProposal | null {
  const hasRowContent = (row: DisplayRow | undefined): boolean => {
    if (!row) return false
    if (String(row.text || '').trim()) return true
    if ((row.tools || []).length) return true
    if ((row.images || []).length) return true
    if ((row.videos || []).length) return true
    if ((row.audios || []).length) return true
    if ((row.files || []).length) return true
    return false
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (!hasRowContent(row)) continue
    if (row.role === 'user') return null
    const tools = Array.isArray(row?.tools) ? row.tools : []
    const hit = extractGoalProposalFromTools(tools)
    if (hit) return hit
  }
  return null
}

/** 子智能体流事件 → 协作子任务 status（与 EvoFlow 存储 / SessionSidebar 一致） */
function collabStatusFromSubagentStreamEv(ev: Record<string, unknown>): string | null {
  const t = ev.type
  // running/started 只能表示"执行中"，绝不能把子任务误置为终态（否则 UI 会抖动：变绿/显示名称）
  if (t === 'task_started' || t === 'task_running') return 'executing'
  if (t === 'task_completed') return 'completed'
  if (t === 'task_failed') return 'failed'
  if (t === 'task_timed_out') return 'timed_out'
  return null
}

function patchCollabSubtasksById(
  list: CollabSubtaskSnapshot[],
  subtaskId: string,
  status: string,
  patch?: Partial<CollabSubtaskSnapshot>,
): CollabSubtaskSnapshot[] {
  const normalizeStatus = (v?: string) =>
    String(v || '')
      .trim()
      .toLowerCase()
      .replace(/-/g, '_')
  const isTerminal = (v?: string) => {
    const s = normalizeStatus(v)
    return s === 'completed' || s === 'failed' || s === 'cancelled' || s === 'timed_out'
  }
  const statusRank = (v?: string) => {
    const s = normalizeStatus(v)
    if (s === 'completed') return 4
    if (s === 'failed') return 3
    if (s === 'cancelled' || s === 'timed_out') return 2
    if (s === 'in_progress' || s === 'running' || s === 'executing') return 1
    return 0
  }
  const nextStatusNorm = normalizeStatus(status)
  const nextIsTerminal = isTerminal(nextStatusNorm)
  let changed = false
  const next = list.map((s) => {
    if (s.subtaskId !== subtaskId) return s
    // 终态子任务禁止被后续心跳/进度回刷为 executing，避免 UI 在 completed <-> running 闪烁。
    if (isTerminal(s.status) && !nextIsTerminal) return s
    // completed 视为最终成功终态；避免被迟到的 failed/cancelled/timed_out 事件降级覆盖。
    if (normalizeStatus(s.status) === 'completed' && nextStatusNorm !== 'completed') return s
    // 允许同级/升级覆盖，但禁止从更高可信终态降级（例如 failed <- cancelled）。
    if (statusRank(s.status) > statusRank(nextStatusNorm)) return s
    changed = true
    return { ...s, status, ...(status === 'completed' ? { progress: 100 } : {}), ...(patch || {}) }
  })
  return changed ? next : list
}

function mergeCollabSubtasksStable(
  prevList: CollabSubtaskSnapshot[],
  incomingList: CollabSubtaskSnapshot[],
): CollabSubtaskSnapshot[] {
  const normalizeStatus = (v?: string) =>
    String(v || '')
      .trim()
      .toLowerCase()
      .replace(/-/g, '_')
  const statusRank = (v?: string) => {
    const s = normalizeStatus(v)
    if (s === 'completed') return 4
    if (s === 'failed') return 3
    if (s === 'cancelled' || s === 'timed_out') return 2
    if (s === 'in_progress' || s === 'running' || s === 'executing' || s === 'active') return 1
    return 0
  }

  const nextById = new Map<string, CollabSubtaskSnapshot>()
  for (const row of prevList || []) {
    const id = String(row?.subtaskId || '').trim()
    if (!id) continue
    nextById.set(id, row)
  }
  for (const row of incomingList || []) {
    const id = String(row?.subtaskId || '').trim()
    if (!id) continue
    const prev = nextById.get(id)
    if (!prev) {
      nextById.set(id, row)
      continue
    }
    const prevStatus = String(prev.status || '').trim()
    const inStatus = String(row.status || '').trim()
    const keepPrevStatus = statusRank(prevStatus) > statusRank(inStatus)
    nextById.set(id, {
      ...prev,
      ...row,
      ...(keepPrevStatus ? { status: prevStatus } : {}),
      ...(normalizeStatus(prevStatus) === 'completed' && normalizeStatus(inStatus) !== 'completed'
        ? { status: prevStatus, progress: typeof prev.progress === 'number' ? prev.progress : 100 }
        : {}),
    })
  }
  return Array.from(nextById.values())
}

function finalizeCollabSubtasksList(
  list: CollabSubtaskSnapshot[],
  subagentTasks?: Record<string, SubagentStreamTask>,
): CollabSubtaskSnapshot[] {
  return stabilizeCollabSubtasksByStreamPhase(preferPersistedCollabSubtasks(list), subagentTasks)
}

function stabilizeCollabSubtasksByStreamPhase(
  list: CollabSubtaskSnapshot[],
  subagentTasks?: Record<string, SubagentStreamTask>,
): CollabSubtaskSnapshot[] {
  return stabilizeCollabSubtasksByStreamPhaseLib(list, subagentTasks)
}

function mapSnapSupervisorSteps(raw: unknown): SupervisorStepSnapshot[] {
  if (!Array.isArray(raw)) return []
  return raw.map((x, i) => {
    const r = x as Record<string, unknown>
    return {
      id: String(r.id ?? r.step_id ?? `step-${i}`),
      action: String(r.action ?? ''),
      label: String(r.label ?? r.action ?? '步骤'),
      done: !!(r.done ?? r.completed),
    }
  })
}

type SidebarTaskView = {
  task: CollabTaskSnapshot
  subtasks: CollabSubtaskSnapshot[]
  steps: SupervisorStepSnapshot[]
  updatedAt: number
  /** 写入侧栏快照时的会话 key，避免切换对话后仍展示其它会话任务 */
  sessionKey?: string
}

function trimStepsToLatestTask(steps?: SupervisorStepSnapshot[]): SupervisorStepSnapshot[] | undefined {
  if (!steps || !steps.length) return steps
  let start = -1
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    const label = String(s.label || '').toLowerCase()
    const action = String(s.action || '').toLowerCase()
    if (
      label.includes('创建主任务') ||
      label.includes('create task') ||
      action.includes('create_task')
    ) {
      start = i
    }
  }
  if (start <= 0) return steps
  return steps.slice(start)
}

function safeReadSessionMetaMap(): Record<string, any> {
  try {
    return JSON.parse(
      localStorage.getItem(STORAGE_SESSION_META_KEY) ||
        localStorage.getItem('evopanel-chat-session-meta') ||
        '{}',
    )
  } catch {
    return {}
  }
}

/** 仅从 `agent:{code}:{channel}` 解析智能体 code；`thread:*` 等占位键勿用第二段当 code（否则会把 UUID 当智能体名）。前缀大小写不敏感。 */
function parseSessionAgent(key: string) {
  const k = key || ''
  if (!k.toLowerCase().startsWith('agent:')) return ''
  const parts = k.split(':')
  return parts.length >= 2 ? String(parts[1] || '').trim() : ''
}

/**
 * 底部「角色」药丸与列表高亮用的 agent_code：与发消息时一致。
 * 员工会话（proactive:…）以 sessionKey 内 agent_code 为准；其余优先 flat agent_id，
 * 再 agent_name，最后才是 sessionKey 嵌入 / main。
 */
function resolveSessionAgentCodeForUi(sessionKey: string): string {
  if (isProactiveSessionKey(sessionKey)) {
    const code = String(parseProactiveSessionKey(sessionKey).agentCode || '')
      .trim()
      .toLowerCase()
    if (code) return code
  }
  try {
    const ctx = wsClient.getSessionContext(sessionKey) as {
      agent_name?: string
      agent_id?: string
      use_claude_code_chat?: boolean | string | number
    } | undefined
    const flag =
      ctx?.use_claude_code_chat === true ||
      ctx?.use_claude_code_chat === 1 ||
      String(ctx?.use_claude_code_chat || '').toLowerCase() === 'true'
    if (flag) return 'claude-code'
    const aid = typeof ctx?.agent_id === 'string' ? ctx.agent_id.trim().toLowerCase() : ''
    if (aid) return aid
    const an = typeof ctx?.agent_name === 'string' ? ctx.agent_name.trim().toLowerCase() : ''
    if (an) return an
  } catch {
    /* ignore */
  }
  const fromKey = parseSessionAgent(sessionKey)
  if (fromKey) return fromKey.toLowerCase()
  return 'main'
}

function safeWriteSessionMetaMap(map: Record<string, any>) {
  try {
    localStorage.setItem(STORAGE_SESSION_META_KEY, JSON.stringify(map))
  } catch {
    // ignore
  }
}

/** Plan 协作仅反映用户手动开启；plan 工具/服务端 collab_phase 不自动改底部「模式」展示 */
function getSessionCollabModeFromMeta(sessionKey: string): boolean {
  return !!safeReadSessionMetaMap()[sessionKey]?.collabMode
}

function setSessionCollabModeInMeta(sessionKey: string, on: boolean) {
  if (!sessionKey) return
  const map = safeReadSessionMetaMap()
  if (on) {
    map[sessionKey] = { ...(map[sessionKey] || {}), collabMode: true }
  } else {
    const cur = map[sessionKey] || {}
    const next = { ...cur }
    delete next.collabMode
    if (Object.keys(next).length) map[sessionKey] = next
    else delete map[sessionKey]
  }
  safeWriteSessionMetaMap(map)
}

function getThinkingLevelFromMeta(sessionKey: string): ThinkingLevel {
  const v = safeReadSessionMetaMap()[sessionKey]?.thinkingLevel
  if (v === 'off' || v === 'low' || v === 'medium' || v === 'high') return v
  return 'auto'
}

function setThinkingLevelInMeta(sessionKey: string, level: ThinkingLevel) {
  if (!sessionKey) return
  const map = safeReadSessionMetaMap()
  map[sessionKey] = { ...(map[sessionKey] || {}), thinkingLevel: level }
  safeWriteSessionMetaMap(map)
}

function comparableAssistantText(row: DisplayRow | undefined): string {
  if (!row || row.role !== 'assistant') return ''
  return String(
    assistantPlainForTurnStrip(row) ||
      flattenStreamDisplayText(row.segments || [], row.text || '') ||
      '',
  ).trim()
}

function shouldReplaceFinalAssistantRow(prev: DisplayRow, next: DisplayRow): boolean {
  const prevComparable = comparableAssistantText(prev)
  const nextComparable = comparableAssistantText(next)
  if (!nextComparable || !prevComparable) return false
  if (nextComparable.startsWith(prevComparable)) return true
  const pn = prevComparable.replace(/\s+/g, ' ')
  const nn = nextComparable.replace(/\s+/g, ' ')
  return nn.includes(pn)
}

/** 真实用户轮（跳过工具授权 replay 隐藏 HumanMessage）之后的首条 assistant 下标 */
function findFirstAssistantAfterRealUser(rows: DisplayRow[]): number {
  let lastRealUser = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (row?.role !== 'user') continue
    if (isHiddenToolApprovalUserMessage(String(row.text || ''))) continue
    lastRealUser = i
    break
  }
  if (lastRealUser < 0) return -1
  for (let i = lastRealUser + 1; i < rows.length; i++) {
    if (rows[i]?.role === 'assistant') return i
  }
  return -1
}

/**
 * 工具审批暂停会留下 incompleteStream 气泡；批准后 client_stream_replay 又开新 run。
 * 同轮工具中段也可能先落库成「已完成」气泡，final 再追加一条。
 * final 时把同真实 user 轮内所有 assistant 片段折成一条，避免多截气泡。
 */
function collapseToolApprovalContinuationRows(
  base: DisplayRow[],
  rowForCommit: DisplayRow,
  opts: { keepIncomplete: boolean; durationStr?: string; tokenStr?: string; sealRunId?: string },
): DisplayRow[] | null {
  const firstAssIdx = findFirstAssistantAfterRealUser(base)
  if (firstAssIdx < 0) return null
  const assistants: DisplayRow[] = []
  for (let i = firstAssIdx; i < base.length; i++) {
    if (base[i]?.role === 'assistant') assistants.push(base[i])
  }
  if (!assistants.length) return null
  const hasIncomplete = assistants.some((a) => a.incompleteStream === true)
  const midPartial =
    assistants.length >= 1 &&
    shouldMergeFinalIntoPriorAssistant(assistants[assistants.length - 1], rowForCommit, opts.sealRunId)
  if (!hasIncomplete && !midPartial && assistants.length <= 1) return null

  let merged: DisplayRow = { ...assistants[0], incompleteStream: true }
  for (let i = 1; i < assistants.length; i++) {
    merged = mergeAssistantRowWithStreamRow(merged, assistants[i])
    merged = {
      ...merged,
      incompleteStream: true,
      tools: mergeToolsForPlanDetection(merged.tools || [], assistants[i].tools || []),
    }
  }
  merged = mergeAssistantRowWithStreamRow(merged, rowForCommit)
  merged = {
    ...merged,
    tools: mergeToolsForPlanDetection(merged.tools || [], rowForCommit.tools || []),
  }
  if (opts.keepIncomplete) {
    merged = {
      ...merged,
      incompleteStream: true,
      durationStr: undefined,
      tokenStr: undefined,
    }
  } else {
    const { incompleteStream: _drop, ...rest } = merged as DisplayRow & { incompleteStream?: boolean }
    merged = {
      ...rest,
      ...(opts.durationStr ? { durationStr: opts.durationStr } : {}),
      ...(opts.tokenStr ? { tokenStr: opts.tokenStr } : {}),
    }
  }
  if (opts.sealRunId) merged = { ...merged, runId: opts.sealRunId }
  else if (assistants[0]?.runId) merged = { ...merged, runId: assistants[0].runId }

  const out: DisplayRow[] = base.slice(0, firstAssIdx)
  for (let i = firstAssIdx; i < base.length; i++) {
    const row = base[i]
    if (row?.role === 'assistant') continue
    if (row?.role === 'user' && isHiddenToolApprovalUserMessage(String(row.text || ''))) continue
    out.push(row)
  }
  out.push(merged)
  return out
}

/** 最近几轮 user/assistant 纯文本，供魔法棒结合上一轮回复优化草稿 */
function recentTranscriptForPromptEnhance(rows: DisplayRow[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const row of rows) {
    if (row.role === 'user') {
      const content = String(row.text || '').trim()
      if (content) out.push({ role: 'user', content })
    } else if (row.role === 'assistant') {
      const content = assistantPlainForTurnStrip(row).trim()
      if (content) out.push({ role: 'assistant', content })
    }
  }
  return out.slice(-6)
}


type SkillPickerRow = { name: string; label: string; description: string; icon: string; enabled?: boolean }

ensureRightStageKindsRegistered()
hideRightStageIfKind('artifacts')

function inferWriteStreamFormat(path: string): 'plain' | 'markdown' | 'code' {
  const lower = String(path || '').trim().toLowerCase()
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown'
  if (/\.(tsx?|jsx?|py|go|rs|java|cpp|c|h|css|scss|json|yaml|yml|toml|sh|sql)$/.test(lower)) {
    return 'code'
  }
  return 'plain'
}

export default function ChatApp() {
  const [selectedSessionKey, setSelectedSessionKey] = useState<string>(() => {
    // 优先检查从任务页等其他页面跳转过来的 pending session
    try {
      const pending = sessionStorage.getItem('evopanel_pending_shell_session')
      const pendingThread = sessionStorage.getItem('evopanel_pending_shell_thread')

      if (pending && pendingThread) {
        // 在 useState 初始化时就恢复 thread 映射
        // 这样在 useThreadHistory 执行时就能读到正确的 threadId
        try {
          const map = JSON.parse(localStorage.getItem('evoflow-chat-session-map-v1') || '{}')
          const now = Date.now()
          if (map[pending]) {
            // Session 已存在，只更新 threadId，不更新 updatedAt（避免会话跳到顶部）
            map[pending].threadId = pendingThread
          } else {
            // 新 session，创建完整记录
            map[pending] = {
              threadId: pendingThread,
              createdAt: now,
              updatedAt: now,
              messageCount: 0,
              context: { taskRelated: true },
            }
          }
          localStorage.setItem('evoflow-chat-session-map-v1', JSON.stringify(map))
        } catch (e) {
          console.error('[ChatApp] 恢复 thread 映射失败:', e)
        }
        return pending
      } else if (pending) {
        // 只有 session_key 没有 thread_id，仍然使用 pending session
        return pending
      }
    } catch (e) {
      console.error('[ChatApp] 读取 sessionStorage 失败:', e)
    }

    // Restore last selected session from localStorage (persists across page refresh)
    try {
      const lastSelected = localStorage.getItem(LS_LAST_SELECTED_SESSION)
      if (lastSelected && String(lastSelected).trim()) {
        return String(lastSelected).trim()
      }
    } catch (e) {
      console.error('[ChatApp] 读取上次选中会话失败:', e)
    }

    return ''
  })
  /** 当前选中会话 key（同步 ref，供 useMemo/回调在 state 未提交前读取） */
  const sessionRef = useRef(selectedSessionKey)
  /** 各会话侧栏/询问面板状态缓存（切换会话时恢复；后台会话询问不得写入当前 UI） */
  const threadPanelBySessionRef = useRef(new Map<string, ThreadPanelState>())
  const commitThreadPanelForSessionRef = useRef<
    (sessionKey: string, updater: (prev: ThreadPanelState) => ThreadPanelState) => void
  >(() => {})
  const pendingNewSessionRef = useRef(false)
  const hydrateContextUsageFromSessionsRef = useRef<(rows: ChatSessionRow[]) => void>(() => {})
  const [sessionNamesTick, setSessionNamesTick] = useState(0)
  const {
    sessions,
    setSessions,
    sessionsRef,
    listLoading,
    sessionFilter,
    setSessionFilter,
    moreMenuKey,
    setMoreMenuKey,
    newChatButtonActive,
    setNewChatButtonActive,
    filteredSessions,
    refreshSessions,
    refreshSessionsRef,
    scheduleRefreshSessions,
    scheduleRefreshSessionsRef,
    workspaceSummaries,
    workspacePagination,
    ensureWorkspaceExpanded,
    loadMoreWorkspaceSessions,
    loadMoreGlobalRecentSessions,
    purgeWorkspaceFromSidebar,
    removeSessionFromList,
  } = useSessionList({
    selectedSessionKey,
    sessionRef,
    pendingNewSessionRef,
    setSelectedSessionKey,
    hydrateContextUsageFromSessionsRef,
    sessionNamesTick,
  })
  const { enabled: obsEnabled } = useObsEnabled()
  const selectedThreadId = useMemo(() => {
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) return ''
    const fromSession = String(sessions.find((s) => String(s.sessionKey || '') === sk)?.threadId || '').trim()
    if (fromSession && !fromSession.startsWith('agent:')) return fromSession
    return String(wsClient.getSessionThreadId(sk) || '').trim()
  }, [selectedSessionKey, sessions])
  const streamRef = useRef<StreamState>(emptyStream())
  /** 每会话 rows/stream 真相源；切换只 mount，不 clone / 不全量 reload 覆盖 */
  const executingListEpoch = useSyncExternalStore(
    subscribeExecutingListRuntime,
    getExecutingListRuntimeEpoch,
  )
  const executionProbeEpoch = useSessionExecutionProbes(sessions, selectedSessionKey)
  /** 来自 session-execution 统一判定（侧栏 / Composer / 停止按钮同源） */
  const executingSessionKeys = useMemo(() => {
    void executingListEpoch
    void executionProbeEpoch
    return collectExecutingSessionKeys(sessions)
  }, [sessions, executingListEpoch, executionProbeEpoch])
  const runningSummaryKeys = useMemo(() => Array.from(executingSessionKeys), [executingSessionKeys])
  const { runningSessionMap } = useRunningSessionSummaries(runningSummaryKeys, selectedSessionKey)
  const executingSessionKeysRef = useRef(executingSessionKeys)
  useLayoutEffect(() => {
    executingSessionKeysRef.current = executingSessionKeys
  }, [executingSessionKeys])

  const seenRunIdsRef = useRef(new Set<string>())
  const activeChatRunIdRef = useRef<string | null>(null)
  /** 供「切换会话」清理逻辑读取上一 key；勿用 sessionRef（layout 中已指向新会话） */
  const prevSelectedSessionCleanupRef = useRef<string | null>(null)
  const prevSwitchRevisionRef = useRef(-1)
  const [shellSelectRevision, setShellSelectRevision] = useState(0)
  /** layout 切换瞬间记录的「来自哪条会话」，供 useEffect 写草稿等 */
  const sessionSwitchFromRef = useRef('')
  const refreshAttachAttemptedRef = useRef<Record<string, string>>({})
  const reattachRetryCountRef = useRef(0)
  const manualReattachSessionKeyRef = useRef<string | null>(null)
  const bumpReattachRetryRef = useRef<(() => void) | null>(null)
  const pageLoadResumeDoneRef = useRef(false)
  const requestManualStreamResumeRef = useRef<
    (sessionKey: string, opts?: { refreshSessions?: boolean }) => void
  >(() => {})
  const sendGoalMessageRef = useRef<(prompt: string, sessionKey: string) => void | Promise<void>>(async () => {})
  /** 当前会话实时轮次：封存 assistant 的 runId，刷新/切会话后清空 */
  const [liveTurnAssistantRunId, setLiveTurnAssistantRunId] = useState<string | null>(null)
  /** 当前轮次流式进行中累计 token（每次模型调用后累加，final 后并入 tokenTotals） */
  const [liveTurnTokens, setLiveTurnTokens] = useState<TokenTotals | null>(null)
  const [turnTimingTick, setTurnTimingTick] = useState(0)
  const goalActiveRef = useRef(false)
  const [streamHealth, setStreamHealth] = useState<'connected' | 'disconnected' | 'silent' | null>(null)
  const streamHealthRef = useRef<'connected' | 'disconnected' | 'silent' | null>(null)
  const liveRunPersistTimerRef = useRef<Record<string, ReturnType<typeof setTimeout> | null>>({})
  const liveRunPersistPendingRef = useRef<Record<string, { runId: string; threadId: string | null; status: string; partialText: string; partialTools: unknown[]; partialDisplaySegments: MessageSegment[]; lastEventAtMs: number } | null>>({})

  const gatewayApiFetch = useCallback(async (path: string, init?: RequestInit) => {
    const { gatewayFetch } = await import('../lib/gateway-json.js')
    const p = path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? path : `/${path}`}`
    return gatewayFetch(p, init)
  }, [])

  const putLiveRunSnapshotBestEffort = useCallback(
    (sessionKey: string, snapshot: { runId: string; threadId: string | null; status: string; partialText: string; partialTools: unknown[]; partialDisplaySegments?: MessageSegment[]; lastEventAtMs: number }) => {
      const sk = String(sessionKey || '').trim()
      const runId = String(snapshot.runId || '').trim()
      if (!sk || !runId) return
      // @ts-expect-error partialDisplaySegments may be undefined at runtime
      liveRunPersistPendingRef.current[sk] = snapshot
      const prevTimer = liveRunPersistTimerRef.current[sk]
      if (prevTimer) clearTimeout(prevTimer)
      liveRunPersistTimerRef.current[sk] = setTimeout(() => {
        const latest = liveRunPersistPendingRef.current[sk]
        liveRunPersistTimerRef.current[sk] = null
        if (!latest) return
        void gatewayApiFetch(`/chat/sessions/${encodeURIComponent(sk)}/live-run`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(latest),
        }).catch(() => {})
      }, 2000)
    },
    [gatewayApiFetch],
  )

  const deleteLiveRunSnapshotBestEffort = useCallback(
    (sessionKey: string) => {
      const sk = String(sessionKey || '').trim()
      if (!sk) return
      const prevTimer = liveRunPersistTimerRef.current[sk]
      if (prevTimer) clearTimeout(prevTimer)
      liveRunPersistTimerRef.current[sk] = null
      liveRunPersistPendingRef.current[sk] = null
      void gatewayApiFetch(`/chat/sessions/${encodeURIComponent(sk)}/live-run`, { method: 'DELETE' }).catch(() => {})
    },
    [gatewayApiFetch],
  )

  const historyLiveContext = useMemo(() => {
    const sk = String(selectedSessionKey || '').trim()
    const rt = sk ? getSessionRuntime(sk) : null
    const live = isSessionRuntimeLive(rt) || executingSessionKeys.has(sk)
    const sessionRow = sk ? sessions.find((s) => s.sessionKey === sk) : null
    return {
      isHot: live,
      liveRows: rt?.rows?.length ? rt.rows : null,
      liveSending: isTurnBusy(rt) || isSessionRuntimeLive(rt),
      currentRunId: sessionRow?.currentRunId || null,
      runStatus: sessionRow?.runStatus || null,
      getLive: () => {
        if (!sk) return null
        const cur = getSessionRuntime(sk)
        return { rows: cur.rows, live: isSessionRuntimeLive(cur) || executingSessionKeys.has(sk) }
      },
    }
  }, [selectedSessionKey, executingSessionKeys, executingListEpoch, sessions])

  const selectedStreamPriorTurnStrip = useMemo(
    () => priorStripForRuntime(getSessionRuntime(selectedSessionKey)),
    [selectedSessionKey, executingListEpoch],
  )

  const {
    rows,
    setRows,
    loading: historyLoading,
    error: historyError,
    reload,
    loadOlder: loadOlderHistory,
    loadingOlder: historyLoadingOlder,
    historyHasMore,
    historyInstantPaint,
    tokenTotals,
    setTokenTotals,
    setRestoredScenarioScene,
    historyBoundSessionKey,
  } = useThreadHistory(selectedSessionKey, historyLiveContext)

  const rowsRef = useRef<DisplayRow[]>(rows)
  const clarifyResolveSeqRef = useRef<Map<string, number>>(new Map())
  const [historyViewReady, setHistoryViewReady] = useState(false)
  /** 本会话本轮是否曾展示过消息；用于防止误进首页藏掉底部输入框 */
  const [sessionHadContent, setSessionHadContent] = useState(false)
  useLayoutEffect(() => {
    rowsRef.current = rows
  }, [rows])
  useLayoutEffect(() => {
    setSessionHadContent(false)
  }, [selectedSessionKey])
  useEffect(() => {
    if (Array.isArray(rows) && rows.length > 0) setSessionHadContent(true)
  }, [rows])

  const scheduleClarificationPanelResolve = useCallback(
    (
      sessionKey: string,
      opts?: { toolCallId?: string; localTool?: unknown; preferToolRetries?: boolean },
    ) => {
      const sk = String(sessionKey || '').trim()
      if (!sk) return
      const liveRows = rowsRef.current || []
      if (
        turnBusyForSession(sessionRef.current) &&
        rowsAwaitUserReplyAfterSend(liveRows) &&
        !findAskClarificationAwaitingUserInRows(liveRows)
      ) {
        return
      }
      const tcid = String(opts?.toolCallId || peekClarificationLatch(sk) || '').trim()
      if (tcid) latchClarificationToolCall(sk, tcid)
      const gen = (clarifyResolveSeqRef.current.get(sk) || 0) + 1
      clarifyResolveSeqRef.current.set(sk, gen)
      void resolveClarificationPanelAuthoritative(sk, {
        toolCallId: tcid || undefined,
        localTool: opts?.localTool,
        preferToolRetries: opts?.preferToolRetries,
      }).then((hit) => {
        if (clarifyResolveSeqRef.current.get(sk) !== gen) return
        const activeSk = String(sessionRef.current || selectedSessionKey || '').trim()
        const rowsNow =
          sk === activeSk ? rowsRef.current || [] : getSessionRuntime(sk).rows || []
        const stillAwaiting = findAskClarificationAwaitingUserInRows(rowsNow)
        if (
          turnBusyForSession(sk) &&
          rowsAwaitUserReplyAfterSend(rowsNow) &&
          !stillAwaiting
        ) {
          commitThreadPanelForSessionRef.current(sk, (prev) => clearThreadPanelClarification(prev))
          return
        }
        if (!hit?.preview || !isClarificationPreviewRenderable(hit.preview)) {
          if (!stillAwaiting && !(opts?.preferToolRetries && tcid)) {
            commitThreadPanelForSessionRef.current(sk, (prev) => {
              if (shouldSuppressClarificationPanel(rowsNow, prev)) return prev
              return clearThreadPanelClarification(prev)
            })
          }
          return
        }
        const input = opts?.localTool ? readAskClarificationInput(opts.localTool) : null
        if (isPlanExecutionConfirmationClarification(hit.preview, input)) {
          commitThreadPanelForSessionRef.current(sk, (prev) => clearThreadPanelClarification(prev))
          return
        }
        commitThreadPanelForSessionRef.current(sk, (prev) => {
          if (shouldSuppressClarificationPanel(rowsNow, prev)) return prev
          return {
            ...prev,
            clarification: hit,
            activityKind: 'clarification',
            activityDetail: getActivityHint('clarification') || '等你选择呢~',
          }
        })
      })
    },
    [selectedSessionKey],
  )
  const scheduleClarificationPanelResolveRef = useRef(scheduleClarificationPanelResolve)
  scheduleClarificationPanelResolveRef.current = scheduleClarificationPanelResolve

  /**
   * Shared clarification detection bridge — extracts ask_clarification from
   * the current stream turn's tool entries, schedules the authoritative API
   * resolve, and updates threadPanelState.clarification.
   *
   * Called from ALL SSE handlers that process tool events:
   * state === 'tool', state === 'agui_event', state === 'stream_turn', state === 'delta'.
   */
  const detectAndScheduleClarificationFromStreamTurn = useCallback(
    (
      S: StreamState,
      rt: SessionRuntime,
      targetSk: string,
      _isBackground: boolean,
    ) => {
      const rowsForClarify: DisplayRow[] = [...rt.rows]
      if (streamTurnHasVisibleContent(S.turn)) {
        rowsForClarify.push({
          role: 'assistant',
          text: '',
          tools: S.turn.tools as DisplayRow['tools'],
          timestamp: Date.now(),
        })
      }
      const clarifyHit = extractLatestClarificationFromRows(rowsForClarify)
      const awaitingAsk = findAskClarificationAwaitingUserInRows(rowsForClarify)
      const clarifySk = String(targetSk || selectedSessionKey || '').trim()
      const awaitingToolCallId = awaitingAsk?.tool
        ? String(
            (awaitingAsk.tool as { id?: string; tool_call_id?: string }).id ||
              (awaitingAsk.tool as { tool_call_id?: string }).tool_call_id ||
              '',
          ).trim()
        : ''
      if (awaitingToolCallId && clarifySk) {
        scheduleClarificationPanelResolveRef.current(clarifySk, {
          toolCallId: awaitingToolCallId,
          localTool: awaitingAsk?.tool,
          preferToolRetries: true,
        })
      }
      const toolPreview = formatActivityDetailFromRunningToolCalls(S.turn.tools as unknown[])
      commitThreadPanelForSessionRef.current(clarifySk, (prev) => {
        let nextClarification = clarifyHit
        if (!nextClarification?.preview && awaitingAsk) {
          nextClarification =
            parseClarificationFromTool(awaitingAsk.tool) ?? prev.clarification ?? nextClarification
        }
        // 其它工具 SSE 更新时保留 thread_state / 已解析的询问表单，避免侧栏闪灭
        if (!nextClarification) {
          nextClarification = prev.clarification
        }
        const showClarify = !!(
          nextClarification?.preview &&
          (isClarificationPreviewRenderable(nextClarification.preview) ||
            isStaleClarificationPreview(nextClarification.preview))
        )
        const nextActivityKind = showClarify
          ? 'clarification'
          : toolPreview
            ? 'tools'
            : prev.activityKind === 'tools'
              ? 'thinking'
              : prev.activityKind
        const nextActivityDetail = showClarify
          ? getActivityHint('clarification') || '等你选择呢~'
          : toolPreview || (prev.activityKind === 'tools' ? getActivityHint('tools') : prev.activityDetail)
        if (
          nextClarification === prev.clarification &&
          nextActivityKind === prev.activityKind &&
          nextActivityDetail === prev.activityDetail
        ) {
          return prev
        }
        return {
          ...prev,
          clarification: nextClarification,
          activityKind: nextActivityKind,
          activityDetail: nextActivityDetail,
        }
      })
    },
    [selectedSessionKey],
  )
  const detectAndScheduleClarificationRef = useRef(detectAndScheduleClarificationFromStreamTurn)
  detectAndScheduleClarificationRef.current = detectAndScheduleClarificationFromStreamTurn

  useLayoutEffect(() => {
    queueMicrotask(() => setHistoryViewReady(false))
  }, [selectedSessionKey])

  /** 历史重载（刷新/F5/续挂）开始时重新等待贴底 boot，避免沿用过期 ready 状态；流式进行中不遮罩 */
  useLayoutEffect(() => {
    if (!historyLoading) return
    const sk = String(selectedSessionKey || '').trim()
    const rt = sk ? getSessionRuntime(sk) : null
    const attach = rt ? deriveAttachState(rt) : 'idle'
    const live =
      turnBusyForSession(sk) ||
      isSessionRuntimeLive(rt) ||
      attach === 'attaching' ||
      attach === 'attached'
    if (live) return
    // 已有内容的同会话 reload（刷新/F5）不应遮罩：避免短暂闪白后内容跳变
    const hasExistingContent = rowsRef.current.length > 0
    if (hasExistingContent) return
    setHistoryViewReady(false)
  }, [historyLoading, selectedSessionKey])

  /** 兜底：boot 异常未回调时勿永久遮罩 */
  useEffect(() => {
    if (historyViewReady || historyLoading) return
    const t = window.setTimeout(() => setHistoryViewReady(true), 3500)
    return () => window.clearTimeout(t)
  }, [historyViewReady, historyLoading, selectedSessionKey])

  useEffect(() => {
    const hasActiveTurnTiming = () => anySessionHasLiveTurnTiming(sessionsRef.current)
    if (!hasActiveTurnTiming() || !getChatSurfaceVisible()) return
    const t = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      if (!getChatSurfaceVisible()) return
      if (hasActiveTurnTiming()) setTurnTimingTick((n) => n + 1)
    }, 1000)
    return () => window.clearInterval(t)
  }, [executingListEpoch, sessions])

  // 落库历史在 React rows 里，runtime.rows 常为 []；发送前对齐，避免 handleSend 只剩新用户消息
  useEffect(() => {
    const sk = String(selectedSessionKey || '').trim()
    if (!sk || historyLoading || turnBusyForSession(sk)) return
    if (historyBoundSessionKey !== sk) return
    const visible = rowsRef.current.length ? rowsRef.current : rows
    if (visible.length) hydrateSessionRuntimeRowsIfIdle(sk, visible)
  }, [rows, historyLoading, selectedSessionKey, executingListEpoch, historyBoundSessionKey])

  /** 切换会话：selectedSessionKey 或用户 force 重选（同 key）时 mount stream */
  useLayoutEffect(() => {
    const prev = prevSelectedSessionCleanupRef.current
    const sk = String(selectedSessionKey || '').trim()
    const rev = shellSelectRevision
    if (prev === sk && rev === prevSwitchRevisionRef.current) return
    prevSwitchRevisionRef.current = rev
    ssLog('switch.layout', { from: skTail(prev ?? ''), to: skTail(sk), rev })
    sessionSwitchFromRef.current = prev ? prev : ''
    if (prev) {
      const prevRt = getSessionRuntime(prev)
      const activeSkNow = String(sessionRef.current || '').trim()
      const streamForCommit =
        streamRef.current === prevRt.stream || activeSkNow === prev
          ? streamRef.current
          : prevRt.stream
      commitActiveSessionRuntime(prev, {
        rows: rowsRef.current,
        stream: streamForCommit,
        seenRunIds: seenRunIdsRef.current,
        activeChatRunId: activeChatRunIdRef.current,
      })
    }
    delete refreshAttachAttemptedRef.current[sk]
    reattachRetryCountRef.current = 0
    if (sk) {
      const rt = mountSessionRuntime(sk, {
        streamRef,
        seenRunIdsRef,
        activeChatRunIdRef,
      })
      if (isSessionRuntimeLive(rt)) {
        const runId =
          String(rt.activeChatRunId || '').trim() ||
          String(sessionsRef.current.find((s) => String(s.sessionKey || '') === sk)?.currentRunId || '').trim()
        const liveRows = runId
          ? markResumeAnchorAssistantIncomplete([...rt.rows], runId)
          : [...rt.rows]
        setRows(liveRows)
        publishLiveStreamNow(sk, rt.stream, { streaming: true })
      }
    } else {
      streamRef.current = emptyStream()
      seenRunIdsRef.current = new Set()
      activeChatRunIdRef.current = null
    }
    prevSelectedSessionCleanupRef.current = sk
  }, [selectedSessionKey, shellSelectRevision])

  /** Monotonic id so aborted/stale handleSend cannot clear a newer round's stream state. */
  const chatSendSeqRef = useRef(0)
  /** Per-session unsent composer text (restored when switching sessions). */
  const composerDraftsRef = useRef(new Map<string, string>())
  const composerTextRef = useRef('')
  const composerDraftSnapshotRef = useRef('')
  const savedDraftBeforeGlobalVoiceRef = useRef('')
  const pendingComposerDraftCarryRef = useRef<string | null>(null)
  const handleEditMessageRef = useRef<(text: string, messageId?: string) => void | Promise<void>>(
    () => {},
  )
  const [composerDraftVersion, setComposerDraftVersion] = useState(0)
  const [speechEnabled, setSpeechEnabled] = useState(false)
  const [engineReady, setEngineReady] = useState(() => {
    // Desktop UI-first: unlock send on Gateway liveness ; LG may still warm.
    try {
      if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) return false
    } catch {
      /* ignore */
    }
    return true
  })
  const [voiceReplyEnabled, setVoiceReplyEnabled] = useState(() => getVoiceReplyEnabled())
  const [knowledgeMapEnabled, setKnowledgeMapEnabled] = useState(
    () => getPanelSetting('knowledgeMapEnabled') !== false,
  )
  const [shortcutHintTick, setShortcutHintTick] = useState(0)
  useEffect(() => {
    const syncVoiceReply = () => {
      setVoiceReplyEnabled(getVoiceReplyEnabled())
    }
    window.addEventListener('evopanel:panel-settings-loaded', syncVoiceReply)
    window.addEventListener('evopanel:panel-settings-changed', syncVoiceReply)
    return () => {
      window.removeEventListener('evopanel:panel-settings-loaded', syncVoiceReply)
      window.removeEventListener('evopanel:panel-settings-changed', syncVoiceReply)
    }
  }, [])

  useEffect(() => {
    const syncKnowledgeMap = () => {
      setKnowledgeMapEnabled(getPanelSetting('knowledgeMapEnabled') !== false)
    }
    window.addEventListener('evopanel:panel-settings-loaded', syncKnowledgeMap)
    window.addEventListener('evopanel:panel-settings-changed', syncKnowledgeMap)
    return () => {
      window.removeEventListener('evopanel:panel-settings-loaded', syncKnowledgeMap)
      window.removeEventListener('evopanel:panel-settings-changed', syncKnowledgeMap)
    }
  }, [])

  useEffect(() => {
    const onShortcutsChanged = () => setShortcutHintTick((t) => t + 1)
    window.addEventListener('evopanel:keyboard-shortcuts-changed', onShortcutsChanged)
    return () => window.removeEventListener('evopanel:keyboard-shortcuts-changed', onShortcutsChanged)
  }, [])

  const composerShortcutExtras = useMemo(() => {
    void shortcutHintTick
    return composerPlaceholderExtras()
  }, [shortcutHintTick])

  const refreshSpeechConfigured = useCallback(() => {
    void (async () => {
      try {
        const { isVolcengineAsrEnabled } = await import('../lib/voice-asr-policy.js')
        if (!isVolcengineAsrEnabled()) {
          const { isWebSpeechCaptureAvailable } = await import('../lib/web-speech-capture.js')
          if (isWebSpeechCaptureAvailable()) {
            setSpeechEnabled(true)
            return
          }
        }
        const { fetchSpeechConfigured } = await import('../lib/speech-client.js')
        setSpeechEnabled(!!(await fetchSpeechConfigured()))
      } catch {
        setSpeechEnabled(false)
      }
    })()
  }, [])

  useEffect(() => {
    // ✅ 修复：只注册一次！不要依赖 selectedSessionKey，否则每次切会话就重新注册
    // 我们用 sessionRef.current 读最新值，不需要放在依赖项里
    registerVoiceSendHandler(async (text, opts) => {
      if (opts?.global) {
        const sk = String(selectedSessionKey || sessionRef.current || '').trim()
        if (!sk) {
          await ensureChatSessionKeyRef.current?.()
        }
      }
      await handleVoiceTranscribedRef.current(text, opts)
    })
    return () => unregisterVoiceSendHandler()
  }, [])

  const pushComposerText = useCallback((next: string) => {
    composerTextRef.current = next
    composerDraftSnapshotRef.current = next
    setComposerDraftVersion((v) => v + 1)
    const sk = String(sessionRef.current || selectedSessionKey || '').trim()
    if (!sk) return
    if (next) composerDraftsRef.current.set(sk, next)
    else composerDraftsRef.current.delete(sk)
  }, [selectedSessionKey])

  // 持续监听 / 全局按住说话：把实时识别文字推到 Composer 输入框（与话筒按钮一致）
  useEffect(() => {
    registerVoicePartialBeginHandler(() => {
      savedDraftBeforeGlobalVoiceRef.current = composerTextRef.current
      pushComposerText('')
    })
    registerVoicePartialHandler((partialText: string) => {
      pushComposerText(partialText)
    })
    registerVoicePartialEndHandler(({ cancelled }) => {
      if (cancelled) {
        pushComposerText(savedDraftBeforeGlobalVoiceRef.current)
      } else {
        pushComposerText('')
      }
      savedDraftBeforeGlobalVoiceRef.current = ''
    })
    return () => {
      unregisterVoicePartialBeginHandler()
      unregisterVoicePartialHandler()
      unregisterVoicePartialEndHandler()
    }
  }, [pushComposerText])
  /** 本轮由语音输入发起 → 流式/结束时朗读 assistant 正文 */
  const voiceReplyPendingRef = useRef(false)
  /** 语音发起时绑定的 sessionKey（后台/隐藏窗口也播报） */
  const voiceSessionKeyRef = useRef('')
  /** 是否已开始流式语音播报（用于 final 托盘状态） */
  const voiceStreamingStartedRef = useRef(false)
  /** 已同步到 TTS 队列的 plainText 前缀，避免重复入队 */
  const voiceSpeechSyncedPlainRef = useRef('')
  const maybeSyncVoiceReplySpeech = useCallback(
    (replySk: string, S: Parameters<typeof streamProject>[0], rt: SessionRuntime) => {
      if (!voiceReplyPendingRef.current) return
      const voiceSk = String(voiceSessionKeyRef.current || '').trim()
      const sk = String(replySk || '').trim()
      if (!voiceSk || sk !== voiceSk) return

      const tools = (S.turn?.tools || []) as unknown[]
      const proj = streamProject(S)
      const speechBody = buildVoiceSpeechBodyForRuntime(rt, {
        segments: proj.segments,
        text: proj.text,
      })

      void import('../lib/voice-reply-speech.js').then(
        ({
          shouldMuteVoiceSpeech,
          shouldAdvanceVoiceSpeechSync,
          enqueueVoiceStreamSpeech,
          enterVoiceToolMute,
          exitVoiceToolMute,
          isVoiceToolMuteActive,
          clipVoiceSpeechForPlayback,
          toVoiceSpeechPlain,
        }) => {
          if (!voiceReplyPendingRef.current) return
          const voiceSkNow = String(voiceSessionKeyRef.current || '').trim()
          if (!voiceSkNow || sk !== voiceSkNow) return

          if (shouldMuteVoiceSpeech(tools)) {
            enterVoiceToolMute((s) => setVoiceTrayState(s))
            void setVoiceTrayState('running')
            return
          }
          if (isVoiceToolMuteActive()) {
            exitVoiceToolMute()
          }

          if (!speechBody) return
          const speakable = clipVoiceSpeechForPlayback(speechBody)
          if (
            !speakable ||
            !shouldAdvanceVoiceSpeechSync(speakable, voiceSpeechSyncedPlainRef.current)
          ) {
            return
          }

          voiceSpeechSyncedPlainRef.current = toVoiceSpeechPlain(speakable)
          voiceStreamingStartedRef.current = true
          void setVoiceTrayState('speaking')
          enqueueVoiceStreamSpeech(speakable)
        },
      )
    },
    [],
  )
  const handleVoiceTranscribedRef = useRef<
    (text: string, opts?: { global?: boolean }) => Promise<void>
  >(async () => {})
  /** 本轮已成功解析的 plan（避免历史工具合并 / stream 清空后 hit 变 none） */
  type PlanPanelHit = {
    planInput?: Record<string, unknown>
    boundPlanReady?: boolean
    taskId?: string
    planOutput?: Record<string, unknown>
    status?: string
    preview?: string
    boundPlanPersisted?: boolean
  }
  const lastPlanPanelHitRef = useRef<PlanPanelHit | null>(null)
  const [planPanelHit, setPlanPanelHit] = useState<PlanPanelHit | null>(null)
  /** 流式中一旦出现 plan 即置位；final 合并丢 input 时仍展示计划面板 */
  const planStreamLatchRef = useRef<{
    planInput?: Record<string, unknown>
    boundPlanReady?: boolean
    taskId?: string
  } | null>(null)
  const [planStreamLatched, setPlanStreamLatched] = useState(false)
  const publishPlanPanelHit = useCallback((hit: PlanPanelHit | null) => {
    lastPlanPanelHitRef.current = hit
    setPlanPanelHit(hit)
    if (hit?.planInput || hit?.boundPlanReady) {
      planStreamLatchRef.current = {
        planInput: hit.planInput,
        boundPlanReady: hit.boundPlanReady,
        taskId: hit.taskId,
      }
      setPlanStreamLatched(true)
    }
  }, [])
  /** final 清空 stream 后仍用于 plan 检测的合并工具行（避免落库 name-only 覆盖流式入参） */
  const lastPlanDetectionToolsRef = useRef<unknown[]>([])
  /** 流式全程累积的最完整 plan 入参（final / emptyStream 不丢） */
  const persistedPlanInputRef = useRef<Record<string, unknown> | null>(null)
  const lastPlanSyncSigRef = useRef('')

  const resetPlanStreamSession = useCallback(() => {
    lastPlanPanelHitRef.current = null
    setPlanPanelHit(null)
    planStreamLatchRef.current = null
    setPlanStreamLatched(false)
    lastPlanDetectionToolsRef.current = []
    persistedPlanInputRef.current = null
    lastPlanSyncSigRef.current = ''
  }, [])

  const absorbPlanFromTools = useCallback((tools: unknown[]) => {
    const next = absorbPlanInputFromTools(persistedPlanInputRef.current, tools)
    const hit = analyzePlanTools(tools).hit
    if (!next && !hit?.boundPlanReady) return
    if (next) persistedPlanInputRef.current = next
    const prevLatch = planStreamLatchRef.current
    const mergedHit = {
      planInput: next || prevLatch?.planInput,
      boundPlanReady: !!(hit?.boundPlanReady || prevLatch?.boundPlanReady),
      taskId: hit?.taskId || prevLatch?.taskId,
      planOutput: (hit as Record<string, unknown>)?.planOutput || (prevLatch as Record<string, unknown>)?.planOutput,
    }
    planStreamLatchRef.current = mergedHit
    setPlanStreamLatched(true)
    if (next) {
      setThreadPanelState((prev) => ({
        ...prev,
        planInputFallback: pickRicherStructuredPlanInput(next, prev.planInputFallback),
      }))
    }
    if (mergedHit.planInput || mergedHit.boundPlanReady) {
      // @ts-expect-error planOutput type mismatch
      publishPlanPanelHit(mergedHit)
    }
  }, [publishPlanPanelHit])
  const planResolveInFlightRef = useRef(false)
  /** 同一会话+任务只拉一次 plan / collab 快照，避免多路 effect 重复请求导致面板闪烁 */
  const planAppliedForRef = useRef('')
  const planApiSyncInflightRef = useRef<Promise<void> | null>(null)
  /** 计划确认条唯一展示态：仅 syncPlanPanelFromApi 写入 */
  type PlanDockApiView =
    | {
        show: false
        source: string
        reason: string
        taskId?: string
        taskStatus?: string
      }
    | {
        show: true
        source: string
        taskId: string
        taskName?: string
        taskStatus: string
        statusLabel: string
        showStartExecution: boolean
        planStructured: StructuredPlanInput
        subtaskCount: number
        toolCallId: string
      }
  const [planDockApiView, setPlanDockApiView] = useState<PlanDockApiView | null>(null)
  const planDockApiViewRef = useRef<PlanDockApiView | null>(null)
  const applyPlanDockApiView = useCallback((view: PlanDockApiView) => {
    planDockApiViewRef.current = view
    tracePlanDockApi(view.show ? 'show' : 'hide', {
      source: view.source,
      reason: view.show ? undefined : view.reason,
      taskId: view.taskId,
      taskStatus: view.show ? view.taskStatus : view.taskStatus,
      statusLabel: view.show ? view.statusLabel : undefined,
    })
    setPlanDockApiView(view)
  }, [])
  const historyCollabHydratedRef = useRef('')
  const planSessionEnterRef = useRef('')
  /** 侧栏单条刷新进行中：避免 warm+reload 双拉 messages、session_enter 再打 tasks */
  const sessionRefreshInFlightRef = useRef('')
  const historyRowsBootstrappedRef = useRef('')
  const planFromApiLoadedRef = useRef('')
  const threadCollabSnapshotRef = useRef('')
  const chatStreamBgApplyRef = useRef(false)
  const chatSurfaceVisibleRef = useRef(true)
  useSyncExternalStore(
    subscribeChatSurfaceVisible,
    () => {
      chatSurfaceVisibleRef.current = getChatSurfaceVisible()
      return getChatSurfaceVisible()
    },
    () => true,
  )
  const [sidePanelHeavyMount, setSidePanelHeavyMount] = useState(false)
  const cancelPendingStreamUiBumpsRef = useRef<() => void>(() => {})
  const scheduleBumpRef = useRef<((opts?: { immediate?: boolean }) => void) | null>(null)

  /** 发送前最后一条已落库 assistant 全文；delta 若以前缀开头则剥掉（messages/values 误把上一轮拼进本轮） */
  // NOTE: 已移除 task-progress 快照刷新逻辑

  useEffect(() => {
    collabDagDebugBannerOnce()
    subtaskStreamDebugBannerOnce()
  }, [])

  const handleComposerDraftChange = useCallback((next: string) => {
    composerTextRef.current = next
    const sk = (sessionRef.current || selectedSessionKey || '').trim()
    if (!sk) return
    if (next) composerDraftsRef.current.set(sk, next)
    else composerDraftsRef.current.delete(sk)
  }, [selectedSessionKey])

  const handleComposerWarmup = useCallback(() => {
    const sk = String(sessionRef.current || selectedSessionKey || '').trim()
    if (!sk) return
    void import('./lib/composer-latency-warmup.js').then((mod) => {
      void mod.warmComposerSession(sk)
    })
  }, [selectedSessionKey])

  const restoreComposerDraft = useCallback((draft: string) => {
    composerTextRef.current = draft
    composerDraftSnapshotRef.current = draft
    setComposerDraftVersion((v) => v + 1)
  }, [])
  const [threadPanelState, setThreadPanelState] = useState<ThreadPanelState>(emptyThreadPanel())
  const threadPanelStateRef = useRef<ThreadPanelState>(emptyThreadPanel())
  const commitThreadPanelForSession = useCallback(
    (sessionKey: string, updater: (prev: ThreadPanelState) => ThreadPanelState) => {
      const sk = String(sessionKey || '').trim()
      if (!sk) return
      const activeSk = String(sessionRef.current || selectedSessionKey || '').trim()
      if (sk === activeSk) {
        setThreadPanelState((prev) => {
          const next = updater(prev)
          if (next !== prev) threadPanelBySessionRef.current.set(sk, next)
          return next
        })
        return
      }
      const prev = threadPanelBySessionRef.current.get(sk) || emptyThreadPanel()
      const next = updater(prev)
      if (next === prev) return
      threadPanelBySessionRef.current.set(sk, next)
    },
    [selectedSessionKey],
  )
  commitThreadPanelForSessionRef.current = commitThreadPanelForSession
  useEffect(() => {
    threadPanelStateRef.current = threadPanelState
    // 仅随 threadPanelState 写入缓存；勿依赖 selectedSessionKey，否则切会话时
    // 新 key 已生效但 panel 仍是上一会话，会把询问弹窗状态污染到错误会话。
    const sk = String(sessionRef.current || '').trim()
    if (sk) threadPanelBySessionRef.current.set(sk, threadPanelState)
  }, [threadPanelState])
  const apiRef = useRef<any>(null)
  const [sessionMode, setSessionMode] = useState<SessionMode>(() => getSessionModeFromMeta(selectedSessionKey))
  const [collabOn, setCollabOn] = useState<boolean>(() => getSessionCollabModeFromMeta(selectedSessionKey))
  /** 与 ws-client session context ``memory_enabled`` 对齐；默认开，仅显式 ``false`` 为关 */
  const [memoryEnabled, setMemoryEnabled] = useState(true)
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(() => getThinkingLevelFromMeta(selectedSessionKey || ''))
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  /** 后端动态返回的模式列表（含 visible/scenario）；null 表示尚未加载 */
  const [dynamicModes, setDynamicModes] = useState<Array<{ value: string; label: string; visible: boolean; scenario: string | null }> | null>(null)
  const [_collabBusy, _setCollabBusy] = useState(false)
  /** 已通过行内/API 处理，避免历史/流式里残留的 pending_approval 再次显示 */
  const toolApprovalResolvedIdsRef = useRef<Set<string>>(new Set())
  const [toolApprovalPolicyTick, setToolApprovalPolicyTick] = useState(0)
  /** 审批 API 请求进行中（独立于轮次 busy 状态，避免待授权时按钮被禁用） */
  const [toolApprovalInFlight, setToolApprovalInFlight] = useState(false)
  const [sessionSidebarOpen, setSessionSidebarOpen] = useState(false)
  const [subtasksApiRefreshKey, setSubtasksApiRefreshKey] = useState(0)
  const bumpSubtasksApiRefresh = useCallback(() => {
    setSubtasksApiRefreshKey((k) => k + 1)
  }, [])
  const {
    workspacePanelOpen,
    setWorkspacePanelOpen,
    collabExecPanelOpen,
    setCollabExecPanelOpen,
    knowledgeMapPanelOpen,
    setKnowledgeMapPanelOpen,
    openWriteStream,
    showKind,
    appendStream: appendRightStageStream,
    openStream: openRightStageStream,
    clearStream: clearRightStageStream,
    closeStream: closeRightStageStream,
    surface: rightStageSurface,
    snapshot: rightStageSnapshot,
    rightPanelLayoutKind: rightStageLayoutKind,
    mainBodyStageClasses,
    isOpen: rightStageOpen,
  } = useRightStageChatBridge()
  const [knowledgeMapRefreshKey, setKnowledgeMapRefreshKey] = useState(0)
  const bumpKnowledgeMapRefresh = useCallback(() => {
    setKnowledgeMapRefreshKey((k) => k + 1)
  }, [])
  /** 用户点「隐藏」后本会话+任务不再自动展开，直至新一轮 executing */
  const collabExecDismissedKeysRef = useRef(new Set<string>())
  const prevCollabExecPhaseRef = useRef('')
  /** 切换会话后首次观测到 collab phase 时只记 baseline，不自动展开工作流 */
  const collabExecSessionBaselinedRef = useRef('')
  const [workspaceTreePinned, setWorkspaceTreePinned] = useState(false)
  const [filePreviewModal, setFilePreviewModal] = useState<{
    path: string
    name: string
    poll: boolean
  } | null>(null)
  /** Chat @@dir/@@ → open workspace tree at this path */
  const [workspaceBrowseFocusPath, setWorkspaceBrowseFocusPath] = useState<string | null>(null)
  /** Filled after workspace roots resolve; used by early file-open handlers */
  const workspaceOpenScopeRef = useRef({
    root: '',
    configuredRoot: '',
    useVirtualPaths: false,
    sessionKey: '',
  })
  const [streamingWritePreview, setStreamingWritePreview] = useState<{
    path: string
    name: string
    content: string
    streaming: boolean
  } | null>(null)
  const lastStreamWritePathRef = useRef<string | null>(null)
  const lastWriteStreamLenRef = useRef(0)
  /** 用户手动打开/固定某一右侧场景时，写入流不得抢焦点 */
  const rightStageUserPinnedRef = useRef<RightStageKind | null>(null)
  /** 用户主动关闭写入流后，本轮写入完成前不再自动弹出 */
  const writeStreamDismissedRef = useRef(false)
  /** 本 run 内关掉过的 Right Stage kind（关闭冷却） */
  const dismissedRightStageKindsRef = useRef<Set<string>>(new Set())
  /** 当前对话轮次 id（发送时刷新） */
  const rightStageRunIdRef = useRef(`run-${Date.now()}`)
  const rightStageHintTimerRef = useRef(0)
  const platformFeedbackSeenRef = useRef<Set<string>>(new Set())
  /** 本轮文件产物 */
  const turnRunArtifactsRef = useRef<ChatArtifact[]>([])
  /** 本轮平台操作（独立 tab，累加） */
  const turnPlatformEntriesRef = useRef<PlatformRunEntry[]>([])
  const [sessionPlatformEntries, setSessionPlatformEntries] = useState<PlatformRunEntry[]>([])
  const [platformFocusEntryId, setPlatformFocusEntryId] = useState('')
  const [turnPlatformEntries, setTurnPlatformEntries] = useState<PlatformRunEntry[]>([])
  const [turnArtifacts, setTurnArtifacts] = useState<ChatArtifact[]>([])
  const [artifactFocusId, setArtifactFocusId] = useState('')
  const publishPlatformEntriesRef = useRef<(entries: PlatformRunEntry[], focusEntryId?: string) => void>(() => {})
  const publishArtifactsRef = useRef<
    (opts?: { focusId?: string; hint?: string; force?: boolean }) => void
  >(() => {})
  const setSessionArtifactsRef = useRef<Dispatch<SetStateAction<ChatArtifact[]>>>(() => {})
  const writeStreamModeRef = useRef<WriteStreamMode>(
    normalizeWriteStreamMode(getPanelSetting('writeStreamMode')),
  )
  useEffect(() => {
    const syncWriteStreamMode = () => {
      writeStreamModeRef.current = normalizeWriteStreamMode(getPanelSetting('writeStreamMode'))
    }
    syncWriteStreamMode()
    window.addEventListener('evopanel:panel-settings-loaded', syncWriteStreamMode)
    window.addEventListener('evopanel:panel-settings-changed', syncWriteStreamMode)
    return () => {
      window.removeEventListener('evopanel:panel-settings-loaded', syncWriteStreamMode)
      window.removeEventListener('evopanel:panel-settings-changed', syncWriteStreamMode)
    }
  }, [])
  const streamingWritePreviewRef = useRef(streamingWritePreview)
  streamingWritePreviewRef.current = streamingWritePreview
  const pendingStreamingPreviewRef = useRef<typeof streamingWritePreview>(null)
  const streamingPreviewFlushTimerRef = useRef(0)
  const flushStreamingWritePreview = useCallback(() => {
    streamingPreviewFlushTimerRef.current = 0
    const pending = pendingStreamingPreviewRef.current
    if (!pending) return
    pendingStreamingPreviewRef.current = null
    setStreamingWritePreview(pending)
  }, [])
  const queueStreamingWritePreview = useCallback(
    (next: NonNullable<typeof streamingWritePreview>) => {
      streamingWritePreviewRef.current = next
      pendingStreamingPreviewRef.current = next
      if (streamingPreviewFlushTimerRef.current) return
      streamingPreviewFlushTimerRef.current = window.setTimeout(flushStreamingWritePreview, next.streaming ? 48 : 200)
    },
    [flushStreamingWritePreview],
  )
  useEffect(
    () => () => {
      if (streamingPreviewFlushTimerRef.current) {
        clearTimeout(streamingPreviewFlushTimerRef.current)
        streamingPreviewFlushTimerRef.current = 0
      }
    },
    [],
  )
  const workspacePanelOpenRef = useRef(workspacePanelOpen)
  workspacePanelOpenRef.current = workspacePanelOpen
  const collabExecPanelOpenRef = useRef(collabExecPanelOpen)
  collabExecPanelOpenRef.current = collabExecPanelOpen
  /** 打开右侧分栏（工作区 / 协作执行）前左侧壳是否已折叠；关闭时恢复 */
  const shellCollapsedBeforeWorkspaceRef = useRef<boolean | null>(null)
  const [contextFiles, setContextFiles] = useState<ContextFileEntry[]>([])
  /** 拖入/路径引用的本地图片全屏预览：null=关闭，number=打开的索引（仅统计图片项） */
  const [contextImagePreviewIndex, setContextImagePreviewIndex] = useState<number | null>(null)
  const openSessionSidebar = useCallback(() => {
    setSessionSidebarOpen(true)
  }, [])
  /** 右侧工作区展开时折叠左侧会话壳，关闭时恢复（与 header 文件夹按钮联动） */
  const syncShellAsideForWorkspacePanel = useCallback((open: boolean) => {
    if (open) {
      if (shellCollapsedBeforeWorkspaceRef.current === null) {
        shellCollapsedBeforeWorkspaceRef.current = getShellAsideCollapsed()
      }
      setShellAsideCollapsed(true)
      return
    }
    if (shellCollapsedBeforeWorkspaceRef.current !== null) {
      setShellAsideCollapsed(shellCollapsedBeforeWorkspaceRef.current)
      shellCollapsedBeforeWorkspaceRef.current = null
    }
  }, [])

  const closeWorkspacePanel = useCallback(() => {
    const kind = normalizeRightStageKind(rightStageStore.getSnapshot().surface?.kind || '')
    if (kind === 'write' || kind === 'workspace-browse') {
      dismissedRightStageKindsRef.current.add(kind)
      if (kind === 'write') writeStreamDismissedRef.current = true
    }
    setStreamingWritePreview(null)
    lastStreamWritePathRef.current = null
    lastWriteStreamLenRef.current = 0
    setFilePreviewModal(null)
    setChatOverlayDefer('workspace', false)
    rightStageUserPinnedRef.current = null
    hideRightStageIfKind('workspace-browse', 'write')
    setWorkspaceTreePinned(false)
    syncShellAsideForWorkspacePanel(false)
    if (!isChatOverlayDeferActive()) {
      scheduleBumpRef.current?.({ immediate: true })
    }
  }, [syncShellAsideForWorkspacePanel])

  const collabExecPanelDismissKey = useCallback(
    (sk?: string, taskId?: string) => {
      const sessionKey = String(sk || selectedSessionKey || '').trim()
      const tid = String(
        taskId || threadPanelState.collabTask?.taskId || threadPanelState.boundTaskId || '',
      ).trim()
      return sessionKey && tid ? `${sessionKey}:${tid}` : ''
    },
    [selectedSessionKey, threadPanelState.collabTask?.taskId, threadPanelState.boundTaskId],
  )

  const openCollabExecPanel = useCallback(
    (opts?: { clearDismiss?: boolean }) => {
      cancelPendingStreamUiBumpsRef.current()
      setChatOverlayDefer('workspace', false)
      setChatOverlayDefer('knowledge-map', false)
      setChatOverlayDefer('workflow', true)
      if (opts?.clearDismiss !== false) {
        const key = collabExecPanelDismissKey()
        if (key) collabExecDismissedKeysRef.current.delete(key)
      }
      flushSync(() => {
        setWorkspacePanelOpen(false)
        setWorkspaceTreePinned(false)
        setStreamingWritePreview(null)
        lastStreamWritePathRef.current = null
        setFilePreviewModal(null)
        setKnowledgeMapPanelOpen(false)
        bumpSubtasksApiRefresh()
        rightStageUserPinnedRef.current = 'collab-workflow'
        setCollabExecPanelOpen(true)
      })
    },
    [collabExecPanelDismissKey, bumpSubtasksApiRefresh],
  )

  const closeCollabExecPanel = useCallback(() => {
    const key = collabExecPanelDismissKey()
    if (key) collabExecDismissedKeysRef.current.add(key)
    setChatOverlayDefer('workflow', false)
    rightStageUserPinnedRef.current = null
    hideRightStageIfKind('collab-workflow')
    if (!isChatOverlayDeferActive()) {
      scheduleBumpRef.current?.({ immediate: true })
    }
  }, [collabExecPanelDismissKey])

  // ★ 性能优化：稳定化回调引用，避免每次 re-render 生成新函数破坏 HistoryMessageRow memo
  const handleQuickPrompt = useCallback((text: string) => { void handleSend(text) }, [handleSend])
  const handleSendRef = useRef(handleSend)
  handleSendRef.current = handleSend
  const startNewChatWithPresetAgentRef = useRef<(code: string) => Promise<void>>(async () => {})
  const setModelNameRef = useRef<(name: string) => void>(() => {})
  useEffect(() => {
    const onHomeSend = (event: Event) => {
      const detail = (event as CustomEvent<{
        text?: string
        agentCode?: string
        skills?: SkillSelection[]
        modelName?: string
        attachments?: ChatAttachment[]
        contextFiles?: ContextFileEntry[]
      }>).detail
      const text = String(detail?.text || '').trim()
      const attachments = Array.isArray(detail?.attachments) ? detail.attachments : undefined
      const homeCtx = Array.isArray(detail?.contextFiles)
        ? detail.contextFiles.filter((f) => String(f?.path || '').trim())
        : []
      if (!text && !attachments?.length && !homeCtx.length) return
      void (async () => {
        if (Array.isArray(detail?.skills)) setSelectedSkills(detail.skills)
        const modelName = String(detail?.modelName || '').trim()
        if (modelName) {
          setModelNameRef.current(modelName)
          try {
            localStorage.setItem(STORAGE_MODEL_KEY, modelName)
          } catch {
            /* ignore */
          }
          void patchPanelSettings({ lastSelectedModel: modelName })
        }
        const code = String(detail?.agentCode || '').trim()
        if (code) {
          try {
            await startNewChatWithPresetAgentRef.current(code)
          } catch {
            /* ignore — still send */
          }
        }
        if (modelName) {
          try {
            const sk =
              (sessionRef.current || '').trim() ||
              (await ensureChatSessionKeyRef.current?.()) ||
              ''
            if (sk) await wsClient.updateSessionContext(sk, { model_name: modelName })
          } catch {
            /* ignore */
          }
        }
        if (homeCtx.length) attachContextFilesRef.current?.(homeCtx)
        await handleSendRef.current(text, attachments, homeCtx.length ? homeCtx : undefined, {
          skillsOverride: Array.isArray(detail?.skills) ? detail.skills : undefined,
        })
      })()
    }
    const onHomeSelectModel = (event: Event) => {
      const modelName = String(
        (event as CustomEvent<{ modelName?: string }>).detail?.modelName || '',
      ).trim()
      if (!modelName) return
      setModelNameRef.current(modelName)
      void (async () => {
        try {
          const sk =
            (sessionRef.current || '').trim() ||
            (await ensureChatSessionKeyRef.current?.()) ||
            ''
          if (sk) await wsClient.updateSessionContext(sk, { model_name: modelName })
        } catch {
          /* ignore */
        }
      })()
    }
    const onHomeSetMemory = (event: Event) => {
      const enabled = (event as CustomEvent<{ enabled?: boolean }>).detail?.enabled
      if (typeof enabled !== 'boolean') return
      setMemoryEnabled(enabled)
    }
    const onHomeSetVoiceReply = (event: Event) => {
      const enabled = (event as CustomEvent<{ enabled?: boolean }>).detail?.enabled
      if (typeof enabled !== 'boolean') return
      setVoiceReplyEnabled(enabled)
    }
    window.addEventListener('evopanel:home-send', onHomeSend)
    window.addEventListener('evopanel:home-select-model', onHomeSelectModel)
    window.addEventListener('evopanel:home-set-memory', onHomeSetMemory)
    window.addEventListener('evopanel:home-set-voice-reply', onHomeSetVoiceReply)
    return () => {
      window.removeEventListener('evopanel:home-send', onHomeSend)
      window.removeEventListener('evopanel:home-select-model', onHomeSelectModel)
      window.removeEventListener('evopanel:home-set-memory', onHomeSetMemory)
      window.removeEventListener('evopanel:home-set-voice-reply', onHomeSetVoiceReply)
    }
  }, [])
  const handleCopyMessage = useCallback(() => {}, [])
  const handleRetryMessage = useCallback(() => {
    const lastUserRow = [...rowsRef.current].reverse().find((r) => r.role === 'user')
    if (lastUserRow) {
      const { text } = resolveUserMessageSkillDisplay(lastUserRow)
      void handleSend(String(text || ''))
    }
  }, [handleSend])
  const handleEditMessage = useCallback((text: string, messageId?: string) => {
    void handleEditMessageRef.current?.(text, messageId)
  }, [])
  /** 稳定引用：传给 MessageVirtualList（已 memo），避免内联箭头函数每次渲染击穿 memo */
  const handleHistoryViewReady = useCallback(() => setHistoryViewReady(true), [])
  /** 稳定引用：传给 GoalModePanel（已 memo），避免内联箭头每次渲染击穿 memo */
  const startGoalRef = useRef<(() => void) | null>(null)
  const stopGoalRef = useRef<(() => void) | null>(null)
  const handleStartGoal = useCallback(() => { void startGoalRef.current?.() }, [])
  const handleStopGoal = useCallback(() => { void stopGoalRef.current?.() }, [])
  const handleSubmitClarification = useCallback(
    (answerText: string) => {
      clearClarificationLatch(selectedSessionKey)
      setThreadPanelState((prev) => ({ ...prev, clarification: null }))
      void goalCaptureRef.current.onUserClarificationSubmitted?.(answerText)
      void handleSend(answerText)
    },
    [selectedSessionKey, handleSend],
  )
  const handleToolApprovalRef = useRef(handleToolApproval)
  handleToolApprovalRef.current = handleToolApproval
  const onToolApprovalStable = useCallback(
    (action: 'approve' | 'approve_all' | 'deny' | 'grant_all' | 'approve_remember', toolCallId?: string, hint?: { tool_name?: string; summary?: string; args?: Record<string, unknown> }) => {
      void handleToolApprovalRef.current(action, toolCallId, hint)
    },
    [],
  )

  const openKnowledgeMapPanel = useCallback(() => {
    if (!knowledgeMapEnabled) return
    cancelPendingStreamUiBumpsRef.current()
    setChatOverlayDefer('workspace', false)
    setChatOverlayDefer('workflow', false)
    setChatOverlayDefer('knowledge-map', true)
    flushSync(() => {
      setWorkspacePanelOpen(false)
      setWorkspaceTreePinned(false)
      setStreamingWritePreview(null)
      lastStreamWritePathRef.current = null
      setFilePreviewModal(null)
      setCollabExecPanelOpen(false)
      setKnowledgeMapRefreshKey((k) => k + 1)
      rightStageUserPinnedRef.current = 'mind-map'
      setKnowledgeMapPanelOpen(true)
    })
  }, [knowledgeMapEnabled])

  const closeKnowledgeMapPanel = useCallback(() => {
    setChatOverlayDefer('knowledge-map', false)
    rightStageUserPinnedRef.current = null
    hideRightStageIfKind('mind-map')
    if (!isChatOverlayDeferActive()) {
      scheduleBumpRef.current?.({ immediate: true })
    }
  }, [])

  const syncRemoteStageSet = useCallback((detail: StageSetPayload) => {
    const kind = String(detail.surface?.kind || '').trim()
    if (detail.action === 'hide' || !kind) {
      rightStageUserPinnedRef.current = null
      setChatOverlayDefer('workspace', false)
      setChatOverlayDefer('knowledge-map', false)
      setChatOverlayDefer('workflow', false)
      syncShellAsideForWorkspacePanel(false)
      if (!isChatOverlayDeferActive()) {
        scheduleBumpRef.current?.({ immediate: true })
      }
      return
    }
    // 产物改由侧栏 Info Rail 呈报，不走 Right Stage
    if (kind === 'artifacts') {
      hideRightStageIfKind('artifacts')
      const data = (detail.surface?.data || {}) as Record<string, unknown>
      const incoming = normalizeChatArtifacts(data.items)
      if (incoming.length) {
        turnRunArtifactsRef.current = mergeChatArtifacts(turnRunArtifactsRef.current, incoming)
        setSessionArtifactsRef.current((prev) => mergeChatArtifacts(prev, incoming))
        publishArtifactsRef.current({
          focusId: String(data.focusId || incoming[incoming.length - 1]?.id || ''),
        })
      }
      return
    }
    cancelPendingStreamUiBumpsRef.current()
    rightStageUserPinnedRef.current = kind as RightStageKind
    setChatOverlayDefer('workspace', kind === 'workspace-browse' || kind === 'write')
    setChatOverlayDefer('workflow', false)
    setChatOverlayDefer('knowledge-map', kind === 'mind-map')
    if (kind !== 'write') {
      setStreamingWritePreview(null)
      lastStreamWritePathRef.current = null
    }
    setFilePreviewModal(null)
    setWorkspaceTreePinned(kind === 'workspace-browse')
    if (kind === 'mind-map') {
      setKnowledgeMapRefreshKey((k) => k + 1)
    }
    if (kind === 'news-dashboard' || kind === 'web-embed') {
      syncShellAsideForWorkspacePanel(true)
    }
    scheduleBumpRef.current?.({ immediate: true })
  }, [syncShellAsideForWorkspacePanel])

  useEffect(() => {
    const onStageSet = (ev: Event) => {
      const detail = (ev as CustomEvent<StageSetPayload>).detail
      if (!detail) return
      syncRemoteStageSet(detail)
    }
    window.addEventListener(STAGE_SET_APPLIED_EVENT, onStageSet)
    return () => window.removeEventListener(STAGE_SET_APPLIED_EVENT, onStageSet)
  }, [syncRemoteStageSet])

  const activeStageExtensionKind = isUserStageExtensionKind(rightStageSurface?.kind)
    ? rightStageSurface.kind
    : null

  const activeStageUiExtensionId =
    rightStageOpen && rightStageSurface?.kind === 'web-embed'
      ? String(
          (rightStageSurface.data || {}).extensionId ||
            (rightStageSurface.data || {}).extension_id ||
            '',
        ).trim()
      : ''

  const openStageExtension = useCallback(
    (kind: UserStageExtensionKind) => {
      if (rightStageSurface?.kind === kind && rightStageOpen) {
        rightStageUserPinnedRef.current = null
        hideRightStageIfKind(kind)
        if (isUserStageExtensionKind(kind)) {
          syncShellAsideForWorkspacePanel(false)
        }
        if (!isChatOverlayDeferActive()) {
          scheduleBumpRef.current?.({ immediate: true })
        }
        return
      }
      cancelPendingStreamUiBumpsRef.current()
      setChatOverlayDefer('workspace', false)
      setChatOverlayDefer('workflow', false)
      setChatOverlayDefer('knowledge-map', false)
      syncShellAsideForWorkspacePanel(true)
      flushSync(() => {
        setWorkspacePanelOpen(false)
        setWorkspaceTreePinned(false)
        setStreamingWritePreview(null)
        lastStreamWritePathRef.current = null
        setFilePreviewModal(null)
        setCollabExecPanelOpen(false)
        setKnowledgeMapPanelOpen(false)
        writeStreamDismissedRef.current = false
        rightStageUserPinnedRef.current = kind
        const extensionData =
          kind === 'web-embed' ? { url: '', editable: true } : undefined
        showKind(kind, {
          title: titleForUserStageExtension(kind),
          data: extensionData,
        })
      })
    },
    [
      rightStageSurface?.kind,
      rightStageOpen,
      showKind,
      setWorkspacePanelOpen,
      setCollabExecPanelOpen,
      setKnowledgeMapPanelOpen,
      syncShellAsideForWorkspacePanel,
    ],
  )

  /** Open installed UI extension in the shared right-stage browser embed (not full-page route). */
  const openUiExtensionInStage = useCallback(
    (extensionId: string) => {
      const id = String(extensionId || '').trim()
      if (!id) return

      const surface = rightStageStore.getSnapshot().surface
      const currentExt = String(
        (surface?.data || {}).extensionId || (surface?.data || {}).extension_id || '',
      ).trim()
      if (surface?.kind === 'web-embed' && currentExt === id && rightStageOpen) {
        rightStageUserPinnedRef.current = null
        hideRightStageIfKind('web-embed')
        syncShellAsideForWorkspacePanel(false)
        if (!isChatOverlayDeferActive()) {
          scheduleBumpRef.current?.({ immediate: true })
        }
        return
      }

      void (async () => {
        try {
          const { ensureUiExtensionReady, getUiExtension } = await import('../lib/ui-extensions.js')
          const rowRaw = await getUiExtension(id)
          const row =
            rowRaw && typeof rowRaw === 'object' ? (rowRaw as Record<string, unknown>) : null
          if (!row) {
            toast('扩展未安装', 'error')
            return
          }
          if (row.enabled === false) {
            toast('扩展已禁用，请先在扩展应用中心启用', 'warning')
            return
          }
          const manifest =
            row.manifest && typeof row.manifest === 'object'
              ? (row.manifest as Record<string, unknown>)
              : {}
          const ui =
            manifest.ui && typeof manifest.ui === 'object'
              ? (manifest.ui as Record<string, unknown>)
              : {}
          const nav =
            manifest.nav && typeof manifest.nav === 'object'
              ? (manifest.nav as Record<string, unknown>)
              : {}
          const title =
            String(nav.title || manifest.name || id).trim() || id
          let entry = String(ui.entry || '').trim()
          const ready = (await ensureUiExtensionReady(id)) as {
            entry?: string
            state?: string
          }
          if (ready?.entry) entry = String(ready.entry).trim() || entry
          if (!entry) {
            toast('扩展缺少入口地址（ui.entry）', 'error')
            return
          }
          const sandbox = Array.isArray(ui.sandbox)
            ? (ui.sandbox as unknown[]).map((s) => String(s || '').trim()).filter(Boolean)
            : [
                'allow-scripts',
                'allow-same-origin',
                'allow-forms',
                'allow-popups',
              ]
          cancelPendingStreamUiBumpsRef.current()
          setChatOverlayDefer('workspace', false)
          setChatOverlayDefer('workflow', false)
          setChatOverlayDefer('knowledge-map', false)
          syncShellAsideForWorkspacePanel(true)
          flushSync(() => {
            setWorkspacePanelOpen(false)
            setWorkspaceTreePinned(false)
            setStreamingWritePreview(null)
            lastStreamWritePathRef.current = null
            setFilePreviewModal(null)
            setCollabExecPanelOpen(false)
            setKnowledgeMapPanelOpen(false)
            writeStreamDismissedRef.current = false
            rightStageUserPinnedRef.current = 'web-embed'
            showKind('web-embed', {
              title,
              data: {
                url: entry,
                editable: false,
                extensionId: id,
                extensionManifest: manifest,
                sandbox,
                titleLabel: title,
              },
            })
          })
        } catch (e) {
          toast(toUserFacingError((e as Error)?.message || e), 'error')
        }
      })()
    },
    [
      rightStageOpen,
      showKind,
      setWorkspacePanelOpen,
      setCollabExecPanelOpen,
      setKnowledgeMapPanelOpen,
      syncShellAsideForWorkspacePanel,
    ],
  )

  const closeRightStage = useCallback(() => {
    const kind = normalizeRightStageKind(rightStageStore.getSnapshot().surface?.kind || '')
    if (kind) dismissedRightStageKindsRef.current.add(kind)
    if (kind === 'workspace-browse' || kind === 'write') {
      closeWorkspacePanel()
      return
    }
    if (kind === 'mind-map') {
      closeKnowledgeMapPanel()
      return
    }
    if (kind === 'collab-workflow') {
      closeCollabExecPanel()
      return
    }
    if (kind === 'write') {
      writeStreamDismissedRef.current = true
      lastWriteStreamLenRef.current = 0
      clearRightStageStream('write_file')
    }
    if (kind === 'artifacts') {
      hideRightStageIfKind('artifacts')
      rightStageUserPinnedRef.current = null
      if (!isChatOverlayDeferActive()) {
        scheduleBumpRef.current?.({ immediate: true })
      }
      return
    }
    if (isUserStageExtensionKind(kind)) {
      rightStageUserPinnedRef.current = null
      hideRightStageIfKind(kind)
      syncShellAsideForWorkspacePanel(false)
      if (!isChatOverlayDeferActive()) {
        scheduleBumpRef.current?.({ immediate: true })
      }
      return
    }
    rightStageUserPinnedRef.current = null
    rightStageStore.hide()
    if (!isChatOverlayDeferActive()) {
      scheduleBumpRef.current?.({ immediate: true })
    }
  }, [
    closeWorkspacePanel,
    closeKnowledgeMapPanel,
    closeCollabExecPanel,
    clearRightStageStream,
    syncShellAsideForWorkspacePanel,
  ])

  useEffect(() => {
    if (!knowledgeMapEnabled && knowledgeMapPanelOpen) {
      closeKnowledgeMapPanel()
    }
  }, [knowledgeMapEnabled, knowledgeMapPanelOpen, closeKnowledgeMapPanel])

  const toggleWorkspacePanel = useCallback(() => {
    const next = !workspacePanelOpenRef.current
    if (next) {
      cancelPendingStreamUiBumpsRef.current()
      setChatOverlayDefer('knowledge-map', false)
      setChatOverlayDefer('workflow', false)
      setChatOverlayDefer('workspace', true)
    } else {
      setChatOverlayDefer('workspace', false)
    }
    flushSync(() => {
      syncShellAsideForWorkspacePanel(next)
      if (next) {
        rightStageUserPinnedRef.current = 'workspace-browse'
        setWorkspacePanelOpen(true)
        setCollabExecPanelOpen(false)
        setKnowledgeMapPanelOpen(false)
        setWorkspaceTreePinned(true)
        // 点文件夹浏览：结束 Agent 写入预览，恢复文件树
        if (!streamingWritePreviewRef.current?.streaming) {
          setFilePreviewModal(null)
          setStreamingWritePreview(null)
          lastStreamWritePathRef.current = null
        }
      } else {
        rightStageUserPinnedRef.current = null
        hideRightStageIfKind('workspace-browse', 'write')
        setStreamingWritePreview(null)
        lastStreamWritePathRef.current = null
        setFilePreviewModal(null)
        setWorkspaceTreePinned(false)
      }
    })
    if (!next && !isChatOverlayDeferActive()) {
      scheduleBumpRef.current?.({ immediate: true })
    }
  }, [syncShellAsideForWorkspacePanel])

  useEffect(() => {
    syncShellAsideForWorkspacePanel(workspacePanelOpen)
  }, [workspacePanelOpen, syncShellAsideForWorkspacePanel])

  useEffect(() => {
    registerPlatformFeedbackOpenHandler((tool, existingEntries) => {
      const opened = openPlatformFeedbackFromTool(tool, existingEntries)
      if (opened) {
        publishPlatformEntriesRef.current(
          opened.entries,
          latestPlatformRunEntryId(opened.entries),
        )
      }
    }, () => turnPlatformEntriesRef.current)
    return () => registerPlatformFeedbackOpenHandler(null, null)
  }, [])

  const userExtensionPanelOpen =
    rightStageOpen && isUserStageExtensionKind(rightStageSurface?.kind)

  /** 子任务工作流 / 思维导图 / 扩展场景展开 → 收起左侧菜单 */
  useEffect(() => {
    if (
      collabExecPanelOpen ||
      (knowledgeMapEnabled && knowledgeMapPanelOpen) ||
      userExtensionPanelOpen
    ) {
      setShellAsideCollapsed(true)
      return
    }
    if (!workspacePanelOpen) {
      setShellAsideCollapsed(false)
    }
  }, [
    collabExecPanelOpen,
    knowledgeMapEnabled,
    knowledgeMapPanelOpen,
    userExtensionPanelOpen,
    workspacePanelOpen,
  ])

  const openWorkspaceFilePreview = useCallback(
    (rawUrl: string, opts?: { poll?: boolean; name?: string }) => {
      const target = resolveWorkspacePreviewTarget(rawUrl, { name: opts?.name })
      if (!target?.path) return
      cancelPendingStreamUiBumpsRef.current()
      setChatOverlayDefer('file-preview', true)
      // Open modal immediately; if cite is a directory, resolve to a primary file then update.
      setFilePreviewModal({
        path: target.path,
        name: target.name,
        poll: !!opts?.poll,
      })
      void (async () => {
        try {
          const scope = workspaceOpenScopeRef.current
          const root = scope.root
          const tid = root
            ? undefined
            : wsClient.getSessionThreadId(scope.sessionKey || '') || undefined
          const openable = await resolveOpenableWorkspaceFile({
            workspaceRoot: root,
            path: target.path,
            name: target.name,
            threadId: tid,
            workspaceScopeOpts: {
              configuredRoot: scope.configuredRoot,
              useVirtualPaths: scope.useVirtualPaths,
            },
          })
          if (!openable?.path || openable.path === target.path) return
          setFilePreviewModal((prev) => {
            if (!prev || prev.path !== target.path) return prev
            return {
              ...prev,
              path: openable.path,
              name: openable.name || prev.name,
            }
          })
        } catch {
          /* keep original path; modal will surface read errors */
        }
      })()
    },
    [],
  )

  const openMessageFilePreview = useCallback(
    (rawUrl: string, name?: string) => {
      const target = resolveWorkspacePreviewTarget(rawUrl, { name })
      if (!target?.path) {
        toast('无法在工作区预览该文件', 'warning')
        return
      }
      openWorkspaceFilePreview(rawUrl, {
        name: target.name,
        poll: false,
      })
    },
    [openWorkspaceFilePreview],
  )
  const openWorkspaceFilePreviewRef = useRef(openWorkspaceFilePreview)
  openWorkspaceFilePreviewRef.current = openWorkspaceFilePreview

  const revealWorkspacePath = useCallback(async (rawPath: string) => {
    const path = String(rawPath || '').trim()
    if (!path) {
      toast('没有可打开的本地路径', 'info')
      return
    }
    try {
      const { api } = await import('../lib/tauri-api.js')
      const scope = workspaceOpenScopeRef.current
      const root = String(scope.root || '').trim()
      const tid = root
        ? undefined
        : wsClient.getSessionThreadId(scope.sessionKey || '') || undefined
      let resolved = path
      // Absolute path: resolveWorkspacePath; else resolve via workspace target
      const looksAbs =
        /^[a-zA-Z]:[\\/]/.test(path) || (path.startsWith('/') && !path.startsWith('//'))
      if (looksAbs) {
        try {
          const info = await api.resolveWorkspacePath(path)
          resolved = String(info?.resolved || path).trim() || path
        } catch {
          resolved = path
        }
      } else {
        const info = await api.resolveWorkspaceTarget(root || undefined, path, tid, {
          configuredRoot: scope.configuredRoot,
          useVirtualPaths: scope.useVirtualPaths,
        })
        resolved = String(info?.resolved || path).trim() || path
        if (info?.exists === false) {
          toast(`文件不存在：${resolved}`, 'error')
          return
        }
      }
      await api.revealPathInFileManager(resolved)
      toast('已在文件管理器中打开', 'success')
    } catch (e) {
      toast(toUserFacingError((e as Error)?.message || e), 'error')
    }
  }, [])
  const revealWorkspacePathRef = useRef(revealWorkspacePath)
  revealWorkspacePathRef.current = revealWorkspacePath

  const openSessionArtifact = useCallback(
    (item: ChatArtifact) => {
      if (item.url && !item.path) {
        try {
          window.open(item.url, '_blank', 'noopener,noreferrer')
        } catch {
          /* ignore */
        }
        return
      }
      if (item.path) {
        openWorkspaceFilePreviewRef.current(item.path, { name: item.name })
      }
    },
    [],
  )

  const revealSessionArtifact = useCallback(
    (item: ChatArtifact) => {
      if (item.url && !item.path) {
        try {
          window.open(item.url, '_blank', 'noopener,noreferrer')
        } catch {
          /* ignore */
        }
        return
      }
      if (item.path) void revealWorkspacePath(item.path)
    },
    [revealWorkspacePath],
  )

  useEffect(() => {
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) {
      setSessionArtifacts([])
      setSessionPlatformEntries([])
      turnPlatformEntriesRef.current = []
      setPlatformFocusEntryId('')
      setTurnArtifacts([])
      setArtifactFocusId('')
      setTurnPlatformEntries([])
      return
    }
    let cancelled = false
    setSessionArtifacts([])
    setSessionPlatformEntries([])
    turnPlatformEntriesRef.current = []
    setPlatformFocusEntryId('')
    setTurnArtifacts([])
    setArtifactFocusId('')
    setTurnPlatformEntries([])
    void evoflowInvokeGatewayJson(`/api/chat/sessions/${encodeURIComponent(sk)}/artifacts`)
      .then((data: { items?: unknown } | null) => {
        if (cancelled) return
        const all = normalizeChatArtifacts(data?.items)
        const platformEntries = platformRunEntriesFromChatArtifacts(all.filter((it) => it.type === 'platform'))
        turnPlatformEntriesRef.current = []
        setTurnPlatformEntries([])
        setSessionPlatformEntries(platformEntries)
        setSessionArtifacts(all.filter((it) => it.type !== 'platform'))
      })
      .catch(() => {
        if (!cancelled) {
          setSessionArtifacts([])
          setSessionPlatformEntries([])
          turnPlatformEntriesRef.current = []
        }
      })
    return () => {
      cancelled = true
    }
  }, [selectedSessionKey])

  const syncWorkspacePreviewFromTools = useCallback((tools: unknown[]) => {
    if (!Array.isArray(tools)) return

    const { shown: platformShown, entries: platformEntries } = syncPlatformFeedbackFromTools(
      tools,
      platformFeedbackSeenRef.current,
      {
        existingEntries: turnPlatformEntriesRef.current,
      },
    )
    if (platformEntries.length) {
      publishPlatformEntriesRef.current(
        platformEntries,
        latestPlatformRunEntryId(platformEntries),
      )
    }
    for (const ui of platformShown) {
      toast(
        ui.title,
        ui.kind === 'warning' ? 'warning' : ui.kind === 'error' ? 'error' : 'success',
      )
    }

    const mode = writeStreamModeRef.current
    const autoPreview = isAutoWorkPreviewEnabled(mode)
    const workspaceWritePanelOpen =
      rightStageStore.getSnapshot().surface?.kind === 'write'
    // 跟踪写入流：设置允许自动预览，或用户已在看写入面板
    const trackWriteStream = autoPreview || workspaceWritePanelOpen
    const writeInFlight = tools.some((t) => isWriteToolInFlight(t))
    const hadStreaming = !!streamingWritePreviewRef.current?.streaming
    const hitAny = detectStreamingWritePreview(tools, { requireReady: false })
    const latestWrite = detectLatestWritePreviewFromTools(tools)
    const pinned = rightStageUserPinnedRef.current
    const currentKind = rightStageStore.currentKind

    const decideOpenWrite = (): boolean => {
      if (!autoPreview || writeStreamDismissedRef.current) return false
      if (pinned && pinned !== 'write') return false
      const decision = applyDecideRightStage(
        {
          intent: 'write',
          kind: 'write',
          runId: rightStageRunIdRef.current,
          userPinned: pinned,
          dismissedKindsThisRun: dismissedRightStageKindsRef.current,
          autoPreviewEnabled: autoPreview,
          currentKind,
        },
        {
          data: {
            streamId: 'write_file',
            path: hitAny?.path || latestWrite?.path || lastStreamWritePathRef.current || '',
            format: inferWriteStreamFormat(
              hitAny?.path || latestWrite?.path || lastStreamWritePathRef.current || '',
            ),
          },
          onHint: (r) => {
            const path = String(hitAny?.path || latestWrite?.path || '').split(/[/\\]/).pop()
            toast(path ? `正在写入 ${path}…` : '正在写入文件…', 'info')
            void r
          },
          scheduleShow: (delayMs, run) => {
            if (rightStageHintTimerRef.current) {
              clearTimeout(rightStageHintTimerRef.current)
            }
            rightStageHintTimerRef.current = window.setTimeout(() => {
              rightStageHintTimerRef.current = 0
              run()
              syncShellAsideForWorkspacePanel(true)
            }, delayMs)
          },
        },
      )
      return decision.action === 'show' || decision.action === 'hint'
    }

    const mayShowWriteStream =
      !writeStreamDismissedRef.current && (!pinned || pinned === 'write')

    const ensureWriteStreamSession = (
      path: string,
      format: 'plain' | 'markdown' | 'code',
      openPanel: boolean,
    ) => {
      if (!trackWriteStream || !path) return
      if (lastStreamWritePathRef.current !== path) {
        lastStreamWritePathRef.current = path
        lastWriteStreamLenRef.current = 0
      }
      openRightStageStream({ streamId: 'write_file', format, path })
      if (openPanel && mayShowWriteStream) {
        // 已由 decide 调度 show；若当前已是 write 则直接确保面板
        if (rightStageStore.currentKind === 'write') {
          openWriteStream({ path, streamId: 'write_file', format, auto: true })
        } else if (decideOpenWrite()) {
          /* hint/show scheduled */
        }
      }
    }

    const appendWriteStreamDelta = (path: string, content: string) => {
      if (!trackWriteStream || !path) return
      const format = inferWriteStreamFormat(path)
      const prevLen = lastWriteStreamLenRef.current
      if (content.length > prevLen) {
        ensureWriteStreamSession(
          path,
          format,
          shouldOpenWriteStreamPanel({
            mode,
            contentLength: content.length,
            prevContentLength: prevLen,
          }),
        )
        appendRightStageStream({
          streamId: 'write_file',
          text: content.slice(prevLen),
        })
        lastWriteStreamLenRef.current = content.length
      } else if (content.length < prevLen) {
        clearRightStageStream('write_file')
        ensureWriteStreamSession(path, format, false)
        appendRightStageStream({ streamId: 'write_file', text: content })
        lastWriteStreamLenRef.current = content.length
      }
    }

    if (!writeInFlight) {
      if (streamingPreviewFlushTimerRef.current) {
        clearTimeout(streamingPreviewFlushTimerRef.current)
        streamingPreviewFlushTimerRef.current = 0
      }
      pendingStreamingPreviewRef.current = null
      const prev = streamingWritePreviewRef.current
      const finalPath = latestWrite?.path ?? hitAny?.path ?? lastStreamWritePathRef.current
      const finalContent = latestWrite?.content ?? hitAny?.content ?? prev?.content ?? ''
      if (
        !hadStreaming &&
        !lastStreamWritePathRef.current &&
        !(trackWriteStream && finalPath && finalContent)
      ) {
        return
      }
      if (prev?.path && isStreamAutoPreviewPath(prev.path) && workspaceWritePanelOpen) {
        setStreamingWritePreview({
          path: prev.path,
          name: prev.name,
          content: prev.content ?? '',
          streaming: false,
        })
      } else if (!workspaceWritePanelOpen) {
        setStreamingWritePreview(null)
      }
      if (trackWriteStream && finalPath && finalContent) {
        appendWriteStreamDelta(finalPath, finalContent)
      }
      if (lastStreamWritePathRef.current) {
        closeRightStageStream('write_file')
      }
      lastStreamWritePathRef.current = null
      lastWriteStreamLenRef.current = 0
      writeStreamDismissedRef.current = false
      return
    }

    // 写入进行中
    if (!hitAny) {
      return
    }

    if (!trackWriteStream) {
      if (shouldSuppressStreamDeliveredFiles(tools, {
        streamingWritePreview: streamingWritePreviewRef.current,
        suppressForSendingWriteTurn: turnBusyForSession(sessionRef.current),
      })) {
        if (streamRef.current.turn.files?.length) {
          streamRef.current.turn.files = []
          scheduleBumpRef.current?.()
        }
      }
      return
    }

    const content = hitAny.content ?? ''
    const path = hitAny.path
    if (path) {
      const format = inferWriteStreamFormat(path)
      if (autoPreview && lastStreamWritePathRef.current !== path) {
        ensureWriteStreamSession(path, format, true)
      }
      appendWriteStreamDelta(path, content)
    }

    if (shouldSuppressStreamDeliveredFiles(tools, {
      streamingWritePreview: streamingWritePreviewRef.current,
      suppressForSendingWriteTurn: turnBusyForSession(sessionRef.current),
    })) {
      if (streamRef.current.turn.files?.length) {
        streamRef.current.turn.files = []
        scheduleBumpRef.current?.()
      }
    }

    if (hitAny.path && lastStreamWritePathRef.current !== hitAny.path) {
      lastStreamWritePathRef.current = hitAny.path
    }
    // 仅侧栏已打开或允许自动预览时才推预览
    if (workspaceWritePanelOpen || autoPreview) {
      queueStreamingWritePreview({
        path: hitAny.path,
        name: hitAny.name,
        content: hitAny.content ?? '',
        streaming: true,
      })
    }
  }, [
    queueStreamingWritePreview,
    openWriteStream,
    openRightStageStream,
    appendRightStageStream,
    clearRightStageStream,
    closeRightStageStream,
    syncShellAsideForWorkspacePanel,
  ])
  const persistContextFiles = useCallback(async (files: ContextFileEntry[], sessionKey?: string) => {
    const sk = (sessionKey || selectedSessionKey || '').trim()
    if (!sk) return
    try {
      const { api } = await import('../lib/tauri-api.js')
      await api.chatUpdateContext(sk, { context_files: files })
    } catch {
      /* ignore */
    }
  }, [selectedSessionKey])

  const toggleContextFile = useCallback(
    (entry: ContextFileEntry) => {
      setContextFiles((prev) => {
        const path = String(entry.path || '').trim()
        if (!path) return prev
        const hit = prev.find((x) => x.path === path)
        const next = hit ? prev.filter((x) => x.path !== path) : [...prev, { path, name: entry.name || path }]
        void persistContextFiles(next)
        return next
      })
    },
    [persistContextFiles],
  )

  const attachContextFiles = useCallback(
    (entries: Array<{ path: string; name?: string }>) => {
      setContextFiles((prev) => {
        const map = new Map(prev.map((f) => [f.path, f]))
        const added: Array<{ path: string; name: string }> = []
        for (const e of entries) {
          const path = String(e.path || '').trim()
          if (!path) continue
          if (!map.has(path)) {
            const name = String(e.name || '').trim() || path.replace(/^.*[/\\]/, '') || path
            map.set(path, { path, name })
            added.push({ path, name })
          }
        }
        const next = [...map.values()]
        if (next.length === prev.length) return prev
        void persistContextFiles(next)
        if (added.length) {
          void import('../components/toast.js').then(({ toast }) => {
            for (const f of added) {
              toast(`已附加：${f.name}（发送后注入 Agent 上下文）`, 'info')
            }
          })
        }
        return next
      })
    },
    [persistContextFiles],
  )
  const attachContextFilesRef = useRef(attachContextFiles)
  attachContextFilesRef.current = attachContextFiles
  const isHomeSurfaceRef = useRef(false)

  const dispatchHomeContextAttach = useCallback((entries: Array<{ path: string; name: string }>) => {
    if (!entries.length) return
    window.dispatchEvent(
      new CustomEvent('evopanel:home-attach-context', { detail: { contextFiles: entries } }),
    )
  }, [])

  const routeContextFileAttach = useCallback(
    (entries: Array<{ path: string; name?: string }>) => {
      const cleaned = entries
        .map((e) => {
          const path = String(e.path || '').trim()
          if (!path) return null
          const name = String(e.name || '').trim() || path.replace(/^.*[/\\]/, '') || path
          return { path, name }
        })
        .filter((x): x is { path: string; name: string } => !!x)
      if (!cleaned.length) return
      if (isHomeSurfaceRef.current) dispatchHomeContextAttach(cleaned)
      else attachContextFilesRef.current(cleaned)
    },
    [dispatchHomeContextAttach],
  )

  const handleConversationComposeDragOver = useCallback((e: ReactDragEvent<HTMLElement>) => {
    composeAttachDragOver(e)
  }, [])

  const handleConversationComposeDrop = useCallback(
    (e: ReactDragEvent<HTMLElement>) => {
      const result = parseComposeDataTransfer(e.dataTransfer, { fromPaste: false })
      if (!result.handled) return
      e.preventDefault()
      e.stopPropagation()
      if (result.contextFiles.length) routeContextFileAttach(result.contextFiles)
    },
    [routeContextFileAttach],
  )

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false
    void import('./lib/compose-attach.js')
      .then(({ subscribeOsFileDrop, basenameFromPath }) =>
        subscribeOsFileDrop((paths) => {
          const entries = paths.map((path) => ({
            path,
            name: basenameFromPath(path),
          }))
          routeContextFileAttach(entries)
        }),
      )
      .then((fn) => {
        if (!fn) return
        if (cancelled) fn()
        else unlisten = fn
      })
      .catch(() => {})
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [routeContextFileAttach])
  /** 子任务对话弹窗：协作执行面板与历史子任务卡片共用 */
  const [subtaskTranscriptModal, setSubtaskTranscriptModal] = useState<SubtaskTranscriptModalPayload | null>(null)
  // 绑定的协作任务 ID（从任务页跳转时设置）
  // 🔧 初始值为 null，完全依赖 useEffect 来设置，避免 StrictMode 双重渲染问题
  const [boundTaskId, setBoundTaskId] = useState<string | null>(null)
  const [hasReceivedTodos, setHasReceivedTodos] = useState(false)
  const [streamTick, bumpStream] = useReducer((x: number) => x + 1, 0)
  const selectedSessionRowForExec = useMemo(() => {
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) return null
    return sessions.find((s) => String(s.sessionKey || '') === sk) ?? null
  }, [selectedSessionKey, sessions])
  const { executing: selectedTurnBusy, goalActive: selectedGoalActive } = useSessionExecutionState(
    selectedSessionKey,
    selectedSessionRowForExec,
  )
  const [memoryRecallRefreshKey, setMemoryRecallRefreshKey] = useState(0)
  const prevTurnBusyForRecallRef = useRef(false)
  useEffect(() => {
    const wasBusy = prevTurnBusyForRecallRef.current
    prevTurnBusyForRecallRef.current = selectedTurnBusy
    if (wasBusy && !selectedTurnBusy) {
      setMemoryRecallRefreshKey((k) => k + 1)
    }
  }, [selectedTurnBusy])
  /** 流式中排队等待发送（仅前端内存；runtime queued follow-ups；切换会话清空） */
  const [pendingSendQueue, setPendingSendQueue] = useState<Array<{ id: string; text: string }>>([])
  const pendingSendQueueRef = useRef(pendingSendQueue)
  pendingSendQueueRef.current = pendingSendQueue
  /**
   * runtime pending_steers：已 ↑/steer 入队、等待下一次 before_model 消费。
   * 只在输入框上方预览，不进 transcript 气泡，直到 consumed ack。
   */
  const [pendingSteers, setPendingSteers] = useState<
    Array<{ id: string; messageId: string; text: string; sessionKey: string }>
  >([])
  const pendingSteersRef = useRef(pendingSteers)
  pendingSteersRef.current = pendingSteers
  /** Esc/立即发送 owns restore+send; stop handler must not also enqueue to pendingSendQueue. */
  const interruptSendSteersRef = useRef(false)
  const pendingDrainBusyRef = useRef(false)
  const prevTurnBusyForDrainRef = useRef(false)
  /** 忙时 ↑ 已入 pending-inject；本轮结束后若尚未被模型消费则 skipAppend 续跑 */
  const midTurnInjectRef = useRef<Array<{ messageId: string; text: string; sessionKey: string }>>([])
  const PENDING_SEND_QUEUE_MAX = 5
  const bumpStreamRef = useRef(bumpStream)
  // Wrap stream-triggered re-renders in startTransition so React treats them as
  // low-priority transition updates. User interactions (clicks, typing, session
  // switching) are high-priority and can interrupt mid-stream re-renders, keeping
  // the UI responsive even when many sessions stream concurrently.
  bumpStreamRef.current = () => startTransition(() => bumpStream())
  const streamBumpMinIntervalRef = useRef(STREAM_BUMP_INTERVAL_MS)
  const STREAM_BG_RUNTIME_NOTIFY_MS = 400
  const STREAM_OVERLAY_DEFER_RUNTIME_NOTIFY_MS = 800
  const STREAM_OVERLAY_DEFER_CHROME_MS = 800
  const bgRuntimeNotifySessionRef = useRef('')
  const streamChromeLastBumpRef = useRef(0)
  const streamChromeBumpTimerRef = useRef(0)
  const streamChromeBumpPendingRef = useRef(false)
  const STREAM_CHROME_BUMP_MS = 450
  const onCoalescedStreamBumpRef = useRef<() => void>(() => {})

  const bumpStreamChromeThrottled = useCallback(() => {
    streamChromeBumpPendingRef.current = true
    const minInterval = isChatOverlayDeferActive()
      ? STREAM_OVERLAY_DEFER_CHROME_MS
      : isStreamThrottleEnabled()
        ? STREAM_CHROME_BUMP_MS
        : STREAM_BUMP_INTERVAL_MS
    const elapsed = Date.now() - streamChromeLastBumpRef.current
    if (elapsed >= minInterval) {
      streamChromeBumpPendingRef.current = false
      streamChromeLastBumpRef.current = Date.now()
      bumpStreamChromeTick()
      return
    }
    if (streamChromeBumpTimerRef.current) return
    streamChromeBumpTimerRef.current = window.setTimeout(() => {
      streamChromeBumpTimerRef.current = 0
      if (!streamChromeBumpPendingRef.current) return
      streamChromeBumpPendingRef.current = false
      streamChromeLastBumpRef.current = Date.now()
      bumpStreamChromeTick()
    }, minInterval - elapsed)
  }, [])

  const onCoalescedStreamBump = useCallback(() => {
    bumpStreamDisplayTick()
    bumpStreamChromeThrottled()
  }, [bumpStreamChromeThrottled])
  onCoalescedStreamBumpRef.current = onCoalescedStreamBump
  const bumpStreamFullRef = useRef(() => {
    bumpStreamRef.current()
  })
  bumpStreamFullRef.current = () => {
    bumpStreamRef.current()
  }

  const streamBumpSchedulerRef = useRef<ReturnType<typeof createStreamBumpScheduler> | null>(null)
  if (
    !streamBumpSchedulerRef.current ||
    typeof streamBumpSchedulerRef.current.cancelPending !== 'function'
  ) {
    streamBumpSchedulerRef.current?.dispose()
    streamBumpSchedulerRef.current = createStreamBumpScheduler(
      () => onCoalescedStreamBumpRef.current(),
      () => streamBumpMinIntervalRef.current,
    )
  }
  const workerFileBumpSchedulerRef = useRef<ReturnType<typeof createStreamBumpScheduler> | null>(null)
  if (
    !workerFileBumpSchedulerRef.current ||
    typeof workerFileBumpSchedulerRef.current.cancelPending !== 'function'
  ) {
    workerFileBumpSchedulerRef.current?.dispose()
    workerFileBumpSchedulerRef.current = createStreamBumpScheduler(
      () => onCoalescedStreamBumpRef.current(),
      () => (isStreamThrottleEnabled() ? 400 : STREAM_BUMP_INTERVAL_MS),
    )
  }
  const reasoningBumpSchedulerRef = useRef<ReturnType<typeof createStreamBumpScheduler> | null>(null)
  if (
    !reasoningBumpSchedulerRef.current ||
    typeof reasoningBumpSchedulerRef.current.cancelPending !== 'function'
  ) {
    reasoningBumpSchedulerRef.current?.dispose()
    reasoningBumpSchedulerRef.current = createStreamBumpScheduler(
      () => onCoalescedStreamBumpRef.current(),
      () => STREAM_REASONING_BUMP_INTERVAL_MS,
    )
  }
  const bgRuntimeNotifySchedulerRef = useRef<ReturnType<typeof createStreamBumpScheduler> | null>(null)
  if (
    !bgRuntimeNotifySchedulerRef.current ||
    typeof bgRuntimeNotifySchedulerRef.current.cancelPending !== 'function'
  ) {
    bgRuntimeNotifySchedulerRef.current?.dispose()
    bgRuntimeNotifySchedulerRef.current = createStreamBumpScheduler(
      () => {
        let sk = String(bgRuntimeNotifySessionRef.current || '').trim()
        if (!sk && !chatSurfaceVisibleRef.current) {
          sk = String(sessionRef.current || '').trim()
        }
        if (sk) bumpSessionRuntimeNotifyForKey(sk)
      },
      () => (isChatOverlayDeferActive() ? STREAM_OVERLAY_DEFER_RUNTIME_NOTIFY_MS : STREAM_BG_RUNTIME_NOTIFY_MS),
    )
  }
  useEffect(() => () => {
    streamBumpSchedulerRef.current?.dispose()
    workerFileBumpSchedulerRef.current?.dispose()
    reasoningBumpSchedulerRef.current?.dispose()
    bgRuntimeNotifySchedulerRef.current?.dispose()
    disposeLiveStreamUiBatch()
    if (streamChromeBumpTimerRef.current) {
      clearTimeout(streamChromeBumpTimerRef.current)
      streamChromeBumpTimerRef.current = 0
    }
  }, [])

  const cancelPendingStreamUiBumps = useCallback(() => {
    streamBumpSchedulerRef.current?.cancelPending?.()
    reasoningBumpSchedulerRef.current?.cancelPending?.()
    workerFileBumpSchedulerRef.current?.cancelPending?.()
    if (streamChromeBumpTimerRef.current) {
      clearTimeout(streamChromeBumpTimerRef.current)
      streamChromeBumpTimerRef.current = 0
    }
    streamChromeBumpPendingRef.current = false
  }, [])
  cancelPendingStreamUiBumpsRef.current = cancelPendingStreamUiBumps

  useEffect(() => {
    const knowledgeMapVisible = knowledgeMapEnabled && knowledgeMapPanelOpen
    const anySidePanelOpen =
      rightStageOpen ||
      workspacePanelOpen ||
      knowledgeMapVisible ||
      collabExecPanelOpen ||
      !!filePreviewModal
    setChatOverlayDefer('workspace', workspacePanelOpen)
    setChatOverlayDefer('knowledge-map', knowledgeMapVisible)
    setChatOverlayDefer('workflow', collabExecPanelOpen)
    setChatOverlayDefer('file-preview', !!filePreviewModal)
    if (anySidePanelOpen) {
      cancelPendingStreamUiBumpsRef.current()
    }
  }, [
    rightStageOpen,
    workspacePanelOpen,
    knowledgeMapEnabled,
    knowledgeMapPanelOpen,
    collabExecPanelOpen,
    filePreviewModal,
  ])

  useEffect(() => {
    const knowledgeMapVisible = knowledgeMapEnabled && knowledgeMapPanelOpen
    const anySidePanelOpen =
      rightStageOpen ||
      workspacePanelOpen ||
      knowledgeMapVisible ||
      collabExecPanelOpen
    if (!anySidePanelOpen) {
      queueMicrotask(() => setSidePanelHeavyMount(false))
      return
    }
    queueMicrotask(() => setSidePanelHeavyMount(false))
    const id = requestAnimationFrame(() => setSidePanelHeavyMount(true))
    return () => cancelAnimationFrame(id)
  }, [
    rightStageOpen,
    workspacePanelOpen,
    knowledgeMapEnabled,
    knowledgeMapPanelOpen,
    collabExecPanelOpen,
  ])

  useEffect(() => {
    if (!isDesktopTauriRuntime()) return
    const warm = () => {
      void import('../lib/tauri-api.js').catch(() => {})
    }
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(warm, { timeout: 8000 })
    } else {
      setTimeout(warm, 3000)
    }
  }, [])

  const reloadHistoryFromDb = useCallback(
    async (opt?: { bypassCache?: boolean; anchorRunId?: string | null; dbOnly?: boolean }) => {
      const sk = String(selectedSessionKey || '').trim()
      const dbOnly = Boolean(opt?.dbOnly)
      if (dbOnly && sk) {
        endLiveStreamSession(sk)
        resetSessionLiveStreamDisplay(sk, streamRef)
        deleteLiveRunSnapshotBestEffort(sk)
        markSessionResumeCatchupReplay(sk, false)
        if (sk === String(sessionRef.current || '').trim()) {
          setThreadPanelState((prev) => clearThreadPanelActivity(prev))
          const cached = threadPanelBySessionRef.current.get(sk)
          if (cached) {
            threadPanelBySessionRef.current.set(sk, clearThreadPanelActivity(cached))
          }
        }
        bumpStreamFullRef.current()
        sfWarn('reloadHistoryFromDb — clearing live stream', { sessionKey: sk, dbOnly })
        srLog('reloadHistoryFromDb cleared live stream + header activity', { sessionKey: sk })
      }
      const result = await reload({ ...opt, dbOnly })
      if (dbOnly && sk && Array.isArray(result?.rows)) {
        const rt = getSessionRuntime(sk)
        const localRows = rt.rows.length ? rt.rows : rowsRef.current
        const lastAsst = [...localRows].reverse().find((r) => r?.role === 'assistant')
        const runId = String(lastAsst?.runId || '').trim() || null
        const mergedRows = mergeDbOnlyHistoryRows(localRows, result.rows, runId, Boolean(opt?.bypassCache))
        sfLog('reloadHistoryFromDb replace rows', {
          sessionKey: sk,
          rowCount: mergedRows.length,
          tail: sfSummarizeRowsTail(mergedRows),
          preservedLocalIncomplete: mergedRows !== result.rows,
        })
        replaceSessionRuntimeRowsFromHistory(sk, mergedRows)
        if (sk === String(selectedSessionKey || '').trim()) {
          // 主动刷新(bypassCache)时绕过等价守卫，强制用 DB 最新数据重渲染
          const forceReplace = Boolean(opt?.bypassCache)
          setRows((prev) => (forceReplace || !displayRowsEquivalent(prev, mergedRows) ? mergedRows : prev))
        }
      }
      return result
    },
    [reload, selectedSessionKey, deleteLiveRunSnapshotBestEffort, setRows],
  )

  const streamingWritePreviewForPane = useMemo(() => {
    const tools = streamRef.current?.turn.tools as unknown[] | undefined
    if (Array.isArray(tools) && tools.length) {
      const live = detectStreamingWritePreview(tools, { requireReady: false })
      if (live) return live
    }
    const streamSession = rightStageStore.getStream('write_file')
    const streamText =
      streamSession?.chunks?.map((chunk) => String(chunk.text || '')).join('') || ''
    if (rightStageSurface?.kind === 'write' && (streamText || streamingWritePreview?.streaming)) {
      const path = String(
        streamSession?.path || rightStageSurface.data?.path || streamingWritePreview?.path || '',
      )
      const baseName = path.replace(/\\/g, '/').split('/').filter(Boolean).pop()
      return {
        path,
        name: streamingWritePreview?.name || baseName || '写入中…',
        content: streamText || streamingWritePreview?.content || '',
        streaming: streamSession ? !streamSession.closed : !!streamingWritePreview?.streaming,
      }
    }
    return streamingWritePreview
  }, [streamTick, streamingWritePreview, rightStageSurface?.kind, rightStageSurface?.data, rightStageSnapshot.rev])

  /** 侧栏宽屏：仅 Agent 写入/预览；点文件夹浏览工作区用窄栏 */
  const workspacePanelWritePreview = useMemo(() => {
    if (rightStageSurface?.kind === 'write') return true
    const p = streamingWritePreviewForPane ?? streamingWritePreview
    return !!(p?.streaming || String(p?.path || '').trim())
  }, [rightStageSurface?.kind, streamingWritePreview, streamingWritePreviewForPane])

  /** 写入预览结束后若仍开着工作区侧栏，切回文件树（避免树被折叠导致空白条） */
  useEffect(() => {
    if (workspacePanelOpen && !workspacePanelWritePreview) {
      queueMicrotask(() => setWorkspaceTreePinned(true))
    }
  }, [workspacePanelOpen, workspacePanelWritePreview])

  const mainBodyRef = useRef<HTMLDivElement>(null)
  const conversationColRef = useRef<HTMLDivElement>(null)
  const bottomAreaRef = useRef<HTMLDivElement>(null)
  const bottomAreaNaturalHeightRef = useRef(160)
  const bottomAreaLiveHeightRef = useRef<number | null>(null)
  const layoutSizesRef = useRef({
    rightPanelWidthPx: loadChatLayoutPrefs().rightPanelWidthPx,
    bottomDockHeightPx: loadChatLayoutPrefs().bottomDockHeightPx,
  })
  const [layoutResizeEnabled, setLayoutResizeEnabled] = useState(
    () => typeof window === 'undefined' || !window.matchMedia('(max-width: 768px)').matches,
  )
  /** 窄屏微信式：list=会话列表全屏，thread=对话内容（桌面忽略） */
  const [isMobileChat, setIsMobileChat] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches,
  )
  const [mobileChatPane, setMobileChatPane] = useState<'list' | 'thread'>(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches ? 'list' : 'thread',
  )
  const [rightPanelWidthPx, setRightPanelWidthPx] = useState<number | null>(
    () => loadChatLayoutPrefs().rightPanelWidthPx,
  )
  const [bottomDockHeightPx, setBottomDockHeightPx] = useState<number | null>(
    () => loadChatLayoutPrefs().bottomDockHeightPx,
  )

  useLayoutEffect(() => {
    const stored = layoutSizesRef.current.bottomDockHeightPx
    if (stored == null) return
    const colH = conversationColRef.current?.clientHeight || 0
    if (!colH) return
    // 历史过大高度：钳制到主列可容纳范围，避免盖住消息区
    const clamped = clampBottomDockHeight(stored, window.innerHeight, colH)
    if (clamped !== stored) {
      setBottomDockHeightPx(clamped)
      layoutSizesRef.current.bottomDockHeightPx = clamped
      saveChatLayoutPrefs(layoutSizesRef.current)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(max-width: 768px)')
    const onChange = () => {
      const mobile = mq.matches
      setLayoutResizeEnabled(!mobile)
      setIsMobileChat(mobile)
      if (!mobile) setMobileChatPane('thread')
      else setMobileChatPane((prev) => prev || 'list')
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const app = document.getElementById('app')
    const aside = document.getElementById('app-shell-aside')
    const apply = () => {
      const path = (window.location.hash.slice(1) || '/chat').split('?')[0]
      const chat = path === '/chat' || path === '/chat-react'
      const list = isMobileChat && mobileChatPane === 'list' && chat
      const thread = isMobileChat && mobileChatPane === 'thread' && chat
      app?.classList.toggle('evopanel-mobile-chat-list', list)
      app?.classList.toggle('evopanel-mobile-chat-thread', thread)
      if (list) {
        aside?.classList.add('shell-aside-open')
        document.getElementById('shell-aside-overlay')?.classList.remove('visible')
        const title = aside?.querySelector('.react-chat-aside-toolbar-title') as HTMLElement | null
        if (title && !title.dataset.desktopTitle) {
          title.dataset.desktopTitle = title.textContent || 'EvoFlow'
          title.textContent = '对话'
        }
      } else {
        if (isMobileChat) aside?.classList.remove('shell-aside-open')
        const title = aside?.querySelector('.react-chat-aside-toolbar-title') as HTMLElement | null
        if (title?.dataset.desktopTitle) {
          title.textContent = title.dataset.desktopTitle
          delete title.dataset.desktopTitle
        }
      }
    }
    apply()
    window.addEventListener('hashchange', apply)
    return () => {
      window.removeEventListener('hashchange', apply)
      app?.classList.remove('evopanel-mobile-chat-list')
      app?.classList.remove('evopanel-mobile-chat-thread')
      const title = document.querySelector(
        '#app-shell-aside .react-chat-aside-toolbar-title',
      ) as HTMLElement | null
      if (title?.dataset.desktopTitle) {
        title.textContent = title.dataset.desktopTitle
        delete title.dataset.desktopTitle
      }
    }
  }, [isMobileChat, mobileChatPane])

  const anyRightPanelOpen = rightStageOpen

  const rightPanelLayoutKind = rightStageLayoutKind
  const lastRightPanelLayoutKindRef = useRef<typeof rightPanelLayoutKind | null>(null)

  useLayoutEffect(() => {
    if (!anyRightPanelOpen || !layoutResizeEnabled) return
    const el = mainBodyRef.current
    if (!el) return
    const def = defaultRightPanelWidth(el.clientWidth, rightPanelLayoutKind)
    const prevKind = lastRightPanelLayoutKindRef.current
    const firstOpen = prevKind == null
    const kindChanged = !firstOpen && prevKind !== rightPanelLayoutKind
    lastRightPanelLayoutKindRef.current = rightPanelLayoutKind
    setRightPanelWidthPx((prev) => {
      if (prev == null || kindChanged) {
        layoutSizesRef.current.rightPanelWidthPx = def
        return def
      }
      // 首次打开：文件树勿继承工作流/半屏留下的过宽偏好
      if (firstOpen) {
        const isBrowse =
          rightPanelLayoutKind === 'workspace-browse' || rightPanelLayoutKind === 'narrow'
        if (isBrowse && (prev < 220 || prev > 340)) {
          layoutSizesRef.current.rightPanelWidthPx = def
          return def
        }
      }
      return prev
    })
  }, [anyRightPanelOpen, rightPanelLayoutKind, layoutResizeEnabled])

  useEffect(() => {
    layoutSizesRef.current = { rightPanelWidthPx, bottomDockHeightPx }
  }, [rightPanelWidthPx, bottomDockHeightPx])

  const persistLayoutSizes = useCallback(() => {
    saveChatLayoutPrefs(layoutSizesRef.current)
  }, [])

  const onRightPanelDragDelta = useCallback(
    (delta: number) => {
      const el = mainBodyRef.current
      if (!el) return
      setRightPanelWidthPx((prev) => {
        const current = prev ?? defaultRightPanelWidth(el.clientWidth, rightPanelLayoutKind)
        const next = clampRightPanelWidth(current - delta, el.clientWidth)
        layoutSizesRef.current.rightPanelWidthPx = next
        return next
      })
    },
    [rightPanelLayoutKind],
  )

  const onBottomDockDragDelta = useCallback((delta: number) => {
    const natural = bottomAreaNaturalHeightRef.current
    const current = bottomAreaLiveHeightRef.current ?? natural
    const colH = conversationColRef.current?.clientHeight || window.innerHeight
    const next = applyBottomAreaHeightDelta(
      current,
      delta,
      natural,
      window.innerHeight,
      colH,
    )
    bottomAreaLiveHeightRef.current = next
    layoutSizesRef.current.bottomDockHeightPx = next
    setBottomDockHeightPx(next)
  }, [])

  const handleBottomDockResizePointerEnd = useCallback(() => {
    bottomAreaLiveHeightRef.current = layoutSizesRef.current.bottomDockHeightPx
    persistLayoutSizes()
  }, [persistLayoutSizes])

  const {
    onPointerDown: onRightPanelResizePointerDown,
    dragging: rightPanelResizeDragging,
  } = useDragResize({
    axis: 'x',
    enabled: anyRightPanelOpen && layoutResizeEnabled,
    onDragDelta: onRightPanelDragDelta,
    onDragEnd: persistLayoutSizes,
  })

  const {
    onPointerDown: onBottomDockResizePointerDown,
    dragging: bottomDockResizeDragging,
  } = useDragResize({
    axis: 'y',
    enabled: layoutResizeEnabled,
    onDragDelta: onBottomDockDragDelta,
    onDragEnd: handleBottomDockResizePointerEnd,
  })

  const handleBottomDockResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const el = bottomAreaRef.current
      if (el) {
        bottomAreaNaturalHeightRef.current = measureBottomAreaNaturalHeight(el)
        const rect = Math.ceil(el.getBoundingClientRect().height)
        bottomAreaLiveHeightRef.current = bottomDockHeightPx ?? rect
      }
      onBottomDockResizePointerDown(e)
    },
    [bottomDockHeightPx, onBottomDockResizePointerDown],
  )

  const mainBodyLayoutStyle = useMemo(() => {
    if (!anyRightPanelOpen || !layoutResizeEnabled || rightPanelWidthPx == null) return undefined
    return { ['--chat-right-panel-width' as string]: `${rightPanelWidthPx}px` }
  }, [anyRightPanelOpen, layoutResizeEnabled, rightPanelWidthPx])

  const bottomAreaLayoutStyle = useMemo(() => {
    if (!layoutResizeEnabled || bottomDockHeightPx == null) return undefined
    return {
      height: bottomDockHeightPx,
      minHeight: bottomDockHeightPx,
      maxHeight: bottomDockHeightPx,
      boxSizing: 'border-box',
      overflow: 'auto',
      flexShrink: 0,
    } as const
  }, [layoutResizeEnabled, bottomDockHeightPx])

  /** 打开工作区面板时，按需拉该会话 workspace-history（仅首次进缓存） */
  useEffect(() => {
    const sk = String(selectedSessionKey || '').trim()
    if (!workspacePanelOpen || !sk) return
    let cancelled = false
    void (async () => {
      try {
        await wsClient.ensureSessionWorkspaceHistory(sk)
        if (cancelled) return
        setWorkspaceHistory(wsClient.getWorkspaceHistory(sk))
        setGlobalWorkspaceHistory(wsClient.getGlobalWorkspaceHistory())
      } catch {
        /* ignore */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workspacePanelOpen, selectedSessionKey])

  /** 本轮发送预期 runId（由 api.chatSend 返回），用于在绑定前丢弃旧 run 的回执/空 final。按 sessionKey 隔离，支持多会话并发发送。 */
  const expectedChatRunIdBySessionRef = useRef<Record<string, string>>({})
  const getExpectedChatRunId = useCallback(
    (sk: string) => expectedChatRunIdBySessionRef.current[String(sk || '').trim()] || null,
    [],
  )
  const setExpectedChatRunId = useCallback((sk: string, rid: string | null) => {
    const key = String(sk || '').trim()
    if (!key) return
    if (rid) expectedChatRunIdBySessionRef.current[key] = String(rid)
    else delete expectedChatRunIdBySessionRef.current[key]
  }, [])
  const suppressNextAbortToastRef = useRef(false)
  /** 仅侧栏/Composer「停止」为 true；刷新断线触发的 aborted 不应清空协作面板 */
  const userInitiatedStopRef = useRef(false)
  /** 供挂载早期 effect 调用：从其它路由进 /chat 时 `shell-new-session` 可能早于 ChatApp 挂载 */
  const handleNewSessionRef = useRef<(() => void) | null>(null)
  const handleOpenHomeRef = useRef<(() => void) | null>(null)
  const handleNewSessionInWorkspaceRef = useRef<((workspacePath: string | null) => void) | null>(null)
  const handleNewWorkspaceRef = useRef<(() => void) | null>(null)
  const handleDeleteSessionRef = useRef<((key?: string) => Promise<void>) | null>(null)
  const deleteSessionConfirmInflightRef = useRef(false)
  const stopSessionExecutionRef = useRef<((sessionKey: string, opts?: { showToast?: boolean }) => Promise<void>) | null>(null)
  const sessionStopHostRef = useRef<SessionStopHost>({
    isForegroundSession: () => false,
    onForegroundStopComplete: () => {},
  })
  const reloadRef = useRef<
    ((opts?: {
      bypassCache?: boolean
      anchorRunId?: string | null
      dbOnly?: boolean
    }) => Promise<{ rows?: DisplayRow[]; transcriptAnchor?: unknown } | void>) | null
  >(null)
  const boundTaskIdRef = useRef<string | null>(null)
  /** 协作主任务状态：用于系统通知去重（taskId → 上次 status） */
  const collabTaskStatusNotifyRef = useRef(new Map<string, string>())
  const threadBoundTaskIdRef = useRef<string | null>(null)
  const ensureChatSessionKeyRef = useRef<(() => Promise<string | null>) | null>(null)
  /** 切换会话递增；异步 task 拉取前后校验，避免上一会话 in-flight 请求仍打到 API */
  const sessionTasksFetchSeqRef = useRef(0)
  /** 当前会话在列表/API 上的 bound task（无则普通对话，不展示协作/工作流） */
  const sessionBoundTaskIdRef = useRef('')
  const isActiveSessionFetch = (sessionKey: string, fetchSeq: number) =>
    sessionTasksFetchSeqRef.current === fetchSeq &&
    String(sessionRef.current || '').trim() === String(sessionKey || '').trim()
  const lastErrorRef = useRef({ msg: '', ts: 0 })
  const unsubRef = useRef<(() => void) | null>(null)
  const [pendingRefreshKey, setPendingRefreshKey] = useState<string | null>(null)
  const lastActivityRef = useRef<Record<string, number>>({})  // 记录每个会话的最后活跃时间
  // thread_state.artifacts is cumulative per thread; track already-consumed artifacts per session
  // to avoid re-injecting previous-round files into later rounds.
  const seenArtifactsRef = useRef<Map<string, Set<string>>>(new Map())
  /** 已从确认条应用/关闭的 propose_goal，避免 history 同步把同一方案反复写回 goalProposal */
  const suppressedGoalProposalKeysRef = useRef<Set<string>>(new Set())
  const suppressedPlanExecDockKeysRef = useRef<Set<string>>(new Set())
  /** 用户已主动点「开始执行」授权过的 taskId 集合；防止后端竞态返回 planned+未授权时误清 suppress。 */
  const userAuthorizedTaskIdsRef = useRef<Set<string>>(new Set())
  const planExecStartInFlightRef = useRef(false)
  /** Bump to re-run plan exec dock memo after suppressing (ref alone does not re-render). */
  const [, setPlanExecSuppressVersion] = useState(0)
  const [planExecStarting, setPlanExecStarting] = useState(false)

  const planExecSuppressToken = useCallback((taskId: string) => {
    return String(taskId || '').trim() || 'plan-pending'
  }, [])

  const isPlanExecDockSuppressed = useCallback(
    (taskId: string, subCount: number) => {
      const tid = planExecSuppressToken(taskId)
      const key = `${tid}:${subCount}`
      const set = suppressedPlanExecDockKeysRef.current
      if (set.has(tid) || set.has(key)) return true
      for (const k of set) {
        if (k.startsWith(`${tid}:`)) return true
      }
      return false
    },
    [planExecSuppressToken],
  )

  const suppressPlanExecDock = useCallback(
    (taskId: string) => {
      suppressedPlanExecDockKeysRef.current.add(planExecSuppressToken(taskId))
      setPlanExecSuppressVersion((v) => v + 1)
    },
    [planExecSuppressToken],
  )
  /** 任务规划场景下每会话自动开启 Plan 协作一次 */
  const applyPlanToolSuccessRef = useRef<
    (hit: { taskId?: string; preview?: string; status?: string; planInput?: Record<string, unknown> }) => void
  >(
    () => {},
  )
  /** TitleMiddleware 自动标题：流式进行中延迟写入，且必须绑定 sessionKey（避免新建对话后标题写到错会话） */
  const pendingAutoSessionTitleRef = useRef<{ sessionKey: string; title: string } | null>(null)
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogEntry[]>([])
  const [contextUsageBySession, setContextUsageBySession] = useState<
    Record<string, ContextUsageSnapshot>
  >({})
  const [manualContextCompacting, setManualContextCompacting] = useState(false)

  const hydrateContextUsageFromSessions = useCallback((rows: ChatSessionRow[]) => {
    if (!Array.isArray(rows) || rows.length === 0) return
    setContextUsageBySession((prev) => {
      let changed = false
      const next = { ...prev }
      for (const row of rows) {
        const sk = String(row.sessionKey || '').trim()
        if (!sk) continue
        const snap = parseContextUsageFromSessionContext(row.context)
        if (!snap) continue
        const merged = mergeContextUsageSnapshots(prev[sk], snap)
        if (merged !== prev[sk]) {
          next[sk] = merged
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [])

  hydrateContextUsageFromSessionsRef.current = hydrateContextUsageFromSessions

  useEffect(() => {
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) return
    const row = sessions.find((s) => String(s.sessionKey || '').trim() === sk)
    const snap = parseContextUsageFromSessionContext(row?.context)
    if (!snap) return
    queueMicrotask(() => {
      setContextUsageBySession((prev) => {
        const merged = mergeContextUsageSnapshots(prev[sk], snap)
        if (merged === prev[sk]) return prev
        return { ...prev, [sk]: merged }
      })
    })
  }, [selectedSessionKey, sessions])
  /** config.yaml primary_model（与后端 _resolve_model_name 回落一致） */
  const [primaryModelName, setPrimaryModelName] = useState<string>('')
  const [modelName, setModelName] = useState<string>('')
  setModelNameRef.current = setModelName
  /** 用于模型↔会话同步：区分「切换会话」与「同会话内改药丸」，避免把上一会话的 modelName 写进新会话 context */
  const syncModelSessionPrevKeyRef = useRef<string | null>(null)
  /** 刷新后按 key 拉会话详情以恢复 model_name；每会话最多尝试一次，避免空模型新会话死循环 */
  const modelHydrateAttemptedRef = useRef<string | null>(null)
  const modelHydrateInflightRef = useRef<string | null>(null)
  /** hydrate 完成后递增，驱动模型同步 effect 再跑一遍 */
  const [modelHydrateTick, setModelHydrateTick] = useState(0)
  const modelsLoadInflightRef = useRef<Promise<void> | null>(null)
  const modelCatalogLoadedRef = useRef(false)
  const modelNameRef = useRef(modelName)
  modelNameRef.current = modelName
  const [modelsLoading, setModelsLoading] = useState(false)
  const [agents, setAgents] = useState<AgentPickerRow[]>([])
  const [bottomModelOpen, setBottomModelOpen] = useState(false)
  const [bottomPermissionOpen, setBottomPermissionOpen] = useState(false)
  /** 连接 key → 自定义展示名映射（来自 /model-connections + localStorage），用于级联菜单区分同厂商多套连接 */
  const [modelConnNameMap, setModelConnNameMap] = useState<Record<string, string>>({})
  const [bottomMoreOpen, setBottomMoreOpen] = useState(false)
  /** 右侧信息 Drawer：默认关闭；与 Right Stage 互斥 */
  const [infoRailOpen, setInfoRailOpen] = useState(true)
  const [infoRailTab, setInfoRailTab] = useState<InfoRailTab>('agent')
  const publishPlatformEntries = useCallback((entries: PlatformRunEntry[], focusEntryId?: string) => {
    turnPlatformEntriesRef.current = entries
    setTurnPlatformEntries([...entries])
    setSessionPlatformEntries((prev) => {
      const map = new Map<string, PlatformRunEntry>()
      for (const row of prev) map.set(row.id, row)
      for (const row of entries) map.set(row.id, row)
      return Array.from(map.values()).sort((a, b) => b.appliedAt - a.appliedAt)
    })
    if (!entries.length) return
    if (rightStageHintTimerRef.current) {
      clearTimeout(rightStageHintTimerRef.current)
      rightStageHintTimerRef.current = 0
    }
    rightStageStore.hide()
    setInfoRailOpen(true)
    setInfoRailTab('platform')
    const focus = String(focusEntryId || latestPlatformRunEntryId(entries)).trim()
    if (focus) setPlatformFocusEntryId(focus)
  }, [])
  const publishArtifacts = useCallback(
    (opts?: { focusId?: string; hint?: string; force?: boolean }) => {
      const items = turnRunArtifactsRef.current
      if (!items.length) return
      setTurnArtifacts([...items])
      const autoPreview = isAutoWorkPreviewEnabled(writeStreamModeRef.current)
      if (!autoPreview && !opts?.force) return
      if (rightStageHintTimerRef.current) {
        clearTimeout(rightStageHintTimerRef.current)
        rightStageHintTimerRef.current = 0
      }
      hideRightStageIfKind('artifacts')
      setInfoRailOpen(true)
      setInfoRailTab('artifacts')
      const focus = String(opts?.focusId || items[items.length - 1]?.id || '').trim()
      if (focus) setArtifactFocusId(focus)
      if (opts?.hint) toast(opts.hint, 'info')
    },
    [],
  )
  useEffect(() => {
    publishPlatformEntriesRef.current = publishPlatformEntries
  }, [publishPlatformEntries])
  useEffect(() => {
    publishArtifactsRef.current = publishArtifacts
  }, [publishArtifacts])
  /** 当前会话累计产物（DB + panel_set artifacts 直播） */
  const [sessionArtifacts, setSessionArtifacts] = useState<ChatArtifact[]>([])
  useEffect(() => {
    setSessionArtifactsRef.current = setSessionArtifacts
  })
  /** 更多下拉内展开的子菜单 key */
  const [moreSubOpen, setMoreSubOpen] = useState<'mode' | 'employee' | 'memory' | 'creative' | 'thinking' | null>(null)
  const [bottomWorkspaceOpen, setBottomWorkspaceOpen] = useState(false)
  const [useVirtualPaths] = useState<boolean>(() => getUseVirtualPaths())
  const [workspaceIndexWatchEnabled, setWorkspaceIndexWatchEnabledState] = useState<boolean>(() =>
    getWorkspaceIndexWatchEnabled(),
  )
  const [localWorkspaceRoot, setLocalWorkspaceRoot] = useState<string>('')
  const localWorkspaceRootRef = useRef('')
  const pendingNewSessionWorkspaceRef = useRef<{ sessionKey: string; path: string } | null>(null)
  /** 侧栏当前点选的工作空间；全局「新对话」优先用此目录 */
  const shellIntentWorkspaceRef = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    localWorkspaceRootRef.current = localWorkspaceRoot
  }, [localWorkspaceRoot])
  const [configuredWorkspaceRoot, setConfiguredWorkspaceRoot] = useState<string>('')
  /** 当前 EVOFLOW_HOME（默认 ~/.evoflow）；未绑项目目录时产出落此地 */
  const [runtimeDataDir, setRuntimeDataDir] = useState<string>('')
  const [, setWorkspaceHistory] = useState<string[]>([])
  const [globalWorkspaceHistory, setGlobalWorkspaceHistory] = useState<string[]>([])

  const effectiveWorkspaceRoot = useMemo(
    () => effectiveLocalWorkspaceRoot(localWorkspaceRoot, configuredWorkspaceRoot, useVirtualPaths),
    [localWorkspaceRoot, configuredWorkspaceRoot, useVirtualPaths],
  )

  useEffect(() => {
    const sync = () => setWorkspaceIndexWatchEnabledState(getWorkspaceIndexWatchEnabled())
    window.addEventListener('evopanel:panel-settings-loaded', sync)
    window.addEventListener('evopanel:panel-settings-changed', sync)
    return () => {
      window.removeEventListener('evopanel:panel-settings-loaded', sync)
      window.removeEventListener('evopanel:panel-settings-changed', sync)
    }
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const { api } = await import('../lib/tauri-api.js')
        const { getPanelSettingsSync } = await import('../lib/panel-settings.js')
        const info = await api.workspaceRuntimeInfo()
        const dataDir = String(info?.runtimeDataDir || '').trim()
        if (dataDir) setRuntimeDataDir(dataDir)
        // 项目默认目录：只用 panel.defaultProjectWorkspaceRoot，不用 userWorkspaceRoot（应用数据根）
        const projectRoot = String(getPanelSettingsSync()?.defaultProjectWorkspaceRoot || '').trim()
        if (projectRoot) setConfiguredWorkspaceRoot(projectRoot)
      } catch {
        /* ignore */
      }
    })()
  }, [])

  useEffect(() => {
    const syncProjectRoot = () => {
      void import('../lib/panel-settings.js').then(({ getPanelSettingsSync }) => {
        const projectRoot = String(getPanelSettingsSync()?.defaultProjectWorkspaceRoot || '').trim()
        setConfiguredWorkspaceRoot(projectRoot)
      })
    }
    window.addEventListener('evopanel:panel-settings-loaded', syncProjectRoot)
    window.addEventListener('evopanel:panel-settings-changed', syncProjectRoot)
    return () => {
      window.removeEventListener('evopanel:panel-settings-loaded', syncProjectRoot)
      window.removeEventListener('evopanel:panel-settings-changed', syncProjectRoot)
    }
  }, [])

  useEffect(() => {
    setChatWorkspaceRoot(effectiveWorkspaceRoot)
  }, [effectiveWorkspaceRoot])

  useEffect(() => {
    workspaceOpenScopeRef.current = {
      root: effectiveWorkspaceRoot,
      configuredRoot: configuredWorkspaceRoot,
      useVirtualPaths,
      sessionKey: selectedSessionKey || '',
    }
  }, [effectiveWorkspaceRoot, configuredWorkspaceRoot, useVirtualPaths, selectedSessionKey])

  const searchWorkspaceFilesForMention = useCallback(
    async (query: string) => {
      const root = effectiveWorkspaceRoot
      const threadId = String(wsClient.getSessionThreadId(selectedSessionKey || '') || '').trim()
      if (!root && !threadId) return []
      const q = String(query || '').trim()
      if (!q) return []
      try {
        const { api } = await import('../lib/tauri-api.js')
        const data = await api.searchWorkspaceFiles(root, q, 15, threadId || undefined)
        return (Array.isArray(data?.files) ? data.files : [])
          .map((f: { path?: string; name?: string }) => {
            const path = String(f?.path || '').trim()
            if (!path) return null
            return {
              path,
              name: String(f?.name || basenameFromPath(path)),
              detail: '文件',
            }
          })
          .filter((x: { path: string; name: string; detail: string } | null): x is { path: string; name: string; detail: string } => x != null)
      } catch {
        return []
      }
    },
    [effectiveWorkspaceRoot, selectedSessionKey],
  )

  /** 智能体员工列表（active），供 @员工 派发与输入框岗位按钮 / 侧栏员工下拉使用 */
  const [proactiveRoles, setProactiveRoles] = useState<MentionEmployeeOption[]>([])
  const loadProactiveRoles = useCallback(async () => {
    try {
      const { api, isGatewayWarming, waitForBackendReady } = await import('../lib/tauri-api.js')
      if (typeof isGatewayWarming === 'function' && isGatewayWarming()) {
        await waitForBackendReady?.(90_000).catch(() => {})
      }
      const res = await api.proactiveListRoles('active')
      // 兼容 { roles: [] } 与偶发裸数组
      const raw = Array.isArray(res)
        ? res
        : Array.isArray(res?.roles)
          ? res.roles
          : []
      const roles = raw
        .map((r: any) => ({
          agent_code: String(r.agent_code || '').trim(),
          // 岗位名保持 API 原样（库里已有「代码助手」「产品经理」等）
          role_name: String(r.role_name || '').trim(),
          agent_name: String(r.agent_name || '').trim(),
          department: String(r.department || ''),
          status: String(r.status || 'active'),
        }))
        .filter((r: MentionEmployeeOption) => r.agent_code)
      setProactiveRoles(roles)
    } catch {
      /* proactive 未启用 / 网关未就绪时静默；后端就绪后再拉 */
    }
  }, [])

  useEffect(() => {
    void loadProactiveRoles()
  }, [loadProactiveRoles])

  // 启动时若第一次失败，后端就绪后补拉，避免侧栏员工下拉一直「未命名岗位」
  useEffect(() => {
    let cancelled = false
    let unsub: (() => void) | undefined
    void import('../lib/tauri-api.js').then((mod) => {
      if (cancelled) return
      if (typeof mod.onBackendReadyChange === 'function') {
        unsub = mod.onBackendReadyChange((ready: boolean) => {
          if (ready) void loadProactiveRoles()
        })
      }
      try {
        if (mod.isBackendReady?.() === true) void loadProactiveRoles()
      } catch {
        /* ignore */
      }
    })
    return () => {
      cancelled = true
      try {
        unsub?.()
      } catch {
        /* ignore */
      }
    }
  }, [loadProactiveRoles])

  /** 把岗位名替换为智能体名（agent_name），让菜单/派发提示显示智能体本身的名字。 */
  const proactiveRolesDisplay = useMemo<MentionEmployeeOption[]>(() => {
    if (!proactiveRoles.length) return proactiveRoles
    return proactiveRoles.map((r) => {
      const code = String(r.agent_code || '').trim()
      const fromAgents = resolveAssignedAgentDisplayName(code, agents)
      const agentName =
        fromAgents && fromAgents !== code ? fromAgents : String(r.agent_name || '').trim()
      if (!agentName) return r
      // role_name 同步为智能体名，供 @员工 菜单沿用；另保留 agent_name 字段供侧栏专用
      return {
        ...r,
        agent_name: agentName,
        role_name: agentName !== r.role_name ? agentName : r.role_name,
      }
    })
  }, [proactiveRoles, agents])

  const workspaceMention = useMemo((): WorkspaceMentionConfig | undefined => {
    const root = effectiveWorkspaceRoot
    const threadId = String(wsClient.getSessionThreadId(selectedSessionKey || '') || '').trim()
    if (!root && !threadId) return undefined
    return {
      enabled: true,
      searchFiles: searchWorkspaceFilesForMention,
      onAttachFile: (entry) => {
        const path = String(entry.path || '').trim()
        if (!path) return
        setContextFiles((prev) => {
          if (prev.some((x) => x.path === path)) return prev
          const next = [...prev, { path, name: entry.name || basenameFromPath(path) }]
          void persistContextFiles(next)
          return next
        })
        void import('../components/toast.js').then(({ toast }) => {
          toast(`已附加：${entry.name || basenameFromPath(path)}（发送后注入 Agent 上下文）`, 'info')
        })
      },
      roles: proactiveRolesDisplay,
    }
  }, [
    effectiveWorkspaceRoot,
    persistContextFiles,
    searchWorkspaceFilesForMention,
    selectedSessionKey,
    useVirtualPaths,
    proactiveRolesDisplay,
  ])
  const [bottomRoleOpen, setBottomRoleOpen] = useState(false)

  /** @员工名 任务 -> 派发给智能体员工，并跳转到该员工工作轨迹 */
  const handleDispatchEmployee = useCallback(async (agentCode: string, goal: string) => {
    const { api } = await import('../lib/tauri-api.js')
    const { toast } = await import('../components/toast.js')
    const role = proactiveRolesDisplay.find((r) => r.agent_code === agentCode)
    const name = role?.role_name || agentCode
    const watchHash = `#/proactive/${encodeURIComponent(agentCode)}?live=1&goal=${encodeURIComponent(goal.slice(0, 120))}`
    const goWatch = () => {
      try {
        window.location.hash = watchHash
      } catch {
        /* ignore */
      }
    }
    try {
      await api.proactiveDispatchTask(agentCode, { goal, source: 'chat_mention' })

      // Insert a dispatch record + fixed reply into the chat flow so the user
      // sees what happened (instead of the message "disappearing" into a toast).
      const sk = String(sessionRef.current || selectedSessionKey || '').trim()
      if (sk) {
        const now = Date.now()
        const next = updateSessionRuntimeRows(sk, (r: DisplayRow[]) => [
          ...r,
          {
            role: 'system' as const,
            text: `📋 已派发给「${name}」：${goal}`,
            timestamp: now,
          },
          {
            role: 'assistant' as const,
            text: `已派发给「${name}」，正在后台处理。\n\n已打开该员工工作页与工作轨迹，可直接查看进度与工作汇报。`,
            timestamp: now + 1,
          },
        ])
        if (next) {
          setRows([...next])
          rowsRef.current = next
        }
      }

      toast(`已派发给「${name}」，正在打开工作轨迹`, 'success')
      goWatch()
    } catch (e: any) {
      const msg = String(e?.message || e || '')
      if (/already running|正在巡检|正在工作|busy|执行任务/i.test(msg)) {
        toast(msg || `「${name}」正在执行任务，已打开工作轨迹`, 'warning')
        const sk = String(sessionRef.current || selectedSessionKey || '').trim()
        if (sk) {
          const now = Date.now()
          const next = updateSessionRuntimeRows(sk, (r: DisplayRow[]) => [
            ...r,
            {
              role: 'system' as const,
              text: `⚠️ 「${name}」正忙，派发未受理：${goal}`,
              timestamp: now,
            },
            {
              role: 'assistant' as const,
              text: `「${name}」当前有任务在执行，无法同时接新派发。\n\n已打开其工作轨迹，请等本轮结束后再派发。`,
              timestamp: now + 1,
            },
          ])
          if (next) {
            setRows([...next])
            rowsRef.current = next
          }
        }
        goWatch()
      } else {
        toast(`派发失败：${msg}`, 'error')
      }
    }
  }, [proactiveRolesDisplay, selectedSessionKey, setRows])
  /** 技能选择 pill（多选弹窗） */
  const [bottomSkillOpen, setBottomSkillOpen] = useState(false)
  const [shareSessionOpen, setShareSessionOpen] = useState(false)
  const [skillList, setSkillList] = useState<Array<{ name: string; label: string; description: string; icon: string; enabled?: boolean }>>([])
  const [skillListLoading, setSkillListLoading] = useState(false)
  const [selectedSkills, setSelectedSkills] = useState<SkillSelection[]>([])

  const persistSelectedSkills = useCallback(async (sk: string, skills: SkillSelection[]) => {
    const key = String(sk || '').trim()
    if (!key) return
    const names = skills.map((s) => String(s.name || '').trim()).filter(Boolean)
    try {
      const { api } = await import('../lib/tauri-api.js')
      await api.chatUpdateContext(key, { preferred_skills: names })
    } catch {
      /* best-effort session sticky */
    }
  }, [])

  const removeSelectedSkill = useCallback(
    (name: string) => {
      setSelectedSkills((prev) => {
        const next = prev.filter((s) => s.name !== name)
        void persistSelectedSkills(String(selectedSessionKey || ''), next)
        return next
      })
    },
    [persistSelectedSkills, selectedSessionKey],
  )
  const [roleSwitchBusy, setRoleSwitchBusy] = useState(false)
  const scenarioSessionHandlers = useMemo(
    () => ({
      sessionKey: String(selectedSessionKey || '').trim(),
      onSessionModeChange: (mode: SessionMode) => setSessionMode(mode),
      patchSessionScenarios: (sk: string, scenarios: string[]) => {
        wsClient.patchSessionActivatedScenarios(sk, scenarios)
        // sessionMode is the source of truth after v75; keep it in sync with
        // the new scenario selection so resolveSessionModeForOpenSession stays
        // consistent without waiting for the next API refresh.
        const derivedMode =
          scenarios.includes('plan') ? 'plan' : scenarios.includes('agent') ? 'agent' : 'ask'
        setSessions((prev) =>
          prev.map((s) =>
            String(s.sessionKey || '') === sk
              ? { ...s, activatedScenarios: scenarios, sessionMode: derivedMode }
              : s,
          ),
        )
      },
    }),
    [selectedSessionKey, sessions],
  )

  const collabVerifyingBadge =
    SHOW_SESSION_MODE_COLLAB_UI &&
    collabOn &&
    String(threadPanelState.collabPhase || '').trim().toLowerCase() === 'verifying' ? (
      <span
        className="react-chat-collab-phase-badge react-chat-collab-phase-badge--verifying"
        title="子任务已完成，主 Agent 正在校验"
      >
        校验中
      </span>
    ) : null

  const normalizeFileHrefForThread = useCallback((_threadId: string, rawUrl: string) => {
    const u = String(rawUrl || '').trim()
    if (!u) return '#'
    if (/^https?:\/\//i.test(u)) return u
    // Windows absolute path (e.g. D:\repo\outputs\a.txt). Browser can't open it directly;
    // map into /mnt/user-data/{outputs,uploads}/... so 1421 can serve it.
    if (/^[a-zA-Z]:[\\/]/.test(u)) {
      const norm = u.replace(/\\/g, '/')
      const pickRel = (marker: string) => {
        const idx = norm.toLowerCase().lastIndexOf(marker)
        if (idx < 0) return null
        const rel = norm.slice(idx + marker.length).replace(/^\/+/, '')
        return rel ? rel : null
      }
      const relOut = pickRel('/outputs/')
      if (relOut) {
        return `/mnt/user-data/outputs/${relOut.split('/').map((seg) => encodeURIComponent(seg)).join('/')}`
      }
      const relUp = pickRel('/uploads/')
      if (relUp) {
        return `/mnt/user-data/uploads/${relUp.split('/').map((seg) => encodeURIComponent(seg)).join('/')}`
      }
      const relWs = pickRel('/workspace/')
      if (relWs) {
        return relWs
      }
      // Unknown absolute path: cannot safely infer; leave unchanged.
      return u
    }

    const stripped0 = u.replace(/^\/+/, '')
    // Accept: outputs/... | uploads/... | mnt/user-data/... | /mnt/user-data/...
    const vpath = stripped0
    if (vpath.startsWith('mnt/user-data/')) {
      // ok
      return `/${vpath.split('/').filter(Boolean).map((seg) => encodeURIComponent(seg)).join('/')}`
    }
    if (vpath.startsWith('outputs/') || vpath === 'outputs') {
      const rest = vpath === 'outputs' ? '' : vpath.slice('outputs/'.length)
      const enc = rest ? rest.split('/').filter(Boolean).map((seg) => encodeURIComponent(seg)).join('/') : ''
      return `/mnt/user-data/outputs/${enc}`.replace(/\/+$/, '')
    }
    if (vpath.startsWith('uploads/') || vpath === 'uploads') {
      const rest = vpath === 'uploads' ? '' : vpath.slice('uploads/'.length)
      const enc = rest ? rest.split('/').filter(Boolean).map((seg) => encodeURIComponent(seg)).join('/') : ''
      return `/mnt/user-data/uploads/${enc}`.replace(/\/+$/, '')
    }
    if (vpath.startsWith('workspace/') || vpath === 'workspace') {
      const rest = vpath === 'workspace' ? '' : vpath.slice('workspace/'.length)
      return rest || u
    }
    // Unknown local-ish path; don't rewrite.
    return u
  }, [])

  const normalizeRowFilesInPlace = useCallback((threadId: string, r: any) => {
    const files = Array.isArray(r?.files) ? r.files : null
    if (!files || !threadId) return r
    let changed = false
    const nextFiles = files.map((f: any) => {
      const url = String(f?.url || '').trim()
      if (!url) return f
      const nextUrl = normalizeFileHrefForThread(threadId, url)
      if (nextUrl !== url) {
        changed = true
        return { ...f, url: nextUrl }
      }
      return f
    })
    return changed ? { ...r, files: nextFiles } : r
  }, [normalizeFileHrefForThread])

  // History + stream tool-derived files may contain raw "D:\..." or "outputs/..." URLs; normalize them.
  useEffect(() => {
    const tid = wsClient.getSessionThreadId(selectedSessionKey)
    if (!tid) return
    setRows((prev) => {
      if (!Array.isArray(prev) || prev.length === 0) return prev
      let touched = false
      const next = prev.map((r: any) => {
        const nr = normalizeRowFilesInPlace(tid, r)
        if (nr !== r) touched = true
        return nr
      })
      return touched ? next : prev
    })
    // Also normalize current streaming files
    const S = streamRef.current
    if (S?.turn.files?.length) {
      const nextFiles = S.turn.files.map((f: any) => {
        const url = String(f?.url || '').trim()
        if (!url) return f
        const nextUrl = normalizeFileHrefForThread(tid, url)
        return nextUrl !== url ? { ...f, url: nextUrl } : f
      })
      S.turn.files = nextFiles
      scheduleBump()
    }
  }, [selectedSessionKey, setRows, normalizeRowFilesInPlace, normalizeFileHrefForThread])
  const [, setSubagentDockTasks] = useState<Record<string, SubagentStreamTask>>({})
  const [sidebarTaskViews, setSidebarTaskViews] = useState<Record<string, SidebarTaskView>>({})
  const [sidebarSelectedTaskId, setSidebarSelectedTaskId] = useState<string | null>(null)
  const bottomModelRootRef = useRef<HTMLDivElement | null>(null)
  const bottomPermissionRootRef = useRef<HTMLDivElement | null>(null)
  const bottomMoreRootRef = useRef<HTMLDivElement | null>(null)
  const bottomMoreTriggerRef = useRef<HTMLButtonElement | null>(null)
  const [bottomMorePortalStyle, setBottomMorePortalStyle] = useState<CSSProperties | null>(null)
  const bottomWorkspaceRootRef = useRef<HTMLDivElement | null>(null)

  const [roleUiNonce, setRoleUiNonce] = useState(0)
  const selectedSessionAgentId = useMemo(() => {
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) return ''
    const row = sessions.find((s) => String(s?.sessionKey || '').trim() === sk)
    const fromRow = String(row?.agentId || '').trim().toLowerCase()
    if (fromRow) return fromRow
    const ctxAid = String((row?.context as { agent_id?: string } | undefined)?.agent_id || '').trim().toLowerCase()
    return ctxAid
  }, [sessions, selectedSessionKey])
  const currentRoleCodeForUi = useMemo(() => {
    if (!selectedSessionKey) return 'main'
    // 员工会话：sessionKey 内 agent_code 优先于列表里可能过期的 agentId（常误为 main）。
    if (isProactiveSessionKey(selectedSessionKey)) {
      const code = String(parseProactiveSessionKey(selectedSessionKey).agentCode || '')
        .trim()
        .toLowerCase()
      if (code) return code
    }
    // DB/list agentId wins over stale local agent_name / sessionKey embedding.
    if (selectedSessionAgentId) return selectedSessionAgentId
    return resolveSessionAgentCodeForUi(selectedSessionKey)
  }, [selectedSessionKey, roleUiNonce, selectedSessionAgentId])

  /** 对话气泡 AI 头：纯显示名（不含标签前缀） */
  const assistantReplyLabel = useMemo(() => {
    const code = currentRoleCodeForUi
    const row = agents.find((a) => String(a?.agent_code || '').trim().toLowerCase() === code)
    const name = String(row?.agent_name || '').trim()
    if (name) return name
    if (code === 'main') return 'EvoFlow'
    if (code === 'claude-code') return '代码助手'
    return code || 'EvoFlow · Agent'
  }, [currentRoleCodeForUi, agents])

  const currentRoleLabel = useMemo(() => {
    const code = currentRoleCodeForUi
    const row = agents.find((a) => String(a?.agent_code || '').trim().toLowerCase() === code)
    const dn = row && String(row.agent_name || '').trim()
    const roleName = dn || (code === 'main' ? 'EvoFlow' : code === 'claude-code' ? '代码助手' : code)
    // Skip meta source tags like「自定义 / 核心 / SkillHub」— they clutter the rail signature.
    const META_PREFIX = new Set(['自定义', '核心', 'SkillHub', 'skillhub'])
    const tagLabels = normalizeAgentTags(row?.tags).filter((t) => !META_PREFIX.has(t))
    if (tagLabels.length > 0 && code !== 'main') {
      return `${tagLabels[0]} · ${roleName}`
    }
    return roleName
  }, [currentRoleCodeForUi, agents])

  /** 当前会话绑定智能体的默认模型（空 = 跟全局 primary） */
  const agentDefaultModelName = useMemo(() => {
    const code = String(currentRoleCodeForUi || '').trim().toLowerCase()
    if (!code) return ''
    const row = agents.find((a) => String(a?.agent_code || '').trim().toLowerCase() === code)
    return String(row?.model || '').trim()
  }, [currentRoleCodeForUi, agents])

  /** 跟随智能体时的展示/回落模型名 */
  const followResolvedModelName = useMemo(() => {
    if (agentDefaultModelName) return agentDefaultModelName
    return defaultModelFromCatalog(modelCatalog, primaryModelName) || String(primaryModelName || '').trim()
  }, [agentDefaultModelName, modelCatalog, primaryModelName])

  /** 会话是否已钉死 model_name（覆盖智能体默认） */
  const sessionModelOverride = useMemo(() => {
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) return ''
    const row = sessions.find((s) => String(s.sessionKey || '') === sk)
    const rowModel = String(row?.modelName || '').trim()
    const ctxRaw = String(wsClient.getSessionContext(sk)?.model_name ?? '').trim()
    return ctxRaw || rowModel
    // modelHydrateTick / roleUiNonce：hydrate 与切角色后重读 context
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionKey, sessions, modelHydrateTick, roleUiNonce])



  const currentRoleAgent = useMemo(() => {
    const code = currentRoleCodeForUi
    return agents.find((a) => String(a?.agent_code || '').trim().toLowerCase() === code) ?? { agent_code: code }
  }, [currentRoleCodeForUi, agents])

  const currentAgentCapabilities = useMemo(() => {
    const summary = agentCapabilitySummary(currentRoleAgent, Number.MAX_SAFE_INTEGER)
    const selectedNames = selectedSkills
      .map((s) => String(s.name || s.label || '').trim())
      .filter(Boolean)
    // Agent 配置技能 ∪ 本会话勾选技能
    const allSkills = Array.from(
      new Set([
        ...(Array.isArray(currentRoleAgent?.skills)
          ? currentRoleAgent.skills.map((s) => String(s || '').trim()).filter(Boolean)
          : []),
        ...selectedNames,
      ]),
    )
    const rawMcp = currentRoleAgent?.mcp_servers
    const mcpServers: string[] | null = Array.isArray(rawMcp)
      ? rawMcp.map((s) => String(s || '').trim()).filter(Boolean)
      : null
    const rawTools = currentRoleAgent?.tools
    const toolNames: string[] | null = Array.isArray(rawTools)
      ? rawTools.map((t) => String(t || '').trim()).filter(Boolean)
      : null
    const knowledgeVaultIds = Array.isArray(currentRoleAgent?.knowledge_vault_ids)
      ? currentRoleAgent.knowledge_vault_ids.map((k) => String(k || '').trim()).filter(Boolean)
      : []
    return {
      skillCount: allSkills.length,
      toolCount: toolNames?.length ?? summary.toolTotal,
      skillNames: allSkills,
      toolNames,
      mcpServers,
      knowledgeVaultIds,
    }
  }, [currentRoleAgent, selectedSkills])

  const [capabilityPatchBusy, setCapabilityPatchBusy] = useState(false)

  /** 智能体员工会话：侧栏选会话；底栏与普通对话一致 */
  const isProactiveEmployeeSession = useMemo(
    () => isProactiveSessionKey(selectedSessionKey),
    [selectedSessionKey],
  )

  useEffect(() => {
    if (!obsEnabled && infoRailTab === 'debug') {
      setInfoRailTab(isProactiveEmployeeSession ? 'task' : 'agent')
    }
  }, [obsEnabled, infoRailTab, isProactiveEmployeeSession])

  const employeeSessionAgentCode = useMemo(() => {
    if (!isProactiveEmployeeSession) return ''
    return String(parseProactiveSessionKey(String(selectedSessionKey || '')).agentCode || '')
      .trim()
      .toLowerCase()
  }, [isProactiveEmployeeSession, selectedSessionKey])

  const [employeeRoleDetail, setEmployeeRoleDetail] = useState<EmployeeRailInfo | null>(null)
  useEffect(() => {
    let cancelled = false
    if (!employeeSessionAgentCode) {
      setEmployeeRoleDetail(null)
      return () => {
        cancelled = true
      }
    }
    void import('../lib/tauri-api.js')
      .then(({ api }) => api.proactiveGetRole(employeeSessionAgentCode))
      .then((res: any) => {
        if (cancelled) return
        const role = res?.role || res
        if (!role || typeof role !== 'object') {
          setEmployeeRoleDetail(null)
          return
        }
        const cfg = role.config && typeof role.config === 'object' ? role.config : {}
        const think = String(cfg.think_mode || '').trim()
        setEmployeeRoleDetail({
          agentCode: String(role.agent_code || employeeSessionAgentCode).trim(),
          roleName: String(role.role_name || role.agent_code || employeeSessionAgentCode).trim(),
          department: String(role.department || '').trim(),
          status: String(role.status || '').trim(),
          responsibilities: Array.isArray(cfg.responsibilities)
            ? cfg.responsibilities.map((x: unknown) => String(x || '').trim()).filter(Boolean)
            : [],
          workspacePath: String(cfg.workspace_path || '').trim(),
          modelName: String(cfg.model_name || '').trim(),
          autonomyLabel: String(cfg.autonomy_level || '').trim(),
          thinkModeLabel: think === 'prompt_only' ? '轻量工作' : think ? '深度工作' : '',
          knowledgeVaultIds: Array.isArray(cfg.knowledge_vault_ids)
            ? cfg.knowledge_vault_ids.map((x: unknown) => String(x || '').trim()).filter(Boolean)
            : [],
        })
      })
      .catch(() => {
        if (!cancelled) setEmployeeRoleDetail(null)
      })
    return () => {
      cancelled = true
    }
  }, [employeeSessionAgentCode, roleUiNonce])

  /** 进入员工会话时按 session_key 同步 workspace_kind，不再用底栏「只聊天/派任务」模式条 */
  useEffect(() => {
    if (!isProactiveEmployeeSession) return
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) return
    const parsed = parseProactiveSessionKey(sk)
    const patch: Record<string, unknown> = {
      source: 'proactive',
      proactive_agent_code: parsed.agentCode || null,
      employee_talk_mode: 'chat',
    }
    if (parsed.kind === 'task' && parsed.taskId) {
      patch.workspace_kind = 'task'
      patch.related_task_id = parsed.taskId
    } else if (parsed.kind === 'chat') {
      patch.workspace_kind = 'chat'
      patch.related_task_id = null
      // 与普通「新建对话」一致：未指定模式时默认 Agent（勿落到 ensure-thread 旧默认 ask）
      const curMode = String(wsClient.getSessionContext(sk)?.session_mode || '')
        .trim()
        .toLowerCase()
      if (!curMode) {
        patch.session_mode = 'agent'
        setSessionModeInMeta(sk, 'agent')
        setSessionMode('agent')
      }
    } else if (parsed.kind === 'duty') {
      patch.workspace_kind = 'duty'
      patch.related_task_id = null
    } else {
      patch.workspace_kind = 'legacy'
    }
    void wsClient.updateSessionContext(sk, patch).catch(() => {})
  }, [isProactiveEmployeeSession, selectedSessionKey])

  const parentTaskToSubtaskRef = useRef<Record<string, string>>({})
  const subtasksBackfillInFlightRef = useRef<Record<string, boolean>>({})
  const subtasksBackfillLastAtRef = useRef<Record<string, number>>({})

  const upsertSidebarTaskView = useCallback(
    (
      task: CollabTaskSnapshot | null | undefined,
      subtasks?: CollabSubtaskSnapshot[],
      steps?: SupervisorStepSnapshot[],
    ) => {
      const taskId = (task?.taskId || '').trim()
      if (!taskId || !task) return
      const sessionKey = String(sessionRef.current || selectedSessionKey || '').trim()
      const normalizedSteps = trimStepsToLatestTask(steps)
      setSidebarTaskViews((prev) => {
        const cur = prev[taskId]
        const mergedSubtasks = preferPersistedCollabSubtasks(
          Array.isArray(subtasks)
            ? mergeCollabSubtasksStable(cur?.subtasks || [], subtasks)
            : cur?.subtasks || [],
        )
        return {
          ...prev,
          [taskId]: {
            task: { ...(cur?.task || {}), ...task },
            subtasks: mergedSubtasks,
            steps: normalizedSteps ?? cur?.steps ?? [],
            updatedAt: Date.now(),
            sessionKey: sessionKey || cur?.sessionKey,
          },
        }
      })
      setSidebarSelectedTaskId(taskId)
    },
    [selectedSessionKey],
  )

  /** 强兜底：检测到任务调度相关工具执行但子任务未显示时，主动查任务接口补齐子任务列表。 */
  const ensureSubtasksVisibleForTask = useCallback(
    async (taskId: string) => {
      const tid = String(taskId || '').trim()
      if (!tid) return
      const captureSk = String(sessionRef.current || selectedSessionKey || '').trim()
      const now = Date.now()
      const last = subtasksBackfillLastAtRef.current[tid] || 0
      // Throttle repeated backfill triggers during dense stream chunks.
      if (now - last < 4000) return
      if (subtasksBackfillInFlightRef.current[tid]) return
      subtasksBackfillInFlightRef.current[tid] = true
      subtasksBackfillLastAtRef.current[tid] = now
      try {
        let threadId = captureSk ? wsClient.getSessionThreadId(captureSk) || '' : ''
        if (!threadId || threadId.startsWith('agent:')) {
          const rowHint = String(
            sessionsRef.current.find((s) => String(s.sessionKey || '') === captureSk)?.threadId || '',
          ).trim()
          threadId = rowHint && !rowHint.startsWith('agent:') ? rowHint : ''
        }
        const mapped = await fetchCollabSubtasksForMainTask(tid, {
          ...(threadId ? { threadId, preferTaskId: tid } : { preferTaskId: tid }),
        })
        if (String(sessionRef.current || '').trim() !== captureSk) return
        if (!mapped.length) return
        setThreadPanelState((prev) => {
          if (String(sessionRef.current || '').trim() !== captureSk) return prev
          const prevTaskId = String(prev.collabTask?.taskId || '').trim()
          if (prevTaskId && prevTaskId !== tid) return prev
          return {
            ...prev,
            collabSubtasks: finalizeCollabSubtasksList(
              mergeCollabSubtasksStable(prev.collabSubtasks || [], mapped),
              prev.subagentTasks,
            ),
          }
        })
        upsertSidebarTaskView({ taskId: tid }, mapped, undefined)
        bumpSubtasksApiRefresh()
      } catch {
        // swallow
      } finally {
        subtasksBackfillInFlightRef.current[tid] = false
      }
    },
    [upsertSidebarTaskView, selectedSessionKey, bumpSubtasksApiRefresh],
  )

  /** 切换/新建会话：清空 plan latch、协作侧栏与 suppress，避免串会话显示上一对话的计划/子任务。 */
  const resetCollabPlanUiForSession = useCallback(
    (opts?: { keepBoundTaskId?: boolean; closeSidebar?: boolean }) => {
      resetPlanStreamSession()
      suppressedPlanExecDockKeysRef.current.clear()
      userAuthorizedTaskIdsRef.current.clear()
      setPlanExecSuppressVersion((v) => v + 1)
      setThreadPanelState(emptyThreadPanel())
      planAppliedForRef.current = ''
      planApiSyncInflightRef.current = null
      historyCollabHydratedRef.current = ''
      historyRowsBootstrappedRef.current = ''
      planFromApiLoadedRef.current = ''
      planDockApiViewRef.current = null
      setPlanDockApiView(null)
      threadCollabSnapshotRef.current = ''
      sessionBoundTaskIdRef.current = ''
      const leavingSk = String(sessionRef.current || selectedSessionKey || '').trim()
      if (leavingSk) invalidatePlanApiCache(leavingSk)
      if (!opts?.keepBoundTaskId) {
        setBoundTaskId(null)
      }
      setSidebarTaskViews({})
      setSidebarSelectedTaskId(null)
      setHasReceivedTodos(false)
      subtasksBackfillLastAtRef.current = {}
      subtasksBackfillInFlightRef.current = {}
      if (opts?.closeSidebar !== false) {
        setSessionSidebarOpen(false)
      }
      setCollabExecPanelOpen(false)
      setKnowledgeMapPanelOpen(false)
      prevCollabExecPhaseRef.current = ''
      collabExecSessionBaselinedRef.current = ''
      collabExecDismissedKeysRef.current.clear()
    },
    [resetPlanStreamSession],
  )

  /** 同会话内开启新一轮 plan：保留会话/thread，清空上一轮 plan/执行侧栏 latch。 */
  const resetCollabPlanUiForNewCycle = useCallback(() => {
    resetPlanStreamSession()
    suppressedPlanExecDockKeysRef.current.clear()
    userAuthorizedTaskIdsRef.current.clear()
    setPlanExecSuppressVersion((v) => v + 1)
    planAppliedForRef.current = ''
    planApiSyncInflightRef.current = null
    planFromApiLoadedRef.current = ''
    lastPlanSyncSigRef.current = ''
    planStreamLatchRef.current = null
    setPlanStreamLatched(false)
    planDockApiViewRef.current = null
    setPlanDockApiView(null)
    lastPlanPanelHitRef.current = null
    setSidebarTaskViews({})
    setSidebarSelectedTaskId(null)
    setHasReceivedTodos(false)
    subtasksBackfillLastAtRef.current = {}
    subtasksBackfillInFlightRef.current = {}
    const sk = String(sessionRef.current || selectedSessionKey || '').trim()
    if (sk) invalidatePlanApiCache(sk)
    setThreadPanelState(emptyThreadPanel())
    setBoundTaskId(null)
  }, [resetPlanStreamSession, selectedSessionKey])

  // collabSubtaskStatusSig removed (unused)

  /** 协作侧栏：流式 + 全历史 assistant 工具。 */
  const collectCollabToolsForSidebar = useCallback((): unknown[] => {
    const streamTools = streamRef.current.turn.tools as unknown[]
    const rowTools = mergeAssistantToolsFromRows(rows)
    return mergePlanToolsForDetection(
      Array.isArray(streamTools) ? streamTools : [],
      rowTools,
      false,
    )
  }, [rows])

  /** 底部 plan 条：流式中仅用 stream buffer，避免全历史合并冲掉当前 plan。 */
  const collectPlanToolsForDetection = useCallback((): unknown[] => {
    const streamTools = streamRef.current.turn.tools as unknown[]
    const rowTools = toolsFromLastAssistantRow(rows)
    const historyTools = mergeAssistantToolsFromRows(rows)
    const streamActive =
      Array.isArray(streamTools) &&
      streamTools.length > 0 &&
      (selectedTurnBusy || streamRefHasVisibleContent(streamRef.current))
    const persisted = persistedPlanInputRef.current
    const enrich = (list: unknown[]) =>
      enrichToolsWithCachedPlanInput(list, persisted ? { planInput: persisted } : null)
    // 流式进行中只用当前轮 stream buffer，避免上一轮 8～9 个工具行把 plan 冲没（plan=0 hit=none）
    if (streamActive) {
      return enrich(mergePlanToolsForDetection(streamTools, rowTools, true))
    }
    const snap = lastPlanDetectionToolsRef.current
    if (Array.isArray(snap) && snap.length > 0 && rows.length > 0) {
      return enrich(mergeToolsForPlanDetection(snap, historyTools, rowTools))
    }
    if (!rows.length) {
      return enrich([])
    }
    return enrich(mergeToolsForPlanDetection(historyTools, rowTools))
  }, [rows, selectedTurnBusy])

  const mergedPlanTools = useMemo(
    () => collectPlanToolsForDetection(),
    [collectPlanToolsForDetection, executingListEpoch, streamTick],
  )

  /** plan 工具入参/出参一到就立刻写 panel state（不等到 final / 刷新）。 */
  const syncPlanPanelImmediateFromTools = useCallback((tools: unknown[]) => {
    absorbPlanFromTools(tools)
    const analyzed = analyzePlanTools(tools)
    if (analyzed.planRows.length > 0) {
      lastPlanDetectionToolsRef.current = tools
      if (!planStreamLatchRef.current) {
        planStreamLatchRef.current = {
          planInput: analyzed.hit?.planInput,
          boundPlanReady: analyzed.hit?.boundPlanReady,
          taskId: analyzed.hit?.taskId,
        }
        setPlanStreamLatched(true)
      }
    }
    const hit = analyzed.hit
    if (hit?.newPlanCycle) {
      resetCollabPlanUiForNewCycle()
    }
    if (!hit?.planInput && !hit?.boundPlanReady) return false
    const goal = String(hit?.planInput?.goal || '').trim()
    const stepN = Array.isArray(hit?.planInput?.steps) ? hit.planInput.steps.length : 0
    const sig = `${hit?.boundPlanReady ? 'out' : 'in'}:${hit?.taskId || ''}:${goal}:${stepN}`
    const prevStepN = planStructuredStepCount(lastPlanPanelHitRef.current?.planInput)
    if (sig === lastPlanSyncSigRef.current && stepN <= prevStepN) return false
    lastPlanSyncSigRef.current = sig
    publishPlanPanelHit(hit)
    lastPlanDetectionToolsRef.current = tools
    setThreadPanelState((prev) => {
      const authorized = !!prev.collabTask?.executionAuthorized
      const phaseLc = String(prev.collabPhase || '')
        .trim()
        .toLowerCase()
      const executing = phaseLc === 'executing' || phaseLc === 'awaiting_exec'
      let nextPhase = prev.collabPhase
      if (hit?.boundPlanReady && !authorized && !executing) {
        nextPhase = 'plan_ready'
      } else if (!hit?.boundPlanReady && phaseLc !== 'plan_ready' && phaseLc !== 'executing') {
        nextPhase = 'planning'
      }
      return {
        ...prev,
        planInputFallback: hit?.planInput || prev.planInputFallback || null,
        collabPhase: nextPhase,
        clarification: hit?.boundPlanReady ? null : prev.clarification,
        ...(hit?.boundPlanReady && !authorized && !executing
          ? {
              collabTask: {
                ...(prev.collabTask || { taskId: String(hit.taskId || '').trim() || 'plan-pending' }),
                ...(hit.taskId ? { taskId: hit.taskId } : {}),
                status: 'planned',
                boundPlanReady: true,
                executionAuthorized: prev.collabTask?.executionAuthorized ?? false,
              } as CollabTaskSnapshot,
            }
          : {}),
      }
    })
    return true
  }, [publishPlanPanelHit, absorbPlanFromTools, resetCollabPlanUiForNewCycle])

  const patchCollabThrottleRef = useRef(0)
  const patchCollabTimerRef = useRef(0)
  const patchCollabPendingOptsRef = useRef<{
    skipPlanPanel?: boolean
    allowAutoOpen?: boolean
    force?: boolean
  } | undefined>(undefined)

  /** 从流式工具结果构建侧栏所需的主任务/子任务/步骤（工具一出结果即展示，不等到 final）。 */
  const patchCollabFromStreamTools = useCallback((opts?: {
    skipPlanPanel?: boolean
    /** 进入会话时仅恢复侧栏数据，不自动展开工作流面板（用户点头像栏按钮手动打开） */
    allowAutoOpen?: boolean
    /** @internal bypass throttle for deferred flush */
    force?: boolean
  }) => {
    const now = Date.now()
    if (!opts?.force && now - patchCollabThrottleRef.current < 400) {
      patchCollabPendingOptsRef.current = opts
      if (!patchCollabTimerRef.current) {
        patchCollabTimerRef.current = window.setTimeout(() => {
          patchCollabTimerRef.current = 0
          patchCollabThrottleRef.current = Date.now()
          const pending = patchCollabPendingOptsRef.current
          patchCollabPendingOptsRef.current = undefined
          patchCollabFromStreamTools({ ...pending, force: true })
        }, 400)
      }
      return
    }
    if (!opts?.force) patchCollabThrottleRef.current = now
    const tools = collectCollabToolsForSidebar()
    const built = buildCollabSidebarFromTools(tools) as {
      main: CollabTaskSnapshot | null
      subtasks: CollabSubtaskSnapshot[]
      supervisorSteps: SupervisorStepSnapshot[]
    }
    if (!opts?.skipPlanPanel) {
      const planTools = collectPlanToolsForDetection()
      const planChanged = syncPlanPanelImmediateFromTools(planTools)
      if (planChanged) {
        const patchAnalyzed = analyzePlanTools(planTools)
        tracePlanPipeline('patch', planTools, {
          planHit: patchAnalyzed.hit || lastPlanPanelHitRef.current,
          collabPhase: threadPanelState.collabPhase,
          collabTask: threadPanelState.collabTask,
          planInputFallback: threadPanelState.planInputFallback,
          subtaskCount: threadPanelState.collabSubtasks?.length ?? 0,
          isSuppressed: false,
          streamPlanLatched: planStreamLatched || !!planStreamLatchRef.current,
          latchedPlanInput: planStreamLatchRef.current?.planInput || null,
        })
      }
    }

    const hasAny =
      !!(built.main?.taskId && String(built.main.taskId).trim()) ||
      built.subtasks.length > 0 ||
      built.supervisorSteps.length > 0
    if (!hasAny) return
    // 进度优化/快照功能下线后：子任务需要直接由工具结果驱动写入 state。
    if (built.main?.taskId || built.subtasks.length || built.supervisorSteps.length) {
      setThreadPanelState((prev) => {
        const incomingTaskId = (built.main?.taskId || '').trim()
        const prevTaskId = (prev.collabTask?.taskId || '').trim()
        const switchedTask = !!incomingTaskId && !!prevTaskId && incomingTaskId !== prevTaskId
        return {
          ...prev,
          ...(built.main?.taskId
            ? {
                boundTaskId: built.main.taskId,
                collabTask: {
                  ...(switchedTask ? {} : prev.collabTask || {}),
                  ...built.main,
                  ...(prev.collabTask?.status === 'planned' && !built.main?.status
                    ? { status: 'planned' }
                    : {}),
                  ...(prev.collabTask?.boundPlanReady && !built.main?.boundPlanReady
                    ? { boundPlanReady: true }
                    : {}),
                } as CollabTaskSnapshot,
              }
            : {}),
          ...(built.subtasks.length
            ? {
                collabSubtasks: finalizeCollabSubtasksList(
                  mergeCollabSubtasksStable(
                    pruneSupersededPendingSubtasks(
                      switchedTask ? [] : (prev.collabSubtasks || []),
                      built.subtasks,
                    ),
                    built.subtasks,
                  ),
                  prev.subagentTasks,
                ),
              }
            : switchedTask
              ? { collabSubtasks: [] }
              : {}),
          ...(built.supervisorSteps.length
            ? { supervisorSteps: built.supervisorSteps }
            : switchedTask
              ? { supervisorSteps: [] }
              : {}),
        }
      })
      upsertSidebarTaskView(built.main || null, built.subtasks, built.supervisorSteps)
    }
    const mainTid = String(
      built.main?.taskId || threadPanelState.collabTask?.taskId || boundTaskId || '',
    ).trim()
    const createdSubtaskAction = (built.supervisorSteps || []).some((s) => {
      const a = String((s as any)?.action || '').trim()
      return a === 'create_task_with_subtasks' || a === 'create_subtasks' || a === 'create_subtask'
    })
    const hasPendingPlaceholders = built.subtasks.some((s) => isPendingSubtaskKey(s.subtaskId))
    // 工具流已能展示列表；仅在占位 id 或解析不到子任务时查 API 补齐。
    if (mainTid && (hasPendingPlaceholders || (createdSubtaskAction && built.subtasks.length === 0))) {
      void ensureSubtasksVisibleForTask(mainTid)
    }
  }, [
    boundTaskId,
    collectCollabToolsForSidebar,
    ensureSubtasksVisibleForTask,
    upsertSidebarTaskView,
    syncPlanPanelImmediateFromTools,
    collectPlanToolsForDetection,
  ])

  /** task-progress / 刷新 / 本轮 final 后：合并 collab_phase、bound_*、持久化 supervisor_steps 与主任务快照 */
  const applyTaskProgressSnapshot = useCallback(
    (snap: Record<string, unknown> | null, opts?: { sessionKey?: string }) => {
      if (!snap) return
      const captureSk = String(opts?.sessionKey || sessionRef.current || selectedSessionKey || '').trim()
      const phase = typeof snap.collab_phase === 'string' ? snap.collab_phase : null
      const boundTaskId =
        typeof snap.bound_task_id === 'string' && snap.bound_task_id.trim()
          ? snap.bound_task_id.trim()
          : null
      const stepsFromSnap = mapSnapSupervisorSteps(snap.supervisor_steps)

      const mainRaw = snap.main_task
      if (!mainRaw || typeof mainRaw !== 'object') {
        if (String(sessionRef.current || '').trim() !== captureSk) return
        setThreadPanelState((prev) => ({
          ...prev,
          ...(phase != null ? { collabPhase: phase } : {}),
          ...(boundTaskId != null ? { boundTaskId } : {}),
          ...(stepsFromSnap.length ? { supervisorSteps: stepsFromSnap } : {}),
        }))
        return
      }
      const main = mainRaw as Record<string, unknown>
      const taskId = typeof main.taskId === 'string' ? main.taskId.trim() : ''
      if (!taskId) {
        if (String(sessionRef.current || '').trim() !== captureSk) return
        setThreadPanelState((prev) => ({
          ...prev,
          ...(phase != null ? { collabPhase: phase } : {}),
          ...(boundTaskId != null ? { boundTaskId } : {}),
          ...(stepsFromSnap.length ? { supervisorSteps: stepsFromSnap } : {}),
        }))
        return
      }
      const subsRaw = snap.subtasks
      const collabSubtasks: CollabSubtaskSnapshot[] = Array.isArray(subsRaw)
        ? (subsRaw
            .map((row) => {
              const r = row as Record<string, unknown>
              const sid = typeof r.subtaskId === 'string' ? r.subtaskId.trim() : ''
              if (!sid) return null
              const dn =
                typeof (r as any).assignedAgentDisplay === 'string' &&
                String((r as any).assignedAgentDisplay).trim()
                  ? String((r as any).assignedAgentDisplay).trim()
                  : typeof (r as any).assignedAgentName === 'string' && String((r as any).assignedAgentName).trim()
                    ? String((r as any).assignedAgentName).trim()
                    : typeof (r as any).assigned_agent_name === 'string' &&
                        String((r as any).assigned_agent_name).trim()
                      ? String((r as any).assigned_agent_name).trim()
                      : ''
              const assignedCode =
                typeof r.assignedAgent === 'string' && r.assignedAgent.trim()
                  ? r.assignedAgent.trim()
                  : typeof (r as any).assigned_to === 'string' && String((r as any).assigned_to).trim()
                    ? String((r as any).assigned_to).trim()
                    : ''
              const out: CollabSubtaskSnapshot = {
                subtaskId: sid,
                ...(typeof r.parentTaskId === 'string' ? { parentTaskId: r.parentTaskId } : {}),
                ...(typeof r.name === 'string' ? { name: r.name } : {}),
                ...(typeof r.description === 'string' ? { description: r.description } : {}),
                ...(typeof r.status === 'string' ? { status: r.status } : {}),
                ...(typeof r.progress === 'number' ? { progress: r.progress } : {}),
                ...(assignedCode ? { assignedAgent: assignedCode } : {}),
                ...(dn ? { assignedAgentDisplay: dn } : {}),
                ...(typeof (r as any).currentStep === 'string'
                  ? { currentStep: (r as any).currentStep }
                  : typeof (r as any).current_step === 'string'
                    ? { currentStep: (r as any).current_step }
                    : {}),
                ...(Array.isArray((r as any).workChecklist)
                  ? { workChecklist: (r as any).workChecklist }
                  : Array.isArray((r as any).work_checklist)
                    ? { workChecklist: (r as any).work_checklist }
                    : []),
              }
              return out
            })
            .filter(Boolean) as CollabSubtaskSnapshot[])
        : []

      const collabTask: CollabTaskSnapshot = {
        taskId,
        ...(typeof main.name === 'string' ? { name: main.name } : {}),
        ...(typeof main.status === 'string' ? { status: main.status } : {}),
        ...(typeof main.progress === 'number' ? { progress: main.progress } : {}),
        ...(typeof main.executionAuthorized === 'boolean'
          ? { executionAuthorized: main.executionAuthorized }
          : typeof (main as { execution_authorized?: boolean }).execution_authorized === 'boolean'
            ? { executionAuthorized: (main as { execution_authorized: boolean }).execution_authorized }
            : {}),
        ...(typeof main.lifecycleStage === 'string' ? { lifecycleStage: main.lifecycleStage } : {}),
        ...(typeof main.lifecycleLabel === 'string' ? { lifecycleLabel: main.lifecycleLabel } : {}),
        ...(typeof main.boundPlanPreview === 'string' ? { boundPlanPreview: main.boundPlanPreview } : {}),
      }

      const taskName = typeof collabTask.name === 'string' ? collabTask.name.trim() : ''
      const nextTaskSt = String(collabTask.status || '')
        .trim()
        .toLowerCase()
      const prevTaskSt = collabTaskStatusNotifyRef.current.get(taskId) || ''
      if (nextTaskSt && nextTaskSt !== prevTaskSt) {
        collabTaskStatusNotifyRef.current.set(taskId, nextTaskSt)
        if (nextTaskSt === 'completed' && prevTaskSt !== 'completed') {
          void notifyDesktopCompletion({
            title: 'EvoFlow · 任务完成',
            body: taskName ? `「${taskName}」已完成` : '协作任务已完成',
            tag: `task:${taskId}:completed`,
          })
        } else if (nextTaskSt === 'failed' && prevTaskSt !== 'failed') {
          void notifyDesktopCompletion({
            title: 'EvoFlow · 任务失败',
            body: taskName ? `「${taskName}」执行失败` : '协作任务执行失败',
            tag: `task:${taskId}:failed`,
          })
        }
      }

      setThreadPanelState((prev) => {
        if (String(sessionRef.current || '').trim() !== captureSk) return prev
        const prevTaskId = (prev.collabTask?.taskId || '').trim()
        const switchedTask = !!prevTaskId && prevTaskId !== taskId
        if (switchedTask) {
          // New task in the same chat session: clear previous subtask stream cache
          // to avoid stale marquee from old task lingering in UI.
          streamRef.current.subagentTasks = {}
          streamRef.current.terminalStreams = {}
          setSubagentDockTasks({})
          parentTaskToSubtaskRef.current = {}
        }
        const nextSubtasks =
          collabSubtasks.length > 0
            ? finalizeCollabSubtasksList(collabSubtasks, prev.subagentTasks)
            : switchedTask
              ? []
              : preferPersistedCollabSubtasks(prev.collabSubtasks || [])
        const mergedCollabTask = switchedTask
          ? collabTask
          : {
              ...(prev.collabTask || {}),
              ...collabTask,
              ...(prev.collabTask?.status === 'planned' && !collabTask.status
                ? { status: 'planned' }
                : {}),
              ...(prev.collabTask?.boundPlanReady && !collabTask.boundPlanReady
                ? { boundPlanReady: true }
                : {}),
            }
        return {
          ...prev,
          collabPhase: phase ?? prev.collabPhase,
          boundTaskId: boundTaskId ?? prev.boundTaskId,
          // 如果快照缺少 progress（或进度暂时未返回），避免把旧的 progress 覆盖成空
          // 只有在 taskId 切换时才重置为新快照的 collabTask。
          collabTask: mergedCollabTask,
          // monitor_execution_step 的紧凑快照可能不带 subtasks，不能把现有子任务清空。
          collabSubtasks: nextSubtasks,
          supervisorSteps: stepsFromSnap.length ? stepsFromSnap : switchedTask ? [] : prev.supervisorSteps,
        }
      })
      upsertSidebarTaskView(collabTask, collabSubtasks.length > 0 ? collabSubtasks : undefined, stepsFromSnap)
      if (collabSubtasks.length > 0) bumpSubtasksApiRefresh()

      const planGoal = String(
        (main as { planGoal?: string }).planGoal || main.boundPlanPreview || '',
      ).trim()
      const boundReady =
        (main as { boundPlanReady?: boolean }).boundPlanReady === true ||
        String(main.status || '')
          .trim()
          .toLowerCase() === 'planned'
      if (planGoal || boundReady) {
        if (!captureSk) return
        const applyKey = `${captureSk}:${taskId}`
        if (planAppliedForRef.current === applyKey) return
        const loadKey = `${captureSk}:${taskId}:${planGoal.slice(0, 48)}`
        if (planFromApiLoadedRef.current === loadKey) return
      }
    },
    [upsertSidebarTaskView, publishPlanPanelHit, selectedSessionKey, bumpSubtasksApiRefresh],
  )

  const syncPlanPanelFromApi = useCallback(
    async (opts: {
      source: string
      sessionKey?: string
      hintTaskId?: string
      preview?: string
      fallback?: Record<string, unknown> | null
      planOutput?: Record<string, unknown> | null
      boundPlanReady?: boolean
      bypassCache?: boolean
      openSidebar?: boolean
    }) => {
      const source = String(opts.source || 'unknown').trim() || 'unknown'
      const fetchSeq = sessionTasksFetchSeqRef.current
      const captureSk = String(
        opts.sessionKey || sessionRef.current || selectedSessionKey || '',
      ).trim()
      if (!isActiveSessionFetch(captureSk, fetchSeq)) return
      let tid = String(opts.hintTaskId || '').trim()
      tracePlanDockApi('sync_start', { source, sessionKey: captureSk, hintTaskId: tid })
      const skipTaskResolve = !!tid || source === 'session_refresh' || !!opts.bypassCache
      if (!skipTaskResolve && captureSk) {
        tid = await resolvePlanBoundTaskId({
          sessionKey: captureSk,
          planOutput: opts.planOutput ?? null,
          hintTaskId: String(threadPanelState.collabSubtasks?.[0]?.parentTaskId || '').trim(),
        })
        if (!isActiveSessionFetch(captureSk, fetchSeq)) return
      }
      if (!skipTaskResolve && !tid && opts.planOutput) {
        tid = await resolvePlanBoundTaskId({
          sessionKey: captureSk,
          planOutput: opts.planOutput,
          hintTaskId: String(threadPanelState.collabSubtasks?.[0]?.parentTaskId || '').trim(),
        })
        if (!isActiveSessionFetch(captureSk, fetchSeq)) return
      }
      if (!isActiveSessionFetch(captureSk, fetchSeq)) return
      const applyKey = tid ? `${captureSk}:${tid}` : ''
      if (!opts.bypassCache && applyKey && planAppliedForRef.current === applyKey) {
        tracePlanDockApi('sync_skip_dedupe', { source, applyKey })
        if (planDockApiViewRef.current) return
      }

      const run = async () => {
        const hide = (reason: string, extra?: Record<string, unknown>) => {
          applyPlanDockApiView(
            planDockApiHide(source, reason, {
              taskId: tid || undefined,
              taskStatus: typeof extra?.taskStatus === 'string' ? extra.taskStatus : undefined,
            }) as PlanDockApiView,
          )
        }

        if (!captureSk) {
          hide('no_session_key')
          if (opts.fallback) {
            setThreadPanelState((prev) => ({
              ...prev,
              planInputFallback: opts.fallback || prev.planInputFallback || null,
              collabPhase: prev.collabPhase === 'executing' ? prev.collabPhase : 'planning',
            }))
          }
          return
        }

        const fallbackStructured = opts.fallback
          ? {
              goal: String(opts.fallback.goal || ''),
              flowchartMermaid: String(opts.fallback.flowchartMermaid || ''),
              steps: (opts.fallback.steps || []) as Array<Record<string, unknown>>,
              validation: opts.fallback.validation as string[] | undefined,
              openQuestions: String(opts.fallback.openQuestions || '无'),
            }
          : null
        if (!isActiveSessionFetch(captureSk, fetchSeq)) return
        const sync = await syncPlanDockStateFromApi(
          {
            sessionKey: captureSk,
            hintTaskId: tid,
            fallback: fallbackStructured,
          },
          { bypassCache: !!opts.bypassCache },
        )
        if (!isActiveSessionFetch(captureSk, fetchSeq)) return
        if (sync.taskId) tid = sync.taskId
        const resolvedApplyKey = tid ? `${captureSk}:${tid}` : applyKey
        if (resolvedApplyKey) {
          planAppliedForRef.current = resolvedApplyKey
          planFromApiLoadedRef.current = `${captureSk}:${tid}:${String(sync.plan?.goal || opts.fallback?.goal || '').slice(0, 48)}`
        }

        let collabAppliedFromSyncRow = false
        const applyCollabOnceFromSyncRow = () => {
          if (collabAppliedFromSyncRow || !(sync as Record<string, unknown>).taskRow || !tid) return
          const snap = collabSnapshotFromTaskRow((sync as Record<string, unknown>).taskRow as Record<string, unknown>)
          if (!snap) return
          collabAppliedFromSyncRow = true
          applyTaskProgressSnapshot(snap, { sessionKey: captureSk })
        }
        if (source === 'session_enter' && (sync as Record<string, unknown>).taskRow) {
          applyCollabOnceFromSyncRow()
          threadCollabSnapshotRef.current = captureSk
        }

        if (tid && sync.taskStatus === 'planned' && !sync.executionAuthorized) {
          const suppressToken = planExecSuppressToken(tid)
          const wasAuthorized = userAuthorizedTaskIdsRef.current.has(tid)
          if (!wasAuthorized) {
            suppressedPlanExecDockKeysRef.current.delete(suppressToken)
            for (const k of [...suppressedPlanExecDockKeysRef.current]) {
              if (k === suppressToken || k.startsWith(`${suppressToken}:`)) {
                suppressedPlanExecDockKeysRef.current.delete(k)
              }
            }
          }
        }

        const rowSubCount = Array.isArray(((sync as Record<string, unknown>).taskRow as { subtasks?: unknown[] } | null)?.subtasks)
          ? (((sync as Record<string, unknown>).taskRow as { subtasks?: unknown[] }).subtasks?.length ?? 0)
          : 0
        const subCount = rowSubCount || threadPanelState.collabSubtasks?.length || 0
        if (tid && isPlanExecDockSuppressed(tid, subCount)) {
          hide('suppressed', { taskStatus: sync.taskStatus })
          return
        }

        const fromApi = sync.plan
          ? {
              goal: String(sync.plan.goal || '').trim(),
              flowchartMermaid: String(sync.plan.flowchartMermaid || '').trim(),
              steps: (Array.isArray(sync.plan.steps) ? sync.plan.steps : []) as StructuredPlanInput['steps'],
              validation: sync.plan.validation as string[] | undefined,
              openQuestions: String(sync.plan.openQuestions || '无').trim(),
            }
          : null
        const planInputForState = fromApi

        if (!sync.showPlanDock || !planInputForState?.goal || !tid) {
          if (
            source === 'session_enter' &&
            !(sync as Record<string, unknown>).taskRow &&
            !tid &&
            !sync.taskStatus
          ) {
            tracePlanDockApi('session_enter_idle', { source, sessionKey: captureSk, note: 'no bound task yet' })
            return
          }
          if (
            sync.taskStatus === 'planning' &&
            !sync.executionAuthorized &&
            (source === 'stream_final' || source.startsWith('stream_final_'))
          ) {
            tracePlanDockApi('sync_wait_planned', { source, sessionKey: captureSk, taskId: tid })
            return
          }
          if (
            planDockApiViewRef.current?.show &&
            String(planDockApiViewRef.current.taskId || '').trim() === tid &&
            sync.taskStatus === 'planned' &&
            !sync.executionAuthorized
          ) {
            tracePlanDockApi('sync_keep_planned_dock', { source, taskId: tid })
            return
          }
          hide(sync.pastPlanGate ? 'past_plan_gate' : !tid ? 'no_task_id' : 'not_planned', {
            taskStatus: sync.taskStatus,
          })
          if (sync.pastPlanGate && tid) {
            suppressPlanExecDock(tid)
            setBoundTaskId(tid)
            applyCollabOnceFromSyncRow()
            if (rowSubCount > 0) bumpSubtasksApiRefresh()
            // Task passed plan gate (executing/completed/authorized):
            // clear stream latch + cached plan hit so subsequent non-plan turns
            // don't keep planCtxAtFinal=true and re-trigger refreshPlanDockAfterStreamFinal.
            planStreamLatchRef.current = null
            lastPlanPanelHitRef.current = null
            setPlanStreamLatched(false)
            setPlanPanelHit(null)
          }
          return
        }

        const effectiveTaskStatus = sync.taskStatus || 'planned'
        const effectiveExecutionAuthorized = sync.executionAuthorized
        const stripUi = computePlanExecStripUi({
          status: effectiveTaskStatus,
          executionAuthorized: effectiveExecutionAuthorized,
          boundPlanReady: true,
          hasPlanToolSuccess: true,
        })
        const showStartExecution =
          effectiveTaskStatus === 'planned' && !effectiveExecutionAuthorized
            ? true
            : stripUi.showStartExecution
        const planStructured: StructuredPlanInput = {
          goal: String(planInputForState.goal || sync.plan?.goal || '').trim(),
          flowchartMermaid: String(planInputForState.flowchartMermaid || sync.plan?.flowchartMermaid || '').trim(),
          steps: (planInputForState.steps || sync.plan?.steps || []) as StructuredPlanInput['steps'],
          validation: (planInputForState.validation || sync.plan?.validation) as string[] | undefined,
          openQuestions: String(planInputForState.openQuestions || sync.plan?.openQuestions || '无').trim(),
        }
        const suppressToken = planExecSuppressToken(tid)
        suppressedPlanExecDockKeysRef.current.delete(suppressToken)
        for (const k of [...suppressedPlanExecDockKeysRef.current]) {
          if (k === suppressToken || k.startsWith(`${suppressToken}:`)) {
            suppressedPlanExecDockKeysRef.current.delete(k)
          }
        }
        applyPlanDockApiView(
          planDockApiShow(source, {
            taskId: tid,
            taskName: threadPanelState.collabTask?.name,
            taskStatus: effectiveTaskStatus,
            statusLabel: stripUi.statusLabel,
            showStartExecution,
            planStructured,
            subtaskCount: subCount,
            toolCallId: '',
          }) as PlanDockApiView,
        )

        publishPlanPanelHit({
          planInput: planInputForState,
          boundPlanReady: opts.boundPlanReady ?? true,
          taskId: tid,
          planOutput: opts.planOutput ?? undefined,
        })
        if (tid) setBoundTaskId(tid)
        applyCollabOnceFromSyncRow()
        // @ts-ignore
        setThreadPanelState((prev) => {
          if (String(sessionRef.current || '').trim() !== captureSk) return prev
          const prevTid = String(prev.collabTask?.taskId || prev.boundTaskId || '').trim()
          const alreadyAuthorized = !!prev.collabTask?.executionAuthorized
          const executing =
            String(prev.collabPhase || '')
              .trim()
              .toLowerCase() === 'executing' ||
            String(prev.collabTask?.lifecycleStage || '')
              .trim()
              .toLowerCase() === 'executing'
          if (alreadyAuthorized || executing) {
            return {
              ...prev,
              boundTaskId: tid || prev.boundTaskId,
              planInputFallback: planInputForState || prev.planInputFallback || null,
              collabPhase: prev.collabPhase,
              collabTask: {
                ...(prev.collabTask || {}),
                taskId: tid || prev.collabTask?.taskId,
                executionAuthorized: true,
                boundPlanPreview:
                  String(opts.preview || prev.collabTask?.boundPlanPreview || '').trim() || undefined,
              },
            }
          }
          if (prevTid && tid && prevTid !== tid) {
            for (const k of [...suppressedPlanExecDockKeysRef.current]) {
              if (k.startsWith(`${prevTid}:`)) suppressedPlanExecDockKeysRef.current.delete(k)
            }
          }
          return {
            ...prev,
            boundTaskId: tid || prev.boundTaskId,
            planInputFallback: planInputForState || prev.planInputFallback || null,
            collabPhase: 'plan_ready',
            clarification: null,
            collabTask: {
              ...(prev.collabTask || {}),
              taskId: tid || prev.collabTask?.taskId,
              boundPlanReady: true,
              boundPlanPreview:
                String(
                  opts.preview ||
                    planStructured.goal ||
                    prev.collabTask?.boundPlanPreview ||
                    '',
                ).trim() || undefined,
              executionAuthorized: false,
              status: effectiveTaskStatus,
            },
          }
        })
        if (opts.openSidebar) openSessionSidebar()
      }

      if (planApiSyncInflightRef.current) {
        try {
          await planApiSyncInflightRef.current
        } catch {
          /* ignore */
        }
        if (!opts.bypassCache && applyKey && planAppliedForRef.current === applyKey && planDockApiViewRef.current) {
          tracePlanDockApi('sync_skip_after_inflight', { source, applyKey })
          return
        }
      }
      const promise = run()
        .catch((e) => {
          tracePlanDockApi('sync_error', { source, message: String((e as Error)?.message || e) })
          applyPlanDockApiView(planDockApiHide(source, 'sync_error') as PlanDockApiView)
        })
        .finally(() => {
          if (planApiSyncInflightRef.current === promise) {
            planApiSyncInflightRef.current = null
          }
          tracePlanDockApi('sync_done', { source })
        })
      planApiSyncInflightRef.current = promise
      return promise
    },
    [
      applyPlanDockApiView,
      applyTaskProgressSnapshot,
      publishPlanPanelHit,
      selectedSessionKey,
      threadPanelState.collabSubtasks,
      threadPanelState.collabTask?.name,
      openSessionSidebar,
      threadPanelState.collabPhase,
      suppressPlanExecDock,
      isPlanExecDockSuppressed,
      setBoundTaskId,
      shouldShowCollabSubtaskSidebar,
      bumpSubtasksApiRefresh,
    ],
  )

  const applyPlanToolSuccess = useCallback(
    async (hit: {
      taskId?: string
      preview?: string
      status?: string
      planInput?: Record<string, unknown>
      planOutput?: Record<string, unknown>
      boundPlanReady?: boolean
    }) => {
      await syncPlanPanelFromApi({
        source: 'tool_success',
        hintTaskId: hit.taskId,
        preview: hit.preview,
        fallback: hit.planInput || null,
        planOutput: hit.planOutput ?? null,
        boundPlanReady: hit.boundPlanReady,
        openSidebar: true,
      })
    },
    [syncPlanPanelFromApi],
  )
  applyPlanToolSuccessRef.current = applyPlanToolSuccess

  const refreshPlanDockAfterStreamFinal = useCallback(
    async (opts: {
      hintTaskId?: string
      sessionKey?: string
      retryUntilPlanned?: boolean
      fallback?: Record<string, unknown> | null
    }) => {
      const captureSk = String(opts.sessionKey || sessionRef.current || selectedSessionKey || '').trim()
      const fallbackPlan = opts.fallback ?? planStreamLatchRef.current?.planInput ?? null
      const runSync = (source: string) =>
        syncPlanPanelFromApi({
          source,
          sessionKey: captureSk,
          hintTaskId: opts.hintTaskId,
          bypassCache: true,
          ...(fallbackPlan ? { fallback: fallbackPlan } : {}),
        })
      await runSync('stream_final')
      if (planDockApiViewRef.current?.show) {
        return
      }
      if (!opts.retryUntilPlanned) {
        return
      }
      for (const delayMs of [600, 1500]) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs))
        if (String(sessionRef.current || '').trim() !== captureSk) return
        if (planDockApiViewRef.current?.show) return
        await runSync('stream_final_retry')
        if (planDockApiViewRef.current?.show) {
          return
        }
      }
    },
    [syncPlanPanelFromApi, selectedSessionKey],
  )
  const refreshPlanDockAfterStreamFinalRef = useRef(refreshPlanDockAfterStreamFinal)
  refreshPlanDockAfterStreamFinalRef.current = refreshPlanDockAfterStreamFinal
  const syncPlanPanelFromApiRef = useRef(syncPlanPanelFromApi)
  syncPlanPanelFromApiRef.current = syncPlanPanelFromApi

  const reconcileInflightRef = useRef(new Map<string, Promise<void>>())

  /** 流式 final 后：拉 DB 最近几条对账，仅在正文不一致时静默替换 assistant（避免 all=1 整页闪）。 */
  const reconcileLastAssistantFromDb = useCallback(
    async (opts: { sessionKey: string; runId?: string | null }) => {
      const sk = String(opts.sessionKey || '').trim()
      const runId = String(opts.runId || '').trim() || null
      if (!sk) return
      const flightKey = `${sk}:${runId || '_'}`
      const prev = reconcileInflightRef.current.get(flightKey)
      if (prev) return prev

      const work = (async () => {
        const tryOnce = async (): Promise<'applied' | 'synced' | 'retry' | 'skip'> => {
          try {
            const { api } = await import('../lib/tauri-api.js')
            const chatApi = (sessionKey: string, limit: number, historyOpts?: { all?: boolean }) =>
              api.chatHistory(sessionKey, limit, historyOpts)
            const result = await fetchSessionHistoryTailMessages(chatApi, sk, 24)
            const built = buildHistoryViewFromRaw(result.messages)
            const rt = getSessionRuntime(sk)
            const localRows = rt.rows.length ? rt.rows : rowsRef.current
            const outcome = reconcileLastAssistantInRows(localRows, built.rows, runId)
            if (outcome.status === 'applied') {
              updateSessionRuntimeRows(sk, () => outcome.rows)
              replaceSessionRuntimeRowsFromHistory(sk, outcome.rows)
              if (sk === String(sessionRef.current || selectedSessionKey || '').trim()) {
                setRows((prevRows) => {
                  if (displayRowsEquivalent(prevRows, outcome.rows)) return prevRows
                  return outcome.rows
                })
              }
              return 'applied'
            }
            return outcome.status
          } catch {
            return 'retry'
          }
        }
        for (const delayMs of [800, 2000, 4000]) {
          if (delayMs) await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs))
          const rt = getSessionRuntime(sk)
          if (isTurnBusy(rt)) return
          const status = await tryOnce()
          if (status === 'applied' || status === 'synced' || status === 'skip') return
        }
      })().finally(() => {
        if (reconcileInflightRef.current.get(flightKey) === work) {
          reconcileInflightRef.current.delete(flightKey)
        }
      })

      reconcileInflightRef.current.set(flightKey, work)
      return work
    },
    [selectedSessionKey, setRows],
  )
  const reconcileLastAssistantFromDbRef = useRef(reconcileLastAssistantFromDb)
  reconcileLastAssistantFromDbRef.current = reconcileLastAssistantFromDb

  /** 侧栏单条刷新：messages 一次 + tasks 一次（reload 后再 sync，并挡住 session_enter 重复）。 */
  const runShellSessionRefresh = useCallback(
    async (sessionKey: string) => {
      const sk = String(sessionKey || '').trim()
      if (!sk) return
      if (sessionRefreshInFlightRef.current === sk) return
      sessionRefreshInFlightRef.current = sk
      const fetchSeq = sessionTasksFetchSeqRef.current
      try {
        if (!isActiveSessionFetch(sk, fetchSeq)) return

        // 先刷新会话列表，获取最新 runStatus（续流门禁依赖此数据）
        await refreshSessionsRef.current?.({ skipAutoReselect: true })
        if (!isActiveSessionFetch(sk, fetchSeq)) return

        if (sk) {
          invalidatePlanApiCache(sk)
        }

        planAppliedForRef.current = ''
        planFromApiLoadedRef.current = ''
        threadCollabSnapshotRef.current = ''

        const rowBefore = sessionsRef.current.find((s) => String(s.sessionKey || '') === sk)
        const rtBefore = getSessionRuntime(sk)
        const shouldResumeBefore = shouldManualRefreshResumeStream({
          sessionKey: sk,
          runStatus: rowBefore?.runStatus,
          executingSessionKeys: executingSessionKeysRef.current,
          runtime: rtBefore,
        })
        if (shouldResumeBefore) {
          const runId = String(rtBefore.activeChatRunId || rowBefore?.currentRunId || '').trim()
          if (runId) wsClient.abortStreamWire(sk, runId)
          dispatchSessionTurnEvent(sk, {
            type: 'REATTACH_STARTED',
            runId: runId || '',
          })
        }

        await reloadHistoryFromDb({ bypassCache: true, dbOnly: true })
        if (!isActiveSessionFetch(sk, fetchSeq)) return

        const row = sessionsRef.current.find((s) => String(s.sessionKey || '') === sk)
        const rt = getSessionRuntime(sk)
        const shouldResume =
          shouldResumeBefore ||
          shouldManualRefreshResumeStream({
            sessionKey: sk,
            runStatus: row?.runStatus,
            executingSessionKeys: executingSessionKeysRef.current,
            runtime: rt,
          })
        srLog('shell session refresh', { sessionKey: sk, shouldResume, runStatus: row?.runStatus ?? null })
        if (shouldResume) {
          requestManualStreamResumeRef.current(sk, { refreshSessions: false })
        } else {
          // shouldResume=false：会话可能已结束但 probe cache/runtime 仍 stale。
          // 主动查后端 execution/state 同步 probe cache，若已结束则清理本地运行状态。
          try {
            const probe = await fetchAndCacheSessionExecutionState(sk)
            const rtAfter = getSessionRuntime(sk)
            const stillBusy = isTurnBusy(rtAfter) || isSessionRuntimeLive(rtAfter)
            const backendDone = probe ? !probe.executing && !probe.goalActive : true
            if (stillBusy && backendDone) {
              // 后端确认已结束：清 probe cache + dispatch TURN_IDLE 归位侧栏运行状态
              clearSessionExecutionProbe(sk)
              dispatchSessionTurnEvent(sk, { type: 'TURN_IDLE' })
            }
          } catch {
            /* best-effort */
          }
        }

        // 刷新目标状态（与续流独立，确保目标图标/步数/目标状态同步）
        void refreshGoalStatusRef.current?.(sk)

        const rowsForPlan = rowsRef.current.length ? rowsRef.current : rows
        const planHit = rowsForPlan.length
          ? extractLastPlanToolSuccessFromArrays(collectAssistantToolArraysFromRows(rowsForPlan))
          : null
        const ctx = wsClient.getSessionContext(sk) as { collab_task_id?: string } | undefined
        const preferTaskId = String(
          ctx?.collab_task_id ||
            (planHit as { taskId?: string } | null)?.taskId ||
            boundTaskId ||
            '',
        ).trim()

        const syncOpts = {
          source: 'session_refresh' as const,
          sessionKey: sk,
          hintTaskId: preferTaskId,
          bypassCache: true,
          fallback: (planHit as { planInput?: Record<string, unknown> } | null)?.planInput ?? null,
          planOutput: (planHit as { planOutput?: Record<string, unknown> } | null)?.planOutput ?? null,
          boundPlanReady: !!(planHit as { boundPlanReady?: boolean } | null)?.boundPlanReady,
        }
        await syncPlanPanelFromApi(syncOpts)
        planSessionEnterRef.current = sk
      } finally {
        if (sessionRefreshInFlightRef.current === sk) sessionRefreshInFlightRef.current = ''
      }
    },
    [syncPlanPanelFromApi, reloadHistoryFromDb, rows],
  )
  const runShellSessionRefreshRef = useRef(runShellSessionRefresh)
  runShellSessionRefreshRef.current = runShellSessionRefresh

  async function resolveLangGraphThreadIdForSession(sessionKey: string): Promise<string> {
    const sk = String(sessionKey || '').trim()
    if (!sk) return ''
    const rowHintRaw = String(
      sessionsRef.current.find((s) => String(s.sessionKey || '') === sk)?.threadId || '',
    ).trim()
    const rowHint =
      resolveLanggraphLeadThreadId(rowHintRaw) ||
      (rowHintRaw && !rowHintRaw.startsWith('agent:') ? rowHintRaw : '')
    const fromMap = wsClient.getSessionThreadId(sk)
    const resolved = await wsClient.resolveSessionThreadId(sk, {
      hintThreadId: rowHint || rowHintRaw || fromMap || undefined,
    })
    return String(resolved || '').trim()
  }

  /** REST authorize-execution：写 execution_authorized 并自动派发首波；失败时仍返回 false。 */
  async function authorizeExecutionInBackground(
    taskId: string,
    _threadIdHint: string,
  ): Promise<boolean> {
    const tid = String(taskId || '').trim()
    if (!tid) return false
    const sk = String(sessionRef.current || selectedSessionKey || '').trim()
    const threadId = await resolveLangGraphThreadIdForSession(sk)
    try {
      const auth = (await tasksAPI.authorizeTaskExecution(tid, {
        authorized_by: 'user',
        ...(threadId ? { thread_id: threadId } : {}),
      })) as Record<string, unknown>
      if (auth?.success === false) {
        const msg = String(auth?.message || auth?.error || '授权失败').trim()
        toast(`授权失败：${msg}`, 'error')
        return false
      }
      if (threadId) {
        const snap = (await wsClient.hydrateCollabSidebarSnapshot(threadId, tid)) as Record<
          string,
          unknown
        > | null
        if (snap) {
          applyTaskProgressSnapshot(snap, {
            sessionKey: String(sessionRef.current || selectedSessionKey || '').trim(),
          })
        }
      }
      const phase = String(auth?.collab_phase || 'awaiting_exec').trim().toLowerCase()
      setThreadPanelState((prev) => ({
        ...prev,
        boundTaskId: tid,
        collabPhase: phase === 'executing' ? 'executing' : 'awaiting_exec',
        collabTask: {
          ...(prev.collabTask || {}),
          taskId: tid,
          executionAuthorized: true,
          status: phase === 'executing' ? 'executing' : prev.collabTask?.status || 'planned',
        },
      }))
      suppressPlanExecDock(tid)
      userAuthorizedTaskIdsRef.current.add(tid)
      applyPlanDockApiView(
        planDockApiHide('user_start_execution', 'execution_authorized', {
          taskId: tid,
          taskStatus: phase === 'executing' ? 'executing' : 'planned',
        }) as PlanDockApiView,
      )
      openCollabExecPanel({ clearDismiss: true })
      await ensureSubtasksVisibleForTask(tid)
      return true
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      toast(`启动执行失败：${raw}`, 'error')
      return false
    }
  }

  /** 界面「开始执行」：REST 授权并自动派发首波，再发用户消息让 Lead 进入监控/验收轮次。 */
  async function runUserExecutionStart(taskId: string) {
    if (planExecStartInFlightRef.current) return
    planExecStartInFlightRef.current = true
    setPlanExecStarting(true)
    let tid = String(taskId || '').trim()
    const sk = String(sessionRef.current || selectedSessionKey || '').trim()
    try {
      if (!tid && sk) {
        const hit = extractLastPlanToolSuccessFromArrays(planExecToolArrays)
        tid = await resolvePlanBoundTaskId({
          sessionKey: sk,
          // @ts-ignore
          planOutput: (hit?.planOutput as Record<string, unknown> | undefined) ?? null,
          hintTaskId: String(
            threadPanelState.collabTask?.taskId ||
              threadPanelState.boundTaskId ||
              boundTaskId ||
              threadPanelState.collabSubtasks?.[0]?.parentTaskId ||
              '',
          ).trim(),
        })
      }
      if (tid) {
        const threadId = await resolveLangGraphThreadIdForSession(sk)
        const authorized = await authorizeExecutionInBackground(tid, threadId)
        if (!authorized) return
      } else {
        toast('未找到可授权的任务 ID，请稍候或刷新后重试', 'warning')
        return
      }
      await handleSend('开始执行')
    } finally {
      planExecStartInFlightRef.current = false
      setPlanExecStarting(false)
    }
  }

  // NOTE: 已移除 scheduleCollabTaskProgressRefresh（不再通过 /task-progress 拉取侧栏快照）

  // 🔧 使用 ref 防止重复处理
  const processedTaskIdRef = useRef<string | null>(null)

  /** 从 MCP/技能等页点侧栏会话列表进入聊天时，shell-aside 写入待选会话 */
  useEffect(() => {
    try {
      const pendingSession = sessionStorage.getItem('evopanel_pending_shell_session')
      const pendingThread = sessionStorage.getItem('evopanel_pending_shell_thread')
      const pendingTaskId = sessionStorage.getItem('evopanel_pending_shell_task_id')

      // 🔧 关键修复：只要存在 pendingTaskId 且未处理过，就应该设置 boundTaskId
      if (pendingTaskId && processedTaskIdRef.current !== pendingTaskId) {
        processedTaskIdRef.current = pendingTaskId
        queueMicrotask(() => setBoundTaskId(pendingTaskId))
        // Session 会自动通过 wsClient.getSessionThreadId 获取 threadId 来订阅流
        // 🔧 标记这是从任务跳转过来的，防止 selectedSessionKey 变化时重置 boundTaskId
        if (pendingSession) {
          sessionRef.current = pendingSession
        }
      }

      const pendingOpenWorkflow = sessionStorage.getItem('evopanel_pending_open_collab_workflow') === '1'

      if (pendingSession) {
        if (String(pendingSession).startsWith('automation:')
          || String(pendingSession).includes(':duty:')) {
          void getApi()
            .then((api) => api.chatSessionSetHidden(pendingSession, false))
            .then(() => refreshSessionsRef.current?.({ skipAutoReselect: true }))
            .catch(() => {})
        }
        if (pendingThread) {
          void wsClient
            .bindSessionThread(pendingSession, pendingThread, {
              context: {
                taskRelated: true,
                ...(pendingTaskId ? { collab_task_id: pendingTaskId } : {}),
              },
            })
            .then(() => {
              if (String(sessionRef.current || '').trim() === pendingSession) {
                void reload({ bypassCache: true })
              }
            })
            .catch((e: unknown) => {
              console.warn('[ChatApp] bindSessionThread failed:', e)
            })
        }

        if (pendingOpenWorkflow) {
          openCollabExecPanel({ clearDismiss: true })
        }

        // 注意：useState 初始化时已经优先返回了 pendingSession
        // 这里不需要再 setSelectedSessionKey，避免重复渲染
        // 🔧 延迟清理 sessionStorage，避免 StrictMode 双重渲染问题
        setTimeout(() => {
          sessionStorage.removeItem('evopanel_pending_shell_session')
          sessionStorage.removeItem('evopanel_pending_shell_thread')
          sessionStorage.removeItem('evopanel_pending_shell_task_id')
          sessionStorage.removeItem('evopanel_pending_open_collab_workflow')
        }, 1000)
      }

      // 从“任务重新开始/开始执行”跳转到实时对话页时：run 可能尚未进入 running/pending。
      // 续流仅由用户刷新页面/侧栏刷新按钮触发，此处不再自动 poll attach。
      if (pendingSession && pendingThread && pendingTaskId) {
        void reload({ bypassCache: true }).catch(() => {
          dispatchSessionTurnEvent(pendingSession, {
            type: 'REATTACH_FAILED',
            threadId: pendingThread,
          })
        })
      }
    } catch (e) {
      console.error('[ChatApp] 处理 pending session 失败:', e)
    }
    // 空依赖数组：只在组件挂载时执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ============================================

  const prevSelectLogRef = useRef('__init__')
  // useLayoutEffect：在 paint 前写入 sessionRef，避免 refreshSessions 仍读到旧 key
  useLayoutEffect(() => {
    const sk = String(selectedSessionKey || '').trim()
    if (prevSelectLogRef.current !== sk) {
      ssLog('state.changed', {
        from: skTail(prevSelectLogRef.current === '__init__' ? '' : prevSelectLogRef.current),
        to: skTail(sk),
        sessionRefBefore: skTail(sessionRef.current),
        newChatButtonActive,
        pendingNew: pendingNewSessionRef.current,
      })
      prevSelectLogRef.current = sk
    }
    sessionRef.current = selectedSessionKey
    // Persist selected session to localStorage for cross-refresh restore
    if (sk) {
      try {
        localStorage.setItem(LS_LAST_SELECTED_SESSION, sk)
      } catch {
        /* ignore */
      }
    }
    sessionTasksFetchSeqRef.current += 1
  }, [selectedSessionKey, newChatButtonActive])

  useEffect(() => {
    const onHome =
      !historyLoading &&
      !historyError &&
      !sessionHadContent &&
      Array.isArray(rows) &&
      rows.length === 0
    document.querySelectorAll('[data-shell-home="1"]').forEach((el) => {
      el.classList.toggle('active', onHome)
    })
  }, [historyLoading, historyError, sessionHadContent, rows])

  useEffect(() => {
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) return
    const row = sessions.find((s) => String(s.sessionKey || '') === sk)
    const list = resolvedActivatedScenariosForOpenSession(row, sk)
    const next = pickDisplayChatSceneFromScenarioResult(
      list.length ? { all_active_scenarios: list } : null,
      undefined,
    )
    setRestoredScenarioScene(next && next !== 'ask' && next !== 'chat' ? next : null)
    const mode = chatSceneToSessionMode(next)
    queueMicrotask(() => {
      setSessionMode(mode ?? getSessionModeFromMeta(sk))
      setThinkingLevel(getThinkingLevelFromMeta(selectedSessionKey || ''))
    })
  }, [selectedSessionKey, sessions, setRestoredScenarioScene])

  useEffect(() => {
    suppressedGoalProposalKeysRef.current.clear()
  }, [selectedSessionKey])

  // Refresh/history hydration: hosted proposal + authoritative pending-clarification API
  useEffect(() => {
    if (historyLoading) {
      return
    }
    if (!selectedSessionKey) {
      return
    }
    // 会话切换竞态守卫：切会话瞬间 rows 可能仍残留上一会话的数据，
    // 若用旧会话的 rows 计算 clarification 会污染新会话的 threadPanelState
    // （现象：A 的「询问」串显示到 B）。即时绘制时 rows 来自当前会话的
    // live/idle 缓存（未走 reload），此时 historyBoundSessionKey 为空，放行；
    // 否则要求 rows 已成功绑定当前会话才继续。
    if (!historyInstantPaint && historyBoundSessionKey !== selectedSessionKey) {
      return
    }
    const liveRows = rows || []
    const awaiting = findAskClarificationAwaitingUserInRows(liveRows)
    const rowsHaveAwaitingAsk = !!awaiting?.tool
    const userJustSent =
      selectedTurnBusy && rowsAwaitUserReplyAfterSend(liveRows) && !rowsHaveAwaitingAsk
    const restored = extractLatestClarificationFromRows(liveRows)
    const hostedProp = extractLatestGoalProposalFromRows(liveRows)
    const suppressed = suppressedGoalProposalKeysRef.current
    setThreadPanelState((prev) => {
      const suppressClarify = shouldSuppressClarificationPanel(liveRows, prev)
      let nextHosted: ThreadGoalProposal | null = prev.goalProposal
      if (hostedProp) {
        const k = goalProposalSuppressKey(hostedProp)
        if (suppressed.has(k)) {
          if (prev.goalProposal && goalProposalSuppressKey(prev.goalProposal) === k) {
            nextHosted = null
          }
        } else if (!prev.goalProposal || goalProposalSuppressKey(prev.goalProposal) !== k) {
          nextHosted = hostedProp
        }
      } else {
        nextHosted = null
      }
      const nextClarification = suppressClarify || userJustSent
        ? null
        : mergeThreadPanelClarification(prev.clarification, restored, {
            preferPrevWhileSending: selectedTurnBusy,
            rowsHaveAwaitingAsk,
          })
      return {
        ...prev,
        clarification: nextClarification,
        goalProposal: nextHosted,
      }
    })

    if (userJustSent) {
      return
    }
    const suppressClarify = shouldSuppressClarificationPanel(liveRows, threadPanelStateRef.current)
    if (suppressClarify && !rowsHaveAwaitingAsk) {
      return
    }
    if (!rowsHaveAwaitingAsk && !peekClarificationLatch(selectedSessionKey)) {
      return
    }
    const toolCallId = awaiting?.tool
      ? String(
          (awaiting.tool as { id?: string; tool_call_id?: string }).id ||
            (awaiting.tool as { tool_call_id?: string }).tool_call_id ||
            '',
        ).trim()
      : peekClarificationLatch(selectedSessionKey)
    scheduleClarificationPanelResolve(selectedSessionKey, {
      toolCallId: toolCallId || undefined,
      localTool: awaiting?.tool,
      preferToolRetries: selectedTurnBusy,
    })
  }, [historyLoading, rows, selectedSessionKey, selectedTurnBusy, scheduleClarificationPanelResolve, historyBoundSessionKey, historyInstantPaint])

  // 如果用户在某个会话条目点击"刷新"，先切换会话，再在切换完成后触发 reload。
  useEffect(() => {
    if (!pendingRefreshKey) return
    if (pendingRefreshKey !== selectedSessionKey) return
    queueMicrotask(() => setPendingRefreshKey(null))
    void reload({ bypassCache: true })
  }, [pendingRefreshKey, reload, selectedSessionKey])

  // 点击空白处关闭「···」菜单（须用 click 而非 mousedown：菜单 portal 到 body，mousedown 会先卸菜单导致 click 到不了「删除」）
  useEffect(() => {
    if (!moreMenuKey) return
    const onClick = (e: MouseEvent) => {
      const target =
        e.target instanceof Element
          ? e.target
          : (e.target as Node | null)?.parentElement ?? null
      if (!target) return
      if (
        target.closest(
          '[data-session-more-root], .modal-overlay, .react-chat-session-more-menu, .react-chat-session-context-menu',
        )
      ) {
        return
      }
      setMoreMenuKey(null)
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [moreMenuKey])

  // 「更多」上拉：挂到 body + fixed，避开输入区上拉后父级 overflow 裁切
  useLayoutEffect(() => {
    if (!bottomMoreOpen || typeof window === 'undefined') {
      setBottomMorePortalStyle(null)
      return
    }
    const update = () => {
      const btn = bottomMoreTriggerRef.current
      if (!btn) return
      const r = btn.getBoundingClientRect()
      const gap = 10
      const sidePad = 10
      const minW = 180
      const left = Math.max(sidePad, Math.min(r.left, window.innerWidth - sidePad - minW))
      const bottom = Math.max(sidePad, window.innerHeight - r.top + gap)
      const maxH = Math.max(120, Math.min(window.innerHeight * 0.55, r.top - gap - sidePad))
      setBottomMorePortalStyle({
        position: 'fixed',
        left,
        bottom,
        top: 'auto',
        minWidth: minW,
        maxHeight: maxH,
        zIndex: 10060,
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [bottomMoreOpen])

  // 底部「模式 + 模型/创意/工作空间」上拉：互斥 + 点击外部 / Esc 全部关闭
  // 技能 / 角色已改为独立 modal，不参与此下拉互斥逻辑
  useEffect(() => {
    const anyOpen = modeMenuOpen || bottomModelOpen || bottomPermissionOpen || bottomMoreOpen || bottomWorkspaceOpen
    if (!anyOpen) return
    const closeAll = () => {
      setModeMenuOpen(false)
      setBottomModelOpen(false)
      setBottomPermissionOpen(false)
      setBottomMoreOpen(false)
      setMoreSubOpen(null)
      setBottomWorkspaceOpen(false)
      setBottomRoleOpen(false)
      setBottomSkillOpen(false)
    }
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (!target) return
      // 模式菜单 portal 到 body，需单独识别
      if (target.closest('.react-chat-mode-menu--portal')) return
      if (bottomModelRootRef.current?.contains(target)) return
      if (bottomPermissionRootRef.current?.contains(target)) return
      // 模型菜单 / 右侧 flyout portal 到 body，需单独识别
      if (target.closest('.react-chat-bottom-dropdown--model-portal')) return
      if (target.closest('.react-chat-model-flyout-portal')) return
      if (target.closest('.react-chat-bottom-dropdown--permission-portal')) return
      if (target.closest('.react-chat-permission-card--portal')) return
      if (bottomMoreRootRef.current?.contains(target)) return
      // 「更多」菜单 portal 到 body，需单独识别
      if (target.closest('.react-chat-bottom-dropdown--more-portal')) return
      if (bottomWorkspaceRootRef.current?.contains(target)) return
      closeAll()
    }
    document.addEventListener('mousedown', onDown)
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') closeAll()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [modeMenuOpen, bottomModelOpen, bottomPermissionOpen, bottomMoreOpen, bottomWorkspaceOpen])

  /** 全局技能目录（与技能管理页共用缓存，进入聊天时预拉取） */
  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => setSkillListLoading(true))
    const unsub = subscribeSkillCatalog((rows: SkillPickerRow[]) => {
      if (cancelled) return
      setSkillList(rows.filter((s: SkillPickerRow) => s.enabled !== false))
      setSkillListLoading(false)
    })
    void loadSkillCatalog({ enabledOnly: true }).catch((e) => {
      if (cancelled) return
      toast(`技能列表加载失败：${(e as Error)?.message || e}`, 'error')
      setSkillListLoading(false)
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  /** 会话级粘性技能：切换会话时从 context 恢复，与发送时 preferred_skills 一致 */
  useEffect(() => {
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) {
      setSelectedSkills([])
      return
    }
    const ctx = wsClient.getSessionContext(sk) as {
      preferred_skills?: unknown
      preferred_skill?: unknown
    }
    let names: string[] = []
    if (Array.isArray(ctx?.preferred_skills)) {
      names = ctx.preferred_skills.map((s) => String(s || '').trim()).filter(Boolean)
    } else {
      const one = String(ctx?.preferred_skill || '').trim()
      if (one) names = [one]
    }
    if (!names.length) {
      setSelectedSkills([])
      return
    }
    setSelectedSkills(
      names.map((name) => {
        const hit = skillList.find((s) => s.name === name)
        return hit
          ? { name: hit.name, label: hit.label || hit.name, icon: hit.icon || '🧩' }
          : { name, label: name, icon: '🧩' }
      }),
    )
  }, [selectedSessionKey, skillList])

  useEffect(() => {
    if (!bottomSkillOpen) return
    // 技能弹窗（SkillPickerModal）自带搜索框聚焦与 Esc/遮罩关闭，此处仅作状态同步
  }, [bottomSkillOpen])

  const onGoalClosureReport = useCallback((p: { sessionKey: string; outcome: string; body: string; ts?: number }) => {
    const sk = String(p.sessionKey || '').trim()
    const sessionTitle = sk
      ? (sessionsRef.current.find((s) => String(s.sessionKey || '') === sk)?.title || '').trim()
      : ''
    pushGoalClosureNotification({
      sessionKey: p.sessionKey,
      sessionTitle,
      outcome: p.outcome,
      body: p.body,
      ts: p.ts && p.ts > 0 ? p.ts : Date.now(),
    })
  }, [])

  const onGoalRunningChange = useCallback((running: boolean, sessionKey: string) => {
    const sk = String(sessionKey || '').trim()
    if (!sk) return
    if (running) {
      if (String(sessionRef.current || '').trim() === sk) {
        setLiveTurnAssistantRunId(null)
      }
      return
    }
    if (String(sessionRef.current || '').trim() === sk) {
      setLiveTurnAssistantRunId(null)
    }
  }, [])

  const goal = useGoalMode({
    sessionKey: selectedSessionKey,
    chatModelName: modelName,
    onGoalClosureReport,
    onGoalRunningChange,
    onGoalSendingChange: (sending) => {
      const sk = String(selectedSessionKey || '').trim()
      if (!sk || String(sessionRef.current || '').trim() !== sk) return
      if (sending) {
        // 用户主动再发：清 stop 后的 recovery cooldown，避免新一轮 AG-UI 被丢弃
        clearStreamReattachCooldown(sk)
        dispatchSessionTurnEvent(sk, { type: 'SEND_STARTED', turnStartTs: Date.now() })
      } else {
        dispatchSessionRunEnded(sk)
      }
    },
    // @ts-ignore
    onRefreshChatHistory: async () => {
      const sk = String(sessionRef.current || '').trim()
      await reloadHistoryFromDb({ bypassCache: true, dbOnly: true })
      if (!sk) return
      // 同步后端 execution/state：若 run 已结束但前端仍显示运行中，归位状态
      try {
        const probe = await fetchAndCacheSessionExecutionState(sk)
        const rt = getSessionRuntime(sk)
        const stillBusy = isTurnBusy(rt) || isSessionRuntimeLive(rt)
        const backendDone = probe ? !probe.executing && !probe.goalActive : true
        if (stillBusy && backendDone) {
          clearSessionExecutionProbe(sk)
          dispatchSessionTurnEvent(sk, { type: 'TURN_IDLE' })
        }
      } catch {
        /* best-effort */
      }
    },
    onSendGoalMessage: (prompt, sk) => sendGoalMessageRef.current(prompt, sk),
  })

  /** WS 订阅 effect 依赖项不含 hosted，须用 ref 避免闭包陈旧导致目标自动应用不执行 */
  const goalCaptureRef = useRef(goal.goalCapture)
  const applyGoalProposalRef = useRef(goal.goal.applyGoalProposal)
  const refreshGoalStatusRef = useRef(goal.goal.refreshGoalStatus)
  goalCaptureRef.current = goal.goalCapture
  applyGoalProposalRef.current = goal.goal.applyGoalProposal
  refreshGoalStatusRef.current = goal.goal.refreshGoalStatus
  startGoalRef.current = goal.goal.startGoal
  stopGoalRef.current = goal.goal.stopGoal

  useLayoutEffect(() => {
    goalActiveRef.current = goal.goal.ui.goalActive
  }, [goal.goal.ui.goalActive])

  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('evopanel:goal-ui', {
        detail: { goalActive: !!goal.goal.ui.goalActive },
      }),
    )
  }, [goal.goal.ui.goalActive])

  useEffect(() => {
    const onOpenGoalPanel = (event: Event) => {
      const detail = (event as CustomEvent<{ open?: boolean }>).detail
      if (typeof detail?.open === 'boolean') {
        goal.goal.setPanelOpen(detail.open)
        return
      }
      goal.goal.setPanelOpen((v) => !v)
    }
    window.addEventListener('evopanel:open-goal-panel', onOpenGoalPanel as EventListener)
    // 从其它路由点击悬浮宠物跳转到 /chat 后，自动弹出目标面板
    try {
      if (sessionStorage.getItem('evopanel-open-goal-panel') === '1') {
        sessionStorage.removeItem('evopanel-open-goal-panel')
        goal.goal.setPanelOpen(true)
      }
    } catch {
      /* ignore */
    }
    return () => window.removeEventListener('evopanel:open-goal-panel', onOpenGoalPanel as EventListener)
  }, [goal.goal])

  const scheduleBump = useCallback((opts?: { immediate?: boolean }) => {
    if (
      chatStreamBgApplyRef.current ||
      isChatOverlayDeferActive() ||
      !chatSurfaceVisibleRef.current
    ) {
      if (opts?.immediate) {
        bgRuntimeNotifySchedulerRef.current?.cancelPending?.()
        let sk = String(bgRuntimeNotifySessionRef.current || '').trim()
        if (!sk && !chatSurfaceVisibleRef.current) {
          sk = String(sessionRef.current || '').trim()
        }
        if (sk) bumpSessionRuntimeNotifyForKey(sk, { immediate: true })
      } else {
        bgRuntimeNotifySchedulerRef.current?.schedule(opts)
      }
      return
    }
    if (opts?.immediate) {
      streamBumpSchedulerRef.current?.cancelPending?.()
      reasoningBumpSchedulerRef.current?.cancelPending?.()
      // MessageVirtualList rebuilds the live `_stream` row from streamDisplayTick
      // (not ChatApp streamTick). Skipping the display tick freezes write progress /
      // tool-row labels even though streamRef already has the latest `_writeProgress`.
      bumpStreamDisplayTick()
      bumpStreamChromeThrottled()
      return
    }
    const throttleFloor = isStreamThrottleEnabled()
      ? resolveStreamBumpMinIntervalMs(streamRef.current)
      : STREAM_BUMP_INTERVAL_MS
    streamBumpMinIntervalRef.current = Math.max(
      STREAM_BUMP_INTERVAL_MS,
      throttleFloor,
    )
    streamBumpSchedulerRef.current?.schedule(opts)
  }, [])

  const scheduleReasoningBump = useCallback((opts?: { immediate?: boolean }) => {
    if (
      chatStreamBgApplyRef.current ||
      isChatOverlayDeferActive() ||
      !chatSurfaceVisibleRef.current
    ) {
      if (opts?.immediate) {
        bgRuntimeNotifySchedulerRef.current?.cancelPending?.()
        let sk = String(bgRuntimeNotifySessionRef.current || '').trim()
        if (!sk && !chatSurfaceVisibleRef.current) {
          sk = String(sessionRef.current || '').trim()
        }
        if (sk) bumpSessionRuntimeNotifyForKey(sk, { immediate: true })
      } else {
        bgRuntimeNotifySchedulerRef.current?.schedule(opts)
      }
      return
    }
    if (opts?.immediate) {
      reasoningBumpSchedulerRef.current?.cancelPending?.()
      streamBumpSchedulerRef.current?.cancelPending?.()
      bumpStreamDisplayTick()
      bumpStreamChromeThrottled()
      return
    }
    reasoningBumpSchedulerRef.current?.schedule(opts)
  }, [])
  scheduleBumpRef.current = scheduleBump

  const afterLiveOrStructuralBump = useCallback(
    (
      sessionKey: string,
      stream: StreamState,
      opts: { liveTextOnly: boolean; immediate?: boolean; reasoning?: boolean },
    ) => {
      const sk = String(sessionKey || '').trim()
      if (!sk) return
      const skipLiveUi =
        chatStreamBgApplyRef.current || !chatSurfaceVisibleRef.current
      if (opts.liveTextOnly) {
        if (skipLiveUi) return
        if (opts.immediate) {
          drainLiveStreamTextBatch()
          publishLiveStreamNow(sk, stream, { streaming: true })
          return
        }
        if (scheduleLiveStreamTextPublish(sk)) return
        if (opts.reasoning) scheduleReasoningBump(opts.immediate ? { immediate: true } : undefined)
        else scheduleBump(opts.immediate ? { immediate: true } : undefined)
        return
      }
      if (skipLiveUi) {
        scheduleBump(opts.immediate ? { immediate: true } : undefined)
        return
      }
      prepareLiveStreamStructuralUpdate(sk, stream)
      scheduleBump(opts.immediate ? { immediate: true } : undefined)
    },
    [scheduleBump, scheduleReasoningBump],
  )

  const clearTurnSendingState = useCallback(
    (sessionKey: string, rt: ReturnType<typeof getSessionRuntime>, isBackground: boolean) => {
      // 必须清 activeChatRunId：否则下一轮 run_started(runId 不同)会被 run gate 阻断，
      // turnPhase 停在 idle，后续 delta 全部被 !streamActive 守卫丢弃，流式显示冻结。
      clearActiveRun(rt)
      if (!isBackground) activeChatRunIdRef.current = null
      dispatchSessionRunEnded(sessionKey)
      if (!isBackground) {
        setStreamHealth(null)
        streamHealthRef.current = null
      }
    },
    [],
  )

  const maybeEndTurnSendingState = useCallback(
    (
      sessionKey: string,
      rt: ReturnType<typeof getSessionRuntime>,
      isBackground: boolean,
      opts: { force?: boolean } = {},
    ) => {
      const sk = String(sessionKey || '').trim()
      if (!sk) return
      void maybeClearTurnSendingState({
        sessionKey: sk,
        wsClient,
        force: opts.force,
        onClear: () => {
          clearTurnSendingState(sk, rt, isBackground)
          void refreshSessionsRef.current?.({
            skipAutoReselect: true,
            summariesOnly: isBackground,
          })
        },
        onResume: () => {
          /* 续流仅用户刷新触发；run 仍 active 时保持 turn busy */
        },
      })
    },
    [clearTurnSendingState],
  )

  /** 僵尸 turn busy：reattach/attach 卡住但无新 SSE 事件时自动恢复 idle，避免整页空转。 */
  useEffect(() => {
    if (!selectedTurnBusy) return
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) return
    let cancelled = false
    const timer = window.setInterval(() => {
      if (cancelled || !turnBusyForSession(sk)) return
      const rt = getSessionRuntime(sk)
      const last =
        Number(rt.lastEventAt || 0) ||
        parseTurnTimestampMs(
          sessionsRef.current.find((s) => String(s.sessionKey || '') === sk)?.currentTurnStartedAt,
        ) ||
        0
      if (!last) return
      if (Date.now() - last < 90000) return
      void import('../lib/poll-loop-log.js').then(({ logPollLoopEnd }) => {
        logPollLoopEnd('stale_sending_watchdog', { sessionKey: sk, silentMs: Date.now() - last })
      })
      void maybeClearTurnSendingState({
        sessionKey: sk,
        wsClient,
        onClear: () => clearTurnSendingState(sk, rt, false),
        onResume: () => {
          /* 续流仅用户刷新触发 */
        },
      }).then((result) => {
        if (result === 'cleared' || result === 'forced') {
          void fetchSessionRuntimeStatus(sk).then((st) => {
            if (st?.attachRecommended === false) {
              refreshAttachAttemptedRef.current[sk] = String(st.threadId || wsClient.getSessionThreadId(sk) || '')
            }
          })
        }
      })
    }, 30000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [selectedTurnBusy, selectedSessionKey, clearTurnSendingState])

  /**
   * 全局 stale busy 轮询兜底：不依赖事件，每 15s 扫描所有 busy 会话（含非选中）。
   * 对 lastEventAt 超 45s 无新事件的会话，查 DB 确认是否真的还在运行；
   * DB 说不在运行就强制清理 turn 状态。这是对事件驱动清理的兜底——
   * 事件可能丢失/拦截/跳过，但轮询不会。
   */
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      const busyKeys = listBusySessionKeys()
      for (const sk of busyKeys) {
        const rt = getSessionRuntime(sk)
        const last = Number(rt.lastEventAt || 0)
        if (!last) continue
        if (Date.now() - last < 45000) continue
        invalidateSessionRuntimeStatusCache(sk)
        void maybeEndTurnSendingState(sk, rt, true)
      }
    }, 15000)
    return () => window.clearInterval(timer)
  }, [maybeEndTurnSendingState])

  const loadModelCatalog = useCallback(async (opts?: { silent?: boolean }) => {
    if (modelsLoadInflightRef.current) {
      await modelsLoadInflightRef.current
      return
    }
    const silent = opts?.silent ?? modelCatalogLoadedRef.current
    const applyCatalog = (rowsRaw: any, primaryRaw: string) => {
      const rows = Array.isArray(rowsRaw?.models)
        ? rowsRaw.models
        : Array.isArray(rowsRaw)
          ? rowsRaw
          : []
      const primary = String(primaryRaw || '').trim()
      if (primary) setPrimaryModelName(primary)
      const next = normalizeModelCatalogRows(rows, parseSceneFromModelPayload)
      setModelCatalog(next)
      modelCatalogLoadedRef.current = next.length > 0
      return next
    }
    const work = (async () => {
      // Prefer engineReady prefetch before flipping the label to 「加载中…」.
      if (isDesktopTauriRuntime()) {
        try {
          const prefetchMod = await import('../lib/tauri-api.js')
          const pref = prefetchMod.getModelCatalogPrefetch?.()
          if (pref) {
            const hit = await Promise.race([
              pref.catch(() => null),
              new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 2500)),
            ])
            if (hit?.models) {
              const p = hit.primary
              const primary =
                typeof p?.primary_model === 'string' ? p.primary_model.trim() : ''
              applyCatalog(hit.models, primary)
              if (!silent) setModelsLoading(false)
              // Connections are display-only; never block catalog paint.
              void (async () => {
                try {
                  const api = await getApi()
                  const conns = await api.listModelConnections()
                  const list = Array.isArray(conns) ? conns : (conns?.connections || [])
                  setModelConnNameMap(buildModelConnNameMap(list))
                } catch {
                  /* ignore */
                }
              })()
              return
            }
          }
        } catch {
          /* fall through */
        }
      }

      if (!silent) setModelsLoading(true)
      try {
        const api = await getApi()
        const fetchLive = async () => {
          if (isDesktopTauriRuntime()) {
            const [modelsData, primaryInfo] = await Promise.all([
              api.listModels(),
              api.getPrimaryModel().catch(() => null),
            ])
            return {
              data: modelsData,
              primary:
                typeof primaryInfo?.primary_model === 'string'
                  ? primaryInfo.primary_model.trim()
                  : '',
            }
          }
          const [resp, primaryInfo] = await Promise.all([
            fetch('/api/models'),
            api.getPrimaryModel().catch(() => null),
          ])
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
          const data = await resp.json()
          return {
            data,
            primary:
              typeof primaryInfo?.primary_model === 'string'
                ? primaryInfo.primary_model.trim()
                : '',
          }
        }
        const live = await Promise.race([
          fetchLive(),
          new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 12_000)),
        ])
        if (!live) {
          if (!modelCatalogLoadedRef.current) {
            setModelCatalog([])
            modelCatalogLoadedRef.current = false
          }
          return
        }
        applyCatalog(live.data, live.primary)
        void (async () => {
          try {
            const conns = await api.listModelConnections()
            const list = Array.isArray(conns) ? conns : (conns?.connections || [])
            setModelConnNameMap(buildModelConnNameMap(list))
          } catch {
            /* ignore */
          }
        })()
      } catch {
        if (!modelCatalogLoadedRef.current) {
          setModelCatalog([])
          modelCatalogLoadedRef.current = false
        }
      }
    })()
    modelsLoadInflightRef.current = work
    try {
      await work
    } finally {
      modelsLoadInflightRef.current = null
      if (!silent) setModelsLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchGlobalToolApprovalPolicy().catch(() => {})
  }, [])

  useEffect(() => {
    const onGlobalChanged = () => {
      setToolApprovalPolicyTick((n) => n + 1)
      scheduleRefreshSessions(0)
    }
    const onSessionChanged = () => {
      setToolApprovalPolicyTick((n) => n + 1)
    }
    window.addEventListener(TOOL_APPROVAL_POLICY_CHANGED, onGlobalChanged)
    window.addEventListener(TOOL_APPROVAL_SESSION_POLICY_CHANGED, onSessionChanged)
    return () => {
      window.removeEventListener(TOOL_APPROVAL_POLICY_CHANGED, onGlobalChanged)
      window.removeEventListener(TOOL_APPROVAL_SESSION_POLICY_CHANGED, onSessionChanged)
    }
  }, [scheduleRefreshSessions])

  useEffect(() => {
    if (!selectedSessionKey) return
    let cancelled = false
    void (async () => {
      try {
        const result = await fetchSessionToolApprovalPolicy(selectedSessionKey)
        if (cancelled) return
        wsClient.applySessionToolApprovalPolicy(selectedSessionKey, result)
        setToolApprovalPolicyTick((n) => n + 1)
      } catch {
        /* Gateway 未就绪或会话尚未落库时沿用内存缓存 */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedSessionKey])

  useEffect(() => {
    if (!selectedSessionKey) toolApprovalResolvedIdsRef.current = new Set()
  }, [selectedSessionKey])

  const toolApprovalUiDisabled = useMemo(() => {
    void toolApprovalPolicyTick
    const sk = String(sessionRef.current || selectedSessionKey || '').trim()
    if (!sk) return isEffectiveToolApprovalGrantAll({})
    const ctx = wsClient.getSessionContext(sk) || {}
    return isEffectiveToolApprovalGrantAll(ctx)
  }, [selectedSessionKey, toolApprovalPolicyTick, listLoading])

  async function getApi() {
    if (apiRef.current) return apiRef.current
    const mod = await import('../lib/tauri-api.js')
    apiRef.current = mod.api
    return apiRef.current
  }

  const pickWorkspaceFolder = useCallback(async (): Promise<string | null> => {
    const isDesktop = isDesktopTauriRuntime()
    if (isDesktop) {
      try {
        const dlg = await import('@tauri-apps/plugin-dialog')
        const picked = await dlg.open({
          directory: true,
          multiple: false,
          title: '选择工作空间文件夹',
        })
        const p = Array.isArray(picked) ? picked[0] : picked
        return p ? String(p) : null
      } catch (err) {
        toast(`打开系统目录选择失败：${String((err as Error)?.message || err)}`, 'error')
        return null
      }
    }
    const current = (localWorkspaceRoot || '').trim()
    const next = await promptWorkspacePath(current)
    return next || null
  }, [localWorkspaceRoot])

  const resolveWorkspacePathForSidebar = useCallback(async (raw: string): Promise<string | null> => {
    const trimmed = String(raw || '').trim()
    if (!trimmed) return null
    try {
      const api = await getApi()
      const resolvedInfo = await api.resolveWorkspacePath(trimmed)
      const resolved = String(resolvedInfo?.resolved || trimmed).trim()
      if (!resolved) return null
      if (resolvedInfo && resolvedInfo.exists === false) {
        toast(`目录不存在：${resolved}`, 'error')
        return null
      }
      if (resolvedInfo && resolvedInfo.is_dir === false) {
        toast(`不是文件夹：${resolved}`, 'error')
        return null
      }
      return resolved
    } catch (err) {
      toast(toUserFacingError((err as Error)?.message || err), 'error')
      return null
    }
  }, [])

  const handleNewWorkspace = useCallback(async () => {
    const picked = await pickWorkspaceFolder()
    if (!picked) return
    const resolved = await resolveWorkspacePathForSidebar(picked)
    if (!resolved) return
    try {
      await wsClient.registerGlobalWorkspacePath(resolved)
      setGlobalWorkspaceHistory(wsClient.getGlobalWorkspaceHistory())
      shellIntentWorkspaceRef.current = resolved
      window.dispatchEvent(
        new CustomEvent('evopanel:shell-expand-workspace', {
          detail: { workspaceKey: normalizeWorkspacePathKey(resolved) },
        }),
      )
      toast(`已添加工作空间：${_pathBasename(resolved)}`, 'success')
    } catch (err) {
      toast(toUserFacingError((err as Error)?.message || err), 'error')
    }
  }, [pickWorkspaceFolder, resolveWorkspacePathForSidebar])

  /** 把当前会话绑到项目目录（没有会话则新建） */
  const bindCurrentSessionToWorkspace = useCallback(
    async (workspacePath: string) => {
      const resolved = await resolveWorkspacePathForSidebar(workspacePath)
      if (!resolved) return
      const sk = String(selectedSessionKey || sessionRef.current || '').trim()
      try {
        await wsClient.registerGlobalWorkspacePath(resolved)
        setGlobalWorkspaceHistory(wsClient.getGlobalWorkspaceHistory())
        if (!sk) {
          startNewSessionWithWorkspace(resolved)
          setBottomWorkspaceOpen(false)
          return
        }
        await wsClient.bindSessionWorkspace(sk, resolved, { userPinned: true })
        setLocalWorkspaceRoot(resolved)
        shellIntentWorkspaceRef.current = resolved
        window.dispatchEvent(
          new CustomEvent('evopanel:shell-expand-workspace', {
            detail: { workspaceKey: normalizeWorkspacePathKey(resolved) },
          }),
        )
        window.dispatchEvent(
          new CustomEvent('evopanel:session-workspace-changed', {
            detail: { sessionKey: sk, local_workspace_root: resolved },
          }),
        )
        setBottomWorkspaceOpen(false)
        toast(`已切换工作空间：${_pathBasename(resolved)}`, 'success')
      } catch (err) {
        toast(toUserFacingError((err as Error)?.message || err), 'error')
      }
    },
    [resolveWorkspacePathForSidebar, selectedSessionKey],
  )

  const pickAndBindCurrentWorkspace = useCallback(async () => {
    const picked = await pickWorkspaceFolder()
    if (!picked) return
    await bindCurrentSessionToWorkspace(picked)
  }, [pickWorkspaceFolder, bindCurrentSessionToWorkspace])

  const pickAndStartNewSessionWithWorkspace = useCallback(async () => {
    const picked = await pickWorkspaceFolder()
    if (!picked) return
    const resolved = await resolveWorkspacePathForSidebar(picked)
    if (!resolved) return
    try {
      await wsClient.registerGlobalWorkspacePath(resolved)
      setGlobalWorkspaceHistory(wsClient.getGlobalWorkspaceHistory())
    } catch {
      /* still create */
    }
    setBottomWorkspaceOpen(false)
    startNewSessionWithWorkspace(resolved)
    toast(`已在「${_pathBasename(resolved)}」新建对话`, 'success')
  }, [pickWorkspaceFolder, resolveWorkspacePathForSidebar])

  const clearCurrentSessionWorkspace = useCallback(async () => {
    const sk = String(selectedSessionKey || sessionRef.current || '').trim()
    try {
      if (sk) {
        await wsClient.updateSessionContext(sk, {
          local_workspace_root: null,
          workspace_user_pinned: false,
        })
      }
      setLocalWorkspaceRoot('')
      shellIntentWorkspaceRef.current = null
      setBottomWorkspaceOpen(false)
      toast('已切回默认工作空间（应用数据目录）', 'success')
    } catch (err) {
      toast(toUserFacingError((err as Error)?.message || err), 'error')
    }
  }, [selectedSessionKey])

  const openCurrentWorkspaceInFileManager = useCallback(async () => {
    const raw = String(localWorkspaceRoot || runtimeDataDir || '').trim()
    if (!raw) {
      toast('没有可打开的本地目录', 'info')
      return
    }
    try {
      const { api } = await import('../lib/tauri-api.js')
      const resolvedInfo = await api.resolveWorkspacePath(raw)
      const resolved = String(resolvedInfo?.resolved || raw).trim()
      await api.revealPathInFileManager(resolved)
      toast('已在文件管理器中打开', 'success')
    } catch (e) {
      toast(String((e as Error)?.message || e), 'error')
    }
  }, [localWorkspaceRoot, runtimeDataDir])

  const handleOpenWorkspaceFolder = useCallback(
    async (group: ShellWorkspaceGroup) => {
      let raw = resolveShellGroupWorkspacePath(group, globalWorkspaceHistory)
      if (!raw && group.workspaceKey === WORKSPACE_GROUP_UNBOUND) {
        raw = String(runtimeDataDir || '').trim()
      }
      if (!raw) {
        toast('该工作空间没有可打开的本地文件夹', 'info')
        return
      }
      try {
        const { api } = await import('../lib/tauri-api.js')
        const resolvedInfo = await api.resolveWorkspacePath(raw)
        const resolved = String(resolvedInfo?.resolved || raw).trim()
        if (!resolved) {
          toast('无法解析文件夹路径', 'error')
          return
        }
        if (resolvedInfo?.exists === false) {
          toast(`目录不存在：${resolved}`, 'error')
          return
        }
        if (resolvedInfo?.is_dir === false) {
          toast(`不是文件夹：${resolved}`, 'error')
          return
        }
        await api.revealPathInFileManager(resolved)
        toast(
          group.workspaceKey === WORKSPACE_GROUP_UNBOUND
            ? '已打开默认数据目录'
            : '已在文件管理器中打开',
          'success',
        )
      } catch (e) {
        toast(String((e as Error)?.message || e), 'error')
      }
    },
    [globalWorkspaceHistory, runtimeDataDir],
  )

  const deleteWorkspaceInflightRef = useRef(false)

  const handleDeleteWorkspaceGroup = useCallback(
    async (group: ShellWorkspaceGroup) => {
      if (deleteWorkspaceInflightRef.current) return
      const workspaceKey = group.workspaceKey
      if (isSpecialWorkspaceGroupKey(workspaceKey)) {
        return
      }

      const removePath =
        String(group.path || '').trim() ||
        (!isSpecialWorkspaceGroupKey(workspaceKey) ? workspaceKey : '')
      const count = group.sessionCount || 0
      const label = group.label || removePath
      const confirmMsg =
        count > 0
          ? `该目录下还有 ${count} 个会话，是否一并删除？\n\n工作空间：${label}\n此操作不可恢复。`
          : `从侧栏移除工作空间「${label}」？\n\n无会话，仅删除历史记录。`

      deleteWorkspaceInflightRef.current = true
      try {
        const yes = await showConfirm(confirmMsg)
        if (!yes) return

        const { api } = await import('../lib/tauri-api.js')
        const allKeys: string[] = []
        let offset = 0
        for (;;) {
          const data = await api.chatSessionsList(SESSION_LIST_PAGE_SIZE, offset, workspaceKey)
          const apiRows = (data?.sessions || []) as ChatSessionRow[]
          for (const s of stripDefaultMainSessionRows(apiRows)) {
            const k = String(s.sessionKey || '').trim()
            if (k) allKeys.push(k)
          }
          if (apiRows.length < SESSION_LIST_PAGE_SIZE) break
          offset += apiRows.length
        }

        const keysSet = new Set(allKeys)
        const viewingDeleted = !!sessionRef.current && keysSet.has(sessionRef.current)

        if (allKeys.length > 0) {
          for (const k of allKeys) {
            removeSessionFromList(k)
            clearSessionRuntime(k)
            deleteLiveStream(k)
            seenArtifactsRef.current.delete(k)
          }
        }

        if (viewingDeleted) {
          sessionRef.current = ''
          setSelectedSessionKey('')
          setNewChatButtonActive(true)
          streamRef.current = emptyStream()
          seenRunIdsRef.current = new Set()
          rowsRef.current = []
          setRows([])
          setTokenTotals(null)
          setLiveTurnTokens(null)
          setSubagentDockTasks({})
          setSidebarTaskViews({})
          setSidebarSelectedTaskId(null)
          setThreadPanelState(emptyThreadPanel())
          setHasReceivedTodos(false)
          setBoundTaskId(null)
          bumpStreamFullRef.current()
        }

        for (const k of allKeys) {
          composerDraftsRef.current.delete(k)
          await api.chatSessionsDelete(k, { clearWorkspaceHistory: false })
        }

        if (removePath) {
          await wsClient.removeWorkspaceHistoryPath(removePath)
        }
        setGlobalWorkspaceHistory((prev) =>
          prev.filter((p) => normalizeWorkspacePathKey(p) !== workspaceKey),
        )
        purgeWorkspaceFromSidebar(workspaceKey, { skipSessions: allKeys.length > 0 })

        const expanded = loadExpandedWorkspaceKeys()
        expanded.delete(workspaceKey)
        saveExpandedWorkspaceKeys(expanded)

        await refreshSessions({ skipAutoReselect: true, summariesOnly: true })
        toast(
          count > 0 ? `已删除工作空间及 ${count} 个会话` : '已从侧栏移除工作空间',
          'success',
        )
      } catch (err) {
        toast(toUserFacingError((err as Error)?.message || err), 'error')
      } finally {
        deleteWorkspaceInflightRef.current = false
      }
    },
    [
      refreshSessions,
      purgeWorkspaceFromSidebar,
      removeSessionFromList,
      setGlobalWorkspaceHistory,
      setNewChatButtonActive,
      setSelectedSessionKey,
    ],
  )

  async function reconcileCollabWithMode(sessionKey: string) {
    const api = await getApi()
    const on = getSessionCollabModeFromMeta(sessionKey)
    if (on) {
      await api.chatUpdateContext(sessionKey, {
        subagent_enabled: true,
        is_plan_mode: true,
        collab_phase: 'planning',
        collab_task_id: null,
      })
    } else {
      await api.chatUpdateContext(sessionKey, { collab_phase: 'idle', collab_task_id: null })
      // 与 toggleCollab(off) 一致：把磁盘 thread collab 拉回 idle，否则中间件仍按 planning 注入 <collab_phase_context>
      const threadId = await wsClient.ensureChatThread(sessionKey)
      if (threadId) {
        try {
          await wsClient.putThreadCollabState(threadId, { collab_phase: 'idle', bound_task_id: null })
        } catch {
          /* ignore */
        }
      }
    }
  }

  async function applySessionModePreset(sessionKey: string, mode: SessionMode) {
    const api = await getApi()
    const scenario = MODE_TO_SCENARIO[mode] ?? null
    // 通过场景接口设置 activated_scenarios（chat/workspace/plan/null=auto）
    await api.setSessionScenario(sessionKey, scenario)
    // 兼容旧 context 字段：同步 session_mode（后端中间件仍可能读取）；思考由后端 AUTO 决策，不传 thinking_enabled
    const contextUpdate: Record<string, any> = { session_mode: mode, thinking_type: 'auto', thinking_enabled: null, reasoning_effort: null }
    // 切换模式时重置思考等级为自动
    setThinkingLevel('auto')
    setThinkingLevelInMeta(sessionKey, 'auto')
    // 同步本地 ws-client session context
    wsClient.updateSessionContext(sessionKey, contextUpdate)
    if (mode === 'plan') {
      contextUpdate.is_plan_mode = true
      contextUpdate.subagent_enabled = true
      contextUpdate.collab_phase = 'planning'
    } else {
      contextUpdate.is_plan_mode = false
      contextUpdate.subagent_enabled = false
    }
    await api.chatUpdateContext(sessionKey, contextUpdate)
    // plan 模式需要同步协作状态
    if (mode === 'plan') {
      if (!getSessionCollabModeFromMeta(sessionKey)) {
        setSessionCollabModeInMeta(sessionKey, true)
        setCollabOn(true)
      }
      await applyCollabServerPatch(sessionKey, true)
    } else {
      if (getSessionCollabModeFromMeta(sessionKey)) {
        setSessionCollabModeInMeta(sessionKey, false)
        setCollabOn(false)
        await applyCollabServerPatch(sessionKey, false)
      }
    }
    await reconcileCollabWithMode(sessionKey)
  }

  async function applyThinkingLevel(sessionKey: string, level: ThinkingLevel) {
    if (!sessionKey) return
    setThinkingLevelInMeta(sessionKey, level)
    setThinkingLevel(level)
    const api = await getApi()
    let contextUpdate: Record<string, any>
    if (level === 'auto') {
      // auto 模式：交回后端 AUTO 决策
      contextUpdate = { thinking_type: 'auto', thinking_enabled: null, reasoning_effort: null }
      toast('思考模式：自动（由后端决策）', 'success')
    } else if (level === 'off') {
      contextUpdate = { thinking_type: 'manual', thinking_enabled: false, reasoning_effort: 'minimum' }
      toast('思考模式：关闭', 'success')
    } else {
      const effortMap: Record<string, string> = { low: 'low', medium: 'medium', high: 'high' }
      contextUpdate = {
        thinking_type: 'manual',
        thinking_enabled: true,
        reasoning_effort: effortMap[level] || 'medium',
      }
      toast(`思考模式：${level === 'low' ? '轻度' : level === 'medium' ? '中度' : '深度'}思考`, 'success')
    }
    // 同步本地 ws-client session context（chatSend 从本地读取构建 runContext）
    wsClient.updateSessionContext(sessionKey, contextUpdate)
    // 同步后端 DB
    await api.chatUpdateContext(sessionKey, contextUpdate)
  }

  async function applyCollabServerPatch(sessionKey: string, on: boolean) {
    const threadId = on
      ? await wsClient.ensureChatThread(sessionKey)
      : (await wsClient.ensureChatThread(sessionKey).catch(() => wsClient.getSessionThreadId(sessionKey)))
    if (!threadId) return
    if (on) {
      const collab = await wsClient.putThreadCollabState(threadId, { collab_phase: 'planning' })
      const boundTaskId =
        collab && typeof collab.bound_task_id === 'string' && collab.bound_task_id.trim()
          ? collab.bound_task_id.trim()
          : ''
      if (boundTaskId) {
        try {
          const api = await getApi()
          await api.chatUpdateContext(sessionKey, {
            collab_task_id: boundTaskId,
            is_plan_mode: true,
            collab_phase: 'planning',
          })
        } catch {
          /* ignore */
        }
      }
    } else {
      await wsClient.putThreadCollabState(threadId, {
        collab_phase: 'idle',
        bound_task_id: null,
      })
    }
  }

  async function setCollabPhaseForSession(sessionKey: string, phase: 'planning' | 'executing' | 'idle') {
    const api = await getApi()
    await api.chatUpdateContext(sessionKey, { collab_phase: phase })
    const threadId = await wsClient.ensureChatThread(sessionKey)
    if (!threadId) return
    if (phase === 'idle') {
      await wsClient.putThreadCollabState(threadId, { collab_phase: 'idle', bound_task_id: null })
      return
    }
    await wsClient.putThreadCollabState(threadId, { collab_phase: phase })
  }

  async function setSessionModeAndApply(mode: SessionMode) {
    if (mode === sessionMode) return
    setSessionMode(mode)
    const key = sessionRef.current || selectedSessionKey
    if (!key) {
      toast(`已切换为：${modeLabel(mode, dynamicModes || DEFAULT_SESSION_MODES)}`, 'success')
      return
    }
    setSessionModeInMeta(key, mode)
    try {
      await applySessionModePreset(key, mode)
      toast(`已切换为：${modeLabel(mode, dynamicModes || DEFAULT_SESSION_MODES)}`, 'success')
    } catch (e) {
      toast(`切换模式失败: ${String((e as Error)?.message || e)}`, 'error')
    }
  }

  // toggleCollab removed (unused)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      let wantNew = false
      let wantHome = false
      let code = ''
      let pendingDraft = ''
      try {
        wantNew = sessionStorage.getItem('evopanel_pending_new_session') === '1'
        if (wantNew) sessionStorage.removeItem('evopanel_pending_new_session')
        wantHome = sessionStorage.getItem('evopanel_pending_open_home') === '1'
        if (wantHome) sessionStorage.removeItem('evopanel_pending_open_home')
        code = String(sessionStorage.getItem('evopanel_pending_agent_switch') || '').trim()
        if (code) sessionStorage.removeItem('evopanel_pending_agent_switch')
        pendingDraft = String(sessionStorage.getItem('evopanel_pending_composer_draft') || '').trim()
        if (pendingDraft) sessionStorage.removeItem('evopanel_pending_composer_draft')
      } catch {
        return
      }
      if (wantNew) await handleNewSessionRef.current?.()
      else if (wantHome) await handleOpenHomeRef.current?.()
      if (cancelled) return
      if (code) {
        try {
          await startNewChatWithPresetAgent(code)
        } catch {
          /* ignore */
        }
      }
      if (cancelled || !pendingDraft) return
      restoreComposerDraft(pendingDraft)
    })()
    return () => {
      cancelled = true
    }
  }, [restoreComposerDraft])

  useEffect(() => {
    try {
      localStorage.removeItem('evopanel-chat-selected-session')
    } catch {
      /* ignore */
    }
    if (!wsClient.connected) wsClient.connect()
    void loadModelCatalog()
    // 从后端加载模式定义（动态控制显示项）
    void (async () => {
      try {
        const api = await getApi()
        const resp = await api.getSessionModes()
        if (resp?.modes && Array.isArray(resp.modes)) {
          setDynamicModes(
            resp.modes.map((m: any) => ({
              value: String(m.value || ''),
              label: String(m.label || m.value || ''),
              visible: m.visible !== false,
              scenario: m.scenario ?? null,
            })),
          )
        }
      } catch {
        /* 降级使用 DEFAULT_SESSION_MODES */
      }
    })()
    // Let /messages + /models win the first seconds after mount (stdio/GIL contention).
    scheduleRefreshSessions(1500)
    const u1 = wsClient.onReady(() => {
      scheduleRefreshSessions(1800)
    })

    // 后台派发/值班新建员工会话时推 panel:session_upserted → 侧栏重拉
    // 窗口隐藏时断开 shell panel SSE，避免 Mac 后台仍保活重连。
    let unsubShellPanel: (() => void) | null = null
    let shellPanelCancelled = false
    const disconnectShellPanel = () => {
      try {
        unsubShellPanel?.()
      } catch {
        /* ignore */
      }
      unsubShellPanel = null
    }
    const connectShellPanel = () => {
      if (shellPanelCancelled) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      disconnectShellPanel()
      void import('../lib/ws-client.js').then(({ subscribeThreadPanelSse }) => {
        if (shellPanelCancelled) return
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        unsubShellPanel = subscribeThreadPanelSse('__evopanel_shell__', (dataJson: string) => {
          try {
            const ev = JSON.parse(String(dataJson || '{}'))
            if (String(ev?.type || '').trim() !== 'panel:session_upserted') return
            scheduleRefreshSessionsRef.current?.(250)
            window.dispatchEvent(new CustomEvent('evopanel:shell-sessions-mutated'))
          } catch {
            /* ignore */
          }
        })
      })
    }
    const onShellPanelVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        disconnectShellPanel()
      } else {
        connectShellPanel()
      }
    }
    connectShellPanel()
    document.addEventListener('visibilitychange', onShellPanelVisibility)
    
    // 监听会话名称更新事件
    const onNameUpdate = (ev?: Event) => {
      setSessionNamesTick((t) => t + 1)
      const detail = (ev as CustomEvent<{ sessionKey?: string; title?: string }> | undefined)?.detail
      const sk = String(detail?.sessionKey || '').trim()
      const title = String(detail?.title || '').trim()
      if (sk && title) {
        setSessions((prev) => patchSessionTitleInRows(prev, sk, title))
        return
      }
      setSessions((prev) => {
        let changed = false
        const next = prev.map((s) => {
          const key = String(s.sessionKey || '').trim()
          if (!key) return s
          const picked = pickSessionRowTitle(key, s.title, s.title)
          if (picked && picked !== s.title) {
            changed = true
            return { ...s, title: picked }
          }
          return s
        })
        return changed ? next : prev
      })
    }
    window.addEventListener('session-name-updated', onNameUpdate)

    const onThreadRebound = (ev: Event) => {
      const detail = (ev as CustomEvent<{ sessionKey?: string; threadId?: string }>).detail
      const sk = String(detail?.sessionKey || '').trim()
      const tid = String(detail?.threadId || '').trim()
      if (!sk || !tid) return
      setSessions((prev) =>
        prev.map((s) => (String(s.sessionKey || '') === sk ? { ...s, threadId: tid } : s)),
      )
      scheduleRefreshSessions(300)
    }
    window.addEventListener('evopanel:session-thread-rebound', onThreadRebound)

    const onPanelTitleUpdated = (ev: Event) => {
      const detail = (ev as CustomEvent<{ sessionKey?: string; title?: string }>).detail
      const sk = String(detail?.sessionKey || '').trim()
      const title = String(detail?.title || '').trim()
      if (!sk || !title || isPlaceholderSessionTitle(title)) return
      setSessionTitle(sk, title)
      setSessions((prev) => patchSessionTitleInRows(prev, sk, title))
    }
    window.addEventListener('evopanel:session-title-updated', onPanelTitleUpdated)

    const onModelsUpdated = () => {
      void loadModelCatalog({ silent: true })
    }
    const onMediaUpdated = () => {
      refreshSpeechConfigured()
    }
    const onChatRouteShown = () => {
      setChatSurfaceVisible(true)
      try {
        const host = document.getElementById('chat-persistent-host')
        if (host) {
          host.hidden = false
          host.style.display = 'flex'
        }
      } catch {
        /* ignore */
      }
      void loadModelCatalog({ silent: true })
      refreshSpeechConfigured()
    }
    refreshSpeechConfigured()
    window.addEventListener('evopanel:models-updated', onModelsUpdated)
    window.addEventListener('evopanel:media-updated', onMediaUpdated)
    window.addEventListener('evopanel:chat-route-shown', onChatRouteShown)
    
    return () => {
      shellPanelCancelled = true
      u1()
      document.removeEventListener('visibilitychange', onShellPanelVisibility)
      disconnectShellPanel()
      window.removeEventListener('session-name-updated', onNameUpdate)
      window.removeEventListener('evopanel:session-thread-rebound', onThreadRebound)
      window.removeEventListener('evopanel:session-title-updated', onPanelTitleUpdated)
      window.removeEventListener('evopanel:models-updated', onModelsUpdated)
      window.removeEventListener('evopanel:media-updated', onMediaUpdated)
      window.removeEventListener('evopanel:chat-route-shown', onChatRouteShown)
    }
  }, [refreshSessions, scheduleRefreshSessions, loadModelCatalog, refreshSpeechConfigured])

  useEffect(() => {
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) return
    const row = sessions.find((s) => String(s.sessionKey || '') === sk)
    const tid = String(wsClient.getSessionThreadId(sk) || row?.threadId || '').trim()
    if (!tid) return
    let cancelled = false
    let unsubPanel: (() => void) | null = null
    const disconnectPanel = () => {
      try {
        unsubPanel?.()
      } catch {
        /* ignore */
      }
      unsubPanel = null
    }
    const connectPanel = () => {
      if (cancelled) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      disconnectPanel()
      void import('../lib/ws-client.js').then(({ subscribeThreadPanelSse }) => {
        if (cancelled) return
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        unsubPanel = subscribeThreadPanelSse(tid, (dataJson: string) => {
          try {
            const ev = JSON.parse(String(dataJson || '{}'))
            if (String(ev?.type || '').trim() !== 'panel:title_updated') return
            const data = ev?.data && typeof ev.data === 'object' ? ev.data : {}
            const title = String(data.title || '').trim()
            const sessionKey = String(data.session_key || data.sessionKey || sk).trim()
            if (!title || !sessionKey) return
            window.dispatchEvent(
              new CustomEvent('evopanel:session-title-updated', {
                detail: { sessionKey, title },
              }),
            )
          } catch {
            /* ignore malformed panel SSE */
          }
        })
      })
    }
    const onVis = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        disconnectPanel()
      } else {
        connectPanel()
      }
    }
    connectPanel()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVis)
      disconnectPanel()
    }
  }, [selectedSessionKey, sessions])

  useEffect(() => {
    if (modelsLoading || !modelCatalog.length) return

    if (!selectedSessionKey) {
      syncModelSessionPrevKeyRef.current = null
      const def = followResolvedModelName || defaultModelFromCatalog(modelCatalog, primaryModelName)
      if (def) {
        queueMicrotask(() => setModelName((prev) => ((prev || '').trim() === def ? prev : def)))
      }
      return
    }

    if (listLoading) return

    const sk = selectedSessionKey
    syncModelSessionPrevKeyRef.current = sk

    const stored = sessionModelOverride
    // 后端 stored 是用户选择模型的权威值：非空时一律保留（无论是否在当前 catalog 内），
    // 避免 catalog 暂时不全/加载竞态时兜底成 primary 后无法回到用户实际选择的模型。
    // 仅当 stored 为空（跟随智能体）时用智能体默认 → primary 做 UI 展示；
    // 切勿把展示回落写回后端。
    if (!stored && modelHydrateAttemptedRef.current !== sk) {
      // 等按 key 拉取真实行完成后再决定是否跟随，避免刷新瞬间误判
      return
    }
    const desired = stored || followResolvedModelName
    if (!desired) return

    setModelName((prev) => ((prev || '').trim() === desired ? prev : desired))
  }, [
    selectedSessionKey,
    modelCatalog,
    modelsLoading,
    primaryModelName,
    listLoading,
    sessions,
    modelHydrateTick,
    sessionModelOverride,
    followResolvedModelName,
  ])

  // 刷新/分页竞态：选中会话不在当前页或仅为占位行时，按 key 拉真实行以恢复 model_name
  useEffect(() => {
    const sk = String(selectedSessionKey || '').trim()
    if (!sk || listLoading) return

    const row = sessionsRef.current.find((s) => String(s.sessionKey || '') === sk)
    const rowModel = String(row?.modelName || '').trim()
    const ctxModel = String(wsClient.getSessionContext(sk)?.model_name ?? '').trim()
    if (rowModel || ctxModel) {
      if (modelHydrateAttemptedRef.current !== sk) {
        modelHydrateAttemptedRef.current = sk
        setModelHydrateTick((n) => n + 1)
      }
      return
    }
    if (modelHydrateAttemptedRef.current === sk) return
    if (modelHydrateInflightRef.current === sk) return
    modelHydrateInflightRef.current = sk

    let cancelled = false
    void (async () => {
      try {
        const { api } = await import('../lib/tauri-api.js')
        const got = await api.chatSessionsGet(sk)
        if (cancelled) return
        if (got) {
          const next = sessionRowFromApi(got as ChatSessionRow & { key?: string })
          if (next.sessionKey) {
            setSessions((prev) => {
              const rest = prev.filter((s) => String(s.sessionKey || '') !== next.sessionKey)
              return sortSessionsForSidebar([next, ...rest])
            })
          }
        }
      } catch {
        /* ignore — UI 回落 primary，且不会写回后端 */
      } finally {
        if (modelHydrateInflightRef.current === sk) modelHydrateInflightRef.current = null
        if (!cancelled) {
          modelHydrateAttemptedRef.current = sk
          setModelHydrateTick((n) => n + 1)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedSessionKey, listLoading, sessionsRef, setSessions])

  useEffect(() => {
    if (!selectedSessionKey) return
    if (listLoading) return
    const row = sessions.find((s) => String(s.sessionKey || '') === selectedSessionKey)
    queueMicrotask(() => {
      setSessionMode(resolveSessionModeForSession(selectedSessionKey, row))
      setCollabOn(getSessionCollabModeFromMeta(selectedSessionKey))
    })
  }, [selectedSessionKey, listLoading, sessions])

  useEffect(() => {
    if (!selectedSessionKey) return
    const ctx = wsClient.getSessionContext(selectedSessionKey) as { memory_enabled?: boolean } | undefined
    queueMicrotask(() => setMemoryEnabled(ctx?.memory_enabled !== false))
  }, [selectedSessionKey, sessions, listLoading])

  useEffect(() => {
    if (!bottomModelOpen) return
    if (modelsLoading) return
    if (modelCatalog.length > 0) return
    void loadModelCatalog()
  }, [bottomModelOpen, modelCatalog.length, modelsLoading, loadModelCatalog])

  const effectiveModelName = useMemo(() => {
    if (modelsLoading && !modelCatalog.length) return ''
    const pill = (modelName || '').trim()
    // 保留会话已选 / 当前展示模型（即使 catalog 暂未就绪），避免刷新时瞬时回落成 primary
    if (pill) return pill
    return followResolvedModelName || defaultModelFromCatalog(modelCatalog, primaryModelName)
  }, [modelName, modelCatalog, primaryModelName, modelsLoading, followResolvedModelName])

  const modelPillLabel = useMemo(() => {
    if (modelsLoading && !modelCatalog.length) return '加载中…'
    const pill = (modelName || '').trim()
    if (pill) {
      const entry = modelCatalog.find((m) => m.name === pill)
      return modelDisplayLabel(entry) || pill
    }
    if (effectiveModelName) {
      const entry = modelCatalog.find((m) => m.name === effectiveModelName)
      return modelDisplayLabel(entry) || effectiveModelName
    }
    const fallback = modelCatalog[0]
    if (fallback) return modelDisplayLabel(fallback) || fallback.name
    return primaryModelName.trim() || '默认模型'
  }, [modelName, effectiveModelName, modelsLoading, primaryModelName, modelCatalog])

  /** null：尚未知（列表未加载或所选名不在目录）；true/false：是否支持多模态用户图（config supports_vision） */
  const effectiveModelSupportsVision = useMemo(() => {
    if (!modelCatalog.length || !effectiveModelName) return null
    const row = modelCatalog.find((m) => m.name === effectiveModelName)
    if (!row) return null
    return row.supportsVision
  }, [modelCatalog, effectiveModelName])

  /** 当前模型是否支持思考（null=未知，用于决定思考等级菜单是否展示） */
  const effectiveModelSupportsThinking = useMemo(() => {
    if (!modelCatalog.length || !effectiveModelName) return null
    const row = modelCatalog.find((m) => m.name === effectiveModelName)
    if (!row) return null
    return row.supportsThinking ?? false
  }, [modelCatalog, effectiveModelName])

  // modelPillTitle removed (unused)
  const handleEnhancePrompt = useCallback(async (draft: string) => {
    const text = String(draft || '').trim()
    if (!text) return null
    const recent = recentTranscriptForPromptEnhance(rowsRef.current)
    try {
      const { text: enhanced } = await wsClient.enhancePrompt(
        text,
        effectiveModelName || undefined,
        recent.length ? recent : undefined,
        selectedSessionKey || sessionRef.current || undefined,
      )
      const next = String(enhanced || '').trim()
      if (!next || next === text) {
        toast('提示词已足够清晰', 'info')
        return text
      }
      toast('已优化提示词', 'success')
      return next
    } catch (err) {
      const e = err as Error & { status?: number }
      const msg = String(e?.message || err || '优化失败').toLowerCase()
      if (e?.status === 404 || msg.includes('not found')) {
        toast('提示词优化功能暂不可用，请稍后重试', 'error')
      } else {
        toast(toUserFacingError(e?.message || err, '优化失败，请稍后重试'), 'error')
      }
      return null
    }
  }, [effectiveModelName, selectedSessionKey])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const api = await getApi()
        const [agentResult] = await Promise.all([api.listAgents()])
        if (cancelled) return
        const list = Array.isArray(agentResult) ? agentResult : agentResult?.agents || []
        setAgents(
          list.map((a: AgentPickerRow) => ({
            ...a,
            agent_code: String(a?.agent_code || '').trim(),
            skills: Array.isArray(a?.skills)
              ? a.skills.map((s) => String(s || '').trim()).filter(Boolean)
              : [],
            tools: Array.isArray(a?.tools)
              ? a.tools.map((t) => String(t || '').trim()).filter(Boolean)
              : null,
            mcp_servers: Array.isArray(a?.mcp_servers)
              ? a.mcp_servers.map((m) => String(m || '').trim()).filter(Boolean)
              : null,
            knowledge_vault_ids: Array.isArray(a?.knowledge_vault_ids)
              ? a.knowledge_vault_ids.map((k) => String(k || '').trim()).filter(Boolean)
              : [],
          })),
        )
        setAgentsDisplayCache(list)
      } catch {
        if (!cancelled) {
          setAgents([])
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const refreshAgentsList = useCallback(async () => {
    try {
      const api = await getApi()
      const agentResult = await api.listAgents()
      const list = Array.isArray(agentResult) ? agentResult : agentResult?.agents || []
      const mapped = list.map((a: AgentPickerRow) => ({
        ...a,
        agent_code: String(a?.agent_code || '').trim(),
        skills: Array.isArray(a?.skills)
          ? a.skills.map((s) => String(s || '').trim()).filter(Boolean)
          : [],
        tools: Array.isArray(a?.tools)
          ? a.tools.map((t) => String(t || '').trim()).filter(Boolean)
          : null,
        mcp_servers: Array.isArray(a?.mcp_servers)
          ? a.mcp_servers.map((m) => String(m || '').trim()).filter(Boolean)
          : null,
        knowledge_vault_ids: Array.isArray(a?.knowledge_vault_ids)
          ? a.knowledge_vault_ids.map((k) => String(k || '').trim()).filter(Boolean)
          : [],
      }))
      setAgents(mapped)
      setAgentsDisplayCache(list)
      setRoleUiNonce((n) => n + 1)
    } catch {
      /* keep previous agents */
    }
  }, [])

  useEffect(() => {
    let unsub: (() => void) | undefined
    let cancelled = false
    void import('../lib/tauri-api.js').then(async (mod) => {
      const initial = mod.isBackendReady()
      if (initial === true) setEngineReady(true)
      else if (initial === false) setEngineReady(false)
      else {
        // 尚未探测：先拉一次，避免 UI-first 下误开发送
        try {
          const ok = await mod.checkBackendReady()
          if (!cancelled) setEngineReady(!!ok)
        } catch {
          if (!cancelled) setEngineReady(false)
        }
      }
      unsub = mod.onBackendReadyChange((v) => {
        setEngineReady(!!v)
        if (v) void refreshAgentsList()
      })
    })
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [refreshAgentsList])

  const patchCurrentAgentCapabilities = useCallback(
    async (patch: {
      skills?: string[]
      tools?: string[] | null
      mcp_servers?: string[] | null
      knowledge_vault_ids?: string[]
    }) => {
      const code = String(
        (isProactiveEmployeeSession ? employeeSessionAgentCode : '') || currentRoleCodeForUi || '',
      ).trim()
      if (!code) {
        toast('当前没有可编辑的智能体', 'warning')
        return
      }
      setCapabilityPatchBusy(true)
      try {
        const api = await getApi()
        const agentPatch: Record<string, unknown> = {}
        if (patch.skills !== undefined) agentPatch.skills = patch.skills
        if (patch.tools !== undefined) agentPatch.tools = patch.tools
        if (patch.mcp_servers !== undefined) agentPatch.mcp_servers = patch.mcp_servers

        if (patch.knowledge_vault_ids !== undefined) {
          if (isProactiveEmployeeSession) {
            await api.proactiveUpdateRole(code, {
              knowledge_vault_ids: patch.knowledge_vault_ids,
            })
            setRoleUiNonce((n) => n + 1)
          } else {
            agentPatch.knowledge_vault_ids = patch.knowledge_vault_ids
          }
        }

        if (Object.keys(agentPatch).length > 0) {
          await api.updateAgent(code, agentPatch)
          await refreshAgentsList()
        }
        toast('已更新能力绑定', 'success')
      } catch (e) {
        toast(`更新失败：${(e as Error)?.message || e}`, 'error')
        throw e
      } finally {
        setCapabilityPatchBusy(false)
      }
    },
    [
      currentRoleCodeForUi,
      employeeSessionAgentCode,
      isProactiveEmployeeSession,
      refreshAgentsList,
    ],
  )

  const openCurrentAgentEditor = useCallback(() => {
    const code = String(
      (isProactiveEmployeeSession ? employeeSessionAgentCode : '') || currentRoleCodeForUi || '',
    ).trim()
    if (!code) {
      toast('当前没有可编辑的智能体', 'warning')
      return
    }
    void import('../pages/agents-role-ui.js')
      .then(({ showEditRoleDialog }) => {
        const page = document.querySelector('.role-page') || document.body
        const state = {
          agents: Array.isArray(agents) ? agents : [],
          hiredCodes: new Set<string>(),
          onRefresh: async () => {
            await refreshAgentsList()
            setRoleUiNonce((n) => n + 1)
          },
        }
        return showEditRoleDialog(page, state, code)
      })
      .catch((e) => {
        toast(`无法打开编辑：${(e as Error)?.message || e}`, 'error')
      })
  }, [
    agents,
    currentRoleCodeForUi,
    employeeSessionAgentCode,
    isProactiveEmployeeSession,
    refreshAgentsList,
  ])

  useEffect(() => {
    // 切换会话：流式快照在上方 useLayoutEffect 已 persist/restore；此处只清 UI 壳层状态。
    const fromKey = sessionSwitchFromRef.current
    if (fromKey) {
      const prevDraft = composerTextRef.current
      if (prevDraft) composerDraftsRef.current.set(fromKey, prevDraft)
      else composerDraftsRef.current.delete(fromKey)
      threadPanelBySessionRef.current.set(fromKey, threadPanelStateRef.current)
      planSessionEnterRef.current = ''
    }
    delete refreshAttachAttemptedRef.current[selectedSessionKey]

    queueMicrotask(() => {
      setStreamingWritePreview(null)
      setWorkspacePanelOpen(false)
      setWorkspaceTreePinned(false)
      setSubagentDockTasks({})
    })
    lastStreamWritePathRef.current = null
    resetStreamMirrorDedupe()
    resetPlanTrace()
    planResolveInFlightRef.current = false
    syncShellAsideForWorkspacePanel(false)
    const isTaskJump =
      processedTaskIdRef.current && boundTaskIdRef.current === processedTaskIdRef.current
    resetCollabPlanUiForSession({ keepBoundTaskId: !!isTaskJump, closeSidebar: true })
    if (selectedSessionKey) {
      // 切会话时立即校验：若新选中的会话看起来 busy，查 DB 确认是否真的还在运行
      const switchSk = String(selectedSessionKey).trim()
      const switchRt = getSessionRuntime(switchSk)
      if (isTurnBusy(switchRt)) {
        invalidateSessionRuntimeStatusCache(switchSk)
        void maybeEndTurnSendingState(switchSk, switchRt, false)
      }
      lastActivityRef.current[selectedSessionKey] = Date.now()
      clearClarificationLatch(selectedSessionKey)
      const cachedPanel = threadPanelBySessionRef.current.get(selectedSessionKey)
      const switchRows = switchRt.rows?.length ? switchRt.rows : rowsRef.current || []
      let panelToRestore = cachedPanel || emptyThreadPanel()
      if (
        panelToRestore.clarification &&
        !findAskClarificationAwaitingUserInRows(switchRows)
      ) {
        panelToRestore = clearThreadPanelClarification(panelToRestore)
        threadPanelBySessionRef.current.set(selectedSessionKey, panelToRestore)
      }
      setThreadPanelState(panelToRestore)
      if (Array.isArray(panelToRestore.todos) && panelToRestore.todos.length > 0) {
        setHasReceivedTodos(true)
      }
    }
    setSessionMode(getSessionModeFromMeta(selectedSessionKey))
    setCollabOn(getSessionCollabModeFromMeta(selectedSessionKey))
    setModeMenuOpen(false)
    bumpStreamFullRef.current()

    const carriedDraft = pendingComposerDraftCarryRef.current
    if (carriedDraft !== null) {
      pendingComposerDraftCarryRef.current = null
      if (selectedSessionKey) {
        if (carriedDraft) composerDraftsRef.current.set(selectedSessionKey, carriedDraft)
        else composerDraftsRef.current.delete(selectedSessionKey)
      }
      restoreComposerDraft(carriedDraft)
    } else if (selectedSessionKey) {
      const draft = composerDraftsRef.current.get(selectedSessionKey) || ''
      restoreComposerDraft(draft)
    }

    // 工作空间历史由壳层 hydrateGlobalWorkspaceHistoryOnce 写入缓存；切换会话只读缓存
    try {
      const ctx = wsClient.getSessionContext(selectedSessionKey)
      const pendingWs = pendingNewSessionWorkspaceRef.current
      let wsRoot = String(ctx.local_workspace_root || '').trim()
      if (
        pendingWs &&
        pendingWs.sessionKey === selectedSessionKey &&
        String(pendingWs.path || '').trim()
      ) {
        wsRoot = String(pendingWs.path).trim()
        pendingNewSessionWorkspaceRef.current = null
      }
      setLocalWorkspaceRoot(wsRoot)
      shellIntentWorkspaceRef.current = wsRoot || null
      if (!wsRoot) {
        // 智能体员工会话：context 未绑定 workspace 时，兜底取该员工绑定的 workspace_path
        //（优先员工绑定，而非默认/上次选择；新会话由后端 prepare 写入，存量会话走此兜底）
        const empCode = parseProactiveSessionKey(selectedSessionKey).agentCode
        if (empCode) {
          void (async () => {
            try {
              const { api } = await import('../lib/tauri-api.js')
              const res = await api.proactiveGetRole(empCode)
              const role = res?.role || res
              const cfg = role && typeof role === 'object' ? role.config : null
              const bound = String(
                (cfg && typeof cfg === 'object' ? cfg.workspace_path || '' : '') || '',
              ).trim()
              if (
                bound &&
                String(sessionRef.current || '').trim() === String(selectedSessionKey || '').trim()
              ) {
                setLocalWorkspaceRoot(bound)
                shellIntentWorkspaceRef.current = bound
              }
            } catch {
              /* best-effort: 未绑定或查询失败时保持原逻辑 */
            }
          })()
        }
      }
      const savedCtxFiles = Array.isArray(ctx.context_files) ? ctx.context_files : []
      setContextFiles(
        savedCtxFiles
          .filter((f: unknown) => f && typeof f === 'object' && String((f as ContextFileEntry).path || '').trim())
          .map((f: ContextFileEntry) => ({
            path: String(f.path).trim(),
            name: String(f.name || f.path).trim(),
          })),
      )
      setWorkspaceHistory(wsClient.getWorkspaceHistory(selectedSessionKey))
      setGlobalWorkspaceHistory(wsClient.getGlobalWorkspaceHistory())
    } catch {
      setLocalWorkspaceRoot('')
      setWorkspaceHistory([])
      setGlobalWorkspaceHistory([])
    }
  }, [selectedSessionKey, resetCollabPlanUiForSession, restoreComposerDraft, maybeEndTurnSendingState])

  useEffect(() => {
    const onWorkspace = (ev: Event) => {
      const d = (ev as CustomEvent<{ sessionKey?: string; local_workspace_root?: string }>).detail
      if (!d?.sessionKey || d.sessionKey !== selectedSessionKey) return
      const p = String(d.local_workspace_root || '').trim()
      if (!p) return
      setLocalWorkspaceRoot(p)
      try {
        setWorkspaceHistory(wsClient.getWorkspaceHistory(selectedSessionKey))
        setGlobalWorkspaceHistory(wsClient.getGlobalWorkspaceHistory())
      } catch {
        /* ignore */
      }
      bumpStreamFullRef.current()
    }
    window.addEventListener('evopanel:session-workspace-updated', onWorkspace as EventListener)
    return () => window.removeEventListener('evopanel:session-workspace-updated', onWorkspace as EventListener)
  }, [selectedSessionKey])

  /** 切换会话时异步拉取工作空间历史（刷新后缓存为空时补全） */
  useEffect(() => {
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) return
    let cancelled = false
    void (async () => {
      try {
        await wsClient.hydrateGlobalWorkspaceHistoryOnce()
        await wsClient.ensureSessionWorkspaceHistory(sk)
        if (cancelled) return
        const ctx = wsClient.getSessionContext(sk)
        const root = String(ctx.local_workspace_root || '').trim()
        if (root) setLocalWorkspaceRoot(root)
        setWorkspaceHistory(wsClient.getWorkspaceHistory(sk))
        setGlobalWorkspaceHistory(wsClient.getGlobalWorkspaceHistory())
      } catch {
        /* ignore */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedSessionKey])

  // Shared SQLite index per workspace root; background warm — gated by user toggle (default off).
  useEffect(() => {
    if (!workspaceIndexWatchEnabled) return
    if (useVirtualPaths) return
    const root = effectiveWorkspaceRoot
    if (!root) return
    let cancelled = false
    void (async () => {
      try {
        const { api } = await import('../lib/tauri-api.js')
        if (cancelled) return
        void api.warmCodeIndex(root, false, undefined)
        await api.startCodeIndexWatch(root, undefined)
      } catch {
        /* best-effort index warm-up */
      }
    })()
    return () => {
      cancelled = true
      void (async () => {
        try {
          const { api } = await import('../lib/tauri-api.js')
          await api.stopCodeIndexWatch(root, undefined)
        } catch {
          /* ignore */
        }
      })()
    }
  }, [effectiveWorkspaceRoot, useVirtualPaths, workspaceIndexWatchEnabled])

  useEffect(() => {
    if (!workspaceIndexWatchEnabled) return
    if (!useVirtualPaths) return
    const threadId = String(wsClient.getSessionThreadId(selectedSessionKey) || '').trim()
    if (!threadId) return
    let cancelled = false
    void (async () => {
      try {
        const { api } = await import('../lib/tauri-api.js')
        if (cancelled) return
        void api.warmCodeIndex('', false, threadId)
        await api.startCodeIndexWatch('', threadId)
      } catch {
        /* best-effort */
      }
    })()
    return () => {
      cancelled = true
      void (async () => {
        try {
          const { api } = await import('../lib/tauri-api.js')
          await api.stopCodeIndexWatch('', threadId)
        } catch {
          /* ignore */
        }
      })()
    }
  }, [useVirtualPaths, selectedSessionKey, workspaceIndexWatchEnabled])

  /** 协作任务执行中：WebSocket 推送 phase / 侧栏 snapshot / 子任务进度（替代 HTTP 轮询）。 */
  useEffect(() => {
    const key = selectedSessionKey
    if (!key) return
    const threadId = wsClient.getSessionThreadId(key)
    if (!threadId) return

    const taskId = String(
      threadPanelState.collabTask?.taskId || boundTaskId || threadPanelState.boundTaskId || '',
    ).trim()
    const phase = String(threadPanelState.collabPhase || '').trim().toLowerCase()
    const subs = threadPanelState.collabSubtasks || []
    const needsBackfill =
      !!taskId &&
      (turnBusyForSession(key) || executingSessionKeysRef.current.has(key)) &&
      subs.some((s) => isPendingSubtaskKey(s.subtaskId))
    const needsPhaseSync =
      collabOn &&
      (turnBusyForSession(key) || executingSessionKeysRef.current.has(key) || isSessionGoalActive(key)) &&
      (phase === 'executing' || phase === 'verifying' || phase === 'reflecting')

    const isTaskActive = () => {
      if (!turnBusyForSession(key) && !executingSessionKeysRef.current.has(key) && !isSessionGoalActive(key)) {
        return false
      }
      const mainStatus = String(threadPanelState.collabTask?.status || '').trim().toLowerCase()
      const terminalMainStatus = new Set(['completed', 'failed', 'cancelled'])
      const activeMainStatus = new Set(['executing', 'in_progress', 'running', 'waiting_dispatch', 'waiting_user'])
      const phaseActive = phase !== '' && phase !== 'idle' && phase !== 'done'
      const statusTerminal = !!mainStatus && terminalMainStatus.has(mainStatus)
      const statusActive = (!!mainStatus && !statusTerminal) || activeMainStatus.has(mainStatus)
      return statusTerminal
        ? phase === 'verifying'
        : phaseActive || statusActive || (phase as string) === 'verifying'
    }
    const needsSidebar = isTaskActive()
    const subRunning = subs.some((s) => {
      const st = String(s.status || '')
        .trim()
        .toLowerCase()
      return st === 'in_progress' || st === 'running' || st === 'executing' || st === 'active'
    })
    const needsNodeStream =
      collabOn &&
      (!!taskId || subRunning) &&
      (turnBusyForSession(key) ||
        executingSessionKeysRef.current.has(key) ||
        isSessionGoalActive(key) ||
        subRunning ||
        phase === 'executing' ||
        phase === 'verifying')

    if (!needsBackfill && !needsPhaseSync && !needsSidebar && !needsNodeStream) return

    const fetchSeq = sessionTasksFetchSeqRef.current
    let pollLogMod: typeof import('../lib/poll-loop-log.js') | null = null
    void import('../lib/poll-loop-log.js').then((mod) => {
      pollLogMod = mod
      mod.logPollLoopStart('collab_unified_ws', {
        sessionKey: key,
        threadId,
        phase,
        needsPhaseSync,
        needsSidebar,
        needsBackfill,
        needsNodeStream,
      })
    })

    const pushSubagentStreamPayload = (payload: Record<string, unknown>) => {
      const inner = String(payload?.type || '').trim()
      if (!inner.startsWith('task_') && inner !== 'subagent_token_delta') return
      dispatchCollabCustomEvent(key, payload)
    }

    const handleWsEvent = (ev: { type?: string; data?: Record<string, unknown> }) => {
      if (!isActiveSessionFetch(key, fetchSeq)) return
      const type = String(ev?.type || '').trim()
      const data = ev?.data && typeof ev.data === 'object' ? ev.data : {}
      pollLogMod?.logPollTick('collab_unified_ws', key, 30000, { phase, eventType: type })

      if (type === 'collab:snapshot') {
        applyTaskProgressSnapshot(data as Record<string, unknown>, { sessionKey: key })
        return
      }
      if (type === 'collab:state') {
        const serverPhase = String(data.collab_phase || '').trim().toLowerCase()
        const bound = String(data.bound_task_id || '').trim()
        if (serverPhase || bound) {
          setThreadPanelState((prev) => ({
            ...prev,
            ...(serverPhase ? { collabPhase: serverPhase } : {}),
            ...(bound ? { boundTaskId: bound } : {}),
          }))
          if (serverPhase) {
            void import('../lib/tauri-api.js').then(({ api: chatApi }) => {
              void chatApi.chatUpdateContext(key, { collab_phase: serverPhase })
            })
          }
        }
        return
      }
      // Workflow node live output (task_running with LangChain message chunks)
      if (type === 'node:output') {
        pushSubagentStreamPayload(data as Record<string, unknown>)
        return
      }
      if (type === 'task:progress') {
        const sid = String(data.collab_subtask_id || data.collabSubtaskId || data.task_id || '').trim()
        if (sid) {
          dispatchCollabCustomEvent(key, {
            type: 'task_running',
            collab_subtask_id: sid,
            task_id: sid,
            progress: data.progress,
            status: data.status,
            current_step: data.current_step || data.currentStep,
          })
        }
        return
      }
      if (type.startsWith('task:')) {
        const innerType = String(data.type || '').trim()
        if (innerType.startsWith('task_') || innerType === 'subagent_token_delta') {
          pushSubagentStreamPayload(data as Record<string, unknown>)
        }
        return
      }
      if (type === 'agent:custom' || type === 'agent:evf') {
        pushSubagentStreamPayload(data as Record<string, unknown>)
      }
    }

    const unsub = subscribeCollabThreadWs(threadId, {
      mainTaskId: taskId || undefined,
      onEvent: handleWsEvent,
      onOpen: () => {
        if (needsBackfill && taskId) void ensureSubtasksVisibleForTask(taskId)
      },
    })

    return () => {
      pollLogMod?.logPollLoopEnd('collab_unified_ws', { sessionKey: key })
      unsub()
    }
  }, [
    collabOn,
    selectedSessionKey,
    boundTaskId,
    ensureSubtasksVisibleForTask,
    threadPanelState.boundTaskId,
    threadPanelState.collabPhase,
    threadPanelState.collabTask?.taskId,
    threadPanelState.collabTask?.status,
    applyTaskProgressSnapshot,
  ])

  const { bumpReattachRetry, markRunCompleted } = useStreamResume({
    selectedSessionKey,
    sessionsRef,
    wsClient,
    // @ts-ignore
    reloadRef,
    manualReattachSessionKeyRef,
  })
  bumpReattachRetryRef.current = bumpReattachRetry
  requestManualStreamResumeRef.current = (
    sessionKey: string,
    opts?: { refreshSessions?: boolean },
  ) => {
    const sk = String(sessionKey || '').trim()
    if (!sk) return
    delete refreshAttachAttemptedRef.current[sk]
    reattachRetryCountRef.current = 0
    srLog('stream resume requested (user refresh)', { sessionKey: sk })
    manualReattachSessionKeyRef.current = sk
    const rt = getSessionRuntime(sk)
    const row = sessionsRef.current.find((s) => String(s.sessionKey || '') === sk)
    const runId = String(rt.activeChatRunId || row?.currentRunId || '').trim()
    if (runId) wsClient.abortStreamWire(sk, runId)
    if (sessionRef.current !== sk) {
      sessionRef.current = sk
      setSelectedSessionKey(sk)
      setNewChatButtonActive(false)
    }
    if (opts?.refreshSessions !== false) {
      void refreshSessionsRef.current?.({ skipAutoReselect: true })
    }
    bumpReattachRetryRef.current?.()
  }

  /** F5 刷新页面：会话列表就绪后若 DB 仍 running，改为 history-watch（拉 messages）直至结束 */
  useEffect(() => {
    if (listLoading || pageLoadResumeDoneRef.current) return
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) return
    const row = sessions.find((s) => String(s.sessionKey || '') === sk)
    const st = String(row?.runStatus || '').trim().toLowerCase()
    if (st !== 'running' && st !== 'pending') {
      pageLoadResumeDoneRef.current = true
      return
    }
    pageLoadResumeDoneRef.current = true
    // Check if the run is stale (no activity for > 10 minutes) before resuming.
    // If stale, cancel instead of resuming — matches backend P0 stale-run threshold.
    // Falls back to updatedAt (epoch-ms) when currentTurnStartedAt is absent.
    const _STALE_RUN_THRESHOLD_MS = 10 * 60 * 1000
    const _startedAt = row?.currentTurnStartedAt
    const _startedMs = _startedAt ? new Date(_startedAt).getTime() : 0
    const _updatedMs = typeof row?.updatedAt === 'number' ? row.updatedAt : 0
    const _refMs = _updatedMs || _startedMs
    if (_refMs && Date.now() - _refMs > _STALE_RUN_THRESHOLD_MS) {
      toast('上次会话已超时，正在自动停止…', 'info')
      void stopSessionExecutionRef.current?.(sk, { showToast: false })
      return
    }
    requestManualStreamResumeRef.current(sk, { refreshSessions: false })
  }, [listLoading, selectedSessionKey, sessions])

  /**
   * visibilitychange / online: 后台切回前台或网络恢复后自动 reattach 活跃 run。
   *
   * 浏览器后台标签会断开 SSE 连接（POST /runs/stream 的 fetch body stream），
   * 回到前台后需检测当前会话是否有活跃 run，若有则触发 stream-resume 续接。
   */
  const hiddenSinceRef = useRef<number | null>(null)
  useEffect(() => {
    let reattachTimer: ReturnType<typeof setTimeout> | null = null

    const tryReattach = () => {
      const sk = String(sessionRef.current || '').trim()
      if (!sk) return
      // 尊重 stream-resume 门控，避免在 live POST stream 进行中触发重复 reattach
      if (shouldManualRefreshResumeStream({ sessionKey: sk }) === false) return
      if (isSessionRecoveryCooldownActive(sk)) return
      void (async () => {
        try {
          const status = await wsClient.getSessionRunStatus(sk)
          // 处理 recently_completed：如果 run 刚完成（60s 内），刷新消息列表并重置流状态
          if (status.recently_completed) {
            srLog('visibility reattach recently-completed', {
              sessionKey: sk,
              runId: status.recently_completed_run_id,
              completedStatus: status.recently_completed_status,
            })
            // 刷新会话列表以获取最新状态
            await refreshSessionsRef.current?.({ skipAutoReselect: true })
            // 清理本地运行状态标记为 idle
            try {
              await evoflowFetch(`/api/chat/sessions/${encodeURIComponent(sk)}/run-idle`, {
                method: 'POST',
              })
            } catch {
              // best-effort
            }
            return
          }
          // R2-2: run 未在执行但有 runId，查询是否已完成
          if (!status.executing && status.runId) {
            try {
              const checkResp = await evoflowFetch(
                `/api/chat/sessions/${encodeURIComponent(sk)}/live-run/check`
              )
              if (checkResp.ok) {
                const checkData = await checkResp.json()
                if (checkData?.completed) {
                  srLog('visibility reattach completed-run', {
                    sessionKey: sk,
                    runId: status.runId,
                    completedStatus: checkData.status,
                  })
                  // 刷新消息列表获取最终结果
                  await refreshSessionsRef.current?.({ skipAutoReselect: true })
                  // 清理 live_run 记录
                  await evoflowFetch(
                    `/api/chat/sessions/${encodeURIComponent(sk)}/live-run`,
                    { method: 'DELETE' }
                  ).catch(() => {})
                  return
                }
              }
            } catch {
              // best-effort: silent failure
            }
            // Run not completed but not executing - stale run, refresh messages
            srLog('visibility reattach stale-run-refresh', {
              sessionKey: sk,
              runId: status.runId,
              status: status.status,
            })
            await refreshSessionsRef.current?.({ skipAutoReselect: true })
            return
          }
          srLog('visibility reattach', {
            sessionKey: sk,
            runId: status.runId,
          })
          requestManualStreamResumeRef.current?.(sk, { refreshSessions: false })
        } catch {
          // 静默失败
        }
      })()
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenSinceRef.current = Date.now()
      } else {
        const hiddenFor = hiddenSinceRef.current ? Date.now() - hiddenSinceRef.current : 0
        hiddenSinceRef.current = null
        // 仅在后台超过 5 秒时触发，避免快速切换干扰
        if (hiddenFor < 5000) return

        // R2-1: Send heartbeat to backend when returning from background
        // This updates last_event_at so backend knows frontend is still alive
        const sk = String(sessionRef.current || '').trim()
        if (sk) {
          void evoflowFetch(`/api/chat/sessions/${encodeURIComponent(sk)}/heartbeat`, {
            method: 'POST',
          }).catch(() => {
            // best-effort: silent failure
          })
        }

        // 延迟 500ms，避免与路由切换/组件重渲染竞争
        if (reattachTimer) clearTimeout(reattachTimer)
        reattachTimer = setTimeout(tryReattach, 500)
      }
    }

    const handleOnline = () => {
      // 网络恢复后延迟 1s 检测
      if (reattachTimer) clearTimeout(reattachTimer)
      reattachTimer = setTimeout(tryReattach, 1000)
    }

    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('online', handleOnline)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('online', handleOnline)
      if (reattachTimer) clearTimeout(reattachTimer)
    }
  }, [])

  useEffect(() => {
    if (unsubRef.current) {
      unsubRef.current()
      unsubRef.current = null
    }
    unsubRef.current = wsClient.onEvent((msg: { event?: string; payload?: ChatWsPayload }) => {
      const flushPendingSessionTitle = () => {
        const pending = pendingAutoSessionTitleRef.current
        if (!pending?.sessionKey || !pending.title) return
        pendingAutoSessionTitleRef.current = null
        persistSessionTitleIfMissing(pending.sessionKey, pending.title)
      }

      if (msg.event === 'pending_inject_consumed') {
        const p = msg.payload as {
          sessionKey?: string
          messageIds?: string[]
        } | null
        const evtSk = String(p?.sessionKey || '').trim()
        const ids = Array.isArray(p?.messageIds) ? p!.messageIds! : []
        if (evtSk && ids.length) promoteConsumedSteersToRows(evtSk, ids)
        return
      }

      if (msg.event === 'thread_state') {
        const p = msg.payload as any
        if (!p) return
        // 必须使用 payload 中携带的 sessionKey，禁止 fallback 到 sessionRef.current，
        // 否则无 sessionKey 的事件会错误归属到当前活跃会话，造成串台
        const evtSk = String(p.sessionKey || '').trim()
        if (!evtSk) return
        const activeSk = String(sessionRef.current || '').trim()
        // 修复：只要 evtSk 存在且与 activeSk 不同，就算 activeSk 为空也视为后台事件
        // （新建会话过程中 activeSk=''，旧会话的事件必须路由到旧会话而非空会话）
        const isBackgroundThreadState = !!(evtSk && evtSk !== activeSk)
        const threadId =
          wsClient.getSessionThreadId(isBackgroundThreadState ? evtSk : activeSk) ||
          String(p.threadId || '').trim() ||
          ''
        const currentMode = getSessionModeFromMeta(isBackgroundThreadState ? evtSk : activeSk)
        const flashMode = currentMode === 'flash'

        const now = Date.now()
        lastActivityRef.current[evtSk] = now
        const lastActivity = lastActivityRef.current[evtSk]
        const timeSinceLastActivity = lastActivity ? now - lastActivity : Infinity

        const hasFreshClarification = !!(p.clarification && (p.clarification.preview || p.clarification.content))
        if (!lastActivity || timeSinceLastActivity > THREAD_STATE_EXPIRY_MS) {
          if (!turnBusyForSession(evtSk) && !hasFreshClarification) {
            return
          }
        }

        const activityKindRaw = String(p.activityKind || 'idle').trim().toLowerCase()
        const activityDetailRaw = String(p.activityDetail || '').trim()
        const rtEvt = getSessionRuntime(evtSk)
        const skipHeaderReplay = !isBackgroundThreadState && rtEvt.resumeCatchupReplay
        let panelActivityKind = activityKindRaw
        let panelActivityDetail = activityDetailRaw
        if (
          !isBackgroundThreadState &&
          !skipHeaderReplay &&
          turnBusyForSession(activeSk)
        ) {
          const runningDetail = formatActivityDetailFromRunningToolCalls(
            streamRef.current.turn.tools as unknown[],
          )
          if (runningDetail) {
            panelActivityKind = 'tools'
            panelActivityDetail = runningDetail
          } else if (activityKindRaw === 'thinking') {
            panelActivityKind = 'thinking'
            panelActivityDetail = activityDetailRaw || getActivityHint('thinking') || '思考中… 🤔'
          } else if (activityKindRaw === 'tools') {
            panelActivityKind = 'thinking'
            panelActivityDetail = getActivityHint('tools') || '执行工具中…'
          } else if (activityKindRaw === 'idle') {
            panelActivityKind = 'idle'
            panelActivityDetail = ''
          } else {
            // 兼容未知类型：使用 getActivityHint 生成提示，并设置合理默认值
            panelActivityKind = 'tools'
            panelActivityDetail = getActivityHint(activityKindRaw) || activityDetailRaw
          }
        }
        if (
          !isBackgroundThreadState &&
          !skipHeaderReplay &&
          panelActivityDetail &&
          panelActivityKind !== 'idle' &&
          panelActivityKind !== 'compacting' &&
          panelActivityKind !== 'retrying' &&
          turnBusyForSession(activeSk)
        ) {
          applyStreamTurnEvent(streamRef.current, {
            type: 'system_activity',
            detail:
              panelActivityKind === 'tools'
                ? panelActivityDetail
                : panelActivityKind === 'thinking'
                  ? panelActivityDetail || getActivityHint('thinking') || '思考中… 🤔'
                  : '',
          })
          scheduleBump()
        } else if (
          !isBackgroundThreadState &&
          !skipHeaderReplay &&
          turnBusyForSession(activeSk) &&
          panelActivityKind === 'idle' &&
          !panelActivityDetail
        ) {
          applyStreamTurnEvent(streamRef.current, { type: 'system_activity', detail: '' })
          scheduleBump()
        }

        const newTitle = typeof p.title === 'string' && p.title.trim() ? p.title.trim() : null
        const newTodos = Array.isArray(p.todos) ? p.todos : []

        if (isBackgroundThreadState) {
          if (
            panelActivityKind !== 'idle' &&
            panelActivityDetail &&
            !skipHeaderReplay
          ) {
            setSessionActivity(evtSk, panelActivityKind, panelActivityDetail)
          }
          if (newTitle) {
            persistSessionTitleIfMissing(evtSk, newTitle)
          }
          if (
            activityKindRaw !== 'idle' &&
            activityDetailRaw &&
            activityKindRaw !== 'compacting' &&
            activityKindRaw !== 'retrying'
          ) {
            bgRuntimeNotifySchedulerRef.current?.schedule()
          }
          return
        }

        const commitThreadPanel = (nextPanel: ThreadPanelState) => {
          threadPanelBySessionRef.current.set(evtSk, nextPanel)
          if (isBackgroundThreadState) return
          setThreadPanelState(nextPanel)
        }

        if (newTodos.length > 0 && !hasReceivedTodos && !isBackgroundThreadState) {
          setHasReceivedTodos(true)
          openSessionSidebar()
        }

        if (
          panelActivityKind !== 'idle' &&
          panelActivityDetail &&
          !skipHeaderReplay
        ) {
          setSessionActivity(evtSk, panelActivityKind, panelActivityDetail)
        }

        commitThreadPanel(applyThreadStatePanelPatch(
          isBackgroundThreadState
            ? threadPanelBySessionRef.current.get(evtSk) || emptyThreadPanel()
            : threadPanelStateRef.current,
          skipHeaderReplay
            ? { ...p, activityKind: 'idle', activityDetail: '', reasoningPreview: null }
            : { ...p, activityKind: panelActivityKind, activityDetail: panelActivityDetail },
          flashMode,
          priorStripForRuntime(getSessionRuntime(evtSk)),
          { preserveActivityWhileSending: turnBusyForSession(activeSk) && !skipHeaderReplay },
        ))

        if (!isBackgroundThreadState) {
          const clarWire = p.clarification as Record<string, unknown> | undefined
          const clarTcid = String(clarWire?.toolCallId || clarWire?.tool_call_id || '').trim()
          const clarPreview = String(clarWire?.preview || clarWire?.content || '').trim()
          if (
            clarTcid &&
            (!clarPreview || !isClarificationPreviewRenderable(clarPreview))
          ) {
            scheduleClarificationPanelResolveRef.current(evtSk, {
              toolCallId: clarTcid,
              preferToolRetries: true,
            })
          }
        }

        if (!isBackgroundThreadState && turnBusyForSession(activeSk)) {
          bumpStreamDisplayTick()
        }

        if (newTitle) {
          const streamBusy = !isBackgroundThreadState && streamRefHasVisibleContent(streamRef.current)
          if (!streamBusy) {
            pendingAutoSessionTitleRef.current = null
            persistSessionTitleIfMissing(evtSk, newTitle)
          } else {
            pendingAutoSessionTitleRef.current = { sessionKey: evtSk, title: newTitle }
          }
        }

        if (isBackgroundThreadState) return

        const allArtifacts = Array.isArray(p.artifacts) ? p.artifacts.map((x: unknown) => String(x || '').trim()).filter(Boolean) : []
        const sid = activeSk || 'default'
        let seen = seenArtifactsRef.current.get(sid)
        if (!seen) {
          seen = new Set<string>()
          seenArtifactsRef.current.set(sid, seen)
        }
        const newArtifacts = allArtifacts.filter((a: string) => !seen!.has(a))
        for (const a of allArtifacts) seen.add(a)
        // 本轮产物只累计本 run 新增路径；勿把 thread 里历史 artifacts 灌进 turnRunArtifactsRef，
        // 否则纯 platform 操作也会在 RUN_FINISHED 误开「本轮产物」右栏。
        if (newArtifacts.length > 0) {
          turnRunArtifactsRef.current = mergeChatArtifacts(
            turnRunArtifactsRef.current,
            normalizeChatArtifacts(
              newArtifacts.map((path) => ({
                type: 'file',
                path,
                status: 'new' as const,
              })),
            ),
          )
        }

        // 处理 artifacts：将文件路径转换为文件展示对象（流式进行中不写 stream/assistant，避免与写入预览叠卡）
        if (newArtifacts.length > 0) {
          const artifactItems = turnRunArtifactsRef.current
          setSessionArtifacts((prev) =>
            mergeChatArtifacts(
              prev,
              normalizeChatArtifacts(
                newArtifacts.map((path) => ({
                  type: 'file',
                  path,
                  status: 'new',
                })),
              ),
            ),
          )
          publishArtifacts({
            focusId: artifactItems.find((it) => it.path === newArtifacts[0])?.id || '',
            hint: `本轮新增 ${newArtifacts.length} 个产物`,
          })

          const files = newArtifacts.map((path: string) => {
            const name = String(path || '').split('/').pop() || '文件'
            return {
              url: threadId ? normalizeFileHrefForThread(threadId, String(path || '')) : String(path || ''),
              name,
              mimeType: '',
            }
          })
          const streamTools = streamRef.current.turn.tools as unknown[]
          const hideDeliveredFileCards = shouldSuppressStreamDeliveredFiles(streamTools, {
            streamingWritePreview: streamingWritePreviewRef.current,
            suppressForSendingWriteTurn: turnBusyForSession(sessionRef.current),
          })
          const blockWhileStreaming = turnBusyForSession(activeSk)
          if (!hideDeliveredFileCards && !blockWhileStreaming) {
            streamRef.current.turn.files = files
            // 写入预览仍可跟到具体文件；产物列表由 decide 打开 artifacts
            for (const path of newArtifacts) {
              const target = workspacePreviewTargetFromUrl(path)
              if (
                target &&
                isStreamAutoPreviewPath(target.path) &&
                rightStageStore.currentKind === 'write'
              ) {
                setStreamingWritePreview({
                  path: target.path,
                  name: target.name,
                  content: streamingWritePreviewRef.current?.content ?? '',
                  streaming: false,
                })
                break
              }
            }
          } else if (streamRef.current.turn.files?.length) {
            streamRef.current.turn.files = []
            scheduleBump()
          }
          // 若当前轮次已经落库为 assistant 消息，也把文件补到最后一条 assistant，
          // 避免“工具成功但页面无反应”（流式进行中跳过，由 final 或 @@路径 承接）。
          if (!hideDeliveredFileCards && !blockWhileStreaming) {
            setRows((prev) => {
              if (!Array.isArray(prev) || prev.length === 0) return prev
              const last = prev[prev.length - 1]
              if (!last || last.role !== 'assistant') return prev
              const existing = Array.isArray(last.files) ? last.files : []
              const mergedMap = new Map<string, { url: string; name: string; mimeType?: string }>()
              for (const f of [...existing, ...files]) {
                const u = String((f as { url?: string })?.url || '').trim()
                if (!u) continue
                mergedMap.set(u, f as { url: string; name: string; mimeType?: string })
              }
              const merged = Array.from(mergedMap.values())
              if (merged.length === existing.length) {
                const same = merged.every((m, idx) => String((existing[idx] as { url?: string })?.url || '') === m.url)
                if (same) return prev
              }
              const next = [...prev]
              next[next.length - 1] = { ...last, files: merged }
              return next
            })
            scheduleBump()
          }
        }

        return
      }

      if (msg.event === 'context_usage') {
        const p = msg.payload as {
          sessionKey?: string
          usedTokens?: number
          windowTokens?: number
          messageCount?: number
          pct?: number
          beforeTokens?: number | null
          compacted?: boolean
          note?: string
          systemTokens?: number | null
          toolsTokens?: number | null
          messageTokens?: number | null
          toolCount?: number | null
        }
        if (!p) return
        // 必须使用 payload 中的 sessionKey，禁止 fallback
        const sk = String(p.sessionKey || '').trim()
        const activeSk = String(sessionRef.current || '').trim()
        if (!sk || sk !== activeSk) return
        setContextUsageBySession((prev) => ({
          ...prev,
          [sk]: mergeContextUsageSnapshots(prev[sk], {
            usedTokens: Number(p.usedTokens) || 0,
            windowTokens: Number(p.windowTokens) || 0,
            messageCount: Number(p.messageCount) || 0,
            pct: Number(p.pct) || 0,
            beforeTokens: p.beforeTokens != null ? Number(p.beforeTokens) || 0 : null,
            compacted: Boolean(p.compacted),
            note: String(p.note || ''),
            systemTokens: p.systemTokens != null ? Number(p.systemTokens) || 0 : null,
            toolsTokens: p.toolsTokens != null ? Number(p.toolsTokens) || 0 : null,
            messageTokens: p.messageTokens != null ? Number(p.messageTokens) || 0 : null,
            toolCount: p.toolCount != null ? Number(p.toolCount) || 0 : null,
            updatedAt: Date.now(),
          }),
        }))
        return
      }

      if (msg.event !== 'chat') return
      const payload = msg.payload
      if (!payload) return
      // 必须使用 payload 中携带的 sessionKey，禁止 fallback 到 sessionRef.current
      const eventSk = String(payload.sessionKey || '').trim()
      const activeSk = String(sessionRef.current || '').trim()
      const uiSk = String(sessionRef.current || selectedSessionKey || '').trim()
      const { state } = payload
      const runId = payload.runId
      // 仅当「当前 UI 会话」已确定且与 eventSk 不同时视为后台；activeSk 为空时不误判为后台，
      // 否则新建会话首轮流式 final 只写 rt.rows 不 setRows，清 stream 后气泡变空。
      const isBackground = !!(eventSk && uiSk && eventSk !== uiSk)
      if (isBackground) {
        if (state === 'final' || state === 'error' || state === 'aborted') {
          scheduleRefreshSessionsRef.current?.()
        }
        chatStreamBgApplyRef.current = true
      } else {
        chatStreamBgApplyRef.current = false
      }
      // 修复：后台事件始终路由到 eventSk；前台事件只有在 activeSk 非空时才路由到 activeSk
      // 当 activeSk 为空（新建会话过程中）且 eventSk 非空时，即使 isBackground=false（理论上不会发生），
      // 也应该丢弃事件而不是写入空会话的临时 runtime
      const targetSk = isBackground ? eventSk : (uiSk || eventSk || '')
      if (isBackground) {
        bgRuntimeNotifySessionRef.current = targetSk
      } else {
        bgRuntimeNotifySessionRef.current = ''
      }
      const rt = targetSk ? getSessionRuntime(targetSk) : null
      const applyRowsUpdate = (updater: (r: DisplayRow[]) => DisplayRow[]) => {
        if (!targetSk) return
        const next = updateSessionRuntimeRows(targetSk, updater)
        const syncSk = uiSk || (!isBackground ? eventSk : '')
        if (syncSk && targetSk === syncSk) {
          setRows([...next])
          rowsRef.current = next
        }
      }
      try {
      if (!rt) return
      const S = rt.stream
      // 修复：streamRef 重绑定必须满足：
      // 1. 非后台事件
      // 2. 当前 streamRef 与目标 rt.stream 不同
      // 3. sessionRef.current 确实指向 targetSk（双重检查，防止竞态）
      // 4. targetSk 非空
      // 5. 目标会话确实处于繁忙状态（避免空闲时错误重绑定）
      if (
        !isBackground &&
        targetSk &&
        streamRef.current !== S &&
        String(sessionRef.current || '').trim() === targetSk &&
        (turnBusyForSession(targetSk) || isTurnBusy(rt))
      ) {
        streamRef.current = S
      }

      if (runId && rtIsStoppedRun(rt, runId) && state !== 'aborted') {
        return
      }

      // 用户已停止：丢弃迟到的 delta/reasoning/tool（避免「正在处理中」与幽灵流式气泡）
      const streamActive = isTurnBusy(rt)
      if (
        !isBackground &&
        !streamActive &&
        state !== 'final' &&
        state !== 'aborted' &&
        state !== 'error' &&
        state !== 'run_started' &&
        state !== 'agui_event' &&
        state !== 'subtask' &&
        state !== 'terminal' &&
        state !== 'stream_health'
      ) {
        return
      }

      if (state === 'run_started' && runId) {
        // 用户已停止：丢弃迟到的 run_started 帧，防止重新激活流式状态（与 rtIsStoppedRun 双重保险）。
        // 主动发送（outbound/live）不受 recovery cooldown 影响，否则 stop 后再发会被整轮丢弃。
        const intentionalOutbound =
          rt.turnPhase === 'outbound' || rt.turnPhase === 'live'
        if (
          !isBackground &&
          !intentionalOutbound &&
          (userInitiatedStopRef.current || isSessionRecoveryCooldownActive(targetSk))
        ) {
          return
        }
        const isResumeAttach = rt.turnPhase === 'reattaching'
        const clientRunId = String(runId).trim()
        const wireRunId = String(S.aguiTurn?.runId || S.runId || rt.activeChatRunId || '').trim()
        const wireAlreadyLive =
          isAgUiWireRunId(wireRunId) &&
          !isAgUiWireRunId(clientRunId) &&
          streamRefHasVisibleContent(S)
        if (wireAlreadyLive) {
          setExpectedChatRunId(targetSk, clientRunId)
        } else {
          bindActiveRun(rt, clientRunId)
          startClientPerfTurn(targetSk, clientRunId)
          dispatchSessionTurnEvent(targetSk, {
            type: 'RUN_LIVE',
            runId: clientRunId,
            wireSource: 'run',
          })
          dispatchSessionTurnEvent(targetSk, { type: 'SESSION_EVENT', at: Date.now() })
          setSessions((prev) =>
            prev.map((s) =>
              String(s.sessionKey || '') === targetSk
                ? {
                    ...s,
                    runStatus: 'running',
                    currentRunId: clientRunId,
                    currentTurnStartedAt:
                      s.currentTurnEndedAt || !s.currentTurnStartedAt
                        ? new Date().toISOString()
                        : s.currentTurnStartedAt,
                    currentTurnEndedAt: null,
                  }
                : s,
            ),
          )
          setExpectedChatRunId(targetSk, clientRunId)
          if (!isBackground) {
            activeChatRunIdRef.current = isAgUiWireRunId(wireRunId) ? wireRunId : clientRunId
            S.runId = isAgUiWireRunId(wireRunId) ? wireRunId : clientRunId
            if (!isResumeAttach) {
              if (!S.aguiTurn || !isAgUiWireRunId(String(S.aguiTurn.runId || ''))) {
                S.aguiTurn = emptyAgUiTurnState(
                  isAgUiWireRunId(wireRunId) ? wireRunId : clientRunId,
                  '',
                )
              }
            } else if (!streamRefHasVisibleContent(S)) {
              resetRuntimeStream(rt, streamRef)
              S.runId = clientRunId
              S.aguiTurn = emptyAgUiTurnState(clientRunId, '')
              const rowsSnap = rowsRef.current || []
              let lastUserIdx = -1
              for (let i = rowsSnap.length - 1; i >= 0; i--) {
                if (rowsSnap[i]?.role === 'user') {
                  lastUserIdx = i
                  break
                }
              }
              let baseline = ''
              if (lastUserIdx >= 0) {
                for (let i = rowsSnap.length - 1; i > lastUserIdx; i--) {
                  if (rowsSnap[i]?.role === 'assistant') {
                    baseline = String(rowsSnap[i]?.text || '').trim()
                    break
                  }
                }
              }
              if (baseline) {
                S.aguiTurn = seedAgUiTurnBaseline(S.aguiTurn, baseline)
                S.turn = syncStreamTurnFromAgUi(S.turn, S.aguiTurn)
              }
              applyRowsUpdate((r) => markResumeAnchorAssistantIncomplete(r, clientRunId))
            }
            if (isResumeAttach) {
              scheduleBump({ immediate: true })
            }
          }
        }
        applyRowsUpdate((r) => {
          const last = r[r.length - 1]
          if (last?.role === 'user' && !last.runId) {
            return [...r.slice(0, -1), { ...last, runId: String(runId) }]
          }
          return r
        })
        return
      }

      if (runId && state === 'final' && rtHasSeenRun(rt, runId)) {
        sfWarn('final skipped — duplicate runId', {
          sessionKey: targetSk,
          runId,
          turnBusy: isTurnBusy(rt) || turnBusyForSession(targetSk),
        })
        if (isTurnBusy(rt) || turnBusyForSession(targetSk)) {
          maybeEndTurnSendingState(targetSk, rt, isBackground)
        }
        return
      }

      if (
        state !== 'subtask' &&
        state !== 'terminal' &&
        state !== 'stream_health' &&
        state !== 'agui_event' &&
        !shouldApplyChatEvent(rt, payload, {
          allowSealingTerminal: true,
          knownRunId:
            sessions.find((s) => s.sessionKey === targetSk)?.currentRunId ||
            rt.activeChatRunId ||
            null,
          expectedRunId: getExpectedChatRunId(targetSk),
        })
      ) {
        if (state === 'final') {
          sfWarn('final blocked by run gate', {
            sessionKey: targetSk,
            runId,
            activeChatRunId: rt.activeChatRunId,
            expectedRunId: getExpectedChatRunId(targetSk),
          })
          // 兜底：final 被 run gate 阻断但 turn 仍 busy 时，查 DB 确认是否真的已结束。
          // 多会话切换场景下，切走后后台 final 到达时 activeChatRunId 可能已不匹配，
          // 若不清理会永久卡在 sealing/live 导致转圈不停。
          if (isTurnBusy(rt) || turnBusyForSession(targetSk)) {
            maybeEndTurnSendingState(targetSk, rt, isBackground)
          }
        }
        return
      }

      if (!rt.activeChatRunId && runId) {
        bindActiveRun(rt, runId)
        if (!isBackground) activeChatRunIdRef.current = String(runId)
      }
      noteSessionEvent(targetSk, rt, { at: Date.now(), silent: isBackground })

      if (
        runId &&
        state === 'delta' &&
        !turnBusyForSession(targetSk) &&
        !isTurnBusy(rt) &&
        rtHasSeenRun(rt, runId) &&
        !streamTurnHasVisibleContent(S.turn)
      ) {
        return
      }

      if (state === 'activity') {
        if (rt.resumeCatchupReplay) return
        const activityKindRaw = String((payload as { activityKind?: string }).activityKind || '').trim().toLowerCase()
        const toolPreview = formatActivityDetailFromRunningToolCalls(S.turn.tools as unknown[])
        const payloadDetail = String((payload as { activityDetail?: string }).activityDetail || '').trim()
        const activityTs = Number((payload as { ts?: number }).ts) || Date.now()
        if (toolPreview) {
          applyStreamTurnEvent(S, { type: 'system_activity', detail: toolPreview, kind: 'tools', ts: activityTs })
          if (!isBackground) {
            setThreadPanelState((prev) => ({
              ...prev,
              activityKind: 'tools',
              activityDetail: toolPreview,
            }))
          }
        } else if (
          (activityKindRaw === 'thinking' || payloadDetail === getActivityHint('thinking')) &&
          !rowHasPendingApprovalTools(S.turn.tools as unknown[])
        ) {
          applyStreamTurnEvent(S, { type: 'system_activity', detail: payloadDetail || getActivityHint('thinking'), kind: 'model', ts: activityTs })
          if (!isBackground) {
            setThreadPanelState((prev) => ({
              ...prev,
              activityKind: 'thinking',
              activityDetail: payloadDetail || getActivityHint('thinking'),
            }))
          }
        } else if (activityKindRaw === 'tool_approval') {
          const detail = payloadDetail || '等待工具授权…'
          applyStreamTurnEvent(S, { type: 'system_activity', detail, kind: 'tool_approval', ts: activityTs })
          if (!isBackground) {
            setThreadPanelState((prev) => ({
              ...prev,
              activityKind: 'tool_approval',
              activityDetail: detail,
            }))
          }
        } else if (activityKindRaw === 'pre_model') {
          // before_model：尚未真正打模型 — 显示「准备中…」。「生成中…」仅在 kind=model。
          const detail = payloadDetail || '准备中…'
          applyStreamTurnEvent(S, { type: 'system_activity', detail, kind: 'pre_model', ts: activityTs })
          if (!isBackground) {
            setThreadPanelState((prev) => ({
              ...prev,
              activityKind: 'pre_model',
              activityDetail: detail,
            }))
          }
        } else if (activityKindRaw === 'model') {
          // wrap_model_call：请求已打向厂商 — 才是「生成中…」
          const detail = payloadDetail || '生成中…'
          applyStreamTurnEvent(S, { type: 'system_activity', detail, kind: 'model', ts: activityTs })
          if (!isBackground) {
            setThreadPanelState((prev) => ({
              ...prev,
              activityKind: 'model',
              activityDetail: detail,
            }))
          }
        } else if (activityKindRaw === 'compacting') {
          const detail = payloadDetail || '正在压缩上下文…'
          applyStreamTurnEvent(S, { type: 'system_activity', detail, kind: 'compacting', ts: activityTs })
          if (!isBackground) {
            setThreadPanelState((prev) => ({
              ...prev,
              activityKind: 'compacting',
              activityDetail: detail,
            }))
          }
        } else if (activityKindRaw === 'retrying') {
          const detail = payloadDetail || '系统重试中…'
          applyStreamTurnEvent(S, { type: 'system_activity', detail, kind: 'retrying', ts: activityTs })
          if (!isBackground) {
            setThreadPanelState((prev) => ({
              ...prev,
              activityKind: 'retrying',
              activityDetail: detail,
            }))
          }
        } else if (activityKindRaw === 'model_fallback') {
          const detail = payloadDetail || '已自动切换模型'
          applyStreamTurnEvent(S, { type: 'system_activity', detail, kind: 'model_fallback', ts: activityTs })
          if (!isBackground) {
            setThreadPanelState((prev) => ({
              ...prev,
              activityKind: 'model_fallback',
              activityDetail: detail,
            }))
          }
        } else if (!payloadDetail) {
          return
        } else {
          applyStreamTurnEvent(S, {
            type: 'system_activity',
            detail: normalizeStreamActivityDetail(payloadDetail, {
              toolName: String((payload as { toolName?: string }).toolName || ''),
            }),
            kind: activityKindRaw || 'system',
            ts: activityTs,
          })
        }
        const runtimeActivityKind = toolPreview
          ? 'tools'
          : rowHasPendingApprovalTools(S.turn.tools as unknown[])
            ? 'tool_approval'
            : activityKindRaw === 'thinking' || payloadDetail === '推理中'
              ? 'thinking'
              : activityKindRaw === 'pre_model'
                ? 'pre_model'
                : activityKindRaw === 'retrying'
                  ? 'retrying'
                  : activityKindRaw === 'model_fallback'
                    ? 'model_fallback'
                    : activityKindRaw || 'system'
        const runtimeActivityDetail =
          toolPreview
            || (rowHasPendingApprovalTools(S.turn.tools as unknown[]) ? '等待工具授权…' : '')
            || payloadDetail
            || (activityKindRaw === 'pre_model' ? '准备中…' : '')
            || (activityKindRaw === 'model' ? '生成中…' : '')
            || (activityKindRaw === 'retrying' ? '系统重试中…' : '')
            || (activityKindRaw === 'model_fallback' ? '已自动切换模型' : '')
        if (runtimeActivityDetail || runtimeActivityKind !== 'idle') {
          setSessionActivity(targetSk, runtimeActivityKind, runtimeActivityDetail)
        }
        if (!S.runId && runId) S.runId = runId
        if (!S.startTs) S.startTs = Date.now()
        scheduleBump()
        return
      }

      if (state === 'chat_artifacts') {
        const incoming = normalizeChatArtifacts((payload as { items?: unknown }).items)
        if (incoming.length && !isBackground) {
          setSessionArtifacts((prev) => mergeChatArtifacts(prev, incoming))
          turnRunArtifactsRef.current = mergeChatArtifacts(turnRunArtifactsRef.current, incoming)
          const newCount = incoming.filter((x) => x.status !== 'updated').length || incoming.length
          publishArtifacts({
            focusId: incoming[incoming.length - 1]?.id || '',
            hint: `本轮新增 ${newCount} 个产物`,
          })
        }
        return
      }

      if (state === 'model_fallback_switch') {
        const nextModel = String((payload as { modelName?: string }).modelName || '').trim()
        const sepText =
          String((payload as { text?: string }).text || '').trim() ||
          (nextModel ? `已自动切换至 ${nextModel} 模型` : '已自动切换模型')
        if (nextModel && !isBackground) {
          setModelName(nextModel)
          try {
            localStorage.setItem(STORAGE_MODEL_KEY, nextModel)
          } catch {
            /* ignore */
          }
          void patchPanelSettings({ lastSelectedModel: nextModel })
          void loadModelCatalog({ silent: true })
        }
        if (!isBackground) {
          setRows((prev) => [
            ...(Array.isArray(prev) ? prev : []),
            {
              role: 'system' as const,
              text: sepText,
              timestamp: Date.now(),
            } as DisplayRow,
          ])
        }
        scheduleBump()
        return
      }

      if (state === 'usage') {
        const usageStats = parseUsageToStats(payload as Record<string, unknown>)
        if (usageStats && usageStats.total > 0 && !isBackground) {
          setLiveTurnTokens({
            input: usageStats.input,
            output: usageStats.output,
            total: usageStats.total,
            ...((usageStats as Record<string, number>).cacheRead ? { cacheRead: (usageStats as Record<string, number>).cacheRead as number } : {}),
            ...((usageStats as Record<string, number>).cacheCreation ? { cacheCreation: (usageStats as Record<string, number>).cacheCreation as number } : {}),
            ...((usageStats as Record<string, number>).cacheMiss ? { cacheMiss: (usageStats as Record<string, number>).cacheMiss as number } : {}),
          })
        }
        scheduleBump()
        return
      }

      if (state === 'block_close') {
        if (isAgUiStreamActive(S)) return
        if (rt.resumeCatchupReplay) return
        const block = blockWireFromChatPayload(payload as Record<string, unknown>)
        if (!block) return
        applyStreamTurnEvent(S, { type: 'block_close', block })
        if (!S.runId && runId) S.runId = runId
        if (!S.startTs) S.startTs = Date.now()
        scheduleBump()
        return
      }

      if (state === 'reasoning') {
        if (isAgUiStreamActive(S)) return
        if (rt.resumeCatchupReplay) return
        const currentMode = getSessionModeFromMeta(sessionRef.current)
        if (currentMode === 'flash') return
        const r =
          typeof (payload as { reasoningPreview?: string }).reasoningPreview === 'string'
            ? (payload as { reasoningPreview: string }).reasoningPreview
            : ''
        if (r) {
          const cleaned = stripPriorTurnReasoningFromStream(
            fixReasoningStreamText(r),
            priorStripForRuntime(rt),
          )
          if (!shouldKeepStreamDeltaAfterStrip(cleaned)) return
          const prevPreview = streamProject(S).reasoningPreview
          releaseStreamBufferIfNeeded(
            S,
            rt,
            { kind: 'reasoning_piece', piece: cleaned },
            applyRowsUpdate,
            runId,
          )
          applyStreamTurnEvent(S, { type: 'reasoning_piece', piece: cleaned, block: blockWireFromChatPayload(payload as Record<string, unknown>) })
          if (!isBackground && turnBusyForSession(activeSk)) {
            applyStreamTurnEvent(S, { type: 'system_activity', detail: '推理中' })
            setThreadPanelState((prev) => ({
              ...prev,
              activityKind: 'thinking',
              activityDetail: '推理中',
            }))
          }
          if (!S.runId && runId) S.runId = runId
          if (!S.startTs) S.startTs = Date.now()
          if (streamProject(S).reasoningPreview !== prevPreview) {
            afterLiveOrStructuralBump(targetSk, S, { liveTextOnly: true, reasoning: true })
          }
        }
        return
      }

      if (state === 'tool') {
        if (isAgUiStreamActive(S)) return
        const entries = filterStreamToolEntriesForRuntime(
          rt,
          normalizeChatToolPayloadToEntries(payload as Record<string, unknown>),
        )
        const rawData = payload.data as Record<string, unknown>
        if (entries.length === 0) return
        const isNewToolCall =
          rawData.type === 'tool_call' && streamDeltaShouldMergeTools(S.turn, entries)
        applyStreamTurnEvent(S, {
          type: isNewToolCall ? 'tools' : 'tools_update',
          entries,
          block: blockWireFromChatPayload(payload as Record<string, unknown>),
        })
        const allTools = S.turn.tools as unknown[]
        const toolPreview = formatActivityDetailFromRunningToolCalls(allTools)
        noteSessionEvent(targetSk, rt, { at: Date.now(), toolPreview, silent: isBackground })
        if (!isBackground) {
          const thinkingDetail =
            String(streamProject(S).reasoningPreview || '').trim() ? '推理中' : ''
          applyStreamTurnEvent(S, {
            type: 'system_activity',
            detail: toolPreview || thinkingDetail,
          })
        }
        if (isNewToolCall) {
          releaseStreamBufferIfNeeded(S, rt, { kind: 'tools', entries }, applyRowsUpdate, runId)
        }
        syncWorkspacePreviewFromTools(S.turn.tools)
        consumeLatestScenarioToolForSession(S.turn.tools, scenarioSessionHandlers)
        syncStreamMediaAssetsFromTools(S)
        if (!S.runId && runId) S.runId = runId
        if (!S.startTs) S.startTs = Date.now()
        scheduleBump()
        absorbPlanFromTools(S.turn.tools as unknown[])
        syncPlanPanelImmediateFromTools(collectPlanToolsForDetection())
        patchCollabFromStreamTools()
        detectAndScheduleClarificationRef.current(S, rt, targetSk, isBackground)
        maybeSyncVoiceReplySpeech(targetSk, S, rt)
        return
      }

      if (state === 'write_progress') {
        const toolCallId = String(payload.toolCallId || '').trim()
        const progress =
          payload.writeProgress && typeof payload.writeProgress === 'object'
            ? (payload.writeProgress as {
                path?: string
                tool_name?: string
                phase?: string
                lines_added?: number
                lines_removed?: number
                bytes_total?: number
                bytes_written?: number
                message?: string
                content?: string
                old_string?: string
                new_string?: string
                content_delta?: string
                old_string_delta?: string
                new_string_delta?: string
                content_len?: number
              })
            : null
        if (!toolCallId || !progress) return
        applyStreamTurnEvent(S, {
          type: 'write_file_progress',
          toolCallId,
          progress: {
            path: progress.path,
            tool_name: progress.tool_name,
            phase: typeof progress.phase === 'string' ? progress.phase : undefined,
            lines_added: Number(progress.lines_added) || 0,
            lines_removed: Number(progress.lines_removed) || 0,
            bytes_total:
              typeof progress.bytes_total === 'number' && Number.isFinite(progress.bytes_total)
                ? progress.bytes_total
                : undefined,
            bytes_written:
              typeof progress.bytes_written === 'number' && Number.isFinite(progress.bytes_written)
                ? progress.bytes_written
                : undefined,
            message: typeof progress.message === 'string' ? progress.message : undefined,
            content: typeof progress.content === 'string' ? progress.content : undefined,
            old_string: typeof progress.old_string === 'string' ? progress.old_string : undefined,
            new_string: typeof progress.new_string === 'string' ? progress.new_string : undefined,
            content_delta: progress.content_delta,
            old_string_delta: progress.old_string_delta,
            new_string_delta: progress.new_string_delta,
            content_len: progress.content_len,
          },
        })
        if (!S.runId && runId) S.runId = runId
        if (!S.startTs) S.startTs = Date.now()
        syncWorkspacePreviewFromTools(S.turn.tools)
        // Write body tokens arrive faster than default bump coalescing; paint each batch promptly.
        scheduleBump({ immediate: true })
        return
      }

      if (state === 'worker_file') {
        const parentToolCallId = String(payload.parentToolCallId || '').trim()
        const entry =
          payload.workerFileEntry && typeof payload.workerFileEntry === 'object'
            ? (payload.workerFileEntry as Record<string, unknown>)
            : null
        if (!parentToolCallId || !entry) return
        applyStreamTurnEvent(S, {
          type: 'worker_file_progress',
          parentToolCallId,
          entry,
        })
        if (!S.runId && runId) S.runId = runId
        if (!S.startTs) S.startTs = Date.now()
        workerFileBumpSchedulerRef.current?.schedule()
        return
      }

      if (state === 'terminal') {
        const ev = payload.terminalEvent
        if (ev && typeof ev === 'object' && !Array.isArray(ev)) {
          if (!S.terminalStreams) S.terminalStreams = {}
          mergeTerminalStreamEvent(S.terminalStreams, ev as Record<string, unknown>)
          // 同时合并到对应的工具对象上（每个工具自带数据，彻底隔离）
          const evObj = ev as Record<string, unknown>
          const evTc = String(evObj.tool_call_id || evObj.toolCallId || '').trim()
          if (evTc) {
            for (const t of S.turn.tools || []) {
              const tool = t as Record<string, unknown>
              const tTc = String(tool.tool_call_id || tool.id || '').trim()
              if (tTc && tTc === evTc) {
                mergeTerminalIntoTool(tool, evObj)
                break
              }
            }
          }
          if (!S.runId && runId) S.runId = runId
          if (!S.startTs) S.startTs = Date.now()
          scheduleBump()
        }
        return
      }

      if (state === 'subtask') {
        const ev = payload.subtaskEvent
        if (ev && typeof ev === 'object' && !Array.isArray(ev)) {
          const evObj = ev as Record<string, unknown>
          if (!S.subagentTasks) S.subagentTasks = {}
          mergeSubagentStreamEvent(S.subagentTasks, evObj)
          collabDagDebug('stream_event', {
            runId,
            type: evObj.type,
            task_id: evObj.task_id,
            collab_subtask_id: evObj.collab_subtask_id ?? evObj.collabSubtaskId,
            mapKey: normalizeSubagentStreamEvent(evObj).task_id,
          })
          setSubagentDockTasks((prev) => {
            const next = { ...prev }
            mergeSubagentStreamEvent(next, evObj)
            // 子智能体输出不再进主消息区，仅供顶部 TODO hover 预览
            setThreadPanelState((tp) => ({ ...tp, subagentTasks: next }))
            if (debugSubtaskTooltipEnabled()) {
              const type = String(evObj.type || '')
              const tid = String(evObj.task_id || '')
              const cid = String(evObj.collab_subtask_id || evObj.collabSubtaskId || '')
              const t = tid ? next[tid] : null
              const hasTxt = !!String(t?.liveOutput || t?.progressHint || '').trim()
              const toolN = Array.isArray(t?.tools) ? t?.tools.length : 0
               
              console.debug(
                `[subtask-tooltip] type=${type} task_id=${tid} collab_subtask_id=${cid} has_text=${hasTxt} tools=${toolN}`,
              )
            }
            if (debugSubtaskFlowEnabled()) {
              const type = String(evObj.type || '')
              const tid = String(evObj.task_id || '')
              const cid = String(evObj.collab_subtask_id || evObj.collabSubtaskId || '')
              const t = tid ? next[tid] : null
              const liveOutputText = shortLogText(t?.liveOutput || '')
              const progressHintText = shortLogText(t?.progressHint || '')
              const mergedOutputText = liveOutputText || progressHintText || ''
               
              console.debug(
                `[subtask-flow][custom][output] type=${type} task_id=${tid} collab_subtask_id=${cid} source=${liveOutputText ? 'liveOutput' : progressHintText ? 'progressHint' : ''} text="${mergedOutputText}"`,
              )
            }
            return next
          })
          const collabSidRaw =
            typeof evObj.collab_subtask_id === 'string'
              ? evObj.collab_subtask_id.trim()
              : typeof evObj.collabSubtaskId === 'string'
                ? evObj.collabSubtaskId.trim()
                : ''
          const nextStatus = collabStatusFromSubagentStreamEv(evObj)
          const normalizedEv = normalizeSubagentStreamEvent(evObj)
          const rawTaskId = String(evObj.task_id || '').trim()
          const parsed = parseParentAndSubtaskIdFromComposite(rawTaskId)
          const collabSid =
            collabSidRaw ||
            (typeof normalizedEv.collab_subtask_id === 'string' ? normalizedEv.collab_subtask_id.trim() : '') ||
            (parsed?.subtaskId || '')
          const evType = String(evObj.type || '')
          if (collabSid && parsed?.parentTaskId) {
            parentTaskToSubtaskRef.current[parsed.parentTaskId] = collabSid
            if (debugSubtaskFlowEnabled()) {
               
              console.debug(
                `[subtask-flow][custom] parent-map task_id=${rawTaskId} parent_task_id=${parsed.parentTaskId} collab_subtask_id=${collabSid}`,
              )
            }
          }
          if (debugSubtaskFlowEnabled()) {
             
            console.debug(
              `[subtask-flow][custom] status-map collab_subtask_id=${collabSid} ev_type=${String(evObj.type || '')} next_status=${nextStatus || ''}`,
            )
          }
          const wcRaw = evObj.work_checklist ?? evObj.workChecklist
          const workChecklistPatch = Array.isArray(wcRaw) ? { workChecklist: wcRaw as CollabSubtaskSnapshot['workChecklist'] } : undefined
          const statusForPatch = nextStatus || (workChecklistPatch ? 'in_progress' : '')
          if (collabSid && statusForPatch) {
            setThreadPanelState((prev) => ({
              ...prev,
              collabSubtasks: patchCollabSubtasksById(
                prev.collabSubtasks || [],
                collabSid,
                statusForPatch,
                {
                  ...(workChecklistPatch || {}),
                },
              ),
            }))
            setSidebarTaskViews((prev) => {
              let touched = false
              const out = { ...prev }
              for (const k of Object.keys(out)) {
                const v = out[k]
                if (!v?.subtasks?.some((s) => s.subtaskId === collabSid)) continue
                const patched = patchCollabSubtasksById(
                  v.subtasks || [],
                  collabSid,
                  statusForPatch,
                  workChecklistPatch || undefined,
                )
                if (patched !== v.subtasks) {
                  out[k] = { ...v, subtasks: patched, updatedAt: Date.now() }
                  touched = true
                }
              }
              return touched ? out : prev
            })
          }
          if (!S.runId && runId) S.runId = runId
          if (!S.startTs) S.startTs = Date.now()
          if (collabSid && (evType === 'task_running' || evType === 'task_completed')) {
            bumpSubtasksApiRefresh()
          }
          scheduleBump()
        }
        return
      }

      if (state === 'agui_event') {
        const aguiEvent = (payload as { aguiEvent?: AGUIEvent }).aguiEvent
        if (!aguiEvent) return

        // chatSend 先绑 client UUID；AG-UI wire run-{hex} 须在 gate 前接管，否则整轮事件被丢弃
        const aguiRunId =
          String((aguiEvent as { runId?: string }).runId || '').trim() ||
          String(runId || '').trim()
        const activeRunId = String(rt.activeChatRunId || '').trim()
        const wireRunTakeover =
          !!aguiRunId &&
          aguiRunId !== activeRunId &&
          /^run-[a-f0-9]+$/i.test(aguiRunId) &&
          (!activeRunId || !/^run-[a-f0-9]+$/i.test(activeRunId))
        if (wireRunTakeover || aguiEvent.type === EventType.RUN_STARTED) {
          const intentionalOutbound =
            rt.turnPhase === 'outbound' || rt.turnPhase === 'live'
          if (
            !isBackground &&
            !intentionalOutbound &&
            (userInitiatedStopRef.current || isSessionRecoveryCooldownActive(targetSk))
          ) {
            return
          }
          if (aguiRunId && rtIsStoppedRun(rt, aguiRunId)) {
            return
          }
          if (aguiRunId) {
            bindActiveRun(rt, aguiRunId)
            dispatchSessionTurnEvent(targetSk, {
              type: 'RUN_LIVE',
              runId: aguiRunId,
              wireSource: 'run',
            })
            dispatchSessionTurnEvent(targetSk, { type: 'SESSION_EVENT', at: Date.now() })
            setExpectedChatRunId(targetSk, aguiRunId)
            if (!isBackground) {
              activeChatRunIdRef.current = aguiRunId
              S.runId = aguiRunId
            }
            setSessions((prev) =>
              prev.map((s) =>
                String(s.sessionKey || '') === targetSk
                  ? {
                      ...s,
                      runStatus: 'running',
                      currentRunId: aguiRunId,
                      currentTurnStartedAt:
                        s.currentTurnEndedAt || !s.currentTurnStartedAt
                          ? new Date().toISOString()
                          : s.currentTurnStartedAt,
                      currentTurnEndedAt: null,
                    }
                  : s,
              ),
            )
          }
        }

        if (
          !shouldApplyChatEvent(rt, payload, {
            allowSealingTerminal: true,
            knownRunId:
              sessions.find((s) => s.sessionKey === targetSk)?.currentRunId ||
              rt.activeChatRunId ||
              null,
            expectedRunId: getExpectedChatRunId(targetSk),
          })
        ) {
          return
        }
        // Release completed AG-UI round buffer when a new tool round starts,
        // preventing unbounded accumulation of messages/toolCalls/order across rounds.
        if (S.aguiTurn && shouldReleaseAgUiBufferBeforeToolStart(S.aguiTurn, aguiEvent)) {
          // 新一轮 TOOL_CALL_START 已到 → 旧批工具必然执行完（模型收到全部结果才会
          // 发起新调用）。先把 TOOL_CALL_RESULT 丢失的「幽灵调用中」工具收尾为 done，
          // 否则它们永远不满足 drain 条件，会一直悬挂在最新轮次上方显示「调用中」。
          finalizeGhostRunningToolsBeforeNewRound(S.aguiTurn)
          const { sealed, fresh, releasedToolIds } = drainAgUiCompletedRound(S.aguiTurn)
          if (sealed) {
            if (!S.compactedParts) S.compactedParts = []
            S.compactedParts.push(sealed)
            S.aguiTurn = fresh
            S.turn = syncStreamTurnFromAgUi(S.turn, S.aguiTurn)
            // 把已完成的工具（如 read）立刻并进 incomplete 气泡，避免下一轮 delete
            // 待审批 final 时只带上 delete、把上一轮步骤冲掉。
            applyRowsUpdate((rows) => {
              const idx = findFirstAssistantAfterRealUser(rows)
              if (idx < 0) return rows
              const row = rows[idx]
              if (row?.role !== 'assistant' || row.incompleteStream !== true) return rows
              const patch: DisplayRow = {
                role: 'assistant',
                text: String(sealed.text || ''),
                segments: sealed.segments,
                tools: sealed.tools as DisplayRow['tools'],
                reasoningSegments: sealed.reasoningSegments,
                // 思考正文已在 segments；勿把 sealed preview 留作 live，避免下轮工具下方复燃 Thinking
                reasoningPreview: null,
                timestamp: Date.now(),
              }
              const merged = mergeAssistantRowWithStreamRow(
                { ...row, incompleteStream: true },
                patch,
              )
              const next = [...rows]
              next[idx] = {
                ...merged,
                incompleteStream: true,
                tools: mergeToolsForPlanDetection(row.tools || [], sealed.tools || []),
                durationStr: undefined,
                tokenStr: undefined,
              }
              return next
            })
            logStreamCompareAgUiDrain({
              sessionKey: targetSk,
              runId: String(S.runId || runId || '').trim() || undefined,
              sealed,
              releasedToolIds,
            })
          }
        }
        let changed = false
        const prevSegLen = S.aguiTurn?.compatSegments?.length ?? 0
        const prevProj = S.aguiTurn ? projectAgUiToStreamTurnFields(S.aguiTurn) : null
        const prevToolsLen = Array.isArray(S.turn.tools) ? S.turn.tools.length : 0
        applyAgUiWireEvent(S, aguiEvent, priorStripForRuntime(rt))
        if (
          aguiEvent.type === EventType.RUN_FINISHED ||
          aguiEvent.type === EventType.MESSAGES_SNAPSHOT ||
          aguiEvent.type === EventType.TEXT_MESSAGE_END
        ) {
          sfLog('ChatApp agui_event', {
            sessionKey: targetSk,
            type: aguiEvent.type,
            runId: String(S.aguiTurn?.runId || runId || ''),
            agui: sfSummarizeAgUi(S.aguiTurn),
          })
        }
        if (String(S.aguiTurn?.runId || '').trim()) {
          S.runId = String(S.aguiTurn?.runId || '').trim()
        }
        const nextProj = S.aguiTurn ? projectAgUiToStreamTurnFields(S.aguiTurn) : null
        changed =
          (S.aguiTurn?.compatSegments?.length ?? 0) !== prevSegLen ||
          !S.aguiTurn?.finished ||
          prevProj?.openText !== nextProj?.openText ||
          prevProj?.reasoningPreview !== nextProj?.reasoningPreview ||
          prevProj?.systemActivity !== nextProj?.systemActivity ||
          (Array.isArray(S.turn.tools) ? S.turn.tools.length : 0) !== prevToolsLen
        if (aguiEvent.type === 'TOOL_CALL_START' || aguiEvent.type === 'TOOL_CALL_ARGS' || aguiEvent.type === 'TOOL_CALL_END' || aguiEvent.type === 'TOOL_CALL_RESULT') {
          syncWorkspacePreviewFromTools(S.turn.tools)
          syncStreamMediaAssetsFromTools(S)
          changed = true
        }
        if (!isBackground && aguiEvent.type === EventType.CUSTOM) {
          const customName = String((aguiEvent as { name?: string }).name || '')
          const customValue = (aguiEvent as { value?: unknown }).value
          if (customName === 'write_file_progress') {
            // content_len / body ticks must force a React bump even when tools[].length is unchanged.
            changed = true
          }
          if (applyRightStageAgUiCustom(customName, customValue)) {
            changed = true
          }
        }
        if (!isBackground && aguiEvent.type === EventType.TOOL_CALL_RESULT) {
          const toolCallId = String((aguiEvent as { toolCallId?: string }).toolCallId || '').trim()
          const tc = toolCallId ? S.aguiTurn?.toolCalls?.get(toolCallId) : undefined
          const toolName = String(tc?.toolCallName || '')
            .trim()
            .toLowerCase()
          if (toolName === 'panel_set' || toolName === 'stage_set') {
            const resultContent =
              typeof tc?.result === 'string'
                ? tc.result
                : typeof (aguiEvent as { content?: string }).content === 'string'
                  ? (aguiEvent as { content?: string }).content
                  : undefined
            if (
              applyStageSetFromToolCall(
                typeof tc?.argsText === 'string' ? tc.argsText : undefined,
                resultContent,
              )
            ) {
              changed = true
            }
          } else if (toolName === 'platform') {
            const resultContent =
              typeof (aguiEvent as { content?: string }).content === 'string'
                ? (aguiEvent as { content?: string }).content
                : typeof tc?.result === 'string'
                  ? tc.result
                  : undefined
            const argsText = typeof tc?.argsText === 'string' ? tc.argsText : undefined
            const toolCallId = String((aguiEvent as { toolCallId?: string }).toolCallId || '').trim()
            if (toolCallId && !platformFeedbackSeenRef.current.has(toolCallId)) {
              const feedback = applyPlatformFeedbackFromToolResult(resultContent, {
                argsText,
                toolCallId,
                existingEntries: turnPlatformEntriesRef.current,
              })
              if (feedback) {
                platformFeedbackSeenRef.current.add(toolCallId)
                publishPlatformEntriesRef.current(
                  feedback.entries,
                  latestPlatformRunEntryId(feedback.entries),
                )
                toast(
                  feedback.ui.title,
                  feedback.ui.kind === 'warning' ? 'warning' : feedback.ui.kind === 'error' ? 'error' : 'success',
                )
                changed = true
              }
            }
          }
        }
        if (aguiEvent.type === EventType.TOOL_CALL_RESULT) {
          const toolCallId = String((aguiEvent as { toolCallId?: string }).toolCallId || '').trim()
          const toolName = String(
            (toolCallId && S.aguiTurn?.toolCalls?.get(toolCallId)?.toolCallName) || '',
          )
            .trim()
            .toLowerCase()
          if (toolName === 'mind_map') {
            bumpKnowledgeMapRefresh()
          }
          // AG-UI tool events: run clarification detection bridge
          detectAndScheduleClarificationRef.current(S, rt, targetSk, isBackground)
          if (rowHasPendingApprovalTools(S.turn.tools as unknown[])) {
            logToolApprovalPendingDetected({
              sessionKey: targetSk,
              runId: String(runId || ''),
              来源: 'agui_tool_result',
              工具数: (S.turn.tools as unknown[]).length,
            })
            dispatchSessionTurnEvent(targetSk, {
              type: 'ACTIVITY',
              kind: 'tool_approval',
              detail: '等待工具授权…',
            })
            if (!isBackground) {
              setThreadPanelState((prev) => ({
                ...prev,
                activityKind: 'tool_approval',
                activityDetail: '等待工具授权…',
              }))
            }
          }
        }
        if (!S.runId && runId) S.runId = runId
        if (!S.startTs) S.startTs = Date.now()
        if (changed) {
          if (
            aguiEvent.type === EventType.TEXT_MESSAGE_CONTENT &&
            rt.resumeCatchupReplay
          ) {
            markSessionResumeCatchupReplay(targetSk, false)
          }
          const liveSnap = buildLiveRunSnapshotPayload(S)
          putLiveRunSnapshotBestEffort(targetSk, {
            runId: String(runId || S.runId || rt.activeChatRunId || ''),
            threadId: String(wsClient.getSessionThreadId(targetSk) || '').trim() || null,
            status: 'running',
            ...liveSnap,
            partialTools: Array.isArray(S.turn.tools) ? [...S.turn.tools] : [],
            // @ts-expect-error aguiMessages is a runtime-only field
            aguiMessages: S.aguiTurn?.compatSegments,
            lastEventAtMs: Date.now(),
          })
        }
        const bumpImmediate =
          aguiEvent.type === EventType.RUN_FINISHED ||
          aguiEvent.type === EventType.RUN_ERROR ||
          (aguiEvent.type === EventType.CUSTOM &&
            String((aguiEvent as { name?: string }).name || '') === 'write_file_progress') ||
          (aguiEvent.type === EventType.TEXT_MESSAGE_CONTENT &&
            !(S as { firstVisibleTextBumpDone?: boolean }).firstVisibleTextBumpDone)
            ? ({ immediate: true } as const)
            : undefined
        if (
          aguiEvent.type === EventType.TEXT_MESSAGE_CONTENT &&
          bumpImmediate?.immediate
        ) {
          ;(S as { firstVisibleTextBumpDone?: boolean }).firstVisibleTextBumpDone = true
        }
        afterLiveOrStructuralBump(targetSk, S, {
          liveTextOnly: isAgUiLiveTextEvent(aguiEvent.type),
          immediate: bumpImmediate?.immediate,
          reasoning:
            aguiEvent.type === EventType.REASONING_MESSAGE_CONTENT ||
            aguiEvent.type === EventType.REASONING_MESSAGE_START ||
            aguiEvent.type === EventType.REASONING_START,
        })
        if (aguiEvent.type === 'RUN_FINISHED' || aguiEvent.type === 'RUN_ERROR') {
          const hasArtifacts = turnRunArtifactsRef.current.length > 0
          const platformEntries = turnPlatformEntriesRef.current
          if (platformEntries.length > 0 && !hasArtifacts) {
            publishPlatformEntriesRef.current(
              platformEntries,
              latestPlatformRunEntryId(platformEntries),
            )
          } else if (hasArtifacts) {
            publishArtifacts({
              focusId: turnRunArtifactsRef.current[turnRunArtifactsRef.current.length - 1]?.id || '',
            })
          } else {
            applyDecideRightStage(
              {
                intent: 'run-finished',
                runId: rightStageRunIdRef.current,
                userPinned: rightStageUserPinnedRef.current,
                dismissedKindsThisRun: dismissedRightStageKindsRef.current,
                autoPreviewEnabled: isAutoWorkPreviewEnabled(writeStreamModeRef.current),
                currentKind: rightStageStore.currentKind,
                hasArtifacts: false,
              },
              {
                scheduleShow: (delayMs, run) => {
                  if (rightStageHintTimerRef.current) clearTimeout(rightStageHintTimerRef.current)
                  rightStageHintTimerRef.current = window.setTimeout(() => {
                    rightStageHintTimerRef.current = 0
                    run()
                  }, delayMs)
                },
              },
            )
          }
        }
        if (changed) {
          maybeSyncVoiceReplySpeech(targetSk, S, rt)
        }
        return
      }

      if (state === 'stream_turn') {
        if (isAgUiStreamActive(S)) return
        const ev = (payload as { streamTurnEvent?: StreamTurnEvent }).streamTurnEvent
        if (!ev) return
        let changed = false
        if (ev.type === 'tools') {
          const freshTools = filterStreamToolEntriesForRuntime(rt, ev.entries || [])
          if (freshTools.length && streamDeltaShouldMergeTools(S.turn, freshTools)) {
            releaseStreamBufferIfNeeded(
              S,
              rt,
              { kind: 'tools', entries: freshTools },
              applyRowsUpdate,
              runId,
            )
            applyStreamTurnEvent(S, { type: 'tools', entries: freshTools, block: ev.block })
            syncWorkspacePreviewFromTools(S.turn.tools)
            consumeLatestScenarioToolForSession(S.turn.tools, scenarioSessionHandlers)
            syncStreamMediaAssetsFromTools(S)
            const toolPreview = formatActivityDetailFromRunningToolCalls(S.turn.tools as unknown[])
            noteSessionEvent(targetSk, rt, { at: Date.now(), toolPreview, silent: isBackground })
            if (!isBackground) {
              const thinkingDetail =
                String(streamProject(S).reasoningPreview || '').trim() ? '推理中' : ''
              applyStreamTurnEvent(S, {
                type: 'system_activity',
                detail: toolPreview || thinkingDetail,
              })
              setThreadPanelState((prev) => ({
                ...prev,
                activityKind: toolPreview ? 'tools' : thinkingDetail ? 'thinking' : prev.activityKind,
                activityDetail: toolPreview || thinkingDetail || prev.activityDetail,
              }))
            }
            absorbPlanFromTools(S.turn.tools as unknown[])
            syncPlanPanelImmediateFromTools(collectPlanToolsForDetection())
            changed = true
          }
        } else if (ev.type === 'text_piece') {
          if (ev.piece && shouldAcceptStreamTextPiece(S.turn, ev.piece)) {
            releaseStreamBufferIfNeeded(
              S,
              rt,
              { kind: 'text_piece', piece: ev.piece, phase: ev.phase ?? null },
              applyRowsUpdate,
              runId,
            )
            applyStreamTurnEvent(S, {
              type: 'text_piece',
              piece: ev.piece,
              phase: ev.phase ?? null,
              block: ev.block,
            })
            changed = true
          }
        } else if (ev.type === 'reasoning_piece') {
          if (rt.resumeCatchupReplay) return
          const currentMode = getSessionModeFromMeta(sessionRef.current)
          if (currentMode === 'flash') return
          const cleaned = stripPriorTurnReasoningFromStream(
            fixReasoningStreamText(ev.piece),
            priorStripForRuntime(rt),
          )
          if (!shouldKeepStreamDeltaAfterStrip(cleaned)) return
          const prevPreview = streamProject(S).reasoningPreview
          releaseStreamBufferIfNeeded(
            S,
            rt,
            { kind: 'reasoning_piece', piece: cleaned },
            applyRowsUpdate,
            runId,
          )
          applyStreamTurnEvent(S, { type: 'reasoning_piece', piece: cleaned, block: ev.block })
          if (!isBackground && turnBusyForSession(activeSk)) {
            applyStreamTurnEvent(S, { type: 'system_activity', detail: '推理中' })
            setThreadPanelState((prev) => ({
              ...prev,
              activityKind: 'thinking',
              activityDetail: '推理中',
            }))
          }
          changed = streamProject(S).reasoningPreview !== prevPreview
        } else {
          applyStreamTurnEvent(S, ev)
          if (ev.type === 'tools_update') {
            syncWorkspacePreviewFromTools(S.turn.tools)
            consumeLatestScenarioToolForSession(S.turn.tools, scenarioSessionHandlers)
            syncStreamMediaAssetsFromTools(S)
            const toolPreview = formatActivityDetailFromRunningToolCalls(S.turn.tools as unknown[])
            noteSessionEvent(targetSk, rt, { at: Date.now(), toolPreview, silent: isBackground })
            if (!isBackground && toolPreview) {
              applyStreamTurnEvent(S, { type: 'system_activity', detail: toolPreview })
              setThreadPanelState((prev) => ({
                ...prev,
                activityKind: 'tools',
                activityDetail: toolPreview,
              }))
            }
          } else if (ev.type === 'system_activity' && !isBackground) {
            const detail = String(ev.detail || '').trim()
            if (detail) {
              setThreadPanelState((prev) => ({
                ...prev,
                activityKind: detail === '推理中' ? 'thinking' : prev.activityKind,
                activityDetail: detail,
              }))
            }
          }
          changed = true
        }
        if (changed) {
          if (!S.runId && runId) S.runId = runId
          if (!S.startTs) S.startTs = Date.now()
          if (ev.type === 'text_piece' && ev.piece) {
            noteSessionEvent(targetSk, rt, {
              at: Date.now(),
              textPreview: String(ev.piece).slice(-240),
              silent: isBackground,
            })
          }
          const liveSnap = buildLiveRunSnapshotPayload(S)
          putLiveRunSnapshotBestEffort(targetSk, {
            runId: String(runId || S.runId || rt.activeChatRunId || ''),
            threadId: String(wsClient.getSessionThreadId(targetSk) || '').trim() || null,
            status: 'running',
            ...liveSnap,
            partialTools: Array.isArray(S.turn.tools) ? [...S.turn.tools] : [],
            lastEventAtMs: Date.now(),
          })
          if (ev.type === 'reasoning_piece') {
            afterLiveOrStructuralBump(targetSk, S, { liveTextOnly: true, reasoning: true })
          } else if (ev.type === 'text_piece' && !(S as { firstVisibleTextBumpDone?: boolean }).firstVisibleTextBumpDone) {
            ;(S as { firstVisibleTextBumpDone?: boolean }).firstVisibleTextBumpDone = true
            afterLiveOrStructuralBump(targetSk, S, { liveTextOnly: true, immediate: true })
          } else if (isStreamTurnLiveTextEvent(ev.type)) {
            afterLiveOrStructuralBump(targetSk, S, { liveTextOnly: true })
          } else {
            afterLiveOrStructuralBump(targetSk, S, { liveTextOnly: false })
          }
          if (ev.type === 'tools' || ev.type === 'tools_update') {
            patchCollabFromStreamTools()
            // stream_turn tool events: run clarification detection bridge
            detectAndScheduleClarificationRef.current(S, rt, targetSk, isBackground)
          }
          maybeSyncVoiceReplySpeech(targetSk, S, rt)
        }
        return
      }

      if (state === 'delta') {
        if (isAgUiStreamActive(S)) return
        const c = extractChatContent(payload.message)
        if (!c) return
        let changed = false
        if (c.images?.length || c.videos?.length || c.audios?.length || c.files?.length) {
          const files =
            c.files?.length &&
            shouldSuppressStreamDeliveredFiles(S.turn.tools, {
              streamingWritePreview: streamingWritePreviewRef.current,
              suppressForSendingWriteTurn: turnBusyForSession(sessionRef.current),
            })
              ? []
              : c.files
          applyStreamTurnEvent(S, {
            type: 'media',
            images: c.images,
            videos: c.videos,
            audios: c.audios,
            files,
          })
          changed = true
        }
        if (c.tools?.length) {
          const freshTools = filterStreamToolEntriesForRuntime(rt, c.tools)
          if (freshTools.length && streamDeltaShouldMergeTools(S.turn, freshTools)) {
            releaseStreamBufferIfNeeded(S, rt, { kind: 'tools', entries: freshTools }, applyRowsUpdate, runId)
            applyStreamTurnEvent(S, {
              type: 'tools',
              entries: freshTools,
              block: blockWireFromChatPayload(payload as Record<string, unknown>),
            })
            syncWorkspacePreviewFromTools(S.turn.tools)
            consumeLatestScenarioToolForSession(S.turn.tools, scenarioSessionHandlers)
            syncStreamMediaAssetsFromTools(S)
            changed = true
          }
        }
        if (c.text) {
          const pieceMode = payload.streamTextMode === 'piece'
          const incoming = String(c.text || '')
          let piece = incoming
          if (!pieceMode) {
            const materialized = flattenLiveSnapshotText(S)
            if (!incoming.trim()) {
              piece = ''
            } else if (!materialized) {
              piece = incoming
            } else if (incoming.startsWith(materialized)) {
              piece = incoming.slice(materialized.length)
            } else if (incoming === materialized) {
              piece = ''
            } else {
              piece = incoming
            }
          }
          if (piece && shouldAcceptStreamTextPiece(S.turn, piece)) {
            releaseStreamBufferIfNeeded(
              S,
              rt,
              { kind: 'text_piece', piece, phase: payload.streamContentPhase ?? null },
              applyRowsUpdate,
              runId,
            )
            applyStreamTurnEvent(S, {
              type: 'text_piece',
              piece,
              phase: payload.streamContentPhase ?? null,
              block: blockWireFromChatPayload(payload as Record<string, unknown>),
            })
            changed = true
          }
        }
        if (changed) {
          if (!S.runId && runId) S.runId = runId
          if (!S.startTs) S.startTs = Date.now()
          if (c?.text) {
            noteSessionEvent(targetSk, rt, {
              at: Date.now(),
              textPreview: String(c.text).slice(-240),
              silent: isBackground,
            })
          }
          const liveSnap = buildLiveRunSnapshotPayload(S)
          putLiveRunSnapshotBestEffort(targetSk, {
            runId: String(runId || S.runId || rt.activeChatRunId || ''),
            threadId: String(wsClient.getSessionThreadId(targetSk) || '').trim() || null,
            status: 'running',
            ...liveSnap,
            partialTools: Array.isArray(S.turn.tools) ? [...S.turn.tools] : [],
            lastEventAtMs: Date.now(),
          })
          const liveTextOnlyDelta = Boolean(c?.text) && !c.tools?.length && !(c.images?.length || c.videos?.length || c.audios?.length || c.files?.length)
          afterLiveOrStructuralBump(targetSk, S, { liveTextOnly: liveTextOnlyDelta })
          if (c.tools?.length) {
            patchCollabFromStreamTools()
            // delta tool events: run clarification detection bridge
            detectAndScheduleClarificationRef.current(S, rt, targetSk, isBackground)
            if (rowHasPendingApprovalTools(S.turn.tools as unknown[])) {
              logToolApprovalPendingDetected({
                sessionKey: targetSk,
                runId: String(runId || ''),
                来源: 'stream_delta',
                工具数: (S.turn.tools as unknown[]).length,
              })
              dispatchSessionTurnEvent(targetSk, {
                type: 'ACTIVITY',
                kind: 'tool_approval',
                detail: '等待工具授权…',
              })
              if (!isBackground) {
                setThreadPanelState((prev) => ({
                  ...prev,
                  activityKind: 'tool_approval',
                  activityDetail: '等待工具授权…',
                }))
              }
            }
          }
          maybeSyncVoiceReplySpeech(targetSk, S, rt)
        }
        return
      }

      if (state === 'final') {
        endLiveStreamSession(targetSk)
        endClientPerfTurn(String(runId || rt.activeChatRunId || targetSk))
        markRunSealing(rt)
        dispatchSessionTurnEvent(targetSk, { type: 'SEALING' })
        dispatchSessionTurnEvent(targetSk, { type: 'SESSION_EVENT', at: Date.now() })
        flushPendingSessionTitle()
        if (!isBackground) {
          // 标题由后台异步生成并写库；合并为两次刷新（singleflight 会再合并叠请求），
          // 避免 1.5s/4s/8s 三次全量 sessions 风暴堵住 /messages。
          scheduleRefreshSessionsRef.current?.(1800)
          window.setTimeout(() => { scheduleRefreshSessionsRef.current?.(0) }, 5500)
        }
        const c = extractChatContent(payload.message)
        sfLog('ChatApp final enter', {
          sessionKey: targetSk,
          runId,
          activeChatRunId: rt.activeChatRunId,
          payloadTextLen: String(c?.text || '').length,
          payloadTextPreview: String(c?.text || '').slice(0, 120),
          payloadSegCount: Array.isArray((payload as { displaySegments?: unknown[] }).displaySegments)
            ? (payload as { displaySegments: unknown[] }).displaySegments.length
            : Array.isArray((payload as { display_segments?: unknown[] }).display_segments)
              ? (payload as { display_segments: unknown[] }).display_segments.length
              : 0,
          streamTimelineAuthoritative: !!(payload as { streamTimelineAuthoritative?: boolean })
            .streamTimelineAuthoritative,
          agui: sfSummarizeAgUi(S.aguiTurn),
          rowsBefore: sfSummarizeRowsTail(rt.rows),
        })
        let turn = mergeCompactedPartsIntoTurn(S.compactedParts || [], S.turn)
        /** 落库前剥离 checkpoint 回灌；剥离完成后才清空 runtime strip */
        const priorStripForFinal = priorStripForRuntime(rt)
        rt.priorTurnStrip = { ...EMPTY_RT_PRIOR_STRIP }
        const staleForMergedTurn = staleToolIdsExcludingTurnTools(rt.staleToolCallIds, turn)
        const finalText = String(c?.text || '')
        let finalTools = filterStaleToolEntries(c?.tools || [], staleForMergedTurn)
        if (!finalTools.length && turn.tools.length) {
          finalTools = filterStaleToolEntries([...turn.tools], staleForMergedTurn)
        }
        if (c?.images?.length || c?.videos?.length || c?.audios?.length || c?.files?.length) {
          const toolsForFileSuppress = finalTools.length ? finalTools : turn.tools
          const files =
            c.files?.length &&
            shouldSuppressStreamDeliveredFiles(toolsForFileSuppress, {
              streamingWritePreview: streamingWritePreviewRef.current,
              suppressForSendingWriteTurn: false,
            })
              ? []
              : c.files
          turn = reduceStreamTurn(turn, {
            type: 'media',
            images: c.images,
            videos: c.videos,
            audios: c.audios,
            files,
          })
        }
        const toolsForFinalRow = turn.tools?.length ? turn.tools : finalTools
        const stripFileCardsAfterWrite = (toolsForFinalRow as unknown[]).some((t) => isActiveWriteTool(t))
        if (finalTools.length) {
          finalTools = finalTools.map((t: unknown) => {
            const tool = t as Record<string, unknown>
            const hasOutput = tool.output != null && tool.output !== ''
            const status = String(tool.status || '').toLowerCase()
            if (hasOutput && (status === 'running' || status === 'in_progress')) {
              const mediaSt = mediaToolStatusFromOutput(tool.output)
              if (mediaSt) return { ...tool, status: mediaSt }
              return { ...tool, status: 'ok' }
            }
            return tool
          })
          const tools = [...turn.tools]
          for (const t of finalTools) upsertTool(tools, t)
          turn = { ...turn, tools: [...tools] }
          consumeLatestScenarioToolForSession(turn.tools, scenarioSessionHandlers)
          syncStreamMediaAssetsFromTools({ ...S, turn })
        }
        const toolsForEvoClarify = finalTools.length ? finalTools : [...turn.tools]
        const evoPendingClarification = toolsForEvoClarify.some(isAskClarificationToolPending)
        let evoClarificationSummary: string | null = null
        if (evoPendingClarification) {
          let clarifyPreview: string | null = null
          for (let ti = toolsForEvoClarify.length - 1; ti >= 0; ti--) {
            const hit = parseClarificationFromTool(toolsForEvoClarify[ti])
            if (hit?.preview) {
              clarifyPreview = hit.preview
              break
            }
          }
          evoClarificationSummary = formatAskClarificationForHosted(toolsForEvoClarify, clarifyPreview)
        }
        const preferStreamTimeline =
          !!(payload as { streamTimelineAuthoritative?: boolean }).streamTimelineAuthoritative ||
          streamTurnHasVisibleContent(turn) ||
          !!(S.aguiTurn && projectAgUiToStreamTurnFields(S.aguiTurn).timeline.length)
        let fin = authoritativeFinalFromPayload(
          finalizeStreamTurn(turn, preferStreamTimeline ? '' : finalText),
          payload as Record<string, unknown>,
        )
        if (S.aguiTurn) {
          // final 时再封一次：防止 RUN_FINISHED 丢失导致工具后 body 只在 openText
          sealOpenAgUiMessages(S.aguiTurn)
          syncAgUiCompatProjection(S.aguiTurn)
          const aguiFin = projectAgUiToStreamTurnFields(S.aguiTurn)
          const aguiTimeline = timelineWithOpenAgUiAssistantText(aguiFin.timeline, S.aguiTurn)
          if (
            (!segmentTimelineHasTextBody(fin.segments) ||
              !segmentTimelineHasPostToolText(fin.segments) ||
              !String(fin.text || '').trim() ||
              !Array.isArray(fin.segments) ||
              !fin.segments.length) &&
            (aguiTimeline.length || String(aguiFin.openText || '').trim())
          ) {
            const bodyText =
              String(finalText || '').trim() ||
              String(aguiFin.openText || '').trim() ||
              flattenStreamDisplayText(aguiTimeline, '').trim()
            const preferAguiSegments =
              aguiTimeline.length > 0 &&
              (!segmentTimelineHasTextBody(fin.segments) ||
                (segmentTimelineHasPostToolText(aguiTimeline) &&
                  !segmentTimelineHasPostToolText(fin.segments)) ||
                !Array.isArray(fin.segments) ||
                !fin.segments.length)
            fin = {
              ...fin,
              segments: preferAguiSegments ? aguiTimeline : fin.segments,
              text: String(fin.text || bodyText || finalText || '').trim(),
              reasoningPreview: fin.reasoningPreview || aguiFin.reasoningPreview || '',
              reasoningSegments: fin.reasoningSegments.length
                ? fin.reasoningSegments
                : aguiFin.reasoningSegments,
              tools: fin.tools.length ? fin.tools : aguiFin.tools,
            }
          }
        }
        fin = sanitizeFinalizedTurnForPersist(fin, priorStripForFinal)
        const segmentsOut = fin.segments
        const textOut = fin.text
        const hasContent =
          textOut ||
          (segmentsOut && segmentsOut.length) ||
          fin.images.length ||
          fin.videos.length ||
          fin.audios.length ||
          fin.files.length ||
          fin.tools.length

        sfLog('ChatApp final merged', {
          sessionKey: targetSk,
          runId,
          preferStreamTimeline,
          hasContent,
          textOutLen: String(textOut || '').length,
          textOutPreview: String(textOut || '').slice(0, 120),
          segments: sfSummarizeSegments(segmentsOut),
          finAfterAgui: sfSummarizeAgUi(S.aguiTurn),
        })

        if (!hasContent) {
          const usageStats = parseUsageToStats(payload as Record<string, unknown>)
          const hadModelInvocation = Boolean(usageStats && usageStats.input > 0)
          const streamStillVisible = streamRefHasVisibleContent(S)
          srLog('最终回合无可见内容，已丢弃', {
            sessionKey: targetSk,
            runId,
            hadModelInvocation,
            usage: usageStats || undefined,
            preferStreamTimeline,
            finalTextLen: String(finalText || '').length,
            textOutLen: String(textOut || '').length,
          })
          sfWarn('final dropped — no visible content', {
            sessionKey: targetSk,
            runId,
            hadModelInvocation,
            streamStillVisible,
            agui: sfSummarizeAgUi(S.aguiTurn),
            // Quota/auth fallbacks often finish with 0 tokens — still reload DB.
            willDbReload: !streamStillVisible,
          })
          voiceReplyPendingRef.current = false
          voiceSessionKeyRef.current = ''
          void setVoiceTrayState('idle')
          deleteLiveRunSnapshotBestEffort(targetSk)
          // Mid-stream model failures (e.g. 429 AccountQuotaExceeded) recover via
          // AIMessage + inject, but live deltas are often lost and usage stays 0.
          // Silent drop looks like "no response" — surface a system row and reload.
          if (!streamStillVisible) {
            applyRowsUpdate((r) => [
              ...r,
              {
                role: 'system' as const,
                text: '本回合没有生成可见回复（可能是模型额度用尽、认证失败或上游异常）。正在从会话记录同步…若仍为空，请切换模型或稍后再试。',
                timestamp: Date.now(),
              },
            ])
            void reloadRef.current?.({ bypassCache: true, dbOnly: true })
          }
          resetRuntimeStream(rt, isBackground ? undefined : streamRef)
          clearActiveRun(rt)
          maybeEndTurnSendingState(targetSk, rt, isBackground)
          flushPendingSessionTitle()
          deleteLiveRunSnapshotBestEffort(targetSk)
          scheduleBump({ immediate: true })
          return
        }

        deleteLiveRunSnapshotBestEffort(targetSk)

        if (runId) {
          rtAddSeenRun(rt, runId)
          if (rt.seenRunIds.length > 200) {
            rt.seenRunIds = rt.seenRunIds.slice(-200)
          }
          if (!isBackground) seenRunIdsRef.current = seenRunIdSet(rt)
        }

        const sessionRow = sessionsRef.current.find((s) => String(s.sessionKey || '') === targetSk)
        // 优先用会话行上已落库的 endedAt 作终点；若 final 事件触发时 DB 尚未回刷则 fallback 到 Date.now()
        const sealedEndMs = parseTurnTimestampMs(sessionRow?.currentTurnEndedAt)
        const elapsedSec = computeTurnElapsedSec(sessionRow, {
          endMs: sealedEndMs && sealedEndMs > 0 ? sealedEndMs : undefined,
          fallbackStartMs: rt.turnStartTs,
        })
        const durStr = elapsedSec != null ? formatTurnDurationStr(elapsedSec) : ''

        const usageStats = parseUsageToStats(payload as Record<string, unknown>)
        let tokenStr = ''
        if (usageStats && usageStats.total > 0) {
          tokenStr = formatUsageTokenStr(usageStats)
          if (!isBackground) {
            setTokenTotals((prev) => {
              const base = prev ?? { input: 0, output: 0, total: 0 }
              const next: TokenTotals = {
                input: base.input + usageStats.input,
                output: base.output + usageStats.output,
                total: base.total + usageStats.total,
              }
              const cacheRead = (base.cacheRead ?? 0) + ((usageStats as Record<string, number>).cacheRead ?? 0)
              const cacheCreation = (base.cacheCreation ?? 0) + ((usageStats as Record<string, number>).cacheCreation ?? 0)
              // @ts-ignore
              const cacheMiss = (base.cacheMiss ?? 0) + (usageStats.cacheMiss ?? 0)
              if (cacheRead > 0) next.cacheRead = cacheRead
              if (cacheCreation > 0) next.cacheCreation = cacheCreation
              if (cacheMiss > 0) next.cacheMiss = cacheMiss
              return next
            })
            setLiveTurnTokens(null)
          }
        }

        // 目标 Agent：须含 segments 合并后的可见全文（否则仅工具/分段流式时 textOut 为空，目标会卡住）
        const hostedCaptureText =
          flattenStreamDisplayText(segmentsOut || [], textOut || '').trim() ||
          (preferStreamTimeline ? '' : String(finalText || '').trim()) ||
          ''
        const hostedRunId = String(runId || S.runId || activeChatRunIdRef.current || '').trim()

        void goalCaptureRef.current.onChatFinal(
          {
            ...(payload as Record<string, unknown>),
            evoPendingClarification,
            evoClarificationSummary,
            runId: hostedRunId,
          },
          hostedCaptureText,
        )
        // 再用"最终展示文本"兜底推进目标（不依赖流式字段完整性）
        // @ts-expect-error extra args not in type signature
        void goalCaptureRef.current.onTargetAssistantText(hostedCaptureText, {
          runId: hostedRunId,
          evoPendingClarification,
          evoClarificationSummary,
        })

        // final 合并工具（须在写 rows 前完成，避免落库仅 name 的 plan 行）
        // 必须始终并入 turn.tools（含 AG-UI drain 进 compactedParts 的 read 等），
        // 不能只信 fin.tools / payload tools——否则 delete 待审批封存时会把上一轮工具丢掉。
        const streamToolsSnap = filterStaleToolEntries(
          [...((turn.tools || []) as unknown[])],
          staleForMergedTurn,
        )
        const finToolsForTurn = mergeToolsForPlanDetection(
          filterStaleToolEntries(
            (fin.tools?.length ? fin.tools : []) as unknown[],
            staleForMergedTurn,
          ),
          streamToolsSnap,
          filterStaleToolEntries((finalTools || []) as unknown[], staleForMergedTurn),
        )
        absorbPlanFromTools(streamToolsSnap)
        absorbPlanFromTools(finToolsForTurn)
        const toolsForCollab = enrichToolsWithCachedPlanInput(
          mergeToolsForPlanDetection(
            finToolsForTurn,
            streamToolsSnap,
            filterStreamToolEntriesForRuntime(rt, lastPlanDetectionToolsRef.current || []),
          ),
          {
            planInput: persistedPlanInputRef.current || undefined,
            boundPlanReady: planStreamLatchRef.current?.boundPlanReady,
            taskId: planStreamLatchRef.current?.taskId,
          },
        )
        lastPlanDetectionToolsRef.current = toolsForCollab
        // 深克隆工具 + 冻结 _terminalData，切断与 S.turn.tools 的引用链
        // 原始工具对象的 _terminalStream 保留继续接收流式事件，克隆体携带冻结快照
        const toolsForPersistedRow = (finToolsForTurn as unknown[]).map((t) => {
          const tool = t as Record<string, unknown>
          const clone = { ...tool }
          const stream = clone._terminalStream as TerminalStreamTask | undefined
          if (stream) {
            clone._terminalData = cloneTerminalStreamTask(stream)
            delete clone._terminalStream
          }
          return clone
        }) as DisplayRow['tools']

        // 添加新消息到 rows
        const subagentSnap =
          S.subagentTasks && Object.keys(S.subagentTasks).length > 0 ? { ...S.subagentTasks } : undefined
        const terminalSnap = cloneTerminalStreamsMap(S.terminalStreams)
        const canonicalOutText = textOut
        const segmentsOutFiltered = fin.segments
          ? filterStaleToolTimelineSegments(fin.segments, staleForMergedTurn)
          : fin.segments
        const segmentsForUi = segmentsOutFiltered
        const sealRunId = hostedRunId || String(runId || rt.activeChatRunId || S.runId || '').trim()
        const deferGoalSeal =
          !isBackground &&
          goalActiveRef.current &&
          (isSessionGoalActive(targetSk) || turnBusyForSession(targetSk))
        const awaitingToolApproval =
          !toolApprovalUiDisabled &&
          rowHasPendingApprovalTools((toolsForPersistedRow || []) as unknown[])
        const streamSnapForFinal =
          !isBackground &&
          streamRefHasVisibleContent(S) &&
          !(
            (payload as { streamTimelineAuthoritative?: boolean }).streamTimelineAuthoritative &&
            Array.isArray((payload as { displaySegments?: unknown[] }).displaySegments) &&
            (payload as { displaySegments: unknown[] }).displaySegments.length > 0
          )
            ? buildStreamDisplayRow(
                { current: S },
                tokenStr,
                stripFileCardsAfterWrite,
                true,
                priorStripForFinal,
                targetSk,
              )
            : null
        applyRowsUpdate((r) => {
          const reasoningSegs = fin.reasoningSegments
            .map((s) => String(s || '').trim())
            .filter(Boolean)
          const reasoningPreview = fin.reasoningPreview ? String(fin.reasoningPreview).trim() || null : null
          const outText = canonicalOutText
          if (
            !String(outText || '').trim() &&
            !(segmentsOutFiltered && segmentsOutFiltered.length) &&
            !(toolsForPersistedRow || []).length
          ) {
            sfWarn('applyRowsUpdate noop — row has no text/segments/tools', {
              sessionKey: targetSk,
              runId,
              outTextLen: String(outText || '').length,
              segments: sfSummarizeSegments(segmentsOutFiltered),
            })
            return r
          }
          const nextRow: DisplayRow = {
            role: 'assistant' as const,
            text: outText,
            reasoningPreview,
            ...(reasoningSegs.length ? { reasoningSegments: reasoningSegs } : {}),
            segments: segmentsForUi,
            tools: [...(toolsForPersistedRow || [])],
            images: [...fin.images],
            videos: [...fin.videos],
            audios: [...fin.audios],
            files: stripFileCardsAfterWrite ? [] : [...fin.files],
            timestamp: Date.now(),
            ...(deferGoalSeal || awaitingToolApproval
              ? { incompleteStream: true as const }
              : {
                  durationStr: durStr || undefined,
                  tokenStr: tokenStr || undefined,
                }),
            ...(sealRunId ? { runId: sealRunId } : {}),
            ...(subagentSnap ? { subagentTasks: subagentSnap } : {}),
            ...(terminalSnap ? { terminalStreams: terminalSnap } : {}),
          }
          if (nextRow.segments?.length && String(nextRow.text || '').trim()) {
            const segPlain = flattenStreamDisplayText(nextRow.segments, '').trim()
            if (segPlain && assistantBodiesLooselySame(segPlain, nextRow.text)) {
              nextRow.text = ''
            }
          }
          const rowForCommit = mergeStreamSnapIntoAssistantRow(nextRow, streamSnapForFinal)
          const base = stripMidTurnPartialAssistantRows(r)
          const collapsed = collapseToolApprovalContinuationRows(base, rowForCommit, {
            keepIncomplete: !!(deferGoalSeal || awaitingToolApproval),
            durationStr: durStr || undefined,
            tokenStr: tokenStr || undefined,
            sealRunId: sealRunId || undefined,
          })
          if (collapsed) {
            sfLog('applyRowsUpdate collapse-approval-continuation', {
              sessionKey: targetSk,
              runId,
              rowsBefore: base.length,
              rowsAfter: collapsed.length,
              keepIncomplete: !!(deferGoalSeal || awaitingToolApproval),
            })
            return collapsed
          }
          const last = base[base.length - 1]
          const turnAssistant = findAssistantRowAfterLastUser(base)
          const dedupTarget =
            last?.role === 'assistant'
              ? last
              : turnAssistant ?? findAssistantRowBeforeTrailingUser(base)
          const dedupIndex =
            last?.role === 'assistant'
              ? base.length - 1
              : turnAssistant
                ? base.indexOf(turnAssistant)
                : -1
          const prevComparable = dedupTarget ? comparableAssistantText(dedupTarget) : ''
          const nextComparable = comparableAssistantText(rowForCommit)
          const continueIncomplete = dedupTarget?.incompleteStream === true
          const mergeIntoMidTurn = shouldMergeFinalIntoPriorAssistant(
            dedupTarget,
            rowForCommit,
            sealRunId,
          )
          const shouldMergeAssistant =
            dedupTarget?.role === 'assistant' &&
            (continueIncomplete || mergeIntoMidTurn
              ? !!(
                  nextComparable ||
                  (toolsForPersistedRow || []).length ||
                  (rowForCommit.segments || []).length
                )
              : !!(
                  nextComparable &&
                  (shouldReplaceFinalAssistantRow(dedupTarget, rowForCommit) ||
                    (prevComparable && assistantBodiesLooselySame(prevComparable, nextComparable)) ||
                    (!!sealRunId &&
                      !!String(dedupTarget.runId || '').trim() &&
                      (String(dedupTarget.runId) === sealRunId ||
                        chatRunIdsSameTurn(String(dedupTarget.runId), sealRunId))))
                ))
          if (shouldMergeAssistant && dedupIndex >= 0) {
            if (debugAssistantDedupEnabled()) {
               
              console.debug('[assistant-dedup] replace-prior', { runId, dedupIndex, continueIncomplete, mergeIntoMidTurn })
            }
            sfLog('applyRowsUpdate merge-prior', {
              sessionKey: targetSk,
              runId,
              dedupIndex,
              continueIncomplete,
              mergeIntoMidTurn,
              prevComparable: prevComparable.slice(0, 80),
              nextComparable: nextComparable.slice(0, 80),
            })
            const mergedCore =
              continueIncomplete || mergeIntoMidTurn
              ? mergeAssistantRowWithStreamRow(
                  { ...dedupTarget, incompleteStream: true },
                  rowForCommit,
                )
              : {
                  ...dedupTarget,
                  ...rowForCommit,
                  tools: mergeToolsForPlanDetection(
                    dedupTarget.tools || [],
                    toolsForPersistedRow || [],
                  ),
                }
            const merged: DisplayRow =
              deferGoalSeal || awaitingToolApproval
                ? {
                    ...mergedCore,
                    incompleteStream: true,
                    durationStr: undefined,
                    tokenStr: undefined,
                  }
                : (() => {
                    const { incompleteStream: _i, ...rest } = mergedCore as DisplayRow & {
                      incompleteStream?: boolean
                    }
                    return {
                      ...rest,
                      ...(rowForCommit.durationStr
                        ? { durationStr: rowForCommit.durationStr }
                        : {}),
                      ...(rowForCommit.tokenStr ? { tokenStr: rowForCommit.tokenStr } : {}),
                    }
                  })()
            return [...base.slice(0, dedupIndex), merged, ...base.slice(dedupIndex + 1)]
          }
          if (
            turnAssistant &&
            prevComparable &&
            nextComparable &&
            assistantBodiesLooselySame(prevComparable, nextComparable)
          ) {
            if (debugAssistantDedupEnabled()) {
               
              console.debug('[assistant-dedup] skip-duplicate', { runId })
            }
            sfWarn('applyRowsUpdate skip-duplicate', {
              sessionKey: targetSk,
              runId,
              comparable: nextComparable.slice(0, 80),
            })
            return collapseSameTurnAssistantsInRows(base)
          }
          if (debugAssistantDedupEnabled() && dedupTarget?.role === 'assistant') {
             
            console.debug('[assistant-dedup] append-new', { runId, reason: 'after_user_turn' })
          }
          sfLog('applyRowsUpdate append', {
            sessionKey: targetSk,
            runId,
            textPreview: String(rowForCommit.text || '').slice(0, 120),
            segments: sfSummarizeSegments(segmentsForUi),
            rowsAfter: base.length + 1,
          })
          return collapseSameTurnAssistantsInRows([...base, rowForCommit])
        })
        if (!isBackground && uiSk && targetSk === uiSk) {
          const committed = getSessionRuntime(targetSk).rows
          setRows([...committed])
          rowsRef.current = committed
        }
        sfLog('ChatApp final rows committed', {
          sessionKey: targetSk,
          runId,
          rowsAfter: sfSummarizeRowsTail(getSessionRuntime(targetSk).rows),
        })
        if (
          hasContent &&
          !isBackground &&
          String(sessionRef.current || selectedSessionKey || '').trim() === targetSk
        ) {
          setLiveTurnAssistantRunId(sealRunId || `turn-${Date.now()}`)
        }

        const cachedPlanHit = planPanelHit || lastPlanPanelHitRef.current
        const toolsForPlanAnalyze = enrichToolsWithCachedPlanInput(toolsForCollab, cachedPlanHit)
        const planFinal = analyzePlanTools(toolsForPlanAnalyze)
        const effectivePlanHit = planFinal.hit || cachedPlanHit
        if (effectivePlanHit) {
          publishPlanPanelHit(effectivePlanHit)
        }
        const dockFallbackEarly = pickRicherStructuredPlanInput(
          effectivePlanHit?.planInput || null,
          threadPanelState.planInputFallback,
        )
        const planCtxAtFinal =
          planFinal.planRows.length > 0 ||
          !!planStreamLatchRef.current ||
          !!(effectivePlanHit?.planInput || effectivePlanHit?.boundPlanReady || dockFallbackEarly)
        if (!isBackground && !planCtxAtFinal) {
          syncPlanPanelImmediateFromTools(toolsForPlanAnalyze)
        }
        if (!isBackground && !planCtxAtFinal && (effectivePlanHit?.planInput || effectivePlanHit?.boundPlanReady)) {
          const richer = pickRicherStructuredPlanInput(
            effectivePlanHit.planInput || null,
            threadPanelState.planInputFallback,
          )
          setThreadPanelState((prev) => ({
            ...prev,
            planInputFallback: richer || prev.planInputFallback || null,
            collabPhase: effectivePlanHit.boundPlanReady
              ? 'plan_ready'
              : prev.collabPhase === 'executing' || prev.collabPhase === 'awaiting_exec'
                ? prev.collabPhase
                : effectivePlanHit.planInput
                  ? 'planning'
                  : prev.collabPhase,
          }))
        }
        resetRuntimeStream(rt, isBackground ? undefined : streamRef)
        clearActiveRun(rt)
        sfLog('ChatApp final stream reset', {
          sessionKey: targetSk,
          runId,
          rtRowsLen: rt.rows.length,
        })
        if (!isBackground) activeChatRunIdRef.current = null
        if (awaitingToolApproval) {
          logToolApprovalStreamFinal({
            sessionKey: targetSk,
            runId: String(runId || ''),
            待授权工具数: (toolsForPersistedRow || []).filter((t) =>
              String((t as { status?: string })?.status || '').toLowerCase() === 'pending_approval',
            ).length,
          })
          dispatchSessionRunEnded(targetSk)
          dispatchSessionTurnEvent(targetSk, {
            type: 'ACTIVITY',
            kind: 'tool_approval',
            detail: '等待工具授权…',
          })
          if (!isBackground) {
            setStreamHealth(null)
            streamHealthRef.current = null
            setThreadPanelState((prev) => ({
              ...prev,
              activityKind: 'tool_approval',
              activityDetail: '等待工具授权…',
            }))
          }
        } else {
          const endedIso = new Date().toISOString()
          setSessions((prev) => patchSessionListRunEnded(prev, targetSk, { endedAt: endedIso, terminalStatus: 'done' }))
          clearSessionExecutionStateForEnded(targetSk)
          seedSessionRuntimeStatusIdle(targetSk)
          invalidateSessionRuntimeStatusCache(targetSk)
          const completedRunId = String(sealRunId || runId || rt.activeChatRunId || '').trim()
          const skForMark = String(targetSk || sessionRef.current || selectedSessionKey || '').trim()
          if (skForMark && completedRunId && !deferGoalSeal) {
            markRunCompleted(skForMark, completedRunId)
          }
          maybeEndTurnSendingState(targetSk, rt, isBackground, { force: true })
        }
        if (isBackground) {
          const bgTitle =
            String(
              sessionsRef.current.find((s) => String(s.sessionKey || '') === targetSk)?.title || '',
            ).trim() || '后台会话'
          toast(`${bgTitle}：回复已完成`, 'info')
          void refreshSessionsRef.current?.({ skipAutoReselect: true, summariesOnly: true })
        } else {
          void refreshSessionsRef.current?.({ skipAutoReselect: true })
        }
        const built = buildCollabSidebarFromTools(toolsForCollab) as {
          main: CollabTaskSnapshot | null
          subtasks: CollabSubtaskSnapshot[]
          supervisorSteps: SupervisorStepSnapshot[]
        }
        const collabSnap = built.main
        const finalSubtasks = built.subtasks || []
        const finalTaskId = String(collabSnap?.taskId || effectivePlanHit?.taskId || '').trim()
        const hitForApply = planFinal.hit || effectivePlanHit
        const dockFallback = dockFallbackEarly
        const finalSk = String(targetSk || sessionRef.current || selectedSessionKey || '').trim()
        const planTaskId = String(
          finalTaskId ||
            hitForApply?.taskId ||
            planStreamLatchRef.current?.taskId ||
            '',
        ).trim()
        const planBoundReady = !!(
          hitForApply?.boundPlanReady || planStreamLatchRef.current?.boundPlanReady
        )
        if (planCtxAtFinal || planBoundReady || planTaskId || collabOn) {
          if (finalSk) {
            void refreshPlanDockAfterStreamFinalRef.current({
              sessionKey: finalSk,
              hintTaskId: planTaskId,
              retryUntilPlanned:
                collabOn ||
                planBoundReady ||
                !!(planStreamLatchRef.current as { boundPlanReady?: boolean } | null)?.boundPlanReady,
              fallback: hitForApply?.planInput ?? null,
            })
          }
        }
        if (!isBackground) {
          tracePlanPipeline('final', toolsForPlanAnalyze, {
            planHit: hitForApply,
            collabPhase: effectivePlanHit?.boundPlanReady
              ? 'plan_ready'
              : hitForApply?.planInput
                ? threadPanelState.collabPhase || 'planning'
                : threadPanelState.collabPhase,
            collabTask: threadPanelState.collabTask,
            planInputFallback: dockFallback,
            subtaskCount: finalSubtasks.length,
            isSuppressed: isPlanExecDockSuppressed(finalTaskId, finalSubtasks.length),
            streamPlanLatched: planStreamLatched || !!planStreamLatchRef.current,
            latchedPlanInput:
              planStreamLatchRef.current?.planInput ||
              dockFallback ||
              null,
          })
        }
        upsertSidebarTaskView(
          collabSnap || null,
          finalSubtasks.length > 0 ? finalSubtasks : undefined,
          built.supervisorSteps,
        )
        if (finalTaskId && !planCtxAtFinal) {
          if (
            finalSubtasks.length === 0 ||
            finalSubtasks.some((s) => isPendingSubtaskKey(s.subtaskId))
          ) {
            void ensureSubtasksVisibleForTask(finalTaskId)
          }
          const threadIdForSnap = wsClient.getSessionThreadId(finalSk) || ''
          if (threadIdForSnap) {
            void wsClient
              .hydrateCollabSidebarSnapshot(threadIdForSnap, finalTaskId)
              .then((snap: Record<string, unknown> | null) => {
                if (snap) applyTaskProgressSnapshot(snap, { sessionKey: finalSk })
              })
              .catch(() => {})
          }
        }
        const hp = extractGoalProposalFromTools(finalTools)
        const proposeMode = getGoalProposeActionMode()
        const clarifyFromFinal = effectivePlanHit?.boundPlanReady
          ? null
          : extractLatestClarificationFromRows(rt.rows)
        if (!isBackground && hp && proposeMode !== 'dock') {
          queueMicrotask(() => {
            try {
              applyGoalProposalRef.current(hp, { start: proposeMode === 'auto_start' })
              suppressedGoalProposalKeysRef.current.add(goalProposalSuppressKey(hp))
            } catch (e) {
              console.error('[ChatApp] applyGoalProposal auto', e)
              toast(toUserFacingError((e as Error)?.message || e, '目标方案自动应用失败'), 'error')
            }
          })
        }
        if (!isBackground) {
          setThreadPanelState((prev) => ({
            title: prev.title,
            todos: prev.todos,
            activityKind: 'idle',
            activityDetail: '',
            reasoningPreview: null,
            // Keep pending clarification visible after stream final unless plan is ready.
            clarification: effectivePlanHit?.boundPlanReady
              ? null
              : mergeThreadPanelClarification(prev.clarification, clarifyFromFinal),
            goalProposal: hp ? (proposeMode === 'dock' ? hp : null) : prev.goalProposal,
            planInputFallback:
              effectivePlanHit?.planInput ||
              prev.planInputFallback ||
              null,
            collabPhase: planCtxAtFinal
              ? prev.collabPhase
              : effectivePlanHit?.boundPlanReady
                ? 'plan_ready'
                : effectivePlanHit?.planInput && prev.collabPhase !== 'executing' && prev.collabPhase !== 'awaiting_exec'
                  ? 'planning'
                  : prev.collabPhase,
            boundTaskId: prev.boundTaskId,
            collabTask:
              collabSnap?.taskId != null
                ? { ...(prev.collabTask || {}), ...collabSnap }
                : prev.collabTask,
            collabSubtasks:
              finalSubtasks.length > 0
                ? finalizeCollabSubtasksList(finalSubtasks, subagentSnap || prev.subagentTasks)
                : collabSnap?.taskId && (prev.collabTask?.taskId || '').trim() !== collabSnap.taskId
                  ? []
                  : prev.collabSubtasks,
            // final 会 emptyStream() 清空 streamRef；侧栏 SessionSidebar 用 subagentTasks.phase 修正「协作快照仍为 executing」的展示，此处必须保留本轮快照，否则流结束后会丢 phase 又转圈
            subagentTasks: subagentSnap ? { ...subagentSnap } : prev.subagentTasks || {},
            supervisorSteps:
              collabSnap?.taskId && (prev.collabTask?.taskId || '').trim() !== collabSnap.taskId
                ? built.supervisorSteps
                : built.supervisorSteps.length
                  ? built.supervisorSteps
                  : prev.supervisorSteps,
          }))
        }
        const voiceSkFinal = String(voiceSessionKeyRef.current || '').trim()
        const replySkFinal = String(eventSk || targetSk || '').trim()
        if (voiceReplyPendingRef.current && voiceSkFinal && replySkFinal === voiceSkFinal) {
          const speechBody = buildVoiceSpeechBodyForRuntime(rt, {
            hostedCaptureText: hostedCaptureText || undefined,
            segments: segmentsOut || [],
            text: textOut || '',
            canonicalOutText: canonicalOutText || textOut || '',
          })

          voiceReplyPendingRef.current = false
          voiceSessionKeyRef.current = ''
          voiceStreamingStartedRef.current = false
          voiceSpeechSyncedPlainRef.current = ''

          if (speechBody) {
            void import('../lib/voice-reply-speech.js').then(({ flushVoiceStreamSpeechIfNeeded }) => {
              const flushed = flushVoiceStreamSpeechIfNeeded(speechBody)
              if (flushed) {
                void setVoiceTrayState('speaking')
                window.setTimeout(() => {
                  void setVoiceTrayState('idle')
                }, 4000)
              } else {
                void setVoiceTrayState('idle')
              }
            })
          } else {
            void setVoiceTrayState('idle')
          }
        }
        flushPendingSessionTitle()
        scheduleBump({ immediate: true })
        if (!isBackground) {
          void refreshSessionsRef.current?.({ skipAutoReselect: true })
        }
        const skPersist = String(targetSk || sessionRef.current || selectedSessionKey || '').trim()
        // 优化：仅当流式 final 未产出正文/工具时才拉 DB 对账（正常完成时流式内容即为权威值）
        // 注意：preferStreamTimeline=true 时正文在 segments 中，finalText(payload 文本)可能为空
        // 但 segmentsOut 非空 → 此时流式内容已完整，不应触发 DB 对账覆盖好的流式 row
        const streamProducedContent =
          !!String(finalText || '').trim() ||
          !!String(textOut || '').trim() ||
          !!(segmentsOut && segmentsOut.length) ||
          !!finalTools.length
        if (skPersist && !streamProducedContent) {
          void reconcileLastAssistantFromDbRef.current({
            sessionKey: skPersist,
            runId: sealRunId || runId || null,
          })
        }
        if (!isBackground && skPersist && !effectivePlanHit?.boundPlanReady) {
          const awaitingFinal = findAskClarificationAwaitingUserInRows(rt.rows)
          const finalTcid = String(
            (awaitingFinal?.tool as { id?: string; tool_call_id?: string } | undefined)?.id ||
              (awaitingFinal?.tool as { tool_call_id?: string } | undefined)?.tool_call_id ||
              peekClarificationLatch(skPersist) ||
              '',
          ).trim()
          scheduleClarificationPanelResolveRef.current(skPersist, {
            toolCallId: finalTcid || undefined,
            localTool: awaitingFinal?.tool,
            preferToolRetries: true,
          })
        }
        if (!isBackground && skPersist) {
          void notifyDesktopCompletion({
            title: 'EvoFlow · 对话完成',
            body: '本轮 AI 回复已完成',
            tag: `chat-final:${skPersist}`,
          })
        }
        // TitleMiddleware writes LLM title to DB in background; pick it up after a short delay.
        window.setTimeout(
          () =>
            void refreshSessionsRef.current?.({
              skipAutoReselect: true,
              summariesOnly: true,
            }),
          2500,
        )
        if (!isBackground) {
          window.setTimeout(
            () => void refreshSessionsRef.current?.({ skipAutoReselect: true, summariesOnly: true }),
            8000,
          )
        }
        return
      }

      if (state === 'aborted') {
        flushPendingSessionTitle()
        if (!shouldApplyChatEvent(rt, payload, {
          allowSealingTerminal: true,
          knownRunId: sessions.find((s) => s.sessionKey === targetSk)?.currentRunId || null,
          expectedRunId: getExpectedChatRunId(targetSk),
        })) {
          return
        }
        markRunSealing(rt)
        if (!userInitiatedStopRef.current) {
          // 断流/切后台等非用户主动停止：保留已收到的流式快照并标记降级，
          // 避免 live 投影随 turnPhase 归 idle 后消息区变空——这是「思考着思考着就没了」的根因。
          const stoppedRun = runId || S.runId || rt.activeChatRunId
          if (streamTurnHasVisibleContent(S.turn) && !rowsAlreadyStopSealedForTurn(rt.rows)) {
            sealStoppedStreamTurn(rt, S.turn, stoppedRun)
            applyRowsUpdate((r) => [
              ...r,
              buildPartialStreamAssistantRow(S.turn, stoppedRun, priorStripForRuntime(rt)),
              { role: 'system' as const, text: DEGRADED_SNAPSHOT_SYSTEM_TEXT, timestamp: Date.now() },
            ])
          } else if (stoppedRun) {
            rtAddStoppedRun(rt, stoppedRun)
          }
          resetRuntimeStream(rt, isBackground ? undefined : streamRef)
          clearActiveRun(rt)
          abortSessionTurnEnded(targetSk, {
            stopRunId: stoppedRun,
            clearActiveRun: false,
          })
          setSessions((prev) => patchSessionListRunEnded(prev, targetSk, { terminalStatus: 'cancelled' }))
          clearSessionExecutionStateForEnded(targetSk)
          if (!isBackground) {
            setStreamHealth(null)
            streamHealthRef.current = null
          }
          scheduleBump({ immediate: true })
          return
        }
        // 不在此处重置 userInitiatedStopRef——由 stopSessionExecution finally 统一重置，
        // 避免过早重置导致后续迟到帧（如 run_started）穿透守卫重新激活流式状态
        if (!turnBusyForSession(targetSk) && !streamTurnHasVisibleContent(S.turn)) {
          return
        }
        if (suppressNextAbortToastRef.current) {
          suppressNextAbortToastRef.current = false
          return
        }
        if (streamTurnHasVisibleContent(S.turn)) {
          commitPriorTurnStripFromStreamTurn(rt, S.turn)
          sealStoppedStreamTurn(rt, S.turn, runId || S.runId || rt.activeChatRunId)
          let didAppend = false
          applyRowsUpdate((r) => {
            if (rowsAlreadyStopSealedForTurn(r)) return r
            didAppend = true
            return [
              ...r,
              buildPartialStreamAssistantRow(
                S.turn,
                runId || S.runId || rt.activeChatRunId,
                priorStripForRuntime(rt),
              ),
            ]
          })
          if (didAppend) {
            const liveSnap = buildLiveRunSnapshotPayload(S)
            putLiveRunSnapshotBestEffort(targetSk, {
              runId: String(runId || S.runId || rt.activeChatRunId || ''),
              threadId: String(wsClient.getSessionThreadId(targetSk) || '').trim() || null,
              status: 'aborted',
              ...liveSnap,
              partialTools: Array.isArray(S.turn.tools) ? [...S.turn.tools] : [],
              lastEventAtMs: Date.now(),
            })

          }
        } else {
          const stoppedRun = runId || S.runId || rt.activeChatRunId
          if (stoppedRun) rtAddStoppedRun(rt, stoppedRun)
        }
        applyRowsUpdate((r) =>
          rowsAlreadyStopSealedForTurn(r)
            ? r
            : [...r, { role: 'system' as const, text: '生成已停止', timestamp: Date.now() }],
        )
        resetRuntimeStream(rt, isBackground ? undefined : streamRef)
        clearActiveRun(rt)
        abortSessionTurnEnded(targetSk, {
          stopRunId: runId || S.runId || rt.activeChatRunId,
          clearActiveRun: false,
        })
        setSessions((prev) => patchSessionListRunEnded(prev, targetSk, { terminalStatus: 'cancelled' }))
        clearSessionExecutionStateForEnded(targetSk)
        setExpectedChatRunId(targetSk, null)
        if (!isBackground) {
          activeChatRunIdRef.current = null
          setSubagentDockTasks({})
          setThreadPanelState(clearThreadPanelActivity)
          setStreamHealth(null)
          streamHealthRef.current = null
        }
        scheduleBump({ immediate: true })
        return
      }

      if (state === 'stream_health') {
        const healthStatus = payload.status
        if (healthStatus === 'disconnected') {
          if (!isBackground) streamHealthRef.current = 'disconnected'
          if (!isBackground) setStreamHealth('disconnected')
        } else if (healthStatus === 'silent') {
          if (!isBackground) streamHealthRef.current = 'silent'
          if (!isBackground) setStreamHealth('silent')
        }
        if ((healthStatus === 'disconnected' || healthStatus === 'silent') && streamTurnHasVisibleContent(S.turn)) {
          const liveSnap = buildLiveRunSnapshotPayload(S)
          putLiveRunSnapshotBestEffort(targetSk, {
            runId: String(runId || S.runId || rt.activeChatRunId || ''),
            threadId: String(wsClient.getSessionThreadId(targetSk) || '').trim() || null,
            status: healthStatus,
            ...liveSnap,
            partialTools: Array.isArray(S.turn.tools) ? [...S.turn.tools] : [],
            lastEventAtMs: Date.now(),
          })
          dispatchSessionTurnEvent(targetSk, {
            type: 'REATTACH_DEGRADED',
            runId: rt.activeChatRunId,
            threadId: wsClient.getSessionThreadId(targetSk),
          })
          dispatchSessionTurnEvent(targetSk, { type: 'SESSION_EVENT', at: Date.now() })
        }
        scheduleBump()
        return
      }

      if (state === 'error') {
        const voiceSkErr = String(voiceSessionKeyRef.current || '').trim()
        const replySkErr = String(eventSk || targetSk || '').trim()
        if (voiceReplyPendingRef.current && voiceSkErr && replySkErr === voiceSkErr) {
          voiceReplyPendingRef.current = false
          voiceSessionKeyRef.current = ''
          voiceStreamingStartedRef.current = false
          void setVoiceTrayState('idle')
        } else if (!isBackground) {
          voiceReplyPendingRef.current = false
        }
        flushPendingSessionTitle()
        const rawErr = String(
          payload.errorMessage ||
            payload.error?.message ||
            // @ts-ignore
            (payload as Record<string, unknown>).error?.error ||
            '',
        ).trim()
        if (/userinterrupt|user\s*interrupt/i.test(rawErr)) {
          dispatchSessionTurnEvent(targetSk, {
            type: 'REATTACH_DEGRADED',
            runId: null,
            threadId: wsClient.getSessionThreadId(targetSk),
          })
          deleteLiveRunSnapshotBestEffort(targetSk)
          dispatchSessionRunEnded(targetSk)
          setSessions((prev) => patchSessionListRunEnded(prev, targetSk, { terminalStatus: 'cancelled' }))
          clearSessionExecutionStateForEnded(targetSk)
          if (!isBackground) {
            setStreamHealth(null)
            streamHealthRef.current = null
          }
          scheduleBump({ immediate: true })
          return
        }
        if (/origin not allowed|NOT_PAIRED|PAIRING_REQUIRED|auth.*fail/i.test(rawErr)) {
          dispatchSessionTurnEvent(targetSk, { type: 'REATTACH_FAILED' })
          dispatchSessionTurnEvent(targetSk, { type: 'SESSION_EVENT', at: Date.now() })
          return
        }
        const errMsg = toUserFacingError(rawErr || '未知错误')
        if (!errMsg) {
          scheduleBump({ immediate: true })
          return
        }
        const now = Date.now()
        if (lastErrorRef.current.msg === errMsg && now - lastErrorRef.current.ts < 2000) return
        lastErrorRef.current = { msg: errMsg, ts: now }
        toast(errMsg, 'error')
        dispatchSessionTurnEvent(targetSk, { type: 'SEND_FAILED' })
        dispatchSessionTurnEvent(targetSk, { type: 'SESSION_EVENT', at: now })
        if (!turnBusyForSession(targetSk) && !streamTurnHasVisibleContent(S.turn)) {
          scheduleBump({ immediate: true })
          return
        }
        // Even if we already received partial output, stop the "sending" UI.
        if (!isBackground) {
          streamHealthRef.current = 'disconnected'
          setStreamHealth('disconnected')
        }
        // For network/timeout errors where there's no visible content, show a helpful retry hint.
        if (!streamTurnHasVisibleContent(S.turn)) {
          const isRecoverable = /超时|中断|网络|暂时不可用|请稍后/i.test(errMsg)
          applyRowsUpdate((r) => [
            ...r,
            {
              role: 'system' as const,
              text: isRecoverable
                ? '💡 连接已断开。如果是长时间分析，任务可能仍在后台运行，可以刷新会话后查看结果。'
                : errMsg,
              timestamp: Date.now(),
            },
          ])
          resetRuntimeStream(rt, isBackground ? undefined : streamRef)
          clearActiveRun(rt)
          finalizeSessionTurnEnded(targetSk, {
            stopRunId: rt.activeChatRunId || rt.stream.runId || runId,
          })
          setSessions((prev) => patchSessionListRunEnded(prev, targetSk, { terminalStatus: 'fail' }))
          clearSessionExecutionStateForEnded(targetSk)
        } else if (rt) {
          const stoppedRun = rt.activeChatRunId || rt.stream.runId || runId
          if (!rowsAlreadyStopSealedForTurn(rt.rows)) {
            sealStoppedStreamTurn(rt, S.turn, stoppedRun)
            applyRowsUpdate((r) => [
              ...r,
              buildPartialStreamAssistantRow(S.turn, stoppedRun, priorStripForRuntime(rt)),
              { role: 'system' as const, text: `生成中断：${errMsg}`, timestamp: Date.now() },
            ])
          }
          resetRuntimeStream(rt, isBackground ? undefined : streamRef)
          clearActiveRun(rt)
          finalizeSessionTurnEnded(targetSk, { stopRunId: stoppedRun })
          setSessions((prev) => patchSessionListRunEnded(prev, targetSk, { terminalStatus: 'fail' }))
          clearSessionExecutionStateForEnded(targetSk)
          if (!isBackground) {
            setStreamHealth(null)
            streamHealthRef.current = null
          }
        }
        scheduleBump({ immediate: true })
      }
      } finally {
        chatStreamBgApplyRef.current = false
        // 兜底：final/aborted/error 处理中异常抛出的情况下，确保 UI 状态被重置
        if (state === 'final' || state === 'aborted' || state === 'error') {
          if (!isBackground && (turnBusyForSession(targetSk) || streamRefHasVisibleContent(streamRef.current))) {
            const rtFin = targetSk ? getSessionRuntime(targetSk) : null
            if (rtFin) {
              resetRuntimeStream(rtFin, streamRef)
              clearActiveRun(rtFin)
              maybeEndTurnSendingState(targetSk, rtFin, isBackground)
            } else {
              setStreamHealth(null)
              streamHealthRef.current = null
            }
          }
        }
      }
    })
    return () => {
      if (unsubRef.current) {
        unsubRef.current()
        unsubRef.current = null
      }
    }
  }, [
    scheduleBump,
    scheduleReasoningBump,
    afterLiveOrStructuralBump,
    bumpSubtasksApiRefresh,
    bumpKnowledgeMapRefresh,
    setRows,
    refreshSessions,
    patchCollabFromStreamTools,
    applyTaskProgressSnapshot,
    upsertSidebarTaskView,
    hasReceivedTodos,
    selectedTurnBusy,
    openSessionSidebar,
    selectedSessionKey,
    streamHealth,
    clearTurnSendingState,
    maybeEndTurnSendingState,
  ])

  const streaming = selectedSessionKey
    ? isSessionRuntimeStreamVisible(String(selectedSessionKey))
    : false

  const selectedSessionLive = useMemo(() => {
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) return false
    const rt = getSessionRuntime(sk)
    return isTurnBusy(rt) || isSessionRuntimeLive(rt)
  }, [selectedSessionKey, executingListEpoch])
  const selectedResumeAttach = useMemo(() => {
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) return false
    const rt = getSessionRuntime(sk)
    const attach = deriveAttachState(rt)
    return attach === 'attaching' || attach === 'attached' || rt.turnPhase === 'reattaching'
  }, [selectedSessionKey, executingListEpoch])
  const selectedResumeStreamHold = useMemo(() => {
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) return false
    const rt = getSessionRuntime(sk)
    return rt.turnPhase === 'reattaching' || deriveAttachState(rt) === 'attaching'
  }, [selectedSessionKey, executingListEpoch])
  const sidebarHistory = useMemo(() => {
    const sk = String(selectedSessionKey || '').trim()
    return Object.values(sidebarTaskViews)
      .filter((x) => !sk || !x.sessionKey || x.sessionKey === sk)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((x) => x.task)
  }, [sidebarTaskViews, selectedSessionKey])

  const renderRows = useMemo(
    () => rows,
    [rows],
  )
  /**
   * 空会话才进「首页」：会隐藏底部输入条（首页自带输入）。
   * 历史加载失败、或本会话曾有消息后又被清空时，绝不能进首页，否则底部输入框消失。
   */
  const isHomeSurface =
    !historyLoading &&
    !historyError &&
    !sessionHadContent &&
    renderRows.length === 0 &&
    !selectedTurnBusy
  isHomeSurfaceRef.current = isHomeSurface
  /** Only while a real network fetch has no rows yet — never gate on scroll boot (historyViewReady). */
  const showHistoryFetchOverlay =
    renderRows.length === 0 &&
    historyLoading &&
    !selectedSessionLive &&
    !selectedTurnBusy
  const showHistorySyncHint =
    renderRows.length > 0 &&
    !historyViewReady &&
    (historyLoading || selectedSessionLive || selectedTurnBusy)

  /** 与输入区右下角 processing dock 同源；会话列表 running 行复用 ``dockLabel``。 */
  /** 流式「运行中」计时唯一标准：当前会话本轮 ``currentTurnStartedAt``（非整段 activity 环节）。 */
  const resolveLiveStreamActivityForSession = useCallback(
    (sessionKey: string, isSelectedRow: boolean): ResolvedLiveStreamActivity | null => {
      const sk = String(sessionKey || '').trim()
      if (!sk) return null
      const sessionRow = sessionsRef.current.find((s) => String(s.sessionKey || '') === sk)
      const executing = isSessionExecuting(sk, { sessionRow })
      if (!executing) return null
      const rt = getSessionRuntime(sk)
      const selectedSk = String(selectedSessionKey || '').trim()
      const useForegroundStream = isSelectedRow && sk === selectedSk
      const panel = useForegroundStream
        ? threadPanelStateRef.current
        : threadPanelBySessionRef.current.get(sk) || emptyThreadPanel()
      const streamTurn = useForegroundStream ? streamRef.current.turn : rt.stream.turn
      const elapsedSec = computeTurnElapsedSec(sessionRow, {
        fallbackStartMs: rt.turnStartTs,
      })
      return resolveComposerDockActivity({
        activityKind: rt.activity.kind !== 'idle' ? rt.activity.kind : panel.activityKind,
        activityDetail: rt.activity.detail || panel.activityDetail,
        streamSystemActivity: streamTurn.systemActivity,
        elapsedSec,
        activeTurn: executing,
      })
    },
    [selectedSessionKey],
  )

  const selectedLiveStreamActivity = useMemo(() => {
    void turnTimingTick
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) return null
    return resolveLiveStreamActivityForSession(sk, true)
  }, [
    selectedSessionKey,
    resolveLiveStreamActivityForSession,
    executingListEpoch,
    turnTimingTick,
  ])

  useEffect(() => {
    if (!selectedTurnBusy) return
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) return
    const rt = getSessionRuntime(sk)
    if (streamRefHasVisibleContent(streamRef.current)) return
    // 找最近一条已封口的 assistant（其后可能已有 ↑「待处理」用户行）
    let sealedAssistant: (typeof renderRows)[number] | null = null
    let pendingInjectAfterSeal = false
    for (let i = renderRows.length - 1; i >= 0; i--) {
      const r = renderRows[i]
      if (r?.role === 'assistant') {
        sealedAssistant = r
        break
      }
      if (r?.role === 'user' && r.pendingInject) {
        pendingInjectAfterSeal = true
        continue
      }
      break
    }
    if (
      !sealedAssistant ||
      !(sealedAssistant.durationStr || sealedAssistant.tokenStr) ||
      sealedAssistant.incompleteStream
    ) {
      return
    }
    const lastEventAt = Number(rt.lastEventAt || 0)
    const eventStale = !lastEventAt || Date.now() - lastEventAt > 3000
    // 有 ↑ 待处理 / sealing / 事件已停：强制 idle，避免 DB 残留 running 卡住 drain
    const force =
      pendingInjectAfterSeal || rt.turnPhase === 'sealing' || eventStale
    maybeEndTurnSendingState(sk, rt, false, force ? { force: true } : undefined)
  }, [selectedTurnBusy, renderRows, selectedSessionKey, maybeEndTurnSendingState])

  /** stream 空闲后冲刷延迟写入的自动标题（绑定 sessionKey，避免串到新会话）。 */
  useEffect(() => {
    const pending = pendingAutoSessionTitleRef.current
    if (!pending?.sessionKey || !pending.title) return
    const pendingRt = getSessionRuntime(pending.sessionKey)
    const pendingStreaming =
      isTurnBusy(pendingRt) ||
      streamRefHasVisibleContent(pendingRt.stream) ||
      (String(sessionRef.current || '').trim() === pending.sessionKey &&
        (streamRefHasVisibleContent(streamRef.current) || selectedTurnBusy))
    if (pendingStreaming) return
    pendingAutoSessionTitleRef.current = null
    persistSessionTitleIfMissing(pending.sessionKey, pending.title)
  }, [executingListEpoch, selectedTurnBusy, selectedSessionKey])

  const lastAssistantRowIndex = useMemo(() => {
    for (let i = renderRows.length - 1; i >= 0; i--) {
      if (renderRows[i]?.role === 'assistant') return i
    }
    return -1
  }, [renderRows])

  const selectedSessionRow = useMemo(() => {
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) return null
    return sessions.find((s) => String(s.sessionKey || '') === sk) ?? null
  }, [selectedSessionKey, sessions])

  const liveTurnTimingActive = !historyLoading && isTurnTimingLive(selectedSessionRow)

  const sessionPersistedTokenTotals = useMemo((): TokenTotals | null => {
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) return null
    const row = sessions.find((s) => String(s.sessionKey || '') === sk)
    if (!row) return null
    const total = Number(row.totalTokens) || 0
    if (total <= 0) return null
    return {
      input: Number(row.inputTokens) || 0,
      output: Number(row.outputTokens) || 0,
      total,
      ...(Number(row.cacheReadTokens) > 0 ? { cacheRead: Number(row.cacheReadTokens) } : {}),
      ...(Number(row.cacheCreationTokens) > 0 ? { cacheCreation: Number(row.cacheCreationTokens) } : {}),
      ...(Number(row.cacheMissTokens) > 0 ? { cacheMiss: Number(row.cacheMissTokens) } : {}),
    }
  }, [selectedSessionKey, sessions])

  const headerTokenTotals = useMemo((): TokenTotals | null => {
    const base = tokenTotals ?? sessionPersistedTokenTotals
    const live = liveTurnTokens
    if (!live) return base
    const mergedBase = base ?? { input: 0, output: 0, total: 0 }
    const merged: TokenTotals = {
      input: mergedBase.input + live.input,
      output: mergedBase.output + live.output,
      total: mergedBase.total + live.total,
    }
    const cacheRead = (mergedBase.cacheRead ?? 0) + (live.cacheRead ?? 0)
    const cacheCreation = (mergedBase.cacheCreation ?? 0) + (live.cacheCreation ?? 0)
    const cacheMiss = (mergedBase.cacheMiss ?? 0) + (live.cacheMiss ?? 0)
    if (cacheRead > 0) merged.cacheRead = cacheRead
    if (cacheCreation > 0) merged.cacheCreation = cacheCreation
    if (cacheMiss > 0) merged.cacheMiss = cacheMiss
    return merged.total > 0 ? merged : base
  }, [tokenTotals, sessionPersistedTokenTotals, liveTurnTokens])

  const displayContextUsage = useMemo((): ContextUsageSnapshot | null => {
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) return null
    const catalogWindow = modelCatalog.find((m) => m.name === effectiveModelName)?.contextLength
    const sessionRow = sessions.find((s) => String(s.sessionKey || '').trim() === sk)
    const persistedSnap = parseContextUsageFromSessionContext(sessionRow?.context)
    const liveSnap = contextUsageBySession[sk]
    const snap = liveSnap
      ? mergeContextUsageSnapshots(persistedSnap ?? undefined, liveSnap)
      : persistedSnap
    // 无后端/持久化快照时不合成占位数据，避免工作台空圆环
    if (!snap || snap.usedTokens <= 0) return null
    if (catalogWindow && catalogWindow > 0 && catalogWindow !== snap.windowTokens) {
      const pct = (snap.usedTokens / catalogWindow) * 100
      return {
        ...snap,
        windowTokens: catalogWindow,
        pct: Math.round(pct * 10) / 10,
      }
    }
    return snap
  }, [selectedSessionKey, contextUsageBySession, sessions, modelCatalog, effectiveModelName])

  /** 顶栏只留一个入口；Agent / 产物等在侧栏内切换，避免与侧栏 tab 重复 */
  const toggleInfoRail = useCallback(() => {
    setInfoRailOpen((open) => !open)
  }, [])

  const [assetQuickBusy, setAssetQuickBusy] = useState(false)
  const handleAssetQuickAction = useCallback(
    (kind: 'episode' | 'craft' | 'journal') => {
      // 一点即发：由当前会话 Agent 根据对话完成；用户不填表、不弹窗
      const empCode = String(employeeSessionAgentCode || '').trim().toLowerCase()
      const forEmployee = isProactiveEmployeeSession && !!empCode
      const ownerLine = forEmployee
        ? `写入智能体员工「${empCode}」自己的资产目录（employees/${empCode}/，与用户同级），不要写到 user。`
        : `写入用户「我」的资产目录（assets/user/）。`

      const messages = {
        episode: [
          '请根据刚才整段对话，把「这次对话的过程」整理成一篇过程记录，写入资产（memory/episodic/{日期}-{slug}.md）。',
          ownerLine,
          '用途：给人以后回顾这段对话走过了什么、结论/约定是什么；不是沉淀经验（怎么做），也不是反思（日结/判断）。',
          '文件必须带 YAML frontmatter：title + summary（短描述 10～30 字，能辨认即可，勿写长）+ 可选 tags；正文按时间线或要点写清过程。',
          '不要再问我要写什么；自行总结并保存。',
        ].join('\n'),
        journal: [
          '请根据刚才的对话，直接写一段今日反思并沉淀到资产（memory/journal/{今天}.md）。',
          ownerLine,
          '文件必须带 YAML frontmatter：date + summary（短描述 10～30 字，能辨认即可，勿写长）+ 可选 tags；正文再写详细反思。',
          '不要再问我要写什么；自行总结并保存。',
        ].join('\n'),
        craft: [
          '请把刚才对话里可复用的做法，直接沉淀成一条经验（craft/{name}/SKILL.md）。',
          ownerLine,
          'SKILL.md 必须带 frontmatter：name + description（短描述 10～30 字，能辨认即可，勿写长）；正文再写步骤/结论。',
          '不要再问我要标题或正文；自行总结并保存。',
        ].join('\n'),
      } as const

      if (selectedTurnBusy) {
        toast('当前正在回复，请稍后再沉淀', 'warning')
        return
      }
      setAssetQuickBusy(true)
      void handleSendRef.current(messages[kind]).finally(() => {
        setAssetQuickBusy(false)
      })
    },
    [isProactiveEmployeeSession, employeeSessionAgentCode, selectedTurnBusy],
  )

  const infoRailHeaderToggle = (
    <button
      type="button"
      className={`react-chat-header-panel-btn${infoRailOpen ? ' is-active' : ''}`}
      title={
        isProactiveEmployeeSession
          ? obsEnabled
            ? '任务 / 岗位 / 产物 / 平台 / 调试 / 运行'
            : '任务 / 岗位 / 产物 / 平台 / 运行'
          : obsEnabled
            ? 'Agent / 产物 / 平台 / 调试'
            : 'Agent / 产物 / 平台'
      }
      aria-pressed={infoRailOpen}
      aria-label={infoRailOpen ? '关闭侧栏' : '打开侧栏'}
      onClick={toggleInfoRail}
    >
      侧栏
    </button>
  )

  useEffect(() => {
    if (rightStageOpen) setInfoRailOpen(false)
  }, [rightStageOpen])

  useEffect(() => {
    if (normalizeRightStageKind(rightStageSurface?.kind || '') === 'artifacts') {
      hideRightStageIfKind('artifacts')
    }
  }, [rightStageSurface?.kind])

  useEffect(() => {
    // 普通对话默认打开 Agent 侧栏；员工会话默认当前任务
    setInfoRailOpen(true)
    setInfoRailTab(isProactiveEmployeeSession ? 'task' : 'agent')
  }, [selectedSessionKey, isProactiveEmployeeSession])

  const handleManualContextCompact = useCallback(async () => {
    const sk = String(selectedSessionKey || '').trim()
    if (!sk || manualContextCompacting) return
    setManualContextCompacting(true)
    try {
      const { snapshot, response } = await requestManualContextCompaction(sk)
      if (snapshot) {
        setContextUsageBySession((prev) => ({
          ...prev,
          [sk]: mergeContextUsageSnapshots(prev[sk], snapshot),
        }))
      }
      if (response.changed) {
        const saved =
          response.beforeGateTokens > response.afterGateTokens
            ? response.beforeGateTokens - response.afterGateTokens
            : 0
        toast(
          saved > 0
            ? `上下文已压缩（-${Math.round((saved / Math.max(response.beforeGateTokens, 1)) * 100)}%）`
            : '上下文已压缩',
          'success',
        )
      } else {
        toast('当前上下文无需压缩', 'info')
      }
    } catch (err) {
      toast(`压缩失败：${String((err as Error)?.message || err)}`, 'error')
    } finally {
      setManualContextCompacting(false)
    }
  }, [selectedSessionKey, manualContextCompacting])

  const liveTurnTokenStr = useMemo(() => {
    if (!liveTurnTokens || liveTurnTokens.total <= 0) return ''
    return formatUsageTokenStr(liveTurnTokens)
  }, [liveTurnTokens])

  const goalExecutionTiming = Boolean(
    !historyLoading &&
      selectedGoalActive &&
      String(selectedSessionKey || '').trim().length > 0,
  )

  const collabPhaseLc = String(threadPanelState.collabPhase || '').trim().toLowerCase()
  const collabExecutionTiming = Boolean(
    liveTurnTimingActive &&
      !selectedTurnBusy &&
      (collabPhaseLc === 'executing' ||
        collabPhaseLc === 'awaiting_exec' ||
        (String(selectedSessionKey || '').trim() &&
          executingSessionKeys.has(String(selectedSessionKey || '').trim()))),
  )

  const executionToolTiming = goalExecutionTiming || collabExecutionTiming

  const sessionRowTaskId = useMemo(() => {
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) return ''
    const row = sessions.find((s) => String(s.sessionKey || '') === sk)
    return resolveSessionTaskId(
      row as { collabTaskId?: string | null } | undefined,
      boundTaskId || '',
    )
  }, [selectedSessionKey, sessions, boundTaskId])
  sessionBoundTaskIdRef.current = sessionRowTaskId

  const sidebarActiveTaskId =
    sidebarSelectedTaskId ||
    sidebarHistory[0]?.taskId ||
    sessionRowTaskId ||
    threadPanelState.collabTask?.taskId ||
    null
  const sidebarActiveView = sidebarActiveTaskId ? sidebarTaskViews[sidebarActiveTaskId] : undefined

  const chatThreadIdForSidebar = useMemo(() => {
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) return null
    const fromMap = wsClient.getSessionThreadId(sk)
    if (fromMap && !fromMap.startsWith('agent:')) return fromMap
    const fromRowRaw = String(
      sessions.find((s) => String(s.sessionKey || '') === sk)?.threadId || '',
    ).trim()
    const fromRow =
      resolveLanggraphLeadThreadId(fromRowRaw) ||
      (fromRowRaw && !fromRowRaw.startsWith('agent:') ? fromRowRaw : '')
    return fromRow || fromMap
  }, [selectedSessionKey, sessions])

  /** 主任务 id：会话行、内存绑定、侧栏快照、子任务 parent 等多源合并（避免仅有 subtasks 时面板为空） */
  const workflowTaskId = useMemo(() => {
    const fromSubParent = String(
      (threadPanelState.collabSubtasks || []).find((s) => String(s.parentTaskId || '').trim())
        ?.parentTaskId || '',
    ).trim()
    return (
      sessionRowTaskId ||
      String(boundTaskId || '').trim() ||
      String(threadPanelState.collabTask?.taskId || '').trim() ||
      String(threadPanelState.boundTaskId || '').trim() ||
      fromSubParent
    )
  }, [
    sessionRowTaskId,
    boundTaskId,
    threadPanelState.collabTask?.taskId,
    threadPanelState.boundTaskId,
    threadPanelState.collabSubtasks,
  ])

  const collabWorkflowApiReady = useMemo(() => {
    if (sessionRowTaskId) return true
    const sk = String(selectedSessionKey || '').trim()
    if (sk.startsWith('agent:')) return true
    const thread = String(chatThreadIdForSidebar || '').trim()
    return !!(thread && !thread.startsWith('agent:'))
  }, [sessionRowTaskId, selectedSessionKey, chatThreadIdForSidebar])

  /** GET /tasks 查询主键：会话绑定 taskId 优先，其次内存 hint */
  const collabSubtasksTaskId = String(sessionRowTaskId || workflowTaskId || '').trim()

  const collabExecPanelCanShow = useMemo(() => {
    if (!collabWorkflowApiReady) return false
    const task = threadPanelState.collabTask
    const planGoal = String(task?.planGoal || task?.boundPlanPreview || '').trim()
    const sidebarOpts = {
      boundPlanReady: task?.boundPlanReady,
      hasPlanBody: !!task?.boundPlanReady || !!planGoal,
    }
    const phase = String(threadPanelState.collabPhase || '').trim().toLowerCase()
    if (phase === 'executing' || phase === 'verifying' || phase === 'reflecting') return true
    if (task && isActiveExecTaskStatus(task.status)) return true
    if (collabSubtasksTaskId && shouldShowCollabWorkflowPanel(task, sidebarOpts)) return true
    return shouldShowCollabSubtaskSidebar(task, sidebarOpts)
  }, [
    collabWorkflowApiReady,
    threadPanelState.collabTask,
    threadPanelState.collabPhase,
    collabSubtasksTaskId,
  ])

  const collabSubtasksFetchEnabled = !!(
    collabWorkflowApiReady &&
    (collabExecPanelOpen ||
      !!subtaskTranscriptModal ||
      !!collabSubtasksTaskId)
  )
  const collabSubtasksRefreshKey = `${subtasksApiRefreshKey}:${subtaskTranscriptModal?.subtaskId || ''}:${subtaskTranscriptModal?.mainTaskId || ''}`
  const collabSubtasksSessionKeyRef = useRef(String(selectedSessionKey || '').trim())
  useEffect(() => {
    collabSubtasksSessionKeyRef.current = String(selectedSessionKey || '').trim()
  }, [selectedSessionKey])
  const isCollabSubtasksFetchActiveRef = useRef(() => true)
  isCollabSubtasksFetchActiveRef.current = () =>
    // @ts-ignore
    String(sessionRef.current || '').trim() === collabSubtasksSessionKeyRef.current
  const { subtasks: sharedCollabSubtasks, mainTask: sharedCollabMainTask } = useCollabSubtasksFromApi({
    taskId: collabSubtasksTaskId || null,
    threadId: chatThreadIdForSidebar,
    sessionKey: selectedSessionKey,
    enabled: collabSubtasksFetchEnabled,
    refreshKey: collabSubtasksRefreshKey,
    isStillActive: () => isCollabSubtasksFetchActiveRef.current(),
  })

  // 执行期间轮询：任务处于活跃执行状态时，定期 bump refreshKey 触发重新拉取 GET /tasks，
  // 弥补被移除的 task-progress 快照刷新逻辑（流式事件 task_running/task_completed 不保证到达）。
  const sharedCollabMainTaskStatus = sharedCollabMainTask?.status
  useEffect(() => {
    if (!collabSubtasksFetchEnabled) return
    const phaseLc = String(threadPanelState.collabPhase || '').trim().toLowerCase()
    const isRunning =
      isActiveExecTaskStatus(sharedCollabMainTaskStatus) ||
      phaseLc === 'executing' ||
      phaseLc === 'verifying' ||
      phaseLc === 'reflecting' ||
      selectedTurnBusy
    if (!isRunning) return
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      bumpSubtasksApiRefresh()
    }
    const interval = window.setInterval(tick, 3000)
    return () => window.clearInterval(interval)
  }, [
    collabSubtasksFetchEnabled,
    sharedCollabMainTaskStatus,
    threadPanelState.collabPhase,
    selectedTurnBusy,
    bumpSubtasksApiRefresh,
  ])

  const renderRightStageLegacy = useCallback(
    (surface: RightStageSurface) => {
      const kind = surface.kind
      if (kind === 'workspace-browse' || kind === 'write') {
        const writePreviewMode = kind === 'write'
        return sidePanelHeavyMount ? (
          <aside
            className={`react-chat-workspace-panel react-chat-right-stage-panel${
              writePreviewMode ? ' is-write-preview-mode' : ' is-tree-browse-mode'
            }`}
            role="region"
            aria-label={writePreviewMode ? '写入内容' : '工作区文件'}
          >
            <WorkspaceFileTree
              workspaceRoot={effectiveWorkspaceRoot}
              threadId={wsClient.getSessionThreadId(selectedSessionKey || '') || undefined}
              selected={contextFiles}
              onToggleFile={toggleContextFile}
              indexWatchEnabled={workspaceIndexWatchEnabled}
              onIndexWatchEnabledChange={(enabled) => {
                setWorkspaceIndexWatchEnabledState(enabled)
                setWorkspaceIndexWatchEnabled(enabled)
              }}
              onOpenFilePreview={(path, opts) => {
                openWorkspaceFilePreview(path, {
                  name: opts?.name,
                  poll: !!opts?.poll,
                })
              }}
              streamingWritePreview={streamingWritePreviewForPane}
              writePreviewMode={writePreviewMode}
              treePinned={workspaceTreePinned}
              onEscapeStreamPreview={() => closeWorkspacePanel()}
              focusBrowsePath={workspaceBrowseFocusPath}
              onFocusBrowsePathConsumed={() => setWorkspaceBrowseFocusPath(null)}
            />
          </aside>
        ) : (
          <SidePanelBootShell
            title={writePreviewMode ? '写入内容' : '工作区文件'}
            className={`react-chat-workspace-panel react-chat-right-stage-panel${
              writePreviewMode ? ' is-write-preview-mode' : ' is-tree-browse-mode'
            }`}
          />
        )
      }
      if (knowledgeMapEnabled && kind === 'mind-map') {
        return sidePanelHeavyMount ? (
          <KnowledgeMapPanel
            sessionKey={selectedSessionKey}
            isOpen={knowledgeMapPanelOpen}
            refreshKey={knowledgeMapRefreshKey}
            onClose={closeKnowledgeMapPanel}
          />
        ) : (
          <SidePanelBootShell
            title="思维导图"
            className="react-chat-collab-exec-panel react-chat-knowledge-map-panel react-chat-right-stage-panel"
          />
        )
      }
      if (kind === 'collab-workflow') {
        return sidePanelHeavyMount ? (
          collabWorkflowApiReady ? (
            <CollabExecutionPanel
              isOpen={collabExecPanelOpen}
              mainTaskId={collabSubtasksTaskId || sidebarActiveTaskId}
              collabTask={sidebarActiveView?.task ?? threadPanelState.collabTask}
              collabPhase={threadPanelState.collabPhase ?? undefined}
              chatThreadId={chatThreadIdForSidebar}
              apiMainTask={sharedCollabMainTask}
              apiSubtasks={sharedCollabSubtasks}
              liveSubtasks={threadPanelState.collabSubtasks || []}
              subagentTasks={threadPanelState.subagentTasks}
              agents={agents}
              onClose={closeCollabExecPanel}
              onSubtaskTranscriptOpen={setSubtaskTranscriptModal}
              canvasFillContainer
            />
          ) : (
            <aside className="react-chat-collab-exec-panel react-chat-right-stage-panel" role="region" aria-label="工作流">
              <header className="react-chat-collab-exec-panel-header">
                <div className="react-chat-collab-exec-panel-title-wrap">
                  <span className="react-chat-collab-exec-panel-title">工作流</span>
                </div>
              </header>
              <div className="react-chat-collab-exec-panel-body collab-wf-panel-body">
                <div className="collab-exec-dag-empty">当前会话暂无工作流</div>
              </div>
            </aside>
          )
        ) : (
          <SidePanelBootShell title="工作流" className="react-chat-right-stage-panel" />
        )
      }
      return null
    },
    [
      sidePanelHeavyMount,
      effectiveWorkspaceRoot,
      selectedSessionKey,
      contextFiles,
      toggleContextFile,
      workspaceIndexWatchEnabled,
      streamingWritePreviewForPane,
      workspaceTreePinned,
      closeWorkspacePanel,
      knowledgeMapEnabled,
      knowledgeMapPanelOpen,
      knowledgeMapRefreshKey,
      closeKnowledgeMapPanel,
      collabWorkflowApiReady,
      collabExecPanelOpen,
      collabSubtasksTaskId,
      sidebarActiveTaskId,
      sidebarActiveView?.task,
      threadPanelState.collabTask,
      threadPanelState.collabPhase,
      threadPanelState.collabSubtasks,
      threadPanelState.subagentTasks,
      chatThreadIdForSidebar,
      sharedCollabMainTask,
      sharedCollabSubtasks,
      agents,
      closeCollabExecPanel,
      openWorkspaceFilePreview,
      workspaceBrowseFocusPath,
    ],
  )

  const collabExecToggleTitle = collabExecPanelOpen
    ? '隐藏子任务工作流'
    : collabExecPanelCanShow
      ? '显示子任务工作流'
      : '工作流（当前会话暂无）'

  const collabExecToggleButton = (
    <button
      type="button"
      className={`react-chat-toggle-sidebar-btn react-chat-collab-exec-toggle-btn${
        collabExecPanelOpen ? ' is-active' : ''
      }${collabExecPanelCanShow ? '' : ' is-idle'}`}
      title={collabExecToggleTitle}
      aria-label={collabExecToggleTitle}
      aria-pressed={collabExecPanelOpen}
      onClick={() => {
        if (collabExecPanelOpen) closeCollabExecPanel()
        else {
          bumpSubtasksApiRefresh()
          openCollabExecPanel({ clearDismiss: true })
        }
      }}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" aria-hidden="true">
        <path d="M6 4v16M10 8h8M10 12h6M10 16h4" />
        <circle cx="6" cy="8" r="1.5" fill="currentColor" />
        <circle cx="6" cy="12" r="1.5" fill="currentColor" />
        <circle cx="6" cy="16" r="1.5" fill="currentColor" />
      </svg>
    </button>
  )

  const knowledgeMapToggleTitle = knowledgeMapPanelOpen ? '隐藏思维导图' : '显示思维导图'

  const knowledgeMapToggleButton = (
    <button
      type="button"
      className={`react-chat-toggle-sidebar-btn react-chat-knowledge-map-toggle-btn${
        knowledgeMapPanelOpen ? ' is-active' : ''
      }`}
      title={knowledgeMapToggleTitle}
      aria-label={knowledgeMapToggleTitle}
      aria-pressed={knowledgeMapPanelOpen}
      onClick={() => {
        if (knowledgeMapPanelOpen) closeKnowledgeMapPanel()
        else openKnowledgeMapPanel()
      }}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" aria-hidden="true">
        <circle cx="6" cy="6" r="2.5" />
        <circle cx="18" cy="6" r="2.5" />
        <circle cx="12" cy="18" r="2.5" />
        <path d="M8.2 7.5l3.3 8M15.8 7.5l-3.3 8M8.5 6h7" />
      </svg>
    </button>
  )

  const workspaceFolderToggleTitle = workspacePanelOpen ? '隐藏工作区文件' : '显示工作区文件'

  const workspaceFolderToggleButton = (
    <button
      type="button"
      className={`react-chat-toggle-sidebar-btn react-chat-workspace-folder-btn${
        workspacePanelOpen ? ' is-active' : ''
      }`}
      title={workspaceFolderToggleTitle}
      aria-label={workspaceFolderToggleTitle}
      aria-pressed={workspacePanelOpen}
      onClick={toggleWorkspacePanel}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" aria-hidden="true">
        <path d="M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H9l-2 2H4a1 1 0 00-1 1v11a1 1 0 001 1z" />
      </svg>
    </button>
  )

  const stageExtensionsToolbar = (
    <RightStageExtensionsToolbar
      activeKind={activeStageExtensionKind}
      activeExtensionId={activeStageUiExtensionId}
      onSelect={openStageExtension}
      onOpenUiExtension={openUiExtensionInStage}
    />
  )

  /** 本会话内进入执行（或主任务变活跃）时自动展开；点进已有工作流的会话只记 baseline，不默认展开 */
  useEffect(() => {
    if (!workflowTaskId) {
      prevCollabExecPhaseRef.current = ''
      return
    }
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) return
    const token = `${sk}:${workflowTaskId}`
    const phase = String(threadPanelState.collabPhase || '').trim().toLowerCase()
    const prev = prevCollabExecPhaseRef.current
    const task = threadPanelState.collabTask
    const planGoal = String(task?.planGoal || task?.boundPlanPreview || '').trim()

    if (collabExecSessionBaselinedRef.current !== token) {
      collabExecSessionBaselinedRef.current = token
      prevCollabExecPhaseRef.current = phase
      return
    }

    const shouldOpen =
      collabExecPanelCanShow &&
      shouldAutoOpenCollabExecPanel(task, {
        collabPhase: phase,
        boundPlanReady: task?.boundPlanReady,
        hasPlanBody: !!task?.boundPlanReady || !!planGoal,
      })
    const enteredExec =
      (phase === 'executing' || phase === 'verifying' || phase === 'reflecting') &&
      prev !== phase &&
      !['executing', 'verifying', 'reflecting'].includes(prev)

    if ((shouldOpen && enteredExec) || (shouldOpen && phase === 'executing' && prev !== 'executing')) {
      const dismissKey = collabExecPanelDismissKey()
      if (!dismissKey || !collabExecDismissedKeysRef.current.has(dismissKey)) {
        openCollabExecPanel({ clearDismiss: true })
      }
    }
    prevCollabExecPhaseRef.current = phase
  }, [
    selectedSessionKey,
    workflowTaskId,
    threadPanelState.collabPhase,
    threadPanelState.collabTask,
    collabExecPanelCanShow,
    collabExecPanelDismissKey,
    openCollabExecPanel,
  ])

  useEffect(() => {
    const preview = String(threadPanelState.clarification?.preview || threadPanelState.clarification?.content || '').trim()
    if (preview) queueMicrotask(() => openSessionSidebar())
  }, [threadPanelState.clarification, openSessionSidebar])

  const planExecToolArrays = useMemo(() => [mergedPlanTools], [mergedPlanTools])

  const planExecConfirmAnchor = useMemo((): PlanExecConfirmAnchor | null => {
    if (!planDockApiView?.show) return null
    const view = planDockApiView
    const sk = String(selectedSessionKey || '').trim()
    const toolCallId =
      findLastSuccessfulPlanToolCallId(planExecToolArrays) || view.toolCallId || ''
    return {
      anchorToolCallId: toolCallId,
      taskId: view.taskId,
      taskName: view.taskName,
      subtaskCount: view.subtaskCount,
      planTitle: view.planStructured.goal,
      planStructuredFallback: view.planStructured,
      syncedSubtasks: undefined,
      sessionKey: sk || undefined,
      showStartExecution: view.showStartExecution,
      statusLabel: view.statusLabel,
      skipApiFetch: true,
      busy: planExecStarting,
      onStartExecution: (startTaskId) => {
        const tid = String(startTaskId || view.taskId || '').trim()
        void runUserExecutionStart(tid)
      },
      onDismiss: (dismissTaskId) => {
        const tid = String(dismissTaskId || view.taskId || '').trim()
        if (!tid) return
        suppressPlanExecDock(tid)
        userAuthorizedTaskIdsRef.current.add(tid)
        applyPlanDockApiView(
          planDockApiHide('user_dismiss', 'manually_dismissed', {
            taskId: tid,
            taskStatus: view.taskStatus,
          }) as PlanDockApiView,
        )
      },
    }
  }, [planDockApiView, planExecToolArrays, planExecStarting, selectedSessionKey, sessions])

  // 切换/刷新会话：唯一入口 — GET /tasks?session_key=… 决定是否展示计划条
  useEffect(() => {
    if (historyLoading || listLoading) return
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) return
    if (sessionRefreshInFlightRef.current === sk) return

    let cancelled = false
    const fetchSeq = sessionTasksFetchSeqRef.current
    void (async () => {
      if (sessionRefreshInFlightRef.current === sk) return
      if (cancelled || !isActiveSessionFetch(sk, fetchSeq)) return
      if (planSessionEnterRef.current === sk) return
      planSessionEnterRef.current = sk
      historyCollabHydratedRef.current = sk

      const sessionRow = sessionsRef.current.find((s) => String(s.sessionKey || '') === sk)
      const sessionTaskId = resolveSessionTaskId(
        sessionRow as { collabTaskId?: string | null } | undefined,
        boundTaskIdRef.current || '',
      )
      sessionBoundTaskIdRef.current = sessionTaskId

      if (historyRowsBootstrappedRef.current !== sk) {
        historyRowsBootstrappedRef.current = sk
        if (sessionTaskId) {
          patchCollabFromStreamTools({ skipPlanPanel: true, allowAutoOpen: false })
        }
      }

      const planHit = rows.length
        ? extractLastPlanToolSuccessFromArrays(collectAssistantToolArraysFromRows(rows))
        : null
      if (cancelled || !isActiveSessionFetch(sk, fetchSeq)) return
      await syncPlanPanelFromApiRef.current({
        source: 'session_enter',
        sessionKey: sk,
        bypassCache: true,
        hintTaskId: sessionTaskId,
        fallback: (planHit as { planInput?: Record<string, unknown> } | null)?.planInput ?? null,
        planOutput: (planHit as { planOutput?: Record<string, unknown> } | null)?.planOutput ?? null,
        boundPlanReady: !!(planHit as { boundPlanReady?: boolean } | null)?.boundPlanReady,
      })
    })()

    return () => {
      cancelled = true
    }
  }, [historyLoading, listLoading, selectedSessionKey, patchCollabFromStreamTools])

  useEffect(() => {
    tracePlanDockApi('render', {
      loading: planDockApiView === null,
      show: planDockApiView?.show ?? false,
      source: planDockApiView?.source,
      reason: planDockApiView && !planDockApiView.show ? planDockApiView.reason : undefined,
      taskId: planDockApiView?.taskId,
      statusLabel: planDockApiView?.show ? planDockApiView.statusLabel : undefined,
    })
  }, [planDockApiView])

  // 底部操作区不依赖对话中是否已出现用户/助手消息：保持"创意"按钮常驻

  const finalizeNewSessionBackground = useCallback(
    async (key: string) => {
      // 新建会话默认 Agent 模式，不继承上一个会话的模式（Plan/Ask 等）
      const modeForNew: SessionMode = 'agent'
      try {
        const { api } = await import('../lib/tauri-api.js')
        const ctx = wsClient.getSessionContext(key)
        const boundWs = String(ctx?.local_workspace_root || '').trim()
        try {
          await api.chatUpdateContext(key, { memory_enabled: memoryEnabled })
        } catch {
          /* ignore */
        }
        try {
          await applySessionModePreset(key, modeForNew)
        } catch (e) {
          console.warn('[ChatApp] 应用会话模式失败:', e)
        }
        if (boundWs) {
          setLocalWorkspaceRoot(boundWs)
          try {
            const bound = await wsClient.bindSessionWorkspace(key, boundWs, { userPinned: true })
            const next = Array.isArray(bound?.paths)
              ? bound.paths.map((x: string) => String(x || '').trim()).filter(Boolean)
              : [boundWs]
            setWorkspaceHistory(next)
            setGlobalWorkspaceHistory(wsClient.getGlobalWorkspaceHistory())
          } catch {
            /* ignore */
          }
        }
        const pill = (modelName || '').trim()
        // 新建会话默认跟随智能体：不写 model_name。仅当用户已显式选过（且在 catalog 内）才钉死覆盖。
        const explicitOverride =
          pill &&
          modelCatalog.some((m) => m.name === pill) &&
          pill !== followResolvedModelName &&
          pill !== agentDefaultModelName
        if (explicitOverride) {
          try {
            await api.chatUpdateContext(key, { model_name: pill })
            setModelName(pill)
            syncModelSessionPrevKeyRef.current = key
          } catch (e) {
            console.warn('[ChatApp] 新会话模型覆盖写入失败:', e)
          }
        } else {
          const display = followResolvedModelName || defaultModelFromCatalog(modelCatalog, primaryModelName)
          if (display) setModelName(display)
          syncModelSessionPrevKeyRef.current = key
        }
        void refreshSessions({ skipAutoReselect: true })
      } catch {
        /* ignore */
      }
    },
    [
      modelName,
      modelCatalog,
      primaryModelName,
      memoryEnabled,
      refreshSessions,
      followResolvedModelName,
      agentDefaultModelName,
    ],
  )

  async function createSessionForChat(opts?: { workspaceRoot?: string | null }): Promise<string | null> {
    try {
      const { api } = await import('../lib/tauri-api.js')
      const createContext: Record<string, unknown> = { memory_enabled: memoryEnabled }
      const ws =
        opts && 'workspaceRoot' in opts ? String(opts.workspaceRoot ?? '').trim() : ''
      if (ws) {
        createContext.local_workspace_root = ws
        createContext.use_virtual_paths = false
        createContext.workspace_user_pinned = true
      }
      const row = (await api.chatSessionsCreate('main', {
        title: '新对话',
        context: createContext,
        ensureThread: false, // 不阻塞等待 LangGraph 线程创建；用户发消息时按需创建（已有超时保护）
      })) as ChatSessionRow & { key?: string }
      const key = String(row?.sessionKey || row?.key || '').trim()
      if (!key) throw new Error('创建会话失败')
      if (ws) {
        try {
          const bound = await wsClient.bindSessionWorkspace(key, ws, { userPinned: true })
          const nextHist = Array.isArray(bound?.paths)
            ? bound.paths.map((x: unknown) => String(x || '').trim()).filter(Boolean)
            : [ws]
          if (String(sessionRef.current || '').trim() === key) {
            setWorkspaceHistory(nextHist)
            setGlobalWorkspaceHistory(wsClient.getGlobalWorkspaceHistory())
          }
        } catch {
          /* create context 已写入 workspace；bind 失败不阻断新建 */
        }
      }
      ssLog('create.done', { key: skTail(key), sessionRefBefore: skTail(sessionRef.current), workspace: ws || '(default)' })
      const enrichedRow = ws
        ? {
            ...row,
            localWorkspaceRoot: ws,
            useVirtualPaths: false,
            context: {
              ...(row.context && typeof row.context === 'object' ? row.context : {}),
              local_workspace_root: ws,
              use_virtual_paths: false,
              workspace_user_pinned: true,
            },
          }
        : row
      prependNewSessionToList(setSessions, enrichedRow as ChatSessionRow & { key?: string })
      // 新建会话默认 Agent 模式，不继承上一个会话的模式
      setSessionModeInMeta(key, 'agent')
      setSessionMode('agent')
      const curSel = String(sessionRef.current || '').trim()
      // pendingNew 时强制 adopt：列表刷新可能已把选中抢回历史会话
      const forceAdopt = pendingNewSessionRef.current || !curSel
      if (forceAdopt) {
        ssLog('create.adopt', {
          key: skTail(key),
          forced: !!pendingNewSessionRef.current,
          prev: skTail(curSel),
        })
        setSelectedSessionKey(key)
        sessionRef.current = key
        setRows([])
        setTokenTotals(null)
        setLiveTurnTokens(null)
        setNewChatButtonActive(false)
      } else {
        ssLog('create.skip-adopt', { key: skTail(key), curSel: skTail(curSel) })
      }
      void finalizeNewSessionBackground(key)
      return key
    } catch (e) {
      setNewChatButtonActive(true)
      toast(toUserFacingError((e as Error)?.message || e), 'error')
      return null
    }
  }

  async function ensureChatSessionKey(): Promise<string | null> {
    const existing = (sessionRef.current || selectedSessionKey || '').trim()
    if (existing) return existing
    setNewChatButtonActive(true)
    const wsHint = resolveWorkspaceForNewSession()
    return coalesceCreateSession(() => createSessionForChat({ workspaceRoot: wsHint }))
  }
  ensureChatSessionKeyRef.current = ensureChatSessionKey

  async function applyMoreMenuSessionApprovalPolicy(presetId: string): Promise<void> {
    const sk = (await ensureChatSessionKey()) || sessionRef.current || selectedSessionKey
    if (!sk) return
    const [{ patchSessionPermissionPreset }, { wsClient }] = await Promise.all([
      import('../lib/tool-approval-settings.js'),
      import('../lib/ws-client.js'),
    ])
    const result = await patchSessionPermissionPreset(sk, presetId)
    // Force local context so session-list refresh cannot fall back to global grant_all.
    wsClient.applySessionToolApprovalPolicy(sk, {
      ...result,
      permission_preset: result.permission_preset || presetId,
      effective_permission_preset: result.effective_permission_preset || presetId,
    })
    setToolApprovalPolicyTick((n) => n + 1)
    toast(permissionPresetToast(presetId), 'success')
  }

  async function handleSend(
    message: string,
    attachments?: ChatAttachment[],
    ctxFiles?: ContextFileEntry[],
    opts?: {
      voiceInitiated?: boolean
      goalInitiated?: boolean
      goalSessionKey?: string
      messageId?: string
      /** 用户行已由 ↑ 注入 transcript，开新 run 时勿重复落库 */
      skipTranscriptAppend?: boolean
      /** UI 已有该 user 气泡，勿再插一条 */
      alreadyInjected?: boolean
      /** 外部传入的技能选择（优先于 selectedSkills 状态） */
      skillsOverride?: SkillSelection[]
    },
  ) {
    // 用户发新消息时重置停止标记，确保停止后可立即发新消息
    userInitiatedStopRef.current = false
    if (shouldArmVoiceReply(voiceReplyEnabled)) {
      voiceReplyPendingRef.current = true
      voiceStreamingStartedRef.current = false
      voiceSpeechSyncedPlainRef.current = ''
      // 键盘发送也播报：清队列；确认语仅语音提问时再播
      if (!opts?.voiceInitiated) {
        void import('../lib/speech-client.js').then(({ resetStreamingSpeechQueue }) => {
          resetStreamingSpeechQueue()
        })
        void import('../lib/voice-reply-speech.js').then(({ resetVoiceToolMuteState }) => {
          resetVoiceToolMuteState()
        })
      }
    }
    const preserveCollabOnSendEarly = isUserExecutionStartIntent(message)
    const skBusy = String(sessionRef.current || '').trim()
    const rowBusy = skBusy
      ? sessionsRef.current.find((s) => String(s.sessionKey || '') === skBusy)
      : null
    if (
      isSessionExecuting(skBusy, { sessionRow: rowBusy }) &&
      !preserveCollabOnSendEarly &&
      !opts?.goalInitiated &&
      // ↑ 注入续跑：消息已在 transcript/队列，必须开新 run；勿被残留 busy/probe 拦住
      !opts?.alreadyInjected
    ) {
      toast('上一条消息仍在处理中，请稍候或点「停止」后再发', 'warning')
      return
    }
    const sendSeq = chatSendSeqRef.current + 1
    chatSendSeqRef.current = sendSeq
    if (pendingNewSessionRef.current && globalCreateSessionInflight) {
      await globalCreateSessionInflight
    }
    let sessionKey = String(opts?.goalSessionKey || '').trim()
      || (sessionRef.current || selectedSessionKey || '').trim()
    if (!sessionKey) {
      sessionKey = (await ensureChatSessionKey()) || ''
      if (!sessionKey) return
    }
    ssLog('send.session', {
      sendSeq,
      sessionKey: skTail(sessionKey),
      sessionRef: skTail(sessionRef.current),
      selectedSessionKey: skTail(selectedSessionKey),
      pendingNew: pendingNewSessionRef.current,
    })
    if (shouldArmVoiceReply(voiceReplyEnabled) || opts?.voiceInitiated) {
      voiceSessionKeyRef.current = sessionKey
    }
    clearClarificationLatch(sessionKey)
    clarifyResolveSeqRef.current.set(
      sessionKey,
      (clarifyResolveSeqRef.current.get(sessionKey) || 0) + 1,
    )
    // 选中技能时：UI 展示技能 pill；run context 传 preferred_skills 并入 available_skills
    let preferredSkillNames: string[] = []
    let preferredSkillsBadge: Array<{ name: string; label: string; icon: string }> = []
    const userMessage = message || ''
    const filesForSend = (ctxFiles && ctxFiles.length ? ctxFiles : contextFiles).filter((f) =>
      String(f.path || '').trim(),
    )
    const activeSkills = opts?.skillsOverride ?? selectedSkills
    if (activeSkills.length > 0 && userMessage.trim()) {
      preferredSkillNames = activeSkills
        .map((s) => String(s.name || '').trim())
        .filter(Boolean)
      preferredSkillsBadge = activeSkills.map((s) => ({
        name: String(s.name || '').trim(),
        label: s.label,
        icon: s.icon,
      }))
      void persistSelectedSkills(sessionKey, activeSkills)
    }
    const slash = String(message || '').trim()
    if (!attachments?.length) {
      if (slash === '/claude' || slash === '/claude-code') {
        const { api } = await import('../lib/tauri-api.js')
        await api.chatUpdateContext(sessionKey, { use_claude_code_chat: true })
        setRoleUiNonce((n) => n + 1)
        toast('已切换为代码助手模式（当前会话）', 'success')
        return
      }
      if (slash === '/lead' || slash === '/main') {
        const { api } = await import('../lib/tauri-api.js')
        await api.chatUpdateContext(sessionKey, { use_claude_code_chat: false })
        setRoleUiNonce((n) => n + 1)
        toast('已切换为 EvoFlow（当前会话）', 'success')
        return
      }
      // /goal <目标内容> — 直接启动当前会话目标（不进入普通聊天）
      const goalDirectMatch = slash.match(/^\/(?:goal|hosted|hd)\s+([\s\S]+)$/i)
      if (goalDirectMatch) {
        const goalText = goalDirectMatch[1].trim()
        if (/^(start|apply)$/i.test(goalText)) {
          const fromPanel = threadPanelState.goalProposal
          const fromRows = !fromPanel ? extractLatestGoalProposalFromRows(rows) : null
          const hp = fromPanel || fromRows
          if (hp) {
            const start = !/^apply$/i.test(goalText)
            suppressedGoalProposalKeysRef.current.add(goalProposalSuppressKey(hp))
            void goal.goal.applyGoalProposal(hp, { start })
            setThreadPanelState((p) => ({ ...p, goalProposal: null }))
            toast(start ? '已根据指令启动目标' : '已写入目标面板', 'success')
            return
          }
          toast('当前会话没有可应用的目标方案', 'warning')
          return
        }
        void goal.goal.startGoalWithPrompt(goalText)
        return
      }
      // 本机聊天：用短指令确认目标方案（飞书侧同一会话若在本机打开 EvoFlow，也可用输入框发相同词）
      if (/^(开始|确认|启动目标|开始目标|启动托管|开始托管)$/.test(slash)) {
        const fromPanel = threadPanelState.goalProposal
        const fromRows = !fromPanel ? extractLatestGoalProposalFromRows(rows) : null
        const hp = fromPanel || fromRows
        if (hp) {
          const start = slash !== '确认'
          suppressedGoalProposalKeysRef.current.add(goalProposalSuppressKey(hp))
          void goal.goal.applyGoalProposal(hp, { start })
          setThreadPanelState((p) => ({ ...p, goalProposal: null }))
          toast(start ? '已根据指令启动目标' : '已写入目标面板', 'success')
          return
        }
      }
    }

    // 智能体员工会话：按 session_key 轻量同步 context，之后走正常 chatSend
    if (isProactiveSessionKey(sessionKey) && String(message || '').trim()) {
      const parsed = parseProactiveSessionKey(sessionKey)
      try {
        const patch: Record<string, unknown> = {
          source: 'proactive',
          proactive_agent_code: parsed.agentCode || null,
          employee_talk_mode: 'chat',
        }
        if (parsed.kind === 'task' && parsed.taskId) {
          patch.workspace_kind = 'task'
          patch.related_task_id = parsed.taskId
        } else if (parsed.kind === 'chat') {
          patch.workspace_kind = 'chat'
          patch.related_task_id = null
        } else if (parsed.kind === 'duty') {
          patch.workspace_kind = 'duty'
        }
        await wsClient.updateSessionContext(sessionKey, patch)
      } catch {
        /* ignore */
      }
    }

    const imageAttachments = (attachments || []).filter((a) => {
      const mime = String(a?.mimeType || '').toLowerCase()
      if (mime.startsWith('image/')) return true
      const name = String(a?.filename || a?.file?.name || '')
      return /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/i.test(name)
    })
    const docAttachments = (attachments || []).filter((a) => a && !imageAttachments.includes(a))
    if (imageAttachments.length > 0 && effectiveModelSupportsVision === false) {
      toast(
        '当前模型不支持图片。请切换带「视觉」标记的模型，或去掉图片后再发送。',
        'warning',
      )
      return
    }
    const contextFilesSentSnapshot =
      filesForSend.length > 0
        ? filesForSend.map((f) => ({
            path: String(f.path).trim(),
            name: String(f.name || f.path).trim(),
          }))
        : []
    if (contextFilesSentSnapshot.length) {
      setContextFiles([])
      void persistContextFiles([], sessionKey)
    }
    const preserveCollabOnSend = isUserExecutionStartIntent(message)

    // 与输入框发送一致：先立刻展示用户消息 + 处理中，再跑 context/abort/chatSend（避免点「开始执行」长时间无反馈）
    lastActivityRef.current[sessionKey] = Date.now()
    let optimisticMessageId: string
    try {
      optimisticMessageId =
        (opts?.messageId && String(opts.messageId).trim()) ||
        (typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `user-${Date.now()}-${sendSeq}`)
    } catch {
      optimisticMessageId = `user-${Date.now()}-${sendSeq}`
    }
    const userRow: DisplayRow = {
      role: 'user',
      text: userMessage,
      ...(preferredSkillsBadge.length ? { preferredSkills: preferredSkillsBadge } : {}),
      ...(filesForSend.length || docAttachments.length
        ? {
            contextFiles: [
              ...filesForSend.map((f) => ({
                path: String(f.path).trim(),
                name: String(f.name || f.path).trim(),
              })),
              ...docAttachments.map((a) => {
                const name = String(a.filename || a.file?.name || 'file').trim() || 'file'
                return { path: name, name }
              }),
            ],
          }
        : {}),
      messageId: optimisticMessageId,
      images: imageAttachments
        .filter((a) => a?.content)
        .map((a) => ({
          data: a.content,
          mediaType: a.mimeType || 'image/png',
        })),
      timestamp: Date.now(),
    }
    const rtSend = getSessionRuntime(sessionKey)
    const activeSk = String(sessionRef.current || '').trim()
    // 发送消息时，消息历史的基准行必须以当前目标会话的 runtime 为准。
    // React rows 可能是上一会话的残留（切换后 history 尚未 bound）；此时不得当作本会话历史。
    const historyReadyForSend =
      historyBoundSessionKey === sessionKey && !historyLoading
    const visibleRows = rtSend.rows.length
      ? rtSend.rows
      : activeSk === sessionKey && historyReadyForSend
        ? rows
        : []
    const runBeforeReset = rtSend.activeChatRunId || activeChatRunIdRef.current || rtSend.stream.runId
    const sessionRunBeforeSend = String(
      sessions.find((s) => String(s.sessionKey || '') === sessionKey)?.currentRunId || '',
    ).trim()
    for (const rid of [runBeforeReset, sessionRunBeforeSend, getExpectedChatRunId(sessionKey)]) {
      const id = String(rid || '').trim()
      if (id) rtAddStoppedRun(rtSend, id)
    }
    const preSendRows = [...rowsBaseForSend(rtSend.rows, visibleRows)]
    const alreadyInjected = !!(opts?.alreadyInjected && optimisticMessageId)
    const sentRows = alreadyInjected
      ? preSendRows.map((row) =>
          row.incompleteStream ? { ...row, incompleteStream: false } : row,
        )
      : [
          ...preSendRows.map((row) =>
            row.incompleteStream ? { ...row, incompleteStream: false } : row,
          ),
          userRow,
        ]
    const priorStripBundle = mergePriorTurnStripBundles(
      priorStripForRuntime(rtSend),
      priorTurnStripBundleWithStream(sentRows, rtSend.stream.turn),
    )
    rtSend.priorTurnStrip = {
      body: priorStripBundle.body,
      reasoning: priorStripBundle.reasoning,
      toolIds: [...priorStripBundle.toolIds],
    }
    const sidForArtifacts = String(sessionKey || 'default')
    let seenArtifacts = seenArtifactsRef.current.get(sidForArtifacts)
    if (!seenArtifacts) {
      seenArtifacts = new Set<string>()
      seenArtifactsRef.current.set(sidForArtifacts, seenArtifacts)
    }
    seedSeenArtifactPathsFromRows(seenArtifacts, sentRows)
    const priorAsstRow = findAssistantRowBeforeTrailingUser(sentRows)
    const priorAssistantPrefix = priorStripBundle.body
    const priorAssistantMessageId = String(priorAsstRow?.messageId || '').trim()
    rtSend.rows = sentRows
    rtAddStaleToolCallIds(rtSend, priorStripBundle.toolIds)
    rtSend.stream = emptyStream()
    rtSend.stream.aguiTurn = emptyAgUiTurnState('', '')
    rtSend.seenRunIds = []
    rightStageRunIdRef.current = `run-${Date.now()}`
    dismissedRightStageKindsRef.current = new Set()
    platformFeedbackSeenRef.current = new Set()
    writeStreamDismissedRef.current = false
    turnRunArtifactsRef.current = []
    turnPlatformEntriesRef.current = []
    setTurnPlatformEntries([])
    setPlatformFocusEntryId('')
    setTurnArtifacts([])
    setArtifactFocusId('')
    if (rightStageHintTimerRef.current) {
      clearTimeout(rightStageHintTimerRef.current)
      rightStageHintTimerRef.current = 0
    }
    const turnStartedIso = new Date().toISOString()
    const provisionalTitle = provisionalSessionTitleFromUserText(userMessage)
    if (provisionalTitle) {
      void persistProvisionalSessionTitleFromMessage(sessionKey, userMessage)
    }
    // stop 后会 markSessionRecoveryCooldown；用户主动再发须清掉，否则 AG-UI run-* 接管被丢弃
    clearStreamReattachCooldown(sessionKey)
    dispatchSessionTurnEvent(sessionKey, { type: 'SEND_STARTED', turnStartTs: Date.now() })
    dispatchSessionTurnEvent(sessionKey, { type: 'WIRE_SOURCE', source: 'run' })
    // 修复：发送消息时，如果目标会话就是当前活跃会话（或当前没有活跃会话，如新建会话过程中），
    // 必须确保 streamRef 指向目标会话的 stream，避免流事件写入错误的 stream 导致串台
    // 这在新建会话后立即发送消息的竞态场景下尤其重要（createSessionForChat 的 setState 可能还没生效）
    // activeSk 已在第 9321 行声明，直接复用
    const isCurrentSession = activeSk === sessionKey
    const noActiveSession = !activeSk
    if (isCurrentSession || noActiveSession) {
      streamRef.current = rtSend.stream
      // 如果当前没有活跃会话但我们正在发送消息，立即同步 sessionRef 到目标会话
      // 这确保后续流事件能正确路由
      if (noActiveSession) {
        sessionRef.current = sessionKey
      }
      setRows([...rtSend.rows])
      setSessions((prev) =>
        prev.map((s) =>
          String(s.sessionKey || '') === sessionKey
            ? {
                ...s,
                runStatus: 'running',
                currentRunId: null,
                currentTurnStartedAt: turnStartedIso,
                currentTurnEndedAt: null,
                ...(provisionalTitle && isReplaceableSessionTitle(s.title)
                  ? { title: provisionalTitle }
                  : {}),
              }
            : s,
        ),
      )
      setLiveTurnAssistantRunId(null)
      setLiveTurnTokens(null)
      seenRunIdsRef.current = new Set()
      activeChatRunIdRef.current = null
    }
    const keepPlanDetectionCache =
      preserveCollabOnSend ||
      (collabOn &&
        (!!lastPlanPanelHitRef.current?.planInput ||
          planStreamLatched ||
          !!planStreamLatchRef.current ||
          (Array.isArray(lastPlanDetectionToolsRef.current) &&
            lastPlanDetectionToolsRef.current.length > 0)))
    if (!keepPlanDetectionCache) {
      resetPlanStreamSession()
    }
    planResolveInFlightRef.current = false
    setStreamingWritePreview(null)
    lastStreamWritePathRef.current = null
    resetStreamMirrorDedupe()
    activeChatRunIdRef.current = null
    setExpectedChatRunId(sessionKey, null)
    scheduleBump({ immediate: true })

    setSubagentDockTasks({})
    if (streamRef.current.subagentTasks) streamRef.current.subagentTasks = {}
    if (streamRef.current.terminalStreams) streamRef.current.terminalStreams = {}
    parentTaskToSubtaskRef.current = {}
    if (!preserveCollabOnSend) {
      setSidebarTaskViews({})
      setSidebarSelectedTaskId(null)
    }
    setThreadPanelState((prev) => {
      const keepTaskId = String(prev.collabTask?.taskId || prev.boundTaskId || '').trim()
      if (preserveCollabOnSend && keepTaskId) {
        queueMicrotask(() => setSidebarSelectedTaskId((cur) => cur || keepTaskId))
      }
      return {
        ...prev,
        activityKind: preserveCollabOnSend ? 'thinking' : 'idle',
        activityDetail: preserveCollabOnSend ? '正在启动执行…' : '',
        reasoningPreview: null,
        subagentTasks: {},
        clarification: null,
        goalProposal: null,
        ...(preserveCollabOnSend
          ? {
              collabPhase:
                prev.collabPhase === 'plan_ready' || !prev.collabPhase ? 'awaiting_exec' : prev.collabPhase,
            }
          : {
              supervisorSteps: [],
              collabSubtasks: [],
              collabTask: null,
              collabPhase: null,
              boundTaskId: null,
            }),
      }
    })

    const { api } = await import('../lib/tauri-api.js')

    const syncChatContextBeforeSend = async () => {
      try {
        const phaseFromPanel = String(threadPanelState.collabPhase || '').trim().toLowerCase()
        const preservedPhases = new Set([
          'planning',
          'plan_ready',
          'awaiting_exec',
          'executing',
          'verifying',
          'paused',
          'done',
        ])
        let effectiveCollabPhase = collabOn
          ? preservedPhases.has(phaseFromPanel)
            ? phaseFromPanel
            : 'planning'
          : 'idle'
        if (preserveCollabOnSend && collabOn) {
          effectiveCollabPhase =
            phaseFromPanel === 'executing' ? 'executing' : 'awaiting_exec'
        }
        const contextPatch: Record<string, unknown> = {
          collab_phase: effectiveCollabPhase,
          memory_enabled: memoryEnabled,
        }
        if (!preserveCollabOnSend) {
          const ctxModelRaw = wsClient.getSessionContext(sessionKey)?.model_name
          const hasOverride = typeof ctxModelRaw === 'string' && !!ctxModelRaw.trim()
          // 跟随智能体：不要用药丸展示值写回 model_name，否则会把智能体默认钉死成会话覆盖。
          // 仅当会话已有覆盖、或用户药丸相对跟随值是显式选择时才同步。
          const rawPill = (modelName || '').trim()
          const pillInCatalog = !!rawPill && modelCatalog.some((m) => m.name === rawPill)
          if (hasOverride && pillInCatalog) {
            contextPatch.model_name = rawPill
          } else if (!hasOverride && pillInCatalog && rawPill !== followResolvedModelName) {
            contextPatch.model_name = rawPill
          }
        }
        // 本地先合并：chatSend 读 map 用本地值；无变更则连后台 PATCH 也省掉
        const prevCtx = wsClient.getSessionContext(sessionKey) || {}
        const patchKeys = Object.keys(contextPatch)
        const unchanged = patchKeys.every((k) => {
          const a = (prevCtx as Record<string, unknown>)[k]
          const b = contextPatch[k]
          return a === b || String(a ?? '') === String(b ?? '')
        })
        await wsClient.updateSessionContext(sessionKey, contextPatch, { localOnly: true })
        if (!unchanged) {
          void wsClient.updateSessionContext(sessionKey, contextPatch).catch(() => {})
        }
        if (!collabOn) {
          // 优化：仅当本地 context 存在非 idle/done 的 collab 状态或残留 task_id 时才发 PUT 清理，
          // 避免每次发消息都发一个空操作请求
          const ctx = wsClient.getSessionContext(sessionKey) || {}
          const localPhase = String(ctx.collab_phase ?? '').trim().toLowerCase()
          const localTaskId = String(ctx.collab_task_id ?? '').trim()
          const needsCollabCleanup =
            localTaskId || (localPhase && localPhase !== 'idle' && localPhase !== 'done')
          if (needsCollabCleanup) {
            const threadId = wsClient.getSessionThreadId(sessionKey)
            if (threadId) {
              void wsClient
                .putThreadCollabState(threadId, { collab_phase: 'idle', bound_task_id: null })
                .catch(() => {})
            }
          }
        }
      } catch {
        /* 模式同步失败不阻断发送 */
      }
    }

    const abortStaleChatStream = () => {
      try {
        suppressNextAbortToastRef.current = true
        // 本地 abort SSE wire；无在途 run 时几乎零开销。勿 await 网络。
        void api.chatAbort(sessionKey).catch(() => {})
      } catch {
        /* ignore */
      } finally {
        window.setTimeout(() => {
          suppressNextAbortToastRef.current = false
        }, 1500)
      }
    }

    try {
      // 本地 context + 本地 abort：不串行等待 Gateway PATCH/stop（否则「运行中」空转数秒才进「准备中」）
      await syncChatContextBeforeSend().catch(() => {})
      abortStaleChatStream()
    } catch {
      /* ignore prep errors */
    }

    if (preserveCollabOnSend) {
      const execTaskId = String(
        threadPanelState.collabTask?.taskId || threadPanelState.boundTaskId || boundTaskId || '',
      ).trim()
      const execThreadId = wsClient.getSessionThreadId(sessionKey) || ''
      if (execTaskId) {
        await authorizeExecutionInBackground(execTaskId, execThreadId)
      }
    }

    try {
      const send = api.chatSend as (
        sessionKey: string,
        message: string,
        attachments?: ChatAttachment[],
        contextFilesArg?: ContextFileEntry[],
        opts?: {
          priorAssistantPrefix?: string
          priorAssistantReasoning?: string
          priorAssistantMessageId?: string
          priorTurnStripBundle?: PriorTurnStripBundle
          messageId?: string
          preferredSkills?: string[]
          skipTranscriptAppend?: boolean
          voiceInitiated?: boolean
        },
      ) => Promise<unknown>
      const priorSendOpts =
        priorStripBundle.body ||
        priorStripBundle.reasoning ||
        priorStripBundle.toolIds.length ||
        priorAssistantMessageId
          ? {
              priorAssistantPrefix,
              priorAssistantReasoning: priorStripBundle.reasoning,
              priorAssistantMessageId,
              priorTurnStripBundle: priorStripBundle,
            }
          : undefined
      const r = await send(
        sessionKey,
        userMessage,
        attachments,
        filesForSend.length ? filesForSend : undefined,
        {
          ...priorSendOpts,
          messageId: optimisticMessageId,
          ...(preferredSkillNames.length ? { preferredSkills: preferredSkillNames } : {}),
          ...(opts?.skipTranscriptAppend || alreadyInjected ? { skipTranscriptAppend: true } : {}),
          ...(opts?.voiceInitiated ? { voiceInitiated: true } : {}),
          ...(shouldArmVoiceReply(voiceReplyEnabled) ? { voiceReply: true } : {}),
        },
      )
      // run_started 事件已提前写入 expectedChatRunIdBySessionRef；此处仅作兜底。
      const rid =
        r && typeof r === 'object' && 'runId' in (r as any) ? String((r as any).runId || '') : ''
      if (rid) {
        if (!getExpectedChatRunId(sessionKey)) setExpectedChatRunId(sessionKey, rid)
        bindActiveRun(rtSend, rid)
        if (String(sessionRef.current || '').trim() === sessionKey) {
          activeChatRunIdRef.current = rid
        }
      }
    } catch (e) {
      if (chatSendSeqRef.current === sendSeq) {
        voiceReplyPendingRef.current = false
        voiceSessionKeyRef.current = ''
        voiceStreamingStartedRef.current = false
        void setVoiceTrayState('idle')
        toast(toUserFacingError((e as Error)?.message || e), 'error')
        rtSend.rows = preSendRows
        rtSend.stream = emptyStream()
        rtSend.priorTurnStrip = { body: '', reasoning: '', toolIds: [] }
        dispatchSessionTurnEvent(sessionKey, { type: 'SEND_FAILED' })
        dispatchSessionRunEnded(sessionKey)
        clearSessionExecutionStateForEnded(sessionKey)
        if (String(sessionRef.current || '').trim() === sessionKey) {
          streamRef.current = rtSend.stream
          setRows([...preSendRows])
          setSessions((prev) => patchSessionListRunEnded(prev, sessionKey, { terminalStatus: 'fail' }))
          setLiveTurnAssistantRunId(null)
          setStreamHealth(null)
          streamHealthRef.current = null
        }
        if (contextFilesSentSnapshot.length) {
          setContextFiles(contextFilesSentSnapshot)
          void persistContextFiles(contextFilesSentSnapshot, sessionKey)
        }
        scheduleBump({ immediate: true })
      }
    }
  }
  sendGoalMessageRef.current = async (prompt, sk) => {
    await handleSend(prompt, undefined, undefined, {
      goalInitiated: true,
      goalSessionKey: sk,
    })
  }

  async function handleVoiceTranscribed(text: string, opts?: { global?: boolean }) {
    const t = String(text || '').trim()
    if (!t) {
      toast('未识别到语音内容', 'warning')
      pushComposerText('')
      return
    }
    const sk = String(selectedSessionKey || sessionRef.current || '').trim()
    if (sk) {
      composerDraftsRef.current.delete(sk)
      composerDraftSnapshotRef.current = ''
      setComposerDraftVersion((v) => v + 1)
    }
    pushComposerText('')
    if (opts?.global) {
      /* 全局快捷键：确认语已在 background-voice 中启动 */
    } else if (shouldArmVoiceReply(voiceReplyEnabled)) {
      const { resetStreamingSpeechQueue } = await import('../lib/speech-client.js')
      resetStreamingSpeechQueue()
      const { startVoiceSimpleAck, resetVoiceToolMuteState } = await import(
        '../lib/voice-reply-speech.js',
      )
      resetVoiceToolMuteState()
      startVoiceSimpleAck((s) => setVoiceTrayState(s))
    }
    await handleSend(t, undefined, undefined, { voiceInitiated: true })
  }
  handleVoiceTranscribedRef.current = handleVoiceTranscribed

  async function handleToolApproval(
    action: 'approve' | 'approve_all' | 'deny' | 'grant_all' | 'approve_remember',
    toolCallId?: string,
    hint?: { tool_name?: string; summary?: string; args?: Record<string, unknown> },
  ) {
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) return
    const { wsClient } = await import('../lib/ws-client.js')
    const tid = wsClient.getSessionThreadId(sk)
    if (!tid) {
      toast('会话尚未就绪，请稍后重试', 'error')
      return
    }
    const ctx = wsClient.getSessionContext(sk) || {}
    const wsRoot = String(ctx.local_workspace_root || '').trim() || undefined
    const tcKey = String(toolCallId || '').trim()
    logToolApprovalUserAction(action, {
      sessionKey: sk,
      threadId: tid,
      toolCallId: tcKey,
      toolName: hint?.tool_name,
      摘要: hint?.summary,
    })
    const markResolved = (ids: string[]) => {
      for (const id of ids) {
        const k = String(id || '').trim()
        if (k) toolApprovalResolvedIdsRef.current.add(k)
      }
    }
    const patchLocalToolApprovalStatus = (ids: string[], status: string) => {
      const list = (Array.isArray(ids) ? ids : []).map((x) => String(x || '').trim()).filter(Boolean)
      if (!list.length) return
      patchToolsApprovalStatus((streamRef.current?.turn.tools as unknown[]) || [], list, status)
      const rt = getSessionRuntime(sk)
      for (const row of rt.rows || []) {
        patchToolsApprovalStatus(((row as { tools?: unknown[] })?.tools as unknown[]) || [], list, status)
      }
      for (const row of rowsRef.current || []) {
        patchToolsApprovalStatus(((row as { tools?: unknown[] })?.tools as unknown[]) || [], list, status)
      }
      scheduleBump({ immediate: true })
    }
    const pendingVisible = collectPendingApprovalsForDock({
      streamTools: (streamRef.current?.turn.tools as unknown[]) || [],
      rows: rowsRef.current,
      isSending: turnBusyForSession(sessionRef.current),
      excludeToolCallIds: toolApprovalResolvedIdsRef.current,
    })
    setToolApprovalInFlight(true)
    try {
      const res = await wsClient.postToolApproval(tid, {
        action: action === 'approve_remember' ? 'approve' : action,
        tool_call_id: toolCallId,
        local_workspace_root: wsRoot,
        tool_name: hint?.tool_name,
        args: hint?.args,
        summary: hint?.summary,
        remember: action === 'approve_remember',
      })
      logToolApprovalUserAction(`${action} API 响应`, {
        sessionKey: sk,
        threadId: tid,
        消息: res?.message,
        stream_resume_recommended: res?.stream_resume_recommended,
        resume_run_id: res?.resume_run_id,
        replay_ids: res?.replay_tool_call_ids,
      })
      if (action === 'grant_all' || action === 'approve_all') {
        markResolved(pendingVisible.map((p) => p.tool_call_id))
        patchLocalToolApprovalStatus(
          pendingVisible.map((p) => p.tool_call_id),
          'approved',
        )
      } else if (action === 'deny') {
        markResolved([tcKey])
        patchLocalToolApprovalStatus([tcKey], 'denied')
        toast(res?.message || '已拒绝', 'info')
        scheduleBump({ immediate: true })
        return
      } else if (action === 'approve' || action === 'approve_remember') {
        markResolved([tcKey])
        const ids =
          Array.isArray(res?.replay_tool_call_ids) && res.replay_tool_call_ids.length
            ? res.replay_tool_call_ids
            : [tcKey]
        patchLocalToolApprovalStatus(ids, 'approved')
      }
      if (res?.client_stream_replay) {
        toast(res?.message || '已批准，正在执行…', 'info')
        const ids =
          Array.isArray(res?.replay_tool_call_ids) && res.replay_tool_call_ids.length
            ? res.replay_tool_call_ids
            : []
        const replayMsg =
          String(res?.replay_message || '').trim() ||
          (ids.length ? buildToolApprovalReplayMessage(ids) : '')
        if (replayMsg) {
          // Open a fresh POST /runs/stream owned by the browser so the next
          // model reply streams token-by-token (history-watch only dumps DB).
          void wsClient.chatSend(sk, replayMsg, [], [], {}).catch((err: unknown) => {
            toast(toUserFacingError((err as Error)?.message || err, '续流失败'), 'error')
            window.setTimeout(() => {
              requestManualStreamResumeRef.current(sk, { refreshSessions: true })
            }, 400)
          })
        } else {
          window.setTimeout(() => {
            requestManualStreamResumeRef.current(sk, { refreshSessions: true })
          }, 400)
        }
      } else if (res?.stream_resume_recommended) {
        toast(res?.message || '已批准，正在执行…', 'info')
        // Do NOT pre-dispatch REATTACH_STARTED here: if reattach is skipped
        // (cooldown / missing runId), turnPhase would stick on reattaching.
        // requestManualStreamResume owns REATTACH_STARTED → TURN_IDLE.
        const resumeRunId = String(res?.resume_run_id || '').trim()
        if (resumeRunId) setExpectedChatRunId(sk, resumeRunId)
        window.setTimeout(() => {
          requestManualStreamResumeRef.current(sk, { refreshSessions: true })
        }, 400)
        // Safety: if history-watch never starts/ends, don't leave spinner forever.
        window.setTimeout(() => {
          const rt = getSessionRuntime(sk)
          if (rt.turnPhase === 'reattaching' || rt.turnPhase === 'degraded') {
            void (async () => {
              try {
                const { isSessionRunStillActive } = await import('./lib/session-reattach.js')
                if (!(await isSessionRunStillActive(sk))) {
                  dispatchSessionTurnEvent(sk, { type: 'TURN_IDLE' })
                }
              } catch {
                /* ignore */
              }
            })()
          }
        }, 8000)
      } else {
        toast(res?.message || '已记录授权，同一条流继续…', 'info')
      }
      scheduleBump({ immediate: true })
    } catch (e) {
      toast(toUserFacingError((e as Error)?.message || e, '授权请求失败'), 'error')
    } finally {
      setToolApprovalInFlight(false)
    }
  }

  /** 停止会话执行：侧栏 / Composer 共用 session-execution.stopSessionExecution */
  sessionStopHostRef.current = {
    isForegroundSession: (sk) =>
      sk === sessionRef.current || sk === String(selectedSessionKey || '').trim(),
    onUserStopStarted: () => {
      userInitiatedStopRef.current = true
    },
    onUserStopFinished: () => {
      userInitiatedStopRef.current = false
    },
    onForegroundStopComplete: ({ sessionKey: sk }) => {
      toolApprovalResolvedIdsRef.current = new Set()
      const rt = getSessionRuntime(sk)
      resetRuntimeStream(rt, streamRef)
      setStreamHealth(null)
      streamHealthRef.current = null
      setSubagentDockTasks({})
      setThreadPanelState(clearThreadPanelActivity)
      setExpectedChatRunId(sk, null)
      activeChatRunIdRef.current = null
      setRows([...getSessionRuntime(sk).rows])
      // Esc/立即发送: interrupt path already captured steer texts and will handleSend.
      // Only pop server queue here (discard); do NOT push into pendingSendQueue or we
      // get a duplicate user bubble when busy→idle also flushes the queue.
      if (interruptSendSteersRef.current) {
        interruptSendSteersRef.current = false
        setPendingSteers((prev) => prev.filter((s) => s.sessionKey !== sk))
        midTurnInjectRef.current = midTurnInjectRef.current.filter((x) => x.sessionKey !== sk)
        void restorePendingInjects(sk).catch(() => {})
        return
      }
      // runtime interrupt restore: merge steers + queue into composer (not scattered list rows)
      const queueTexts = pendingSendQueueRef.current
        .map((x) => String(x.text || '').trim())
        .filter(Boolean)
      setPendingSendQueue([])
      setPendingSteers((prev) => prev.filter((s) => s.sessionKey !== sk))
      midTurnInjectRef.current = midTurnInjectRef.current.filter((x) => x.sessionKey !== sk)

      void restorePendingInjects(sk)
        .then((res) => {
          const restored = Array.isArray(res?.restored) ? res.restored : []
          const restoredTexts = restored
            .map((item: { text?: string }) => String(item?.text || '').trim())
            .filter(Boolean)
          const mergedParts = [...restoredTexts, ...queueTexts]
          if (!mergedParts.length) return
          if (String(sessionRef.current || '').trim() !== sk) return
          pushComposerText(
            mergeInterruptedComposerDraft(mergedParts, composerTextRef.current),
          )
          toast(`已恢复 ${mergedParts.length} 条到输入框`, 'info')
        })
        .catch(() => {
          if (!queueTexts.length) return
          if (String(sessionRef.current || '').trim() !== sk) return
          pushComposerText(
            mergeInterruptedComposerDraft(queueTexts, composerTextRef.current),
          )
        })
    },
    onBackgroundStopComplete: ({ sessionKey: sk, stopRunId }) => {
      const rt = getSessionRuntime(sk)
      if (stopRunId) rtAddStoppedRun(rt, stopRunId)
    },
    onRefreshSessions: () => void refreshSessionsRef.current?.(),
    onReloadHistory: () => void reloadHistoryFromDb({ dbOnly: true, bypassCache: true }),
    onScheduleRuntimeBump: () => scheduleBump({ immediate: true }),
    deleteLiveRunSnapshot: (sk) => deleteLiveRunSnapshotBestEffort(sk),
    onSessionRunEnded: (sk, opts) => {
      clearSessionExecutionStateForEnded(sk)
      setSessions((prev) =>
        patchSessionListRunEnded(prev, sk, opts ?? { terminalStatus: 'cancelled', reason: 'user_stop' }),
      )
    },
    toast: (message, kind) => toast(message, kind),
  }

  async function stopSessionExecution(sessionKey: string, opts?: { showToast?: boolean }) {
    voiceReplyPendingRef.current = false
    voiceSessionKeyRef.current = ''
    voiceStreamingStartedRef.current = false
    void setVoiceTrayState('idle')
    await runStopSessionExecution(sessionKey, sessionStopHostRef.current, opts)
  }

  stopSessionExecutionRef.current = stopSessionExecution

  async function handleAbort() {
    const sessionKey = selectedSessionKey
    if (!sessionKey) return
    try {
      await stopSessionExecution(sessionKey, { showToast: false })
    } catch (e) {
      toast(toUserFacingError((e as Error)?.message || e), 'error')
    }
  }

  const handleQueueWhileBusy = useCallback((text: string) => {
    const t = String(text || '').trim()
    if (!t) return
    const id =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `pending-${Date.now()}`
    setPendingSendQueue((prev) => {
      if (prev.length >= PENDING_SEND_QUEUE_MAX) {
        toast(`最多排队 ${PENDING_SEND_QUEUE_MAX} 条，请先发送或删除`, 'warning')
        return prev
      }
      return [...prev, { id, text: t }]
    })
    toast('已排队，回合结束后发送', 'info')
  }, [])

  const enqueueSteerWhileBusy = useCallback((text: string) => {
    const t = String(text || '').trim()
    if (!t) return
    const skBusy = String(sessionRef.current || '').trim()
    if (!skBusy) return
    const rowBusy = sessionsRef.current.find((s) => String(s.sessionKey || '') === skBusy)
    // UI 仍显示 busy、turn 已 idle 时：走普通发送，禁止静默丢字
    if (!isSessionExecuting(skBusy, { sessionRow: rowBusy })) {
      void handleSendRef.current?.(t)
      return
    }

    let messageId = ''
    try {
      messageId =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `user-inject-${Date.now()}`
    } catch {
      messageId = `user-inject-${Date.now()}`
    }
    const steer = { id: messageId, messageId, text: t, sessionKey: skBusy }
    setPendingSteers((prev) => {
      if (prev.some((s) => s.messageId === messageId && s.sessionKey === skBusy)) return prev
      return [...prev, steer]
    })
    midTurnInjectRef.current = [
      ...midTurnInjectRef.current,
      { messageId, text: t, sessionKey: skBusy },
    ]
    const rt = getSessionRuntime(skBusy)
    const threadId = String(wsClient.getSessionThreadId(skBusy) || '').trim() || null
    const runId =
      String(rt.activeChatRunId || activeChatRunIdRef.current || rt.stream?.runId || '').trim() ||
      null
    void enqueuePendingInject(skBusy, {
      content: t,
      messageId,
      runId,
      threadId,
    })
      .then((res) => {
        if (!res || (res as { ok?: boolean }).ok === false) {
          throw new Error('纠偏消息入队失败，请重试')
        }
      })
      .catch((e) => {
        toast(toUserFacingError((e as Error)?.message || e), 'error')
        setPendingSteers((prev) =>
          prev.filter((s) => !(s.sessionKey === skBusy && s.messageId === messageId)),
        )
        midTurnInjectRef.current = midTurnInjectRef.current.filter(
          (x) => !(x.sessionKey === skBusy && x.messageId === messageId),
        )
      })
  }, [])

  const handleSteerWhileBusy = enqueueSteerWhileBusy

  const handleCancelPendingSend = useCallback((id: string) => {
    setPendingSendQueue((prev) => prev.filter((x) => x.id !== id))
  }, [])

  const handleEditPendingSend = useCallback((id: string, text: string) => {
    setPendingSendQueue((prev) =>
      prev.map((x) => (x.id === id ? { ...x, text } : x)),
    )
  }, [])

  const promoteConsumedSteersToRows = useCallback(
    (sessionKey: string, messageIds: string[]) => {
      const sk = String(sessionKey || '').trim()
      const ids = new Set((messageIds || []).map((x) => String(x || '').trim()).filter(Boolean))
      if (!sk || !ids.size) return
      const steers = pendingSteersRef.current.filter(
        (s) => s.sessionKey === sk && ids.has(s.messageId),
      )
      if (!steers.length) {
        setPendingSteers((prev) =>
          prev.filter((s) => !(s.sessionKey === sk && ids.has(s.messageId))),
        )
        midTurnInjectRef.current = midTurnInjectRef.current.filter(
          (x) => !(x.sessionKey === sk && ids.has(x.messageId)),
        )
        return
      }
      const rt = getSessionRuntime(sk)
      const existingRows = Array.isArray(rt.rows) ? [...rt.rows] : []
      let changed = false
      for (const s of steers) {
        if (existingRows.some((r) => r.messageId && r.messageId === s.messageId)) continue
        existingRows.push({
          role: 'user',
          text: s.text,
          messageId: s.messageId,
          timestamp: Date.now(),
        })
        changed = true
      }
      if (changed) {
        rt.rows = existingRows
        if (String(sessionRef.current || '').trim() === sk) {
          setRows([...rt.rows])
          rowsRef.current = [...rt.rows]
        }
      }
      setPendingSteers((prev) =>
        prev.filter((s) => !(s.sessionKey === sk && ids.has(s.messageId))),
      )
      midTurnInjectRef.current = midTurnInjectRef.current.filter(
        (x) => !(x.sessionKey === sk && ids.has(x.messageId)),
      )
      // Clear legacy optimistic pendingInject bubbles if any remain
      let badgeCleared = false
      const cleaned = (Array.isArray(rt.rows) ? rt.rows : []).map((r) => {
        if (r.role !== 'user' || !r.pendingInject) return r
        if (!ids.has(String(r.messageId || ''))) return r
        badgeCleared = true
        const { pendingInject: _omit, ...rest } = r
        return rest
      })
      if (badgeCleared) {
        rt.rows = cleaned
        if (String(sessionRef.current || '').trim() === sk) {
          setRows([...cleaned])
          rowsRef.current = [...cleaned]
        }
      }
    },
    [],
  )

  const handleFlushPendingSend = useCallback((id: string) => {
    const hit = pendingSendQueueRef.current.find((x) => x.id === id)
    if (!hit) return
    const text = String(hit.text || '').trim()
    if (!text) {
      toast('等待发送内容为空，请先填写或删除', 'warning')
      return
    }
    const skBusy = String(sessionRef.current || '').trim()
    const rowBusy = skBusy
      ? sessionsRef.current.find((s) => String(s.sessionKey || '') === skBusy)
      : null
    const busy = isSessionExecuting(skBusy, { sessionRow: rowBusy })
    setPendingSendQueue((prev) => prev.filter((x) => x.id !== id))
    if (busy) {
      enqueueSteerWhileBusy(text)
      return
    }
    void handleSendRef.current(text)
  }, [enqueueSteerWhileBusy])

  const handleCancelPendingSteer = useCallback((messageId: string) => {
    const mid = String(messageId || '').trim()
    if (!mid) return
    const sk = String(sessionRef.current || '').trim()
    setPendingSteers((prev) =>
      prev.filter((s) => !(s.messageId === mid && (!sk || s.sessionKey === sk))),
    )
    midTurnInjectRef.current = midTurnInjectRef.current.filter(
      (x) => !(x.messageId === mid && (!sk || x.sessionKey === sk)),
    )
  }, [])

  const handleInterruptAndSendSteers = useCallback(async () => {
    const sk = String(sessionRef.current || '').trim()
    if (!sk) return
    const steers = pendingSteersRef.current.filter((s) => s.sessionKey === sk)
    if (!steers.length) return
    const texts = steers.map((s) => s.text).filter(Boolean)
    const merged = texts.join('\n\n').trim()
    const steerTextSet = new Set(texts.map((t) => String(t || '').trim()).filter(Boolean))
    // Set before stop so onForegroundStopComplete does not restore→pendingSendQueue.
    interruptSendSteersRef.current = true
    try {
      try {
        await stopSessionExecutionRef.current?.(sk, { showToast: false })
      } catch {
        /* still try to restore/send */
      }
      // Interrupt restore: pop pending so next turn won't double-drain
      try {
        await restorePendingInjects(sk)
      } catch {
        /* ignore */
      }
      setPendingSteers((prev) => prev.filter((s) => s.sessionKey !== sk))
      midTurnInjectRef.current = midTurnInjectRef.current.filter((x) => x.sessionKey !== sk)
      // Drop any race-restored queue rows that match these steers (duplicate guard).
      if (steerTextSet.size) {
        setPendingSendQueue((prev) => prev.filter((x) => !steerTextSet.has(String(x.text || '').trim())))
      }
      if (merged) {
        toast('已打断，正在立即发送纠偏指令…', 'info')
        await handleSendRef.current(merged)
      }
    } finally {
      interruptSendSteersRef.current = false
    }
  }, [])

  // 当前回复结束后：① 未消费的 ↑ 注入续跑；② 再发排队队首
  useEffect(() => {
    const wasBusy = prevTurnBusyForDrainRef.current
    prevTurnBusyForDrainRef.current = selectedTurnBusy
    if (selectedTurnBusy || !wasBusy) return
    if (pendingDrainBusyRef.current) return

    const sk = String(sessionRef.current || selectedSessionKey || '').trim()
    const injects = midTurnInjectRef.current.filter((x) => x.sessionKey === sk)
    const steers = pendingSteersRef.current.filter((s) => s.sessionKey === sk)
    const hasOrphanPendingUi = (
      (sk ? getSessionRuntime(sk).rows : null) || rowsRef.current || []
    ).some((r) => r.role === 'user' && r.pendingInject)

    if (
      !injects.length &&
      !steers.length &&
      !pendingSendQueueRef.current.length &&
      !hasOrphanPendingUi
    ) {
      return
    }

    pendingDrainBusyRef.current = true
    void Promise.resolve(
      (async () => {
        let pendingCount = -1
        let lastConsumedMessageId: string | null = null
        let statusItems: Array<{ messageId: string; text: string }> = []
        try {
          const status = await getPendingInjectStatus(sk)
          if (status && typeof status.pendingCount === 'number') {
            pendingCount = status.pendingCount
            const lc = status.lastConsumed as
              | { messageId?: string; message_id?: string }
              | null
              | undefined
            lastConsumedMessageId =
              (lc?.messageId && String(lc.messageId).trim()) ||
              (lc?.message_id && String(lc.message_id).trim()) ||
              null
            if (Array.isArray(status.items)) {
              statusItems = status.items
                .map((it: { messageId?: string; text?: string }) => ({
                  messageId: String(it?.messageId || '').trim(),
                  text: String(it?.text || '').trim(),
                }))
                .filter((it: { messageId: string }) => it.messageId)
            }
          }
        } catch {
          pendingCount = -1
        }

        // Sync composer preview with backend authority
        if (pendingCount === 0) {
          // All consumed: promote any remaining local steers into transcript rows
          const localIds = steers.map((s) => s.messageId)
          if (localIds.length) promoteConsumedSteersToRows(sk, localIds)
          else {
            setPendingSteers((prev) => prev.filter((s) => s.sessionKey !== sk))
            midTurnInjectRef.current = midTurnInjectRef.current.filter((x) => x.sessionKey !== sk)
          }
          // Clear legacy badges
          const rt = getSessionRuntime(sk)
          const cleaned = (Array.isArray(rt.rows) ? rt.rows : []).map((r) => {
            if (r.role !== 'user' || !r.pendingInject) return r
            const { pendingInject: _omit, ...rest } = r
            return rest
          })
          rt.rows = cleaned
          if (String(sessionRef.current || '').trim() === sk) {
            setRows([...cleaned])
            rowsRef.current = [...cleaned]
          }
        } else if (pendingCount > 0 && statusItems.length) {
          // Keep only still-pending steers in preview; promote others
          const pendingIds = new Set(statusItems.map((i) => i.messageId))
          const consumedLocal = steers
            .filter((s) => !pendingIds.has(s.messageId))
            .map((s) => s.messageId)
          if (consumedLocal.length) promoteConsumedSteersToRows(sk, consumedLocal)
          setPendingSteers((prev) => {
            const keep = prev.filter((s) => s.sessionKey !== sk || pendingIds.has(s.messageId))
            const existing = new Set(keep.filter((s) => s.sessionKey === sk).map((s) => s.messageId))
            const add = statusItems
              .filter((i) => !existing.has(i.messageId))
              .map((i) => ({
                id: i.messageId,
                messageId: i.messageId,
                text: i.text,
                sessionKey: sk,
              }))
            return [...keep, ...add]
          })
        }

        let needsContinue: { messageId: string; text: string; sessionKey: string } | null = null
        if (pendingCount > 0) {
          const still = pendingSteersRef.current.filter((s) => s.sessionKey === sk)
          if (still.length) {
            needsContinue = {
              messageId: still[0].messageId,
              text: still[0].text,
              sessionKey: sk,
            }
          } else if (statusItems.length) {
            needsContinue = {
              messageId: statusItems[0].messageId,
              text: statusItems[0].text,
              sessionKey: sk,
            }
          } else if (injects.length) {
            needsContinue = injects[0]
          }
        }

        if (needsContinue) {
          try {
            await handleSendRef.current(needsContinue.text, undefined, undefined, {
              messageId: needsContinue.messageId,
              skipTranscriptAppend: true,
              alreadyInjected: true,
            })
            midTurnInjectRef.current = midTurnInjectRef.current.filter(
              (x) => !(x.sessionKey === sk && x.messageId === needsContinue!.messageId),
            )
          } catch {
            /* retry next busy→idle */
          }
          return
        }

        midTurnInjectRef.current = midTurnInjectRef.current.filter((x) => x.sessionKey !== sk)

        const next = pendingSendQueueRef.current[0]
        if (!next) return
        const rowStill = sessionsRef.current.find((s) => String(s.sessionKey || '') === sk)
        if (isSessionExecuting(sk, { sessionRow: rowStill })) {
          // 仍 busy：保留队首，勿先出队再被 handleSend 门闩吃掉
          return
        }
        setPendingSendQueue((prev) => prev.filter((x) => x.id !== next.id))
        await handleSendRef.current(next.text)
      })(),
    ).finally(() => {
      pendingDrainBusyRef.current = false
    })
  }, [selectedTurnBusy, selectedSessionKey, promoteConsumedSteersToRows])

  // 切换会话：清空本地排队；从 DB 恢复未消费 steers（runtime thread input_state 对标）
  useEffect(() => {
    setPendingSendQueue([])
    pendingDrainBusyRef.current = false
    midTurnInjectRef.current = []
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) {
      setPendingSteers([])
      return
    }
    let cancelled = false
    void getPendingInjectStatus(sk).then((status) => {
      if (cancelled) return
      const items = Array.isArray(status?.items) ? status.items : []
      setPendingSteers(
        items
          .map((it: { messageId?: string; text?: string }) => ({
            id: String(it?.messageId || '').trim(),
            messageId: String(it?.messageId || '').trim(),
            text: String(it?.text || '').trim(),
            sessionKey: sk,
          }))
          .filter((s: { messageId: string; text: string }) => s.messageId && s.text),
      )
    })
    return () => {
      cancelled = true
    }
  }, [selectedSessionKey])

  function resetChatSurfaceForNewDraft() {
    streamRef.current = emptyStream()
    setLiveTurnAssistantRunId(null)
    rowsRef.current = []
    setRows([])
    setTokenTotals(null)
    setLiveTurnTokens(null)
    setSubagentDockTasks({})
    setThreadPanelState(clearThreadPanelActivity(emptyThreadPanel()))
    resetCollabPlanUiForSession({ closeSidebar: true })
    processedTaskIdRef.current = null
    // 新建会话统一回落 Agent 模式，不继承上一个会话的模式
    setSessionMode('agent')
    scheduleBump({ immediate: true })
  }

  function startNewSessionWithWorkspace(workspacePath: string | null) {
    pendingComposerDraftCarryRef.current = composerTextRef.current
    const oldSk = String(selectedSessionKey || sessionRef.current || '').trim()
    if (oldSk) {
      const prevRt = getSessionRuntime(oldSk)
      commitActiveSessionRuntime(oldSk, {
        rows: rowsRef.current,
        stream:
          streamRef.current === prevRt.stream || String(sessionRef.current || '').trim() === oldSk
            ? streamRef.current
            : prevRt.stream,
        seenRunIds: seenRunIdsRef.current,
        activeChatRunId: activeChatRunIdRef.current,
      })
    }
    pendingNewSessionRef.current = true
    // 立刻切到空白草稿态，避免等 POST 时侧栏像「点了没反应」
    setSelectedSessionKey('')
    sessionRef.current = ''
    setNewChatButtonActive(true)
    resetChatSurfaceForNewDraft()
    if (workspacePath) {
      setLocalWorkspaceRoot(String(workspacePath).trim())
    } else {
      setLocalWorkspaceRoot('')
    }
    ssLog('new.start', { oldSk: skTail(oldSk), workspace: workspacePath || '(default)' })
    void coalesceCreateSession(() => createSessionForChat({ workspaceRoot: workspacePath }))
      .then((key) => {
        ssLog('new.complete', { key: skTail(key || ''), sessionRef: skTail(sessionRef.current) })
        if (key) {
          setSelectedSessionKey(key)
          sessionRef.current = key
          setNewChatButtonActive(false)
          if (workspacePath) {
            const ws = String(workspacePath).trim()
            pendingNewSessionWorkspaceRef.current = { sessionKey: key, path: ws }
            setLocalWorkspaceRoot(ws)
            window.dispatchEvent(
              new CustomEvent('evopanel:shell-expand-workspace', {
                detail: { workspaceKey: normalizeWorkspacePathKey(ws) },
              }),
            )
          } else {
            pendingNewSessionWorkspaceRef.current = null
            setLocalWorkspaceRoot('')
          }
        } else {
          setSelectedSessionKey('')
          sessionRef.current = ''
          setNewChatButtonActive(true)
          resetChatSurfaceForNewDraft()
        }
      })
      .finally(() => {
        // 延后清 pending：避免 create 刚写完 sessionRef、React 尚未同步 selectedSessionKeyRef
        // 时，在途的列表刷新走 first-selectable 把选中抢回历史会话。
        queueMicrotask(() => {
          window.setTimeout(() => {
            pendingNewSessionRef.current = false
            ssLog('new.inflight-end', { sessionRef: skTail(sessionRef.current) })
          }, 0)
        })
      })
  }

  function resolveWorkspaceForNewSession(): string | null {
    if (shellIntentWorkspaceRef.current !== undefined) {
      const intent = String(shellIntentWorkspaceRef.current || '').trim()
      return intent || null
    }
    const cur = String(localWorkspaceRootRef.current || '').trim()
    return cur || null
  }

  function handleNewSession() {
    startNewSessionWithWorkspace(resolveWorkspaceForNewSession())
  }

  /** 回到工作台：已在空会话仪表盘则不重复建会话；否则新开空会话以展示首页 */
  function handleOpenHome() {
    const onHome =
      !historyLoading &&
      !historyError &&
      !sessionHadContent &&
      Array.isArray(rowsRef.current) &&
      rowsRef.current.length === 0 &&
      !selectedTurnBusy
    if (onHome) {
      try {
        document
          .querySelector('.chat-messages-inner--home')
          ?.scrollTo?.({ top: 0, behavior: 'smooth' })
      } catch {
        /* ignore */
      }
      return
    }
    startNewSessionWithWorkspace(resolveWorkspaceForNewSession())
  }

  function handleNewSessionInWorkspace(workspacePath: string | null) {
    const ws = String(workspacePath || '').trim()
    shellIntentWorkspaceRef.current = ws || null
    startNewSessionWithWorkspace(ws || null)
  }

  const onShellWorkspaceFocus = useCallback((workspacePath: string | null) => {
    shellIntentWorkspaceRef.current = workspacePath ? String(workspacePath).trim() : null
  }, [])

  handleNewSessionRef.current = handleNewSession
  handleOpenHomeRef.current = handleOpenHome
  handleNewSessionInWorkspaceRef.current = handleNewSessionInWorkspace
  handleNewWorkspaceRef.current = () => {
    void handleNewWorkspace()
  }

  /** 在当前会话切换预设角色（写入 context，不新开会话；与 main / Claude Code 一致） */
  async function startNewChatWithPresetAgent(agentCodeRaw: string) {
    const code = (agentCodeRaw || '').trim().toLowerCase()
    if (!code) return
    setRoleSwitchBusy(true)
    setBottomRoleOpen(false)
    try {
      const { api } = await import('../lib/tauri-api.js')
      const sk = (selectedSessionKey || (await ensureChatSessionKey()) || '').trim()
      if (!sk) return
      if (isProactiveSessionKey(sk)) {
        toast('智能体员工会话岗位已固定，不能切换角色', 'info')
        return
      }
      if (resolveSessionAgentCodeForUi(sk) === code) {
        toast('当前已是该角色', 'info')
        return
      }

      const agentRow = agents.find(
        (a: { agent_code?: string }) => String(a?.agent_code || '').trim().toLowerCase() === code,
      )
      const label =
        (agentRow && String(agentRow.agent_name || '').trim()) ||
        (code === 'main' ? 'EvoFlow' : code === 'claude-code' ? '代码助手' : code)

      if (code === 'main') {
        await api.chatUpdateContext(sk, {
          use_claude_code_chat: false,
          agent_name: 'main',
          agent_id: 'main',
          collab_phase: 'idle',
          collab_task_id: null,
          model_name: null,
        })
        setSessions((prev) =>
          prev.map((s) =>
            String(s.sessionKey || '') === sk ? { ...s, agentId: 'main', modelName: null } : s,
          ),
        )
        setRoleUiNonce((n) => n + 1)
        toast('已切换为 EvoFlow（当前会话）', 'success')
        return
      }
      if (code === 'claude-code') {
        await api.chatUpdateContext(sk, {
          use_claude_code_chat: true,
          agent_name: 'claude-code',
          collab_phase: 'idle',
          collab_task_id: null,
          model_name: null,
        })
        setSessions((prev) =>
          prev.map((s) =>
            String(s.sessionKey || '') === sk ? { ...s, agentId: 'claude-code', modelName: null } : s,
          ),
        )
        setRoleUiNonce((n) => n + 1)
        toast('已切换为代码助手模式（当前会话）', 'success')
        return
      }

      await api.chatUpdateContext(sk, {
        use_claude_code_chat: false,
        agent_name: code,
        agent_id: code,
        collab_phase: 'idle',
        collab_task_id: null,
        model_name: null,
      })
      setSessions((prev) =>
        prev.map((s) =>
          String(s.sessionKey || '') === sk ? { ...s, agentId: code, modelName: null } : s,
        ),
      )
      setRoleUiNonce((n) => n + 1)
      toast(`已切换为「${label}」（当前会话，历史消息保留）`, 'success')
    } catch (e) {
      toast(toUserFacingError((e as Record<string, unknown>)?.message || e || '切换角色失败', '切换角色失败'), 'error')
    } finally {
      setRoleSwitchBusy(false)
    }
  }
  startNewChatWithPresetAgentRef.current = startNewChatWithPresetAgent

  async function handleDeleteSession(key?: string) {
    const targetKey = key || selectedSessionKey
    if (!targetKey || deleteSessionConfirmInflightRef.current) return
    deleteSessionConfirmInflightRef.current = true
    // 先收起侧栏「···」菜单，避免确认框下方仍留着「删除会话」导致第一次点击被穿透/误触
    setMoreMenuKey(null)
    try {
      await new Promise<void>((resolve) => {
        window.setTimeout(() => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        }, 0)
      })
      suppressModalBackdropDismiss(300)
      const yes = await showConfirm('删除此会话？')
      if (!yes) return

      const { api } = await import('../lib/tauri-api.js')
      const viewingDeleted =
        targetKey === sessionRef.current || targetKey === selectedSessionKey

      // 侧栏先去掉条目（含搜索缓存），避免 refresh 合并草稿时从 prev 粘回（agent:*:new-*）
      removeSessionFromList(targetKey)
      clearSessionRuntime(targetKey)
      deleteLiveStream(targetKey)
      seenArtifactsRef.current.delete(targetKey)
      setMoreMenuKey((mk) => (mk === targetKey ? null : mk))

      if (viewingDeleted) {
        sessionRef.current = ''
        setSelectedSessionKey('')
        setNewChatButtonActive(true)
        streamRef.current = emptyStream()
        seenRunIdsRef.current = new Set()
        rowsRef.current = []
        setRows([])
        setTokenTotals(null)
        setLiveTurnTokens(null)
        setSubagentDockTasks({})
        setSidebarTaskViews({})
        setSidebarSelectedTaskId(null)
        setThreadPanelState(emptyThreadPanel())
        setHasReceivedTodos(false)
        setBoundTaskId(null)
        bumpStreamFullRef.current()
      }

      await api.chatSessionsDelete(targetKey, { clearWorkspaceHistory: false })
      composerDraftsRef.current.delete(targetKey)
      await refreshSessions({ skipAutoReselect: true })
    } catch (e) {
      toast(toUserFacingError((e as Error)?.message || e), 'error')
    } finally {
      deleteSessionConfirmInflightRef.current = false
    }
  }

  handleDeleteSessionRef.current = handleDeleteSession

  /** 侧栏会话列表变化时释放已删除会话的 runtime / live-stream，避免长期泄漏 */
  useEffect(() => {
    const keep = new Set<string>()
    for (const s of sessions) {
      const sk = String(s?.sessionKey || '').trim()
      if (sk) keep.add(sk)
    }
    const active = String(selectedSessionKey || sessionRef.current || '').trim()
    if (active) keep.add(active)
    pruneSessionRuntimes(keep)
    pruneLiveStreams(keep)
    for (const sk of [...seenArtifactsRef.current.keys()]) {
      if (!keep.has(sk)) seenArtifactsRef.current.delete(sk)
    }
  }, [sessions, selectedSessionKey])

  const onShellPinSession = useCallback((key: string, pinned: boolean) => {
    markSessionPinPending(key, pinned)
    setSessions((prev) => patchSessionPinInRows(prev, key, pinned))
  }, [setSessions])

  const onShellDeleteSession = useCallback((k: string) => {
    void handleDeleteSessionRef.current?.(k)
  }, [])

  const onShellRefreshSession = useCallback(async (k: string) => {
    setMoreMenuKey(null)
    if (sessionRef.current !== k) {
      sessionRef.current = k
      setSelectedSessionKey(k)
    }
    await runShellSessionRefreshRef.current?.(k)
  }, [setMoreMenuKey, setSelectedSessionKey])

  const onShellRefreshSessionList = useCallback(async () => {
    const sel = sessionRef.current
    await refreshSessionsRef.current?.()
    if (sel && sessionRef.current === sel) {
      await runShellSessionRefreshRef.current?.(sel)
    }
  }, [])

  const onShellStopSession = useCallback(async (k: string) => {
    setMoreMenuKey(null)
    try {
      await stopSessionExecutionRef.current?.(k)
    } catch (e) {
      toast(toUserFacingError((e as Error)?.message || e), 'error')
    }
  }, [setMoreMenuKey])

  const onShellNewWorkspace = useCallback(() => {
    handleNewWorkspaceRef.current?.()
  }, [])

  const onShellNewSessionInWorkspace = useCallback((path: string | null) => {
    handleNewSessionInWorkspaceRef.current?.(path)
  }, [])

  reloadRef.current = reloadHistoryFromDb
  boundTaskIdRef.current = boundTaskId
  threadBoundTaskIdRef.current = threadPanelState?.boundTaskId ?? null

  const selectSessionFromShellRef = useRef<(sessionKey: string) => void>(() => {})
  const selectSessionFromShell = useCallback(
    (sessionKey: string) => {
      const k = String(sessionKey || '').trim()
      if (!k) return
      ssLog('shell.select', { key: skTail(k), from: skTail(sessionRef.current) })
      setShellSelectRevision((r) => r + 1)
      try {
        sessionStorage.removeItem('evopanel_pending_shell_session')
      } catch {
        /* ignore */
      }
      sessionRef.current = k
      flushSync(() => {
        setNewChatButtonActive(false)
        setMoreMenuKey(null)
        setSelectedSessionKey(k)
        if (typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches) {
          setMobileChatPane('thread')
        }
      })
    },
    [setNewChatButtonActive, setSelectedSessionKey, setMoreMenuKey],
  )
  selectSessionFromShellRef.current = selectSessionFromShell

  const onShellForkSession = useCallback(async (k: string) => {
    const key = String(k || '').trim()
    if (!key) return
    setMoreMenuKey(null)
    try {
      const { api } = await import('../lib/tauri-api.js')
      const data = await api.chatSessionsFork(key)
      const newKey = String(data?.sessionKey || data?.session?.sessionKey || '').trim()
      if (!newKey) throw new Error('分叉失败：未返回新会话')
      await refreshSessionsRef.current?.({ skipAutoReselect: true })
      selectSessionFromShellRef.current(newKey)
      toast('已分叉会话', 'success')
    } catch (e) {
      toast(toUserFacingError((e as Error)?.message || e || '分叉失败'), 'error')
    }
  }, [setMoreMenuKey])

  const handleForkFromMessage = useCallback(async (messageId?: string) => {
    const key = String(selectedSessionKey || '').trim()
    if (!key) return
    try {
      const { api } = await import('../lib/tauri-api.js')
      const mid = String(messageId || '').trim()
      const data = await api.chatSessionsFork(key, mid ? { throughMessageId: mid } : {})
      const newKey = String(data?.sessionKey || data?.session?.sessionKey || '').trim()
      if (!newKey) throw new Error('分叉失败：未返回新会话')
      await refreshSessionsRef.current?.({ skipAutoReselect: true })
      selectSessionFromShellRef.current(newKey)
      toast('已从此处分叉会话', 'success')
    } catch (e) {
      toast(toUserFacingError((e as Error)?.message || e || '分叉失败'), 'error')
    }
  }, [selectedSessionKey])

  handleEditMessageRef.current = async (text: string, messageId?: string) => {
    const draft = String(text || '').trim()
    const mid = String(messageId || '').trim()
    const key = String(selectedSessionKey || sessionRef.current || '').trim()
    if (!draft) return
    if (!key) {
      toast('当前没有选中会话', 'error')
      throw new Error('no session')
    }

    // 无 messageId：无法安全截断（历史行缺 id 时刷新后再试）
    if (!mid) {
      toast('无法定位该消息，请刷新会话后再编辑', 'error')
      throw new Error('missing messageId')
    }

    try {
      const { api } = await import('../lib/tauri-api.js')
      await api.chatSessionsTruncate(key, { fromMessageId: mid })

      // 同一会话内截掉该条及之后的 UI 行
      const prev = rowsRef.current || []
      let cutIdx = prev.findIndex((r) => String(r.messageId || '').trim() === mid)
      if (cutIdx < 0) {
        // 兜底：按正文匹配最近一条 user（编辑后文案可能已变，尽量用原 id）
        for (let i = prev.length - 1; i >= 0; i--) {
          if (prev[i]?.role !== 'user') continue
          if (String(prev[i]?.text || '').trim() === draft) {
            cutIdx = i
            break
          }
        }
      }
      if (cutIdx >= 0) {
        const next = prev.slice(0, cutIdx)
        rowsRef.current = next
        setRows(next)
        try {
          const rt = getSessionRuntime(key)
          commitActiveSessionRuntime(key, {
            rows: next,
            stream: rt.stream,
            seenRunIds: seenRunIdsRef.current,
            activeChatRunId: activeChatRunIdRef.current,
          })
        } catch {
          /* ignore */
        }
      }

      // 用编辑后的正文重新发送（不塞底部输入框）
      await handleSendRef.current?.(draft)
    } catch (e) {
      toast(toUserFacingError((e as Error)?.message || e || '编辑失败'), 'error')
      throw e
    }
  }

  const prefetchSessionHistoryFromShell = useCallback(
    (sessionKey: string) => {
      const sk = String(sessionKey || '').trim()
      if (!sk || sk === String(selectedSessionKey || '').trim()) return
      warmSessionHistoryPrefetch(sk)
    },
    [selectedSessionKey],
  )

  useEffect(() => {
    const onNew = () => {
      if (typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches) {
        setMobileChatPane('thread')
      }
      void handleNewSessionRef.current?.()
    }
    const onOpenHome = () => {
      if (typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches) {
        setMobileChatPane('list')
        return
      }
      void handleOpenHomeRef.current?.()
    }
    const onMobileChatList = () => {
      setMobileChatPane('list')
    }
    const onSettingsModalOpened = () => {
      cancelPendingStreamUiBumpsRef.current()
    }
    const onSettingsModalClosed = () => {
      if (!isChatOverlayDeferActive()) {
        scheduleBumpRef.current?.({ immediate: true })
      }
    }
    const onChatRouteShown = () => {
      // 从知识库/菜单返回：强制解开消息面 + 确保常驻宿主可见
      setChatSurfaceVisible(true)
      try {
        const host = document.getElementById('chat-persistent-host')
        if (host) {
          host.hidden = false
          host.style.display = 'flex'
        }
      } catch {
        /* ignore */
      }
      try {
        const pending = sessionStorage.getItem('evopanel_pending_shell_session')
        if (pending) {
          sessionStorage.removeItem('evopanel_pending_shell_session')
          selectSessionFromShellRef.current(pending)
        }
        if (sessionStorage.getItem('evopanel_pending_mobile_chat_list') === '1') {
          sessionStorage.removeItem('evopanel_pending_mobile_chat_list')
          setMobileChatPane('list')
        }
      } catch {
        /* ignore */
      }
    }
    const onShellSelectSession = (ev: Event) => {
      const key = String((ev as CustomEvent<{ sessionKey?: string }>).detail?.sessionKey || '').trim()
      if (!key) return
      selectSessionFromShellRef.current(key)
    }
    window.addEventListener('evopanel:shell-new-session', onNew)
    window.addEventListener('evopanel:shell-open-home', onOpenHome)
    window.addEventListener('evopanel:mobile-chat-list', onMobileChatList)
    window.addEventListener('evopanel:shell-select-session', onShellSelectSession)
    window.addEventListener('evopanel:settings-modal-opened', onSettingsModalOpened)
    window.addEventListener('evopanel:settings-modal-closed', onSettingsModalClosed)
    window.addEventListener('evopanel:chat-route-shown', onChatRouteShown)
    return () => {
      window.removeEventListener('evopanel:shell-new-session', onNew)
      window.removeEventListener('evopanel:shell-open-home', onOpenHome)
      window.removeEventListener('evopanel:mobile-chat-list', onMobileChatList)
      window.removeEventListener('evopanel:shell-select-session', onShellSelectSession)
      window.removeEventListener('evopanel:settings-modal-opened', onSettingsModalOpened)
      window.removeEventListener('evopanel:settings-modal-closed', onSettingsModalClosed)
      window.removeEventListener('evopanel:chat-route-shown', onChatRouteShown)
    }
  }, [])

  return (
    <HoverBubbleProvider>
    <div
      className={`chat-react-full${isMobileChat ? ' is-mobile-chat' : ''}${
        isMobileChat && mobileChatPane === 'list' ? ' is-mobile-chat-list' : ''
      }${isMobileChat && mobileChatPane === 'thread' ? ' is-mobile-chat-thread' : ''}`}
    >
      <div className="react-chat-workspace react-chat-workspace--no-aside">
        <div className={`chat-main react-chat-main-col${isHomeSurface ? ' react-chat-main-col--home' : ''}`}>
          <header
            className={`react-chat-header${isDesktopTauriRuntime() ? ' react-chat-header--tauri-chrome' : ''}${
              isMobileChat ? ' react-chat-header--mobile' : ''
            }`}
            {...(isDesktopTauriRuntime()
              ? ({
                  'data-tauri-drag-region': '',
                  title: '拖动窗口 · 双击最大化',
                  onDoubleClick: (e: ReactMouseEvent<HTMLElement>) => {
                    if ((e.target as HTMLElement).closest('[data-tauri-no-drag]')) return
                    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) =>
                      void getCurrentWindow().toggleMaximize(),
                    )
                  },
                } as Record<string, unknown>)
              : {})}
          >
            {isMobileChat ? (
              <>
                <div className="react-chat-header-left react-chat-header-left--mobile">
                  <button
                    type="button"
                    className="react-chat-toggle-sidebar-btn react-chat-mobile-back-btn"
                    title="返回会话列表"
                    aria-label="返回会话列表"
                    onClick={() => setMobileChatPane('list')}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" width="20" height="20">
                      <path d="M15 18l-6-6 6-6" />
                    </svg>
                  </button>
                  <span className="react-chat-mobile-title">
                    {isHomeSurface
                      ? null
                      : getDisplayLabel(
                          selectedSessionKey,
                          sessions.find((s) => String(s.sessionKey || '') === String(selectedSessionKey || ''))?.title,
                        )}
                  </span>
                </div>
                <div className="react-chat-header-right react-chat-header-right--mobile">
                  {isDesktopTauriRuntime() ? (
                    <>
                      <span className="react-chat-header-win-sep" aria-hidden="true" />
                      <TauriWindowControls />
                    </>
                  ) : null}
                </div>
              </>
            ) : isDesktopTauriRuntime() ? (
              <>
                <div className="react-chat-header-toolbar" {...TAURI_HEADER_CELL_DRAG_PROPS}>
                  <button
                    type="button"
                    className="react-chat-toggle-sidebar-btn"
                    data-tauri-no-drag
                    title="主导航"
                    aria-label="主导航"
                    onClick={() => {
                      toggleShellAsideCollapsed()
                    }}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                      <line x1="3" y1="6" x2="21" y2="6" />
                      <line x1="3" y1="12" x2="21" y2="12" />
                      <line x1="3" y1="18" x2="21" y2="18" />
                    </svg>
                  </button>
                  <div className="react-chat-header-session" data-tauri-no-drag>
                    {isHomeSurface ? null : (
                      <>
                        <span className="react-chat-header-session-title">
                          {getDisplayLabel(
                            selectedSessionKey,
                            sessions.find((s) => String(s.sessionKey || '') === String(selectedSessionKey || ''))?.title,
                          )}
                        </span>
                        {selectedTurnBusy ? (
                          <span className="react-chat-header-run-badge">Running</span>
                        ) : !engineReady ? (
                          <span className="react-chat-header-run-badge is-warming">引擎加载中</span>
                        ) : null}
                      </>
                    )}
                  </div>
                  {isHomeSurface ? null : collabVerifyingBadge}
                </div>
                <div className="react-chat-header-title-drag" {...TAURI_HEADER_CELL_DRAG_PROPS} />
                <div className="react-chat-header-tauri-drag-gap" aria-hidden="true" {...TAURI_HEADER_CELL_DRAG_PROPS} />
                <div className="react-chat-header-right" {...TAURI_HEADER_CELL_DRAG_PROPS}>
                  {isHomeSurface ? null : (
                  <div className="react-chat-header-product-actions" data-tauri-no-drag>
                    <div className="react-chat-header-action-group react-chat-header-action-group--panels">
                    {infoRailHeaderToggle}
                    </div>
                    <span className="react-chat-header-action-sep" aria-hidden />
                    <div className="react-chat-header-action-group react-chat-header-action-group--global">
                    <button
                      type="button"
                      className="react-chat-header-share-btn"
                      title="分享"
                      disabled={!selectedSessionKey || isHomeSurface}
                      onClick={() => setShareSessionOpen(true)}
                    >
                      分享
                    </button>
                    {collabExecToggleButton}
                    {knowledgeMapEnabled ? knowledgeMapToggleButton : null}
                    {stageExtensionsToolbar}
                    {workspaceFolderToggleButton}
                    </div>
                  </div>
                  )}
                  {isHomeSurface ? null : <span className="react-chat-header-win-sep" aria-hidden="true" />}
                  <TauriWindowControls />
                </div>
              </>
            ) : (
              <>
              <div className="react-chat-header-left">
                <button
                  type="button"
                  className="react-chat-toggle-sidebar-btn"
                  title="主导航"
                  onClick={() => {
                    toggleShellAsideCollapsed()
                  }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                    <line x1="3" y1="6" x2="21" y2="6" />
                    <line x1="3" y1="12" x2="21" y2="12" />
                    <line x1="3" y1="18" x2="21" y2="18" />
                  </svg>
                </button>
                <div className="react-chat-header-session">
                  {isHomeSurface ? null : (
                    <>
                      <span className="react-chat-header-session-title">
                        {getDisplayLabel(
                          selectedSessionKey,
                          sessions.find((s) => String(s.sessionKey || '') === String(selectedSessionKey || ''))?.title,
                        )}
                      </span>
                      {selectedTurnBusy ? (
                        <span className="react-chat-header-run-badge">Running</span>
                      ) : !engineReady ? (
                        <span className="react-chat-header-run-badge is-warming">引擎加载中</span>
                      ) : null}
                    </>
                  )}
                </div>
                {isHomeSurface ? null : collabVerifyingBadge}
              </div>
              <div className="react-chat-header-right">
                {isHomeSurface ? null : (
                <div className="react-chat-header-product-actions">
                  <div className="react-chat-header-action-group react-chat-header-action-group--panels">
                  {infoRailHeaderToggle}
                  </div>
                  <span className="react-chat-header-action-sep" aria-hidden />
                  <div className="react-chat-header-action-group react-chat-header-action-group--global">
                  <button
                    type="button"
                    className="react-chat-header-share-btn"
                    title="分享"
                    disabled={!selectedSessionKey || isHomeSurface}
                    onClick={() => setShareSessionOpen(true)}
                  >
                    分享
                  </button>
                  {collabExecToggleButton}
                  {knowledgeMapEnabled ? knowledgeMapToggleButton : null}
                  {stageExtensionsToolbar}
                  {workspaceFolderToggleButton}
                  </div>
                </div>
                )}
              </div>
              </>
            )}
          </header>
          <div
            ref={mainBodyRef}
            style={mainBodyLayoutStyle}
            className={`react-chat-main-body${
              rightStageOpen ? ` ${mainBodyStageClasses}` : ''
            }${
              !rightStageOpen && infoRailOpen && !isHomeSurface && selectedSessionKey && !isMobileChat
                ? ' is-info-rail-open'
                : ''
            }${
              anyRightPanelOpen && layoutResizeEnabled && rightPanelWidthPx != null
                ? ' is-layout-custom-width'
                : ''
            }`}
          >
            <div
              className="react-chat-conversation-col"
              ref={conversationColRef}
              onDragOver={handleConversationComposeDragOver}
              onDrop={handleConversationComposeDrop}
            >
          {historyError && (
            <div className="react-chat-error-banner">{toUserFacingError(historyError)}</div>
          )}
          {streamHealth === 'disconnected' ? (
            <div className="react-chat-stream-health-banner react-chat-stream-health-banner--disconnected" role="status">
              <span className="react-chat-stream-health-dot" aria-hidden />
              连接已断开，正在尝试重连…
            </div>
          ) : null}
          {streamHealth === 'silent' ? (
            <div className="react-chat-stream-health-banner react-chat-stream-health-banner--silent" role="status">
              <span className="react-chat-stream-health-dot" aria-hidden />
              响应较慢，请稍候…
            </div>
          ) : null}
          <div
            className={`react-chat-messages-wrap chat-messages-wrap${
              showHistoryFetchOverlay ? ' react-chat-messages-wrap--history-loading' : ''
            }`}
          >
            {showHistoryFetchOverlay ? (
              <div className="react-chat-history-fetch-overlay" aria-busy="true" aria-live="polite">
                <HistoryFetchSpinner />
                <div className="page-loader-text">加载中...</div>
              </div>
            ) : null}
            {showHistorySyncHint ? (
              <div className="react-chat-history-sync-hint" role="status" aria-live="polite">
                正在同步…
              </div>
            ) : null}
            <div className="react-chat-messages-body">
              <ChatMessageStreamPane
                rows={renderRows}
                streamRef={streamRef}
                historyLoading={historyLoading}
                showHomeDashboard={isHomeSurface}
                isSending={selectedTurnBusy}
                streamLive={selectedSessionLive}
                resumeAttachActive={selectedResumeAttach}
                resumeStreamHoldActive={selectedResumeStreamHold}
                onViewReady={handleHistoryViewReady}
                sessionKey={selectedSessionKey}
                onQuickPrompt={handleQuickPrompt}
                suppressPlanExecPromptNoise={!!planExecConfirmAnchor}
                onToolApproval={onToolApprovalStable}
                toolApprovalBusy={toolApprovalInFlight}
                toolApprovalUiDisabled={toolApprovalUiDisabled}
                hideSubagentInnerTools={
                  !!threadPanelState.collabTask?.executionAuthorized ||
                  threadPanelState.collabPhase === 'executing'
                }
                inlineSubagentTasks={threadPanelState.subagentTasks}
                onOpenFile={openMessageFilePreview}
                onOpenKnowledgeMap={knowledgeMapEnabled ? openKnowledgeMapPanel : undefined}
                recentArtifacts={turnArtifacts}
                onOpenArtifact={openSessionArtifact}
                liveTurnAssistantRunId={liveTurnAssistantRunId}
                liveTurnTokenStr={liveTurnTokenStr}
                liveTurnTimingActive={liveTurnTimingActive || goalExecutionTiming}
                executionToolTiming={executionToolTiming}
                goalExecutionTiming={goalExecutionTiming}
                hostedGoalActive={goal.goal.ui.goalActive}
                lastAssistantRowIndex={lastAssistantRowIndex}
                streamPriorTurnStrip={selectedStreamPriorTurnStrip}
                resolveLiveStreamActivity={resolveLiveStreamActivityForSession}
                streamingWritePreview={streamingWritePreview}
                workspacePanelWritePreview={workspacePanelWritePreview}
                layoutKey={rightStageOpen ? 'right-stage-open' : 'right-stage-closed'}
                onCopy={handleCopyMessage}
                onRetry={handleRetryMessage}
                onEdit={handleEditMessage}
                onFork={handleForkFromMessage}
                historyHasMore={historyHasMore}
                historyLoadingOlder={historyLoadingOlder}
                onLoadOlder={loadOlderHistory}
                instantOpen={historyInstantPaint && !historyLoading}
                assistantAgent={currentRoleAgent}
                assistantAgentLabel={assistantReplyLabel}
              />
            </div>
          </div>
          <SessionSidebar
            state={threadPanelState}
            taskHistory={sidebarHistory}
            selectedTaskId={sidebarActiveTaskId}
            activeTaskSubtasks={sidebarActiveView?.subtasks}
            activeTaskSteps={sidebarActiveView?.steps}
            isOpen={sessionSidebarOpen}
            agents={agents}
            chatThreadId={chatThreadIdForSidebar}
            apiSubtasks={sharedCollabSubtasks}
            hideCollabSubtaskList
            execConfirmPending={
              !!planDockApiView?.show &&
              planDockApiView.showStartExecution &&
              !threadPanelState.collabTask?.executionAuthorized
            }
            subtaskTranscriptModal={subtaskTranscriptModal}
            onSubtaskTranscriptModalChange={setSubtaskTranscriptModal}
            onOpenMessageFile={openMessageFilePreview}
            sessionStreamConnected={streamHealth !== 'disconnected'}
            onSubmitClarification={handleSubmitClarification}
          />
          <GoalModePanel
            panelOpen={goal.goal.panelOpen}
            setPanelOpen={goal.goal.setPanelOpen}
            ui={goal.goal.ui}
            statusText={goal.goal.statusText}
            statusIcon={goal.goal.goalStatusIcon}
            setDraft={goal.goal.setDraft}
            onStartGoal={handleStartGoal}
            onStopGoal={handleStopGoal}
          />
          <SkillPickerModal
            open={bottomSkillOpen}
            onClose={() => setBottomSkillOpen(false)}
            skills={skillList}
            loading={skillListLoading}
            selected={selectedSkills}
            onConfirm={(next) => {
              setSelectedSkills(next)
              void persistSelectedSkills(String(selectedSessionKey || ''), next)
              if (next.length > 0) {
                toast(`已选择 ${next.length} 个技能`, 'success')
              } else {
                toast('已清空技能选择', 'info')
              }
            }}
          />
          <ShareSessionModal
            open={shareSessionOpen}
            onClose={() => setShareSessionOpen(false)}
            sessionKey={String(selectedSessionKey || '')}
            sessionTitle={getDisplayLabel(
              selectedSessionKey,
              sessions.find((s) => String(s.sessionKey || '') === String(selectedSessionKey || ''))?.title,
            )}
          />
          <AgentPickerModal
            open={bottomRoleOpen}
            onClose={() => setBottomRoleOpen(false)}
            agents={agents}
            loading={false}
            selected={currentRoleCodeForUi}
            onConfirm={(code) => {
              void startNewChatWithPresetAgent(code)
            }}
          />
          <div
            className={`react-chat-bottom-dock${
              bottomDockHeightPx != null ? ' is-bottom-area-resizable' : ''
            }${
              modeMenuOpen || bottomModelOpen || bottomPermissionOpen || bottomMoreOpen || bottomWorkspaceOpen
                ? ' is-bottom-menu-open'
                : ''
            }`}
            onDragOver={handleConversationComposeDragOver}
            onDrop={handleConversationComposeDrop}
          >
            {layoutResizeEnabled ? (
              <PanelResizeHandle
                direction="horizontal"
                label="拖动调整输入区高度"
                dragging={bottomDockResizeDragging}
                onPointerDown={handleBottomDockResizePointerDown}
                className="react-chat-panel-resize-handle--bottom-dock-top"
              />
            ) : null}
            {planExecConfirmAnchor ? (
              <PlanExecConfirm
                taskId={planExecConfirmAnchor.taskId}
                taskName={planExecConfirmAnchor.taskName}
                subtaskCount={planExecConfirmAnchor.subtaskCount}
                showStartExecution={planExecConfirmAnchor.showStartExecution}
                statusLabel={planExecConfirmAnchor.statusLabel}
                planTitle={planExecConfirmAnchor.planTitle}
                planStructuredFallback={planExecConfirmAnchor.planStructuredFallback}
                skipApiFetch={planExecConfirmAnchor.skipApiFetch}
                syncedSubtasks={planExecConfirmAnchor.syncedSubtasks}
                sessionKey={planExecConfirmAnchor.sessionKey}
                busy={planExecConfirmAnchor.busy}
                onDismiss={planExecConfirmAnchor.onDismiss}
                onStartExecution={planExecConfirmAnchor.onStartExecution}
              />
            ) : null}
            {threadPanelState.clarification?.preview ? (
              <ClarificationConfirmDock
                preview={threadPanelState.clarification.preview}
                toolCallId={threadPanelState.clarification.toolCallId}
                busy={selectedTurnBusy}
                onSubmit={handleSubmitClarification}
              />
            ) : null}
            {threadPanelState.goalProposal ? (
              <GoalProposalDock
                proposal={threadPanelState.goalProposal}
                busy={selectedTurnBusy}
                onDismiss={() => {
                  setThreadPanelState((p) => {
                    if (p.goalProposal) {
                      suppressedGoalProposalKeysRef.current.add(goalProposalSuppressKey(p.goalProposal))
                    }
                    return { ...p, goalProposal: null }
                  })
                }}
                onApplyOnly={() => {
                  const hp = threadPanelState.goalProposal
                  if (!hp) return
                  suppressedGoalProposalKeysRef.current.add(goalProposalSuppressKey(hp))
                  setThreadPanelState((p) => ({ ...p, goalProposal: null }))
                  goal.goal.applyGoalProposal(hp, { start: false })
                  toast('已写入目标面板', 'success')
                }}
                onApplyStart={() => {
                  const hp = threadPanelState.goalProposal
                  if (!hp) return
                  suppressedGoalProposalKeysRef.current.add(goalProposalSuppressKey(hp))
                  setThreadPanelState((p) => ({ ...p, goalProposal: null }))
                  void goal.goal.applyGoalProposal(hp, { start: true })
                }}
              />
            ) : null}
            <div
              className={`react-chat-composer-stack${
                pendingSteers.some(
                  (s) =>
                    s.sessionKey === String(selectedSessionKey || sessionRef.current || '').trim(),
                )
                  ? ' has-steer-strip'
                  : ''
              }`}
            >
              <PendingSteersStrip
                items={pendingSteers.filter(
                  (s) =>
                    s.sessionKey === String(selectedSessionKey || sessionRef.current || '').trim(),
                )}
                onCancelPendingSteer={handleCancelPendingSteer}
                onInterruptAndSendSteers={handleInterruptAndSendSteers}
              />
              <div
                className={`react-chat-bottom-area${
                  bottomDockHeightPx != null ? ' is-custom-height' : ''
                }`}
                ref={bottomAreaRef}
                style={bottomAreaLayoutStyle}
              >
            {contextFiles.length > 0 ? (
              <div className="react-chat-context-pills" aria-label="附加上下文文件">
                <span className="react-chat-context-pills-label">已附加 {contextFiles.length} 个文件，发送后注入 Agent 上下文</span>
                {contextFiles.map((f) => {
                  const isImg = isImagePathLike(f.path)
                  const imgSrc = isImg ? resolveChatImageSrc(f.path) : ''
                  if (isImg) {
                    const imgIndex = contextFiles.filter((x) => isImagePathLike(x.path)).findIndex((x) => x.path === f.path)
                    return (
                      <div
                        key={f.path}
                        className="react-chat-context-img-card"
                        role="button"
                        tabIndex={0}
                        title={f.path}
                        onClick={() => setContextImagePreviewIndex(imgIndex >= 0 ? imgIndex : 0)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            setContextImagePreviewIndex(imgIndex >= 0 ? imgIndex : 0)
                          }
                        }}
                      >
                        {imgSrc ? (
                          <img
                            src={imgSrc}
                            alt={f.name}
                            className="react-chat-context-img-thumb"
                            onError={(e) => {
                              e.currentTarget.style.display = 'none'
                            }}
                          />
                        ) : null}
                        <div className="react-chat-context-img-name">{f.name}</div>
                        <button
                          type="button"
                          className="react-chat-context-pill-remove react-chat-context-img-x"
                          aria-label="移除"
                          onClick={(e) => {
                            e.stopPropagation()
                            toggleContextFile(f)
                          }}
                        >
                          ×
                        </button>
                      </div>
                    )
                  }
                  return (
                    <HoverBubble key={f.path} text={f.path} side="top" align="start" maxWidth={420}>
                      <button
                        type="button"
                        className="react-chat-context-pill"
                        onClick={() => toggleContextFile(f)}
                      >
                        <span className="react-chat-context-pill-name">{f.name}</span>
                        <span className="react-chat-context-pill-remove" aria-hidden="true">
                          ×
                        </span>
                      </button>
                    </HoverBubble>
                  )
                })}
              </div>
            ) : null}
            {contextImagePreviewIndex !== null &&
            contextFiles.some((x) => isImagePathLike(x.path)) ? (
              (() => {
                const imgItems: ImagePreviewItem[] = contextFiles
                  .filter((x) => isImagePathLike(x.path))
                  .map((x) => ({ src: resolveChatImageSrc(x.path), name: x.name }))
                const safeIndex = Math.min(contextImagePreviewIndex, imgItems.length - 1)
                return (
                  <ImagePreviewModal
                    images={imgItems}
                    index={safeIndex}
                    onClose={() => setContextImagePreviewIndex(null)}
                  />
                )
              })()
            ) : null}
            {selectedSkills.length > 0 ? (
              <div className="react-chat-skill-composer-pills" aria-label="已选技能">
                <span className="react-chat-context-pills-label">
                  已选 {selectedSkills.length} 个技能，发送时自动注入 Agent
                </span>
                {selectedSkills.map((sk) => (
                  <HoverBubble key={sk.name} text={`技能：${sk.label}`} side="top" align="start" maxWidth={320}>
                    <button
                      type="button"
                      className="react-chat-skill-composer-pill"
                      onClick={() => removeSelectedSkill(sk.name)}
                    >
                      <span className="react-chat-skill-composer-pill-icon" aria-hidden>
                        {sk.icon || '🧩'}
                      </span>
                      <span className="react-chat-skill-composer-pill-label">{sk.label}</span>
                      <span className="react-chat-skill-composer-pill-remove" aria-hidden>
                        ×
                      </span>
                    </button>
                  </HoverBubble>
                ))}
              </div>
            ) : null}
            <MemoryRecallChip
              threadId={wsClient.getSessionThreadId(selectedSessionKey || '') || ''}
              refreshKey={`${selectedSessionKey || ''}:${memoryRecallRefreshKey}`}
            />
            <ChatComposer
              sessionReady
              engineReady={engineReady}
              initialDraft={composerDraftSnapshotRef.current}
              draftVersion={composerDraftVersion}
              onDraftChange={handleComposerDraftChange}
              onComposerWarmup={handleComposerWarmup}
              sending={selectedTurnBusy}
              streaming={selectedTurnBusy && streaming}
              // @ts-expect-error handleSend has extra ctxFiles param
              onSend={handleSend}
              onAbort={handleAbort}
              pendingSteers={pendingSteers.filter(
                (s) => s.sessionKey === String(selectedSessionKey || sessionRef.current || '').trim(),
              )}
              pendingSendQueue={pendingSendQueue}
              onSteerWhileBusy={handleSteerWhileBusy}
              onQueueWhileBusy={handleQueueWhileBusy}
              onFlushPendingSend={handleFlushPendingSend}
              onCancelPendingSend={handleCancelPendingSend}
              onEditPendingSend={handleEditPendingSend}
              onInterruptAndSendSteers={handleInterruptAndSendSteers}
              onEnhancePrompt={handleEnhancePrompt}
              speechEnabled={speechEnabled}
              onVoiceTranscribed={speechEnabled ? handleVoiceTranscribed : undefined}
              onDispatchEmployee={handleDispatchEmployee}
              workspaceMention={workspaceMention}
              attachedContextFileCount={contextFiles.length}
              onAttachContextFiles={attachContextFiles}
              renderBottomControls={(ctrl) => {
                const { pickFiles, pickDocFiles, insertText } = ctrl
                const modelDisabled = modelsLoading && !modelCatalog.length
                const onSelectModel = (name: string) => {
                  setModelName(name)
                  try {
                    localStorage.setItem(STORAGE_MODEL_KEY, name)
                  } catch {
                    /* ignore */
                  }
                  void patchPanelSettings({ lastSelectedModel: name })
                  void (async () => {
                    const sk =
                      (selectedSessionKey || sessionRef.current || '').trim() ||
                      (await ensureChatSessionKeyRef.current?.()) ||
                      ''
                    if (!sk) return
                    try {
                      await wsClient.updateSessionContext(sk, { model_name: name })
                      setSessions((prev) =>
                        prev.map((s) =>
                          String(s.sessionKey || '') === sk ? { ...s, modelName: name } : s,
                        ),
                      )
                      setRoleUiNonce((n) => n + 1)
                    } catch {
                      /* ignore */
                    }
                    const sepText = `已切换至 ${name} 模型`
                    setRows((prev) => [
                      ...(Array.isArray(prev) ? prev : []),
                      {
                        role: 'system' as const,
                        text: sepText,
                        timestamp: Date.now(),
                      } as DisplayRow,
                    ])
                    try {
                      await gatewayApiFetch(
                        `/chat/sessions/${encodeURIComponent(sk)}/messages`,
                        {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            role: 'user',
                            content: `${MODEL_SWITCH_SEPARATOR_PREFIX}${sepText}`,
                          }),
                        },
                      )
                    } catch {
                      /* ignore */
                    }
                  })()
                }
                void toolApprovalPolicyTick
                const approvalSk = String(sessionRef.current || selectedSessionKey || '').trim()
                const approvalCtx = (approvalSk && wsClient.getSessionContext(approvalSk)) || {}
                const permissionPreset = resolvePermissionPreset(approvalCtx)
                const permissionMenu = (
                  <PermissionPresetMenu
                    open={bottomPermissionOpen}
                    onOpenChange={setBottomPermissionOpen}
                    presetId={permissionPreset}
                    rootRef={bottomPermissionRootRef}
                    onBeforeOpen={() => {
                      setModeMenuOpen(false)
                      setBottomModelOpen(false)
                      setBottomMoreOpen(false)
                      setMoreSubOpen(null)
                      setBottomWorkspaceOpen(false)
                      setBottomRoleOpen(false)
                      setBottomSkillOpen(false)
                    }}
                    onSelect={async (presetId) => {
                      try {
                        await applyMoreMenuSessionApprovalPolicy(presetId)
                      } catch (e) {
                        toast(toUserFacingError((e as Error)?.message || e), 'error')
                        throw e
                      }
                    }}
                  />
                )
                const modelMenu = (
                  <ModelCatalogMenu
                    open={bottomModelOpen}
                    onOpenChange={setBottomModelOpen}
                    catalog={modelCatalog}
                    connNameMap={modelConnNameMap}
                    selectedModel={effectiveModelName}
                    pillLabel={modelPillLabel}
                    loading={modelsLoading}
                    disabled={modelDisabled}
                    manageDismiss={false}
                    portalFixed
                    portalStack={isMobileChat}
                    rootRef={bottomModelRootRef}
                    onBeforeOpen={() => {
                      setModeMenuOpen(false)
                      setBottomPermissionOpen(false)
                      setBottomMoreOpen(false)
                      setBottomWorkspaceOpen(false)
                      setBottomRoleOpen(false)
                    }}
                    onSelect={onSelectModel}
                  />
                )
                // 手机对话：底栏放模型 + 权限
                if (isMobileChat) {
                  return (
                    <div className="react-chat-composer-bottom-controls react-chat-composer-bottom-controls--mobile">
                      <div className="react-chat-composer-bottom-row1">
                      <div className="react-chat-composer-bottom-row1-main">
                        {modelMenu}
                        {permissionMenu}
                      </div>
                      </div>
                    </div>
                  )
                }

                return (
                  <div className="react-chat-composer-bottom-controls">
                    <div className="react-chat-composer-bottom-row1">
                      <div className="react-chat-composer-bottom-row1-main">
                      {modelMenu}
                      {permissionMenu}

                      <div className="react-chat-bottom-pill-root" ref={bottomMoreRootRef}>
                        <button
                          ref={bottomMoreTriggerRef}
                          type="button"
                          className={`react-chat-bottom-pill${bottomMoreOpen ? ' react-chat-bottom-pill--open' : ''}`}
                          title="更多：附件 / 语音播报 / 记忆 / 创意"
                          onClick={() =>
                            setBottomMoreOpen((prev) => {
                              const next = !prev
                              if (next) {
                                setModeMenuOpen(false)
                                setBottomModelOpen(false)
                                setBottomPermissionOpen(false)
                                setBottomWorkspaceOpen(false)
                                setBottomRoleOpen(false)
                                setBottomSkillOpen(false)
                              } else {
                                setMoreSubOpen(null)
                              }
                              return next
                            })
                          }
                        >
                          <svg
                            className="react-chat-bottom-pill-icon"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            aria-hidden="true"
                          >
                            <circle cx="5" cy="12" r="1.5" />
                            <circle cx="12" cy="12" r="1.5" />
                            <circle cx="19" cy="12" r="1.5" />
                          </svg>
                          <span className="react-chat-bottom-pill-text">更多</span>
                          <span className="react-chat-bottom-pill-caret">▾</span>
                        </button>
                        {bottomMoreOpen && typeof document !== 'undefined'
                          ? createPortal(
                          <div
                            className="react-chat-bottom-dropdown react-chat-bottom-dropdown--more react-chat-bottom-dropdown--more-portal"
                            role="menu"
                            style={bottomMorePortalStyle || { display: 'none' }}
                          >
                            {/* ── Agent 模式 ── */}
                            <div className="react-chat-more-submenu-item">
                              <button
                                type="button"
                                className={`react-chat-more-submenu-header${moreSubOpen === 'mode' ? ' react-chat-more-submenu-header--open' : ''}`}
                                onClick={() => setMoreSubOpen((p) => (p === 'mode' ? null : 'mode'))}
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ width: 16, height: 16, flexShrink: 0 }}>
                                  <path d="M12 2l1.2 4.5L18 8l-4.8 1.5L12 14l-1.2-4.5L6 8l4.8-1.5L12 2z" />
                                  <path d="M19 14l.8 2.8L23 18l-3.2 1.2L19 22l-.8-2.8L15 18l3.2-1.2L19 14z" />
                                </svg>
                                <span className="react-chat-more-submenu-title">Agent 模式</span>
                                <span className="react-chat-more-submenu-badge">{modeLabel(sessionMode, dynamicModes || DEFAULT_SESSION_MODES)}</span>
                                <span className="react-chat-more-submenu-caret" aria-hidden>▸</span>
                              </button>
                              {moreSubOpen === 'mode' ? (
                                <div className="react-chat-more-submenu-flyout" role="menu">
                                  {(dynamicModes || DEFAULT_SESSION_MODES).filter(m => m.visible).map((m) => (
                                    <button
                                      key={m.value}
                                      type="button"
                                      role="menuitem"
                                      className={`react-chat-bottom-dropdown-item${sessionMode === m.value ? ' react-chat-bottom-dropdown-item--active' : ''}`}
                                      onClick={() => {
                                        void setSessionModeAndApply(m.value as SessionMode)
                                        setBottomMoreOpen(false)
                                        setMoreSubOpen(null)
                                      }}
                                    >
                                      <span>{m.label}</span>
                                      {sessionMode === m.value ? <span className="react-chat-skill-item-check" aria-hidden>✓</span> : null}
                                    </button>
                                  ))}
                                  {SHOW_SESSION_MODE_COLLAB_UI && collabOn ? (
                                    <>
                                    <div className="react-chat-bottom-dropdown-divider" role="separator" />
                                    <button
                                      type="button"
                                      role="menuitem"
                                      className="react-chat-bottom-pill react-chat-bottom-mode-pill"
                                      onClick={async () => {
                                        if (!selectedSessionKey) return
                                        await setCollabPhaseForSession(selectedSessionKey, 'planning')
                                        setThreadPanelState((prev) => ({ ...prev, collabPhase: 'planning' }))
                                        toast('已回到 Plan 阶段', 'success')
                                        setBottomMoreOpen(false)
                                        setMoreSubOpen(null)
                                      }}
                                    >
                                      回到 Plan
                                    </button>
                                    <button
                                      type="button"
                                      role="menuitem"
                                      className="react-chat-bottom-pill react-chat-bottom-mode-pill"
                                      onClick={async () => {
                                        if (!selectedSessionKey) return
                                        await setCollabPhaseForSession(selectedSessionKey, 'executing')
                                        setThreadPanelState((prev) => ({ ...prev, collabPhase: 'executing' }))
                                        toast('已授权执行', 'success')
                                        setBottomMoreOpen(false)
                                        setMoreSubOpen(null)
                                      }}
                                    >
                                      Authorize 执行
                                    </button>
                                    </>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>

                            {/* ── Agent/预设角色 ── */}
                            {!isProactiveEmployeeSession ? (
                              <button
                                type="button"
                                role="menuitem"
                                className="react-chat-bottom-dropdown-item"
                                disabled={roleSwitchBusy}
                                onClick={() => {
                                  setBottomMoreOpen(false)
                                  setMoreSubOpen(null)
                                  setBottomRoleOpen(true)
                                }}
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: 16, height: 16, flexShrink: 0 }}>
                                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                                  <circle cx="12" cy="7" r="4" />
                                </svg>
                                <span>{roleSwitchBusy ? '…' : currentRoleLabel}</span>
                              </button>
                            ) : null}

                            {/* ── 技能 ── */}
                            <button
                              type="button"
                              role="menuitem"
                              className="react-chat-bottom-dropdown-item"
                              onClick={() => {
                                setBottomMoreOpen(false)
                                setMoreSubOpen(null)
                                setBottomSkillOpen(true)
                              }}
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: 16, height: 16, flexShrink: 0 }}>
                                <path d="M12 2l1.2 4.5L18 8l-4.8 1.5L12 14l-1.2-4.5L6 8l4.8-1.5L12 2z" />
                                <path d="M19 14l.8 2.8L23 18l-3.2 1.2L19 22l-.8-2.8L15 18l3.2-1.2L19 14z" />
                              </svg>
                              <span>{selectedSkills.length > 0 ? `技能 ${selectedSkills.length}` : '技能'}</span>
                            </button>

                            {/* ── 目标 ── */}
                            <button
                              type="button"
                              role="menuitem"
                              className="react-chat-bottom-dropdown-item"
                              onClick={() => {
                                setBottomMoreOpen(false)
                                setMoreSubOpen(null)
                                goal.goal.setPanelOpen(true)
                              }}
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ width: 16, height: 16, flexShrink: 0 }}>
                                <path d="M12 5v14" />
                                <path d="M5 12h14" />
                              </svg>
                              <span>目标</span>
                              {goal.goal.ui.goalActive ? (
                                <span className="react-chat-more-submenu-badge">{goal.goal.goalStatusIcon}</span>
                              ) : null}
                            </button>

                            {/* ── 员工 ── */}
                            {proactiveRolesDisplay.length > 0 ? (
                              <div className="react-chat-more-submenu-item">
                                <button
                                  type="button"
                                  className={`react-chat-more-submenu-header${moreSubOpen === 'employee' ? ' react-chat-more-submenu-header--open' : ''}`}
                                  onClick={() => setMoreSubOpen((p) => (p === 'employee' ? null : 'employee'))}
                                >
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: 16, height: 16, flexShrink: 0 }}>
                                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                                    <circle cx="9" cy="7" r="4" />
                                    <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
                                  </svg>
                                  <span className="react-chat-more-submenu-title">员工</span>
                                  <span className="react-chat-more-submenu-caret" aria-hidden>▸</span>
                                </button>
                                {moreSubOpen === 'employee' ? (
                                  <div className="react-chat-more-submenu-flyout react-chat-more-submenu-flyout--scroll" role="menu">
                                    {proactiveRolesDisplay.map((r) => (
                                      <button
                                        key={r.agent_code}
                                        type="button"
                                        role="menuitem"
                                        className="react-chat-bottom-dropdown-item"
                                        onClick={() => {
                                          const name = String(r.role_name || r.agent_code || '').trim()
                                          const cur = String(composerDraftSnapshotRef.current || '').trimEnd()
                                          const token = `@${name} `
                                          insertText(cur ? `${cur}${cur.endsWith(' ') ? '' : ' '}${token}` : token)
                                          setBottomMoreOpen(false)
                                          setMoreSubOpen(null)
                                        }}
                                      >
                                        <span>{r.role_name || r.agent_code}</span>
                                        {r.department ? <span className="react-chat-more-submenu-badge">{r.department}</span> : null}
                                      </button>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                            ) : null}

                            <div className="react-chat-bottom-dropdown-divider" role="separator" />
                            <button
                              type="button"
                              role="menuitem"
                              className="react-chat-bottom-dropdown-item"
                              disabled={!selectedSessionKey}
                              onClick={() => {
                                setBottomMoreOpen(false)
                                setMoreSubOpen(null)
                                void pickDocFiles()
                              }}
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: 16, height: 16, flexShrink: 0 }}>
                                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                              </svg>
                              <span>添加附件</span>
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="react-chat-bottom-dropdown-item"
                              disabled={!selectedSessionKey || effectiveModelSupportsVision === false}
                              title={
                                effectiveModelSupportsVision === false
                                  ? '当前模型不支持图片，请切换带「视觉」标记的模型'
                                  : undefined
                              }
                              onClick={() => {
                                if (effectiveModelSupportsVision === false) return
                                setBottomMoreOpen(false)
                                setMoreSubOpen(null)
                                pickFiles()
                              }}
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ width: 16, height: 16, flexShrink: 0 }}>
                                <rect x="3" y="5" width="18" height="14" rx="2" />
                                <circle cx="8.5" cy="10" r="1.5" />
                                <path d="M21 16l-5.2-5.2a1.5 1.5 0 00-2.1 0L3 18" />
                              </svg>
                              <span>添加图片</span>
                            </button>
                            <div className="react-chat-bottom-dropdown-divider" role="separator" />
                            {speechEnabled ? (
                              <button
                                type="button"
                                role="menuitem"
                                className={`react-chat-bottom-dropdown-item${voiceReplyEnabled ? ' react-chat-bottom-dropdown-item--active' : ''}`}
                                onClick={async () => {
                                  const next = !voiceReplyEnabled
                                  setVoiceReplyEnabled(next)
                                  await patchPanelSettings(voiceReplyModeToSettingsPatch(next))
                                  if (!next) {
                                    voiceReplyPendingRef.current = false
                                    voiceStreamingStartedRef.current = false
                                    voiceSpeechSyncedPlainRef.current = ''
                                    void import('../lib/speech-client.js').then(
                                      ({ stopAllAssistantSpeech, resetStreamingSpeechQueue }) => {
                                        stopAllAssistantSpeech()
                                        resetStreamingSpeechQueue()
                                      },
                                    )
                                  }
                                  toast(next ? '已开启语音播报' : '已关闭语音播报', 'success')
                                }}
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: 16, height: 16, flexShrink: 0 }}>
                                  <path d="M11 5L6 9H2v6h4l5 4V5z" />
                                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                                </svg>
                                <span>语音播报</span>
                                <span className="react-chat-more-submenu-badge">{voiceReplyEnabled ? '开' : '关'}</span>
                                {voiceReplyEnabled ? (
                                  <span className="react-chat-skill-item-check" aria-hidden>✓</span>
                                ) : null}
                              </button>
                            ) : null}
                            {/* ── 记忆 ── */}
                            <div className="react-chat-more-submenu-item">
                              <button
                                type="button"
                                className={`react-chat-more-submenu-header${moreSubOpen === 'memory' ? ' react-chat-more-submenu-header--open' : ''}`}
                                onClick={() => setMoreSubOpen((p) => (p === 'memory' ? null : 'memory'))}
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true" style={{ width: 16, height: 16, flexShrink: 0 }}>
                                  <path d="M12 3 4 7l8 4 8-4-8-4z" />
                                  <path d="M4 12l8 4 8-4" />
                                  <path d="M4 17l8 4 8-4" />
                                </svg>
                                <span className="react-chat-more-submenu-title">记忆</span>
                                <span className="react-chat-more-submenu-badge">{memoryEnabled ? '开' : '关'}</span>
                                <span className="react-chat-more-submenu-caret" aria-hidden>▸</span>
                              </button>
                              {moreSubOpen === 'memory' ? (
                                <div className="react-chat-more-submenu-flyout" role="menu">
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className={`react-chat-bottom-dropdown-item${memoryEnabled ? ' react-chat-bottom-dropdown-item--active' : ''}`}
                                    onClick={async () => {
                                      const sk = (await ensureChatSessionKey()) || sessionRef.current || selectedSessionKey
                                      if (!sk) return
                                      const next = !memoryEnabled
                                      setMemoryEnabled(next)
                                      try {
                                        const api = await getApi()
                                        await api.chatUpdateContext(sk, { memory_enabled: next })
                                        toast(next ? '已开启记忆' : '已关闭记忆', 'success')
                                      } catch (err) {
                                        setMemoryEnabled(!next)
                                        toast(toUserFacingError((err as Error)?.message || err), 'error')
                                      }
                                    }}
                                  >
                                    <span>记忆: {memoryEnabled ? '开' : '关'}</span>
                                    {memoryEnabled ? <span className="react-chat-skill-item-check" aria-hidden>✓</span> : null}
                                  </button>
                                </div>
                              ) : null}
                            </div>

                            {/* ── 创意 ── */}
                            <div className="react-chat-more-submenu-item">
                              <button
                                type="button"
                                className={`react-chat-more-submenu-header${moreSubOpen === 'creative' ? ' react-chat-more-submenu-header--open' : ''}`}
                                onClick={() => setMoreSubOpen((p) => (p === 'creative' ? null : 'creative'))}
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ width: 16, height: 16, flexShrink: 0 }}>
                                  <path d="M12 2l1.2 4.5L18 8l-4.8 1.5L12 14l-1.2-4.5L6 8l4.8-1.5L12 2z" />
                                  <path d="M19 14l.8 2.8L23 18l-3.2 1.2L19 22l-.8-2.8L15 18l3.2-1.2L19 14z" />
                                </svg>
                                <span className="react-chat-more-submenu-title">创意</span>
                                <span className="react-chat-more-submenu-caret" aria-hidden>▸</span>
                              </button>
                              {moreSubOpen === 'creative' ? (
                                <div className="react-chat-more-submenu-flyout react-chat-more-submenu-flyout--scroll" role="menu">
                                  {QUICK_PROMPTS.map((p) => (
                                    <button
                                      key={p.label}
                                      type="button"
                                      role="menuitem"
                                      className="react-chat-bottom-dropdown-item"
                                      onClick={() => {
                                        setBottomMoreOpen(false)
                                        setMoreSubOpen(null)
                                        insertText(p.prompt)
                                      }}
                                    >
                                      {p.label}
                                    </button>
                                  ))}
                                </div>
                              ) : null}
                            </div>

                            {/* ── 思考等级（仅当前模型支持思考时展示） ── */}
                            {effectiveModelSupportsThinking ? (
                              <div className="react-chat-more-submenu-item">
                                <button
                                  type="button"
                                  className={`react-chat-more-submenu-header${moreSubOpen === 'thinking' ? ' react-chat-more-submenu-header--open' : ''}`}
                                  onClick={() => setMoreSubOpen((p) => (p === 'thinking' ? null : 'thinking'))}
                                >
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: 16, height: 16, flexShrink: 0 }}>
                                    <path d="M9 18h6" />
                                    <path d="M10 22h4" />
                                    <path d="M12 2a7 7 0 0 0-4 12.7c.5.4.8 1 .9 1.6h6.2c.1-.6.4-1.2.9-1.6A7 7 0 0 0 12 2z" />
                                  </svg>
                                  <span className="react-chat-more-submenu-title">思考</span>
                                  <span className="react-chat-more-submenu-badge">{thinkingLevel === 'auto' ? '自动' : thinkingLevel === 'off' ? '关闭' : thinkingLevel === 'low' ? '轻度' : thinkingLevel === 'medium' ? '中度' : '深度'}</span>
                                  <span className="react-chat-more-submenu-caret" aria-hidden>▸</span>
                                </button>
                                {moreSubOpen === 'thinking' ? (
                                  <div className="react-chat-more-submenu-flyout" role="menu">
                                    {THINKING_LEVEL_OPTIONS.map((opt) => (
                                      <button
                                        key={opt.value}
                                        type="button"
                                        role="menuitem"
                                        className={`react-chat-bottom-dropdown-item${thinkingLevel === opt.value ? ' react-chat-bottom-dropdown-item--active' : ''}`}
                                        onClick={async () => {
                                          try {
                                            await applyThinkingLevel(selectedSessionKey || '', opt.value)
                                          } catch (e) {
                                            toast(toUserFacingError((e as Error)?.message || e), 'error')
                                          }
                                          setMoreSubOpen(null)
                                        }}
                                      >
                                        <span>{opt.label}</span>
                                        {thinkingLevel === opt.value ? <span className="react-chat-skill-item-check" aria-hidden>✓</span> : null}
                                      </button>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                            ) : null}
                          </div>,
                              document.body,
                            )
                          : null}
                      </div>

                      </div>

                      <div className="react-chat-composer-bottom-row1-workspace">
                        <div
                          className="react-chat-bottom-pill-root"
                          ref={bottomWorkspaceRootRef}
                        >
                          <HoverBubble
                            text={
                              useVirtualPaths
                                ? '虚拟沙箱路径（无本地目录绑定）'
                                : localWorkspaceRoot
                                  ? `工作空间：${localWorkspaceRoot}\n点击切换 / 选择项目文件夹`
                                  : runtimeDataDir
                                    ? `默认工作空间（未绑定项目目录）\n产出写入：${runtimeDataDir}\n点击选择项目文件夹`
                                    : '默认工作空间 · 点击选择项目文件夹'
                            }
                            side="top"
                            align="end"
                            maxWidth={480}
                          >
                            <button
                              type="button"
                              className={`react-chat-bottom-pill react-chat-bottom-pill--workspace${
                                useVirtualPaths ? ' react-chat-bottom-pill--workspace-virtual' : ''
                              }${localWorkspaceRoot ? ' react-chat-bottom-pill--workspace-bound' : ''}${
                                bottomWorkspaceOpen ? ' react-chat-bottom-pill--open' : ''
                              }`}
                              aria-label="切换工作空间"
                              aria-haspopup="menu"
                              aria-expanded={bottomWorkspaceOpen}
                              onClick={() => {
                                setBottomWorkspaceOpen((prev) => {
                                  const next = !prev
                                  if (next) {
                                    setModeMenuOpen(false)
                                    setBottomModelOpen(false)
                                    setBottomPermissionOpen(false)
                                    setBottomMoreOpen(false)
                                    setBottomRoleOpen(false)
                                    setBottomSkillOpen(false)
                                  }
                                  return next
                                })
                              }}
                            >
                              <svg
                                className="react-chat-bottom-pill-icon"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                aria-hidden="true"
                              >
                                <path d="M3 7h18" />
                                <path d="M6 3h12l2 4v14H4V7l2-4z" />
                              </svg>
                              <span className="react-chat-bottom-pill-text">
                                {useVirtualPaths
                                  ? '虚拟'
                                  : localWorkspaceRoot
                                    ? _pathBasename(localWorkspaceRoot)
                                    : '默认'}
                              </span>
                              <span className="react-chat-bottom-pill-caret">▾</span>
                            </button>
                          </HoverBubble>
                          {bottomWorkspaceOpen ? (
                            <div
                              className="react-chat-bottom-dropdown react-chat-bottom-dropdown--workspace"
                              role="menu"
                            >
                              <button
                                type="button"
                                className="react-chat-bottom-dropdown-item"
                                role="menuitem"
                                onClick={() => {
                                  void pickAndBindCurrentWorkspace()
                                }}
                              >
                                <span className="react-chat-bottom-dropdown-item-label">
                                  选择项目文件夹…
                                </span>
                              </button>
                              <button
                                type="button"
                                className="react-chat-bottom-dropdown-item"
                                role="menuitem"
                                onClick={() => {
                                  void pickAndStartNewSessionWithWorkspace()
                                }}
                              >
                                <span className="react-chat-bottom-dropdown-item-label">
                                  新建对话并选文件夹…
                                </span>
                              </button>
                              <button
                                type="button"
                                className="react-chat-bottom-dropdown-item"
                                role="menuitem"
                                onClick={() => {
                                  void openCurrentWorkspaceInFileManager()
                                }}
                              >
                                <span className="react-chat-bottom-dropdown-item-label">
                                  {localWorkspaceRoot ? '打开当前文件夹' : '打开默认数据目录'}
                                </span>
                              </button>
                              {localWorkspaceRoot ? (
                                <button
                                  type="button"
                                  className="react-chat-bottom-dropdown-item"
                                  role="menuitem"
                                  onClick={() => {
                                    void clearCurrentSessionWorkspace()
                                  }}
                                >
                                  <span className="react-chat-bottom-dropdown-item-label">
                                    切回默认（解绑项目目录）
                                  </span>
                                </button>
                              ) : null}
                              {globalWorkspaceHistory.length > 0 ? (
                                <>
                                  <div className="react-chat-bottom-dropdown-divider" />
                                  <div className="react-chat-bottom-dropdown-section-label">
                                    最近工作空间
                                  </div>
                                  {globalWorkspaceHistory.map((p) => {
                                    const path = String(p || '').trim()
                                    if (!path) return null
                                    const active =
                                      normalizeWorkspacePathKey(path) ===
                                      normalizeWorkspacePathKey(localWorkspaceRoot || '')
                                    return (
                                      <button
                                        key={path}
                                        type="button"
                                        role="menuitem"
                                        title={path}
                                        className={`react-chat-bottom-dropdown-item${
                                          active ? ' react-chat-bottom-dropdown-item--active' : ''
                                        }`}
                                        onClick={() => {
                                          void bindCurrentSessionToWorkspace(path)
                                        }}
                                      >
                                        <span className="react-chat-bottom-dropdown-item-label">
                                          {_pathBasename(path)}
                                        </span>
                                      </button>
                                    )
                                  })}
                                </>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>

                    {/* creative dropdown 常驻在 row1，避免占用 row2 */}
                  </div>
                )
            }}
              placeholder={
                isMobileChat
                  ? '输入消息…'
                  : SHOW_SESSION_MODE_COLLAB_UI && collabOn
                    ? '描述多步骤目标；将先对齐需求再规划…'
                    : '输入消息，@ 提及员工，# 引用文件'
              }
            />
              </div>
            </div>
          </div>
            </div>
            {anyRightPanelOpen && layoutResizeEnabled ? (
              <PanelResizeHandle
                direction="vertical"
                label="拖动调整右侧面板宽度"
                dragging={rightPanelResizeDragging}
                onPointerDown={onRightPanelResizePointerDown}
              />
            ) : null}
            {rightStageOpen ? (
              <RightStageShell
                surface={rightStageSurface}
                booting={!sidePanelHeavyMount && !!rightStageSurface}
                bootTitle={rightStageSurface?.title}
                onClose={closeRightStage}
                renderLegacy={renderRightStageLegacy}
              />
            ) : infoRailOpen && !isHomeSurface && selectedSessionKey && !isMobileChat ? (
              <ChatWorkspaceInfoRail
                tab={infoRailTab}
                isEmployeeSession={isProactiveEmployeeSession}
                sessionTitle={getDisplayLabel(
                  selectedSessionKey,
                  sessions.find((s) => String(s.sessionKey || '') === String(selectedSessionKey || ''))?.title,
                )}
                isRunning={selectedTurnBusy}
                contextUsage={displayContextUsage}
                tokenTotals={headerTokenTotals}
                agentLabel={currentRoleLabel}
                modelLabel={modelPillLabel}
                agentCode={
                  isProactiveEmployeeSession
                    ? employeeSessionAgentCode || currentRoleCodeForUi
                    : currentRoleCodeForUi
                }
                agentDescription={String(currentRoleAgent?.description || '').trim()}
                agent={currentRoleAgent}
                skillCount={currentAgentCapabilities.skillCount}
                toolCount={currentAgentCapabilities.toolCount}
                skillNames={currentAgentCapabilities.skillNames}
                toolNames={currentAgentCapabilities.toolNames}
                mcpServers={currentAgentCapabilities.mcpServers}
                knowledgeVaultIds={
                  isProactiveEmployeeSession
                    ? employeeRoleDetail?.knowledgeVaultIds || []
                    : currentAgentCapabilities.knowledgeVaultIds
                }
                onPatchCapabilities={patchCurrentAgentCapabilities}
                capabilityBusy={capabilityPatchBusy}
                modelName={effectiveModelName}
                artifacts={sessionArtifacts}
                recentArtifacts={turnArtifacts}
                artifactFocusId={artifactFocusId}
                platformEntries={sessionPlatformEntries}
                recentPlatformEntries={turnPlatformEntries}
                platformFocusEntryId={platformFocusEntryId}
                onOpenArtifact={openSessionArtifact}
                onRevealArtifact={revealSessionArtifact}
                onTabChange={setInfoRailTab}
                onSwitchAgent={() => setBottomRoleOpen(true)}
                onEditAgent={currentRoleCodeForUi || employeeSessionAgentCode ? openCurrentAgentEditor : undefined}
                onManualCompact={handleManualContextCompact}
                manualCompactDisabled={manualContextCompacting}
                onClose={() => setInfoRailOpen(false)}
                onAssetQuickAction={handleAssetQuickAction}
                assetQuickBusy={assetQuickBusy}
                employeeInfo={isProactiveEmployeeSession ? employeeRoleDetail : null}
                sessionKey={String(selectedSessionKey || '')}
                liveTask={
                  isProactiveEmployeeSession
                    ? sidebarActiveView?.task || null
                    : null
                }
                obsEnabled={obsEnabled}
                threadId={selectedThreadId}
              />
            ) : null}
          </div>
        </div>
      </div>
      {filePreviewModal ? (
        <WorkspaceFilePreviewModal
          workspaceRoot={effectiveWorkspaceRoot}
          threadId={
            effectiveWorkspaceRoot
              ? undefined
              : wsClient.getSessionThreadId(selectedSessionKey || '') || undefined
          }
          workspaceScopeOpts={{
            configuredRoot: configuredWorkspaceRoot,
            useVirtualPaths,
          }}
          path={filePreviewModal.path}
          name={filePreviewModal.name}
          poll={filePreviewModal.poll}
          onClose={() => {
            setChatOverlayDefer('file-preview', false)
            setFilePreviewModal(null)
            if (!isChatOverlayDeferActive()) {
              scheduleBumpRef.current?.({ immediate: true })
            }
          }}
        />
      ) : null}
      <ShellSessionListHost
        filteredSessions={filteredSessions}
        sessions={sessions}
        workspaceSummaries={workspaceSummaries}
        workspacePagination={workspacePagination}
        listLoading={listLoading}
        sessionFilter={sessionFilter}
        moreMenuKey={moreMenuKey}
        selectedSessionKey={selectedSessionKey}
        newChatButtonActive={newChatButtonActive}
        sessionNamesTick={sessionNamesTick}
        agents={agents}
        runningSessionMap={runningSessionMap}
        resolveLiveStreamActivityForSession={resolveLiveStreamActivityForSession}
        setSessionFilter={setSessionFilter}
        setMoreMenuKey={setMoreMenuKey}
        onSelectSession={selectSessionFromShell}
        onPrefetchSession={prefetchSessionHistoryFromShell}
        onPinSession={onShellPinSession}
        onDeleteSession={onShellDeleteSession}
        onForkSession={onShellForkSession}
        onRefreshSession={onShellRefreshSession}
        onRefreshSessionList={onShellRefreshSessionList}
        onStopSession={onShellStopSession}
        loadMoreWorkspaceSessions={loadMoreWorkspaceSessions}
        loadMoreGlobalRecentSessions={loadMoreGlobalRecentSessions}
        ensureWorkspaceExpanded={ensureWorkspaceExpanded}
        employeeRoles={proactiveRoles}
        registeredWorkspacePaths={globalWorkspaceHistory}
        onNewWorkspace={onShellNewWorkspace}
        onNewSessionInWorkspace={onShellNewSessionInWorkspace}
        onDeleteWorkspace={handleDeleteWorkspaceGroup}
        onWorkspaceFocus={onShellWorkspaceFocus}
        onOpenWorkspaceFolder={handleOpenWorkspaceFolder}
      />

    </div>
    </HoverBubbleProvider>
  )
}

/**
 * HMR 自我保护：ChatApp.tsx 体量巨大（>15k 行）且内部有大量 useCallback/闭包，
 * Vite react-refresh 部分热替换时旧闭包可能引用正在重新初始化的顶层 const（TDZ），
 * 导致一次性 `Cannot access 'xxx' before initialization` 崩溃白屏（见 frontend 日志 23:49:44）。
 * 显式 accept 整模块：热更新时整体重渲染，避免部分热替换的闭包残留。
 */
if (import.meta.hot) {
  import.meta.hot.accept()
}