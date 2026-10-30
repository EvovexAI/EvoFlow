// @ts-nocheck — mechanical P89 extract.
/**
 * ChatApp main JSX tree. Extracted from ChatApp.tsx (P89).
 */
import { useState, useEffect, type ReactNode, type MouseEvent as ReactMouseEvent } from 'react'
import type { DisplayRow } from '../../chat-types.js'
import { ModelCatalogMenu } from '../../components/ModelCatalogMenu.js'
import { ShellSessionListHost } from '../../components/ShellSessionListHost.js'
import { ChatMessageStreamPane } from '../../components/ChatMessageStreamPane.js'
import { V4StreamRowsBridge } from '../../v4/V4StreamRowsBridge.js'
import { V4ZCodeTimeline } from '../../v4/V4ZCodeTimeline.js'
import { XiaomiVoiceStage } from '../../right-stage/kinds/XiaomiVoiceStage.js'
import { isXwVoiceMode, subscribeXwVoiceMode } from '../../../lib/xw-voice-mode.js'
import { rightStageStore } from '../../../lib/right-stage/right-stage-store.js'
import {
  openRightStageForCodeViewerSource,
  showRightStageCodeViewers,
  showRightStageFromFileLink,
} from '../../../lib/right-stage/open-right-stage-file.js'
import { showRightStageBrowserUrl } from '../../../lib/right-stage/open-right-stage-browser.js'
import { isEvoflowChatV4Enabled } from '../../v4/v4Gate.js'
import { v4WindowHasUserText } from '../../v4/optimisticUserInput.js'
import { resolveChatPaneMode } from '../../lib/chat-pane-mode.js'
import { logV4Life } from '../../lib/v4-lifecycle-log.js'
import { SS_SHELL_EMPTY_DRAFT } from '../../components/ShellSessionList.js'
import { HistoryFetchSpinner } from '../../components/HistoryFetchSpinner.js'
import { ChatComposer, type WorkspaceMentionConfig, type MentionEmployeeOption } from '../../components/ChatComposer.js'
import { PendingSteersStrip } from '../../components/PendingSteersStrip.js'
import { GoalModePanel } from '../../components/GoalModePanel.js'
import { GoalProposalDock } from '../../components/GoalProposalDock.js'
import { SkillPickerModal, type SkillSelection } from '../../components/SkillPickerModal.js'
import { PluginQuickPanel } from '../../components/PluginQuickPanel.js'
import { PluginPillIcon } from '../../components/PluginPillIcon.js'
import { ShareSessionModal } from '../../components/ShareSessionModal.js'
import { PlanExecConfirm } from '../../components/PlanExecConfirmDock.js'
import { ClarificationConfirmDock } from '../../components/ClarificationConfirmDock.js'
import {
  RightStagePanel,
  buildDefaultRightStageLauncherItems,
} from '../../components/RightStagePanel.js'
import { PanelResizeHandle } from '../../components/PanelResizeHandle.js'
import { SessionSidebar, type SubtaskTranscriptModalPayload } from '../../components/SessionSidebar.js'
import { MemoryRecallChip } from '../../components/MemoryRecallChip.js'
import { ImagePreviewModal, type ImagePreviewItem } from '../../components/ImagePreviewModal.js'
import { TauriWindowControls } from '../../components/TauriWindowControls.js'
import { HoverBubble, HoverBubbleProvider } from '../../components/HoverBubble.js'

export type ChatAppViewCtx = Record<string, any>

export function renderChatAppView(ctx: ChatAppViewCtx): ReactNode {
  /* 语音全屏模式：html[data-xw-voice='1'] 时由 CSS 接管整窗（左语音域/右标签区） */
  const [xwVoiceOn, setXwVoiceOn] = useState(() => isXwVoiceMode())
  useEffect(() => subscribeXwVoiceMode(setXwVoiceOn), [])
  const {
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
    displayContextUsage,
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
    rightStageFilterSessionKey,
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
    rows,
    runningSessionMap,
    selectedPlugins,
    selectedResumeAttach,
    selectedResumeStreamHold,
    selectedSessionKey,
    selectedSessionLive,
    selectedThreadId,
    selectedSkills,
    selectedStreamPriorTurnStrip,
    selectedTurnBusy,
    selectSessionFromShell,
    sessionFilter,
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
  } = ctx

  // 无 threadId / 历史仍在拉：每 2s 落一条中文原因（有 tid 且 history 结束则停）
  useEffect(() => {
    if (isHomeSurface) return
    const sk = String(selectedSessionKey || '').trim()
    if (!sk) return
    const tid0 = String(selectedThreadId || '').trim()
    if (tid0 && !historyLoading) return
    const tick = () => {
      const tid = String(selectedThreadId || '').trim()
      const mapTid = String(wsClient?.getSessionThreadId?.(sk) || '').trim()
      const rowTid = String(
        (sessions || []).find((s) => String(s?.sessionKey || '') === sk)?.threadId || '',
      ).trim()
      if (!tid) {
        logV4Life({
          event: 'loading_why',
          sessionKey: sk,
          level: 'warn',
          zh: `界面「加载中」原因：当前会话没有可用 threadId（selected 空；sessions行=${rowTid || '空'}；map=${mapTid || '空'}）。V4 无法订阅首帧，会一直转圈。`,
          detail: { rowTid: rowTid || null, mapTid: mapTid || null, historyLoading: !!historyLoading },
          skipDedupe: true,
        })
        return
      }
      if (historyLoading) {
        logV4Life({
          event: 'loading_why',
          sessionKey: sk,
          threadId: tid,
          zh: `界面「加载中」原因：threadId 已有（${tid}），但 historyLoading 仍为 true（旧历史接口未结束）。`,
          detail: { rowTid: rowTid || null, mapTid: mapTid || null },
          skipDedupe: true,
        })
      }
    }
    tick()
    const id = window.setInterval(tick, 2_000)
    return () => window.clearInterval(id)
  }, [
    isHomeSurface,
    selectedSessionKey,
    selectedThreadId,
    historyLoading,
    sessions,
    wsClient,
  ])

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
            {xwVoiceOn ? <XiaomiVoiceStage /> : null}
            <div
              className={`react-chat-conversation-col${
                isEvoflowChatV4Enabled() ? ' is-v4-unified-scroll' : ''
              }`}
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
              {/* V4：对话恒用 ConversationTimeline。ChatMessageStreamPane 仅工作台首页壳。 */}
              <V4StreamRowsBridge
                enabled={isEvoflowChatV4Enabled() && !isHomeSurface}
                /* 用 controller 钉住的 selectedThreadId，避免 ensure remint 导致 sessionId 连跳拆租约 */
                sessionId={String(selectedThreadId || '').trim() || null}
              >
                {(v4Payload, v4Phase) => {
                  /* 发送瞬间：在 V4 时间线尾部注入乐观 userInput，绝不整树切老面板。
                     闲置切历史 turnLive=false，不会 hold，避免字墙。 */
                  const v4RowCount = v4Payload?.snapshot?.rows.totalCount ?? 0
                  const v4SessionMatched =
                    !!v4Payload &&
                    String(v4Payload.sessionId || '').trim() ===
                      String(selectedThreadId || '').trim()
                  const turnLive = selectedTurnBusy || selectedSessionLive
                  const lastLocal =
                    Array.isArray(rows) && rows.length > 0 ? rows[rows.length - 1] : null
                  const lastLocalUserText =
                    lastLocal && String(lastLocal.role || '') === 'user'
                      ? String(lastLocal.text || '').trim()
                      : ''
                  const awaitingV4UserEcho =
                    turnLive &&
                    !!lastLocalUserText &&
                    !v4WindowHasUserText(v4Payload?.snapshot?.rows?.window, lastLocalUserText)
                  const localOptimisticHold =
                    awaitingV4UserEcho &&
                    (v4Phase === 'ready'
                      ? v4SessionMatched
                      : v4Phase === 'connecting' ||
                        v4Phase === 'no-thread' ||
                        v4Phase === 'failed')
                  const localHasRows = Array.isArray(rows) && rows.length > 0
                  const v4HasRows = v4SessionMatched && v4RowCount > 0
                  const optimisticUserText = localOptimisticHold ? lastLocalUserText : null
                  let knownEmptyDraft = false
                  try {
                    knownEmptyDraft =
                      sessionStorage.getItem(SS_SHELL_EMPTY_DRAFT) ===
                      String(selectedSessionKey || '').trim()
                  } catch {
                    knownEmptyDraft = false
                  }
                  /* 面板选择：对话永不回落 ToolCallList；useLegacyPane 仅首页。 */
                  const { useLegacyPane, draftEmpty } = resolveChatPaneMode({
                    v4Phase,
                    localHasRows,
                    historyLoading,
                    v4HasRows,
                    isHomeSurface,
                    localOptimisticHold,
                    knownEmptyDraft,
                  })
                  return useLegacyPane ? (
              /* LEGACY：仅 isHomeSurface — 勿在此恢复主对话 ToolCallList */
              <ChatMessageStreamPane
                rows={renderRows}
                streamRef={streamRef}
                isSending={selectedTurnBusy}
                historyLoading={historyLoading}
                showHomeDashboard={isHomeSurface}
                homeWorkspaceLabel={homeWorkspaceLabel}
                homeWorkspacePath={effectiveWorkspaceRoot}
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
                  ) : (
                    <V4ZCodeTimeline
                      payload={v4Payload}
                      connecting={
                        // no-thread 不能当永久「加载中」——否则无 tid 时转圈到死；
                        // 交给 draftEmpty / 空态文案；connecting 只表示「已有 tid、等首帧」。
                        v4Phase === 'connecting' || v4Phase === 'failed'
                      }
                      connectionFailed={v4Phase === 'failed'}
                      draftEmpty={draftEmpty}
                      optimisticUserText={optimisticUserText}
                      evoflowSessionKey={selectedSessionKey}
                      onOpenFileLink={(target) => {
                        // 话术 Markdown 路径 pill → 右侧「文件」预览区（可关、半宽，不盖住对话）
                        showRightStageFromFileLink(target, {
                          sessionKey: selectedSessionKey,
                          threadId: wsClient?.getSessionThreadId?.(selectedSessionKey || '') || '',
                        })
                      }}
                      onOpenCodeViewer={(source) => {
                        // type:file → 文件区；patch/pptx/pdf 等 → PreviewPane
                        openRightStageForCodeViewerSource(source, {
                          sessionKey: selectedSessionKey,
                          threadId: wsClient?.getSessionThreadId?.(selectedSessionKey || '') || '',
                        })
                      }}
                      onOpenBrowserUrl={(url) => {
                        // 助手预览卡「网站」→ 右侧内置浏览器（localhost / HTML）
                        showRightStageBrowserUrl(url, {
                          sessionKey: selectedSessionKey,
                          threadId: wsClient?.getSessionThreadId?.(selectedSessionKey || '') || '',
                        })
                      }}
                      onToolApproval={onToolApprovalStable}
                      workspacePath={effectiveWorkspaceRoot}
                      subagentTasks={threadPanelState.subagentTasks}
                      onOpenSubagentTranscript={(taskId, title, fallbackText, fallbackStatus) => {
                        // 子代理流式输出 → 右侧面板（transcript 轮询 + liveOutput 兜底）
                        rightStageStore.show({
                          kind: 'subagentTranscript',
                          id: `subagentTranscript:${taskId}`,
                          title: title || '子代理输出',
                          layout: 'wide',
                          sessionKey: selectedSessionKey || undefined,
                          data: {
                            taskId,
                            title,
                            fallbackText,
                            fallbackStatus,
                            sessionKey: selectedSessionKey || undefined,
                          },
                        })
                      }}
                      onAutoOpenCodeViewers={(sources) => {
                        showRightStageCodeViewers(sources, {
                          sessionKey: selectedSessionKey,
                          threadId: wsClient?.getSessionThreadId?.(selectedSessionKey || '') || '',
                        })
                      }}
                      toolApprovalUiDisabled={toolApprovalUiDisabled}
                      bottomDock={
                        <div
                          ref={setV4ComposerHostEl}
                          data-v4-evoflow-composer-host="true"
                          className="w-full min-w-0"
                        />
                      }
                    />
                  )
                }}
              </V4StreamRowsBridge>
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
            onSubtaskTranscriptModalChange={(next) => {
              if (!next) {
                setSubtaskTranscriptModal(null)
                return
              }
              // 侧栏点节点：与工作流画布同口径 → V4 右侧独立进度 tab
              void import('../../../lib/right-stage/open-collab-subtask-stage.js').then((m) => {
                m.openCollabSubtaskInRightStage(next, { sessionKey: selectedSessionKey })
              })
            }}
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
          {(() => {
            const bottomDockNode = (
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
              speechEnabled={false}
              onVoiceTranscribed={undefined}
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
                // + 号切换插件/添加快捷面板：已开则收起（ZCode 交互复刻）
                const next = !bottomPluginPanelOpen
                // 打开时互斥收起其它底栏菜单，避免叠层
                if (next) {
                  setModeMenuOpen(false)
                  setBottomModelOpen(false)
                  setBottomPermissionOpen(false)
                  setBottomMoreOpen(false)
                  setMoreSubOpen(null)
                  setBottomWorkspaceOpen(false)
                  setBottomRoleOpen(false)
                  setBottomSkillOpen(false)
                }
                setBottomPluginPanelOpen(next)
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
                            try {
                              const { markVoiceReplyUserExplicit } = await import('../../../lib/voice-reply-mode.js')
                              markVoiceReplyUserExplicit()
                            } catch { /* ignore */ }
                            await patchPanelSettings(voiceReplyModeToSettingsPatch(next))
                            if (!next) { voiceReplyPendingRef.current = false; voiceStreamingStartedRef.current = false; voiceSpeechSyncedPlainRef.current = ''
                              void import('../../../lib/speech-client.js').then(({ stopAllAssistantSpeech, resetStreamingSpeechQueue }) => { stopAllAssistantSpeech(); resetStreamingSpeechQueue() })
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
                      onOpenLegacyMenu={() => setBottomMoreOpen(true)}
                      onInsertText={(text) => insertText(text)}
                      showVoice={speechEnabled}
                      voiceOn={voiceReplyEnabled}
                      onToggleVoice={async () => {
                        const next = !voiceReplyEnabled
                        setVoiceReplyEnabled(next)
                        try {
                          const { markVoiceReplyUserExplicit } = await import('../../../lib/voice-reply-mode.js')
                          markVoiceReplyUserExplicit()
                        } catch { /* ignore */ }
                        await patchPanelSettings(voiceReplyModeToSettingsPatch(next))
                        if (!next) {
                          voiceReplyPendingRef.current = false
                          voiceStreamingStartedRef.current = false
                          voiceSpeechSyncedPlainRef.current = ''
                          void import('../../../lib/speech-client.js').then(({ stopAllAssistantSpeech, resetStreamingSpeechQueue }) => {
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
            )
            // V4 对话：portal 进 timeline sticky bottomDock；工作台首页用自带输入，走兄弟 dock（CSS 隐藏）。
            // host 未挂好时不要回落兄弟 dock——否则空草稿会先贴底再被 portal+居中抬到中间，闪一下。
            if (isEvoflowChatV4Enabled() && !isHomeSurface) {
              return v4ComposerHostEl
                ? createPortal(bottomDockNode, v4ComposerHostEl)
                : null
            }
            return bottomDockNode
          })()}
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
                  filterRightStageTabsForSession(
                    [entry.tab],
                    rightStageFilterSessionKey || selectedSessionKey,
                  ).length > 0,
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
