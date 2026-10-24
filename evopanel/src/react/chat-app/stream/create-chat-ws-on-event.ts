// @ts-nocheck — mechanical P81 extract; host bag is untyped Record.
/**
 * Chat WS onEvent handler. Extracted from ChatApp.tsx (P81).
 */
import { EventType } from '@ag-ui/core'
import type { ChatWsPayload } from '../../chat-types.js'
import {
  isEvoflowChatV4Enabled,
  isV4DisplayAuthoritative,
  isV4GatedAgUiEvent,
} from '../../v4/v4Gate.js'

export type ChatWsOnEventCtx = Record<string, any>

export function createChatWsOnEventHandler(ctx: ChatWsOnEventCtx) {
  const {
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
  } = ctx
  return (msg: { event?: string; payload?: ChatWsPayload }) => {
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
        // 限流/压缩等系统状态必须盖过工具预览，否则面板只显示工具卡、用户看不到「重试中」。
        const stickySystemActivity =
          activityKindRaw === 'retrying' ||
          activityKindRaw === 'compacting' ||
          activityKindRaw === 'model_fallback' ||
          activityKindRaw === 'model_error' ||
          activityKindRaw === 'pre_model'
        if (
          !isBackgroundThreadState &&
          !skipHeaderReplay &&
          turnBusyForSession(activeSk)
        ) {
          const runningDetail = formatActivityDetailFromRunningToolCalls(
            streamRef.current.turn.tools as unknown[],
          )
          if (stickySystemActivity) {
            panelActivityKind = activityKindRaw
            panelActivityDetail =
              activityDetailRaw ||
              (activityKindRaw === 'retrying'
                ? '系统重试中…'
                : activityKindRaw === 'compacting'
                  ? '正在压缩上下文…'
                  : activityKindRaw === 'model_fallback'
                    ? '已自动切换模型'
                    : activityKindRaw === 'model_error'
                      ? '模型调用失败'
                      : activityDetailRaw || '准备中…')
          } else if (runningDetail) {
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
          turnBusyForSession(activeSk)
        ) {
          applyStreamTurnEvent(streamRef.current, {
            type: 'system_activity',
            detail:
              panelActivityKind === 'tools'
                ? panelActivityDetail
                : panelActivityKind === 'thinking'
                  ? panelActivityDetail || getActivityHint('thinking') || '思考中… 🤔'
                  : panelActivityKind === 'retrying' ||
                      panelActivityKind === 'compacting' ||
                      panelActivityKind === 'model_fallback' ||
                      panelActivityKind === 'model_error' ||
                      panelActivityKind === 'pre_model'
                    ? panelActivityDetail
                    : '',
            kind:
              panelActivityKind === 'retrying' ||
              panelActivityKind === 'compacting' ||
              panelActivityKind === 'model_fallback' ||
              panelActivityKind === 'model_error' ||
              panelActivityKind === 'pre_model' ||
              panelActivityKind === 'tools' ||
              panelActivityKind === 'thinking'
                ? panelActivityKind
                : undefined,
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
        // 限流重试/压缩等优先于工具预览，否则面板一直停在工具行，看不到「系统重试中」。
        const stickySystemActivity =
          activityKindRaw === 'retrying' ||
          activityKindRaw === 'compacting' ||
          activityKindRaw === 'model_fallback' ||
          activityKindRaw === 'model_error' ||
          activityKindRaw === 'pre_model' ||
          activityKindRaw === 'model'
        if (stickySystemActivity && activityKindRaw === 'model_error') {
          const detail = payloadDetail || '模型调用失败'
          applyStreamTurnEvent(S, { type: 'system_activity', detail, kind: 'model_error', ts: activityTs })
          if (!isBackground) {
            setThreadPanelState((prev) => ({
              ...prev,
              activityKind: 'model_error',
              activityDetail: detail,
            }))
          }
          // 额度/鉴权等终态失败：正文已到但 RUN_FINISHED 可能再拖十几秒。
          // 立刻结束 busy（保留 model_error 活动文案），否则一直「生成中」转圈。
          if (rt && isTurnBusy(rt) && targetSk) {
            logStreamStop({
              sessionKey: targetSk,
              runId: String(S.runId || runId || rt.activeChatRunId || '').trim() || null,
              trigger: 'activity_model_error',
              hasEndMarker: false,
              detail: { activityDetail: detail.slice(0, 120) },
            })
            if (rt.streamWireSource === 'run') {
              dispatchSessionTurnEvent(targetSk, { type: 'WIRE_SOURCE', source: null })
            }
            dispatchSessionTurnEvent(targetSk, { type: 'TURN_IDLE' })
          }
        } else if (stickySystemActivity && activityKindRaw === 'retrying') {
          const detail = payloadDetail || '系统重试中…'
          applyStreamTurnEvent(S, { type: 'system_activity', detail, kind: 'retrying', ts: activityTs })
          if (!isBackground) {
            setThreadPanelState((prev) => ({
              ...prev,
              activityKind: 'retrying',
              activityDetail: detail,
            }))
          }
        } else if (stickySystemActivity && activityKindRaw === 'compacting') {
          const detail = payloadDetail || '正在压缩上下文…'
          applyStreamTurnEvent(S, { type: 'system_activity', detail, kind: 'compacting', ts: activityTs })
          if (!isBackground) {
            setThreadPanelState((prev) => ({
              ...prev,
              activityKind: 'compacting',
              activityDetail: detail,
            }))
          }
        } else if (stickySystemActivity && activityKindRaw === 'model_fallback') {
          const detail = payloadDetail || '已自动切换模型'
          applyStreamTurnEvent(S, { type: 'system_activity', detail, kind: 'model_fallback', ts: activityTs })
          if (!isBackground) {
            setThreadPanelState((prev) => ({
              ...prev,
              activityKind: 'model_fallback',
              activityDetail: detail,
            }))
          }
        } else if (stickySystemActivity && activityKindRaw === 'pre_model') {
          const detail = payloadDetail || '准备中…'
          applyStreamTurnEvent(S, { type: 'system_activity', detail, kind: 'pre_model', ts: activityTs })
          if (!isBackground) {
            setThreadPanelState((prev) => ({
              ...prev,
              activityKind: 'pre_model',
              activityDetail: detail,
            }))
          }
        } else if (stickySystemActivity && activityKindRaw === 'model') {
          const detail = payloadDetail || '生成中…'
          applyStreamTurnEvent(S, { type: 'system_activity', detail, kind: 'model', ts: activityTs })
          if (!isBackground) {
            setThreadPanelState((prev) => ({
              ...prev,
              activityKind: 'model',
              activityDetail: detail,
            }))
          }
        } else if (toolPreview) {
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
        const runtimeActivityKind = stickySystemActivity
          ? activityKindRaw
          : toolPreview
            ? 'tools'
            : rowHasPendingApprovalTools(S.turn.tools as unknown[])
              ? 'tool_approval'
              : activityKindRaw === 'thinking' || payloadDetail === '推理中'
                ? 'thinking'
                : activityKindRaw || 'system'
        const runtimeActivityDetail = stickySystemActivity
          ? payloadDetail ||
            (activityKindRaw === 'pre_model'
              ? '准备中…'
              : activityKindRaw === 'model'
                ? '生成中…'
                : activityKindRaw === 'retrying'
                  ? '系统重试中…'
                  : activityKindRaw === 'compacting'
                    ? '正在压缩上下文…'
                    : activityKindRaw === 'model_fallback'
                      ? '已自动切换模型'
                      : activityKindRaw === 'model_error'
                        ? '模型调用失败'
                        : '')
          : toolPreview ||
            (rowHasPendingApprovalTools(S.turn.tools as unknown[]) ? '等待工具授权…' : '') ||
            payloadDetail ||
            (activityKindRaw === 'pre_model' ? '准备中…' : '') ||
            (activityKindRaw === 'model' ? '生成中…' : '') ||
            (activityKindRaw === 'retrying' ? '系统重试中…' : '') ||
            (activityKindRaw === 'model_fallback' ? '已自动切换模型' : '') ||
            (activityKindRaw === 'model_error' ? '模型调用失败' : '')
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

        // V4 双轨闸门：仅当 V4 时间线已真正接管（有快照）时，才丢掉 TEXT_* 热路径。
        // store=error / 永 connecting 时若仍闸门，模型报错正文进不了老面板，用户只看到加载中。
        // 业务事件（TOOL_CALL_*、RUN_*、平台）始终放行。
        const v4ThreadId =
          String(wsClient.getSessionThreadId?.(targetSk) || '').trim() ||
          String((aguiEvent as { threadId?: string }).threadId || '').trim()
        if (
          isEvoflowChatV4Enabled() &&
          isV4DisplayAuthoritative(v4ThreadId) &&
          isV4GatedAgUiEvent(aguiEvent)
        ) {
          return
        }

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
        // panel_set 前后台统一走同一条路径：applyStageSetPayload 按归属路由——
        // 前台写 live 右栏；后台只写该会话的冻结记忆（ZCode「后台挂载不抢焦点」），
        // 切过去才看见，绝不污染当前正在看的会话。
        if (aguiEvent.type === EventType.TOOL_CALL_RESULT) {
          const bgToolCallId = String(
            (aguiEvent as { toolCallId?: string }).toolCallId || '',
          ).trim()
          const bgToolCall = bgToolCallId ? S.aguiTurn?.toolCalls?.get(bgToolCallId) : undefined
          const bgToolName = String(bgToolCall?.toolCallName || '')
            .trim()
            .toLowerCase()
          if (bgToolName === 'panel_set' || bgToolName === 'stage_set') {
            const bgResultContent =
              typeof bgToolCall?.result === 'string'
                ? bgToolCall.result
                : typeof (aguiEvent as { content?: string }).content === 'string'
                  ? (aguiEvent as { content?: string }).content
                  : undefined
            if (
              applyStageSetFromToolCall(
                typeof bgToolCall?.argsText === 'string' ? bgToolCall.argsText : undefined,
                bgResultContent,
                { sessionKey: targetSk },
              )
            ) {
              changed = true
            }
          }
        }
        if (!isBackground && aguiEvent.type === EventType.CUSTOM) {
          const customName = String((aguiEvent as { name?: string }).name || '')
          const customValue = (aguiEvent as { value?: unknown }).value
          if (customName === 'write_file_progress') {
            // content_len / body ticks must force a React bump even when tools[].length is unchanged.
            changed = true
          }
          if (applyRightStageAgUiCustom(customName, customValue, { sessionKey: targetSk })) {
            changed = true
          }
        }
        if (!isBackground && aguiEvent.type === EventType.TOOL_CALL_RESULT) {
          const toolCallId = String((aguiEvent as { toolCallId?: string }).toolCallId || '').trim()
          const tc = toolCallId ? S.aguiTurn?.toolCalls?.get(toolCallId) : undefined
          const toolName = String(tc?.toolCallName || '')
            .trim()
            .toLowerCase()
          // panel_set / stage_set 已在上方统一处理（含后台会话），这里只剩 platform。
          if (toolName === 'platform') {
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
          // - 本轮已是 model_error（额度用尽等）：立刻 idle。这类失败不会再进工具循环，
          //   若因 livePostOpen 拖着 busy，面板会一直「生成中」转圈且停止钮与 busy 不同步。
          // - RUN_FINISHED：若 live POST /runs/stream 仍开着（streamWireSource==='run'），
          //   勿 idle。工具循环中间的 RUN_FINISHED 若提前 idle，侧栏/停止/「运行中」会灭，
          //   但 agui_event 仍豁免写入 → holdStreamResidue 继续流式渲染（切去任务中心再回来尤甚）。
          //   真正收尾交给 SSE final / 用户停止。
          if (rt && isTurnBusy(rt) && targetSk) {
            const isRunError = String(aguiEvent.type) === 'RUN_ERROR'
            const livePostOpen = rt.streamWireSource === 'run'
            const terminalModelError =
              String(S.turn?.systemActivityKind || '').toLowerCase() === 'model_error' ||
              String(
                (S.aguiTurn as { activity?: string | null } | null | undefined)?.activity || '',
              )
                .toLowerCase()
                .includes('model_error')
            if (!isRunError && livePostOpen && !terminalModelError) {
              dispatchSessionTurnEvent(targetSk, { type: 'SESSION_EVENT', at: Date.now() })
            } else {
              const endTrigger = isRunError
                ? 'agui_run_error'
                : terminalModelError
                  ? 'agui_model_error_finished'
                  : 'agui_run_finished'
              logStreamStop({
                sessionKey: targetSk,
                runId: String(S.runId || runId || rt.activeChatRunId || '').trim() || null,
                trigger: endTrigger,
                hasEndMarker: true,
                detail: {
                  aguiType: String(aguiEvent.type || ''),
                  wasBusy: true,
                  livePostOpen,
                  terminalModelError,
                },
              })
              if (terminalModelError) {
                applyStreamTurnEvent(S, {
                  type: 'system_activity',
                  detail: '',
                  kind: 'idle',
                  ts: Date.now(),
                })
                if (!isBackground) {
                  setThreadPanelState((prev) => ({
                    ...prev,
                    activityKind: 'idle',
                    activityDetail: '',
                  }))
                }
                if (rt.streamWireSource === 'run') {
                  dispatchSessionTurnEvent(targetSk, { type: 'WIRE_SOURCE', source: null })
                }
              }
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
        // SSE `final` = turn is over for the UI. Idle IMMEDIATELY — do not SEALING.
        // SEALING kept selectedTurnBusy true through resetRuntimeStream, so React painted
        // empty 「生成中」 (stream cleared, history setRows not committed yet) and then
        // residue+spinner stuck for ~15s until a watchdog cleared busy.
        clearSessionExecutionStateForEnded(targetSk)
        seedSessionRuntimeStatusIdle(targetSk)
        if (rt.streamWireSource === 'run') {
          dispatchSessionTurnEvent(targetSk, { type: 'WIRE_SOURCE', source: null })
        }
        maybeEndTurnSendingState(targetSk, rt, isBackground, { force: true })
        if (!isBackground) activeChatRunIdRef.current = null
        clearActiveRun(rt)
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
          maybeEndTurnSendingState(targetSk, rt, isBackground, { force: true })
          clearActiveRun(rt)
          resetRuntimeStream(rt, isBackground ? undefined : streamRef)
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
                  // Always stamp duration so MessageVirtualList.suppressStreamUiAfterSeal
                  // can drop the _stream pin even if elapsedSec/tokenStr were empty.
                  durationStr: durStr || '1s',
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
        // Idle / clear busy BEFORE emptying the live stream. Otherwise one React
        // frame paints empty 「生成中」 (isSending + empty streamRef) and residue
        // then re-pins the sealed text under a stuck spinner.
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
        if (!isBackground) activeChatRunIdRef.current = null
        clearActiveRun(rt)
        resetRuntimeStream(rt, isBackground ? undefined : streamRef)
        sfLog('ChatApp final stream reset', {
          sessionKey: targetSk,
          runId,
          rtRowsLen: rt.rows.length,
        })
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
            void import('../../../lib/voice-reply-speech.js').then(({ flushVoiceStreamSpeechIfNeeded }) => {
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
              // force：勿被 DB/probe 残留 running 拖住；先 idle 再清空 stream，避免空闪
              maybeEndTurnSendingState(targetSk, rtFin, isBackground, { force: true })
              clearActiveRun(rtFin)
              resetRuntimeStream(rtFin, streamRef)
            } else {
              setStreamHealth(null)
              streamHealthRef.current = null
            }
          }
        }
      }
  }
}
