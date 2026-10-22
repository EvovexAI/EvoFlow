import type {
  CSSProperties,
  Dispatch,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
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
import { ChevronDown, Folder, FolderOpen, Globe, PanelRightClose, PanelRightOpen, Share } from 'lucide-react'
import {
  wsClient,
  restorePendingInjects,
  subscribeCollabThreadWs,
  dispatchCollabCustomEvent,
  collabSnapshotFromTaskRow,
  evoflowInvokeGatewayJson,
  evoflowFetch,
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
  assistantBodiesLooselySame,
  pickDisplayChatSceneFromScenarioResult,
  isGoalProposalToolName,
  isTaskNotificationInject,
} from '../lib/chat-normalize.js'
import {
  DEFAULT_SESSION_MODES,
  SHOW_SESSION_MODE_COLLAB_UI,
  modeLabel,
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
import { defaultModelFromCatalog } from './lib/model-catalog.js'
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
  purgeStaleSessionNamesCharsetCacheOnce,
} from './lib/session-list/display.js'
import {
  patchSessionPinInRows,
  patchSessionTitleInRows,
  prependNewSessionToList,
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
} from './lib/session-list/workspace-groups.js'
import { useCollabSubtasksFromApi } from './hooks/useCollabSubtasksFromApi.js'
import { skTail, ssLog } from '../lib/session-list-debug.js'
import { ChatMessageStreamPane } from './components/ChatMessageStreamPane.js'
import { HistoryFetchSpinner } from './components/HistoryFetchSpinner.js'
import { ChatComposer, type WorkspaceMentionConfig, type MentionEmployeeOption } from './components/ChatComposer.js'
import { PendingSteersStrip } from './components/PendingSteersStrip.js'
import { mergeInterruptedComposerDraft } from './lib/merge-interrupted-composer-draft.js'
import { ContextUsageRing } from './components/ContextUsageRing.js'
import { basenameFromPath } from './lib/workspace-mention.js'
import { GoalModePanel } from './components/GoalModePanel.js'
import { GoalProposalDock } from './components/GoalProposalDock.js'
import { SkillPickerModal, type SkillSelection } from './components/SkillPickerModal.js'
import { PluginQuickPanel } from './components/PluginQuickPanel.js'
import type { PluginSelection } from './components/PluginPickerModal.js'

import { PluginPillIcon } from './components/PluginPillIcon.js'
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
  getCachedGlobalToolApprovalPolicy,
  isEffectiveToolApprovalGrantAll,
  // @ts-ignore
  isEffectiveToolApprovalSession,
  isToolApprovalDisabled,
  patchGlobalToolApprovalPolicy,
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
  PERMISSION_PRESETS,
  PERMISSION_PRESET_FULL_ACCESS,
  resolvePermissionPreset,
  permissionPresetToast,
} from '../lib/permission-tier.js'
import { TOOL_APPROVAL_REQUEST_SESSION_FULL_ACCESS } from './components/ToolApprovalPanel.js'
import {
  logToolApprovalPendingDetected,
  logToolApprovalStreamFinal,
  logToolApprovalUserAction,
} from '../lib/tool-approval-trace.js'
import { CollabExecutionPanel } from './components/CollabExecutionPanel.js'
import {
  RightStagePanel,
  buildDefaultRightStageLauncherItems,
} from './components/RightStagePanel.js'
import { switchRightStageSession } from '../lib/right-stage/right-stage-session-memory.js'
import { KnowledgeMapPanel } from './components/KnowledgeMapPanel.js'
import { ChatSummaryPanel } from './components/ChatSummaryPanel.js'
import {
  EmployeePane,
  TaskPane,
  type InfoRailTab,
  type EmployeeRailInfo,
} from './components/ChatWorkspaceInfoRail.js'
import { useLiveProcessSnapshot } from './lib/use-live-process-snapshot.js'
import {
  loadChatSummaryPrefs,
  saveChatSummaryDisplayMode,
  type ChatSummaryDisplayMode,
} from './lib/chat-summary-panel-prefs.js'
import type { ProcessItem } from './lib/chat-summary-panel-model.js'
import { SidePanelBootShell } from './components/SidePanelBootShell.js'
import { applyRightStageAgUiCustom, applyStageSetFromToolCall, STAGE_SET_APPLIED_EVENT, type StageSetPayload } from '../lib/right-stage/right-stage-agui.js'
import { syncBrowserPanelFromAgUiEvent, isBrowserToolWireName } from '../lib/browser-panel-agui.js'
import {
  applyBrowserCommandResponse,
  closeBrowserStage,
  ensureBrowserStage,
  NODE_REPL_BRIDGE_THREAD_ID,
  resetBrowserStageSwitchTracking,
  setBrowserPanelThreadId,
} from '../lib/browser-panel-store.js'
import { dbgLog } from '../lib/browser-debug-log.js'
import { hideRightStageIfKind, rightStageStore } from '../lib/right-stage/right-stage-store.js'
import { closeSummaryStage } from '../lib/right-stage/ensure-summary-stage.js'
import { ensureTerminalStage } from '../lib/right-stage/ensure-terminal-stage.js'
import { filterRightStageTabsForSession } from '../lib/right-stage/right-stage-session-visibility.js'
import { isAutoWorkPreviewEnabled } from '../lib/right-stage/write-stream-mode.js'
import { applyDecideRightStage } from '../lib/right-stage/apply-decide-right-stage.js'
import { syncEmployeesRosterFromToolResult } from '../lib/employees-roster-sync.js'
import { applyPlatformFeedbackFromToolResult, latestPlatformRunEntryId, openPlatformFeedbackFromTool, platformRunEntriesFromChatArtifacts, type PlatformRunEntry } from '../lib/right-stage/platform-feedback.js'
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
import { SessionSidebar, type SubtaskTranscriptModalPayload } from './components/SessionSidebar.js'
import { WorkspaceFileTree, type ContextFileEntry } from './components/WorkspaceFileTree.js'
import { MemoryRecallChip } from './components/MemoryRecallChip.js'
import { WorkspaceFilePreviewPanel } from './components/WorkspaceFilePreviewPanel.js'
import { TerminalStagePanel } from './components/TerminalStagePanel.js'
import { ImagePreviewModal, type ImagePreviewItem } from './components/ImagePreviewModal.js'
import { isImagePathLike, resolveChatImageSrc } from '../lib/chat-image-src.js'
import {
  detectStreamingWritePreview,
  isActiveWriteTool,
  isStreamAutoPreviewPath,
  shouldSuppressStreamDeliveredFiles,
  workspacePreviewTargetFromUrl,
} from '../lib/workspace-preview-path.js'
import { TauriWindowControls } from './components/TauriWindowControls.js'
import { toast } from '../components/toast.js'
import { toUserFacingError } from '../lib/user-facing-error.js'
import {
  ServiceHealthState,
  startServiceHealthPoll,
  stopServiceHealthPoll,
  onServiceHealthChange,
  triggerServiceHealthCheck,
} from '../lib/service-health.js'
import { isDebugOn } from '../lib/debug-flag.js'
import { t as i18nT } from '../lib/i18n.js'
import { notifyDesktopCompletion } from '../lib/desktop-notification.js'
import {
  registerVoiceSendHandler,
  unregisterVoiceSendHandler,
} from '../lib/background-voice-bridge.js'
import { setVoiceTrayState } from '../lib/background-voice.js'
import { normalizeStreamActivityDetail, formatActivityDetailFromRunningToolCalls, resolveAssignedAgentDisplayName } from '../lib/tool-display.js'
import {
  resolveComposerDockActivity,
  type ResolvedLiveStreamActivity,
} from './lib/resolve-live-stream-activity.js'
import {
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
import { useClarificationPanel } from './hooks/useClarificationPanel.js'
import { useComposerDrafts } from './hooks/useComposerDrafts.js'
import { usePendingSendQueue } from './hooks/usePendingSendQueue.js'
import { useChatContextFiles } from './hooks/useChatContextFiles.js'
import { useStreamingWritePreview } from './hooks/useStreamingWritePreview.js'
import { useWorkspaceFileOpen } from './hooks/useWorkspaceFileOpen.js'
import { useComposerSkillPluginSelection } from './hooks/useComposerSkillPluginSelection.js'
import { useChatLayoutResize } from './hooks/useChatLayoutResize.js'
import { useComposerModelCatalog } from './hooks/useComposerModelCatalog.js'
import { useSessionWorkspaceBind } from './hooks/useSessionWorkspaceBind.js'
import { useProactiveRoles } from './hooks/useProactiveRoles.js'
import { useContextUsageBySession } from './hooks/useContextUsageBySession.js'
import { useSessionModeControls } from './hooks/useSessionModeControls.js'
import { useCollabSidebarSync } from './hooks/useCollabSidebarSync.js'
import { normalizeFileHrefForThread, normalizeRowFilesInPlace } from './chat-app/utils/file-href-normalize.js'
import {
  formatAskClarificationForHosted,
  isClarificationPreviewRenderable,
  isUserExecutionStartIntent,
} from './lib/clarify-chat-display.js'
import {
  findAskClarificationAwaitingUserInRows,
  isAskClarificationToolPending,
} from '../lib/clarify-preview-resolve.js'
import {
  clearClarificationLatch,
  peekClarificationLatch,
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
import {
  buildCollabSidebarFromTools,
  collectAssistantToolArraysFromRows,
  extractLastPlanToolSuccessFromArrays,
  findLastSuccessfulPlanToolCallId,
  isPendingSubtaskKey,
  mergeAssistantToolsFromRows,
  pruneSupersededPendingSubtasks,
} from '../lib/collab-sidebar-from-tools.js'
import {
  computePlanExecStripUi,
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
import { pickRicherStructuredPlanInput } from '../lib/plan-from-task.js'
import { tracePlanPipeline, resetPlanTrace } from '../lib/plan-trace.js'
import type { StructuredPlanInput } from './components/PlanDetailView.js'
import type {
  PlanPanelHit,
  PlanDockApiView,
  PlanStreamLatch,
} from './chat-app/plan-dock/types.js'
import {
  syncPlanPanelFromApi as syncPlanPanelFromApiImpl,
  type SyncPlanPanelFromApiOpts,
} from './chat-app/plan-dock/sync-plan-panel-from-api.js'
import { syncPlanPanelImmediateFromTools as syncPlanPanelImmediateFromToolsImpl } from './chat-app/plan-dock/sync-plan-panel-immediate.js'
import { collectPlanToolsForDetection as collectPlanToolsForDetectionImpl } from './chat-app/plan-dock/collect-plan-tools.js'
import { reconcileLastAssistantFromDb as reconcileLastAssistantFromDbImpl } from './chat-app/utils/reconcile-last-assistant-from-db.js'
import { openUiExtensionInStage as openUiExtensionInStageImpl } from './chat-app/right-stage/open-ui-extension-in-stage.js'
import { handleDispatchEmployee as handleDispatchEmployeeImpl } from './chat-app/dispatch/handle-dispatch-employee.js'
import { syncRemoteStageSet as syncRemoteStageSetImpl } from './chat-app/right-stage/sync-remote-stage-set.js'
import { handleEnhancePrompt as handleEnhancePromptImpl } from './chat-app/composer/handle-enhance-prompt.js'
import { handleManualContextCompact as handleManualContextCompactImpl } from './chat-app/context/handle-manual-context-compact.js'
import { closeRightStage as closeRightStageImpl } from './chat-app/right-stage/close-right-stage.js'
import { closeRightStageTabByKey as closeRightStageTabByKeyImpl } from './chat-app/right-stage/close-right-stage-tab.js'
import { forkSessionByKey as forkSessionByKeyImpl } from './chat-app/session/fork-session.js'
import { resolveLangGraphThreadIdForSession as resolveLangGraphThreadIdForSessionImpl } from './chat-app/session/resolve-langgraph-thread-id.js'
import { openStageExtension as openStageExtensionImpl } from './chat-app/right-stage/open-stage-extension.js'
import { toggleWorkspacePanel as toggleWorkspacePanelImpl } from './chat-app/right-stage/toggle-workspace-panel.js'
import {
  collapseRightStageShell as collapseRightStageShellImpl,
  expandRightStageShell as expandRightStageShellImpl,
} from './chat-app/right-stage/collapse-expand-right-stage.js'
import { mapAgentPickerRows } from './chat-app/agents/map-agent-picker-rows.js'
import { closeWorkspacePanel as closeWorkspacePanelImpl } from './chat-app/right-stage/close-workspace-panel.js'
import {
  openCollabExecPanel as openCollabExecPanelImpl,
  closeCollabExecPanel as closeCollabExecPanelImpl,
} from './chat-app/right-stage/collab-exec-panel.js'
import {
  openKnowledgeMapPanel as openKnowledgeMapPanelImpl,
  closeKnowledgeMapPanel as closeKnowledgeMapPanelImpl,
} from './chat-app/right-stage/knowledge-map-panel.js'
import { handleAssetQuickAction as handleAssetQuickActionImpl } from './chat-app/assets/handle-asset-quick-action.js'
import { mergeHeaderTokenTotals } from './chat-app/context/merge-header-token-totals.js'
import { resolveDisplayContextUsage } from './chat-app/context/resolve-display-context-usage.js'
import { syncShellAsideForWorkspacePanel as syncShellAsideForWorkspacePanelImpl } from './chat-app/shell/sync-shell-aside-for-workspace.js'
import { patchCurrentAgentCapabilities as patchCurrentAgentCapabilitiesImpl } from './chat-app/agents/patch-current-agent-capabilities.js'
import { openCurrentAgentEditor as openCurrentAgentEditorImpl } from './chat-app/agents/open-current-agent-editor.js'
import { handleStopProcessItem as handleStopProcessItemImpl } from './chat-app/process/handle-stop-process-item.js'
import { handleOpenProcessItem as handleOpenProcessItemImpl } from './chat-app/process/handle-open-process-item.js'
import { refreshPlanDockAfterStreamFinal as refreshPlanDockAfterStreamFinalImpl } from './chat-app/plan-dock/refresh-plan-dock-after-stream-final.js'
import { sessionPersistedTokenTotals as buildSessionPersistedTokenTotals } from './chat-app/context/session-persisted-token-totals.js'
import { collectCollabToolsForSidebar as collectCollabToolsForSidebarImpl } from './chat-app/collab/collect-collab-tools-for-sidebar.js'
import { handleDeleteWorkspaceGroup as handleDeleteWorkspaceGroupImpl } from './chat-app/session/handle-delete-workspace-group.js'
import { handleDeleteSession as handleDeleteSessionImpl } from './chat-app/session/handle-delete-session.js'
import { authorizeExecutionInBackground as authorizeExecutionInBackgroundImpl } from './chat-app/plan-dock/authorize-execution-in-background.js'
import { runUserExecutionStart as runUserExecutionStartImpl } from './chat-app/plan-dock/run-user-execution-start.js'
import { runShellSessionRefresh as runShellSessionRefreshImpl } from './chat-app/session/run-shell-session-refresh.js'
import { applyPlanToolSuccess as applyPlanToolSuccessImpl } from './chat-app/plan-dock/apply-plan-tool-success.js'
import { toggleBrowserStage as toggleBrowserStageImpl } from './chat-app/right-stage/toggle-browser-stage.js'
import {
  onShellPinSession as onShellPinSessionImpl,
  onShellRefreshSession as onShellRefreshSessionImpl,
  onShellRefreshSessionList as onShellRefreshSessionListImpl,
  onShellStopSession as onShellStopSessionImpl,
} from './chat-app/shell/shell-session-actions.js'
import { selectSessionFromShell as selectSessionFromShellImpl } from './chat-app/shell/select-session-from-shell.js'
import { handleEditMessage as handleEditMessageImpl } from './chat-app/composer/handle-edit-message.js'
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
import { mergeBackgroundWorkEvent } from './lib/background-work-merge.js'
import {
  fetchBackgroundBashOutput,
  listBackgroundBashWorks,
  stopBackgroundBashWork,
} from './lib/background-bash-api.js'
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
  filterStaleToolEntries,
  mergeCompactedPartsIntoTurn,
  staleToolIdsExcludingTurnTools,
  type StreamTurnEvent,
} from './lib/stream-turn-engine.js'
import { parseStreamBlockWire, enforceSegmentDisplayOrder, type StreamBlockWire } from './lib/content-blocks.js'
import { createStreamBumpScheduler } from './lib/stream-bump-scheduler.js'
import { resolveStreamBumpMinIntervalMs, STREAM_BUMP_INTERVAL_MS, STREAM_REASONING_BUMP_INTERVAL_MS } from './lib/stream-bump-interval.js'
import { streamPerfNoteBumpThrottle } from './lib/stream-perf-trace.js'
import { isStreamThrottleEnabled } from './lib/stream-throttle-toggle.js'
import { isAgUiLiveTextEvent, isStreamTurnLiveTextEvent } from './lib/agui-live-routes.js'
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
  markSessionKnownEmpty,
  rowsAlreadyStopSealedForTurn,
  rowsBaseForSend,
  clearSessionRuntime,
  pruneSessionRuntimes,
  DEGRADED_SNAPSHOT_SYSTEM_TEXT,
  seenRunIdSet,
  EMPTY_PRIOR_TURN_STRIP as EMPTY_RT_PRIOR_STRIP,
  reviveTurnBusyIfLivePostOpen,
  reviveAllTurnBusyIfLivePostOpen,
  markSessionStreamWireSource,
  isLivePostStreamOpen,
  type SessionRuntime,
} from './lib/session-runtime-store.js'
import { commitStreamSnapshot, pruneStreamSnapshots } from './lib/stream-snapshot-store.js'
import { rowHasVisibleContent } from './lib/display-row-content.js'
import {
  syncStreamMediaAssetsFromTools,
  applyStreamTurnEvent,
  applyAgUiWireEvent,
  stripMidTurnPartialAssistantRows,
  releaseStreamBufferIfNeeded,
  buildPartialStreamAssistantRow,
  sealStoppedStreamTurn,
  filterStreamToolEntriesForRuntime,
  priorStripForRuntime,
  buildVoiceSpeechBodyForRuntime,
} from './lib/chat-stream-apply.js'
import {
  assistantPlainForTurnStrip,
  commitPriorTurnStripFromStreamTurn,
  EMPTY_PRIOR_TURN_STRIP,
  findAssistantRowAfterLastUser,
  findAssistantRowBeforeTrailingUser,
  filterStaleToolTimelineSegments,
  mergePriorTurnStripBundles,
  priorTurnStripBundleWithStream,
  seedSeenArtifactPathsFromRows,
  stripPriorTurnReasoningFromStream,
  fixReasoningStreamText,
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
import {
  installStreamStopPageUnloadHook,
  logStreamStop,
  resetStreamStopLogDedupe,
} from './lib/stream-stop-log.js'
import {
  shouldManualRefreshResumeStream,
  shouldSuppressAutoReattach,
} from './lib/stream-resume-gate.js'
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
} from './lib/reconcile-last-assistant-from-history.js'
import { buildStreamDisplayRow } from './lib/build-stream-display-row.js'
import { logStreamCompareAgUiDrain } from './lib/stream-compare-file-log.js'
import { resolveUserMessageSkillDisplay } from './lib/preferred-skill-display.js'
import { mergeStreamSnapIntoAssistantRow, mergeAssistantRowWithStreamRow } from './lib/merge-assistant-stream-row.js'
import {
  collapseSameTurnAssistantsInRows,
  shouldMergeFinalIntoPriorAssistant,
} from './lib/collapse-same-turn-assistants.js'

// v3.5 阶段 F2 commit 1: module 顶层 helper 抽到 ./chat-app/utils/
import {
  STORAGE_MODEL_KEY,
  LS_LAST_SELECTED_SESSION,
  THINKING_LEVEL_OPTIONS,
  type ThinkingLevel,
} from './chat-app/utils/storage.js'
import {
  turnBusyForSession,
  coalesceCreateSession,
  getGlobalCreateSessionInflight,
} from './chat-app/utils/session-busy.js'
import {
  flattenLiveSnapshotText,
  buildLiveRunSnapshotPayload,
  blockWireFromChatPayload,
} from './chat-app/utils/stream-snapshot.js'
import {
  segmentTimelineHasTextBody,
  segmentTimelineHasPostToolText,
  segmentTimelineHasInterleavedTools,
  sortSegmentsBySeqIfPresent,
  dedupSegmentsById,
  mergeAuthoritativeDisplaySegments,
  authoritativeFinalFromPayload,
} from './chat-app/utils/segments.js'

// v3.5 阶段 F2 / P0: 其余 module 顶层 helper → ./chat-app/**
import {
  debugSubtaskTooltipEnabled,
  debugSubtaskFlowEnabled,
  debugAssistantDedupEnabled,
  shortLogText,
} from './chat-app/utils/debug-flags.js'
import {
  _pathBasename,
  isDesktopTauriRuntime,
  TAURI_HEADER_CELL_DRAG_PROPS,
  THREAD_STATE_EXPIRY_MS,
  QUICK_PROMPTS,
} from './chat-app/utils/desktop-workspace.js'
import {
  resolveSessionAgentCodeForUi,
  getSessionCollabModeFromMeta,
  getThinkingLevelFromMeta,
} from './chat-app/utils/session-meta.js'
import {
  comparableAssistantText,
  shouldReplaceFinalAssistantRow,
  findFirstAssistantAfterRealUser,
  collapseToolApprovalContinuationRows,
  recentTranscriptForPromptEnhance,
} from './chat-app/utils/transcript-rows.js'
import {
  emptyThreadPanel,
  clearThreadPanelActivity,
  applyThreadStatePanelPatch,
} from './chat-app/thread-panel/state.js'
import {
  parseClarificationFromTool,
  extractLatestClarificationFromRows,
  rowsAwaitUserReplyAfterSend,
  mergeThreadPanelClarification,
  clearThreadPanelClarification,
  shouldSuppressClarificationPanel,
} from './chat-app/thread-panel/clarification.js'
import {
  getGoalProposeActionMode,
  goalProposalSuppressKey,
  extractGoalProposalFromTools,
  extractLatestGoalProposalFromRows,
} from './chat-app/thread-panel/goal-proposal.js'
import {
  parseParentAndSubtaskIdFromComposite,
  collabStatusFromSubagentStreamEv,
  patchCollabSubtasksById,
  mergeCollabSubtasksStable,
  finalizeCollabSubtasksList,
} from './chat-app/collab/subtask-merge.js'

ensureRightStageKindsRegistered()
hideRightStageIfKind('artifacts')

export default function ChatApp() {
  // Drop once any titles cached while gateway_proxy mis-decoded UTF-8 as GBK.
  purgeStaleSessionNamesCharsetCacheOnce()
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
  // 各会话侧栏/询问面板状态缓存(切换会话时恢复;后台会话询问不得写入当前 UI)
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
    syncSessionRowRef,
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
  /** 有后台 bash 在跑时才继续拉列表；空闲时由 background_work 事件再叫醒。 */
  const watchBackgroundBashRef = useRef<(() => void) | null>(null)
  /**
   * stream-snapshot-store seq 计数器：每次 commit 都递增，让 React 端
   * ``useStreamSnapshotSeq`` 能感知 mutable streamRef 内部 mutation。
   * 切换会话或清空时复 0。
   */
  const streamSeqRef = useRef(0)
  /**
   * streamRef.current 当前绑定的会话 key。流式 bump / session 通知以此为准，
   * 替代旧的 streamDisplayTick (跨 session 通知)。
   */
  const streamRefKeyRef = useRef('')
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
  /** 注意：不要在此处加顶层 1s 轮询 tick。所有可见的耗时标签（消息区/侧栏行/输入区 dock）
   *  各自持有 1Hz interval，顶层 tick 只会造成整棵 ChatApp 的无谓重渲染。 */
  const goalActiveRef = useRef(false)
  const [streamHealth, setStreamHealth] = useState<'connected' | 'disconnected' | 'silent' | null>(null)
  const streamHealthRef = useRef<'connected' | 'disconnected' | 'silent' | null>(null)
  /** 服务可用性状态（独立于对话流健康 — 关注"服务能不能连上"） */
  const [serviceHealth, setServiceHealth] = useState<string>(ServiceHealthState.UNKNOWN)
  const serviceHealthRetryRef = useRef<boolean>(false)

  // 启动服务健康轮询（30s），订阅状态变化同步到 React state
  useEffect(() => {
    startServiceHealthPoll()
    const unsubscribe = onServiceHealthChange((snap) => {
      setServiceHealth(snap.state)
      // 调试日志：排查 banner 是否可见。默认静默（healthy 时每次 emit 都打）。
      try {
        if (isDebugOn('EVOFLOW_DEBUG_SERVICE_HEALTH')) console.info('[service-health]', snap)
      } catch { /* ignore */ }
      // 恢复时清掉 retry 标记
      if (snap.state === ServiceHealthState.HEALTHY) serviceHealthRetryRef.current = false
    })
    return () => {
      unsubscribe()
      stopServiceHealthPoll()
    }
  }, [])

  const handleServiceHealthRetry = useCallback(() => {
    if (serviceHealthRetryRef.current) return
    serviceHealthRetryRef.current = true
    void triggerServiceHealthCheck({ manual: true }).finally(() => {
      // 留给下次点击重置
      setTimeout(() => { serviceHealthRetryRef.current = false }, 500)
    })
  }, [])

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
        // 等价于当前 rows 时复用 prev 引用，避免 SSE delta 期间 baseHistoryItems 反复重算。
        setRows((prev) => (displayRowsEquivalent(prev, liveRows) ? prev : liveRows))
        // 旧 publishLiveStreamNow 已删：resume 时由 buildStreamDisplayRow 直接读 rt.stream
      }
    } else {
      streamRef.current = emptyStream()
      streamRefKeyRef.current = ''
      seenRunIdsRef.current = new Set()
      activeChatRunIdRef.current = null
    }
    prevSelectedSessionCleanupRef.current = sk
  }, [selectedSessionKey, shellSelectRevision])

  /** Monotonic id so aborted/stale handleSend cannot clear a newer round's stream state. */
  const chatSendSeqRef = useRef(0)
  const {
    composerDraftsRef,
    composerTextRef,
    composerDraftSnapshotRef,
    pendingComposerDraftCarryRef,
    composerDraftVersion,
    pushComposerText,
    handleComposerDraftChange,
    restoreComposerDraft,
  } = useComposerDrafts({ selectedSessionKey, sessionRef })
  const {
    contextFiles,
    setContextFiles,
    contextImagePreviewIndex,
    setContextImagePreviewIndex,
    isHomeSurfaceRef,
    persistContextFiles,
    toggleContextFile,
    attachContextFiles,
    attachContextFilesRef,
    handleConversationComposeDragOver,
    handleConversationComposeDrop,
  } = useChatContextFiles({ selectedSessionKey })
  const handleEditMessageRef = useRef<
    (text: string, messageId?: string, images?: Array<{ mediaType: string; data?: string; url?: string }>) => void | Promise<void>
  >(() => {})
  const [speechEnabled, setSpeechEnabled] = useState(false)
  const [engineReady, setEngineReady] = useState(() => {
    // Desktop UI-first: unlock send on Gateway liveness ; LG may still warm.
    try {
      if (typeof window !== 'undefined' && (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) return false
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
  const lastPlanPanelHitRef = useRef<PlanPanelHit | null>(null)
  const [planPanelHit, setPlanPanelHit] = useState<PlanPanelHit | null>(null)
  /** 流式中一旦出现 plan 即置位；final 合并丢 input 时仍展示计划面板 */
  const planStreamLatchRef = useRef<PlanStreamLatch>(null)
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

  const handleComposerWarmup = useCallback(() => {
    const sk = String(sessionRef.current || selectedSessionKey || '').trim()
    if (!sk) return
    void import('./lib/composer-latency-warmup.js').then((mod) => {
      void mod.warmComposerSession(sk)
    })
  }, [selectedSessionKey])

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
  /** Filled by handleSend (function decl hoisted); submit / home-send use .current */
  const handleSendRef = useRef<(...args: any[]) => any>(async () => {})
  const stopSessionExecutionRef = useRef<
    ((sessionKey: string, opts?: { showToast?: boolean }) => Promise<void>) | null
  >(null)
  const onClarificationSubmittedRef = useRef<
    ((answerText: string) => void | Promise<void>) | undefined | null
  >(null)
  const {
    bumpClarifyResolveSeq,
    scheduleClarificationPanelResolve,
    scheduleClarificationPanelResolveRef,
    detectAndScheduleClarificationRef,
    handleSubmitClarification,
  } = useClarificationPanel({
    selectedSessionKey,
    sessionRef,
    rowsRef,
    commitThreadPanelForSessionRef,
    setThreadPanelState,
    handleSendRef,
    onClarificationSubmittedRef,
  })

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
  /** 审批面板勾选「新对话默认完全访问」时同步当前会话（避免 effect 闭包过期） */
  const applyFullAccessToCurrentSessionRef = useRef<
    (opts?: { quiet?: boolean }) => Promise<void>
  >(async () => {})
  /** applyFullAccess 内部 grant_all 时抑制重复 toast */
  const suppressToolApprovalToastRef = useRef(false)
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
    tabs: rightStageTabs,
    activeKey: rightStageActiveKey,
    recentClosed: rightStageRecentClosed,
    activateTab: activateRightStageTab,
    closeTab: closeRightStageTab,
    reorderTab: reorderRightStageTab,
    reopenClosedTab: reopenRightStageTab,
    expand: expandRightStage,
    collapse: collapseRightStage,
    toggleCollapsed: toggleRightStageCollapsed,
    rightPanelLayoutKind: rightStageLayoutKind,
    mainBodyStageClasses,
    isOpen: rightStageOpen,
  } = useRightStageChatBridge()
  const rightStageSessionKeyRef = useRef(String(selectedSessionKey || '').trim())
  // 切会话时冻结 / 恢复右栏 tabs（浏览器标签式缓存）
  useEffect(() => {
    const nextKey = String(selectedSessionKey || '').trim()
    const prevKey = rightStageSessionKeyRef.current
    // 换会话前清掉 browser:primary 去重，否则 A/B 同 id 时 HWND 不会跟到新会话 URL。
    if (prevKey !== nextKey) resetBrowserStageSwitchTracking()
    // 同 key 也要登记「当前 UI 会话」，否则后台 agent 开浏览器无法判断归属。
    switchRightStageSession(prevKey, nextKey)
    rightStageSessionKeyRef.current = nextKey
  }, [selectedSessionKey])
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
  /** Chat @@dir/@@ → open workspace tree at this path */
  const [workspaceBrowseFocusPath, setWorkspaceBrowseFocusPath] = useState<string | null>(null)
  /** Filled after workspace roots resolve; used by early file-open handlers */
  const workspaceOpenScopeRef = useRef({
    root: '',
    configuredRoot: '',
    useVirtualPaths: false,
    sessionKey: '',
  })
  /** 用户手动打开/固定某一右侧场景时，写入流不得抢焦点 */
  const rightStageUserPinnedRef = useRef<RightStageKind | null>(null)
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
  const workspacePanelOpenRef = useRef(workspacePanelOpen)
  workspacePanelOpenRef.current = workspacePanelOpen
  const collabExecPanelOpenRef = useRef(collabExecPanelOpen)
  collabExecPanelOpenRef.current = collabExecPanelOpen
  /** 打开右侧分栏（工作区 / 协作执行）前左侧壳是否已折叠；关闭时恢复 */
  const shellCollapsedBeforeWorkspaceRef = useRef<boolean | null>(null)
  const openSessionSidebar = useCallback(() => {
    setSessionSidebarOpen(true)
  }, [])
  /** 右侧工作区展开时折叠左侧会话壳，关闭时恢复（与 header 文件夹按钮联动） */
  const syncShellAsideForWorkspacePanel = useCallback((open: boolean) => {
    syncShellAsideForWorkspacePanelImpl(
      {
        shellCollapsedBeforeWorkspaceRef,
        getShellAsideCollapsed,
        setShellAsideCollapsed,
      },
      open,
    )
  }, [])

  const {
    streamingWritePreview,
    setStreamingWritePreview,
    streamingWritePreviewRef,
    lastStreamWritePathRef,
    lastWriteStreamLenRef,
    writeStreamDismissedRef,
    writeStreamModeRef,
    syncWorkspacePreviewFromTools,
  } = useStreamingWritePreview({
    sessionRef,
    streamRef,
    scheduleBumpRef,
    rightStageUserPinnedRef,
    dismissedRightStageKindsRef,
    rightStageRunIdRef,
    rightStageHintTimerRef,
    platformFeedbackSeenRef,
    turnPlatformEntriesRef,
    publishPlatformEntriesRef,
    openWriteStream,
    openRightStageStream,
    appendRightStageStream,
    clearRightStageStream,
    closeRightStageStream,
    syncShellAsideForWorkspacePanel,
  })

  const closeWorkspacePanel = useCallback(() => {
    closeWorkspacePanelImpl({
      dismissedRightStageKindsRef,
      writeStreamDismissedRef,
      lastStreamWritePathRef,
      lastWriteStreamLenRef,
      rightStageUserPinnedRef,
      scheduleBumpRef,
      setStreamingWritePreview,
      setWorkspaceTreePinned,
      syncShellAsideForWorkspacePanel,
    })
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
      openCollabExecPanelImpl(
        {
          cancelPendingStreamUiBumpsRef,
          collabExecDismissedKeysRef,
          rightStageUserPinnedRef,
          collabExecPanelDismissKey,
          bumpSubtasksApiRefresh,
          setCollabExecPanelOpen,
        },
        opts,
      )
    },
    [collabExecPanelDismissKey, bumpSubtasksApiRefresh, setCollabExecPanelOpen],
  )

  const closeCollabExecPanel = useCallback(() => {
    closeCollabExecPanelImpl({
      collabExecDismissedKeysRef,
      rightStageUserPinnedRef,
      scheduleBumpRef,
      collabExecPanelDismissKey,
    })
  }, [collabExecPanelDismissKey])

  // ★ 性能优化：稳定化回调引用，避免每次 re-render 生成新函数破坏 HistoryMessageRow memo
  handleSendRef.current = handleSend
  const handleQuickPrompt = useCallback((text: string) => { void handleSendRef.current(text) }, [])
  const startNewChatWithPresetAgentRef = useRef<(code: string) => Promise<void>>(async () => {})
  const setModelNameRef = useRef<(name: string) => void>(() => {})
  useEffect(() => {
    const onHomeSend = (event: Event) => {
      const detail = (event as CustomEvent<{
        text?: string
        agentCode?: string
        skills?: SkillSelection[]
        plugins?: PluginSelection[]
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
      // 立刻离开工作台表面，避免「发完还停在首页 → 再切会话 → 再出消息」的三段感
      flushSync(() => {
        setSessionHadContent(true)
      })
      void (async () => {
        if (Array.isArray(detail?.skills)) setSelectedSkills(detail.skills)
        if (Array.isArray(detail?.plugins)) setSelectedPlugins(detail.plugins)
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
        // 先确保会话，再并行写 agent/model（静默，不走带 toast 的角色切换）
        let sk =
          (sessionRef.current || '').trim() ||
          (await ensureChatSessionKeyRef.current?.()) ||
          ''
        const code = String(detail?.agentCode || '').trim().toLowerCase()
        const prep: Promise<unknown>[] = []
        if (sk && code) {
          prep.push(
            (async () => {
              try {
                const { api } = await import('../lib/tauri-api.js')
                if (code === 'claude-code') {
                  await api.chatUpdateContext(sk, {
                    use_claude_code_chat: true,
                    agent_name: 'claude-code',
                    collab_phase: 'idle',
                    collab_task_id: null,
                  })
                } else if (code === 'main') {
                  await api.chatUpdateContext(sk, {
                    use_claude_code_chat: false,
                    agent_name: 'main',
                    agent_id: 'main',
                    collab_phase: 'idle',
                    collab_task_id: null,
                  })
                } else {
                  await api.chatUpdateContext(sk, {
                    use_claude_code_chat: false,
                    agent_name: code,
                    agent_id: code,
                    collab_phase: 'idle',
                    collab_task_id: null,
                  })
                }
              } catch {
                /* ignore — still send */
              }
            })(),
          )
        }
        if (sk && modelName) {
          prep.push(
            wsClient.updateSessionContext(sk, { model_name: modelName }).catch(() => undefined),
          )
        }
        if (prep.length) await Promise.all(prep)
        if (homeCtx.length) attachContextFilesRef.current?.(homeCtx)
        await handleSendRef.current(text, attachments, homeCtx.length ? homeCtx : undefined, {
          skillsOverride: Array.isArray(detail?.skills) ? detail.skills : undefined,
          pluginsOverride: Array.isArray(detail?.plugins) ? detail.plugins : undefined,
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
      void handleSendRef.current(String(text || ''))
    }
  }, [])
  const handleEditMessage = useCallback(
    (text: string, messageId?: string, images?: Array<{ mediaType: string; data?: string; url?: string }>) => {
      void handleEditMessageRef.current?.(text, messageId, images)
    },
    [],
  )
  /** 稳定引用：传给 MessageVirtualList（已 memo），避免内联箭头函数每次渲染击穿 memo */
  const handleHistoryViewReady = useCallback(() => setHistoryViewReady(true), [])
  /** 稳定引用：传给 GoalModePanel（已 memo），避免内联箭头每次渲染击穿 memo */
  const startGoalRef = useRef<(() => void) | null>(null)
  const stopGoalRef = useRef<(() => void) | null>(null)
  const handleStartGoal = useCallback(() => { void startGoalRef.current?.() }, [])
  const handleStopGoal = useCallback(() => { void stopGoalRef.current?.() }, [])
  const handleToolApprovalRef = useRef(handleToolApproval)
  handleToolApprovalRef.current = handleToolApproval
  const onToolApprovalStable = useCallback(
    (action: 'approve' | 'approve_all' | 'deny' | 'grant_all' | 'approve_remember', toolCallId?: string, hint?: { tool_name?: string; summary?: string; args?: Record<string, unknown> }) => {
      void handleToolApprovalRef.current(action, toolCallId, hint)
    },
    [],
  )

  const openKnowledgeMapPanel = useCallback(() => {
    openKnowledgeMapPanelImpl({
      knowledgeMapEnabled,
      cancelPendingStreamUiBumpsRef,
      rightStageUserPinnedRef,
      setKnowledgeMapRefreshKey,
      setKnowledgeMapPanelOpen,
    })
  }, [knowledgeMapEnabled, setKnowledgeMapPanelOpen])

  const closeKnowledgeMapPanel = useCallback(() => {
    closeKnowledgeMapPanelImpl({
      rightStageUserPinnedRef,
      scheduleBumpRef,
    })
  }, [])

  const syncRemoteStageSet = useCallback((detail: StageSetPayload) => {
    syncRemoteStageSetImpl(
      {
        rightStageUserPinnedRef,
        scheduleBumpRef,
        cancelPendingStreamUiBumpsRef,
        lastStreamWritePathRef,
        turnRunArtifactsRef,
        setSessionArtifactsRef,
        publishArtifactsRef,
        syncShellAsideForWorkspacePanel,
        setStreamingWritePreview,
        setWorkspaceTreePinned,
        setKnowledgeMapRefreshKey,
      },
      detail,
    )
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
      openStageExtensionImpl(
        {
          rightStageSurfaceKind: rightStageSurface?.kind,
          rightStageOpen,
          rightStageUserPinnedRef,
          scheduleBumpRef,
          cancelPendingStreamUiBumpsRef,
          lastStreamWritePathRef,
          writeStreamDismissedRef,
          syncShellAsideForWorkspacePanel,
          showKind,
          setWorkspacePanelOpen,
          setWorkspaceTreePinned,
          setStreamingWritePreview,
          setCollabExecPanelOpen,
          setKnowledgeMapPanelOpen,
        },
        kind,
      )
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


  const openUiExtensionInStage = useCallback(
    (extensionId: string) => {
      openUiExtensionInStageImpl(
        {
          rightStageOpen,
          rightStageUserPinnedRef,
          scheduleBumpRef,
          cancelPendingStreamUiBumpsRef,
          lastStreamWritePathRef,
          writeStreamDismissedRef,
          syncShellAsideForWorkspacePanel,
          showKind,
          setWorkspacePanelOpen,
          setWorkspaceTreePinned,
          setStreamingWritePreview,
          setCollabExecPanelOpen,
          setKnowledgeMapPanelOpen,
        },
        extensionId,
      )
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
    closeRightStageImpl({
      dismissedRightStageKindsRef,
      rightStageUserPinnedRef,
      writeStreamDismissedRef,
      lastWriteStreamLenRef,
      scheduleBumpRef,
      closeWorkspacePanel,
      closeKnowledgeMapPanel,
      closeCollabExecPanel,
      clearRightStageStream,
      syncShellAsideForWorkspacePanel,
    })
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
    toggleWorkspacePanelImpl({
      rightStageUserPinnedRef,
      scheduleBumpRef,
      cancelPendingStreamUiBumpsRef,
      lastStreamWritePathRef,
      streamingWritePreviewRef,
      syncShellAsideForWorkspacePanel,
      setWorkspacePanelOpen,
      setWorkspaceTreePinned,
      setStreamingWritePreview,
    })
  }, [setWorkspacePanelOpen, syncShellAsideForWorkspacePanel])


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

  /** 子任务工作流 / 思维导图 / Agent应用场景展开 → 收起左侧菜单 */
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

  const {
    openWorkspaceFilePreview,
    openMessageFilePreview,
    openWorkspaceFilePreviewRef,
    openSessionArtifact,
    revealSessionArtifact,
  } = useWorkspaceFileOpen({
    workspaceOpenScopeRef,
    rightStageSessionKeyRef,
  })

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
  const {
    pendingSendQueue,
    setPendingSendQueue,
    pendingSendQueueRef,
    pendingSteers,
    setPendingSteers,
    interruptSendSteersRef,
    midTurnInjectRef,
    handleQueueWhileBusy,
    handleSteerWhileBusy,
    handleCancelPendingSend,
    handleEditPendingSend,
    promoteConsumedSteersToRows,
    handleFlushPendingSend,
    handleCancelPendingSteer,
    handleInterruptAndSendSteers,
  } = usePendingSendQueue({
    selectedSessionKey,
    selectedTurnBusy,
    sessionRef,
    sessionsRef,
    rowsRef,
    setRows,
    handleSendRef,
    stopSessionExecutionRef,
    activeChatRunIdRef,
  })
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
    const sk = String(streamRefKeyRef.current || sessionRef.current || '').trim()
    if (!sk) return
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
      bumpSessionRuntimeNotifyForKey(sk, { immediate: true })
      return
    }
    if (streamChromeBumpTimerRef.current) return
    streamChromeBumpTimerRef.current = window.setTimeout(() => {
      streamChromeBumpTimerRef.current = 0
      if (!streamChromeBumpPendingRef.current) return
      streamChromeBumpPendingRef.current = false
      streamChromeLastBumpRef.current = Date.now()
      bumpSessionRuntimeNotifyForKey(sk, { immediate: true })
    }, minInterval - elapsed)
  }, [])

  const onCoalescedStreamBump = useCallback(() => {
    const sk = String(streamRefKeyRef.current || sessionRef.current || '').trim()
    if (sk) bumpSessionRuntimeNotifyForKey(sk, { immediate: true })
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
    // 旧 disposeLiveStreamUiBatch 已删：rAF batch 不存在了
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
    // 右栏文件/终端与对话并排，取消 bump 会冻住流式绘制并在恢复时跳动；
    // 仅遮罩对话区的侧栏才暂停 bump。
    const coveringOverlay =
      workspacePanelOpen || knowledgeMapVisible || collabExecPanelOpen
    setChatOverlayDefer('workspace', workspacePanelOpen)
    setChatOverlayDefer('knowledge-map', knowledgeMapVisible)
    setChatOverlayDefer('workflow', collabExecPanelOpen)
    setChatOverlayDefer('file-preview', false)
    if (coveringOverlay) {
      cancelPendingStreamUiBumpsRef.current()
    }
  }, [
    rightStageOpen,
    workspacePanelOpen,
    knowledgeMapEnabled,
    knowledgeMapPanelOpen,
    collabExecPanelOpen,
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
        // 旧 endLiveStreamSession 已删：live-stream-store 没了
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
          // bypassCache 只保证重新拉库；合并结果与当前画面等价则不 setRows，
          // 避免流刚结束、DB 尚未写完时整页闪一下或被半截历史盖掉。
          setRows((prev) => (displayRowsEquivalent(prev, mergedRows) ? prev : mergedRows))
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

  const anyRightPanelOpen = rightStageOpen
  const {
    mainBodyRef,
    conversationColRef,
    bottomAreaRef,
    layoutResizeEnabled,
    isMobileChat,
    mobileChatPane,
    setMobileChatPane,
    rightPanelWidthPx,
    bottomDockHeightPx,
    onRightPanelResizePointerDown,
    rightPanelResizeDragging,
    handleBottomDockResizePointerDown,
    bottomDockResizeDragging,
    mainBodyLayoutStyle,
    bottomAreaLayoutStyle,
  } = useChatLayoutResize({
    anyRightPanelOpen,
    rightStageTabs,
    selectedSessionKey,
  })

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
  const {
    contextUsageBySession,
    setContextUsageBySession,
    hydrateContextUsageFromSessions,
  } = useContextUsageBySession({ selectedSessionKey, sessions })
  hydrateContextUsageFromSessionsRef.current = hydrateContextUsageFromSessions
  const [manualContextCompacting, setManualContextCompacting] = useState(false)
  const [agents, setAgents] = useState<AgentPickerRow[]>([])
  const [bottomModelOpen, setBottomModelOpen] = useState(false)
  const [bottomPermissionOpen, setBottomPermissionOpen] = useState(false)
  const [bottomMoreOpen, setBottomMoreOpen] = useState(false)
  /** 右侧信息 Drawer：默认关闭；与 Right Stage 互斥 */
  const [, setInfoRailOpen] = useState(true)
  const [infoRailTab, setInfoRailTab] = useState<InfoRailTab>('agent')
  /**
   * 用户在当前会话内是否手动关过侧栏。
   * 切会话时若该 ref 为 false，则默认开侧栏；为 true 则尊重用户意图保持关闭。
   * 这样可避免「用户点关闭后立刻被切会话 effect 拉回 true」的竞态。
   */
  const userClosedInfoRailRef = useRef(false)
  /** 状态面板三态：右侧空白悬浮卡 / 气泡 / 隐藏。与专用 Right Stage 互斥。 */
  const [chatPanelMode, setChatPanelMode] = useState<ChatSummaryDisplayMode>(() => {
    try {
      return loadChatSummaryPrefs().displayMode
    } catch {
      return 'panel'
    }
  })
  const setChatPanelDisplayMode = useCallback(
    (mode: ChatSummaryDisplayMode) => {
      setChatPanelMode(mode)
      saveChatSummaryDisplayMode(mode)
      if (mode === 'panel') {
        // 悬浮卡与专用侧栏互斥：展开卡片时关掉侧栏。
        collapseRightStage()
      }
    },
    [collapseRightStage],
  )

  // 摘要已改挂对话正文右上角，启动时卸掉右栏里残留的 summary 标签。
  useEffect(() => {
    closeSummaryStage()
    const remaining = filterRightStageTabsForSession(
      rightStageStore.getSnapshot().tabs,
      selectedSessionKey,
    )
    if (remaining.length === 0) collapseRightStage()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount: drop leftover summary tab
  }, [])
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
    // 浏览器面板由 agent 实时驱动（画布/点击/滚轮穿透）。平台条目改走 Info Rail
    // 呈报，不抢占 Right Stage——否则平台工具一发布条目，浏览器面板就被折叠。
    const browserStageLive = rightStageStore.getSnapshot().surface?.kind === 'browser'
    if (rightStageHintTimerRef.current) {
      clearTimeout(rightStageHintTimerRef.current)
      rightStageHintTimerRef.current = 0
    }
    if (!browserStageLive) {
      rightStageStore.hide()
    }
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
  const startNewSessionWithWorkspaceRef = useRef<(workspacePath: string | null) => void>(() => {})
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

  /** 首页工作台输入框下方展示的当前工作空间（与底部工作空间 pill 同源） */
  const homeWorkspaceLabel = useMemo(() => {
    if (useVirtualPaths) return '虚拟'
    const p = String(effectiveWorkspaceRoot || '').trim()
    return p ? _pathBasename(p) : '默认'
  }, [useVirtualPaths, effectiveWorkspaceRoot])

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
  const { proactiveRoles, loadProactiveRoles } = useProactiveRoles()

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

  const [bottomRoleOpen, setBottomRoleOpen] = useState(false)

  /** @员工名 任务 -> 派发给智能体员工，并跳转到该员工工作轨迹 */
  const handleDispatchEmployee = useCallback(async (agentCode: string, goal: string) => {
    await handleDispatchEmployeeImpl(
      {
        proactiveRolesDisplay,
        sessionRef,
        selectedSessionKey,
        rowsRef,
        setRows,
      },
      agentCode,
      goal,
    )
  }, [proactiveRolesDisplay, selectedSessionKey, setRows])

  /** 技能/插件选择（多选弹窗 + sticky） */
  const [shareSessionOpen, setShareSessionOpen] = useState(false)
  /** 顶栏「在资源管理器打开」成组按钮的下拉开合态。 */
  const [workspaceFolderMenuOpen, setWorkspaceFolderMenuOpen] = useState(false)
  const {
    bottomSkillOpen,
    setBottomSkillOpen,
    skillList,
    skillListLoading,
    selectedSkills,
    setSelectedSkills,
    persistSelectedSkills,
    removeSelectedSkill,
    addSelectedSkill,
    bottomPluginPanelOpen,
    setBottomPluginPanelOpen,
    pluginPanelStyle,
    setPluginPanelStyle,
    pluginList,
    pluginListLoading,
    selectedPlugins,
    setSelectedPlugins,
    pluginComposerPillsVisible,
    setPluginComposerPillsVisible,
    persistSelectedPlugins,
    removeSelectedPlugin,
    addSelectedPlugin,
  } = useComposerSkillPluginSelection({ selectedSessionKey })

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
      // `/` 触发器：注入技能 + 插件的搜索目录。`addSelected*` 会把命中项追加到
      // `selectedSkills` / `selectedPlugins`，与加号面板的语义一致。
      skills: skillList,
      plugins: pluginList.map((p) => ({
        id: p.id,
        label: p.label || p.name,
        iconUrl: p.iconUrl,
        description: p.description,
      })),
      onPickSkill: (sk) => {
        addSelectedSkill(sk)
        void import('../components/toast.js').then(({ toast }) => {
          toast(`已选技能：${sk.label}`, 'info')
        })
      },
      onPickPlugin: (pl) => {
        addSelectedPlugin(pl)
        void import('../components/toast.js').then(({ toast }) => {
          toast(`已选插件：${pl.label}`, 'info')
        })
      },
    }
  }, [
    effectiveWorkspaceRoot,
    persistContextFiles,
    searchWorkspaceFilesForMention,
    selectedSessionKey,
    useVirtualPaths,
    proactiveRolesDisplay,
    skillList,
    pluginList,
    addSelectedSkill,
    addSelectedPlugin,
  ])

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
  }, [selectedSessionKey, setRows])
  const [, setSubagentDockTasks] = useState<Record<string, SubagentStreamTask>>({})
  const {
    sidebarTaskViews,
    setSidebarTaskViews,
    sidebarSelectedTaskId,
    setSidebarSelectedTaskId,
    parentTaskToSubtaskRef,
    upsertSidebarTaskView,
    ensureSubtasksVisibleForTask,
    clearSidebarBackfillCaches,
    applyTaskProgressSnapshot,
  } = useCollabSidebarSync({
    selectedSessionKey,
    sessionRef,
    sessionsRef,
    streamRef,
    setThreadPanelState,
    bumpSubtasksApiRefresh,
    setSubagentDockTasks,
    planAppliedForRef,
    planFromApiLoadedRef,
  })
  const bottomModelRootRef = useRef<HTMLDivElement | null>(null)
  const bottomPermissionRootRef = useRef<HTMLDivElement | null>(null)
  const bottomMoreRootRef = useRef<HTMLDivElement | null>(null)
  const bottomMoreTriggerRef = useRef<HTMLButtonElement | null>(null)
  const renderBottomControlsLoggedRef = useRef(false)
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

  const {
    modelCatalog,
    primaryModelName,
    modelName,
    setModelName,
    modelsLoading,
    modelConnNameMap,
    loadModelCatalog,
    followResolvedModelName,
    effectiveModelName,
    modelPillLabel,
    syncModelSessionPrevKeyRef,
  } = useComposerModelCatalog({
    selectedSessionKey,
    sessions,
    listLoading,
    agentDefaultModelName,
    roleUiNonce,
    bottomModelOpen,
    setSessions,
    sessionsRef,
  })
  setModelNameRef.current = setModelName

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
      clearSidebarBackfillCaches()
      if (opts?.closeSidebar !== false) {
        setSessionSidebarOpen(false)
      }
      setCollabExecPanelOpen(false)
      setKnowledgeMapPanelOpen(false)
      prevCollabExecPhaseRef.current = ''
      collabExecSessionBaselinedRef.current = ''
      collabExecDismissedKeysRef.current.clear()
    },
    [resetPlanStreamSession, clearSidebarBackfillCaches],
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
    clearSidebarBackfillCaches()
    const sk = String(sessionRef.current || selectedSessionKey || '').trim()
    if (sk) invalidatePlanApiCache(sk)
    setThreadPanelState(emptyThreadPanel())
    setBoundTaskId(null)
  }, [resetPlanStreamSession, selectedSessionKey, clearSidebarBackfillCaches])

  // collabSubtaskStatusSig removed (unused)

  /** 协作侧栏：流式 + 全历史 assistant 工具。 */
  const collectCollabToolsForSidebar = useCallback((): unknown[] => {
    return collectCollabToolsForSidebarImpl({ streamRef }, rows)
  }, [rows])

  /** 底部 plan 条：流式中仅用 stream buffer，避免全历史合并冲掉当前 plan。 */
  const collectPlanToolsForDetection = useCallback((): unknown[] => {
    return collectPlanToolsForDetectionImpl(
      {
        streamRef,
        persistedPlanInputRef,
        lastPlanDetectionToolsRef,
        streamRefHasVisibleContent,
      },
      rows,
      selectedTurnBusy,
    )
  }, [rows, selectedTurnBusy])

  const mergedPlanTools = useMemo(
    () => collectPlanToolsForDetection(),
    [collectPlanToolsForDetection, executingListEpoch, streamTick],
  )

  /** plan 工具入参/出参一到就立刻写 panel state（不等到 final / 刷新）。 */
  const syncPlanPanelImmediateFromTools = useCallback(
    (tools: unknown[]) =>
      syncPlanPanelImmediateFromToolsImpl(
        {
          planStreamLatchRef,
          lastPlanDetectionToolsRef,
          lastPlanPanelHitRef,
          lastPlanSyncSigRef,
          setPlanStreamLatched,
          setThreadPanelState,
          absorbPlanFromTools,
          publishPlanPanelHit,
          resetCollabPlanUiForNewCycle,
        },
        tools,
      ),
    [publishPlanPanelHit, absorbPlanFromTools, resetCollabPlanUiForNewCycle],
  )

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

  const syncPlanPanelFromApi = useCallback(
    async (opts: SyncPlanPanelFromApiOpts) => {
      await syncPlanPanelFromApiImpl(
        {
          sessionRef,
          selectedSessionKey,
          sessionTasksFetchSeqRef,
          planAppliedForRef,
          planFromApiLoadedRef,
          planApiSyncInflightRef,
          planDockApiViewRef,
          planStreamLatchRef,
          lastPlanPanelHitRef,
          threadCollabSnapshotRef,
          suppressedPlanExecDockKeysRef,
          userAuthorizedTaskIdsRef,
          threadPanelState,
          isActiveSessionFetch,
          applyPlanDockApiView,
          applyTaskProgressSnapshot,
          publishPlanPanelHit,
          setPlanStreamLatched,
          setPlanPanelHit,
          setThreadPanelState,
          setBoundTaskId,
          openSessionSidebar,
          suppressPlanExecDock,
          isPlanExecDockSuppressed,
          planExecSuppressToken,
          bumpSubtasksApiRefresh,
        },
        opts,
      )
    },
    [
      applyPlanDockApiView,
      applyTaskProgressSnapshot,
      publishPlanPanelHit,
      selectedSessionKey,
      threadPanelState,
      openSessionSidebar,
      suppressPlanExecDock,
      isPlanExecDockSuppressed,
      setBoundTaskId,
      bumpSubtasksApiRefresh,
      planExecSuppressToken,
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
      await applyPlanToolSuccessImpl({ syncPlanPanelFromApi }, hit)
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
      await refreshPlanDockAfterStreamFinalImpl(
        {
          sessionRef,
          selectedSessionKey,
          planStreamLatchRef,
          planDockApiViewRef,
          syncPlanPanelFromApi,
        },
        opts,
      )
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
      await reconcileLastAssistantFromDbImpl(
        {
          sessionRef,
          selectedSessionKey,
          rowsRef,
          reconcileInflightRef,
          setRows,
        },
        opts,
      )
    },
    [selectedSessionKey, setRows],
  )
  const reconcileLastAssistantFromDbRef = useRef(reconcileLastAssistantFromDb)
  reconcileLastAssistantFromDbRef.current = reconcileLastAssistantFromDb

  /** 侧栏单条刷新：messages 一次 + tasks 一次（reload 后再 sync，并挡住 session_enter 重复）。 */
  const runShellSessionRefresh = useCallback(
    async (sessionKey: string) => {
      await runShellSessionRefreshImpl(
        {
          sessionRefreshInFlightRef,
          sessionTasksFetchSeqRef,
          sessionsRef,
          executingSessionKeysRef,
          planAppliedForRef,
          planFromApiLoadedRef,
          threadCollabSnapshotRef,
          planSessionEnterRef,
          rowsRef,
          rows,
          boundTaskId,
          refreshSessionsRef,
          requestManualStreamResumeRef,
          refreshGoalStatusRef,
          isActiveSessionFetch,
          reloadHistoryFromDb,
          syncPlanPanelFromApi,
          abortStreamWire: (sk, runId) => wsClient.abortStreamWire(sk, runId),
          getSessionContext: (sk) =>
            wsClient.getSessionContext(sk) as { collab_task_id?: string } | undefined,
        },
        sessionKey,
      )
    },
    [syncPlanPanelFromApi, reloadHistoryFromDb, rows, boundTaskId],
  )
  const runShellSessionRefreshRef = useRef(runShellSessionRefresh)
  runShellSessionRefreshRef.current = runShellSessionRefresh

  async function resolveLangGraphThreadIdForSession(sessionKey: string): Promise<string> {
    return resolveLangGraphThreadIdForSessionImpl(
      {
        sessionsRef,
        getSessionThreadId: (sk) => wsClient.getSessionThreadId(sk),
        resolveSessionThreadId: (sk, opts) => wsClient.resolveSessionThreadId(sk, opts),
      },
      sessionKey,
    )
  }

  /** REST authorize-execution：写 execution_authorized 并自动派发首波；失败时仍返回 false。 */
  async function authorizeExecutionInBackground(
    taskId: string,
    _threadIdHint: string,
  ): Promise<boolean> {
    return authorizeExecutionInBackgroundImpl(
      {
        sessionRef,
        selectedSessionKey,
        userAuthorizedTaskIdsRef,
        setThreadPanelState,
        resolveLangGraphThreadIdForSession,
        hydrateCollabSidebarSnapshot: (threadId, tid) =>
          wsClient.hydrateCollabSidebarSnapshot(threadId, tid) as Promise<
            Record<string, unknown> | null
          >,
        applyTaskProgressSnapshot,
        suppressPlanExecDock,
        applyPlanDockApiView,
        planDockApiHide,
        openCollabExecPanel,
        ensureSubtasksVisibleForTask,
      },
      taskId,
      _threadIdHint,
    )
  }

  /** 界面「开始执行」：REST 授权并自动派发首波，再发用户消息让 Lead 进入监控/验收轮次。 */
  async function runUserExecutionStart(taskId: string) {
    await runUserExecutionStartImpl(
      {
        sessionRef,
        selectedSessionKey,
        planExecStartInFlightRef,
        setPlanExecStarting,
        planExecToolArrays,
        threadPanelState,
        boundTaskId,
        resolveLangGraphThreadIdForSession,
        authorizeExecutionInBackground,
        handleSend,
      },
      taskId,
    )
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
    console.log('[ChatApp] useLayoutEffect bottomMoreOpen:', bottomMoreOpen);
    if (!bottomMoreOpen || typeof window === 'undefined') {
      console.log('[ChatApp] bottomMoreOpen 为 false 或 window 不存在，清除样式');
      setBottomMorePortalStyle(null)
      return
    }
    console.log('[ChatApp] 计算下拉菜单位置...');
    const update = () => {
      const btn = bottomMoreTriggerRef.current
      if (!btn) {
        console.log('[ChatApp] bottomMoreTriggerRef.current 为 null');
        return
      }
      console.log('[ChatApp] 按钮位置:', btn.getBoundingClientRect());
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
      console.log('[ChatApp] 计算的样式:', { left, bottom, maxH, minW });
    }
    update()
    console.log('[ChatApp] 初始化完成，添加事件监听');
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [bottomMoreOpen])

  // 插件快捷面板：锚定 + 按钮上方（与 bottom-more 同一定位机制）
  useLayoutEffect(() => {
    if (!bottomPluginPanelOpen || typeof window === 'undefined') {
      setPluginPanelStyle(null)
      return
    }
    const update = () => {
      const btn = bottomMoreTriggerRef.current
      if (!btn) return
      const r = btn.getBoundingClientRect()
      const gap = 10
      const sidePad = 10
      const left = Math.max(sidePad, Math.min(r.left, window.innerWidth - sidePad - 620))
      const bottom = Math.max(sidePad, window.innerHeight - r.top + gap)
      const maxH = Math.max(160, Math.min(window.innerHeight * 0.62, r.top - gap - sidePad))
      setPluginPanelStyle({
        position: 'fixed',
        left,
        bottom,
        top: 'auto',
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
  }, [bottomPluginPanelOpen])

  // 底部「模式 + 模型/创意/工作空间」上拉：互斥 + 点击外部 / Esc 全部关闭
  // 技能 / 角色已改为独立 modal，不参与此下拉互斥逻辑
  useEffect(() => {
    const anyOpen = modeMenuOpen || bottomModelOpen || bottomPermissionOpen || bottomMoreOpen || bottomWorkspaceOpen || bottomPluginPanelOpen
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
      setBottomPluginPanelOpen(false)
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
      // + 号按钮（v4 加号触发附件/更多下拉）也算「更多」菜单入口
      if (target.closest('.react-chat-icon-attach-btn')) return
      // 权限 pill（v4 风格点 pill 弹三选一菜单）
      if (target.closest('.react-chat-bottom-permission-pill')) return
      // 权限三选一上拉菜单本身（v4 新位置，不 portal）
      if (target.closest('.react-chat-permission-menu')) return
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
        resetStreamStopLogDedupe(sk)
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
        // live POST 未关：probe 滞后不得清 busy（与 shell refresh / RUN_FINISHED 同病）
        if (isLivePostStreamOpen(rt)) return
        const stillBusy = isTurnBusy(rt) || isSessionRuntimeLive(rt)
        const backendDone = probe ? !probe.executing && !probe.goalActive : true
        if (stillBusy && backendDone) {
          logStreamStop({
            sessionKey: sk,
            runId: rt.activeChatRunId || rt.stream.runId,
            trigger: 'refresh_backend_done',
            hasEndMarker: false,
            detail: {
              source: 'goal_refresh_chat_history',
              turnPhase: rt.turnPhase,
              probeExecuting: probe?.executing,
              probeGoalActive: probe?.goalActive,
            },
          })
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
  onClarificationSubmittedRef.current = (answerText: string) => {
    void goalCaptureRef.current.onUserClarificationSubmitted?.(answerText)
  }
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
      // 流式写进度 / tool 标签更新：沿 session-runtime 通知（替代旧 streamDisplayTick）。
      const targetSk = String(streamRefKeyRef.current || sessionRef.current || '').trim()
      if (targetSk) bumpSessionRuntimeNotifyForKey(targetSk, { immediate: true })
      return
    }
    const throttleFloor = isStreamThrottleEnabled()
      ? resolveStreamBumpMinIntervalMs(streamRef.current)
      : STREAM_BUMP_INTERVAL_MS
    const nextInterval = Math.max(STREAM_BUMP_INTERVAL_MS, throttleFloor)
    const prevInterval = streamBumpMinIntervalRef.current
    streamBumpMinIntervalRef.current = nextInterval
    if (nextInterval !== prevInterval) {
      streamPerfNoteBumpThrottle(nextInterval, prevInterval)
    }
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
      // 写进度 / tool 标签更新：会话级通知驱动 MessageVirtualList 重算
      const targetSk = String(streamRefKeyRef.current || sessionRef.current || '').trim()
      if (targetSk) bumpSessionRuntimeNotifyForKey(targetSk, { immediate: true })
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
      // 整块替换 + 递增 seq：作为「事实存储」，下游 React 端由 session-runtime
      // notify（scheduleBump 触发）单链路到达，避免双路通知造成每条 SSE delta
      // 触发两次 React rerender，从而消除 MessageVirtualList / MessageRow 闪烁。
      streamSeqRef.current += 1
      commitStreamSnapshot(sk, stream, { seq: streamSeqRef.current })
      if (opts.liveTextOnly) {
        if (skipLiveUi) return
        // v6.0 关闭正文/推理 SSE delta 节流：用户要求"sse 返回什么就显示什么"。
        // 之前 STREAM_BUMP_INTERVAL_MS / REASONING_BUMP_INTERVAL_MS (16ms) + 调度器
        // 仍然会在多 delta 突发时被合并到一帧，导致正文 1s 跳 386 字符。
        // Keep every delta in the committed snapshot, but coalesce paints to one
        // low-latency frame. Immediate React updates per token starve the main
        // thread and make both reasoning and body text appear to stutter.
        streamBumpSchedulerRef.current?.schedule({ lowLatency: true })
        return
      }
      // structural 变化：新 tool / 新 image / 新 segment 出现。
      // 走 coalesced 路径按需立即或合并，保证视觉但避免每条都全量重渲染。
      if (opts.immediate) {
        scheduleBump({ immediate: true })
        return
      }
      if (skipLiveUi) {
        scheduleBump()
        return
      }
      scheduleBump()
    },
    [scheduleBump, scheduleReasoningBump],
  )

  const clearTurnSendingState = useCallback(
    (sessionKey: string, rt: ReturnType<typeof getSessionRuntime>, isBackground: boolean) => {
      // 必须清 activeChatRunId：否则下一轮 run_started(runId 不同)会被 run gate 阻断，
      // turnPhase 停在 idle，后续 delta 全部被 !streamActive 守卫丢弃，流式显示冻结。
      clearActiveRun(rt)
      if (!isBackground) activeChatRunIdRef.current = null
      // SSE final / 停止：POST wire 已关，显式清 marker（TURN_IDLE 会保留 'run' 以免误伤）
      if (rt.streamWireSource === 'run') {
        markSessionStreamWireSource(sessionKey, null)
      }
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
          logStreamStop({
            sessionKey: sk,
            runId: rt.activeChatRunId || rt.stream.runId,
            trigger: 'stale_sending_watchdog',
            hasEndMarker: false,
            detail: {
              result,
              silentMs: Date.now() - last,
              turnPhase: rt.turnPhase,
              note: '前端 90s 无事件后清 busy（非用户点停止）',
            },
          })
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
        const silentMs = Date.now() - last
        const runIdBefore = rt.activeChatRunId || rt.stream.runId
        void maybeClearTurnSendingState({
          sessionKey: sk,
          wsClient,
          onClear: () => {
            clearTurnSendingState(sk, rt, true)
            logStreamStop({
              sessionKey: sk,
              runId: runIdBefore,
              trigger: 'stale_busy_poll_clear',
              hasEndMarker: false,
              detail: {
                silentMs,
                turnPhase: rt.turnPhase,
                note: '全局 45s 无事件且后端确认不在跑后清 busy',
              },
            })
          },
          onResume: () => {
            /* 续流仅用户刷新触发 */
          },
        })
      }
    }, 15000)
    return () => window.clearInterval(timer)
  }, [clearTurnSendingState])

  /** 刷新/关窗时若仍 busy，落 page_unload（靠 frontend-*.log / LS ring 事后排查） */
  useEffect(() => {
    return installStreamStopPageUnloadHook(() => listBusySessionKeys())
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
    const onRequestSessionFullAccess = () => {
      void applyFullAccessToCurrentSessionRef.current({ quiet: true }).then(() => {
        toast('本会话已切换为完全访问', 'success')
      })
    }
    window.addEventListener(TOOL_APPROVAL_POLICY_CHANGED, onGlobalChanged)
    window.addEventListener(TOOL_APPROVAL_SESSION_POLICY_CHANGED, onSessionChanged)
    window.addEventListener(TOOL_APPROVAL_REQUEST_SESSION_FULL_ACCESS, onRequestSessionFullAccess)
    return () => {
      window.removeEventListener(TOOL_APPROVAL_POLICY_CHANGED, onGlobalChanged)
      window.removeEventListener(TOOL_APPROVAL_SESSION_POLICY_CHANGED, onSessionChanged)
      window.removeEventListener(
        TOOL_APPROVAL_REQUEST_SESSION_FULL_ACCESS,
        onRequestSessionFullAccess,
      )
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

  const {
    pickWorkspaceFolder,
    resolveWorkspacePathForSidebar,
    handleNewWorkspace,
    bindCurrentSessionToWorkspace,
    pickAndBindCurrentWorkspace,
    pickAndStartNewSessionWithWorkspace,
    clearCurrentSessionWorkspace,
    openCurrentWorkspaceInFileManager,
    handleOpenWorkspaceFolder,
  } = useSessionWorkspaceBind({
    selectedSessionKey,
    localWorkspaceRoot,
    setLocalWorkspaceRoot,
    runtimeDataDir,
    globalWorkspaceHistory,
    setGlobalWorkspaceHistory,
    setBottomWorkspaceOpen,
    sessionRef,
    shellIntentWorkspaceRef,
    startNewSessionWithWorkspaceRef,
  })

  const deleteWorkspaceInflightRef = useRef(false)

  const handleDeleteWorkspaceGroup = useCallback(
    async (group: ShellWorkspaceGroup) => {
      await handleDeleteWorkspaceGroupImpl(
        {
          deleteWorkspaceInflightRef,
          sessionRef,
          streamRef,
          streamRefKeyRef,
          seenRunIdsRef,
          rowsRef,
          seenArtifactsRef,
          composerDraftsRef,
          bumpStreamFullRef,
          setSelectedSessionKey,
          setNewChatButtonActive,
          setRows,
          setTokenTotals,
          setLiveTurnTokens,
          setSubagentDockTasks,
          setSidebarTaskViews,
          setSidebarSelectedTaskId,
          setThreadPanelState,
          setHasReceivedTodos,
          setBoundTaskId,
          setGlobalWorkspaceHistory,
          removeSessionFromList,
          purgeWorkspaceFromSidebar,
          refreshSessions,
          removeWorkspaceHistoryPath: (p) => wsClient.removeWorkspaceHistoryPath(p),
        },
        group,
      )
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

  const {
    reconcileCollabWithMode,
    applySessionModePreset,
    applyThinkingLevel,
    applyCollabServerPatch,
    setCollabPhaseForSession,
    setSessionModeAndApply,
  } = useSessionModeControls({
    sessionMode,
    setSessionMode,
    setThinkingLevel,
    setCollabOn,
    dynamicModes,
    selectedSessionKey,
    sessionRef,
  })

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
            const data = ev?.data && typeof ev.data === 'object' ? ev.data : ev
            const sk = String(data?.session_key || data?.sessionKey || '').trim()
            if (!sk) return
            if (sessionsRef.current.some((s) => String(s.sessionKey || '') === sk)) return
            void syncSessionRowRef.current?.(sk)
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
      void loadModelCatalog({ silent: true, forceLive: true })
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
      // 切回 #/chat：恢复所有仍挂着 live POST 却被误 idle 的会话（含后台「绘画」）
      reviveAllTurnBusyIfLivePostOpen()
      void loadModelCatalog({ silent: true, forceLive: true })
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
            const evType = String(ev?.type || '').trim()
            if (evType === 'panel:activity') {
              // 后台 run（proactive 值班等）无 live runs/stream：步骤进度经
              // panel-stream 控制面到达。走与 thread_state 活动相同的管线，
              // 驱动 session 状态条 + 流式行 spinner 文案（B1/B2 通路前端端）。
              const data = ev?.data && typeof ev.data === 'object' ? ev.data : {}
              const detail = String(data.detail || '').trim()
              if (!detail) return
              const kind = String(data.kind || 'system').trim().toLowerCase()
              setSessionActivity(sk, kind === 'idle' ? 'system' : kind, detail)
              applyStreamTurnEvent(streamRef.current, { type: 'system_activity', detail })
              scheduleBumpRef.current?.({ immediate: true })
              return
            }
            if (evType !== 'panel:title_updated') return
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
    return handleEnhancePromptImpl(
      {
        rowsRef,
        effectiveModelName,
        selectedSessionKey,
        sessionRef,
        enhancePrompt: (text, model, recent, sessionKey) =>
          wsClient.enhancePrompt(text, model, recent, sessionKey),
      },
      draft,
    )
  }, [effectiveModelName, selectedSessionKey])


  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const api = await getApi()
        const [agentResult] = await Promise.all([api.listAgents()])
        if (cancelled) return
        const list = Array.isArray(agentResult) ? agentResult : agentResult?.agents || []
        setAgents(mapAgentPickerRows(list))
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
      const mapped = mapAgentPickerRows(list)
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
      await patchCurrentAgentCapabilitiesImpl(
        {
          currentRoleCodeForUi,
          employeeSessionAgentCode,
          isProactiveEmployeeSession,
          getApi,
          setCapabilityPatchBusy,
          setRoleUiNonce,
          refreshAgentsList,
        },
        patch,
      )
    },
    [
      currentRoleCodeForUi,
      employeeSessionAgentCode,
      isProactiveEmployeeSession,
      refreshAgentsList,
    ],
  )

  const openCurrentAgentEditor = useCallback(() => {
    openCurrentAgentEditorImpl({
      agents,
      currentRoleCodeForUi,
      employeeSessionAgentCode,
      isProactiveEmployeeSession,
      refreshAgentsList,
      setRoleUiNonce,
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
    const rt = getSessionRuntime(sk)
    // Never abortStreamWire a live POST /runs/stream — that is the send itself.
    if (shouldSuppressAutoReattach({ sessionKey: sk, runtime: rt })) {
      srLog('stream resume skipped — live POST stream', { sessionKey: sk })
      return
    }
    delete refreshAttachAttemptedRef.current[sk]
    reattachRetryCountRef.current = 0
    srLog('stream resume requested (user refresh)', { sessionKey: sk })
    manualReattachSessionKeyRef.current = sk
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
      // Live POST /runs/stream: never reattach (would abortStreamWire the send).
      if (shouldSuppressAutoReattach({ sessionKey: sk })) return
      // Only resume when the session still looks like it needs a wire.
      if (!shouldManualRefreshResumeStream({ sessionKey: sk })) return
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
          // 旧 bumpStreamDisplayTick 已删：会话级通知已驱动 streamRow 重算
          const sk = String(streamRefKeyRef.current || sessionRef.current || activeSk || '').trim()
          if (sk) bumpSessionRuntimeNotifyForKey(sk, { immediate: true })
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
              newArtifacts.map((path: string) => ({
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
            newArtifacts.map((path: string) => ({
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
          systemSkillsTokens?: number | null
          systemAssetsTokens?: number | null
          systemMemoryTokens?: number | null
          injectedSections?: Record<string, string>
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
            systemSkillsTokens: p.systemSkillsTokens != null ? Number(p.systemSkillsTokens) || 0 : null,
            systemAssetsTokens: p.systemAssetsTokens != null ? Number(p.systemAssetsTokens) || 0 : null,
            systemMemoryTokens: p.systemMemoryTokens != null ? Number(p.systemMemoryTokens) || 0 : null,
            injectedSections: p.injectedSections,
            updatedAt: Date.now(),
          }),
        }))
        return
      }

      if (msg.event !== 'chat') return
      const payload = msg.payload
      if (!payload) return
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
          void syncSessionRowRef.current?.(eventSk)
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
      // live POST 仍开着但 turn 被误 idle：立刻拉回 busy，避免后续 delta 被丢、侧栏停转
      if (targetSk && isLivePostStreamOpen(rt) && !isTurnBusy(rt)) {
        reviveTurnBusyIfLivePostOpen(targetSk)
      }
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
        (turnBusyForSession(targetSk) || isTurnBusy(rt) || isLivePostStreamOpen(rt))
      ) {
        streamRef.current = S
        streamRefKeyRef.current = targetSk
      }

      if (runId && rtIsStoppedRun(rt, runId) && state !== 'aborted') {
        return
      }

      // 用户已停止：丢弃迟到的 delta/reasoning/tool（避免「正在处理中」与幽灵流式气泡）
      // live POST 仍开着也视为 active（中途 RUN_FINISHED 误 idle 时不能丢帧）
      const streamActive = isTurnBusy(rt) || isLivePostStreamOpen(rt)
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
          void loadModelCatalog({ silent: true, forceLive: true })
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

      if (state === 'background_work') {
        const ev = payload.backgroundWorkEvent
        if (ev && typeof ev === 'object' && !Array.isArray(ev)) {
          if (!S.backgroundWorks) S.backgroundWorks = {}
          mergeBackgroundWorkEvent(S.backgroundWorks, ev as Record<string, unknown>)
          const workStatus = String((ev as { status?: string }).status || 'running').trim().toLowerCase()
          if (!workStatus || workStatus === 'running') watchBackgroundBashRef.current?.()
          if (!S.runId && runId) S.runId = runId
          if (!S.startTs) S.startTs = Date.now()
          const sk = String(payload.sessionKey || sessionRef.current || '').trim()
          if (sk) {
            streamSeqRef.current += 1
            commitStreamSnapshot(sk, S, { seq: streamSeqRef.current })
          }
          scheduleBump({ immediate: true })
        }
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
              // 找 lastRealUser 之后的最后一个 assistant 行（与 MessageVirtualList
              // continuationTargetIndex 一致）。原来用 findFirstAssistantAfterRealUser 找第一个，
              // 多 assistant 行时与 continuationTargetIndex（最后一个）错位：第一个非 incomplete →
              // return rows 不更新，最后一个保持终态 → streamContinuesAssistant=false →
              // streamRow 不合并 → 新轮次工具不显示。
              let lastRealUser = -1
              for (let i = rows.length - 1; i >= 0; i--) {
                if (
                  rows[i]?.role === 'user' &&
                  !isHiddenToolApprovalUserMessage(String(rows[i].text || ''))
                ) {
                  lastRealUser = i
                  break
                }
              }
              if (lastRealUser < 0) return rows
              let idx = -1
              for (let i = rows.length - 1; i > lastRealUser; i--) {
                if (rows[i]?.role === 'assistant') {
                  idx = i
                  break
                }
              }
              if (idx < 0) return rows
              const row = rows[idx]
              if (row?.role !== 'assistant') return rows
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
        if (
          aguiEvent.type === 'TOOL_CALL_START' ||
          aguiEvent.type === 'TOOL_CALL_ARGS' ||
          aguiEvent.type === 'TOOL_CALL_END' ||
          aguiEvent.type === 'TOOL_CALL_RESULT'
        ) {
          const evToolCallId = String(
            (aguiEvent as { toolCallId?: string }).toolCallId || '',
          ).trim()
          const evToolName = String(
            (aguiEvent as { toolCallName?: string }).toolCallName ||
              (evToolCallId ? S.aguiTurn?.toolCalls?.get(evToolCallId)?.toolCallName : '') ||
              '',
          )
            .trim()
            .toLowerCase()
          // Bind the browser panel to the engine session the tool will drive.
          // node-repl / browser-use always hits ``/api/browser/execute`` with the
          // fixed bridge thread id — using the chat thread here mounts a second
          // empty WebView2 the agent never controls.
          if (isBrowserToolWireName(evToolName)) {
            if (evToolName === 'mcp__node_repl__js') {
              if (setBrowserPanelThreadId(NODE_REPL_BRIDGE_THREAD_ID)) changed = true
            } else {
              const realTid = String(
                (S.aguiTurn as { threadId?: string } | null | undefined)?.threadId ||
                  (aguiEvent as { threadId?: string }).threadId ||
                  '',
              ).trim()
              if (setBrowserPanelThreadId(realTid)) changed = true
            }
          }
          syncWorkspacePreviewFromTools(S.turn.tools)
          syncStreamMediaAssetsFromTools(S)
          if (
            syncBrowserPanelFromAgUiEvent(aguiEvent, S.aguiTurn?.toolCalls, {
              // 事件归属会话：后台 agent 开浏览器不得写进当前正在看的会话侧栏。
              sessionKey: targetSk,
            })
          ) {
            changed = true
          }
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
              // Roster notify runs on every TOOL_CALL_RESULT (incl. background); skip here.
              const feedback = applyPlatformFeedbackFromToolResult(resultContent, {
                argsText,
                toolCallId,
                existingEntries: turnPlatformEntriesRef.current,
                notifyEmployeesRoster: false,
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
          if (toolName === 'platform') {
            const tc = toolCallId ? S.aguiTurn?.toolCalls?.get(toolCallId) : undefined
            const resultContent =
              typeof (aguiEvent as { content?: string }).content === 'string'
                ? (aguiEvent as { content?: string }).content
                : typeof tc?.result === 'string'
                  ? tc.result
                  : undefined
            const argsText = typeof tc?.argsText === 'string' ? tc.argsText : undefined
            syncEmployeesRosterFromToolResult(resultContent, { argsText })
          }
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
          // 兜底：drain 仅在 TOOL_CALL_START 触发（ChatApp.tsx#10127 shouldReleaseAgUiBufferBeforeToolStart），
          // 但每个 run 最后一轮完成后没有新 TOOL_CALL_START，那批 done 工具就永远滞留在 aguiTurn 里，
          // 落库时 row.tools 只看到中间 drain 出的 N-1 批，最后一批被吞。表现为「UI 只显示前 4 个工具」。
          // 在 RUN_FINISHED / RUN_ERROR 兜底把剩余 done 工具封到 compactedParts，让 finalize 阶段
          // mergeCompactedPartsIntoTurn 一起并入。
          if (S.aguiTurn) {
            finalizeGhostRunningToolsBeforeNewRound(S.aguiTurn)
            const drained = drainAgUiCompletedRound(S.aguiTurn)
            if (drained.sealed) {
              if (!S.compactedParts) S.compactedParts = []
              S.compactedParts.push(drained.sealed)
              S.aguiTurn = drained.fresh
              S.turn = syncStreamTurnFromAgUi(S.turn, S.aguiTurn)
              logStreamCompareAgUiDrain({
                sessionKey: targetSk,
                runId: String(S.runId || runId || '').trim() || undefined,
                sealed: drained.sealed,
                releasedToolIds: drained.releasedToolIds,
              })
            }
          }
          // 运行态收尾：
          // - RUN_ERROR：立刻 TURN_IDLE
          // - RUN_FINISHED：若 live POST /runs/stream 仍开着（streamWireSource==='run'），
          //   勿 idle。工具循环中间的 RUN_FINISHED 若提前 idle，侧栏/停止/「运行中」会灭，
          //   但 agui_event 仍豁免写入 → holdStreamResidue 继续流式渲染（切去任务中心再回来尤甚）。
          //   真正收尾交给 SSE final / 用户停止。
          if (rt && isTurnBusy(rt) && targetSk) {
            const isRunError = String(aguiEvent.type) === 'RUN_ERROR'
            const livePostOpen = rt.streamWireSource === 'run'
            if (!isRunError && livePostOpen) {
              dispatchSessionTurnEvent(targetSk, { type: 'SESSION_EVENT', at: Date.now() })
            } else {
              const endTrigger = isRunError ? 'agui_run_error' : 'agui_run_finished'
              logStreamStop({
                sessionKey: targetSk,
                runId: String(S.runId || runId || rt.activeChatRunId || '').trim() || null,
                trigger: endTrigger,
                hasEndMarker: true,
                detail: {
                  aguiType: String(aguiEvent.type || ''),
                  wasBusy: true,
                  livePostOpen,
                },
              })
              dispatchSessionTurnEvent(targetSk, { type: 'TURN_IDLE' })
            }
          }
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
        // 旧 endLiveStreamSession 已删：live-stream-store 没了
        endClientPerfTurn(String(runId || rt.activeChatRunId || targetSk))
        logStreamStop({
          sessionKey: targetSk,
          runId: String(runId || rt.activeChatRunId || S.runId || '').trim() || null,
          trigger: 'sse_final',
          hasEndMarker: true,
          detail: {
            turnPhase: rt.turnPhase,
            aguiFinished: !!S.aguiTurn?.finished,
            isBackground,
          },
        })
        // Early AG-UI RUN_FINISHED already idled; late SSE `final` must not SEALING→busy
        // or the stop button / gear flashes back on for the checkpoint tail.
        if (isTurnBusy(rt)) {
          markRunSealing(rt)
          dispatchSessionTurnEvent(targetSk, { type: 'SEALING' })
        }
        dispatchSessionTurnEvent(targetSk, { type: 'SESSION_EVENT', at: Date.now() })
        flushPendingSessionTitle()
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
                S,
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
          void syncSessionRowRef.current?.(targetSk)
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
          logStreamStop({
            sessionKey: targetSk,
            runId: stoppedRun,
            trigger: 'sse_aborted',
            hasEndMarker: false,
            detail: {
              turnPhase: rt.turnPhase,
              streamHealth: streamHealthRef.current,
              isBackground,
              hasVisibleContent: streamTurnHasVisibleContent(S.turn),
              note: 'SSE aborted 且非停止按钮路径（断流/后端取消/超时等）',
            },
          })
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
        logStreamStop({
          sessionKey: targetSk,
          runId: runId || S.runId || rt.activeChatRunId,
          trigger: 'sse_aborted_after_ui_stop',
          hasEndMarker: false,
          fromUiStopButton: true,
          detail: { isBackground, suppressToast: suppressNextAbortToastRef.current },
        })
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
          // 健康降级本身未必停轮；若随后无 final/abort，watchdog 会再打非正常停止
          if (isTurnBusy(rt)) {
            console.warn('[stream-stop] health_degraded status=disconnected', {
              sessionKey: targetSk,
              runId: runId || S.runId || rt.activeChatRunId,
              turnPhase: rt.turnPhase,
            })
          }
        } else if (healthStatus === 'silent') {
          if (!isBackground) streamHealthRef.current = 'silent'
          if (!isBackground) setStreamHealth('silent')
          if (isTurnBusy(rt)) {
            console.warn('[stream-stop] health_degraded status=silent', {
              sessionKey: targetSk,
              runId: runId || S.runId || rt.activeChatRunId,
              turnPhase: rt.turnPhase,
            })
          }
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
        if (/user[_\s-]*interrupt/i.test(rawErr)) {
          logStreamStop({
            sessionKey: targetSk,
            runId: runId || S.runId || rt.activeChatRunId,
            trigger: 'user_interrupt_error',
            hasEndMarker: false,
            fromUiStopButton: true,
            detail: {
              rawErr: rawErr.slice(0, 200),
              note: '后端报 user interrupt；通常紧随停止按钮，但也可能是别处 abort',
            },
          })
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
        if (rawErr) console.error('[ChatApp] stream error', rawErr, payload)
        const errMsg = toUserFacingError(rawErr || '未知错误')
        if (!errMsg) {
          scheduleBump({ immediate: true })
          return
        }
        const now = Date.now()
        if (lastErrorRef.current.msg === errMsg && now - lastErrorRef.current.ts < 2000) return
        lastErrorRef.current = { msg: errMsg, ts: now }
        logStreamStop({
          sessionKey: targetSk,
          runId: runId || S.runId || rt.activeChatRunId,
          trigger: 'stream_error',
          hasEndMarker: false,
          detail: {
            errMsg: errMsg.slice(0, 200),
            rawErr: rawErr.slice(0, 200),
            hasVisibleContent: streamTurnHasVisibleContent(S.turn),
            turnPhase: rt.turnPhase,
            isBackground,
          },
        })
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

  // Composer stop + sidebar gear + list isSending: selectedTurnBusy only.

  const selectedSessionLive = useMemo(() => {
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) return false
    const rt = getSessionRuntime(sk)
    if (rt.uiTurnSettled && !isTurnBusy(rt)) return false
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
  // 有内容却未揭开（含从知识库/任务中心切回时 --booting）：始终给加载提示，避免白屏无反馈
  const showHistorySyncHint = renderRows.length > 0 && !historyViewReady

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

  const sessionPersistedTokenTotals = useMemo(
    (): TokenTotals | null => buildSessionPersistedTokenTotals(selectedSessionKey, sessions),
    [selectedSessionKey, sessions],
  )

  const headerTokenTotals = useMemo(
    (): TokenTotals | null =>
      mergeHeaderTokenTotals(tokenTotals, sessionPersistedTokenTotals, liveTurnTokens),
    [tokenTotals, sessionPersistedTokenTotals, liveTurnTokens],
  )

  const displayContextUsage = useMemo(
    (): ContextUsageSnapshot | null =>
      resolveDisplayContextUsage({
        selectedSessionKey,
        contextUsageBySession,
        sessions,
        modelCatalog,
        effectiveModelName,
      }),
    [selectedSessionKey, contextUsageBySession, sessions, modelCatalog, effectiveModelName],
  )

  const [assetQuickBusy, setAssetQuickBusy] = useState(false)
  const handleAssetQuickAction = useCallback(
    async (kind: 'episode' | 'craft' | 'journal') => {
      await handleAssetQuickActionImpl(
        {
          employeeSessionAgentCode,
          isProactiveEmployeeSession,
          selectedTurnBusy,
          getApi,
          setAssetQuickBusy,
          sendMessage: (text) => handleSendRef.current(text),
        },
        kind,
      )
    },
    [isProactiveEmployeeSession, employeeSessionAgentCode, selectedTurnBusy, getApi],
  )

  // 首页不应出现右侧摘要/侧边面板：进入首页时主动折叠右栏（保留 tabs 缓存）。
  useEffect(() => {
    if (!isHomeSurface) return
    collapseRightStage()
  }, [isHomeSurface, collapseRightStage])

  // Rust CDP path emits this when the agent drives the browser before the
  // AG-UI TOOL_CALL_START has opened the side panel. Mount the bridge WebView2
  // immediately so ensure_webview_for_cdp can reuse a healthy HWND.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) return
    let cancelled = false
    let unlisten: (() => void) | undefined
    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<{ threadId?: string; url?: string }>('browser-panel-request', (ev) => {
          if (cancelled) return
          const tid =
            String(ev.payload?.threadId || '').trim() || NODE_REPL_BRIDGE_THREAD_ID
          const url = String(ev.payload?.url || '').trim()
          dbgLog(`[chat-app] browser-panel-request thread=${tid} url=${url || '(none)'}`)
          setBrowserPanelThreadId(tid)
          if (url && /^https?:\/\//i.test(url)) {
            applyBrowserCommandResponse({ threadId: tid, pageUrl: url })
          } else {
            ensureBrowserStage({
              sessionKey: rightStageSessionKeyRef.current || undefined,
            })
          }
        }),
      )
      .then((fn) => {
        if (cancelled) {
          fn()
          return
        }
        unlisten = fn
      })
      .catch((err) => {
        dbgLog(`[chat-app] browser-panel-request listen failed: ${String(err)}`)
      })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    if (normalizeRightStageKind(rightStageSurface?.kind || '') === 'artifacts') {
      hideRightStageIfKind('artifacts')
    }
  }, [rightStageSurface?.kind])

  // 切会话：复位「已手动关」标记，按初始默认行为（开 + 对应 tab）生效。
  // 之前这里无条件 setInfoRailOpen(true)，会在用户点关闭按钮后立刻被回滚，
  // 导致「点关闭没反应」的体验。改用 userClosedInfoRailRef 记录用户意图：
  // 仅在 ref 标记为「已手动关」时，跳过打开动作、保留用户的关闭状态。
  // 仅在 selectedSessionKey 真正变化时复位 ref（员工会话 ↔ 普通对话切换属于同一会话上下文，
  // 不应把用户刚关掉的侧栏强行打开）。
  const prevSelectedSessionKeyForInfoRailRef = useRef(selectedSessionKey)
  useEffect(() => {
    const sessionKeyChanged =
      prevSelectedSessionKeyForInfoRailRef.current !== selectedSessionKey
    prevSelectedSessionKeyForInfoRailRef.current = selectedSessionKey
    if (sessionKeyChanged) {
      userClosedInfoRailRef.current = false
    }
    if (userClosedInfoRailRef.current) {
      // 用户在当前会话主动关过：尊重意图，保持关闭，仅同步 tab。
      setInfoRailTab(isProactiveEmployeeSession ? 'task' : 'agent')
      return
    }
    setInfoRailOpen(true)
    setInfoRailTab(isProactiveEmployeeSession ? 'task' : 'agent')
  }, [selectedSessionKey, isProactiveEmployeeSession])

  const handleManualContextCompact = useCallback(async () => {
    await handleManualContextCompactImpl({
      selectedSessionKey,
      manualContextCompacting,
      setManualContextCompacting,
      setContextUsageBySession,
    })
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

  // 状态面板「进程」区：以 streamRef 为唯一真相源，按 chrome tick 取快照，
  // 避免另开 state 漏掉切会话/终态收束时的终端清理。
  const liveProcessPanelEnabled =
    chatPanelMode !== 'hidden' && !isHomeSurface && !!selectedSessionKey && !isMobileChat
  const backgroundWorksPollSigRef = useRef('')
  const backgroundOutputPollRef = useRef<{ workId: string; timer: number; stopAt: number } | null>(null)
  const liveProcessSnapshot = useLiveProcessSnapshot(
    streamRef,
    liveProcessPanelEnabled,
    selectedSessionKey,
  )

  useEffect(() => {
    if (!liveProcessPanelEnabled) return
    backgroundWorksPollSigRef.current = ''
    let cancelled = false
    let timer: number | null = null
    const clearTimer = () => {
      if (timer != null) {
        window.clearTimeout(timer)
        timer = null
      }
    }
    const tick = async () => {
      timer = null
      if (cancelled) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      try {
        const works = await listBackgroundBashWorks({
          runningOnly: true,
          threadId: selectedThreadId || undefined,
        })
        if (cancelled) return
        const S = streamRef.current
        if (!S) return
        if (!S.backgroundWorks) S.backgroundWorks = {}
        const signature = works
          .map((w) => `${w.workId}:${w.status}:${w.endedAt || 0}`)
          .sort()
          .join('|')
        const changed = signature !== backgroundWorksPollSigRef.current
        backgroundWorksPollSigRef.current = signature
        if (changed) {
          for (const w of works) {
            S.backgroundWorks[w.workId] = {
              workId: w.workId,
              kind: 'bash',
              title: w.title || w.command || w.workId,
              status: w.status || 'running',
              startedAt: w.startedAt || Date.now(),
              endedAt: w.endedAt,
              cancellable: w.status === 'running' && w.cancellable !== false,
              toolCallId: w.toolCallId || w.workId,
              command: w.command,
            }
          }
          const sk = String(selectedSessionKey || '').trim()
          if (sk) {
            streamSeqRef.current += 1
            commitStreamSnapshot(sk, S, { seq: streamSeqRef.current })
          }
        }
        const stillRunning = works.some((w) => String(w.status || 'running') === 'running')
        if (stillRunning && !cancelled) {
          timer = window.setTimeout(() => void tick(), 2000)
        }
      } catch {
        /* gateway may be down; a later background_work event retries */
      }
    }
    watchBackgroundBashRef.current = () => {
      if (cancelled || timer != null) return
      void tick()
    }
    void tick()
    return () => {
      cancelled = true
      watchBackgroundBashRef.current = null
      clearTimer()
    }
  }, [liveProcessPanelEnabled, selectedSessionKey, selectedThreadId])

  const handleStopProcessItem = useCallback(
    (item: ProcessItem) => {
      handleStopProcessItemImpl(
        {
          streamRef,
          sessionRef,
          streamSeqRef,
          scheduleBump,
        },
        item,
      )
    },
    [scheduleBump],
  )

  /** 点进程行：终端开右栏标签；智能体仍切到摘要区 */
  const handleOpenProcessItem = useCallback(
    (item: ProcessItem) => {
      handleOpenProcessItemImpl(
        {
          selectedSessionKey,
          streamRef,
          sessionRef,
          streamSeqRef,
          backgroundOutputPollRef,
          scheduleBump,
          setChatPanelDisplayMode,
          setInfoRailTab,
        },
        item,
      )
    },
    [selectedSessionKey, setChatPanelDisplayMode, scheduleBump],
  )

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

  const renderChatSummaryPanel = (mode: 'panel' | 'capsule'): ReactNode => (
    <ChatSummaryPanel
      displayMode={mode}
      onDisplayModeChange={setChatPanelDisplayMode}
      isRunning={selectedTurnBusy}
      sessionTitle={getDisplayLabel(
        selectedSessionKey,
        sessions.find((s) => String(s.sessionKey || '') === String(selectedSessionKey || ''))?.title,
      )}
      terminalStreams={liveProcessSnapshot.terminalStreams}
      subagentTasks={liveProcessSnapshot.subagentTasks}
      workflowSubtasks={sharedCollabSubtasks}
      backgroundWorks={liveProcessSnapshot.backgroundWorks}
      onOpenProcessItem={handleOpenProcessItem}
      onStopProcessItem={handleStopProcessItem}
      agentLabel={currentRoleLabel}
      modelLabel={modelPillLabel}
      modelName={effectiveModelName}
      agentCode={
        isProactiveEmployeeSession
          ? employeeSessionAgentCode || currentRoleCodeForUi
          : currentRoleCodeForUi
      }
      agentDescription={String(currentRoleAgent?.description || '').trim()}
      agent={currentRoleAgent}
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
      onSwitchAgent={
        isProactiveEmployeeSession ? undefined : () => setBottomRoleOpen(true)
      }
      onEditAgent={currentRoleCodeForUi || employeeSessionAgentCode ? openCurrentAgentEditor : undefined}
      onAssetQuickAction={handleAssetQuickAction}
      assetQuickBusy={assetQuickBusy}
      artifacts={sessionArtifacts}
      recentArtifacts={turnArtifacts}
      artifactFocusId={artifactFocusId}
      platformEntries={sessionPlatformEntries}
      recentPlatformEntries={turnPlatformEntries}
      platformFocusEntryId={platformFocusEntryId}
      onOpenArtifact={openSessionArtifact}
      onRevealArtifact={revealSessionArtifact}
      obsEnabled={obsEnabled}
      threadId={selectedThreadId}
      isEmployeeSession={isProactiveEmployeeSession}
      employeePane={
        isProactiveEmployeeSession ? (
          <EmployeePane
            employeeInfo={employeeRoleDetail}
            sessionTitle={getDisplayLabel(selectedSessionKey, '')}
            isRunning={selectedTurnBusy}
            agentLabel={currentRoleLabel}
            modelLabel={modelPillLabel}
            agentCode={employeeSessionAgentCode || currentRoleCodeForUi}
            agentDescription={String(currentRoleAgent?.description || '').trim()}
            agent={currentRoleAgent}
            skillNames={currentAgentCapabilities.skillNames}
            toolNames={currentAgentCapabilities.toolNames}
            mcpServers={currentAgentCapabilities.mcpServers}
            knowledgeVaultIds={
              employeeRoleDetail?.knowledgeVaultIds ||
              currentAgentCapabilities.knowledgeVaultIds
            }
            onPatchCapabilities={patchCurrentAgentCapabilities}
            capabilityBusy={capabilityPatchBusy}
            modelName={effectiveModelName}
            contextUsage={displayContextUsage}
            tokenTotals={headerTokenTotals}
            onManualCompact={handleManualContextCompact}
            manualCompactDisabled={manualContextCompacting}
            onEditAgent={openCurrentAgentEditor}
            onAssetQuickAction={handleAssetQuickAction}
            assetQuickBusy={assetQuickBusy}
          />
        ) : null
      }
      taskPane={
        isProactiveEmployeeSession ? (
          <TaskPane
            sessionTitle={getDisplayLabel(selectedSessionKey, '')}
            isRunning={selectedTurnBusy}
            tokenTotals={headerTokenTotals}
            agentCode={employeeSessionAgentCode || currentRoleCodeForUi}
            sessionKey={String(selectedSessionKey || '')}
            liveTask={sidebarActiveView?.task || null}
          />
        ) : null
      }
    />
  )

  const renderRightStageBody = useCallback(
    (surface: RightStageSurface): ReactNode => {
      const kind = surface.kind
      if (kind === 'summary') {
        return null
      }
      if (kind === 'terminal') {
        const data = surface.data || {}
        const toolCallId = String(data.toolCallId || surface.id || '').trim()
        const command = String(data.command || '').trim()
        const streams = liveProcessSnapshot.terminalStreams || {}
        const stream =
          streams[toolCallId] ||
          Object.values(streams).find(
            (s) =>
              String(s?.toolCallId || '') === toolCallId ||
              String((s as { id?: string })?.id || '') === toolCallId,
          ) ||
          undefined
        return (
          <TerminalStagePanel
            title={String(surface.title || data.title || '终端')}
            command={command}
            sessionKey={String(data.sessionKey || selectedSessionKey || '')}
            toolCallId={toolCallId}
            outputFallback={String(data.outputFallback || '')}
            stream={stream}
            running={!!data.running || stream?.phase === 'running'}
          />
        )
      }
      if (kind === 'file') {
        const data = surface.data || {}
        const path = String(data.path || surface.id || '').trim()
        const name = String(data.name || surface.title || '').trim()
        if (!path) return null
        const focusAnnotation =
          data.focusAnnotation && typeof data.focusAnnotation === 'object'
            ? (data.focusAnnotation as { title?: string; body?: string; priority?: number })
            : undefined
        const scope = workspaceOpenScopeRef.current
        const root = String(scope.root || effectiveWorkspaceRoot || '').trim()
        return sidePanelHeavyMount ? (
          <WorkspaceFilePreviewPanel
            embedded
            workspaceRoot={root}
            threadId={
              root ? undefined : wsClient.getSessionThreadId(selectedSessionKey || '') || undefined
            }
            workspaceScopeOpts={{
              configuredRoot: scope.configuredRoot,
              useVirtualPaths: scope.useVirtualPaths,
            }}
            path={path}
            name={name}
            poll={!!data.poll}
            focusLine={typeof data.focusLine === 'number' ? data.focusLine : undefined}
            focusEndLine={typeof data.focusEndLine === 'number' ? data.focusEndLine : undefined}
            focusAnnotation={focusAnnotation}
            onClose={() => {
              rightStageStore.closeTab(`file:${path.replace(/\\/g, '/')}`)
            }}
          />
        ) : (
          <SidePanelBootShell title={name || '文件预览'} className="react-chat-workspace-preview-stage" />
        )
      }
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
      selectedTurnBusy,
      selectedSessionKey,
      sessions,
      liveProcessSnapshot.terminalStreams,
      liveProcessSnapshot.subagentTasks,
      sharedCollabSubtasks,
      handleOpenProcessItem,
      currentRoleLabel,
      modelPillLabel,
      effectiveModelName,
      isProactiveEmployeeSession,
      employeeSessionAgentCode,
      currentRoleCodeForUi,
      currentRoleAgent,
      currentAgentCapabilities,
      employeeRoleDetail,
      patchCurrentAgentCapabilities,
      capabilityPatchBusy,
      openCurrentAgentEditor,
      handleAssetQuickAction,
      assetQuickBusy,
      sessionArtifacts,
      turnArtifacts,
      artifactFocusId,
      sessionPlatformEntries,
      turnPlatformEntries,
      platformFocusEntryId,
      openSessionArtifact,
      revealSessionArtifact,
      obsEnabled,
      selectedThreadId,
      displayContextUsage,
      headerTokenTotals,
      handleManualContextCompact,
      manualContextCompacting,
      sidebarActiveView?.task,
      effectiveWorkspaceRoot,
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
      threadPanelState.collabTask,
      threadPanelState.collabPhase,
      threadPanelState.collabSubtasks,
      threadPanelState.subagentTasks,
      chatThreadIdForSidebar,
      sharedCollabMainTask,
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

  

  const knowledgeMapToggleTitle = knowledgeMapPanelOpen ? '隐藏思维导图' : '显示思维导图'

  

  // 浏览器面板头部开关：存在则激活，再点一次关掉这一页（不关整栏其它标签）
  const visibleRightStageTabs = useMemo(
    () => filterRightStageTabsForSession(rightStageTabs, selectedSessionKey),
    [rightStageTabs, selectedSessionKey],
  )
  const browserStageOpen = visibleRightStageTabs.some(
    (t) => normalizeRightStageKind(t.kind) === 'browser',
  )
  const browserStageActive =
    normalizeRightStageKind(rightStageSurface?.kind || '') === 'browser'
  const toggleBrowserStage = useCallback(() => {
    toggleBrowserStageImpl({
      selectedSessionKey,
      scheduleBumpRef,
      closeBrowserStage,
      setBrowserPanelThreadId,
      getSessionThreadId: (sk) => wsClient.getSessionThreadId(sk),
      ensureBrowserStage,
    })
  }, [selectedSessionKey])
  const browserToggleTitle = browserStageOpen ? '隐藏浏览器' : '打开浏览器'
  const browserToggleButton = (
    <button
      type="button"
      className={`react-chat-header-icon-btn react-chat-browser-stage-toggle-btn${
        browserStageActive ? ' is-active' : ''
      }`}
      title={browserToggleTitle}
      aria-label={browserToggleTitle}
      aria-pressed={browserStageOpen}
      onClick={toggleBrowserStage}
    >
      <Globe className="react-chat-header-icon" aria-hidden />
    </button>
  )

  /** 折叠侧栏：保留 tabs 缓存，对齐 ZCode collapse（不是 hideAll）。 */
  const handleCollapseRightStage = useCallback(() => {
    collapseRightStageShellImpl({
      rightStageUserPinnedRef,
      scheduleBumpRef,
      collapseRightStage,
      syncShellAsideForWorkspacePanel,
    })
  }, [collapseRightStage, syncShellAsideForWorkspacePanel])

  const handleExpandRightStage = useCallback(() => {
    expandRightStageShellImpl({
      chatPanelMode,
      scheduleBumpRef,
      expandRightStage,
      setChatPanelMode,
      setInfoRailOpen,
    })
  }, [expandRightStage, chatPanelMode])


  /**
   * 顶栏 PanelRight：对齐 ZCode 侧栏开关。
   * 展开 → 右侧壳（无标签时显示「打开标签」首页）；折叠 → 只藏面板，tabs 缓存保留。
   */
  const toggleInfoRail = useCallback(() => {
    if (rightStageOpen) {
      handleCollapseRightStage()
      userClosedInfoRailRef.current = false
      return
    }
    handleExpandRightStage()
    userClosedInfoRailRef.current = true
  }, [rightStageOpen, handleCollapseRightStage, handleExpandRightStage])

  /** 右侧空白里的悬浮状态卡；专用侧栏打开时让位，互斥不叠放。 */
  const showChatSummaryFloat =
    chatPanelMode !== 'hidden' &&
    !rightStageOpen &&
    !isHomeSurface &&
    !isMobileChat &&
    !!selectedSessionKey

  const infoRailHeaderToggle = (
    <button
      type="button"
      className={`react-chat-header-icon-btn${rightStageOpen ? ' is-active' : ''}`}
      title={rightStageOpen ? '收起右侧面板' : '打开右侧面板'}
      aria-pressed={rightStageOpen}
      aria-label={rightStageOpen ? '收起右侧面板' : '打开右侧面板'}
      data-info-rail-open={rightStageOpen ? 'true' : 'false'}
      data-right-stage-open={rightStageOpen ? 'true' : 'false'}
      onClick={toggleInfoRail}
    >
      {rightStageOpen ? (
        <PanelRightClose className="react-chat-header-icon" aria-hidden />
      ) : (
        <PanelRightOpen className="react-chat-header-icon" aria-hidden />
      )}
    </button>
  )

  const rightStageLauncherItems = useMemo(
    () =>
      buildDefaultRightStageLauncherItems({
        onOpenBrowser: () => {
          const manualTid = String(wsClient.getSessionThreadId(selectedSessionKey || '') || '').trim()
          if (manualTid) setBrowserPanelThreadId(manualTid)
          ensureBrowserStage({
            forceNew: true,
            sessionKey: selectedSessionKey || undefined,
          })
        },
        onOpenWorkspace: () => {
          rightStageUserPinnedRef.current = 'workspace-browse'
          setWorkspacePanelOpen(true)
          setWorkspaceTreePinned(true)
          syncShellAsideForWorkspacePanel(true)
        },
        onOpenWorkflow: () => {
          openCollabExecPanel()
        },
        onOpenSummary: () => {
          setChatPanelDisplayMode('panel')
        },
        mindMapEnabled: knowledgeMapEnabled,
        onOpenMindMap: () => {
          openKnowledgeMapPanel()
        },
      }),
    [
      selectedSessionKey,
      setWorkspacePanelOpen,
      syncShellAsideForWorkspacePanel,
      openCollabExecPanel,
      knowledgeMapEnabled,
      openKnowledgeMapPanel,
      setChatPanelDisplayMode,
    ],
  )

  /** 标签 ×：按 kind 走既有清理，再 closeTab；不能只删列表项丢掉 write/dismiss 状态。 */
  const handleCloseRightStageTab = useCallback(
    (key: string) => {
      closeRightStageTabByKeyImpl(
        {
          dismissedRightStageKindsRef,
          rightStageUserPinnedRef,
          userClosedInfoRailRef,
          closeWorkspacePanel,
          closeCollabExecPanel,
          closeKnowledgeMapPanel,
          closeBrowserStage,
          closeSummaryStage,
          closeRightStageTab,
          setInfoRailOpen,
        },
        key,
      )
    },
    [
      closeWorkspacePanel,
      closeCollabExecPanel,
      closeKnowledgeMapPanel,
      closeRightStageTab,
    ],
  )

  const handleCloseOtherRightStageTabs = useCallback(
    (keepKey: string) => {
      const keep = String(keepKey || '').trim()
      if (!keep) return
      for (const tab of visibleRightStageTabs) {
        const key = `${normalizeRightStageKind(tab.kind)}:${tab.id}`
        if (key !== keep) handleCloseRightStageTab(key)
      }
    },
    [visibleRightStageTabs, handleCloseRightStageTab],
  )

  const handleCloseAllRightStageTabs = useCallback(() => {
    for (const tab of [...visibleRightStageTabs]) {
      handleCloseRightStageTab(`${normalizeRightStageKind(tab.kind)}:${tab.id}`)
    }
  }, [visibleRightStageTabs, handleCloseRightStageTab])

  const workspaceStageActive =
    normalizeRightStageKind(rightStageSurface?.kind || '') === 'workspace-browse' ||
    normalizeRightStageKind(rightStageSurface?.kind || '') === 'write'
  const workspaceFolderToggleTitle = workspacePanelOpen ? '隐藏工作区文件' : '显示工作区文件'

  const workspaceFolderToggleButton = (
    <button
      type="button"
      className={`react-chat-header-icon-btn react-chat-workspace-folder-btn${
        workspaceStageActive ? ' is-active' : ''
      }`}
      title={workspaceFolderToggleTitle}
      aria-label={workspaceFolderToggleTitle}
      aria-pressed={workspacePanelOpen}
      onClick={toggleWorkspacePanel}
    >
      <Folder className="react-chat-header-icon" aria-hidden />
    </button>
  )

  /**
   * ZCode 式成组按钮：主按钮直接「在资源管理器中打开」，右侧 chevron 弹下拉给出
   * 「显示工作区文件」等次级入口。两键共享一个描边圆角容器。
   */
  const workspaceFolderGroup = (
    <div className="react-chat-header-btn-group">      <button
        type="button"
        className="react-chat-header-icon-btn react-chat-header-btn-group-main"
        data-tauri-no-drag
        title="在资源管理器中打开工作区"
        aria-label="在资源管理器中打开工作区"
        onClick={() => {
          void openCurrentWorkspaceInFileManager()
        }}
      >
        <FolderOpen className="react-chat-header-icon" aria-hidden />
      </button>
      <button
        type="button"
        className="react-chat-header-icon-btn react-chat-header-btn-group-more"
        data-tauri-no-drag
        title="选择打开方式"
        aria-label="选择打开方式"
        aria-haspopup="menu"
        aria-expanded={workspaceFolderMenuOpen}
        onClick={() => setWorkspaceFolderMenuOpen((v) => !v)}
      >
        <ChevronDown className="react-chat-header-icon react-chat-header-icon--xs" aria-hidden />
      </button>
      {workspaceFolderMenuOpen ? (
        <>
          {/* 点击遮罩关闭：不用 Radix 是为了避免为一处下拉再引依赖，
              这里用透明遮罩 + z-index 达到同样效果，Esc 由下面的 onKeyDown 兜底。 */}
          <div
            className="react-chat-header-menu-scrim"
            onClick={() => setWorkspaceFolderMenuOpen(false)}
            aria-hidden="true"
          />
          <div className="react-chat-header-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              className="react-chat-header-menu-item"
              onClick={() => {
                setWorkspaceFolderMenuOpen(false)
                toggleWorkspacePanel()
              }}
            >
              <Folder className="react-chat-header-icon" aria-hidden />
              <span>{workspaceFolderToggleTitle}</span>
            </button>
          </div>
        </>
      ) : null}
    </div>
  )

  // 顶栏下拉：Esc 关闭。遮罩只处理点击，键盘用户需要这条通路。
  useEffect(() => {
    if (!workspaceFolderMenuOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setWorkspaceFolderMenuOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [workspaceFolderMenuOpen])

  
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
        // Defer list refresh so home dashboard first paint is not contending for Gateway.
        window.setTimeout(() => {
          void refreshSessions({ skipAutoReselect: true })
        }, 300)
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
      // Before adopt: known-empty latch keeps home surface mounted (no historyLoading skeleton).
      markSessionKnownEmpty(key)
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

  async function applyMoreMenuSessionApprovalPolicy(
    presetId: string,
    opts?: { quiet?: boolean },
  ): Promise<void> {
    const sk = (await ensureChatSessionKey()) || sessionRef.current || selectedSessionKey
    if (!sk) return
    const [{ patchSessionPermissionPreset }, { wsClient: wsClientMod }] = await Promise.all([
      import('../lib/tool-approval-settings.js'),
      import('../lib/ws-client.js'),
    ])
    let result
    try {
      result = await patchSessionPermissionPreset(sk, presetId)
    } catch (err) {
      // 静默失败会让用户以为已保存（刷新后回跳旧档位）——必须可见。
      toast(
        `权限档位保存失败：${toUserFacingError((err as Error)?.message || err)}`,
        'error',
      )
      throw err
    }
    // Force local context so session-list refresh cannot fall back to global grant_all.
    wsClientMod.applySessionToolApprovalPolicy(sk, {
      ...result,
      permission_preset: result.permission_preset || presetId,
      effective_permission_preset: result.effective_permission_preset || presetId,
    })
    const effPreset = result.effective_permission_preset || presetId
    const explicitPreset = result.permission_preset || presetId
    setSessions((prev) =>
      prev.map((s) => {
        if (String(s.sessionKey || '') !== sk) return s
        const ctx: Record<string, unknown> =
          s.context && typeof s.context === 'object' ? { ...s.context } : {}
        ctx.permission_preset = explicitPreset
        ctx.effective_permission_preset = effPreset
        if (result.tool_approval_policy) {
          ctx.tool_approval_policy = result.tool_approval_policy
        }
        const effPolicy = result.effective_policy || result.tool_approval_policy
        if (effPolicy) {
          ctx.effective_tool_approval_policy = effPolicy
        }
        return { ...s, context: ctx }
      }),
    )
    setToolApprovalPolicyTick((n) => n + 1)
    if (!opts?.quiet) {
      toast(permissionPresetToast(presetId as Parameters<typeof permissionPresetToast>[0]), 'success')
    }
  }

  // 当前 session 的有效权限档位（sessions 行 context + wsClient 会话映射）。
  // PATCH 成功后 wsClient 映射即时同步，而 sessions 行可能被 in-flight 的旧列表
  // 响应覆盖回旧值（stale ctx）——wsClient 值优先，避免档位显示回跳。
  const currentPermissionPresetId = useMemo(() => {
    void toolApprovalPolicyTick
    const row = selectedSessionKey
      ? sessions.find((s) => String(s.sessionKey || '') === selectedSessionKey) ?? null
      : null
    const base: Record<string, unknown> =
      row?.context && typeof row.context === 'object' ? { ...row.context } : {}
    try {
      const wsCtx = wsClient.getSessionContext(selectedSessionKey) as
        | Record<string, unknown>
        | null
      for (const k of [
        'effective_permission_preset',
        'permission_preset',
        'effective_tool_approval_policy',
        'tool_approval_policy',
      ]) {
        const v = wsCtx ? wsCtx[k] : undefined
        if (v != null && String(v).trim()) base[k] = v
      }
    } catch {
      /* ignore */
    }
    return resolvePermissionPreset(base)
  }, [selectedSessionKey, sessions, toolApprovalPolicyTick])

  const currentPermissionPillLabel = useMemo(() => {
    const preset = PERMISSION_PRESETS.find((p) => p.id === currentPermissionPresetId)
    return preset?.pillLabel ?? preset?.label ?? '帮我批准'
  }, [currentPermissionPresetId])

  // 点击权限 pill：切换上拉菜单（与其他底部菜单互斥）
  function togglePermissionMenu(): void {
    setBottomPermissionOpen((v) => {
      const next = !v
      if (next) {
        // 打开时再拉一次全局默认，避免设置页改过而聊天菜单开关仍停在旧缓存
        void fetchGlobalToolApprovalPolicy().catch(() => {})
        if (selectedSessionKey) {
          void fetchSessionToolApprovalPolicy(selectedSessionKey)
            .then((result) => {
              wsClient.applySessionToolApprovalPolicy(selectedSessionKey, result)
              setToolApprovalPolicyTick((n) => n + 1)
            })
            .catch(() => {})
        }
      }
      return next
    })
    setModeMenuOpen(false)
    setBottomModelOpen(false)
    setBottomMoreOpen(false)
    setBottomWorkspaceOpen(false)
    setBottomRoleOpen(false)
  }

  /** 选择一个档位：调用已有的 applyMoreMenuSessionApprovalPolicy 并关闭菜单 */
  async function pickPermissionPreset(presetId: string): Promise<void> {
    setBottomPermissionOpen(false)
    await applyMoreMenuSessionApprovalPolicy(presetId)
  }

  /** 与安全中心「新对话默认完全访问」同一全局策略 */
  const newChatGrantAllDefault = useMemo(() => {
    void toolApprovalPolicyTick
    return isToolApprovalDisabled(getCachedGlobalToolApprovalPolicy())
  }, [toolApprovalPolicyTick])

  /**
   * 开启「完全访问」后立刻对本会话生效：切档位 + 放行已挂起的工具审批。
   * 仅改全局默认而不动当前会话时，对话中仍会继续弹「需要权限」——用户会感觉开关没反应。
   */
  async function applyFullAccessToCurrentSession(opts?: { quiet?: boolean }): Promise<void> {
    try {
      await applyMoreMenuSessionApprovalPolicy(PERMISSION_PRESET_FULL_ACCESS, {
        quiet: !!opts?.quiet,
      })
    } catch {
      return
    }
    const pendingVisible = collectPendingApprovalsForDock({
      streamTools: (streamRef.current?.turn.tools as unknown[]) || [],
      rows: rowsRef.current,
      isSending: turnBusyForSession(sessionRef.current),
      excludeToolCallIds: toolApprovalResolvedIdsRef.current,
    })
    if (pendingVisible.length) {
      suppressToolApprovalToastRef.current = true
      try {
        await handleToolApproval('grant_all')
      } finally {
        suppressToolApprovalToastRef.current = false
      }
    }
  }
  applyFullAccessToCurrentSessionRef.current = applyFullAccessToCurrentSession

  async function toggleNewChatGrantAllDefault(next: boolean): Promise<void> {
    const policy = next ? TOOL_APPROVAL_POLICY_GRANT_ALL : TOOL_APPROVAL_POLICY_SESSION
    try {
      await patchGlobalToolApprovalPolicy(policy)
      setToolApprovalPolicyTick((n) => n + 1)
      if (next) {
        await applyFullAccessToCurrentSession({ quiet: true })
        toast('已开启：新对话默认完全访问；本会话已切换为完全访问', 'success')
      } else {
        toast('新对话默认：帮我批准（风险操作询问）', 'success')
      }
    } catch (err) {
      toast(String((err as Error)?.message || err) || '保存失败', 'error')
      void fetchGlobalToolApprovalPolicy().catch(() => {})
    }
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
      /** 外部传入的插件选择（优先于 selectedPlugins 状态） */
      pluginsOverride?: PluginSelection[]
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
    if (pendingNewSessionRef.current && getGlobalCreateSessionInflight()) {
      await getGlobalCreateSessionInflight()
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
    bumpClarifyResolveSeq(sessionKey)
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
    // 选中插件时：run context 传 preferred_plugins，后端按轮注入组件元数据；仅本轮消息 /命令名 调用的命令才注入正文
    let preferredPluginIds: string[] = []
    const activePlugins = opts?.pluginsOverride ?? selectedPlugins
    if (activePlugins.length > 0 && userMessage.trim()) {
      preferredPluginIds = activePlugins.map((p) => String(p.id || '').trim()).filter(Boolean)
      void persistSelectedPlugins(sessionKey, activePlugins)
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
    // 消息已确认发出：隐藏已选插件 pills。粘性选择仍保留，下次再点选时才会重新展示。
    setPluginComposerPillsVisible(false)
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
    resetStreamStopLogDedupe(sessionKey)
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
      streamRefKeyRef.current = sessionKey
      // 如果当前没有活跃会话但我们正在发送消息，立即同步 sessionRef 到目标会话
      // 这确保后续流事件能正确路由
      if (noActiveSession) {
        sessionRef.current = sessionKey
      }
      // flushSync：用户气泡同帧出现，工作台→对话不再「空等一拍」
      flushSync(() => {
        setSessionHadContent(true)
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
      })
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
          preferredPlugins?: string[]
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
          ...(preferredPluginIds.length ? { preferredPlugins: preferredPluginIds } : {}),
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
        console.error('[ChatApp] send failed', e)
        toast(toUserFacingError((e as Error)?.message || e), 'error')
        rtSend.rows = preSendRows
        rtSend.stream = emptyStream()
        rtSend.priorTurnStrip = { body: '', reasoning: '', toolIds: [] }
        dispatchSessionTurnEvent(sessionKey, { type: 'SEND_FAILED' })
        dispatchSessionRunEnded(sessionKey)
        clearSessionExecutionStateForEnded(sessionKey)
        if (String(sessionRef.current || '').trim() === sessionKey) {
          streamRef.current = rtSend.stream
          streamRefKeyRef.current = sessionKey
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
      const notify = (message: string, kind: 'info' | 'success' | 'error' = 'info') => {
        if (!suppressToolApprovalToastRef.current) toast(message, kind)
      }
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
        if (action === 'grant_all') {
          // 后端已落 grant_all；本地 pill / context 立刻对齐，避免仍显示「帮我批准」
          try {
            await applyMoreMenuSessionApprovalPolicy(PERMISSION_PRESET_FULL_ACCESS, {
              quiet: true,
            })
          } catch {
            /* 审批已成功；档位同步失败不阻断续流 */
          }
        }
      } else if (action === 'deny') {
        markResolved([tcKey])
        patchLocalToolApprovalStatus([tcKey], 'denied')
        notify(res?.message || '已拒绝', 'info')
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
        notify(res?.message || '已批准，正在执行…', 'info')
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
        notify(res?.message || '已批准，正在执行…', 'info')
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
        notify(res?.message || '已记录授权，同一条流继续…', 'info')
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
            .map((item: { text?: string; messageId?: string }) => ({
              messageId: String(item?.messageId || '').trim(),
              text: String(item?.text || '').trim(),
            }))
            .filter((item) => item.text && !isTaskNotificationInject(item))
            .map((item) => item.text)
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

  function resetChatSurfaceForNewDraft() {
    streamRef.current = emptyStream()
    streamRefKeyRef.current = ''
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
    // flushSync：侧栏「+」/新建必须同帧切到空白草稿，否则下一帧前像没点上
    sessionRef.current = ''
    flushSync(() => {
      setSelectedSessionKey('')
      setNewChatButtonActive(true)
      setSessionHadContent(false)
      if (workspacePath) {
        setLocalWorkspaceRoot(String(workspacePath).trim())
      } else {
        setLocalWorkspaceRoot('')
      }
    })
    resetChatSurfaceForNewDraft()
    // 已在空工作台时视觉变化小：聚焦输入框，避免「点了没反应」
    queueMicrotask(() => {
      try {
        const el = document.querySelector(
          '.evo-home-composer__input, .react-chat-composer-input, textarea.react-chat-input',
        ) as HTMLTextAreaElement | HTMLInputElement | null
        el?.focus?.()
      } catch {
        /* ignore */
      }
    })
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

  startNewSessionWithWorkspaceRef.current = startNewSessionWithWorkspace

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
    await handleDeleteSessionImpl(
      {
        selectedSessionKey,
        deleteSessionConfirmInflightRef,
        sessionRef,
        streamRef,
        streamRefKeyRef,
        seenRunIdsRef,
        rowsRef,
        seenArtifactsRef,
        composerDraftsRef,
        bumpStreamFullRef,
        setMoreMenuKey,
        setSelectedSessionKey,
        setNewChatButtonActive,
        setRows,
        setTokenTotals,
        setLiveTurnTokens,
        setSubagentDockTasks,
        setSidebarTaskViews,
        setSidebarSelectedTaskId,
        setThreadPanelState,
        setHasReceivedTodos,
        setBoundTaskId,
        removeSessionFromList,
        refreshSessions,
      },
      key,
    )
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
    // 等价旧 pruneLiveStreams：用 stream-snapshot-store 的 prune 接口
    pruneStreamSnapshots(keep)
    for (const sk of [...seenArtifactsRef.current.keys()]) {
      if (!keep.has(sk)) seenArtifactsRef.current.delete(sk)
    }
  }, [sessions, selectedSessionKey])

  const onShellPinSession = useCallback((key: string, pinned: boolean) => {
    onShellPinSessionImpl(setSessions, key, pinned)
  }, [setSessions])

  const onShellDeleteSession = useCallback((k: string) => {
    void handleDeleteSessionRef.current?.(k)
  }, [])

  const onShellRefreshSession = useCallback(async (k: string) => {
    await onShellRefreshSessionImpl(
      {
        sessionRef,
        setMoreMenuKey,
        setSelectedSessionKey,
        runShellSessionRefresh: async (sk) => {
          await runShellSessionRefreshRef.current?.(sk)
        },
      },
      k,
    )
  }, [setMoreMenuKey, setSelectedSessionKey])

  const onShellRefreshSessionList = useCallback(async () => {
    await onShellRefreshSessionListImpl({
      sessionRef,
      refreshSessions: async () => {
        await refreshSessionsRef.current?.()
      },
      loadProactiveRoles,
      runShellSessionRefresh: async (sk) => {
        await runShellSessionRefreshRef.current?.(sk)
      },
    })
  }, [loadProactiveRoles])

  // 自愈：SSE 会话变更事件偶尔丢失（窗口假死/后台标签错过推送）会让会话列表停在旧状态。
  // 窗口重新聚焦或每 60s 轻量刷新一次会话列表，保证列表最终一致。
  // v5.10：选中的会话本地仍在流式时跳过单会话刷新 —— 该刷新走 dbOnly 强制重载，
  // 会把 live 视图（pin 行 + 合并态）替换成 DB 视图，用户看到「最新内容消失」；
  // 流式期间的 live 视图本就是最新数据，无需 DB 对账。
  useEffect(() => {
    let disposed = false
    const heal = () => {
      if (disposed) return
      void onShellRefreshSessionList().catch(() => {})
    }
    const healSelectedSession = () => {
      const sel = sessionRef.current
      if (!sel) {
        heal()
        return
      }
      // 会话列表始终刷（轻量）；单会话对账仅在非流式时执行
      void refreshSessionsRef.current?.().catch(() => {})
      try {
        const rt = getSessionRuntime(sel)
        // live POST 未关或本地仍 busy/live：dbOnly 刷新会清 pin / 误 TURN_IDLE
        if (
          isSessionRuntimeLive(rt) ||
          turnBusyForSession(sel) ||
          rt.streamWireSource === 'run'
        ) {
          return
        }
      } catch {
        /* store 不可达时按原行为刷新 */
      }
      void runShellSessionRefreshRef.current?.(sel).catch(() => {})
    }
    const onFocus = () => {
      healSelectedSession()
    }
    window.addEventListener('focus', onFocus)
    const timer = window.setInterval(healSelectedSession, 60_000)
    return () => {
      disposed = true
      window.removeEventListener('focus', onFocus)
      window.clearInterval(timer)
    }
  }, [])

  const onShellStopSession = useCallback(async (k: string) => {
    await onShellStopSessionImpl(
      {
        setMoreMenuKey,
        stopSessionExecution: async (sk) => {
          await stopSessionExecutionRef.current?.(sk)
        },
      },
      k,
    )
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
      selectSessionFromShellImpl(
        {
          sessionRef,
          setShellSelectRevision,
          setNewChatButtonActive,
          setMoreMenuKey,
          setSelectedSessionKey,
          setMobileChatPane,
        },
        sessionKey,
      )
    },
    [setNewChatButtonActive, setSelectedSessionKey, setMoreMenuKey],
  )
  selectSessionFromShellRef.current = selectSessionFromShell

  const onShellForkSession = useCallback(async (k: string) => {
    const key = String(k || '').trim()
    if (!key) return
    setMoreMenuKey(null)
    await forkSessionByKeyImpl(
      {
        refreshSessions: async (opts) => {
          await refreshSessionsRef.current?.(opts)
        },
        selectSession: (sessionKey) => selectSessionFromShellRef.current(sessionKey),
      },
      key,
    )
  }, [setMoreMenuKey])


  const handleForkFromMessage = useCallback(async (messageId?: string) => {
    const key = String(selectedSessionKey || '').trim()
    if (!key) return
    await forkSessionByKeyImpl(
      {
        refreshSessions: async (opts) => {
          await refreshSessionsRef.current?.(opts)
        },
        selectSession: (sessionKey) => selectSessionFromShellRef.current(sessionKey),
      },
      key,
      {
        throughMessageId: messageId,
        successToast: '已从此处分叉会话',
      },
    )
  }, [selectedSessionKey])


  handleEditMessageRef.current = async (text: string, messageId?: string, images?: Array<{ mediaType: string; data?: string; url?: string }>) => {
    await handleEditMessageImpl(
      {
        selectedSessionKey,
        sessionRef,
        rowsRef,
        seenRunIdsRef,
        activeChatRunIdRef,
        setRows,
        handleSend: (draft, attachments) => handleSendRef.current?.(draft, attachments),
      },
      text,
      messageId,
      images,
    )
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
      // 任务中心等路由回来：恢复所有 live POST 仍开着却被误 idle 的会话
      reviveAllTurnBusyIfLivePostOpen()
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
        {/*
         * ZCode 对齐：会话区包在 section 里，右侧面板打开时加 rounded border。
         * data-workspace-conversation-frame 供 CSS 选择器精确定位。
         */}
        <section
          data-workspace-conversation-frame="true"
          className={`react-chat-conversation-frame${
            anyRightPanelOpen && layoutResizeEnabled && rightPanelWidthPx != null
              ? ' is-rounded'
              : ''
          }`}
        >
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
                {/* ZCode 式顶栏：左区「工作区路径 + 标题 + 更多」整体 no-drag，
                    中间留大片 drag 空白，右侧动作区与窗控各自成组。 */}
                <div className="react-chat-header-toolbar" {...TAURI_HEADER_CELL_DRAG_PROPS}>
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
                    {workspaceFolderGroup}
                    <span className="react-chat-header-action-sep" aria-hidden />
                    <div className="react-chat-header-action-group react-chat-header-action-group--global">
                      {browserToggleButton}
                      {infoRailHeaderToggle}
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
                  title="展开侧栏"
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
                  {browserToggleButton}
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
              showChatSummaryFloat ? ' is-chat-summary-split' : ''
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
                homeWorkspaceLabel={homeWorkspaceLabel}
                homeWorkspacePath={effectiveWorkspaceRoot}
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
            {pluginComposerPillsVisible && selectedPlugins.length > 0 ? (
              <div className="react-chat-skill-composer-pills" aria-label="已选插件">
                <span className="react-chat-context-pills-label">
                  已选 {selectedPlugins.length} 个插件，发送时自动注入 Agent
                </span>
                {selectedPlugins.map((pl) => (
                  <HoverBubble key={pl.id} text={`插件：${pl.label}`} side="top" align="start" maxWidth={320}>
                    <button
                      type="button"
                      className="react-chat-skill-composer-pill"
                      onClick={() => removeSelectedPlugin(pl.id)}
                    >
                      <span
                        className="react-chat-skill-composer-pill-icon"
                        aria-hidden
                        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                      >
                        <PluginPillIcon pluginId={pl.id} iconUrl={pl.iconUrl} />
                      </span>
                      <span className="react-chat-skill-composer-pill-label">{pl.label}</span>
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
              // 停止按钮与左侧齿轮同一套：selectedTurnBusy = isSessionExecuting
              streaming={selectedTurnBusy}
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
              contextUsage={displayContextUsage}
              tokenTotals={headerTokenTotals}
              onManualCompact={handleManualContextCompact}
              manualCompactDisabled={manualContextCompacting}
              compacting={manualContextCompacting}
              workspaceMention={workspaceMention}
              attachedContextFileCount={contextFiles.length}
              onAttachContextFiles={attachContextFiles}
              renderTrailingControls={() => {
                const modelDisabled = modelsLoading && !modelCatalog.length
                const onSelectModel = (name: string) => {
                  setModelName(name)
                  try { localStorage.setItem(STORAGE_MODEL_KEY, name) } catch { /* ignore */ }
                  void patchPanelSettings({ lastSelectedModel: name })
                  void (async () => {
                    const sk = (selectedSessionKey || sessionRef.current || '').trim() || (await ensureChatSessionKeyRef.current?.()) || ''
                    if (!sk) return
                    try {
                      await wsClient.updateSessionContext(sk, { model_name: name })
                      setSessions((prev) => prev.map((s) => String(s.sessionKey || '') === sk ? { ...s, modelName: name } : s))
                      setRoleUiNonce((n) => n + 1)
                    } catch { /* ignore */ }
                    const sepText = `已切换至 ${name} 模型`
                    setRows((prev) => [...(Array.isArray(prev) ? prev : []), { role: 'system' as const, text: sepText, timestamp: Date.now() } as DisplayRow])
                  })()
                }
                return (
                  <ModelCatalogMenu open={bottomModelOpen} onOpenChange={setBottomModelOpen}
                    catalog={modelCatalog} connNameMap={modelConnNameMap}
                    selectedModel={effectiveModelName} pillLabel={modelPillLabel}
                    loading={modelsLoading} disabled={modelDisabled} manageDismiss={false}
                    portalFixed portalStack={isMobileChat} rootRef={bottomModelRootRef}
                    onBeforeOpen={() => { setModeMenuOpen(false); setBottomPermissionOpen(false); setBottomMoreOpen(false); setBottomWorkspaceOpen(false); setBottomRoleOpen(false) }}
                    onSelect={onSelectModel}
                  />
                )
              }}
              onOpenAttachmentMenu={() => {
                // + 号一键直达插件/添加快捷面板（ZCode 交互复刻）
                setBottomPluginPanelOpen(true);
              }}
              bottomMoreTriggerRef={bottomMoreTriggerRef}
              permissionPill={currentPermissionPillLabel}
              permissionMenuOpen={bottomPermissionOpen}
              onOpenPermissionMenu={togglePermissionMenu}
              permissionOptions={PERMISSION_PRESETS.map((p) => ({
                id: p.id,
                label: p.label,
                pillLabel: p.pillLabel,
                menuDesc: p.menuDesc,
                icon: p.icon,
                active: currentPermissionPresetId === p.id,
              }))}
              onPickPermission={(id) => void pickPermissionPreset(id)}
              newChatGrantAllDefault={newChatGrantAllDefault}
              onToggleNewChatGrantAllDefault={(next) => void toggleNewChatGrantAllDefault(next)}
              renderBottomControls={(ctrl) => {
                if (!renderBottomControlsLoggedRef.current) {
                  console.log('[ChatApp] renderBottomControls called (first render)')
                  renderBottomControlsLoggedRef.current = true
                }
                const { pickFiles, pickDocFiles, insertText } = ctrl
                // 手机对话：底栏简化
                if (isMobileChat) {
                  return null
                }
                // portal 下拉菜单（通过 onOpenAttachmentMenu / setBottomMoreOpen 触发）
                const bottomMorePortal = bottomMoreOpen && typeof document !== 'undefined'
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
                              <button key={m.value} type="button" role="menuitem" className={`react-chat-bottom-dropdown-item${sessionMode === m.value ? ' react-chat-bottom-dropdown-item--active' : ''}`}
                                onClick={() => { void setSessionModeAndApply(m.value as SessionMode); setBottomMoreOpen(false); setMoreSubOpen(null) }}
                              >
                                <span>{m.label}</span>
                                {sessionMode === m.value ? <span className="react-chat-skill-item-check" aria-hidden>✓</span> : null}
                              </button>
                            ))}
                            {SHOW_SESSION_MODE_COLLAB_UI && collabOn ? (
                              <>
                                <div className="react-chat-bottom-dropdown-divider" role="separator" />
                                <button type="button" role="menuitem" className="react-chat-bottom-pill react-chat-bottom-mode-pill"
                                  onClick={async () => { if (!selectedSessionKey) return; await setCollabPhaseForSession(selectedSessionKey, 'planning'); setThreadPanelState((prev) => ({ ...prev, collabPhase: 'planning' })); toast('已回到 Plan 阶段', 'success'); setBottomMoreOpen(false); setMoreSubOpen(null) }}
                                >回到 Plan</button>
                                <button type="button" role="menuitem" className="react-chat-bottom-pill react-chat-bottom-mode-pill"
                                  onClick={async () => { if (!selectedSessionKey) return; await setCollabPhaseForSession(selectedSessionKey, 'executing'); setThreadPanelState((prev) => ({ ...prev, collabPhase: 'executing' })); toast('已授权执行', 'success'); setBottomMoreOpen(false); setMoreSubOpen(null) }}
                                >Authorize 执行</button>
                              </>
                            ) : null}
                          </div>
                        ) : null}
                      </div>

                      {/* ── Agent/预设角色 ── */}
                      {!isProactiveEmployeeSession ? (
                        <button type="button" role="menuitem" className="react-chat-bottom-dropdown-item" disabled={roleSwitchBusy}
                          onClick={() => { setBottomMoreOpen(false); setMoreSubOpen(null); setBottomRoleOpen(true) }}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: 16, height: 16, flexShrink: 0 }}>
                            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
                          </svg>
                          <span>{roleSwitchBusy ? '…' : currentRoleLabel}</span>
                        </button>
                      ) : null}

                      {/* ── 技能 ── */}
                      <button type="button" role="menuitem" className="react-chat-bottom-dropdown-item"
                        onClick={() => { setBottomMoreOpen(false); setMoreSubOpen(null); setBottomSkillOpen(true) }}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: 16, height: 16, flexShrink: 0 }}>
                          <path d="M12 2l1.2 4.5L18 8l-4.8 1.5L12 14l-1.2-4.5L6 8l4.8-1.5L12 2z" />
                          <path d="M19 14l.8 2.8L23 18l-3.2 1.2L19 22l-.8-2.8L15 18l3.2-1.2L19 14z" />
                        </svg>
                        <span>{selectedSkills.length > 0 ? `技能 ${selectedSkills.length}` : '技能'}</span>
                      </button>

                      {/* ── 目标 ── */}
                      <button type="button" role="menuitem" className="react-chat-bottom-dropdown-item"
                        onClick={() => { setBottomMoreOpen(false); setMoreSubOpen(null); goal.goal.setPanelOpen(true) }}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ width: 16, height: 16, flexShrink: 0 }}>
                          <path d="M12 5v14" /><path d="M5 12h14" />
                        </svg>
                        <span>目标</span>
                        {goal.goal.ui.goalActive ? <span className="react-chat-more-submenu-badge">{goal.goal.goalStatusIcon}</span> : null}
                      </button>

                      {/* ── 员工 ── */}
                      {proactiveRolesDisplay.length > 0 ? (
                        <div className="react-chat-more-submenu-item">
                          <button type="button" className={`react-chat-more-submenu-header${moreSubOpen === 'employee' ? ' react-chat-more-submenu-header--open' : ''}`}
                            onClick={() => setMoreSubOpen((p) => (p === 'employee' ? null : 'employee'))}
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: 16, height: 16, flexShrink: 0 }}>
                              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
                              <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
                            </svg>
                            <span className="react-chat-more-submenu-title">员工</span>
                            <span className="react-chat-more-submenu-caret" aria-hidden>▸</span>
                          </button>
                          {moreSubOpen === 'employee' ? (
                            <div className="react-chat-more-submenu-flyout react-chat-more-submenu-flyout--scroll" role="menu">
                              {proactiveRolesDisplay.map((r) => (
                                <button key={r.agent_code} type="button" role="menuitem" className="react-chat-bottom-dropdown-item"
                                  onClick={() => {
                                    const name = String(r.role_name || r.agent_code || '').trim()
                                    const cur = String(composerDraftSnapshotRef.current || '').trimEnd()
                                    const token = `@${name} `
                                    insertText(cur ? `${cur}${cur.endsWith(' ') ? '' : ' '}${token}` : token)
                                    setBottomMoreOpen(false); setMoreSubOpen(null)
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
                      <button type="button" role="menuitem" className="react-chat-bottom-dropdown-item" disabled={!selectedSessionKey}
                        onClick={() => { setBottomMoreOpen(false); setMoreSubOpen(null); void pickDocFiles() }}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: 16, height: 16, flexShrink: 0 }}>
                          <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                        </svg>
                        <span>添加附件</span>
                      </button>
                      <button type="button" role="menuitem" className="react-chat-bottom-dropdown-item"
                        disabled={!selectedSessionKey || effectiveModelSupportsVision === false}
                        title={effectiveModelSupportsVision === false ? '当前模型不支持图片，请切换带「视觉」标记的模型' : undefined}
                        onClick={() => { if (effectiveModelSupportsVision === false) return; setBottomMoreOpen(false); setMoreSubOpen(null); pickFiles() }}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ width: 16, height: 16, flexShrink: 0 }}>
                          <rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="8.5" cy="10" r="1.5" />
                          <path d="M21 16l-5.2-5.2a1.5 1.5 0 00-2.1 0L3 18" />
                        </svg>
                        <span>添加图片</span>
                      </button>
                      <div className="react-chat-bottom-dropdown-divider" role="separator" />
                      {speechEnabled ? (
                        <button type="button" role="menuitem" className={`react-chat-bottom-dropdown-item${voiceReplyEnabled ? ' react-chat-bottom-dropdown-item--active' : ''}`}
                          onClick={async () => {
                            const next = !voiceReplyEnabled
                            setVoiceReplyEnabled(next)
                            await patchPanelSettings(voiceReplyModeToSettingsPatch(next))
                            if (!next) { voiceReplyPendingRef.current = false; voiceStreamingStartedRef.current = false; voiceSpeechSyncedPlainRef.current = ''
                              void import('../lib/speech-client.js').then(({ stopAllAssistantSpeech, resetStreamingSpeechQueue }) => { stopAllAssistantSpeech(); resetStreamingSpeechQueue() })
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
                          {voiceReplyEnabled ? <span className="react-chat-skill-item-check" aria-hidden>✓</span> : null}
                        </button>
                      ) : null}
                      {/* ── 记忆 ── */}
                      <div className="react-chat-more-submenu-item">
                        <button type="button" className={`react-chat-more-submenu-header${moreSubOpen === 'memory' ? ' react-chat-more-submenu-header--open' : ''}`}
                          onClick={() => setMoreSubOpen((p) => (p === 'memory' ? null : 'memory'))}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true" style={{ width: 16, height: 16, flexShrink: 0 }}>
                            <path d="M12 3 4 7l8 4 8-4-8-4z" /><path d="M4 12l8 4 8-4" /><path d="M4 17l8 4 8-4" />
                          </svg>
                          <span className="react-chat-more-submenu-title">记忆</span>
                          <span className="react-chat-more-submenu-badge">{memoryEnabled ? '开' : '关'}</span>
                          <span className="react-chat-more-submenu-caret" aria-hidden>▸</span>
                        </button>
                        {moreSubOpen === 'memory' ? (
                          <div className="react-chat-more-submenu-flyout" role="menu">
                            <button type="button" role="menuitem" className={`react-chat-bottom-dropdown-item${memoryEnabled ? ' react-chat-bottom-dropdown-item--active' : ''}`}
                              onClick={async () => {
                                const sk = (await ensureChatSessionKey()) || sessionRef.current || selectedSessionKey
                                if (!sk) return
                                const next = !memoryEnabled
                                setMemoryEnabled(next)
                                try { const api = await getApi(); await api.chatUpdateContext(sk, { memory_enabled: next }); toast(next ? '已开启记忆' : '已关闭记忆', 'success') }
                                catch (err) { setMemoryEnabled(!next); toast(toUserFacingError((err as Error)?.message || err), 'error') }
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
                        <button type="button" className={`react-chat-more-submenu-header${moreSubOpen === 'creative' ? ' react-chat-more-submenu-header--open' : ''}`}
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
                              <button key={p.label} type="button" role="menuitem" className="react-chat-bottom-dropdown-item"
                                onClick={() => { setBottomMoreOpen(false); setMoreSubOpen(null); insertText(p.prompt) }}
                              >{p.label}</button>
                            ))}
                          </div>
                        ) : null}
                      </div>

                      {/* ── 思考等级 ── */}
                      {effectiveModelSupportsThinking ? (
                        <div className="react-chat-more-submenu-item">
                          <button type="button" className={`react-chat-more-submenu-header${moreSubOpen === 'thinking' ? ' react-chat-more-submenu-header--open' : ''}`}
                            onClick={() => setMoreSubOpen((p) => (p === 'thinking' ? null : 'thinking'))}
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: 16, height: 16, flexShrink: 0 }}>
                              <path d="M9 18h6" /><path d="M10 22h4" />
                              <path d="M12 2a7 7 0 0 0-4 12.7c.5.4.8 1 .9 1.6h6.2c.1-.6.4-1.2.9-1.6A7 7 0 0 0 12 2z" />
                            </svg>
                            <span className="react-chat-more-submenu-title">思考</span>
                            <span className="react-chat-more-submenu-badge">{thinkingLevel === 'auto' ? '自动' : thinkingLevel === 'off' ? '关闭' : thinkingLevel === 'low' ? '轻度' : thinkingLevel === 'medium' ? '中度' : '深度'}</span>
                            <span className="react-chat-more-submenu-caret" aria-hidden>▸</span>
                          </button>
                          {moreSubOpen === 'thinking' ? (
                            <div className="react-chat-more-submenu-flyout" role="menu">
                              {THINKING_LEVEL_OPTIONS.map((opt) => (
                                <button key={opt.value} type="button" role="menuitem" className={`react-chat-bottom-dropdown-item${thinkingLevel === opt.value ? ' react-chat-bottom-dropdown-item--active' : ''}`}
                                  onClick={async () => {
                                    try { await applyThinkingLevel(selectedSessionKey || '', opt.value) }
                                    catch (e) { toast(toUserFacingError((e as Error)?.message || e), 'error') }
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
                  : null
                // + 号一键直达：锚定插件/添加快捷面板（ZCode ChatPromptActionMenu 复刻）
                const pluginPanelPortal = bottomPluginPanelOpen && typeof document !== 'undefined'
                  ? createPortal(
                    <PluginQuickPanel
                      open={bottomPluginPanelOpen}
                      onClose={() => setBottomPluginPanelOpen(false)}
                      style={pluginPanelStyle}
                      plugins={pluginList}
                      loading={pluginListLoading}
                      selected={selectedPlugins}
                      onToggle={(item) => {
                        setPluginComposerPillsVisible(true)
                        setSelectedPlugins((prev) => {
                          const next = prev.some((p) => p.id === item.id)
                            ? prev.filter((p) => p.id !== item.id)
                            : [
                                ...prev,
                                {
                                  id: item.id,
                                  label: item.label || item.name,
                                  iconUrl: item.iconUrl,
                                },
                              ]
                          // 即点即存（ZCode 面板无「完成」按钮）
                          void persistSelectedPlugins(String(selectedSessionKey || ''), next)
                          return next
                        })
                      }}
                      onPickDocs={() => void pickDocFiles()}
                      onPickImages={() => void pickFiles()}
                      onOpenSkillPicker={() => setBottomSkillOpen(true)}
                      onOpenGoal={() => goal.goal.setPanelOpen(true)}
                      onOpenRolePicker={() => setBottomRoleOpen(true)}
                      onOpenLegacyMenu={() => setBottomMoreOpen(true)}
                      onInsertText={(text) => insertText(text)}
                      showVoice={speechEnabled}
                      voiceOn={voiceReplyEnabled}
                      onToggleVoice={async () => {
                        const next = !voiceReplyEnabled
                        setVoiceReplyEnabled(next)
                        await patchPanelSettings(voiceReplyModeToSettingsPatch(next))
                        if (!next) {
                          voiceReplyPendingRef.current = false
                          voiceStreamingStartedRef.current = false
                          voiceSpeechSyncedPlainRef.current = ''
                          void import('../lib/speech-client.js').then(({ stopAllAssistantSpeech, resetStreamingSpeechQueue }) => {
                            stopAllAssistantSpeech()
                            resetStreamingSpeechQueue()
                          })
                        }
                        toast(next ? '已开启语音播报' : '已关闭语音播报', 'success')
                      }}
                    />,
                    document.body,
                  )
                  : null
                return pluginPanelPortal || bottomMorePortal || null
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
            {showChatSummaryFloat
              ? renderChatSummaryPanel(chatPanelMode === 'capsule' ? 'capsule' : 'panel')
              : null}
            {anyRightPanelOpen && layoutResizeEnabled ? (
              <PanelResizeHandle
                direction="vertical"
                label="拖动调整右侧面板宽度"
                dragging={rightPanelResizeDragging}
                onPointerDown={onRightPanelResizePointerDown}
              />
            ) : null}
            {rightStageOpen ? (
              <RightStagePanel
                tabs={visibleRightStageTabs}
                activeKey={rightStageActiveKey}
                recentClosed={rightStageRecentClosed.filter((entry) =>
                  filterRightStageTabsForSession([entry.tab], selectedSessionKey).length > 0,
                )}
                onActivateTab={activateRightStageTab}
                onCloseTab={handleCloseRightStageTab}
                onCloseOtherTabs={handleCloseOtherRightStageTabs}
                onCloseAllTabs={handleCloseAllRightStageTabs}
                onReorderTab={reorderRightStageTab}
                onReopenClosedTab={reopenRightStageTab}
                onCollapse={handleCollapseRightStage}
                launcherItems={rightStageLauncherItems}
                renderContent={renderRightStageBody}
              />
            ) : null}
          </div>
        </div>
        </section>
      </div>
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
        onRefreshEmployeeRoles={loadProactiveRoles}
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