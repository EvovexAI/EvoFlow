// @ts-nocheck — mechanical P80 extract; host bag is untyped Record.
/**
 * Composer send turn. Extracted from ChatApp.tsx (P80).
 * Body moved wholesale; outer deps via ctx destructure (host whitelist).
 */
import { startTransition } from 'react'
import type { ChatAttachment, DisplayRow } from '../../chat-types.js'
import type { ContextFileEntry } from '../../components/WorkspaceFileTree.js'
import type { SkillSelection } from '../../components/SkillPickerModal.js'
import type { PluginSelection } from '../../components/PluginPickerModal.js'
import type { PriorTurnStripBundle } from '../../lib/turn-text-isolation.js'
import {
  bindChatTurnSendSession,
  logChatTurnSendClick,
  logChatTurnSendWire,
} from '../../lib/chat-turn-timing-log.js'

export type HandleSendOpts = {
  voiceInitiated?: boolean
  goalInitiated?: boolean
  goalSessionKey?: string
  messageId?: string
  skipTranscriptAppend?: boolean
  alreadyInjected?: boolean
  skillsOverride?: SkillSelection[]
  pluginsOverride?: PluginSelection[]
  /** 工作台首页发送：与乐观用户气泡同帧离开首页，避免空草稿居中闪一下。 */
  leaveHomeOnPaint?: boolean
  /** 乐观气泡画出后、真正 chatSend 前执行（如首页 agent/model 上下文写入）。 */
  beforeWire?: () => Promise<unknown>
}

/** Host bag from ChatApp — mechanical extract; fields match whitelist. */
export type HandleSendCtx = Record<string, any>

export async function handleSend(
  ctx: HandleSendCtx,
  message: string,
  attachments?: ChatAttachment[],
  ctxFiles?: ContextFileEntry[],
  opts?: HandleSendOpts,
): Promise<void> {
  const {
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
    setRoleUiNonce,
    setPreferHomeDashboard,
    setPendingOptimisticUserText,
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
  } = ctx

    // 用户发新消息时重置停止标记，确保停止后可立即发新消息
    userInitiatedStopRef.current = false
    // 仅：用户开了「语音播报」或本轮是语音提问 → 才 arm TTS。
    // 避免小V 退出后全局开关仍开、文本轮误走 legacy HTTP 播报。
    const armVoiceThisTurn =
      shouldArmVoiceReply(voiceReplyEnabled) || !!opts?.voiceInitiated
    if (armVoiceThisTurn) {
      voiceReplyPendingRef.current = true
      voiceStreamingStartedRef.current = false
      voiceSpeechSyncedPlainRef.current = ''
      // 键盘发送也播报：清队列；确认语仅语音提问时再播
      if (!opts?.voiceInitiated) {
        void import('../../../lib/speech-client.js').then(({ resetStreamingSpeechQueue }) => {
          resetStreamingSpeechQueue()
        })
        void import('../../../lib/voice-reply-speech.js').then(({ resetVoiceToolMuteState }) => {
          resetVoiceToolMuteState()
        })
      }
    } else {
      voiceReplyPendingRef.current = false
      voiceStreamingStartedRef.current = false
      voiceSpeechSyncedPlainRef.current = ''
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
        const { api } = await import('../../../lib/tauri-api.js')
        await api.chatUpdateContext(sessionKey, { use_claude_code_chat: true })
        setRoleUiNonce((n) => n + 1)
        toast('已切换为代码助手模式（当前会话）', 'success')
        return
      }
      if (slash === '/lead' || slash === '/main') {
        const { api } = await import('../../../lib/tauri-api.js')
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
    const turnStartTs = Date.now()
    const attachCount = Array.isArray(attachments) ? attachments.length : 0
    const bind = bindChatTurnSendSession({
      sessionKey,
      text: userMessage,
      attachmentCount: attachCount,
    })
    if (!bind.sendClickAlreadyLogged) {
      logChatTurnSendClick({
        sessionKey,
        text: userMessage,
        attachmentCount: attachCount,
        source: opts?.voiceInitiated
          ? 'handle_send_voice'
          : opts?.goalInitiated
            ? 'handle_send_goal'
            : 'handle_send',
      })
    }

    // ① 先只推乐观文案（不 flushSync、不 SEND_STARTED、不 setRows）。
    //    事件 handler 在 await 处让出后 React 提交；ConversationTimeline 走尾部 append 快路径。
    const activeSk = String(sessionRef.current || '').trim()
    const isCurrentSession = activeSk === sessionKey
    const noActiveSession = !activeSk
    if (isCurrentSession || noActiveSession) {
      if (noActiveSession) sessionRef.current = sessionKey
      setPendingOptimisticUserText?.(userMessage)
      setSessionHadContent(true)
      if (opts?.leaveHomeOnPaint) setPreferHomeDashboard?.(false)
    } else if (opts?.leaveHomeOnPaint) {
      setSessionHadContent(true)
      setPreferHomeDashboard?.(false)
    }

    // ② 等一帧：乐观气泡先上屏，再做 runtime 重置 / context / wire
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })

    // 智能体员工：paint 后再本地合并 context（勿挡首帧）
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
        await wsClient.updateSessionContext(sessionKey, patch, { localOnly: true })
        void wsClient.updateSessionContext(sessionKey, patch).catch(() => {})
      } catch {
        /* ignore */
      }
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

    if (isCurrentSession || noActiveSession) {
      streamRef.current = rtSend.stream
      streamRefKeyRef.current = sessionKey
    }
    // busy / sessions：paint 后更新；V4 显示已由 pendingOptimistic 撑住
    dispatchSessionTurnEvent(sessionKey, { type: 'SEND_STARTED', turnStartTs })
    dispatchSessionTurnEvent(sessionKey, { type: 'WIRE_SOURCE', source: 'run' })
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
    lastStreamWritePathRef.current = null
    resetStreamMirrorDedupe()
    activeChatRunIdRef.current = null
    setExpectedChatRunId(sessionKey, null)
    if (streamRef.current.subagentTasks) streamRef.current.subagentTasks = {}
    if (streamRef.current.terminalStreams) streamRef.current.terminalStreams = {}
    parentTaskToSubtaskRef.current = {}

    // host rows / 侧栏：低优先级；V4 权威投影，勿在发送热路径抢主线程。
    // runtime 已写 rtSend.rows；host setRows 仅供副作用对账，延后一帧再 transition。
    startTransition(() => {
      if (isCurrentSession || noActiveSession) {
        // 与当前画面等价则跳过，避免发送瞬间第二 longtask
        const prev = Array.isArray(rows) ? rows : []
        const next = rtSend.rows
        const sameLen = prev.length === next.length
        const tailSame =
          sameLen &&
          prev.length > 0 &&
          String(prev[prev.length - 1]?.messageId || '') ===
            String(next[next.length - 1]?.messageId || '') &&
          String(prev[prev.length - 1]?.text || '') === String(next[next.length - 1]?.text || '')
        if (!tailSame) setRows([...next])
      }
      setTurnPlatformEntries([])
      setPlatformFocusEntryId('')
      setTurnArtifacts([])
      setArtifactFocusId('')
      setStreamingWritePreview(null)
      setSubagentDockTasks({})
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
                  prev.collabPhase === 'plan_ready' || !prev.collabPhase
                    ? 'awaiting_exec'
                    : prev.collabPhase,
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
    })
    scheduleBump()

    const { api } = await import('../../../lib/tauri-api.js')

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
      // 首页等：先让用户看到气泡，再等 agent/model 上下文写完，最后才上线
      if (opts?.beforeWire) {
        await opts.beforeWire().catch(() => {})
      }
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
      // chatSend 会 await 整轮流结束；上线打点须在 await 之前（准备已完成：beforeWire/context/abort）
      logChatTurnSendWire({ sessionKey })
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
          // 语音提问 / 语音播报回合：打标 → ws-client + 后端强制关思考（避免慢回）
          ...(opts?.voiceInitiated ? { voiceInitiated: true } : {}),
          ...(armVoiceThisTurn ? { voiceReply: true } : {}),
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
        setPendingOptimisticUserText?.('')
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
