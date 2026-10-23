// @ts-nocheck — ChatApp controller body (mechanical extract P151).
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
import {
  wsClient,
  restorePendingInjects,
  subscribeCollabThreadWs,
  dispatchCollabCustomEvent,
  collabSnapshotFromTaskRow,
  evoflowInvokeGatewayJson,
  evoflowFetch,
} from '../../lib/ws-client.js'
import { getPanelSetting, getVoiceReplyEnabled, patchPanelSettings } from '../../lib/panel-settings.js'
import { shouldArmVoiceReply, voiceReplyModeToSettingsPatch } from '../../lib/voice-reply-mode.js'
import { isChatOverlayDeferActive, setChatOverlayDefer } from '../../lib/chat-overlay-defer.js'
import { composerPlaceholderExtras } from '../../lib/keyboard-shortcuts.js'
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
} from '../../lib/chat-normalize.js'
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
} from '../lib/session-mode.js'
import { ModelCatalogMenu } from '../components/ModelCatalogMenu.js'
import { PermissionPresetMenu } from '../components/PermissionPresetMenu.js'
import { defaultModelFromCatalog } from '../lib/model-catalog.js'
import { setChatWorkspaceRoot } from '../../lib/chat-workspace-context.js'
import { effectiveLocalWorkspaceRoot } from '../../lib/workspace-api-scope.js'
import { useThreadHistory, markResumeAnchorAssistantIncomplete } from '../hooks/useThreadHistory.js'
import { useSessionList } from '../hooks/useSessionList.js'
import { ShellSessionListHost } from '../components/ShellSessionListHost.js'
import { getActivityHint } from '../lib/activity-hints.js'
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
} from '../lib/session-list/display.js'
import {
  patchSessionPinInRows,
  patchSessionTitleInRows,
  prependNewSessionToList,
  stripDefaultMainSessionRows,
} from '../lib/session-list/utils.js'
import { markSessionPinPending } from '../lib/session-list/session-pin-pending.js'
import { SESSION_LIST_PAGE_SIZE } from '../lib/session-list/constants.js'
import {
  loadExpandedWorkspaceKeys,
  saveExpandedWorkspaceKeys,
} from '../lib/session-list/expanded-workspaces-storage.js'
import type { ShellWorkspaceGroup } from '../lib/session-list/types.js'
import {
  isProactiveSessionKey,
  isSpecialWorkspaceGroupKey,
  normalizeWorkspacePathKey,
  parseProactiveSessionKey,
  proactiveAgentCodeFromSessionKey,
} from '../lib/session-list/workspace-groups.js'
import { useCollabSubtasksFromApi } from '../hooks/useCollabSubtasksFromApi.js'
import { skTail, ssLog } from '../../lib/session-list-debug.js'
import { ChatMessageStreamPane } from '../components/ChatMessageStreamPane.js'
import { HistoryFetchSpinner } from '../components/HistoryFetchSpinner.js'
import { ChatComposer, type WorkspaceMentionConfig, type MentionEmployeeOption } from '../components/ChatComposer.js'
import { PendingSteersStrip } from '../components/PendingSteersStrip.js'
import { mergeInterruptedComposerDraft } from '../lib/merge-interrupted-composer-draft.js'
import { ContextUsageRing } from '../components/ContextUsageRing.js'
import { basenameFromPath } from '../lib/workspace-mention.js'
import { GoalModePanel } from '../components/GoalModePanel.js'
import { GoalProposalDock } from '../components/GoalProposalDock.js'
import { SkillPickerModal, type SkillSelection } from '../components/SkillPickerModal.js'
import { PluginQuickPanel } from '../components/PluginQuickPanel.js'
import type { PluginSelection } from '../components/PluginPickerModal.js'

import { PluginPillIcon } from '../components/PluginPillIcon.js'
import { ShareSessionModal } from '../components/ShareSessionModal.js'
import { AgentPickerModal } from '../components/AgentPickerModal.js'
import { PlanExecConfirm } from '../components/PlanExecConfirmDock.js'
import { ClarificationConfirmDock } from '../components/ClarificationConfirmDock.js'
import type { PlanExecConfirmAnchor } from '../components/ToolCallList.js'
import { setAgentsDisplayCache } from '../../lib/agents-display-cache.js'
import {
  collectPendingApprovalsForDock,
  patchToolsApprovalStatus,
  rowHasPendingApprovalTools,
  buildToolApprovalReplayMessage,
  isHiddenToolApprovalUserMessage,
} from '../../lib/tool-approval.js'
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
} from '../../lib/tool-approval-settings.js'
import {
  PERMISSION_PRESETS,
  PERMISSION_PRESET_FULL_ACCESS,
  resolvePermissionPreset,
  permissionPresetToast,
} from '../../lib/permission-tier.js'
import { TOOL_APPROVAL_REQUEST_SESSION_FULL_ACCESS } from '../components/ToolApprovalPanel.js'
import {
  logToolApprovalPendingDetected,
  logToolApprovalStreamFinal,
  logToolApprovalUserAction,
} from '../../lib/tool-approval-trace.js'
import { CollabExecutionPanel } from '../components/CollabExecutionPanel.js'
import {
  RightStagePanel,
  buildDefaultRightStageLauncherItems,
} from '../components/RightStagePanel.js'
import { switchRightStageSession } from '../../lib/right-stage/right-stage-session-memory.js'
import { KnowledgeMapPanel } from '../components/KnowledgeMapPanel.js'
import {
  type InfoRailTab,
  type EmployeeRailInfo,
} from '../components/ChatWorkspaceInfoRail.js'
import { useLiveProcessSnapshot } from '../lib/use-live-process-snapshot.js'
import {
  loadChatSummaryPrefs,
  saveChatSummaryDisplayMode,
  type ChatSummaryDisplayMode,
} from '../lib/chat-summary-panel-prefs.js'
import type { ProcessItem } from '../lib/chat-summary-panel-model.js'
import { SidePanelBootShell } from '../components/SidePanelBootShell.js'
import { applyRightStageAgUiCustom, applyStageSetFromToolCall, STAGE_SET_APPLIED_EVENT, type StageSetPayload } from '../../lib/right-stage/right-stage-agui.js'
import { syncBrowserPanelFromAgUiEvent, isBrowserToolWireName } from '../../lib/browser-panel-agui.js'
import {
  applyBrowserCommandResponse,
  closeBrowserStage,
  ensureBrowserStage,
  getBridgeOwnerSessionKey,
  NODE_REPL_BRIDGE_THREAD_ID,
  resetBrowserStageSwitchTracking,
  setBrowserPanelThreadId,
} from '../../lib/browser-panel-store.js'
import { dbgLog } from '../../lib/browser-debug-log.js'
import { hideRightStageIfKind, rightStageStore } from '../../lib/right-stage/right-stage-store.js'
import { closeSummaryStage } from '../../lib/right-stage/ensure-summary-stage.js'
import { ensureTerminalStage } from '../../lib/right-stage/ensure-terminal-stage.js'
import { filterRightStageTabsForSession } from '../../lib/right-stage/right-stage-session-visibility.js'
import { isAutoWorkPreviewEnabled } from '../../lib/right-stage/write-stream-mode.js'
import { applyDecideRightStage } from '../../lib/right-stage/apply-decide-right-stage.js'
import { syncEmployeesRosterFromToolResult } from '../../lib/employees-roster-sync.js'
import { applyPlatformFeedbackFromToolResult, latestPlatformRunEntryId, openPlatformFeedbackFromTool, platformRunEntriesFromChatArtifacts, type PlatformRunEntry } from '../../lib/right-stage/platform-feedback.js'
import { registerPlatformFeedbackOpenHandler } from '../../lib/right-stage/platform-feedback-bridge.js'
import { normalizeRightStageKind } from '../../lib/right-stage/right-stage-types.js'
import type { RightStageKind } from '../../lib/right-stage/right-stage-types.js'
import type { RightStageSurface } from '../../lib/right-stage/right-stage-types.js'
import {
  isUserStageExtensionKind,
  titleForUserStageExtension,
  type UserStageExtensionKind,
} from '../../lib/right-stage/right-stage-extensions.js'
import { useRightStageChatBridge } from '../hooks/useRightStageChatBridge.js'
import { useObsEnabled } from '../hooks/useObsEnabled.js'
import { PanelResizeHandle } from '../components/PanelResizeHandle.js'
import { SessionSidebar, type SubtaskTranscriptModalPayload } from '../components/SessionSidebar.js'
import { WorkspaceFileTree, type ContextFileEntry } from '../components/WorkspaceFileTree.js'
import { MemoryRecallChip } from '../components/MemoryRecallChip.js'
import { WorkspaceFilePreviewPanel } from '../components/WorkspaceFilePreviewPanel.js'
import { TerminalStagePanel } from '../components/TerminalStagePanel.js'
import { ImagePreviewModal, type ImagePreviewItem } from '../components/ImagePreviewModal.js'
import { isImagePathLike, resolveChatImageSrc } from '../../lib/chat-image-src.js'
import {
  detectStreamingWritePreview,
  isActiveWriteTool,
  isStreamAutoPreviewPath,
  shouldSuppressStreamDeliveredFiles,
  workspacePreviewTargetFromUrl,
} from '../../lib/workspace-preview-path.js'
import { TauriWindowControls } from '../components/TauriWindowControls.js'
import { toast } from '../../components/toast.js'
import { toUserFacingError } from '../../lib/user-facing-error.js'
import {
  ServiceHealthState,
  startServiceHealthPoll,
  stopServiceHealthPoll,
  onServiceHealthChange,
  triggerServiceHealthCheck,
} from '../../lib/service-health.js'
import { isDebugOn } from '../../lib/debug-flag.js'
import { t as i18nT } from '../../lib/i18n.js'
import { notifyDesktopCompletion } from '../../lib/desktop-notification.js'
import {
  registerVoiceSendHandler,
  unregisterVoiceSendHandler,
} from '../../lib/background-voice-bridge.js'
import { setVoiceTrayState } from '../../lib/background-voice.js'
import { normalizeStreamActivityDetail, formatActivityDetailFromRunningToolCalls, resolveAssignedAgentDisplayName } from '../../lib/tool-display.js'
import {
  resolveComposerDockActivity,
  type ResolvedLiveStreamActivity,
} from '../lib/resolve-live-stream-activity.js'
import {
  computeTurnElapsedSec,
  formatTurnDurationStr,
  isTurnTimingLive,
  parseTurnTimestampMs,
} from '../lib/turn-timing.js'
import { showConfirm, showModal, suppressModalBackdropDismiss } from '../../components/modal.js'
import {
  getShellAsideCollapsed,
  setShellAsideCollapsed,
  toggleShellAsideCollapsed,
} from '../../components/shell-aside.js'
import { useGoalMode } from '../hooks/useGoalMode.js'
import { useClarificationPanel } from '../hooks/useClarificationPanel.js'
import { useComposerDrafts } from '../hooks/useComposerDrafts.js'
import { usePendingSendQueue } from '../hooks/usePendingSendQueue.js'
import { useChatContextFiles } from '../hooks/useChatContextFiles.js'
import { useStreamingWritePreview } from '../hooks/useStreamingWritePreview.js'
import { useWorkspaceFileOpen } from '../hooks/useWorkspaceFileOpen.js'
import { useComposerSkillPluginSelection } from '../hooks/useComposerSkillPluginSelection.js'
import { useChatLayoutResize } from '../hooks/useChatLayoutResize.js'
import { useComposerModelCatalog } from '../hooks/useComposerModelCatalog.js'
import { useSessionWorkspaceBind } from '../hooks/useSessionWorkspaceBind.js'
import { useProactiveRoles } from '../hooks/useProactiveRoles.js'
import { useContextUsageBySession } from '../hooks/useContextUsageBySession.js'
import { useSessionModeControls } from '../hooks/useSessionModeControls.js'
import { useCollabSidebarSync } from '../hooks/useCollabSidebarSync.js'
import {
  useSelectedStaleTurnWatchdog,
  useGlobalStaleBusyPoll,
  type UseStaleTurnWatchdogsCtx,
} from './session/use-stale-turn-watchdogs.js'
import { normalizeFileHrefForThread, normalizeRowFilesInPlace } from './utils/file-href-normalize.js'
import {
  formatAskClarificationForHosted,
  isClarificationPreviewRenderable,
  isUserExecutionStartIntent,
} from '../lib/clarify-chat-display.js'
import {
  findAskClarificationAwaitingUserInRows,
  isAskClarificationToolPending,
} from '../../lib/clarify-preview-resolve.js'
import {
  clearClarificationLatch,
  peekClarificationLatch,
} from '../lib/clarify-tool-fetch.js'
import { pushGoalClosureNotification } from '../lib/session-notifications.js'
import { getUseVirtualPaths } from '../../lib/path-mode.js'
import {
  getWorkspaceIndexWatchEnabled,
  setWorkspaceIndexWatchEnabled,
} from '../../lib/workspace-index-watch.js'
import { resolveLanggraphLeadThreadId } from '../../lib/collab-thread-ids.js'
import { agentCapabilitySummary, normalizeAgentTags, type AgentPickerRow } from '../lib/agent-tags.js'

// ========== 任务进度可视化系统集成 ==========
import { tasksAPI } from '../../lib/api-client.js'
import { fetchCollabSubtasksForMainTask, preferPersistedCollabSubtasks } from '../../lib/collab-subtasks-from-api.js'
import {
  buildCollabSidebarFromTools,
  collectAssistantToolArraysFromRows,
  extractLastPlanToolSuccessFromArrays,
  findLastSuccessfulPlanToolCallId,
  isPendingSubtaskKey,
  mergeAssistantToolsFromRows,
  pruneSupersededPendingSubtasks,
} from '../../lib/collab-sidebar-from-tools.js'
import {
  computePlanExecStripUi,
  resolvePlanBoundTaskId,
} from '../../lib/plan-exec-ui.js'
import {
  isActiveExecTaskStatus,
  shouldAutoOpenCollabExecPanel,
  shouldShowCollabSubtaskSidebar,
  shouldShowCollabWorkflowPanel,
} from '../../lib/plan-task-status.js'
import {
  mergePlanToolsForDetection,
  mergeToolsForPlanDetection,
  analyzePlanTools,
  enrichToolsWithCachedPlanInput,
  historyPastPlanExecutionGate,
} from '../../lib/plan-pipeline.js'
import {
  syncPlanDockStateFromApi,
} from '../../lib/plan-from-api.js'
import {
  resolveSessionTaskId,
} from '../../lib/session-task-api-gate.js'
import { planDockApiHide, planDockApiShow, tracePlanDockApi } from '../../lib/plan-dock-api.js'
import { pickRicherStructuredPlanInput } from '../../lib/plan-from-task.js'
import { tracePlanPipeline, resetPlanTrace } from '../../lib/plan-trace.js'
import type { StructuredPlanInput } from '../components/PlanDetailView.js'
import type {
  PlanPanelHit,
  PlanDockApiView,
  PlanStreamLatch,
} from './plan-dock/types.js'
import {
  syncPlanPanelFromApi as syncPlanPanelFromApiImpl,
  type SyncPlanPanelFromApiOpts,
} from './plan-dock/sync-plan-panel-from-api.js'
import { syncPlanPanelImmediateFromTools as syncPlanPanelImmediateFromToolsImpl } from './plan-dock/sync-plan-panel-immediate.js'
import { collectPlanToolsForDetection as collectPlanToolsForDetectionImpl } from './plan-dock/collect-plan-tools.js'
import { reconcileLastAssistantFromDb as reconcileLastAssistantFromDbImpl } from './utils/reconcile-last-assistant-from-db.js'
import { openUiExtensionInStage as openUiExtensionInStageImpl } from './right-stage/open-ui-extension-in-stage.js'
import { handleDispatchEmployee as handleDispatchEmployeeImpl } from './dispatch/handle-dispatch-employee.js'
import { syncRemoteStageSet as syncRemoteStageSetImpl } from './right-stage/sync-remote-stage-set.js'
import { handleEnhancePrompt as handleEnhancePromptImpl } from './composer/handle-enhance-prompt.js'
import { handleManualContextCompact as handleManualContextCompactImpl } from './context/handle-manual-context-compact.js'
import { closeRightStage as closeRightStageImpl } from './right-stage/close-right-stage.js'
import { closeRightStageTabByKey as closeRightStageTabByKeyImpl } from './right-stage/close-right-stage-tab.js'
import { forkSessionByKey as forkSessionByKeyImpl } from './session/fork-session.js'
import { resolveLangGraphThreadIdForSession as resolveLangGraphThreadIdForSessionImpl } from './session/resolve-langgraph-thread-id.js'
import { openStageExtension as openStageExtensionImpl } from './right-stage/open-stage-extension.js'
import { toggleWorkspacePanel as toggleWorkspacePanelImpl } from './right-stage/toggle-workspace-panel.js'
import {
  collapseRightStageShell as collapseRightStageShellImpl,
  expandRightStageShell as expandRightStageShellImpl,
} from './right-stage/collapse-expand-right-stage.js'
import { mapAgentPickerRows } from './agents/map-agent-picker-rows.js'
import { closeWorkspacePanel as closeWorkspacePanelImpl } from './right-stage/close-workspace-panel.js'
import {
  openCollabExecPanel as openCollabExecPanelImpl,
  closeCollabExecPanel as closeCollabExecPanelImpl,
} from './right-stage/collab-exec-panel.js'
import {
  openKnowledgeMapPanel as openKnowledgeMapPanelImpl,
  closeKnowledgeMapPanel as closeKnowledgeMapPanelImpl,
} from './right-stage/knowledge-map-panel.js'
import { handleAssetQuickAction as handleAssetQuickActionImpl } from './assets/handle-asset-quick-action.js'
import { mergeHeaderTokenTotals } from './context/merge-header-token-totals.js'
import { resolveDisplayContextUsage } from './context/resolve-display-context-usage.js'
import { syncShellAsideForWorkspacePanel as syncShellAsideForWorkspacePanelImpl } from './shell/sync-shell-aside-for-workspace.js'
import { patchCurrentAgentCapabilities as patchCurrentAgentCapabilitiesImpl } from './agents/patch-current-agent-capabilities.js'
import { openCurrentAgentEditor as openCurrentAgentEditorImpl } from './agents/open-current-agent-editor.js'
import { handleStopProcessItem as handleStopProcessItemImpl } from './process/handle-stop-process-item.js'
import { handleOpenProcessItem as handleOpenProcessItemImpl } from './process/handle-open-process-item.js'
import { refreshPlanDockAfterStreamFinal as refreshPlanDockAfterStreamFinalImpl } from './plan-dock/refresh-plan-dock-after-stream-final.js'
import { sessionPersistedTokenTotals as buildSessionPersistedTokenTotals } from './context/session-persisted-token-totals.js'
import { collectCollabToolsForSidebar as collectCollabToolsForSidebarImpl } from './collab/collect-collab-tools-for-sidebar.js'
import { handleDeleteWorkspaceGroup as handleDeleteWorkspaceGroupImpl } from './session/handle-delete-workspace-group.js'
import { handleDeleteSession as handleDeleteSessionImpl } from './session/handle-delete-session.js'
import { authorizeExecutionInBackground as authorizeExecutionInBackgroundImpl } from './plan-dock/authorize-execution-in-background.js'
import { runUserExecutionStart as runUserExecutionStartImpl } from './plan-dock/run-user-execution-start.js'
import { runShellSessionRefresh as runShellSessionRefreshImpl } from './session/run-shell-session-refresh.js'
import { applyPlanToolSuccess as applyPlanToolSuccessImpl } from './plan-dock/apply-plan-tool-success.js'
import { toggleBrowserStage as toggleBrowserStageImpl } from './right-stage/toggle-browser-stage.js'
import {
  onShellPinSession as onShellPinSessionImpl,
  onShellRefreshSession as onShellRefreshSessionImpl,
  onShellRefreshSessionList as onShellRefreshSessionListImpl,
  onShellStopSession as onShellStopSessionImpl,
} from './shell/shell-session-actions.js'
import { selectSessionFromShell as selectSessionFromShellImpl } from './shell/select-session-from-shell.js'
import { handleEditMessage as handleEditMessageImpl } from './composer/handle-edit-message.js'
import { applyFullAccessToCurrentSession as applyFullAccessToCurrentSessionImpl } from './session/apply-full-access.js'
import { startNewChatWithPresetAgent as startNewChatWithPresetAgentImpl } from './agents/start-new-chat-with-preset-agent.js'
import { applyMoreMenuSessionApprovalPolicy as applyMoreMenuSessionApprovalPolicyImpl } from './session/apply-more-menu-session-approval-policy.js'
import { toggleNewChatGrantAllDefault as toggleNewChatGrantAllDefaultImpl } from './session/toggle-new-chat-grant-all-default.js'
import { createSessionForChat as createSessionForChatImpl } from './session/create-session-for-chat.js'
import { resolveCurrentPermissionPresetId } from './session/resolve-current-permission-preset.js'
import {
  resolveWorkspaceForNewSession as resolveWorkspaceForNewSessionImpl,
  shouldStayOnHomeDashboard,
  scrollHomeMessagesToTop,
} from './session/new-session-workspace.js'
import { resetChatSurfaceForNewDraft as resetChatSurfaceForNewDraftImpl } from './session/reset-chat-surface-for-new-draft.js'
import { startNewSessionWithWorkspace as startNewSessionWithWorkspaceImpl } from './session/start-new-session-with-workspace.js'
import { togglePermissionMenu as togglePermissionMenuImpl } from './session/toggle-permission-menu.js'
import { buildPlanExecConfirmAnchor } from './plan-dock/build-plan-exec-confirm-anchor.js'
import { handleAbort as handleAbortImpl } from './session/handle-abort.js'
import { finalizeNewSessionBackground as finalizeNewSessionBackgroundImpl } from './session/finalize-new-session-background.js'
import { ensureChatSessionKey as ensureChatSessionKeyImpl } from './session/ensure-chat-session-key.js'
import { handleVoiceTranscribed as handleVoiceTranscribedImpl } from './composer/handle-voice-transcribed.js'
import { handleToolApproval as handleToolApprovalImpl } from './session/handle-tool-approval.js'
import { applyPendingShellSession as applyPendingShellSessionImpl } from './shell/apply-pending-shell-session.js'
import {
  handleHomeSendEvent,
  handleHomeSelectModelEvent,
  handleHomeSetMemoryEvent,
  handleHomeSetVoiceReplyEvent,
} from './composer/handle-home-events.js'
import { refreshAgentsList as refreshAgentsListImpl } from './agents/refresh-agents-list.js'
import { applySessionSwitchUiShell as applySessionSwitchUiShellImpl } from './session/apply-session-switch-ui-shell.js'
import { buildSessionStopHost } from './session/build-session-stop-host.js'
import { installShellSessionHeal } from './shell/install-shell-session-heal.js'
import { maybeSyncVoiceReplySpeech as maybeSyncVoiceReplySpeechImpl } from './composer/maybe-sync-voice-reply-speech.js'
import {
  resetCollabPlanUiForSession as resetCollabPlanUiForSessionImpl,
  resetCollabPlanUiForNewCycle as resetCollabPlanUiForNewCycleImpl,
} from './plan-dock/reset-collab-plan-ui.js'
import { absorbPlanFromTools as absorbPlanFromToolsImpl } from './plan-dock/absorb-plan-from-tools.js'
import { handleSend as handleSendImpl } from './composer/handle-send.js'
import { runChatWsOnEventEffect } from './stream/install-chat-ws-on-event.js'
import { patchCollabFromStreamTools as patchCollabFromStreamToolsImpl } from './collab/patch-collab-from-stream-tools.js'
import { renderRightStageBody as renderRightStageBodyImpl } from './right-stage/render-right-stage-body.js'
import { runCollabUnifiedWsEffect } from './collab/install-collab-unified-ws.js'
import { runShellWindowListenersEffect } from './shell/install-shell-window-listeners.js'
import { runVisibilityReattachEffect } from './shell/install-visibility-reattach.js'
import { runChatMountBootstrapEffect } from './shell/install-chat-mount-bootstrap.js'
import { runThreadPanelSseEffect } from './shell/install-thread-panel-sse.js'
import { renderChatSummaryPanel as renderChatSummaryPanelImpl } from './view/render-chat-summary-panel.js'
import {
  renderBrowserToggleButton,
  renderInfoRailHeaderToggle,
  renderWorkspaceFolderGroup,
  renderWorkspaceFolderToggleButton,
} from './view/header-chrome.js'
import { runSessionEnterPlanSyncEffect } from './plan-dock/run-session-enter-plan-sync.js'
import { runSessionSwitchLayoutEffect } from './session/run-session-switch-layout.js'
import { runClarificationHydrateEffect } from './session/run-clarification-hydrate.js'
import { runPageLoadResumeEffect } from './shell/run-page-load-resume.js'
import { requestManualStreamResume } from './shell/request-manual-stream-resume.js'
import { runBackgroundWorksPollEffect } from './process/install-background-works-poll.js'
import { runCollabSubtasksPollEffect } from './collab/install-collab-subtasks-poll.js'
import {
  createOnGoalRunningChange,
  createOnGoalSendingChange,
  createOnRefreshChatHistory,
} from './goal/goal-mode-callbacks.js'
import {
  createScheduleBump,
  createScheduleReasoningBump,
} from './stream/schedule-stream-bumps.js'
import { afterLiveOrStructuralBump as afterLiveOrStructuralBumpImpl } from './stream/after-live-or-structural-bump.js'
import {
  clearTurnSendingState as clearTurnSendingStateImpl,
  maybeEndTurnSendingState as maybeEndTurnSendingStateImpl,
} from './stream/turn-sending-state.js'
import {
  disposeStreamBumpSchedulers,
  ensureStreamBumpSchedulers,
} from './stream/ensure-stream-bump-schedulers.js'
import { buildWorkspaceMentionConfig } from './composer/workspace-mention.js'
import { buildChatRightStageLauncherItems } from './right-stage/build-right-stage-launcher-items.js'
import { runNormalizeRowFileUrlsEffect } from './session/run-normalize-row-file-urls.js'
import { runLoadEmployeeRoleDetailEffect } from './agents/load-employee-role-detail.js'
import { runBottomMenusDismissEffect } from './composer/install-bottom-menus-dismiss.js'
import { runSyncProactiveWorkspaceKindEffect } from './session/sync-proactive-workspace-kind.js'
import { runLoadSessionArtifactsEffect } from './session/load-session-artifacts.js'
import { commitThreadPanelForSession as commitThreadPanelForSessionImpl } from './session/commit-thread-panel.js'
import { runHomeWindowListenersEffect } from './composer/install-home-window-listeners.js'
import {
  runBottomMorePortalLayoutEffect,
  runPluginPanelPortalLayoutEffect,
} from './composer/install-bottom-portal-layouts.js'
import {
  handleNewSession as handleNewSessionImpl,
  handleNewSessionInWorkspace as handleNewSessionInWorkspaceImpl,
  handleOpenHome as handleOpenHomeImpl,
  pruneDeletedSessionCaches,
} from './session/new-session-actions.js'
import { reloadHistoryFromDb as reloadHistoryFromDbImpl } from './session/reload-history-from-db.js'
import { runPendingNavFromStorageEffect } from './shell/run-pending-nav-from-storage.js'
import { runBrowserPanelRequestEffect } from './right-stage/install-browser-panel-request.js'
import { runForceEndTurnWhenSealedEffect } from './stream/run-force-end-turn-when-sealed.js'
import { resolveStreamingWritePreviewForPane } from './right-stage/resolve-streaming-write-preview-for-pane.js'
import { runFlushPendingAutoTitleEffect } from './session/run-flush-pending-auto-title.js'
import { runInitialAgentsLoadEffect } from './agents/run-initial-agents-load.js'
import { runEngineReadyListenerEffect } from './shell/install-engine-ready-listener.js'
import { resolveCurrentAgentCapabilities } from './agents/resolve-current-agent-capabilities.js'
import { resolveLiveStreamActivityForSession as resolveLiveStreamActivityForSessionImpl } from './stream/resolve-live-stream-activity-for-session.js'
import { runToolApprovalPolicyListenersEffect } from './session/install-tool-approval-policy-listeners.js'
import { runFetchSessionToolApprovalEffect } from './session/run-fetch-session-tool-approval.js'
import { runMoreMenuDismissEffect } from './shell/install-more-menu-dismiss.js'
import { publishPlatformEntries as publishPlatformEntriesImpl } from './right-stage/publish-platform-entries.js'
import { publishArtifacts as publishArtifactsImpl } from './right-stage/publish-artifacts.js'
import { buildScenarioSessionHandlers } from './session/build-scenario-session-handlers.js'
import {
  resolveSessionRowTaskId as resolveSessionRowTaskIdImpl,
  resolveChatThreadIdForSidebar as resolveChatThreadIdForSidebarImpl,
  resolveWorkflowTaskId as resolveWorkflowTaskIdImpl,
  resolveCollabWorkflowApiReady as resolveCollabWorkflowApiReadyImpl,
  resolveCollabExecPanelCanShow as resolveCollabExecPanelCanShowImpl,
} from './collab/resolve-collab-sidebar-derived.js'
import { bumpStreamChromeThrottled as bumpStreamChromeThrottledImpl } from './stream/bump-stream-chrome-throttled.js'
import {
  putLiveRunSnapshotBestEffort as putLiveRunSnapshotBestEffortImpl,
  deleteLiveRunSnapshotBestEffort as deleteLiveRunSnapshotBestEffortImpl,
} from './session/live-run-snapshot-persist.js'
import { buildHistoryLiveContext } from './session/build-history-live-context.js'
import {
  resolveGoalExecutionTiming,
  resolveCollabExecutionTiming,
} from './stream/resolve-execution-tool-timing.js'
import { cancelPendingStreamUiBumps as cancelPendingStreamUiBumpsImpl } from './stream/cancel-pending-stream-ui-bumps.js'
import { resolveToolApprovalUiDisabled } from './session/resolve-tool-approval-ui-disabled.js'
import {
  isPlanExecDockSuppressed as isPlanExecDockSuppressedImpl,
  suppressPlanExecDock as suppressPlanExecDockImpl,
} from './plan-dock/plan-exec-dock-suppress.js'
import { setChatPanelDisplayMode as setChatPanelDisplayModeImpl } from './right-stage/set-chat-panel-display-mode.js'
import { runCloseLeftoverSummaryStageEffect } from './right-stage/run-close-leftover-summary-stage.js'
import { runInfoRailOnSessionChangeEffect } from './shell/run-info-rail-on-session-change.js'
import { refreshSpeechConfigured as refreshSpeechConfiguredImpl } from './composer/refresh-speech-configured.js'
import { runVoiceSendHandlerEffect } from './composer/install-voice-send-handler.js'
import {
  publishPlanPanelHit as publishPlanPanelHitImpl,
  resetPlanStreamSession as resetPlanStreamSessionImpl,
  applyPlanDockApiView as applyPlanDockApiViewImpl,
} from './plan-dock/publish-plan-panel-hit.js'
import { resolveProactiveRolesDisplay } from './agents/resolve-proactive-roles-display.js'
import {
  resolveSelectedSessionAgentId,
  resolveCurrentRoleCodeForUi,
  resolveAssistantReplyLabel,
  resolveCurrentRoleLabel,
  resolveAgentDefaultModelName,
} from './agents/resolve-session-role-ui.js'
import {
  resolveSelectedSessionLive,
  resolveIsHomeSurface,
  resolveSelectedResumeAttach,
  resolveSelectedResumeStreamHold,
  resolveSidebarHistory,
} from './session/resolve-selected-session-live.js'
import { isEvoflowChatV4Enabled } from '../v4/v4Gate.js'
import { runOpenGoalPanelListenerEffect } from './goal/install-open-goal-panel-listener.js'
import {
  runChatOverlayDeferEffect,
  runSidePanelHeavyMountEffect,
} from './shell/install-overlay-defer-effects.js'
import {
  handleSessionWorkspaceUpdatedEvent,
  startHydrateSessionWorkspaceHistory,
} from './session/sync-session-workspace.js'
import {
  installProjectCodeIndexWatch,
  installVirtualCodeIndexWatch,
} from './session/install-code-index-watch.js'
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
} from '../chat-types.js'
import { HoverBubble, HoverBubbleProvider } from '../components/HoverBubble.js'
import type { ContextUsageSnapshot } from '../lib/context-usage.js'
import {
  mergeChatArtifacts,
  normalizeChatArtifacts,
  type ChatArtifact,
} from '../lib/chat-artifact.js'
import {
  mergeContextUsageSnapshots,
  parseContextUsageFromSessionContext,
} from '../lib/context-usage.js'
import { requestManualContextCompaction } from '../lib/manual-context-compaction.js'
import { mergeSubagentStreamEvent, normalizeSubagentStreamEvent } from '../subagent-stream-merge.js'
import { cloneTerminalStreamTask, cloneTerminalStreamsMap, mergeTerminalIntoTool, mergeTerminalStreamEvent } from '../terminal-stream-merge.js'
import { mergeBackgroundWorkEvent } from '../lib/background-work-merge.js'
import {
  fetchBackgroundBashOutput,
  listBackgroundBashWorks,
  stopBackgroundBashWork,
} from '../lib/background-bash-api.js'
import { collabDagDebug, collabDagDebugBannerOnce } from '../../lib/collab-dag-debug.js'
import { isSubtaskStreamDebugEnabled, subtaskStreamDebugBannerOnce } from '../../lib/subtask-stream-debug.js'
import { resetStreamMirrorDedupe } from '../stream-console-mirror.js'
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
} from '../lib/stream-turn-engine.js'
import { parseStreamBlockWire, enforceSegmentDisplayOrder, type StreamBlockWire } from '../lib/content-blocks.js'
import { createStreamBumpScheduler } from '../lib/stream-bump-scheduler.js'
import { resolveStreamBumpMinIntervalMs, STREAM_BUMP_INTERVAL_MS, STREAM_REASONING_BUMP_INTERVAL_MS } from '../lib/stream-bump-interval.js'
import { streamPerfNoteBumpThrottle } from '../lib/stream-perf-trace.js'
import { isStreamThrottleEnabled } from '../lib/stream-throttle-toggle.js'
import { isAgUiLiveTextEvent, isStreamTurnLiveTextEvent } from '../lib/agui-live-routes.js'
import {
  endClientPerfTurn,
  getChatSurfaceVisible,
  setChatSurfaceVisible,
  startClientPerfTurn,
  subscribeChatSurfaceVisible,
} from '../lib/client-perf.js'
import {
  emptyStream,
  isAgUiStreamActive,
  streamRefHasVisibleContent,
  streamProject,
} from '../lib/stream-state.js'
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
} from '../lib/agui-turn-reducer.js'
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
} from '../lib/session-runtime-store.js'
import { commitStreamSnapshot, pruneStreamSnapshots } from '../lib/stream-snapshot-store.js'
import { rowHasVisibleContent } from '../lib/display-row-content.js'
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
} from '../lib/chat-stream-apply.js'
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
} from '../lib/turn-text-isolation.js'
import {
  bindActiveRun,
  chatRunIdsSameTurn,
  clearActiveRun,
  markRunSealing,
  shouldApplyChatEvent,
  isAgUiWireRunId,
} from '../lib/run-turn-gate.js'
import {
  fetchSessionRuntimeStatus,
  maybeClearTurnSendingState,
  seedSessionRuntimeStatusIdle,
  invalidateSessionRuntimeStatusCache,
} from '../lib/session-reattach.js'
import { useRunningSessionSummaries } from '../hooks/useRunningSessionSummaries.js'
import { useStreamResume } from '../hooks/useStreamResume.js'
import { srLog } from '../lib/stream-resume-debug.js'
import {
  sfLog,
  sfWarn,
  sfSummarizeAgUi,
  sfSummarizeSegments,
  sfSummarizeRowsTail,
} from '../lib/stream-final-debug.js'
import {
  installStreamStopPageUnloadHook,
  logStreamStop,
  resetStreamStopLogDedupe,
} from '../lib/stream-stop-log.js'
import {
  shouldManualRefreshResumeStream,
  shouldSuppressAutoReattach,
} from '../lib/stream-resume-gate.js'
import {
  clearStreamReattachCooldown,
  isSessionRecoveryCooldownActive,
} from '../lib/stream-reattach-cooldown.js'
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
} from '../lib/session-execution/index.js'
import { useSessionExecutionState } from '../hooks/useSessionExecutionState.js'
import { useSessionExecutionProbes } from '../hooks/useSessionExecutionProbes.js'
import { buildHistoryViewFromRaw } from '../lib/chatHistoryView.js'
import { fetchSessionHistoryTailMessages } from '../hooks/fetchSessionHistory.js'
import { warmSessionHistoryPrefetch } from '../lib/warm-session-history-prefetch.js'
import { warmEvoflowV4Session } from '../v4/V4StreamRowsBridge.js'
import {
  displayRowsEquivalent,
  mergeDbOnlyHistoryRows,
} from '../lib/reconcile-last-assistant-from-history.js'
import { buildStreamDisplayRow } from '../lib/build-stream-display-row.js'
import { logStreamCompareAgUiDrain } from '../lib/stream-compare-file-log.js'
import { resolveUserMessageSkillDisplay } from '../lib/preferred-skill-display.js'
import { mergeStreamSnapIntoAssistantRow, mergeAssistantRowWithStreamRow } from '../lib/merge-assistant-stream-row.js'
import {
  collapseSameTurnAssistantsInRows,
  shouldMergeFinalIntoPriorAssistant,
} from '../lib/collapse-same-turn-assistants.js'

// v3.5 阶段 F2 commit 1: module 顶层 helper 抽到 ./chat-app/utils/
import {
  STORAGE_MODEL_KEY,
  LS_LAST_SELECTED_SESSION,
  THINKING_LEVEL_OPTIONS,
  type ThinkingLevel,
} from './utils/storage.js'
import {
  turnBusyForSession,
  coalesceCreateSession,
  getGlobalCreateSessionInflight,
} from './utils/session-busy.js'
import {
  flattenLiveSnapshotText,
  buildLiveRunSnapshotPayload,
  blockWireFromChatPayload,
} from './utils/stream-snapshot.js'
import {
  segmentTimelineHasTextBody,
  segmentTimelineHasPostToolText,
  segmentTimelineHasInterleavedTools,
  sortSegmentsBySeqIfPresent,
  dedupSegmentsById,
  mergeAuthoritativeDisplaySegments,
  authoritativeFinalFromPayload,
} from './utils/segments.js'

// v3.5 阶段 F2 / P0: 其余 module 顶层 helper → ./chat-app/**
import {
  debugSubtaskTooltipEnabled,
  debugSubtaskFlowEnabled,
  debugAssistantDedupEnabled,
  shortLogText,
} from './utils/debug-flags.js'
import {
  _pathBasename,
  isDesktopTauriRuntime,
  TAURI_HEADER_CELL_DRAG_PROPS,
  THREAD_STATE_EXPIRY_MS,
  QUICK_PROMPTS,
} from './utils/desktop-workspace.js'
import {
  resolveSessionAgentCodeForUi,
  getSessionCollabModeFromMeta,
  getThinkingLevelFromMeta,
} from './utils/session-meta.js'
import {
  comparableAssistantText,
  shouldReplaceFinalAssistantRow,
  findFirstAssistantAfterRealUser,
  collapseToolApprovalContinuationRows,
  recentTranscriptForPromptEnhance,
} from './utils/transcript-rows.js'
import {
  emptyThreadPanel,
  clearThreadPanelActivity,
  applyThreadStatePanelPatch,
} from './thread-panel/state.js'
import {
  parseClarificationFromTool,
  extractLatestClarificationFromRows,
  rowsAwaitUserReplyAfterSend,
  mergeThreadPanelClarification,
  clearThreadPanelClarification,
  shouldSuppressClarificationPanel,
} from './thread-panel/clarification.js'
import {
  getGoalProposeActionMode,
  goalProposalSuppressKey,
  extractGoalProposalFromTools,
  extractLatestGoalProposalFromRows,
} from './thread-panel/goal-proposal.js'
import {
  parseParentAndSubtaskIdFromComposite,
  collabStatusFromSubagentStreamEv,
  patchCollabSubtasksById,
  mergeCollabSubtasksStable,
  finalizeCollabSubtasksList,
} from './collab/subtask-merge.js'



/**
 * Owns ChatApp state, effects, and handlers. Returns the host bag for renderChatAppView.
 * Extracted from ChatApp.tsx (P151).
 */
export function useChatAppController() {
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
    const { gatewayFetch } = await import('../../lib/gateway-json.js')
    const p = path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? path : `/${path}`}`
    return gatewayFetch(p, init)
  }, [])

  const putLiveRunSnapshotBestEffort = useCallback(
    (sessionKey: string, snapshot: { runId: string; threadId: string | null; status: string; partialText: string; partialTools: unknown[]; partialDisplaySegments?: MessageSegment[]; lastEventAtMs: number }) => {
      putLiveRunSnapshotBestEffortImpl(
        {
          liveRunPersistPendingRef,
          liveRunPersistTimerRef,
          gatewayApiFetch,
        },
        sessionKey,
        snapshot,
      )
    },
    [gatewayApiFetch],
  )

  const deleteLiveRunSnapshotBestEffort = useCallback(
    (sessionKey: string) => {
      deleteLiveRunSnapshotBestEffortImpl(
        {
          liveRunPersistPendingRef,
          liveRunPersistTimerRef,
          gatewayApiFetch,
        },
        sessionKey,
      )
    },
    [gatewayApiFetch],
  )

  const historyLiveContext = useMemo(
    () =>
      buildHistoryLiveContext({
        selectedSessionKey,
        getSessionRuntime,
        isSessionRuntimeLive,
        executingSessionKeys,
        sessions,
        isTurnBusy,
      }),
    [selectedSessionKey, executingSessionKeys, executingListEpoch, sessions],
  )

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
  /**
   * 显式打开工作台仪表盘（侧栏「工作台」/ shell-open-home）。
   * V4 下「新对话」空草稿不再自动进首页；只有 preferHomeDashboard 才挂 EvoFlowHomeDashboard。
   */
  const [preferHomeDashboard, setPreferHomeDashboard] = useState(false)
  useLayoutEffect(() => {
    rowsRef.current = rows
  }, [rows])
  useLayoutEffect(() => {
    setSessionHadContent(false)
  }, [selectedSessionKey])
  useEffect(() => {
    if (Array.isArray(rows) && rows.length > 0) {
      setSessionHadContent(true)
      setPreferHomeDashboard(false)
    }
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
    runSessionSwitchLayoutEffect({
      activeChatRunIdRef,
      commitActiveSessionRuntime,
      displayRowsEquivalent,
      emptyStream,
      getSessionRuntime,
      isSessionRuntimeLive,
      markResumeAnchorAssistantIncomplete,
      mountSessionRuntime,
      prevSelectedSessionCleanupRef,
      prevSwitchRevisionRef,
      reattachRetryCountRef,
      refreshAttachAttemptedRef,
      rowsRef,
      seenRunIdsRef,
      selectedSessionKey,
      sessionRef,
      sessionSwitchFromRef,
      sessionsRef,
      setRows,
      shellSelectRevision,
      ssLog,
      skTail,
      streamRef,
      streamRefKeyRef,
    })
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
  /** V4 ConversationTimeline sticky bottomDock 挂载点：EvoFlow 输入区 portal 进去，与 ZCode 同滚动视口。 */
  const [v4ComposerHostEl, setV4ComposerHostElState] = useState<HTMLElement | null>(null)
  // 回调 ref：同节点身份不 setState；避免 portal/侧栏开合时 null→el 空转触发 #185。
  const setV4ComposerHostEl = useCallback((node: HTMLElement | null) => {
    setV4ComposerHostElState((prev) => (prev === node ? prev : node))
  }, [])
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
    refreshSpeechConfiguredImpl({ setSpeechEnabled })
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
      maybeSyncVoiceReplySpeechImpl(
        {
          voiceReplyPendingRef,
          voiceSessionKeyRef,
          voiceSpeechSyncedPlainRef,
          voiceStreamingStartedRef,
        },
        replySk,
        S,
        rt,
      )
    },
    [],
  )
  const handleVoiceTranscribedRef = useRef<
    (text: string, opts?: { global?: boolean }) => Promise<void>
  >(async () => {})

  useEffect(() => {
    // ✅ 修复：只注册一次！不要依赖 selectedSessionKey，否则每次切会话就重新注册
    // 我们用 sessionRef.current 读最新值，不需要放在依赖项里
    return runVoiceSendHandlerEffect({
      registerVoiceSendHandler,
      unregisterVoiceSendHandler,
      selectedSessionKey,
      sessionRef,
      ensureChatSessionKeyRef,
      handleVoiceTranscribedRef,
    })
  }, [])
  const lastPlanPanelHitRef = useRef<PlanPanelHit | null>(null)
  const [planPanelHit, setPlanPanelHit] = useState<PlanPanelHit | null>(null)
  /** 流式中一旦出现 plan 即置位；final 合并丢 input 时仍展示计划面板 */
  const planStreamLatchRef = useRef<PlanStreamLatch>(null)
  const [planStreamLatched, setPlanStreamLatched] = useState(false)
  const publishPlanPanelHit = useCallback((hit: PlanPanelHit | null) => {
    publishPlanPanelHitImpl(
      {
        lastPlanPanelHitRef,
        setPlanPanelHit,
        planStreamLatchRef,
        setPlanStreamLatched,
      },
      hit,
    )
  }, [])
  /** final 清空 stream 后仍用于 plan 检测的合并工具行（避免落库 name-only 覆盖流式入参） */
  const lastPlanDetectionToolsRef = useRef<unknown[]>([])
  /** 流式全程累积的最完整 plan 入参（final / emptyStream 不丢） */
  const persistedPlanInputRef = useRef<Record<string, unknown> | null>(null)
  const lastPlanSyncSigRef = useRef('')

  const resetPlanStreamSession = useCallback(() => {
    resetPlanStreamSessionImpl({
      lastPlanPanelHitRef,
      setPlanPanelHit,
      planStreamLatchRef,
      setPlanStreamLatched,
      lastPlanDetectionToolsRef,
      persistedPlanInputRef,
      lastPlanSyncSigRef,
    })
  }, [])

  const absorbPlanFromTools = useCallback((tools: unknown[]) => {
    absorbPlanFromToolsImpl(
      {
        persistedPlanInputRef,
        planStreamLatchRef,
        setPlanStreamLatched,
        setThreadPanelState,
        publishPlanPanelHit,
      },
      tools,
    )
  }, [publishPlanPanelHit])
  const planResolveInFlightRef = useRef(false)
  /** 同一会话+任务只拉一次 plan / collab 快照，避免多路 effect 重复请求导致面板闪烁 */
  const planAppliedForRef = useRef('')
  const planApiSyncInflightRef = useRef<Promise<void> | null>(null)
  const [planDockApiView, setPlanDockApiView] = useState<PlanDockApiView | null>(null)
  const planDockApiViewRef = useRef<PlanDockApiView | null>(null)
  const applyPlanDockApiView = useCallback((view: PlanDockApiView) => {
    applyPlanDockApiViewImpl(
      {
        planDockApiViewRef,
        tracePlanDockApi,
        setPlanDockApiView,
      },
      view,
    )
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
    void import('../lib/composer-latency-warmup.js').then((mod) => {
      void mod.warmComposerSession(sk)
    })
  }, [selectedSessionKey])

  const [threadPanelState, setThreadPanelState] = useState<ThreadPanelState>(emptyThreadPanel())
  const threadPanelStateRef = useRef<ThreadPanelState>(emptyThreadPanel())
  const commitThreadPanelForSession = useCallback(
    (sessionKey: string, updater: (prev: ThreadPanelState) => ThreadPanelState) => {
      commitThreadPanelForSessionImpl(
        {
          sessionRef,
          selectedSessionKey,
          setThreadPanelState,
          threadPanelBySessionRef,
          emptyThreadPanel,
        },
        sessionKey,
        updater,
      )
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
    return runHomeWindowListenersEffect({
      sessionRef,
      setSessionHadContent,
      setPreferHomeDashboard,
      setSelectedSkills,
      setSelectedPlugins,
      setModelNameRef,
      setMemoryEnabled,
      setVoiceReplyEnabled,
      ensureChatSessionKeyRef,
      attachContextFilesRef,
      wsClient,
      handleSendRef,
      handleHomeSendEvent,
      handleHomeSelectModelEvent,
      handleHomeSetMemoryEvent,
      handleHomeSetVoiceReplyEvent,
    })
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
    return runLoadSessionArtifactsEffect({
      selectedSessionKey,
      setSessionArtifacts,
      setSessionPlatformEntries,
      turnPlatformEntriesRef,
      setPlatformFocusEntryId,
      setTurnArtifacts,
      setArtifactFocusId,
      setTurnPlatformEntries,
      evoflowInvokeGatewayJson,
      normalizeChatArtifacts,
      platformRunEntriesFromChatArtifacts,
    })
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
    bumpStreamChromeThrottledImpl({
      streamRefKeyRef,
      sessionRef,
      streamChromeBumpPendingRef,
      isChatOverlayDeferActive,
      STREAM_OVERLAY_DEFER_CHROME_MS,
      isStreamThrottleEnabled,
      STREAM_CHROME_BUMP_MS,
      STREAM_BUMP_INTERVAL_MS,
      streamChromeLastBumpRef,
      bumpSessionRuntimeNotifyForKey,
      streamChromeBumpTimerRef,
    })
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
  const workerFileBumpSchedulerRef = useRef<ReturnType<typeof createStreamBumpScheduler> | null>(null)
  const reasoningBumpSchedulerRef = useRef<ReturnType<typeof createStreamBumpScheduler> | null>(null)
  const bgRuntimeNotifySchedulerRef = useRef<ReturnType<typeof createStreamBumpScheduler> | null>(null)
  ensureStreamBumpSchedulers({
    STREAM_BG_RUNTIME_NOTIFY_MS,
    STREAM_BUMP_INTERVAL_MS,
    STREAM_OVERLAY_DEFER_RUNTIME_NOTIFY_MS,
    STREAM_REASONING_BUMP_INTERVAL_MS,
    bgRuntimeNotifySchedulerRef,
    bgRuntimeNotifySessionRef,
    bumpSessionRuntimeNotifyForKey,
    chatSurfaceVisibleRef,
    createStreamBumpScheduler,
    isChatOverlayDeferActive,
    isStreamThrottleEnabled,
    onCoalescedStreamBumpRef,
    reasoningBumpSchedulerRef,
    sessionRef,
    streamBumpMinIntervalRef,
    streamBumpSchedulerRef,
    workerFileBumpSchedulerRef,
  })
  useEffect(
    () => () => {
      disposeStreamBumpSchedulers({
        bgRuntimeNotifySchedulerRef,
        reasoningBumpSchedulerRef,
        streamBumpSchedulerRef,
        streamChromeBumpTimerRef,
        workerFileBumpSchedulerRef,
      })
    },
    [],
  )

  const cancelPendingStreamUiBumps = useCallback(() => {
    cancelPendingStreamUiBumpsImpl({
      streamBumpSchedulerRef,
      reasoningBumpSchedulerRef,
      workerFileBumpSchedulerRef,
      streamChromeBumpTimerRef,
      streamChromeBumpPendingRef,
    })
  }, [])
  cancelPendingStreamUiBumpsRef.current = cancelPendingStreamUiBumps

  useEffect(() => {
    runChatOverlayDeferEffect({
      knowledgeMapEnabled,
      knowledgeMapPanelOpen,
      workspacePanelOpen,
      collabExecPanelOpen,
      setChatOverlayDefer,
      cancelPendingStreamUiBumpsRef,
    })
  }, [
    rightStageOpen,
    workspacePanelOpen,
    knowledgeMapEnabled,
    knowledgeMapPanelOpen,
    collabExecPanelOpen,
  ])

  useEffect(() => {
    return runSidePanelHeavyMountEffect({
      knowledgeMapEnabled,
      knowledgeMapPanelOpen,
      rightStageOpen,
      workspacePanelOpen,
      collabExecPanelOpen,
      setSidePanelHeavyMount,
    })
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
      void import('../../lib/tauri-api.js').catch(() => {})
    }
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(warm, { timeout: 8000 })
    } else {
      setTimeout(warm, 3000)
    }
  }, [])

  const reloadHistoryFromDb = useCallback(
    async (opt?: { bypassCache?: boolean; anchorRunId?: string | null; dbOnly?: boolean }) => {
      return reloadHistoryFromDbImpl(
        {
          selectedSessionKey,
          resetSessionLiveStreamDisplay,
          streamRef,
          deleteLiveRunSnapshotBestEffort,
          markSessionResumeCatchupReplay,
          sessionRef,
          setThreadPanelState,
          clearThreadPanelActivity,
          threadPanelBySessionRef,
          bumpStreamFullRef,
          sfWarn,
          srLog,
          reload,
          getSessionRuntime,
          rowsRef,
          mergeDbOnlyHistoryRows,
          sfLog,
          sfSummarizeRowsTail,
          replaceSessionRuntimeRowsFromHistory,
          setRows,
          displayRowsEquivalent,
        },
        opt,
      )
    },
    [reload, selectedSessionKey, deleteLiveRunSnapshotBestEffort, setRows],
  )

  const streamingWritePreviewForPane = useMemo(
    () =>
      resolveStreamingWritePreviewForPane({
        streamRef,
        detectStreamingWritePreview,
        rightStageStore,
        rightStageSurface,
        streamingWritePreview,
      }),
    [streamTick, streamingWritePreview, rightStageSurface?.kind, rightStageSurface?.data, rightStageSnapshot.rev],
  )

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
      return isPlanExecDockSuppressedImpl(
        {
          planExecSuppressToken,
          suppressedPlanExecDockKeysRef,
        },
        taskId,
        subCount,
      )
    },
    [planExecSuppressToken],
  )

  const suppressPlanExecDock = useCallback(
    (taskId: string) => {
      suppressPlanExecDockImpl(
        {
          planExecSuppressToken,
          suppressedPlanExecDockKeysRef,
          setPlanExecSuppressVersion,
        },
        taskId,
      )
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
      setChatPanelDisplayModeImpl(
        {
          setChatPanelMode,
          saveChatSummaryDisplayMode,
          collapseRightStage,
        },
        mode,
      )
    },
    [collapseRightStage],
  )

  // 摘要已改挂对话正文右上角，启动时卸掉右栏里残留的 summary 标签。
  useEffect(() => {
    runCloseLeftoverSummaryStageEffect({
      closeSummaryStage,
      filterRightStageTabsForSession,
      rightStageStore,
      selectedSessionKey,
      collapseRightStage,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount: drop leftover summary tab
  }, [])
  const publishPlatformEntries = useCallback((entries: PlatformRunEntry[], focusEntryId?: string) => {
    publishPlatformEntriesImpl(
      {
        turnPlatformEntriesRef,
        setTurnPlatformEntries,
        setSessionPlatformEntries,
        rightStageStore,
        rightStageHintTimerRef,
        setInfoRailOpen,
        setInfoRailTab,
        latestPlatformRunEntryId,
        setPlatformFocusEntryId,
      },
      entries,
      focusEntryId,
    )
  }, [])
  const publishArtifacts = useCallback(
    (opts?: { focusId?: string; hint?: string; force?: boolean }) => {
      publishArtifactsImpl(
        {
          turnRunArtifactsRef,
          setTurnArtifacts,
          isAutoWorkPreviewEnabled,
          writeStreamModeRef,
          rightStageHintTimerRef,
          hideRightStageIfKind,
          setInfoRailOpen,
          setInfoRailTab,
          setArtifactFocusId,
          toast,
        },
        opts,
      )
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
        const { api } = await import('../../lib/tauri-api.js')
        const { getPanelSettingsSync } = await import('../../lib/panel-settings.js')
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
      void import('../../lib/panel-settings.js').then(({ getPanelSettingsSync }) => {
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

  /** 智能体员工列表（active），供 @员工 派发与输入框岗位按钮 / 侧栏员工下拉使用 */
  const { proactiveRoles, loadProactiveRoles } = useProactiveRoles()

  /** 把岗位名替换为智能体名（agent_name），让菜单/派发提示显示智能体本身的名字。 */
  const proactiveRolesDisplay = useMemo<MentionEmployeeOption[]>(
    () =>
      resolveProactiveRolesDisplay({
        proactiveRoles,
        agents,
        resolveAssignedAgentDisplayName,
      }),
    [proactiveRoles, agents],
  )

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

  const workspaceMention = useMemo(
    (): WorkspaceMentionConfig | undefined =>
      buildWorkspaceMentionConfig({
        effectiveWorkspaceRoot,
        selectedSessionKey,
        wsClient,
        basenameFromPath,
        setContextFiles,
        persistContextFiles,
        proactiveRolesDisplay,
        skillList,
        pluginList,
        addSelectedSkill,
        addSelectedPlugin,
      }) as WorkspaceMentionConfig | undefined,
    [
      effectiveWorkspaceRoot,
      persistContextFiles,
      selectedSessionKey,
      useVirtualPaths,
      proactiveRolesDisplay,
      skillList,
      pluginList,
      addSelectedSkill,
      addSelectedPlugin,
    ],
  )

  const [roleSwitchBusy, setRoleSwitchBusy] = useState(false)
  const scenarioSessionHandlers = useMemo(
    () =>
      buildScenarioSessionHandlers({
        selectedSessionKey,
        setSessionMode,
        wsClient,
        setSessions,
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
    runNormalizeRowFileUrlsEffect({
      wsClient,
      selectedSessionKey,
      setRows,
      normalizeRowFilesInPlace,
      streamRef,
      normalizeFileHrefForThread,
      scheduleBump,
    })
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
  const selectedSessionAgentId = useMemo(
    () =>
      resolveSelectedSessionAgentId({
        selectedSessionKey,
        sessions,
      }),
    [sessions, selectedSessionKey],
  )
  const currentRoleCodeForUi = useMemo(
    () =>
      resolveCurrentRoleCodeForUi({
        selectedSessionKey,
        isProactiveSessionKey,
        parseProactiveSessionKey,
        selectedSessionAgentId,
        resolveSessionAgentCodeForUi,
      }),
    [selectedSessionKey, roleUiNonce, selectedSessionAgentId],
  )

  /** 对话气泡 AI 头：纯显示名（不含标签前缀） */
  const assistantReplyLabel = useMemo(
    () =>
      resolveAssistantReplyLabel({
        currentRoleCodeForUi,
        agents,
      }),
    [currentRoleCodeForUi, agents],
  )

  const currentRoleLabel = useMemo(
    () =>
      resolveCurrentRoleLabel({
        currentRoleCodeForUi,
        agents,
        normalizeAgentTags,
      }),
    [currentRoleCodeForUi, agents],
  )

  /** 当前会话绑定智能体的默认模型（空 = 跟全局 primary） */
  const agentDefaultModelName = useMemo(
    () =>
      resolveAgentDefaultModelName({
        currentRoleCodeForUi,
        agents,
      }),
    [currentRoleCodeForUi, agents],
  )

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

  const currentAgentCapabilities = useMemo(
    () =>
      resolveCurrentAgentCapabilities({
        agentCapabilitySummary,
        currentRoleAgent,
        selectedSkills,
      }),
    [currentRoleAgent, selectedSkills],
  )

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
    return runLoadEmployeeRoleDetailEffect({
      employeeSessionAgentCode,
      setEmployeeRoleDetail,
    })
  }, [employeeSessionAgentCode, roleUiNonce])

  /** 进入员工会话时按 session_key 同步 workspace_kind，不再用底栏「只聊天/派任务」模式条 */
  useEffect(() => {
    runSyncProactiveWorkspaceKindEffect({
      isProactiveEmployeeSession,
      selectedSessionKey,
      parseProactiveSessionKey,
      wsClient,
      setSessionModeInMeta,
      setSessionMode,
    })
  }, [isProactiveEmployeeSession, selectedSessionKey])

  /** 切换/新建会话：清空 plan latch、协作侧栏与 suppress，避免串会话显示上一对话的计划/子任务。 */
  const resetCollabPlanUiForSession = useCallback(
    (opts?: { keepBoundTaskId?: boolean; closeSidebar?: boolean }) => {
      resetCollabPlanUiForSessionImpl(
        {
          sessionRef,
          selectedSessionKey,
          suppressedPlanExecDockKeysRef,
          userAuthorizedTaskIdsRef,
          planAppliedForRef,
          planApiSyncInflightRef,
          historyCollabHydratedRef,
          historyRowsBootstrappedRef,
          planFromApiLoadedRef,
          planDockApiViewRef,
          threadCollabSnapshotRef,
          sessionBoundTaskIdRef,
          lastPlanSyncSigRef,
          planStreamLatchRef,
          lastPlanPanelHitRef,
          prevCollabExecPhaseRef,
          collabExecSessionBaselinedRef,
          collabExecDismissedKeysRef,
          resetPlanStreamSession,
          clearSidebarBackfillCaches,
          setPlanExecSuppressVersion,
          setThreadPanelState,
          setPlanDockApiView,
          setPlanStreamLatched,
          setBoundTaskId,
          setSidebarTaskViews,
          setSidebarSelectedTaskId,
          setHasReceivedTodos,
          setSessionSidebarOpen,
          setCollabExecPanelOpen,
          setKnowledgeMapPanelOpen,
        },
        opts,
      )
    },
    [resetPlanStreamSession, clearSidebarBackfillCaches, selectedSessionKey],
  )

  /** 同会话内开启新一轮 plan：保留会话/thread，清空上一轮 plan/执行侧栏 latch。 */
  const resetCollabPlanUiForNewCycle = useCallback(() => {
    resetCollabPlanUiForNewCycleImpl({
      sessionRef,
      selectedSessionKey,
      suppressedPlanExecDockKeysRef,
      userAuthorizedTaskIdsRef,
      planAppliedForRef,
      planApiSyncInflightRef,
      historyCollabHydratedRef,
      historyRowsBootstrappedRef,
      planFromApiLoadedRef,
      planDockApiViewRef,
      threadCollabSnapshotRef,
      sessionBoundTaskIdRef,
      lastPlanSyncSigRef,
      planStreamLatchRef,
      lastPlanPanelHitRef,
      prevCollabExecPhaseRef,
      collabExecSessionBaselinedRef,
      collabExecDismissedKeysRef,
      resetPlanStreamSession,
      clearSidebarBackfillCaches,
      setPlanExecSuppressVersion,
      setThreadPanelState,
      setPlanDockApiView,
      setPlanStreamLatched,
      setBoundTaskId,
      setSidebarTaskViews,
      setSidebarSelectedTaskId,
      setHasReceivedTodos,
      setSessionSidebarOpen,
      setCollabExecPanelOpen,
      setKnowledgeMapPanelOpen,
    })
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
    patchCollabFromStreamToolsImpl(
      {
        patchCollabThrottleRef,
        patchCollabPendingOptsRef,
        patchCollabTimerRef,
        lastPlanPanelHitRef,
        planStreamLatchRef,
        planStreamLatched,
        boundTaskId,
        threadPanelState,
        collectCollabToolsForSidebar,
        collectPlanToolsForDetection,
        syncPlanPanelImmediateFromTools,
        setThreadPanelState,
        upsertSidebarTaskView,
        ensureSubtasksVisibleForTask,
        patchCollabFromStreamTools,
      },
      opts,
    )
  }, [
    boundTaskId,
    collectCollabToolsForSidebar,
    ensureSubtasksVisibleForTask,
    upsertSidebarTaskView,
    syncPlanPanelImmediateFromTools,
    collectPlanToolsForDetection,
    planStreamLatched,
    threadPanelState,
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
    applyPendingShellSessionImpl({
      processedTaskIdRef,
      sessionRef,
      setBoundTaskId,
      getApi,
      refreshSessions: (opts) => refreshSessionsRef.current?.(opts),
      bindSessionThread: (sk, tid, opts) => wsClient.bindSessionThread(sk, tid, opts),
      reload: (opts) => reload(opts),
      openCollabExecPanel,
    })
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
    runClarificationHydrateEffect({
      findAskClarificationAwaitingUserInRows,
      extractLatestClarificationFromRows,
      extractLatestGoalProposalFromRows,
      goalProposalSuppressKey,
      historyBoundSessionKey,
      historyInstantPaint,
      historyLoading,
      mergeThreadPanelClarification,
      peekClarificationLatch,
      rows,
      rowsAwaitUserReplyAfterSend,
      scheduleClarificationPanelResolve,
      selectedSessionKey,
      selectedTurnBusy,
      setThreadPanelState,
      shouldSuppressClarificationPanel,
      suppressedGoalProposalKeysRef,
      threadPanelStateRef,
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
    return runMoreMenuDismissEffect({ moreMenuKey, setMoreMenuKey })
  }, [moreMenuKey])

  // 「更多」上拉：挂到 body + fixed，避开输入区上拉后父级 overflow 裁切
  useLayoutEffect(() => {
    return runBottomMorePortalLayoutEffect({
      bottomMoreOpen,
      bottomMoreTriggerRef,
      setBottomMorePortalStyle,
    })
  }, [bottomMoreOpen])

  // 插件快捷面板：锚定 + 按钮上方（与 bottom-more 同一定位机制）
  useLayoutEffect(() => {
    return runPluginPanelPortalLayoutEffect({
      bottomPluginPanelOpen,
      bottomMoreTriggerRef,
      setPluginPanelStyle,
    })
  }, [bottomPluginPanelOpen])

  // 底部「模式 + 模型/创意/工作空间」上拉：互斥 + 点击外部 / Esc 全部关闭
  // 技能 / 角色已改为独立 modal，不参与此下拉互斥逻辑
  useEffect(() => {
    return runBottomMenusDismissEffect({
      modeMenuOpen,
      bottomModelOpen,
      bottomPermissionOpen,
      bottomMoreOpen,
      bottomWorkspaceOpen,
      bottomPluginPanelOpen,
      setModeMenuOpen,
      setBottomModelOpen,
      setBottomPermissionOpen,
      setBottomMoreOpen,
      setMoreSubOpen,
      setBottomWorkspaceOpen,
      setBottomRoleOpen,
      setBottomSkillOpen,
      setBottomPluginPanelOpen,
      bottomModelRootRef,
      bottomPermissionRootRef,
      bottomMoreRootRef,
      bottomWorkspaceRootRef,
    })
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

  const onGoalRunningChange = useCallback(
    createOnGoalRunningChange({ sessionRef, setLiveTurnAssistantRunId }),
    [],
  )

  const goal = useGoalMode({
    sessionKey: selectedSessionKey,
    chatModelName: modelName,
    onGoalClosureReport,
    onGoalRunningChange,
    onGoalSendingChange: createOnGoalSendingChange({
      selectedSessionKey,
      sessionRef,
      clearStreamReattachCooldown,
      resetStreamStopLogDedupe,
      dispatchSessionTurnEvent,
      dispatchSessionRunEnded,
    }),
    // @ts-ignore
    onRefreshChatHistory: createOnRefreshChatHistory({
      sessionRef,
      reloadHistoryFromDb,
      fetchAndCacheSessionExecutionState,
      getSessionRuntime,
      isLivePostStreamOpen,
      isTurnBusy,
      isSessionRuntimeLive,
      logStreamStop,
      clearSessionExecutionProbe,
      dispatchSessionTurnEvent,
    }),
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
    return runOpenGoalPanelListenerEffect({ goal })
  }, [goal.goal])

  const scheduleBumpHost = {
    STREAM_BUMP_INTERVAL_MS,
    bgRuntimeNotifySchedulerRef,
    bgRuntimeNotifySessionRef,
    bumpSessionRuntimeNotifyForKey,
    chatStreamBgApplyRef,
    chatSurfaceVisibleRef,
    isChatOverlayDeferActive,
    isStreamThrottleEnabled,
    reasoningBumpSchedulerRef,
    resolveStreamBumpMinIntervalMs,
    sessionRef,
    streamBumpMinIntervalRef,
    streamBumpSchedulerRef,
    streamPerfNoteBumpThrottle,
    streamRef,
    streamRefKeyRef,
  }
  const scheduleBump = useCallback(createScheduleBump(scheduleBumpHost), [])
  const scheduleReasoningBump = useCallback(createScheduleReasoningBump(scheduleBumpHost), [])
  scheduleBumpRef.current = scheduleBump

  const afterLiveOrStructuralBump = useCallback(
    (
      sessionKey: string,
      stream: StreamState,
      opts: { liveTextOnly: boolean; immediate?: boolean; reasoning?: boolean },
    ) => {
      afterLiveOrStructuralBumpImpl(
        {
          chatStreamBgApplyRef,
          chatSurfaceVisibleRef,
          commitStreamSnapshot,
          scheduleBump,
          streamBumpSchedulerRef,
          streamSeqRef,
        },
        sessionKey,
        stream,
        opts,
      )
    },
    [scheduleBump, scheduleReasoningBump],
  )

  const turnSendingStateHost = {
    activeChatRunIdRef,
    clearActiveRun,
    dispatchSessionRunEnded,
    markSessionStreamWireSource,
    maybeClearTurnSendingState,
    setStreamHealth,
    streamHealthRef,
    wsClient,
  }
  const clearTurnSendingState = useCallback(
    (sessionKey: string, rt: ReturnType<typeof getSessionRuntime>, isBackground: boolean) => {
      clearTurnSendingStateImpl(turnSendingStateHost, sessionKey, rt, isBackground)
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
      maybeEndTurnSendingStateImpl(turnSendingStateHost, sessionKey, rt, isBackground, opts)
    },
    [clearTurnSendingState],
  )

  // Stale turn-busy 看门狗（选中 90s / 全局 45s）已抽到
  // chat-app/session/use-stale-turn-watchdogs.ts
  const staleTurnWatchdogsCtx = useMemo<UseStaleTurnWatchdogsCtx>(
    () => ({
      selectedTurnBusy,
      selectedSessionKey,
      sessionsRef,
      clearTurnSendingState,
      refreshAttachAttemptedRef,
      wsClient,
    }),
    [selectedTurnBusy, selectedSessionKey, clearTurnSendingState],
  )
  useSelectedStaleTurnWatchdog(staleTurnWatchdogsCtx)
  useGlobalStaleBusyPoll(staleTurnWatchdogsCtx)

  /** 刷新/关窗时若仍 busy，落 page_unload（靠 frontend-*.log / LS ring 事后排查） */
  useEffect(() => {
    return installStreamStopPageUnloadHook(() => listBusySessionKeys())
  }, [])

  useEffect(() => {
    void fetchGlobalToolApprovalPolicy().catch(() => {})
  }, [])

  useEffect(() => {
    return runToolApprovalPolicyListenersEffect({
      setToolApprovalPolicyTick,
      scheduleRefreshSessions,
      applyFullAccessToCurrentSessionRef,
      toast,
      TOOL_APPROVAL_POLICY_CHANGED,
      TOOL_APPROVAL_SESSION_POLICY_CHANGED,
      TOOL_APPROVAL_REQUEST_SESSION_FULL_ACCESS,
    })
  }, [scheduleRefreshSessions])

  useEffect(() => {
    return runFetchSessionToolApprovalEffect({
      selectedSessionKey,
      fetchSessionToolApprovalPolicy,
      wsClient,
      setToolApprovalPolicyTick,
    })
  }, [selectedSessionKey])

  useEffect(() => {
    if (!selectedSessionKey) toolApprovalResolvedIdsRef.current = new Set()
  }, [selectedSessionKey])

  const toolApprovalUiDisabled = useMemo(
    () =>
      resolveToolApprovalUiDisabled({
        toolApprovalPolicyTick,
        sessionRef,
        selectedSessionKey,
        isEffectiveToolApprovalGrantAll,
        wsClient,
      }),
    [selectedSessionKey, toolApprovalPolicyTick, listLoading],
  )

  async function getApi() {
    if (apiRef.current) return apiRef.current
    const mod = await import('../../lib/tauri-api.js')
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
    return runPendingNavFromStorageEffect({
      handleNewSessionRef,
      handleOpenHomeRef,
      startNewChatWithPresetAgent,
      restoreComposerDraft,
    })
  }, [restoreComposerDraft])

  useEffect(() => {
    return runChatMountBootstrapEffect({
      getApi,
      isPlaceholderSessionTitle,
      loadModelCatalog,
      patchSessionTitleInRows,
      pickSessionRowTitle,
      refreshSpeechConfigured,
      reviveAllTurnBusyIfLivePostOpen,
      scheduleRefreshSessions,
      sessionsRef,
      setChatSurfaceVisible,
      setDynamicModes,
      setSessionNamesTick,
      setSessions,
      setSessionTitle,
      syncSessionRowRef,
      wsClient,
    })
  }, [refreshSessions, scheduleRefreshSessions, loadModelCatalog, refreshSpeechConfigured])

  useEffect(() => {
    return runThreadPanelSseEffect({
      applyStreamTurnEvent,
      scheduleBumpRef,
      selectedSessionKey,
      sessions,
      setSessionActivity,
      streamRef,
      wsClient,
    })
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
    return runInitialAgentsLoadEffect({
      getApi,
      setAgents,
      mapAgentPickerRows,
      setAgentsDisplayCache,
    })
  }, [])

  const refreshAgentsList = useCallback(async () => {
    await refreshAgentsListImpl({
      getApi,
      setAgents,
      setRoleUiNonce,
    })
  }, [])

  useEffect(() => {
    return runEngineReadyListenerEffect({
      setEngineReady,
      refreshAgentsList,
    })
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
    applySessionSwitchUiShellImpl({
      selectedSessionKey,
      sessionSwitchFromRef,
      composerTextRef,
      composerDraftsRef,
      threadPanelStateRef,
      threadPanelBySessionRef,
      planSessionEnterRef,
      refreshAttachAttemptedRef,
      lastStreamWritePathRef,
      planResolveInFlightRef,
      processedTaskIdRef,
      boundTaskIdRef,
      lastActivityRef,
      pendingComposerDraftCarryRef,
      pendingNewSessionWorkspaceRef,
      sessionRef,
      rowsRef,
      bumpStreamFullRef,
      setStreamingWritePreview,
      setWorkspacePanelOpen,
      setWorkspaceTreePinned,
      setSubagentDockTasks,
      setThreadPanelState,
      setHasReceivedTodos,
      setSessionMode,
      setCollabOn,
      setModeMenuOpen,
      setLocalWorkspaceRoot,
      setContextFiles,
      setWorkspaceHistory,
      setGlobalWorkspaceHistory,
      shellIntentWorkspaceRef,
      syncShellAsideForWorkspacePanel,
      resetCollabPlanUiForSession,
      maybeEndTurnSendingState,
      restoreComposerDraft,
      getSessionContext: (sk) => wsClient.getSessionContext(sk) as Record<string, unknown>,
      getWorkspaceHistory: (sk) => wsClient.getWorkspaceHistory(sk),
      getGlobalWorkspaceHistory: () => wsClient.getGlobalWorkspaceHistory(),
    })
  }, [selectedSessionKey, resetCollabPlanUiForSession, restoreComposerDraft, maybeEndTurnSendingState])

  useEffect(() => {
    const onWorkspace = (ev: Event) => {
      handleSessionWorkspaceUpdatedEvent(
        {
          selectedSessionKey,
          setLocalWorkspaceRoot,
          setWorkspaceHistory,
          setGlobalWorkspaceHistory,
          bumpStreamFull: () => bumpStreamFullRef.current(),
          getWorkspaceHistory: (sk) => wsClient.getWorkspaceHistory(sk),
          getGlobalWorkspaceHistory: () => wsClient.getGlobalWorkspaceHistory(),
        },
        ev,
      )
    }
    window.addEventListener('evopanel:session-workspace-updated', onWorkspace as EventListener)
    return () => window.removeEventListener('evopanel:session-workspace-updated', onWorkspace as EventListener)
  }, [selectedSessionKey])

  /** 切换会话时异步拉取工作空间历史（刷新后缓存为空时补全） */
  useEffect(() => {
    return startHydrateSessionWorkspaceHistory({
      selectedSessionKey,
      setLocalWorkspaceRoot,
      setWorkspaceHistory,
      setGlobalWorkspaceHistory,
      hydrateGlobalWorkspaceHistoryOnce: () => wsClient.hydrateGlobalWorkspaceHistoryOnce(),
      ensureSessionWorkspaceHistory: (sk) => wsClient.ensureSessionWorkspaceHistory(sk),
      getSessionContext: (sk) => wsClient.getSessionContext(sk) as Record<string, unknown>,
      getWorkspaceHistory: (sk) => wsClient.getWorkspaceHistory(sk),
      getGlobalWorkspaceHistory: () => wsClient.getGlobalWorkspaceHistory(),
    })
  }, [selectedSessionKey])

  // Shared SQLite index per workspace root; background warm — gated by user toggle (default off).
  useEffect(() => {
    return installProjectCodeIndexWatch({
      workspaceIndexWatchEnabled,
      useVirtualPaths,
      effectiveWorkspaceRoot,
    })
  }, [effectiveWorkspaceRoot, useVirtualPaths, workspaceIndexWatchEnabled])

  useEffect(() => {
    return installVirtualCodeIndexWatch({
      workspaceIndexWatchEnabled,
      useVirtualPaths,
      threadId: String(wsClient.getSessionThreadId(selectedSessionKey) || '').trim(),
    })
  }, [useVirtualPaths, selectedSessionKey, workspaceIndexWatchEnabled])

  /** 协作任务执行中：WebSocket 推送 phase / 侧栏 snapshot / 子任务进度（替代 HTTP 轮询）。 */
  useEffect(() => {
    return runCollabUnifiedWsEffect({
      applyTaskProgressSnapshot,
      boundTaskId,
      collabOn,
      dispatchCollabCustomEvent,
      ensureSubtasksVisibleForTask,
      executingSessionKeysRef,
      isActiveSessionFetch,
      isPendingSubtaskKey,
      isSessionGoalActive,
      selectedSessionKey,
      sessionTasksFetchSeqRef,
      setThreadPanelState,
      subscribeCollabThreadWs,
      threadPanelState,
      turnBusyForSession,
      wsClient,
    })
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
  requestManualStreamResumeRef.current = (sessionKey, opts) => {
    requestManualStreamResume(
      {
        bumpReattachRetryRef,
        getSessionRuntime,
        manualReattachSessionKeyRef,
        reattachRetryCountRef,
        refreshAttachAttemptedRef,
        refreshSessionsRef,
        sessionRef,
        sessionsRef,
        setNewChatButtonActive,
        setSelectedSessionKey,
        shouldSuppressAutoReattach,
        srLog,
        wsClient,
      },
      sessionKey,
      opts,
    )
  }

  /** F5 刷新页面：会话列表就绪后若 DB 仍 running，改为 history-watch（拉 messages）直至结束 */
  useEffect(() => {
    runPageLoadResumeEffect({
      listLoading,
      pageLoadResumeDoneRef,
      requestManualStreamResumeRef,
      selectedSessionKey,
      sessions,
      stopSessionExecutionRef,
      toast,
    })
  }, [listLoading, selectedSessionKey, sessions])

  /**
   * visibilitychange / online: 后台切回前台或网络恢复后自动 reattach 活跃 run。
   *
   * 浏览器后台标签会断开 SSE 连接（POST /runs/stream 的 fetch body stream），
   * 回到前台后需检测当前会话是否有活跃 run，若有则触发 stream-resume 续接。
   */
  const hiddenSinceRef = useRef<number | null>(null)
  useEffect(() => {
    return runVisibilityReattachEffect({
      evoflowFetch,
      hiddenSinceRef,
      isSessionRecoveryCooldownActive,
      refreshSessionsRef,
      requestManualStreamResumeRef,
      sessionRef,
      shouldManualRefreshResumeStream,
      shouldSuppressAutoReattach,
      srLog,
      wsClient,
    })
  }, [])

  useEffect(() => {
    return runChatWsOnEventEffect({
      DEGRADED_SNAPSHOT_SYSTEM_TEXT,
      EMPTY_RT_PRIOR_STRIP,
      NODE_REPL_BRIDGE_THREAD_ID,
      STORAGE_MODEL_KEY,
      THREAD_STATE_EXPIRY_MS,
      abortSessionTurnEnded,
      absorbPlanFromTools,
      activeChatRunIdRef,
      afterLiveOrStructuralBump,
      analyzePlanTools,
      applyAgUiWireEvent,
      applyDecideRightStage,
      applyGoalProposalRef,
      applyPlatformFeedbackFromToolResult,
      applyRightStageAgUiCustom,
      applyStageSetFromToolCall,
      applyStreamTurnEvent,
      applyTaskProgressSnapshot,
      applyThreadStatePanelPatch,
      assistantBodiesLooselySame,
      authoritativeFinalFromPayload,
      bgRuntimeNotifySchedulerRef,
      bgRuntimeNotifySessionRef,
      bindActiveRun,
      blockWireFromChatPayload,
      boundTaskId,
      buildCollabSidebarFromTools,
      buildLiveRunSnapshotPayload,
      buildPartialStreamAssistantRow,
      buildStreamDisplayRow,
      buildVoiceSpeechBodyForRuntime,
      bumpKnowledgeMapRefresh,
      bumpSessionRuntimeNotifyForKey,
      bumpSubtasksApiRefresh,
      chatRunIdsSameTurn,
      chatStreamBgApplyRef,
      clearActiveRun,
      clearSessionExecutionStateForEnded,
      clearThreadPanelActivity,
      cloneTerminalStreamTask,
      cloneTerminalStreamsMap,
      collabDagDebug,
      collabOn,
      collabStatusFromSubagentStreamEv,
      collapseSameTurnAssistantsInRows,
      collapseToolApprovalContinuationRows,
      collectPlanToolsForDetection,
      commitPriorTurnStripFromStreamTurn,
      commitStreamSnapshot,
      comparableAssistantText,
      computeTurnElapsedSec,
      consumeLatestScenarioToolForSession,
      debugAssistantDedupEnabled,
      debugSubtaskFlowEnabled,
      debugSubtaskTooltipEnabled,
      deleteLiveRunSnapshotBestEffort,
      detectAndScheduleClarificationRef,
      dismissedRightStageKindsRef,
      dispatchSessionRunEnded,
      dispatchSessionTurnEvent,
      drainAgUiCompletedRound,
      emptyAgUiTurnState,
      emptyThreadPanel,
      endClientPerfTurn,
      enrichToolsWithCachedPlanInput,
      ensureSubtasksVisibleForTask,
      extractChatContent,
      extractGoalProposalFromTools,
      extractLatestClarificationFromRows,
      filterStaleToolEntries,
      filterStaleToolTimelineSegments,
      filterStreamToolEntriesForRuntime,
      finalizeCollabSubtasksList,
      finalizeGhostRunningToolsBeforeNewRound,
      finalizeSessionTurnEnded,
      finalizeStreamTurn,
      findAskClarificationAwaitingUserInRows,
      findAssistantRowAfterLastUser,
      findAssistantRowBeforeTrailingUser,
      fixReasoningStreamText,
      flattenLiveSnapshotText,
      flattenStreamDisplayText,
      formatActivityDetailFromRunningToolCalls,
      formatAskClarificationForHosted,
      formatTurnDurationStr,
      formatUsageTokenStr,
      getActivityHint,
      getExpectedChatRunId,
      getGoalProposeActionMode,
      getSessionModeFromMeta,
      getSessionRuntime,
      goalActiveRef,
      goalCaptureRef,
      goalProposalSuppressKey,
      hasReceivedTodos,
      invalidateSessionRuntimeStatusCache,
      isActiveWriteTool,
      isAgUiLiveTextEvent,
      isAgUiStreamActive,
      isAgUiWireRunId,
      isAskClarificationToolPending,
      isAutoWorkPreviewEnabled,
      isBrowserToolWireName,
      isClarificationPreviewRenderable,
      isHiddenToolApprovalUserMessage,
      isLivePostStreamOpen,
      isPendingSubtaskKey,
      isPlanExecDockSuppressed,
      isSessionGoalActive,
      isSessionRecoveryCooldownActive,
      isStreamAutoPreviewPath,
      isStreamTurnLiveTextEvent,
      isTurnBusy,
      lastActivityRef,
      lastErrorRef,
      lastPlanDetectionToolsRef,
      lastPlanPanelHitRef,
      latestPlatformRunEntryId,
      logStreamCompareAgUiDrain,
      logStreamStop,
      logToolApprovalPendingDetected,
      logToolApprovalStreamFinal,
      markResumeAnchorAssistantIncomplete,
      markRunSealing,
      markSessionResumeCatchupReplay,
      maybeEndTurnSendingState,
      maybeSyncVoiceReplySpeech,
      mediaToolStatusFromOutput,
      mergeAssistantRowWithStreamRow,
      mergeBackgroundWorkEvent,
      mergeChatArtifacts,
      mergeCompactedPartsIntoTurn,
      mergeContextUsageSnapshots,
      mergeStreamSnapIntoAssistantRow,
      mergeSubagentStreamEvent,
      mergeTerminalIntoTool,
      mergeTerminalStreamEvent,
      mergeThreadPanelClarification,
      mergeToolsForPlanDetection,
      modelName,
      normalizeChatArtifacts,
      normalizeChatToolPayloadToEntries,
      normalizeFileHrefForThread,
      normalizeStreamActivityDetail,
      normalizeSubagentStreamEvent,
      noteSessionEvent,
      notifyDesktopCompletion,
      openSessionSidebar,
      parentTaskToSubtaskRef,
      parseClarificationFromTool,
      parseParentAndSubtaskIdFromComposite,
      parseTurnTimestampMs,
      parseUsageToStats,
      patchCollabFromStreamTools,
      patchCollabSubtasksById,
      patchPanelSettings,
      patchSessionListRunEnded,
      peekClarificationLatch,
      pendingAutoSessionTitleRef,
      persistSessionTitleIfMissing,
      persistedPlanInputRef,
      pickRicherStructuredPlanInput,
      planPanelHit,
      planStreamLatchRef,
      planStreamLatched,
      platformFeedbackSeenRef,
      priorStripForRuntime,
      projectAgUiToStreamTurnFields,
      publishArtifacts,
      publishPlanPanelHit,
      publishPlatformEntriesRef,
      putLiveRunSnapshotBestEffort,
      reconcileLastAssistantFromDbRef,
      reduceStreamTurn,
      refreshPlanDockAfterStreamFinalRef,
      releaseStreamBufferIfNeeded,
      reloadRef,
      resetRuntimeStream,
      reviveTurnBusyIfLivePostOpen,
      rightStageHintTimerRef,
      rightStageRunIdRef,
      rightStageStore,
      rightStageUserPinnedRef,
      rowHasPendingApprovalTools,
      rows,
      rowsAlreadyStopSealedForTurn,
      rowsRef,
      rtAddSeenRun,
      rtAddStoppedRun,
      rtHasSeenRun,
      rtIsStoppedRun,
      sanitizeFinalizedTurnForPersist,
      scenarioSessionHandlers,
      scheduleBump,
      sealOpenAgUiMessages,
      sealStoppedStreamTurn,
      seedAgUiTurnBaseline,
      seedSessionRuntimeStatusIdle,
      seenArtifactsRef,
      seenRunIdSet,
      seenRunIdsRef,
      segmentTimelineHasPostToolText,
      segmentTimelineHasTextBody,
      selectedSessionKey,
      sessionRef,
      sessions,
      setBrowserPanelThreadId,
      setExpectedChatRunId,
      setHasReceivedTodos,
      setLiveTurnAssistantRunId,
      setLiveTurnTokens,
      setModelName,
      setRows,
      setSessionActivity,
      setSessionArtifacts,
      setSessions,
      setStreamHealth,
      setSubagentDockTasks,
      setThreadPanelState,
      setVoiceTrayState,
      sfLog,
      sfSummarizeAgUi,
      sfSummarizeRowsTail,
      sfSummarizeSegments,
      sfWarn,
      shortLogText,
      shouldAcceptStreamTextPiece,
      shouldApplyChatEvent,
      shouldKeepStreamDeltaAfterStrip,
      shouldMergeFinalIntoPriorAssistant,
      shouldReleaseAgUiBufferBeforeToolStart,
      shouldReplaceFinalAssistantRow,
      shouldSuppressStreamDeliveredFiles,
      srLog,
      staleToolIdsExcludingTurnTools,
      startClientPerfTurn,
      streamDeltaShouldMergeTools,
      streamHealth,
      streamHealthRef,
      streamProject,
      streamRef,
      streamRefHasVisibleContent,
      streamRefKeyRef,
      streamSeqRef,
      streamTurnHasVisibleContent,
      stripMidTurnPartialAssistantRows,
      stripPriorTurnReasoningFromStream,
      suppressNextAbortToastRef,
      suppressedGoalProposalKeysRef,
      syncAgUiCompatProjection,
      syncBrowserPanelFromAgUiEvent,
      syncEmployeesRosterFromToolResult,
      syncPlanPanelImmediateFromTools,
      syncStreamMediaAssetsFromTools,
      syncStreamTurnFromAgUi,
      threadPanelBySessionRef,
      threadPanelState,
      threadPanelStateRef,
      timelineWithOpenAgUiAssistantText,
      toUserFacingError,
      toast,
      toolApprovalUiDisabled,
      tracePlanPipeline,
      turnBusyForSession,
      turnPlatformEntriesRef,
      turnRunArtifactsRef,
      updateSessionRuntimeRows,
      upsertTool,
      userInitiatedStopRef,
      voiceReplyPendingRef,
      voiceSessionKeyRef,
      voiceSpeechSyncedPlainRef,
      voiceStreamingStartedRef,
      watchBackgroundBashRef,
      workerFileBumpSchedulerRef,
      workspacePreviewTargetFromUrl,
      wsClient,
      unsubRef,
    })
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

  const selectedSessionLive = useMemo(
    () =>
      resolveSelectedSessionLive({
        selectedSessionKey,
        getSessionRuntime,
        isTurnBusy,
        isSessionRuntimeLive,
      }),
    [selectedSessionKey, executingListEpoch],
  )
  const selectedResumeAttach = useMemo(
    () =>
      resolveSelectedResumeAttach({
        selectedSessionKey,
        getSessionRuntime,
        deriveAttachState,
      }),
    [selectedSessionKey, executingListEpoch],
  )
  const selectedResumeStreamHold = useMemo(
    () =>
      resolveSelectedResumeStreamHold({
        selectedSessionKey,
        getSessionRuntime,
        deriveAttachState,
      }),
    [selectedSessionKey, executingListEpoch],
  )
  const sidebarHistory = useMemo(
    () =>
      resolveSidebarHistory({
        selectedSessionKey,
        sidebarTaskViews,
      }),
    [sidebarTaskViews, selectedSessionKey],
  )

  const renderRows = useMemo(
    () => rows,
    [rows],
  )
  /**
   * 空会话「工作台」仪表盘：会隐藏底部输入条（首页自带输入）。
   * - 非 V4：空草稿即首页（旧行为）
   * - V4：仅 preferHomeDashboard（侧栏「工作台」）才进首页；会话列表「新对话」保持空白聊天+composer
   * prefer 时忽略 historyLoading：新建空会话确认历史的窗口若等 loading 结束，会先闪 V4 白屏+composer。
   */
  const emptyHomeEligible = preferHomeDashboard
    ? !historyError &&
      !sessionHadContent &&
      renderRows.length === 0 &&
      !selectedTurnBusy
    : resolveIsHomeSurface({
        historyLoading,
        historyError,
        sessionHadContent,
        renderRows,
        selectedTurnBusy,
      })
  const isHomeSurface =
    emptyHomeEligible && (!isEvoflowChatV4Enabled() || preferHomeDashboard)
  isHomeSurfaceRef.current = isHomeSurface

  useEffect(() => {
    document.querySelectorAll('[data-shell-home="1"]').forEach((el) => {
      el.classList.toggle('active', isHomeSurface)
    })
  }, [isHomeSurface])
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
      return resolveLiveStreamActivityForSessionImpl(
        {
          sessionsRef,
          isSessionExecuting,
          getSessionRuntime,
          selectedSessionKey,
          threadPanelStateRef,
          threadPanelBySessionRef,
          emptyThreadPanel,
          streamRef,
          computeTurnElapsedSec,
          resolveComposerDockActivity,
        },
        sessionKey,
        isSelectedRow,
      )
    },
    [selectedSessionKey],
  )

  useEffect(() => {
    runForceEndTurnWhenSealedEffect({
      selectedTurnBusy,
      selectedSessionKey,
      getSessionRuntime,
      streamRefHasVisibleContent,
      streamRef,
      renderRows,
      maybeEndTurnSendingState,
    })
  }, [selectedTurnBusy, renderRows, selectedSessionKey, maybeEndTurnSendingState])

  /** stream 空闲后冲刷延迟写入的自动标题（绑定 sessionKey，避免串到新会话）。 */
  useEffect(() => {
    runFlushPendingAutoTitleEffect({
      pendingAutoSessionTitleRef,
      getSessionRuntime,
      isTurnBusy,
      streamRefHasVisibleContent,
      sessionRef,
      streamRef,
      selectedTurnBusy,
      persistSessionTitleIfMissing,
    })
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
    return runBrowserPanelRequestEffect({
      NODE_REPL_BRIDGE_THREAD_ID,
      dbgLog,
      setBrowserPanelThreadId,
      applyBrowserCommandResponse,
      ensureBrowserStage,
      getBridgeOwnerSessionKey,
      rightStageSessionKeyRef,
    })
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
    runInfoRailOnSessionChangeEffect({
      prevSelectedSessionKeyForInfoRailRef,
      selectedSessionKey,
      userClosedInfoRailRef,
      setInfoRailTab,
      setInfoRailOpen,
      isProactiveEmployeeSession,
    })
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

  const goalExecutionTiming = resolveGoalExecutionTiming({
    historyLoading,
    selectedGoalActive,
    selectedSessionKey,
  })

  const collabExecutionTiming = resolveCollabExecutionTiming({
    threadPanelState,
    liveTurnTimingActive,
    selectedTurnBusy,
    selectedSessionKey,
    executingSessionKeys,
  })

  const executionToolTiming = goalExecutionTiming || collabExecutionTiming

  const sessionRowTaskId = useMemo(
    () =>
      resolveSessionRowTaskIdImpl({
        selectedSessionKey,
        sessions,
        resolveSessionTaskId,
        boundTaskId,
      }),
    [selectedSessionKey, sessions, boundTaskId],
  )
  sessionBoundTaskIdRef.current = sessionRowTaskId

  const sidebarActiveTaskId =
    sidebarSelectedTaskId ||
    sidebarHistory[0]?.taskId ||
    sessionRowTaskId ||
    threadPanelState.collabTask?.taskId ||
    null
  const sidebarActiveView = sidebarActiveTaskId ? sidebarTaskViews[sidebarActiveTaskId] : undefined

  const chatThreadIdForSidebar = useMemo(
    () =>
      resolveChatThreadIdForSidebarImpl({
        selectedSessionKey,
        wsClient,
        sessions,
        resolveLanggraphLeadThreadId,
      }),
    [selectedSessionKey, sessions],
  )

  /** 主任务 id：会话行、内存绑定、侧栏快照、子任务 parent 等多源合并（避免仅有 subtasks 时面板为空） */
  const workflowTaskId = useMemo(
    () =>
      resolveWorkflowTaskIdImpl({
        threadPanelState,
        sessionRowTaskId,
        boundTaskId,
      }),
    [
      sessionRowTaskId,
      boundTaskId,
      threadPanelState.collabTask?.taskId,
      threadPanelState.boundTaskId,
      threadPanelState.collabSubtasks,
    ],
  )

  const collabWorkflowApiReady = useMemo(
    () =>
      resolveCollabWorkflowApiReadyImpl({
        sessionRowTaskId,
        selectedSessionKey,
        chatThreadIdForSidebar,
      }),
    [sessionRowTaskId, selectedSessionKey, chatThreadIdForSidebar],
  )

  /** GET /tasks 查询主键：会话绑定 taskId 优先，其次内存 hint */
  const collabSubtasksTaskId = String(sessionRowTaskId || workflowTaskId || '').trim()

  const collabExecPanelCanShow = useMemo(
    () =>
      resolveCollabExecPanelCanShowImpl({
        collabWorkflowApiReady,
        threadPanelState,
        collabSubtasksTaskId,
        isActiveExecTaskStatus,
        shouldShowCollabWorkflowPanel,
        shouldShowCollabSubtaskSidebar,
      }),
    [
      collabWorkflowApiReady,
      threadPanelState.collabTask,
      threadPanelState.collabPhase,
      collabSubtasksTaskId,
    ],
  )

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
    return runBackgroundWorksPollEffect({
      backgroundWorksPollSigRef,
      commitStreamSnapshot,
      listBackgroundBashWorks,
      liveProcessPanelEnabled,
      selectedSessionKey,
      selectedThreadId,
      streamRef,
      streamSeqRef,
      watchBackgroundBashRef,
    })
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
    return runCollabSubtasksPollEffect({
      bumpSubtasksApiRefresh,
      collabSubtasksFetchEnabled,
      isActiveExecTaskStatus,
      selectedTurnBusy,
      sharedCollabMainTaskStatus,
      threadPanelState,
    })
  }, [
    collabSubtasksFetchEnabled,
    sharedCollabMainTaskStatus,
    threadPanelState.collabPhase,
    selectedTurnBusy,
    bumpSubtasksApiRefresh,
  ])

  const renderChatSummaryPanel = (mode: 'panel' | 'capsule'): ReactNode =>
    renderChatSummaryPanelImpl(
      {
        artifactFocusId,
        assetQuickBusy,
        capabilityPatchBusy,
        currentAgentCapabilities,
        currentRoleAgent,
        currentRoleCodeForUi,
        currentRoleLabel,
        displayContextUsage,
        effectiveModelName,
        employeeRoleDetail,
        employeeSessionAgentCode,
        getDisplayLabel,
        handleAssetQuickAction,
        handleManualContextCompact,
        handleOpenProcessItem,
        handleStopProcessItem,
        headerTokenTotals,
        isProactiveEmployeeSession,
        liveProcessSnapshot,
        manualContextCompacting,
        modelPillLabel,
        obsEnabled,
        openCurrentAgentEditor,
        openSessionArtifact,
        patchCurrentAgentCapabilities,
        platformFocusEntryId,
        revealSessionArtifact,
        selectedSessionKey,
        selectedThreadId,
        selectedTurnBusy,
        sessionArtifacts,
        sessionPlatformEntries,
        sessions,
        setBottomRoleOpen,
        setChatPanelDisplayMode,
        sharedCollabSubtasks,
        sidebarActiveView,
        turnArtifacts,
        turnPlatformEntries,
      },
      mode,
    )

  const renderRightStageBody = useCallback(
    (surface: RightStageSurface): ReactNode => {
      return renderRightStageBodyImpl(
        {
          agents,
          chatThreadIdForSidebar,
          closeCollabExecPanel,
          closeKnowledgeMapPanel,
          closeWorkspacePanel,
          collabExecPanelOpen,
          collabSubtasksTaskId,
          collabWorkflowApiReady,
          contextFiles,
          effectiveWorkspaceRoot,
          knowledgeMapEnabled,
          knowledgeMapPanelOpen,
          knowledgeMapRefreshKey,
          liveProcessSnapshot,
          openWorkspaceFilePreview,
          selectedSessionKey,
          setSubtaskTranscriptModal,
          setWorkspaceBrowseFocusPath,
          setWorkspaceIndexWatchEnabledState,
          sharedCollabMainTask,
          sharedCollabSubtasks,
          sidePanelHeavyMount,
          sidebarActiveTaskId,
          sidebarActiveView,
          streamingWritePreviewForPane,
          threadPanelState,
          toggleContextFile,
          workspaceBrowseFocusPath,
          workspaceIndexWatchEnabled,
          workspaceOpenScopeRef,
          workspaceTreePinned,
          wsClient,
        },
        surface,
      )
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
  const browserToggleButton = renderBrowserToggleButton({
    browserStageActive,
    browserStageOpen,
    toggleBrowserStage,
  })

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

  const infoRailHeaderToggle = renderInfoRailHeaderToggle({
    rightStageOpen,
    toggleInfoRail,
  })

  const rightStageLauncherItems = useMemo(
    () =>
      buildChatRightStageLauncherItems({
        buildDefaultRightStageLauncherItems,
        wsClient,
        selectedSessionKey,
        setBrowserPanelThreadId,
        ensureBrowserStage,
        rightStageUserPinnedRef,
        setWorkspacePanelOpen,
        setWorkspaceTreePinned,
        syncShellAsideForWorkspacePanel,
        openCollabExecPanel,
        setChatPanelDisplayMode,
        knowledgeMapEnabled,
        openKnowledgeMapPanel,
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

  const workspaceFolderToggleButton = renderWorkspaceFolderToggleButton({
    workspaceStageActive,
    workspacePanelOpen,
    workspaceFolderToggleTitle,
    toggleWorkspacePanel,
  })

  /** ZCode 式成组按钮：主按钮「在资源管理器中打开」+ chevron 次级入口。 */
  const workspaceFolderGroup = renderWorkspaceFolderGroup({
    workspaceFolderMenuOpen,
    workspaceFolderToggleTitle,
    openCurrentWorkspaceInFileManager,
    setWorkspaceFolderMenuOpen,
    toggleWorkspacePanel,
  })

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

  const planExecConfirmAnchor = useMemo(
    (): PlanExecConfirmAnchor | null =>
      buildPlanExecConfirmAnchor({
        planDockApiView,
        planExecToolArrays,
        planExecStarting,
        selectedSessionKey,
        runUserExecutionStart,
        suppressPlanExecDock,
        userAuthorizedTaskIdsRef,
        applyPlanDockApiView,
      }),
    [planDockApiView, planExecToolArrays, planExecStarting, selectedSessionKey, sessions],
  )

  // 切换/刷新会话：唯一入口 — GET /tasks?session_key=… 决定是否展示计划条
  useEffect(() => {
    return runSessionEnterPlanSyncEffect({
      boundTaskIdRef,
      collectAssistantToolArraysFromRows,
      extractLastPlanToolSuccessFromArrays,
      historyCollabHydratedRef,
      historyLoading,
      historyRowsBootstrappedRef,
      isActiveSessionFetch,
      listLoading,
      patchCollabFromStreamTools,
      planSessionEnterRef,
      resolveSessionTaskId,
      rows,
      selectedSessionKey,
      sessionBoundTaskIdRef,
      sessionRefreshInFlightRef,
      sessionTasksFetchSeqRef,
      sessionsRef,
      syncPlanPanelFromApiRef,
    })
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
      await finalizeNewSessionBackgroundImpl(
        {
          memoryEnabled,
          modelName,
          modelCatalog,
          followResolvedModelName,
          agentDefaultModelName,
          primaryModelName,
          syncModelSessionPrevKeyRef,
          applySessionModePreset,
          setLocalWorkspaceRoot,
          setWorkspaceHistory,
          setGlobalWorkspaceHistory,
          setModelName,
          getSessionContext: (k) =>
            wsClient.getSessionContext(k) as { local_workspace_root?: string } | null | undefined,
          bindSessionWorkspace: (k, ws, o) => wsClient.bindSessionWorkspace(k, ws, o),
          getGlobalWorkspaceHistory: () => wsClient.getGlobalWorkspaceHistory(),
          refreshSessions,
        },
        key,
      )
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
    return createSessionForChatImpl(
      {
        memoryEnabled,
        sessionRef,
        pendingNewSessionRef,
        setSessions,
        setSessionMode,
        setSelectedSessionKey,
        setRows,
        setTokenTotals,
        setLiveTurnTokens,
        setNewChatButtonActive,
        setWorkspaceHistory,
        setGlobalWorkspaceHistory,
        markSessionKnownEmpty,
        bindSessionWorkspace: (key, ws, o) => wsClient.bindSessionWorkspace(key, ws, o),
        getGlobalWorkspaceHistory: () => wsClient.getGlobalWorkspaceHistory(),
        finalizeNewSessionBackground,
      },
      opts,
    )
  }

  async function ensureChatSessionKey(): Promise<string | null> {
    return ensureChatSessionKeyImpl({
      sessionRef,
      selectedSessionKey,
      setNewChatButtonActive,
      resolveWorkspaceForNewSession,
      coalesceCreateSession,
      createSessionForChat,
    })
  }
  ensureChatSessionKeyRef.current = ensureChatSessionKey

  async function applyMoreMenuSessionApprovalPolicy(
    presetId: string,
    opts?: { quiet?: boolean },
  ): Promise<void> {
    await applyMoreMenuSessionApprovalPolicyImpl(
      {
        sessionRef,
        selectedSessionKey,
        ensureChatSessionKey,
        setSessions,
        setToolApprovalPolicyTick,
        permissionPresetToast: (id) =>
          permissionPresetToast(id as Parameters<typeof permissionPresetToast>[0]),
      },
      presetId,
      opts,
    )
  }

  // 当前 session 的有效权限档位（sessions 行 context + wsClient 会话映射）。
  // PATCH 成功后 wsClient 映射即时同步，而 sessions 行可能被 in-flight 的旧列表
  // 响应覆盖回旧值（stale ctx）——wsClient 值优先，避免档位显示回跳。
  const currentPermissionPresetId = useMemo(() => {
    void toolApprovalPolicyTick
    return resolveCurrentPermissionPresetId({
      selectedSessionKey,
      sessions,
      getSessionContext: (sk) =>
        wsClient.getSessionContext(sk) as Record<string, unknown> | null | undefined,
    })
  }, [selectedSessionKey, sessions, toolApprovalPolicyTick])

  const currentPermissionPillLabel = useMemo(() => {
    const preset = PERMISSION_PRESETS.find((p) => p.id === currentPermissionPresetId)
    return preset?.pillLabel ?? preset?.label ?? '帮我批准'
  }, [currentPermissionPresetId])

  // 点击权限 pill：切换上拉菜单（与其他底部菜单互斥）
  function togglePermissionMenu(): void {
    togglePermissionMenuImpl({
      selectedSessionKey,
      setBottomPermissionOpen,
      setModeMenuOpen,
      setBottomModelOpen,
      setBottomMoreOpen,
      setBottomWorkspaceOpen,
      setBottomRoleOpen,
      setToolApprovalPolicyTick,
      fetchGlobalToolApprovalPolicy,
      fetchSessionToolApprovalPolicy,
      applySessionToolApprovalPolicy: (sk, result) =>
        wsClient.applySessionToolApprovalPolicy(sk, result),
    })
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
    await applyFullAccessToCurrentSessionImpl(
      {
        streamRef,
        rowsRef,
        sessionRef,
        toolApprovalResolvedIdsRef,
        suppressToolApprovalToastRef,
        applyMoreMenuSessionApprovalPolicy,
        permissionPresetFullAccess: PERMISSION_PRESET_FULL_ACCESS,
        collectPendingApprovalsForDock,
        turnBusyForSession,
        handleToolApproval,
      },
      opts,
    )
  }
  applyFullAccessToCurrentSessionRef.current = applyFullAccessToCurrentSession

  async function toggleNewChatGrantAllDefault(next: boolean): Promise<void> {
    await toggleNewChatGrantAllDefaultImpl(
      {
        setToolApprovalPolicyTick,
        patchGlobalToolApprovalPolicy,
        toolApprovalPolicyGrantAll: TOOL_APPROVAL_POLICY_GRANT_ALL,
        toolApprovalPolicySession: TOOL_APPROVAL_POLICY_SESSION,
        applyFullAccessToCurrentSession,
        fetchGlobalToolApprovalPolicy,
      },
      next,
    )
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
      skipTranscriptAppend?: boolean
      alreadyInjected?: boolean
      skillsOverride?: SkillSelection[]
      pluginsOverride?: PluginSelection[]
      leaveHomeOnPaint?: boolean
      beforeWire?: () => Promise<unknown>
    },
  ) {
    await handleSendImpl(
      {
      activeChatRunIdRef,
      authorizeExecutionInBackground,
      bindActiveRun,
      boundTaskId,
      bumpClarifyResolveSeq,
      chatSendSeqRef,
      clearClarificationLatch,
      clearSessionExecutionStateForEnded,
      clearStreamReattachCooldown,
      collabOn,
      contextFiles,
      dismissedRightStageKindsRef,
      dispatchSessionRunEnded,
      dispatchSessionTurnEvent,
      effectiveModelSupportsVision,
      emptyAgUiTurnState,
      emptyStream,
      ensureChatSessionKey,
      extractLatestGoalProposalFromRows,
      findAssistantRowBeforeTrailingUser,
      followResolvedModelName,
      getExpectedChatRunId,
      getGlobalCreateSessionInflight,
      getSessionRuntime,
      goal,
      goalProposalSuppressKey,
      historyBoundSessionKey,
      historyLoading,
      isProactiveSessionKey,
      isReplaceableSessionTitle,
      isSessionExecuting,
      isUserExecutionStartIntent,
      lastActivityRef,
      lastPlanDetectionToolsRef,
      lastPlanPanelHitRef,
      lastStreamWritePathRef,
      memoryEnabled,
      mergePriorTurnStripBundles,
      modelCatalog,
      modelName,
      parentTaskToSubtaskRef,
      parseProactiveSessionKey,
      patchSessionListRunEnded,
      pendingNewSessionRef,
      persistContextFiles,
      persistProvisionalSessionTitleFromMessage,
      persistSelectedPlugins,
      persistSelectedSkills,
      planResolveInFlightRef,
      planStreamLatchRef,
      planStreamLatched,
      platformFeedbackSeenRef,
      priorStripForRuntime,
      priorTurnStripBundleWithStream,
      provisionalSessionTitleFromUserText,
      resetPlanStreamSession,
      resetStreamMirrorDedupe,
      resetStreamStopLogDedupe,
      rightStageHintTimerRef,
      rightStageRunIdRef,
      rows,
      rowsBaseForSend,
      sessions,
      rtAddStaleToolCallIds,
      rtAddStoppedRun,
      scheduleBump,
      seedSeenArtifactPathsFromRows,
      seenArtifactsRef,
      seenRunIdsRef,
      selectedPlugins,
      selectedSessionKey,
      selectedSkills,
      sessionRef,
      sessionsRef,
      setArtifactFocusId,
      setContextFiles,
      setExpectedChatRunId,
      setLiveTurnAssistantRunId,
      setLiveTurnTokens,
      setPlatformFocusEntryId,
      setPluginComposerPillsVisible,
      setPreferHomeDashboard,
      setRoleUiNonce,
      setRows,
      setSessionHadContent,
      setSessions,
      setSidebarSelectedTaskId,
      setSidebarTaskViews,
      setStreamHealth,
      setStreamingWritePreview,
      setSubagentDockTasks,
      setThreadPanelState,
      setTurnArtifacts,
      setTurnPlatformEntries,
      setVoiceTrayState,
      shouldArmVoiceReply,
      skTail,
      ssLog,
      streamHealthRef,
      streamRef,
      streamRefKeyRef,
      suppressNextAbortToastRef,
      suppressedGoalProposalKeysRef,
      threadPanelState,
      toUserFacingError,
      toast,
      turnPlatformEntriesRef,
      turnRunArtifactsRef,
      userInitiatedStopRef,
      voiceReplyEnabled,
      voiceReplyPendingRef,
      voiceSessionKeyRef,
      voiceSpeechSyncedPlainRef,
      voiceStreamingStartedRef,
      writeStreamDismissedRef,
      wsClient,
      },
      message,
      attachments,
      ctxFiles,
      opts,
    )
  }
  sendGoalMessageRef.current = async (prompt, sk) => {
    await handleSend(prompt, undefined, undefined, {
      goalInitiated: true,
      goalSessionKey: sk,
    })
  }

  async function handleVoiceTranscribed(text: string, opts?: { global?: boolean }) {
    await handleVoiceTranscribedImpl(
      {
        voiceReplyEnabled,
        pushComposerText,
        setVoiceTrayState,
        handleSend,
      },
      text,
      opts,
    )
  }
  handleVoiceTranscribedRef.current = handleVoiceTranscribed

  async function handleToolApproval(
    action: 'approve' | 'approve_all' | 'deny' | 'grant_all' | 'approve_remember',
    toolCallId?: string,
    hint?: { tool_name?: string; summary?: string; args?: Record<string, unknown> },
  ) {
    await handleToolApprovalImpl(
      {
        selectedSessionKey,
        sessionRef,
        streamRef,
        rowsRef,
        toolApprovalResolvedIdsRef,
        suppressToolApprovalToastRef,
        requestManualStreamResumeRef,
        setToolApprovalInFlight,
        permissionPresetFullAccess: PERMISSION_PRESET_FULL_ACCESS,
        applyMoreMenuSessionApprovalPolicy,
        turnBusyForSession,
        scheduleBump,
        setExpectedChatRunId,
      },
      action,
      toolCallId,
      hint,
    )
  }

  /** 停止会话执行：侧栏 / Composer 共用 session-execution.stopSessionExecution */
  sessionStopHostRef.current = buildSessionStopHost({
    selectedSessionKey,
    sessionRef,
    streamRef,
    streamHealthRef,
    toolApprovalResolvedIdsRef,
    userInitiatedStopRef,
    interruptSendSteersRef,
    pendingSendQueueRef,
    midTurnInjectRef,
    activeChatRunIdRef,
    composerTextRef,
    refreshSessionsRef,
    setStreamHealth,
    setSubagentDockTasks,
    setThreadPanelState,
    setExpectedChatRunId,
    setRows,
    setPendingSteers,
    setPendingSendQueue,
    setSessions,
    pushComposerText,
    reloadHistoryFromDb,
    scheduleBump,
    deleteLiveRunSnapshotBestEffort,
  })

  async function stopSessionExecution(sessionKey: string, opts?: { showToast?: boolean }) {
    voiceReplyPendingRef.current = false
    voiceSessionKeyRef.current = ''
    voiceStreamingStartedRef.current = false
    void setVoiceTrayState('idle')
    await runStopSessionExecution(sessionKey, sessionStopHostRef.current, opts)
  }

  stopSessionExecutionRef.current = stopSessionExecution

  async function handleAbort() {
    await handleAbortImpl({
      selectedSessionKey,
      stopSessionExecution,
    })
  }

  function resetChatSurfaceForNewDraft() {
    resetChatSurfaceForNewDraftImpl({
      streamRef,
      streamRefKeyRef,
      rowsRef,
      processedTaskIdRef,
      setLiveTurnAssistantRunId,
      setRows,
      setTokenTotals,
      setLiveTurnTokens,
      setSubagentDockTasks,
      setThreadPanelState,
      setSessionMode,
      resetCollabPlanUiForSession,
      scheduleBump,
    })
  }

  function startNewSessionWithWorkspace(workspacePath: string | null) {
    startNewSessionWithWorkspaceImpl(
      {
        selectedSessionKey,
        sessionRef,
        rowsRef,
        streamRef,
        seenRunIdsRef,
        activeChatRunIdRef,
        composerTextRef,
        pendingComposerDraftCarryRef,
        pendingNewSessionRef,
        pendingNewSessionWorkspaceRef,
        setSelectedSessionKey,
        setNewChatButtonActive,
        setSessionHadContent,
        setLocalWorkspaceRoot,
        resetChatSurfaceForNewDraft,
        coalesceCreateSession,
        createSessionForChat,
      },
      workspacePath,
    )
  }

  startNewSessionWithWorkspaceRef.current = startNewSessionWithWorkspace

  function resolveWorkspaceForNewSession(): string | null {
    return resolveWorkspaceForNewSessionImpl({
      shellIntentWorkspaceRef,
      localWorkspaceRootRef,
    })
  }

  function handleNewSession() {
    setPreferHomeDashboard(false)
    handleNewSessionImpl({
      startNewSessionWithWorkspace,
      resolveWorkspaceForNewSession,
    })
  }

  /** 侧栏「工作台」：已在仪表盘则滚顶；否则新开空会话并挂 EvoFlowHomeDashboard */
  function handleOpenHome() {
    // 必须在清行之前判断「是否已在工作台」——清行后再 shouldStay 会把带消息的会话误判成空首页并 return。
    const alreadyOnHome =
      preferHomeDashboard &&
      !sessionHadContent &&
      Array.isArray(rowsRef.current) &&
      rowsRef.current.length === 0 &&
      !selectedTurnBusy
    // 同帧拉起 home：清掉当前行，避免 prefer=true 时仍带着旧 messages → isHomeSurface 算不成。
    flushSync(() => {
      setPreferHomeDashboard(true)
      setSessionHadContent(false)
      setRows([])
      rowsRef.current = []
    })
    if (alreadyOnHome) {
      scrollHomeMessagesToTop()
      return
    }
    startNewSessionWithWorkspace(resolveWorkspaceForNewSession())
  }

  function handleNewSessionInWorkspace(workspacePath: string | null) {
    setPreferHomeDashboard(false)
    handleNewSessionInWorkspaceImpl(
      {
        shellIntentWorkspaceRef,
        startNewSessionWithWorkspace,
      },
      workspacePath,
    )
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
    await startNewChatWithPresetAgentImpl(
      {
        selectedSessionKey,
        agents,
        setRoleSwitchBusy,
        setBottomRoleOpen,
        setRoleUiNonce,
        setSessions,
        ensureChatSessionKey,
      },
      agentCodeRaw,
    )
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
    pruneDeletedSessionCaches({
      sessions,
      selectedSessionKey,
      sessionRef,
      pruneSessionRuntimes,
      pruneStreamSnapshots,
      seenArtifactsRef,
    })
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
    return installShellSessionHeal({
      sessionRef,
      refreshSessions: () => refreshSessionsRef.current?.(),
      runShellSessionRefresh: (sk) => runShellSessionRefreshRef.current?.(sk),
      onShellRefreshSessionList,
      turnBusyForSession,
    })
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
          setPreferHomeDashboard,
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
      // AG-UI history：点击瞬间 runtime.rows 已热（旧面板/对比用）。
      warmSessionHistoryPrefetch(sk)
      // V4 帧：悬停即 acquire→keep-warm，点击时 Timeline 尽量已有快照，避免字墙闪一下。
      if (!isEvoflowChatV4Enabled()) return
      const threadId = String(
        sessionsRef.current.find((s) => String(s.sessionKey || '').trim() === sk)?.threadId ||
          wsClient?.getSessionThreadId?.(sk) ||
          '',
      ).trim()
      if (threadId) warmEvoflowV4Session(threadId)
    },
    [selectedSessionKey],
  )

  useEffect(() => {
    return runShellWindowListenersEffect({
      cancelPendingStreamUiBumpsRef,
      handleNewSessionRef,
      handleOpenHomeRef,
      isChatOverlayDeferActive,
      reviveAllTurnBusyIfLivePostOpen,
      scheduleBumpRef,
      selectSessionFromShellRef,
      setChatSurfaceVisible,
      setMobileChatPane,
    })
  }, [])

  return {
    activateRightStageTab,
    agents,
    anyRightPanelOpen,
    applyThinkingLevel,
    assistantReplyLabel,
    attachContextFiles,
    bottomAreaLayoutStyle,
    bottomAreaRef,
    bottomDockHeightPx,
    bottomDockResizeDragging,
    bottomModelOpen,
    bottomModelRootRef,
    bottomMoreOpen,
    bottomMorePortalStyle,
    bottomMoreTriggerRef,
    bottomPermissionOpen,
    bottomPluginPanelOpen,
    bottomRoleOpen,
    bottomSkillOpen,
    bottomWorkspaceOpen,
    browserToggleButton,
    chatPanelMode,
    chatThreadIdForSidebar,
    collabOn,
    collabVerifyingBadge,
    composerDraftSnapshotRef,
    composerDraftVersion,
    contextFiles,
    contextImagePreviewIndex,
    conversationColRef,
    createPortal,
    currentPermissionPillLabel,
    currentPermissionPresetId,
    currentRoleAgent,
    currentRoleCodeForUi,
    currentRoleLabel,
    DEFAULT_SESSION_MODES,
    displayContextUsage,
    dynamicModes,
    effectiveModelName,
    effectiveModelSupportsThinking,
    effectiveModelSupportsVision,
    effectiveWorkspaceRoot,
    engineReady,
    ensureChatSessionKey,
    ensureChatSessionKeyRef,
    ensureWorkspaceExpanded,
    executionToolTiming,
    filteredSessions,
    filterRightStageTabsForSession,
    getApi,
    getDisplayLabel,
    globalWorkspaceHistory,
    goal,
    goalExecutionTiming,
    goalProposalSuppressKey,
    handleAbort,
    handleBottomDockResizePointerDown,
    handleCancelPendingSend,
    handleCancelPendingSteer,
    handleCloseAllRightStageTabs,
    handleCloseOtherRightStageTabs,
    handleCloseRightStageTab,
    handleCollapseRightStage,
    handleComposerDraftChange,
    handleComposerWarmup,
    handleConversationComposeDragOver,
    handleConversationComposeDrop,
    handleCopyMessage,
    handleDeleteWorkspaceGroup,
    handleDispatchEmployee,
    handleEditMessage,
    handleEditPendingSend,
    handleEnhancePrompt,
    handleFlushPendingSend,
    handleForkFromMessage,
    handleHistoryViewReady,
    handleInterruptAndSendSteers,
    handleManualContextCompact,
    handleOpenWorkspaceFolder,
    handleQueueWhileBusy,
    handleQuickPrompt,
    handleRetryMessage,
    handleSend,
    handleStartGoal,
    handleSteerWhileBusy,
    handleStopGoal,
    handleSubmitClarification,
    handleVoiceTranscribed,
    headerTokenTotals,
    historyError,
    historyHasMore,
    historyInstantPaint,
    historyLoading,
    historyLoadingOlder,
    homeWorkspaceLabel,
    infoRailHeaderToggle,
    isDesktopTauriRuntime,
    isHomeSurface,
    isImagePathLike,
    isMobileChat,
    isProactiveEmployeeSession,
    knowledgeMapEnabled,
    lastAssistantRowIndex,
    layoutResizeEnabled,
    listLoading,
    liveTurnAssistantRunId,
    liveTurnTimingActive,
    liveTurnTokenStr,
    loadMoreGlobalRecentSessions,
    loadMoreWorkspaceSessions,
    loadOlderHistory,
    loadProactiveRoles,
    mainBodyLayoutStyle,
    mainBodyRef,
    mainBodyStageClasses,
    manualContextCompacting,
    memoryEnabled,
    memoryRecallRefreshKey,
    mobileChatPane,
    modeLabel,
    modelCatalog,
    modelConnNameMap,
    modelPillLabel,
    modelsLoading,
    modeMenuOpen,
    moreMenuKey,
    moreSubOpen,
    newChatButtonActive,
    newChatGrantAllDefault,
    onRightPanelResizePointerDown,
    onShellDeleteSession,
    onShellForkSession,
    onShellNewSessionInWorkspace,
    onShellNewWorkspace,
    onShellPinSession,
    onShellRefreshSession,
    onShellRefreshSessionList,
    onShellStopSession,
    onShellWorkspaceFocus,
    onToolApprovalStable,
    openKnowledgeMapPanel,
    openMessageFilePreview,
    openSessionArtifact,
    patchPanelSettings,
    pendingSendQueue,
    pendingSteers,
    PERMISSION_PRESETS,
    persistSelectedPlugins,
    persistSelectedSkills,
    pickPermissionPreset,
    planDockApiView,
    planExecConfirmAnchor,
    pluginComposerPillsVisible,
    pluginList,
    pluginListLoading,
    pluginPanelStyle,
    prefetchSessionHistoryFromShell,
    proactiveRoles,
    proactiveRolesDisplay,
    QUICK_PROMPTS,
    removeSelectedPlugin,
    removeSelectedSkill,
    renderBottomControlsLoggedRef,
    renderChatSummaryPanel,
    renderRightStageBody,
    renderRows,
    reopenRightStageTab,
    reorderRightStageTab,
    resolveChatImageSrc,
    resolveLiveStreamActivityForSession,
    rightPanelResizeDragging,
    rightPanelWidthPx,
    rightStageActiveKey,
    rightStageLauncherItems,
    rightStageOpen,
    rightStageRecentClosed,
    roleSwitchBusy,
    rows,
    runningSessionMap,
    selectedPlugins,
    selectedResumeAttach,
    selectedResumeStreamHold,
    selectedSessionKey,
    selectedSessionLive,
    selectedSkills,
    selectedStreamPriorTurnStrip,
    selectedTurnBusy,
    selectSessionFromShell,
    sessionFilter,
    sessionMode,
    sessionNamesTick,
    sessionRef,
    sessions,
    sessionSidebarOpen,
    setBottomModelOpen,
    setBottomMoreOpen,
    setBottomPermissionOpen,
    setBottomPluginPanelOpen,
    setBottomRoleOpen,
    setBottomSkillOpen,
    setBottomWorkspaceOpen,
    setCollabPhaseForSession,
    setContextImagePreviewIndex,
    setMemoryEnabled,
    setMobileChatPane,
    setModelName,
    setModeMenuOpen,
    setMoreMenuKey,
    setMoreSubOpen,
    setPluginComposerPillsVisible,
    setRoleUiNonce,
    setRows,
    setSelectedPlugins,
    setSelectedSkills,
    setSessionFilter,
    setSessionModeAndApply,
    setSessions,
    setShareSessionOpen,
    setSubtaskTranscriptModal,
    setThreadPanelState,
    setVoiceReplyEnabled,
    sharedCollabSubtasks,
    shareSessionOpen,
    SHOW_SESSION_MODE_COLLAB_UI,
    showChatSummaryFloat,
    showHistoryFetchOverlay,
    showHistorySyncHint,
    sidebarActiveTaskId,
    sidebarActiveView,
    sidebarHistory,
    skillList,
    skillListLoading,
    speechEnabled,
    startNewChatWithPresetAgent,
    STORAGE_MODEL_KEY,
    streamHealth,
    streamingWritePreview,
    streamRef,
    subtaskTranscriptModal,
    suppressedGoalProposalKeysRef,
    TAURI_HEADER_CELL_DRAG_PROPS,
    THINKING_LEVEL_OPTIONS,
    thinkingLevel,
    threadPanelState,
    toast,
    toggleContextFile,
    toggleNewChatGrantAllDefault,
    togglePermissionMenu,
    toggleShellAsideCollapsed,
    tokenTotals,
    toolApprovalInFlight,
    toolApprovalUiDisabled,
    toUserFacingError,
    turnArtifacts,
    visibleRightStageTabs,
    voiceReplyEnabled,
    voiceReplyModeToSettingsPatch,
    voiceReplyPendingRef,
    voiceSpeechSyncedPlainRef,
    voiceStreamingStartedRef,
    v4ComposerHostEl,
    setV4ComposerHostEl,
    workspaceFolderGroup,
    workspaceFolderToggleButton,
    workspaceMention,
    workspacePagination,
    workspacePanelWritePreview,
    workspaceSummaries,
    wsClient,
  }
}
