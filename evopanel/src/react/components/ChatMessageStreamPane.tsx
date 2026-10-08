import { memo, useMemo, useSyncExternalStore, useState, useEffect, useRef, type MutableRefObject } from 'react'
import { MessageVirtualList } from './MessageVirtualList.js'
import type { DisplayRow, StreamState, SubagentStreamTask } from '../chat-types.js'
import type { ChatArtifact } from '../lib/chat-artifact.js'
import type { ResolvedLiveStreamActivity } from '../lib/resolve-live-stream-activity.js'
import type { PriorTurnStrip } from '../lib/session-runtime-store.js'
import {
  getSessionRuntimeEpochForKey,
  subscribeSessionRuntimeForKey,
} from '../lib/session-runtime-store.js'
import { shouldSuppressStreamDeliveredFiles, detectStreamingWritePreview } from '../../lib/workspace-preview-path.js'
import { useChatSurfaceVisible } from '../hooks/useChatSurfaceVisible.js'
import { setChatSurfaceVisible } from '../lib/client-perf.js'

export type ChatMessageStreamPaneProps = {
  rows: DisplayRow[]
  streamRef: MutableRefObject<StreamState>
  historyLoading: boolean
  /** When false, empty thread shows a quiet placeholder instead of the home dashboard */
  showHomeDashboard?: boolean
  /** 首页工作台展示的当前工作空间名（basename）与完整路径 */
  homeWorkspaceLabel?: string
  homeWorkspacePath?: string
  isSending: boolean
  streamLive: boolean
  resumeAttachActive: boolean
  resumeStreamHoldActive: boolean
  onViewReady: () => void
  sessionKey: string
  onQuickPrompt: (text: string) => void
  suppressPlanExecPromptNoise: boolean
  onToolApproval: (
    action: 'approve' | 'approve_all' | 'deny' | 'grant_all' | 'approve_remember',
    toolCallId?: string,
    hint?: { tool_name?: string; summary?: string; args?: Record<string, unknown> },
  ) => void
  toolApprovalBusy: boolean
  toolApprovalUiDisabled: boolean
  hideSubagentInnerTools: boolean
  /** 当前轮 subagent 流式聚合（liveOutput/tools/phase），注入到最后一条 assistant 行供 ToolCallList 消费 */
  inlineSubagentTasks?: Record<string, SubagentStreamTask>
  onOpenFile: (rawUrl: string, name?: string) => void
  onOpenKnowledgeMap?: () => void
  /** 本轮结构化产物（panel_set 权威 path），渲染在最后一条 assistant 气泡下方 */
  recentArtifacts?: ChatArtifact[]
  onOpenArtifact?: (item: ChatArtifact) => void
  liveTurnAssistantRunId: string | null
  liveTurnTokenStr: string
  liveTurnTimingActive: boolean
  executionToolTiming: boolean
  /** Folded into executionToolTiming/liveTurnTimingActive at ChatApp; accepted for API compat */
  goalExecutionTiming?: boolean
  hostedGoalActive: boolean
  lastAssistantRowIndex: number
  streamPriorTurnStrip: PriorTurnStrip
  resolveLiveStreamActivity: (sessionKey: string, isSelectedRow: boolean) => ResolvedLiveStreamActivity | null
  streamingWritePreview: {
    path?: string
    name?: string
    content?: string
    streaming?: boolean
  } | null
  workspacePanelWritePreview: boolean
  layoutKey?: number | string
  onCopy?: (text: string) => void
  onRetry?: () => void
  onEdit?: (text: string, messageId?: string) => void | Promise<void>
  onFork?: (messageId?: string) => void
  historyHasMore?: boolean
  historyLoadingOlder?: boolean
  onLoadOlder?: () => void | Promise<unknown>
  instantOpen?: boolean
  assistantAgent?: import('../lib/agent-avatar.js').AgentAvatarAgent | null
    assistantAgentLabel?: string
}

/**
 * useStreamChromeTick 订阅 session-runtime 通知（writeProgress / subagentTasks / 计数等），
 * 用于驱动流式气泡外壳（计时、活动标签等）的更新。
 *
 * 注意：真正的流式正文驱动依赖的是 MessageVirtualList 中的 useStreamSnapshotSeq +
 * ChatApp 的 commitStreamSnapshot(seq++)，不是这个 sessionEpoch。
 */
function useStreamChromeTick(sk: string): number {
  return useSyncExternalStore(
    (cb) => subscribeSessionRuntimeForKey(sk, cb),
    () => getSessionRuntimeEpochForKey(sk),
  )
}

export const ChatMessageStreamPane = memo(function ChatMessageStreamPane(props: ChatMessageStreamPaneProps) {
  const {
    rows,
    streamRef,
    historyLoading,
    showHomeDashboard = true,
    homeWorkspaceLabel = '',
    homeWorkspacePath = '',
    isSending,
    streamLive,
    resumeAttachActive,
    resumeStreamHoldActive,
    onViewReady,
    sessionKey,
    onQuickPrompt,
    suppressPlanExecPromptNoise,
    onToolApproval,
    toolApprovalBusy,
    toolApprovalUiDisabled,
    hideSubagentInnerTools,
    inlineSubagentTasks,
    onOpenFile,
    onOpenKnowledgeMap,
    recentArtifacts = [],
    onOpenArtifact,
    liveTurnAssistantRunId,
    liveTurnTokenStr,
    liveTurnTimingActive,
    executionToolTiming,
    hostedGoalActive,
    lastAssistantRowIndex,
    streamPriorTurnStrip,
    resolveLiveStreamActivity,
    streamingWritePreview,
    workspacePanelWritePreview,
    layoutKey,
    onCopy,
    onRetry,
    onEdit,
    onFork,
    historyHasMore = false,
    historyLoadingOlder = false,
    onLoadOlder,
    instantOpen = false,
    assistantAgent = null,
    assistantAgentLabel,
  } = props

  const chatSurfaceVisible = useChatSurfaceVisible()
  const sk = String(sessionKey || '').trim()
  const streamChromeTick = useStreamChromeTick(sk)
  const sessionEpoch = useSyncExternalStore(
    (cb) => (sk ? subscribeSessionRuntimeForKey(sk, cb) : () => {}),
    () => (sk ? getSessionRuntimeEpochForKey(sk) : 0),
  )

  const [streamTools, setStreamTools] = useState<unknown[] | undefined>(undefined)

  useEffect(() => {
    setStreamTools(streamRef.current?.turn.tools as unknown[] | undefined)
  }, [streamChromeTick, streamRef])

  const [timingTick, setTimingTick] = useState(0)
  useEffect(() => {
    if (!liveTurnTimingActive && !isSending && !streamLive) return
    const id = window.setInterval(() => setTimingTick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [liveTurnTimingActive, isSending, streamLive])

  const streamingWritePreviewForPane = useMemo(() => {
    if (Array.isArray(streamTools) && streamTools.length) {
      const live = detectStreamingWritePreview(streamTools, { requireReady: false })
      if (live) return live
    }
    return streamingWritePreview
  }, [streamTools, streamingWritePreview])

  const suppressStreamFiles = useMemo(() => {
    if (workspacePanelWritePreview) return true
    return shouldSuppressStreamDeliveredFiles(streamTools || [], {
      streamingWritePreview: streamingWritePreviewForPane ?? streamingWritePreview,
      suppressForSendingWriteTurn: isSending,
    })
  }, [
    streamTools,
    streamingWritePreview,
    streamingWritePreviewForPane,
    workspacePanelWritePreview,
    isSending,
  ])

  const liveStreamActivity = useMemo(() => {
    void streamChromeTick
    void sessionEpoch
    void timingTick
    if (!sk) return null
    return resolveLiveStreamActivity(sk, true)
  }, [sk, resolveLiveStreamActivity, streamChromeTick, sessionEpoch, timingTick])

  /**
   * 关键：不要用 chatSurfaceVisible 卸载 MessageVirtualList。
   * #chat-persistent-host 离开路由时已经 display:none；再卸列表会在标志不同步时留下永久空白。
   * 回到 #/chat 时只强制 visible + layoutKey 重测，禁止用 key remount
   * （remount 会把 viewReady 打回 false；旧逻辑还会把当前 rows 标 stale 并跳过 boot → 永久 --booting 白屏）。
   */
  const [wakeGen, setWakeGen] = useState(0)
  const wasSurfaceVisibleRef = useRef(chatSurfaceVisible)

  useEffect(() => {
    const onShown = () => {
      setChatSurfaceVisible(true)
      setWakeGen((g) => g + 1)
      requestAnimationFrame(() => {
        try {
          window.dispatchEvent(new Event('resize'))
        } catch {
          /* ignore */
        }
      })
    }
    window.addEventListener('evopanel:chat-route-shown', onShown)
    return () => window.removeEventListener('evopanel:chat-route-shown', onShown)
  }, [])

  useEffect(() => {
    if (chatSurfaceVisible && !wasSurfaceVisibleRef.current) {
      setWakeGen((g) => g + 1)
      requestAnimationFrame(() => {
        try {
          window.dispatchEvent(new Event('resize'))
        } catch {
          /* ignore */
        }
      })
    }
    wasSurfaceVisibleRef.current = chatSurfaceVisible
  }, [chatSurfaceVisible])

  /** 回到可见面时：通知组件层（已无 publishLiveStreamNow） */
  useEffect(() => {
    if (!chatSurfaceVisible || !sk || (!streamLive && !isSending)) return
    // 旧 publishLiveStreamNow / bumpStreamDisplayTick 已删：回到 chat 表面时
    // sessionEpoch 通知驱动 MessageVirtualList.streamRow 重算
    if (sk) {
      // 直接调底层：仅当组件已 mount 时；store 会通知订阅者
      getSessionRuntimeEpochForKey(sk) // touch for dep
    }
  }, [chatSurfaceVisible, sk, streamLive, isSending, streamRef])

  const wakeLayoutKey = `${layoutKey ?? 'main'}::wake-${wakeGen}`

  return (
    <MessageVirtualList
      rows={rows}
      streamRef={streamRef}
      historyLoading={historyLoading}
      showHomeDashboard={showHomeDashboard}
      homeWorkspaceLabel={homeWorkspaceLabel}
      homeWorkspacePath={homeWorkspacePath}
      isSending={isSending}
      streamLive={streamLive}
      resumeAttachActive={resumeAttachActive}
      resumeStreamHoldActive={resumeStreamHoldActive}
      layoutKey={wakeLayoutKey}
      onViewReady={onViewReady}
      sessionKey={sessionKey}
      inlineSubagentTasks={inlineSubagentTasks}
      onQuickPrompt={onQuickPrompt}
      suppressPlanExecPromptNoise={suppressPlanExecPromptNoise}
      onToolApproval={onToolApproval}
      toolApprovalBusy={toolApprovalBusy}
      toolApprovalUiDisabled={toolApprovalUiDisabled}
      suppressStreamFiles={suppressStreamFiles}
      hideSubagentInnerTools={hideSubagentInnerTools}
      onOpenFile={onOpenFile}
      onOpenKnowledgeMap={onOpenKnowledgeMap}
      recentArtifacts={recentArtifacts}
      onOpenArtifact={onOpenArtifact}
      liveTurnAssistantRunId={liveTurnAssistantRunId}
      liveTurnTokenStr={liveTurnTokenStr}
      liveTurnTimingActive={liveTurnTimingActive}
      executionToolTiming={executionToolTiming}
      hostedGoalActive={hostedGoalActive}
      lastAssistantRowIndex={lastAssistantRowIndex}
      liveStreamActivity={liveStreamActivity}
      streamPriorTurnStrip={streamPriorTurnStrip}
      onCopy={onCopy}
      onRetry={onRetry}
      onEdit={onEdit}
      onFork={onFork}
      historyHasMore={historyHasMore}
      historyLoadingOlder={historyLoadingOlder}
      onLoadOlder={onLoadOlder}
      instantOpen={instantOpen}
      assistantAgent={assistantAgent}
      assistantAgentLabel={assistantAgentLabel}
    />
  )
})
