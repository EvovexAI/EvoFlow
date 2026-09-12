import {
  memo,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MutableRefObject,
  type RefObject,
} from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { resolveMessageRowIsStreaming } from '../lib/message-row-streaming.js'
import { getLiveStreamSnapshot, subscribeLiveStream } from '../lib/live-stream-store.js'
import { isLiveStreamPathEnabled } from '../lib/stream-live-path-toggle.js'
import { MessageRow } from './MessageRow.js'
import { EvoFlowHomeDashboard } from './EvoFlowHomeDashboard.js'
import type { DisplayRow, StreamState, SubagentStreamTask } from '../chat-types.js'
import type { ChatArtifact } from '../lib/chat-artifact.js'
import { chatArtifactDisplayLabel } from '../lib/chat-artifact.js'
import { FileText, Image, Video, Link, Globe, FileCode2, Database, Package } from 'lucide-react'
import { buildStreamDisplayRow } from '../lib/build-stream-display-row.js'
import { SESSION_RUNNING_ACTIVITY_LABEL } from '../lib/resolve-live-stream-activity.js'
import {
  getStreamDisplayTick,
  subscribeStreamDisplayTick,
} from '../lib/stream-display-tick.js'
import { mergeAssistantRowWithStreamRow, assistantRowAcceptsStreamContinuation } from '../lib/merge-assistant-stream-row.js'
import type { ResolvedLiveStreamActivity } from '../lib/resolve-live-stream-activity.js'
import {
  resolveToolApprovalHost,
  toolApprovalInteractiveForItem,
  isHiddenToolApprovalUserMessage,
} from '../../lib/tool-approval.js'
import { HISTORY_FLAT_LIST_MAX_ROWS, shouldPrefetchOlderHistory } from '../hooks/history-pagination.js'
import { historyItemStableKey } from '../lib/history-row-stable-key.js'
import { installMessageListDebugGlobal } from '../../lib/message-list-debug.js'
import { streamRefHasVisibleContent } from '../lib/stream-state.js'
import {
  SCROLL_EDGE_SLACK,
  isFoldInducedScrollAway,
} from '../lib/fold-induced-scroll-away.js'

/**
 * AI 回复流式贴底时，在真正底部上方留一点余量，让最新内容「吸附」在底部偏上，
 * 不贴死输入框边缘。
 */
const STREAM_FOLLOW_BOTTOM_INSET_PX = 36
/** 流式结束后贴底跟随窗口（仅在 true→false 时开启一次，中途不无限续期） */
const POST_STREAM_FOLLOW_MS = 2800
/** 对账 / reload 最多把窗口顶到「起始 + 此上限」，避免 ResizeObserver 连环续期 */
const POST_STREAM_FOLLOW_MAX_MS = 4500

type HistoryItem = { kind: 'row'; row: DisplayRow; i: number }

const MemoMessageRow = memo(MessageRow)

type SharedHistoryProps = {
  sessionKey: string
  historyLoading: boolean
  toolApprovalHost: ReturnType<typeof resolveToolApprovalHost>
  streamToolApprovalHost: ReturnType<typeof resolveToolApprovalHost>
  streamContinuedRowIndex: number
  isSending: boolean
  lastAssistantRowIndex: number
  liveTurnAssistantRunId: string | null
  liveTurnTimingActive: boolean
  executionToolTiming: boolean
  hostedExecutionTiming: boolean
  hostedGoalActive: boolean
  toolApprovalUiDisabled: boolean
  suppressPlanExecPromptNoise: boolean
  hideSubagentInnerTools: boolean
  onOpenFile?: (rawUrl: string, name?: string) => void
  onOpenKnowledgeMap?: () => void
  onToolApproval?: (
    action: 'approve' | 'approve_all' | 'deny' | 'grant_all' | 'approve_remember',
    toolCallId?: string,
    hint?: { tool_name?: string; summary?: string; args?: Record<string, unknown> },
  ) => void
  toolApprovalBusy?: boolean
  /** 流式计时/活动文案：与左侧会话列表同源（resolveLiveStreamActivity.dockLabel） */
  liveActivityDockLabel?: string
  /** 本轮原始耗时（秒）；优先于从 dockLabel 反解析 */
  liveTurnElapsedSec?: number
  /** 消息操作回调 */
  onCopy?: (text: string) => void
  onRetry?: () => void
  onEdit?: (text: string, messageId?: string) => void | Promise<void>
  onFork?: (messageId?: string) => void
  /** 当前会话 Agent 展示名 / 头像 */
  assistantAgentLabel?: string
  assistantAgent?: import('../lib/agent-avatar.js').AgentAvatarAgent | null
}

type HistoryMessageRowProps = SharedHistoryProps & {
  item: HistoryItem
  historyIndex: number
  className: string
  style?: CSSProperties
  measureRef?: (node: HTMLDivElement | null) => void
  measureIndex?: number
}

// resolveShowToolTiming removed (unused)

const HistoryMessageRow = memo(function HistoryMessageRow({
  item,
  historyIndex,
  sessionKey,
  toolApprovalHost,
  streamToolApprovalHost,
  streamContinuedRowIndex,
  isSending,
  toolApprovalUiDisabled,
  suppressPlanExecPromptNoise,
  hideSubagentInnerTools,
  onOpenFile,
  onOpenKnowledgeMap,
  onToolApproval,
  toolApprovalBusy,
  liveActivityDockLabel,
  liveTurnElapsedSec,
  onCopy,
  onRetry,
  onEdit,
  onFork,
  assistantAgentLabel,
  assistantAgent,
  className,
  style,
  measureRef,
  measureIndex,
}: HistoryMessageRowProps) {
  const sk = String(sessionKey || 'default')
  const isContinuedStream = resolveMessageRowIsStreaming(
    item.i,
    streamContinuedRowIndex,
    isSending,
  )
  const approvalHost = isContinuedStream ? streamToolApprovalHost : toolApprovalHost
  return (
    <div
      ref={measureRef}
      data-index={measureIndex}
      data-history-index={historyIndex}
      className={className}
      style={style}
    >
      <MemoMessageRow
        row={item.row}
        isStreaming={isContinuedStream}
        showToolTiming={false}
        onOpenFile={onOpenFile}
        onOpenKnowledgeMap={onOpenKnowledgeMap}
        onToolApproval={onToolApproval}
        toolApprovalBusy={toolApprovalBusy}
        interactiveToolApproval={
          toolApprovalUiDisabled
            ? false
            : toolApprovalInteractiveForItem(approvalHost, item, {
                continuedStreamRowIndex: streamContinuedRowIndex,
              })
        }
        suppressPlanExecPromptNoise={suppressPlanExecPromptNoise}
        hideSubagentInnerTools={hideSubagentInnerTools}
        sessionKey={sk}
        liveActivityDockLabel={isContinuedStream ? liveActivityDockLabel : undefined}
        liveTurnElapsedSec={isContinuedStream ? liveTurnElapsedSec : undefined}
        onCopy={onCopy}
        onRetry={onRetry}
        onEdit={onEdit}
        onFork={onFork}
        assistantAgent={assistantAgent}
        assistantAgentLabel={assistantAgentLabel}
      />
    </div>
  )
})

/** 普通文档流：浏览器原生滚动，读历史最稳 */
const FlatHistoryBody = memo(function FlatHistoryBody(
  props: SharedHistoryProps & { historyItems: HistoryItem[] },
) {
  const { historyItems, liveActivityDockLabel, liveTurnElapsedSec, ...rowProps } = props
  const sk = String(props.sessionKey || 'default')
  return (
    <div className="react-vlist-inner react-vlist-inner--flat">
      {historyItems.map((item, historyIndex) => {
        const isContinuedStream = resolveMessageRowIsStreaming(
          item.i,
          rowProps.streamContinuedRowIndex,
          rowProps.isSending,
        )
        return (
          <HistoryMessageRow
            key={historyItemStableKey(sk, item.row, item.i)}
            item={item}
            historyIndex={historyIndex}
            className={
              item.row.role === 'user'
                ? 'react-vlist-item react-vlist-item--turn react-vlist-item--user'
                : 'react-vlist-item react-vlist-item--turn'
            }
            {...rowProps}
            // 仅流式续写行接收 dock 计时，避免每秒计时击穿其余行 memo
            liveActivityDockLabel={isContinuedStream ? liveActivityDockLabel : undefined}
            liveTurnElapsedSec={isContinuedStream ? liveTurnElapsedSec : undefined}
          />
        )
      })}
    </div>
  )
})

/** 仅极长会话才用虚拟列表 */
const VirtualHistoryBody = memo(function VirtualHistoryBody(
  props: SharedHistoryProps & {
    historyItems: HistoryItem[]
    parentRef: RefObject<HTMLDivElement | null>
    autoFollowRef: MutableRefObject<boolean>
    holdHistoryScrollRef: MutableRefObject<boolean>
    readingHistoryRef: MutableRefObject<boolean>
    /** 用户最近一次主动滚动时间；测高校正时避开手势中，防止上滑卡顿 */
    lastUserScrollAtRef: MutableRefObject<number>
    virtualBootScrollRef: MutableRefObject<(() => void) | null>
    virtualScrollToIndexRef: MutableRefObject<
      ((index: number, align: 'start' | 'end') => void) | null
    >
    virtualScrollToOffsetRef: MutableRefObject<((offset: number) => void) | null>
  },
) {
  const {
    historyItems,
    parentRef,
    autoFollowRef,
    holdHistoryScrollRef,
    readingHistoryRef,
    lastUserScrollAtRef,
    virtualBootScrollRef,
    virtualScrollToIndexRef,
    virtualScrollToOffsetRef,
    ...rowProps
  } = props
  const sk = String(rowProps.sessionKey || 'default')
  const historyItemsRef = useRef(historyItems)
  historyItemsRef.current = historyItems

  const getRowKey = useCallback(
    (index: number) => {
      const item = historyItemsRef.current[index]
      if (!item) return `missing-${index}`
      return historyItemStableKey(sk, item.row, item.i)
    },
    [sk],
  )

  const virtualizer = useVirtualizer({
    count: historyItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      const item = historyItemsRef.current[index]
      if (!item) return 120
      const row = item.row
      if (row.role === 'user') return 60
      if (row.role === 'assistant') {
        const toolsLen = row.tools?.length ?? 0
        const hasReasoning = !!(row.reasoningPreview && String(row.reasoningPreview).trim())
        const textLen = String(row.text || '').length
        let est = 80
        if (toolsLen > 0) est += toolsLen * 50
        if (hasReasoning) est += 60
        if (textLen > 200) est += Math.min(1600, Math.ceil((textLen - 200) / 40) * 24)
        return est
      }
      return 100
    },
    // 6->3：降低滚动窗口外常驻行数（配合 markdown LRU 缓存，重挂成本已可控）
    overscan: 3,
    getItemKey: (index) => getRowKey(index),
  })

  /** 极长会话：boot 阶段由父级调用 scrollToIndex 贴底；流式期间随高度变化保持贴底 */
  useLayoutEffect(() => {
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => {
      // 上拉分页锚定期间必须校正，否则 maxScroll / 锚点错位
      if (holdHistoryScrollRef.current) return true
      // 用户手势中改 scrollTop 会与手指/滚轮抢位置 → 卡顿抖动
      if (Date.now() - lastUserScrollAtRef.current < 160) return false
      // 读历史且手势已停：允许测高校正，避免滚到一半卡住
      if (readingHistoryRef.current) return true
      return autoFollowRef.current
    }
    const scrollToHistoryIndex = (index: number, align: 'start' | 'end') => {
      if (holdHistoryScrollRef.current && align === 'end') return
      const count = historyItemsRef.current.length
      if (index < 0 || index >= count) return
      virtualizer.scrollToIndex(index, { align })
    }
    virtualBootScrollRef.current = () => {
      if (holdHistoryScrollRef.current) return
      scrollToHistoryIndex(historyItemsRef.current.length - 1, 'end')
    }
    virtualScrollToIndexRef.current = scrollToHistoryIndex
    virtualScrollToOffsetRef.current = (offset: number) => {
      virtualizer.scrollToOffset(Math.max(0, offset), { align: 'start' })
    }
    return () => {
      virtualBootScrollRef.current = null
      virtualScrollToIndexRef.current = null
      virtualScrollToOffsetRef.current = null
    }
  })

  return (
    <div
      className="react-vlist-inner"
      style={{ width: '100%', height: virtualizer.getTotalSize(), position: 'relative' }}
    >
      {virtualizer.getVirtualItems().map((vRow) => {
        const item = historyItems[vRow.index]
        if (!item) return null
        const isUser = item.row.role === 'user'
        return (
          <HistoryMessageRow
            key={vRow.key}
            item={item}
            historyIndex={vRow.index}
            sessionKey={rowProps.sessionKey}
            historyLoading={rowProps.historyLoading}
            toolApprovalHost={rowProps.toolApprovalHost}
            streamToolApprovalHost={rowProps.streamToolApprovalHost}
            streamContinuedRowIndex={rowProps.streamContinuedRowIndex}
            isSending={rowProps.isSending}
            lastAssistantRowIndex={rowProps.lastAssistantRowIndex}
            liveTurnAssistantRunId={rowProps.liveTurnAssistantRunId}
            liveTurnTimingActive={rowProps.liveTurnTimingActive}
            executionToolTiming={rowProps.executionToolTiming}
            hostedExecutionTiming={rowProps.hostedExecutionTiming}
            hostedGoalActive={rowProps.hostedGoalActive}
            toolApprovalUiDisabled={rowProps.toolApprovalUiDisabled}
            suppressPlanExecPromptNoise={rowProps.suppressPlanExecPromptNoise}
            hideSubagentInnerTools={rowProps.hideSubagentInnerTools}
            onOpenFile={rowProps.onOpenFile}
            onOpenKnowledgeMap={rowProps.onOpenKnowledgeMap}
            onToolApproval={rowProps.onToolApproval}
            toolApprovalBusy={rowProps.toolApprovalBusy}
            liveActivityDockLabel={
              resolveMessageRowIsStreaming(
                item.i,
                rowProps.streamContinuedRowIndex,
                rowProps.isSending,
              )
                ? rowProps.liveActivityDockLabel
                : undefined
            }
            liveTurnElapsedSec={
              resolveMessageRowIsStreaming(
                item.i,
                rowProps.streamContinuedRowIndex,
                rowProps.isSending,
              )
                ? rowProps.liveTurnElapsedSec
                : undefined
            }
            onCopy={rowProps.onCopy}
            onRetry={rowProps.onRetry}
            onEdit={rowProps.onEdit}
            onFork={rowProps.onFork}
            assistantAgent={rowProps.assistantAgent}
            assistantAgentLabel={rowProps.assistantAgentLabel}
            className={
              isUser
                ? 'react-vlist-item react-vlist-item--turn react-vlist-item--user'
                : 'react-vlist-item react-vlist-item--turn'
            }
            measureRef={virtualizer.measureElement}
            measureIndex={vRow.index}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${vRow.start}px)`,
            }}
          />
        )
      })}
    </div>
  )
})

const HistoryBody = memo(function HistoryBody(
  props: SharedHistoryProps & {
    historyItems: HistoryItem[]
    parentRef: RefObject<HTMLDivElement | null>
    autoFollowRef: MutableRefObject<boolean>
    holdHistoryScrollRef: MutableRefObject<boolean>
    readingHistoryRef: MutableRefObject<boolean>
    lastUserScrollAtRef: MutableRefObject<number>
    virtualBootScrollRef: MutableRefObject<(() => void) | null>
    virtualScrollToIndexRef: MutableRefObject<
      ((index: number, align: 'start' | 'end') => void) | null
    >
    virtualScrollToOffsetRef: MutableRefObject<((offset: number) => void) | null>
    showApprovalPauseHint: boolean
  },
) {
  const {
    historyItems,
    parentRef,
    autoFollowRef,
    holdHistoryScrollRef,
    readingHistoryRef,
    lastUserScrollAtRef,
    virtualBootScrollRef,
    virtualScrollToIndexRef,
    virtualScrollToOffsetRef,
    showApprovalPauseHint,
    ...rowProps
  } = props
  const useFlat = historyItems.length <= HISTORY_FLAT_LIST_MAX_ROWS

  return (
    <>
      {showApprovalPauseHint ? (
        <div className="react-chat-tool-approval-pause-hint" role="status">
          智能体已暂停，请点击消息流中标记为「待授权」的工具进行批准或拒绝；全部确认后将自动继续。
        </div>
      ) : null}
      {useFlat ? (
        <FlatHistoryBody historyItems={historyItems} {...rowProps} />
      ) : (
        <VirtualHistoryBody
          historyItems={historyItems}
          parentRef={parentRef}
          autoFollowRef={autoFollowRef}
          holdHistoryScrollRef={holdHistoryScrollRef}
          readingHistoryRef={readingHistoryRef}
          lastUserScrollAtRef={lastUserScrollAtRef}
          virtualBootScrollRef={virtualBootScrollRef}
          virtualScrollToIndexRef={virtualScrollToIndexRef}
          virtualScrollToOffsetRef={virtualScrollToOffsetRef}
          {...rowProps}
        />
      )}
    </>
  )
})

function bootScrollToBottom(
  el: HTMLDivElement,
  opts?: { virtualScroll?: (() => void) | null; maxPasses?: number },
) {
  const maxPasses = opts?.maxPasses ?? 10
  for (let i = 0; i < maxPasses; i++) {
    opts?.virtualScroll?.()
    el.scrollTop = el.scrollHeight
    if (isPinnedToBottom(el, 8)) return true
  }
  opts?.virtualScroll?.()
  el.scrollTop = el.scrollHeight
  return isPinnedToBottom(el, 16)
}

function isPinnedToBottom(el: HTMLDivElement, slack = 4) {
  return el.scrollHeight - (el.scrollTop + el.clientHeight) <= slack
}

function cancelPendingScrollRaf(rafScheduledRef: MutableRefObject<number>) {
  if (!rafScheduledRef.current) return
  cancelAnimationFrame(rafScheduledRef.current)
  rafScheduledRef.current = 0
}

function readScrollJumpVisibility(
  el: HTMLDivElement,
  prev?: { showTop: boolean; showBottom: boolean },
) {
  const distBottom = el.scrollHeight - (el.scrollTop + el.clientHeight)
  const canScroll = el.scrollHeight > el.clientHeight + 8
  // 滞回：避免在阈值附近 true/false 翻转触发整表 re-render 卡顿
  const enter = SCROLL_EDGE_SLACK
  const leave = Math.max(12, SCROLL_EDGE_SLACK - 24)
  const showTop = canScroll
    ? prev?.showTop
      ? el.scrollTop > leave
      : el.scrollTop > enter
    : false
  const showBottom = canScroll
    ? prev?.showBottom
      ? distBottom > leave
      : distBottom > enter
    : false
  return { canScroll, showTop, showBottom }
}

function shouldPreserveSendScrollAnchor(
  postSendScrollAnchorRef: MutableRefObject<boolean>,
  sendScrollLockUntilRef: MutableRefObject<number>,
) {
  return (
    postSendScrollAnchorRef.current ||
    Date.now() < sendScrollLockUntilRef.current
  )
}

type OlderLoadScrollAnchor = {
  scrollHeight: number
  scrollTop: number
  historyItemsLenBefore: number
  anchorHistoryIndex: number
  anchorViewportOffset: number
  /** Stable key of the anchor row — survives prepend index shift in virtual lists */
  anchorStableKey: string
  attempts: number
}

function findHistoryIndexByStableKey(
  items: HistoryItem[],
  sessionKey: string,
  stableKey: string,
): number {
  if (!stableKey) return -1
  const sk = String(sessionKey || 'default')
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (historyItemStableKey(sk, item.row, item.i) === stableKey) return i
  }
  return -1
}

/** First history row visible in the scroller (for prepend scroll anchoring). */
function findAnchorHistoryIndexInViewport(
  content: HTMLElement | null,
  scroller: HTMLElement,
): { index: number; viewportOffset: number } {
  if (!content) return { index: 0, viewportOffset: 0 }
  const scrollerTop = scroller.getBoundingClientRect().top
  const nodes = content.querySelectorAll('[data-history-index]')
  for (const node of nodes) {
    const el = node as HTMLElement
    const rect = el.getBoundingClientRect()
    if (rect.bottom <= scrollerTop + 4) continue
    const index = Number.parseInt(el.dataset.historyIndex || '', 10)
    return {
      index: Number.isFinite(index) && index >= 0 ? index : 0,
      viewportOffset: Math.max(0, Math.round(rect.top - scrollerTop)),
    }
  }
  return { index: 0, viewportOffset: 0 }
}

export const MessageVirtualList = memo(function MessageVirtualList({
  rows,
  streamRef,
  historyLoading = false,
  showHomeDashboard = true,
  isSending = false,
  streamLive = false,
  layoutKey = 0,
  sessionKey = '',
  inlineSubagentTasks,
  onQuickPrompt,
  suppressPlanExecPromptNoise = false,
  onToolApproval,
  toolApprovalBusy,
  toolApprovalUiDisabled = false,
  suppressStreamFiles = false,
  hideSubagentInnerTools = false,
  onOpenFile,
  onOpenKnowledgeMap,
  recentArtifacts = [],
  onOpenArtifact,
  liveTurnAssistantRunId = null,
  liveTurnTokenStr = '',
  liveTurnTimingActive = false,
  executionToolTiming = false,
  hostedExecutionTiming = false,
  hostedGoalActive = false,
  resumeAttachActive = false,
  resumeStreamHoldActive = false,
  lastAssistantRowIndex = -1,
  liveStreamActivity = null,
  onViewReady,
  onCopy,
  onRetry,
  onEdit,
  onFork,
  streamPriorTurnStrip,
  historyHasMore = false,
  historyLoadingOlder = false,
  onLoadOlder,
  instantOpen = false,
  assistantAgent = null,
  assistantAgentLabel,
}: {
  rows: DisplayRow[]
  streamRef: MutableRefObject<StreamState>
  historyLoading?: boolean
  /** False when history failed / not a true empty home — keep composer visible */
  showHomeDashboard?: boolean
  isSending?: boolean
  /** 续流/attach 时 isSending 可能滞后；与 session runtime live 同源 */
  streamLive?: boolean
  layoutKey?: number | string
  sessionKey?: string
  inlineSubagentTasks?: Record<string, SubagentStreamTask>
  onQuickPrompt?: (text: string) => void
  suppressPlanExecPromptNoise?: boolean
  onToolApproval?: (
    action: 'approve' | 'approve_all' | 'deny' | 'grant_all' | 'approve_remember',
    toolCallId?: string,
    hint?: { tool_name?: string; summary?: string; args?: Record<string, unknown> },
  ) => void
  toolApprovalBusy?: boolean
  toolApprovalUiDisabled?: boolean
  suppressStreamFiles?: boolean
  hideSubagentInnerTools?: boolean
  onOpenFile?: (rawUrl: string, name?: string) => void
  onOpenKnowledgeMap?: () => void
  recentArtifacts?: ChatArtifact[]
  onOpenArtifact?: (item: ChatArtifact) => void
  liveTurnAssistantRunId?: string | null
  liveTurnTokenStr?: string
  liveTurnTimingActive?: boolean
  executionToolTiming?: boolean
  hostedExecutionTiming?: boolean
  hostedGoalActive?: boolean
  resumeAttachActive?: boolean
  resumeStreamHoldActive?: boolean
  lastAssistantRowIndex?: number
  liveStreamActivity?: ResolvedLiveStreamActivity | null
  /** 会话历史贴底就绪后回调（用于外层继续显示 loading 直至此时） */
  onViewReady?: () => void
  /** 消息操作回调 */
  onCopy?: (text: string) => void
  onRetry?: () => void
  onEdit?: (text: string, messageId?: string) => void | Promise<void>
  onFork?: (messageId?: string) => void
  /** 上一轮 assistant 封存段，用于流式气泡剥离 checkpoint 回灌 */
  streamPriorTurnStrip?: import('../lib/turn-text-isolation.js').PriorTurnStripBundle
  /** 仍有更早 transcript 可上拉 */
  historyHasMore?: boolean
  historyLoadingOlder?: boolean
  onLoadOlder?: () => void | Promise<unknown>
  /** Idle/live cache hit: skip visibility-hidden multi-frame boot */
  instantOpen?: boolean
  assistantAgent?: import('../lib/agent-avatar.js').AgentAvatarAgent | null
  assistantAgentLabel?: string
}) {
  const streamDisplayTick = useSyncExternalStore(
    subscribeStreamDisplayTick,
    getStreamDisplayTick,
    getStreamDisplayTick,
  )
  const parentRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const autoFollowRef = useRef(true)
  /** 上滑加载历史期间：禁止贴底 / 虚拟列表随高度变化自动调 scrollTop */
  const holdHistoryScrollRef = useRef(false)
  /** 用户正在阅读更早历史（非底部）；直到主动滚回底部才解除 */
  const readingHistoryRef = useRef(false)
  const prevLastHistoryTailKeyRef = useRef('')
  const virtualBootScrollRef = useRef<(() => void) | null>(null)
  const virtualScrollToIndexRef = useRef<
    ((index: number, align: 'start' | 'end') => void) | null
  >(null)
  const virtualScrollToOffsetRef = useRef<((offset: number) => void) | null>(null)
  const postStreamFollowUntilRef = useRef(0)
  /** 本轮 post-stream 窗口起点；用于硬封顶，防止 schedule/RO 把 until 无限往后推 */
  const postStreamFollowStartedAtRef = useRef(0)
  const postStreamScrollTimerRef = useRef(0)
  /** 流式结束后 ResizeObserver / rows 抖动：单帧合并轻量贴底，避免 bootScroll 多遍打架 */
  const postStreamPinRafRef = useRef(0)
  const lastProgrammaticScrollRef = useRef(0)
  /** 用户主动上滑意图窗口：此期间禁止 fold 误判回贴底 / 虚拟列表测高改 scrollTop */
  const userScrollAwayIntentUntilRef = useRef(0)
  const lastUserScrollAtRef = useRef(0)
  /** 单帧合并滚动：同一帧内多次调用只执行一次 rAF，消除 burst/ResizeObserver/tick 竞争导致的闪烁 */
  const rafScheduledRef = useRef(0)
  /** 发送后锁定滚动位置，防止流式 tick / ResizeObserver 覆盖 */
  const sendScrollLockUntilRef = useRef(0)
  /** 底部占位：发送后撑出足够滚动空间，让最后一条消息能滚到视口顶部 */
  const bottomSpacerRef = useRef<HTMLDivElement | null>(null)
  /** 取消过期的发送后顶对齐重试 */
  const sendScrollTokenRef = useRef(0)
  /** 同一轮 user 发送只顶对齐一次，避免 userAppended + sendStarted 双跳 */
  const lastSendScrollTailRef = useRef('')
  /** 发送后顶对齐模式：禁止 scroll 监听器误开 autoFollow 导致与贴底逻辑打架 */
  const postSendScrollAnchorRef = useRef(false)
  const lastScrollTopRef = useRef(0)
  /** 用于区分「内容折叠导致高度骤降」与「用户手动上滑」 */
  const lastScrollHeightRef = useRef(0)
  const prevLayoutKeyRef = useRef(layoutKey)
  const sessionBootedRef = useRef(false)
  const bootTokenRef = useRef(0)
  /** 会话切换瞬间捕获旧 rows 引用；boot effect 检测到 rows 仍是旧引用时跳过，等父级更新后再 boot */
  const staleRowsAtSwitchRef = useRef<DisplayRow[] | null>(null)
  const prevHistoryLoadingRef = useRef(historyLoading)
  const prevRowsLenRef = useRef(0)
  const prevIsSendingRef = useRef(false)
  const prevHistoryLenRef = useRef(0)
  /** 贴底确认前不显示（DOM 已挂载于隐藏容器内） */
  const [viewReady, setViewReady] = useState(false)
  /** 流式期间用户不在底部时显示「↓ 新消息」按钮 */
  const [showNewMsgBtn, setShowNewMsgBtn] = useState(false)
  /** 快速跳转：不在顶部/底部时显示对应按钮 */
  const [showScrollTopBtn, setShowScrollTopBtn] = useState(false)
  const [showScrollBottomBtn, setShowScrollBottomBtn] = useState(false)
  const showScrollTopBtnRef = useRef(false)
  const showScrollBottomBtnRef = useRef(false)
  showScrollTopBtnRef.current = showScrollTopBtn
  showScrollBottomBtnRef.current = showScrollBottomBtn
  /** 仅用户手动上滑时为 true；发送后「消息顶对齐」不算离开底部 */
  const userScrolledAwayDuringStreamRef = useRef(false)
  if (prevLayoutKeyRef.current !== layoutKey) {
    prevLayoutKeyRef.current = layoutKey
    autoFollowRef.current = false
    userScrolledAwayDuringStreamRef.current = false
    postSendScrollAnchorRef.current = false
    cancelPendingScrollRaf(rafScheduledRef)
  }
  const onViewReadyRef = useRef(onViewReady)
  onViewReadyRef.current = onViewReady
  const onLoadOlderRef = useRef(onLoadOlder)
  onLoadOlderRef.current = onLoadOlder
  const historyHasMoreRef = useRef(historyHasMore)
  historyHasMoreRef.current = historyHasMore
  const historyLoadingOlderRef = useRef(historyLoadingOlder)
  historyLoadingOlderRef.current = historyLoadingOlder
  const instantOpenRef = useRef(instantOpen)
  instantOpenRef.current = instantOpen
  /** 上拉插入历史前的滚动锚点，避免视口跳动 */
  const pendingOlderLoadAnchorRef = useRef<OlderLoadScrollAnchor | null>(null)
  const historyItemsCountRef = useRef(0)
  /** 进入顶部缓冲区的边沿触发，避免停留在缓冲区内反复加载 */
  const wasInOlderPrefetchZoneRef = useRef(false)
  const olderLoadCooldownUntilRef = useRef(0)

  const lastHistoryRole = rows[rows.length - 1]?.role
  const prevIsSendingPropRef = useRef(false)
  const lastSessionKeyForSendRef = useRef(sessionKey)
  /**
   * 反闪烁宽限：发送瞬间到 SSE 首帧之间，isSending 可能短暂被某个清理路径置 false
   * 再回 true，导致 streamActive 0→1→0→1 → 光标 / 计时条 显示→隐藏→再显示。
   * 这里把 streamActive 一旦点亮则至少保持 STREAM_ACTIVE_MIN_VISIBLE_MS，除非
   * 历史 rows 已经出现「真正终态 assistant 行」（incompleteStream=false 且有时长/token）。
   */
  const STREAM_ACTIVE_MIN_VISIBLE_MS = 1200
  const streamActiveSinceRef = useRef<number>(0)
  const lastTerminalDigestRef = useRef<string>('')
  // 监控终态指纹：assistant 行的 runId + durationStr + tokenStr。真正落库后这个值会变。
  const lastRowForDigest = rows[rows.length - 1]
  const terminalAssistantSealed =
    lastRowForDigest?.role === 'assistant' &&
    !lastRowForDigest.incompleteStream &&
    !!(lastRowForDigest.durationStr || lastRowForDigest.tokenStr)
  const currentTerminalDigest = terminalAssistantSealed
    ? `${lastRowForDigest.runId || ''}|${lastRowForDigest.durationStr || ''}|${lastRowForDigest.tokenStr || ''}`
    : ''
  const justSawTerminal =
    currentTerminalDigest !== '' && currentTerminalDigest !== lastTerminalDigestRef.current
  if (currentTerminalDigest) lastTerminalDigestRef.current = currentTerminalDigest
  /** final 已落库且 stream 内存已清空：勿再等 isSending 归零才撤 _stream pin（否则会闪占位 + 视口跳回用户消息） */
  const suppressStreamUiAfterSeal =
    terminalAssistantSealed && !streamRefHasVisibleContent(streamRef.current)
  const rawStreamActive =
    !suppressStreamUiAfterSeal && (isSending || streamLive || resumeStreamHoldActive)
  /**
   * ★ 关键修复：在 render 阶段（所有 useLayoutEffect 之前）检测 isSending prop 的 false→true 跳变，
   * 立即设 autoFollowRef=false + sendScrollLockUntilRef。不依赖 lastHistoryRole（rows 可能还没更新）。
   * 这样 stream tick effect 等 useLayoutEffect 执行时 autoFollowRef 已为 false，不会滚到底部。
   */

  if (rawStreamActive) {
    if (!streamActiveSinceRef.current) streamActiveSinceRef.current = Date.now()
  } else if (justSawTerminal) {
    // 收到本轮真正终态 — 允许立即熄灭
    streamActiveSinceRef.current = 0
  }
  const withinGrace =
    !rawStreamActive &&
    streamActiveSinceRef.current > 0 &&
    Date.now() - streamActiveSinceRef.current < STREAM_ACTIVE_MIN_VISIBLE_MS &&
    !justSawTerminal
  const streamActive = rawStreamActive || withinGrace

  /**
   * ★ 关键修复：在 render 阶段（所有 useLayoutEffect 之前）检测 isSending prop 的 false→true 跳变，
   * 立即设 autoFollowRef=false + sendScrollLockUntilRef。不依赖 lastHistoryRole（rows 可能还没更新）。
   * 会话切换时不触发（避免打开/切到流式会话时误锁滚动、停在中间）。
   */
  const sessionKeyForSend = String(sessionKey || '')
  if (lastSessionKeyForSendRef.current !== sessionKeyForSend) {
    lastSessionKeyForSendRef.current = sessionKeyForSend
    lastSendScrollTailRef.current = ''
    prevIsSendingPropRef.current = isSending
  } else if (!prevIsSendingPropRef.current && isSending) {
    // 发送后贴底：保持 autoFollow=true，短锁防止内容跳变时滚动监听器误判
    autoFollowRef.current = true
    postSendScrollAnchorRef.current = false
    sendScrollLockUntilRef.current = Date.now() + 500
    lastProgrammaticScrollRef.current = Date.now()
  }
  prevIsSendingPropRef.current = isSending

  if (!streamActive && streamActiveSinceRef.current) {
    // 已超过宽限期且无新点亮，重置起点
    streamActiveSinceRef.current = 0
  }
  // 宽限期到期前强制一次 re-render，让 streamActive 重新计算到 false
  const [graceTick, setGraceTick] = useState(0)
  useEffect(() => {
    if (!withinGrace) return
    const remain =
      STREAM_ACTIVE_MIN_VISIBLE_MS - (Date.now() - streamActiveSinceRef.current)
    if (remain <= 0) return
    const t = window.setTimeout(() => setGraceTick((n) => n + 1), remain + 30)
    return () => window.clearTimeout(t)
  }, [withinGrace, graceTick])
  const streamActiveRef = useRef(streamActive)
  streamActiveRef.current = streamActive
  const liveStreamPaintEpoch = useSyncExternalStore(
    (cb) =>
      isLiveStreamPathEnabled() && streamActive && sessionKeyForSend
        ? subscribeLiveStream(sessionKeyForSend, cb)
        : () => {},
    () =>
      isLiveStreamPathEnabled() && streamActive && sessionKeyForSend
        ? getLiveStreamSnapshot(sessionKeyForSend).epoch
        : 0,
    () => 0,
  )
  /** 上一帧 streamActive，用于检测 true→false 跳变并设置 post-stream 贴底窗口 */
  const prevStreamActiveRef = useRef(false)
  const liveActivityDockLabel =
    liveStreamActivity != null ? String(liveStreamActivity.dockLabel || '').trim() : undefined
  const liveTurnElapsedSec =
    liveStreamActivity != null &&
    liveStreamActivity.elapsedSec != null &&
    Number.isFinite(liveStreamActivity.elapsedSec)
      ? liveStreamActivity.elapsedSec
      : undefined
  const showStreamSlot =
    streamActive &&
    (lastHistoryRole === 'user' || lastHistoryRole === 'assistant' || !!liveStreamActivity)
  const lastHistoryRow = rows[rows.length - 1]
  const streamRunId = String(streamRef.current?.runId || '').trim()
  const streamContinuationOpts = {
    hostedGoalSameRun: hostedGoalActive,
    resumeAttachSameRun: resumeAttachActive,
    liveStreamSameRun: rawStreamActive && !!streamRunId && lastHistoryRow?.role === 'assistant',
  }
  /** Skip trailing hidden replay user rows so approval continuation merges into incomplete assistant. */
  let continuationTargetIndex = -1
  let continuationTargetRow: DisplayRow | undefined
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (row?.role === 'user') {
      if (isHiddenToolApprovalUserMessage(String(row.text || ''))) continue
      break
    }
    if (row?.role === 'assistant') {
      if (assistantRowAcceptsStreamContinuation(row, streamRunId, streamContinuationOpts)) {
        continuationTargetIndex = i
        continuationTargetRow = row
      }
      break
    }
  }
  const streamContinuesAssistant =
    showStreamSlot && continuationTargetIndex >= 0 && !!continuationTargetRow
  /**
   * 上一帧的 streamRow 记忆。streamRow 抖动场景：当 built.text 暂时为空但 streamActive 仍在时，
   * useMemo 会先返回 null 再变 object，导致 streamContinuedRowIndex 在 -1 / rows.length-1
   * 之间反复切换，MessageRow.isStreaming 跟着 true ↔ false 跳变 → 光标闪烁、计时条闪烁。
   * 用 ref 记住上一次非空的 row，在「streamActive && 当前帧建空但内容尚未提交」时复用。
   */
  const lastStreamRowRef = useRef<DisplayRow | null>(null)
  const streamRow = useMemo(() => {
    if (!showStreamSlot) {
      lastStreamRowRef.current = null
      return null
    }
    const built = buildStreamDisplayRow(
      streamRef,
      liveTurnTokenStr,
      suppressStreamFiles,
      isSending,
      streamPriorTurnStrip,
      sessionKeyForSend,
    )
    if (built) {
      const last = continuationTargetRow || rows[rows.length - 1]
      const emptyPlaceholder =
        !String(built.text || '').trim() &&
        !(built.segments?.length) &&
        !(built.tools?.length) &&
        !String(built.reasoningPreview || '').trim()
      const acceptsContinuation = assistantRowAcceptsStreamContinuation(
        last,
        streamRunId,
        streamContinuationOpts,
      )
      if (
        emptyPlaceholder &&
        last?.role === 'assistant' &&
        (last.durationStr || last.tokenStr) &&
        !last.incompleteStream &&
        !acceptsContinuation
      ) {
        // 已落库 assistant 行已显示 token/计时 — 流式 slot 真没新内容了，清理 ref。
        lastStreamRowRef.current = null
        return null
      }
      lastStreamRowRef.current = built
      return built
    }
    // built==null 且仍在 streamActive：优先复用上一帧 row 保持 isStreaming 稳定，
    // 避免气泡反复闪烁；仅 executing（isSending）时才展示「运行中」占位骨架。
    if (streamActive && lastStreamRowRef.current) {
      // 新一轮 user 发送后 stream 已清空：勿复用上一轮 AI 正文（半旧半新）
      if (lastHistoryRole === 'user' && !streamRefHasVisibleContent(streamRef.current)) {
        lastStreamRowRef.current = null
      } else {
        return lastStreamRowRef.current
      }
    }
    if (isSending) {
      const placeholder: DisplayRow = {
        role: '_stream',
        text: '',
        tools: [],
        systemActivity: SESSION_RUNNING_ACTIVITY_LABEL,
      } as DisplayRow
      lastStreamRowRef.current = placeholder
      return placeholder
    }
    lastStreamRowRef.current = null
    return null
  }, [
    showStreamSlot,
    streamDisplayTick,
    streamActive,
    isSending,
    streamRef,
    liveTurnTokenStr,
    suppressStreamFiles,
    rows,
    streamPriorTurnStrip,
    sessionKeyForSend,
    continuationTargetRow,
    continuationTargetIndex,
    lastHistoryRole,
  ])

  // ★ 性能优化：拆分 baseHistoryItems 与流式合并，使流式 tick 期间非末行 item 引用保持稳定，
  // 避免所有 HistoryMessageRow 因 item prop 引用变化而打破 memo。
  const baseHistoryItems = useMemo((): HistoryItem[] => {
    const ink = inlineSubagentTasks || {}
    const rawLast = rows[rows.length - 1]
    let displayRows = rows
    if (rawLast?.role === 'assistant' && Object.keys(ink).length > 0) {
      displayRows = [...rows.slice(0, -1), { ...rawLast, subagentTasks: { ...ink } }]
    }
    return displayRows.map((row, i) => ({ kind: 'row' as const, row, i }))
  }, [rows, inlineSubagentTasks])

  const historyItems = useMemo((): HistoryItem[] => {
    if (!streamContinuesAssistant || !streamRow || continuationTargetIndex < 0) {
      return baseHistoryItems
    }
    const last = baseHistoryItems[continuationTargetIndex]
    if (last?.row.role !== 'assistant') return baseHistoryItems
    return [
      ...baseHistoryItems.slice(0, continuationTargetIndex),
      { ...last, row: mergeAssistantRowWithStreamRow(last.row, streamRow) },
      ...baseHistoryItems.slice(continuationTargetIndex + 1),
    ]
  }, [baseHistoryItems, streamContinuesAssistant, streamRow, continuationTargetIndex])

  const streamContinuedRowIndex =
    streamContinuesAssistant && streamRow ? continuationTargetIndex : -1
  const showSeparateStreamPin = !!streamRow && !streamContinuesAssistant

  const hasContent = historyItems.length > 0 || showSeparateStreamPin
  historyItemsCountRef.current = historyItems.length
  const historyItemsRef = useRef(historyItems)
  historyItemsRef.current = historyItems
  const sessionKeyRef = useRef(sessionKey)
  sessionKeyRef.current = sessionKey

  const historyToolApprovalHost = useMemo(
    () =>
      resolveToolApprovalHost({
        rows,
        streamTools: undefined,
        isSending: false,
      }),
    [rows],
  )

  // ★ 性能修复：原依赖含 streamDisplayTick，流式期间每 80-200ms 重算生成新对象引用，
  // 通过 SharedHistoryProps 传给所有 HistoryMessageRow 导致 memo 全部失效 → N 条消息每秒
  // 重渲染 5-12 次。改为依赖 streamRef.current?.turn.tools 实际快照引用：只有工具数组
  // 引用变化时才重算，文本 delta 期间保持稳定。
  const streamToolsRaw = streamRef.current?.turn.tools as unknown[] | undefined
  const streamToolApprovalHost = useMemo(
    () =>
      resolveToolApprovalHost({
        rows,
        streamTools: streamToolsRaw,
        isSending,
      }),
    [rows, streamToolsRaw, isSending],
  )

  const showApprovalPauseHint =
    !toolApprovalUiDisabled && historyToolApprovalHost.kind !== 'none' && !isSending

  /**
   * 流式 live-edge 贴底（行业常见做法：未手动离开底部就跟到底）。
   * 发送后「用户消息置顶」只是短暂锚定；一旦进入流式且用户未上滑，解除锚定并持续贴底，
   * 避免内容往下长、滚动条却停在原地。
   */
  const prepareStreamLiveEdgeFollow = useCallback((): boolean => {
    if (!streamActiveRef.current) return false
    if (userScrolledAwayDuringStreamRef.current) return false
    if (holdHistoryScrollRef.current) return false
    postSendScrollAnchorRef.current = false
    autoFollowRef.current = true
    readingHistoryRef.current = false
    sendScrollLockUntilRef.current = 0
    return true
  }, [])

  /** 流式跟随：维持底部小留白，再滚到可滚最大处 → 最新内容吸附在底部偏上 */
  const applyStreamFollowBottomInset = useCallback(() => {
    if (!bottomSpacerRef.current) return
    if (!streamActiveRef.current) return
    if (postSendScrollAnchorRef.current) return
    bottomSpacerRef.current.style.height = `${STREAM_FOLLOW_BOTTOM_INSET_PX}px`
  }, [])

  /** 流式贴底：单帧合并滚动，同一帧内多次调用只执行一次 rAF */
  const followBottomIfNeeded = useCallback(() => {
    if (holdHistoryScrollRef.current) return
    if (userScrolledAwayDuringStreamRef.current) return
    prepareStreamLiveEdgeFollow()
    if (postSendScrollAnchorRef.current) return
    if (readingHistoryRef.current) return
    if (!autoFollowRef.current) return
    if (Date.now() < sendScrollLockUntilRef.current) return
    if (rafScheduledRef.current) return
    rafScheduledRef.current = requestAnimationFrame(() => {
      rafScheduledRef.current = 0
      if (userScrolledAwayDuringStreamRef.current) return
      prepareStreamLiveEdgeFollow()
      if (!autoFollowRef.current) return
      if (holdHistoryScrollRef.current) return
      if (Date.now() < sendScrollLockUntilRef.current) return
      const el = parentRef.current
      if (!el) return
      lastProgrammaticScrollRef.current = Date.now()
      applyStreamFollowBottomInset()
      el.scrollTop = el.scrollHeight
      lastScrollTopRef.current = el.scrollTop
      lastScrollHeightRef.current = el.scrollHeight
    })
  }, [applyStreamFollowBottomInset, prepareStreamLiveEdgeFollow])

  /** 流式贴底（同步）：无 rAF 延迟，在 useLayoutEffect / ResizeObserver 中直接执行 */
  const syncScrollToBottom = useCallback(() => {
    if (holdHistoryScrollRef.current) return
    if (userScrolledAwayDuringStreamRef.current) return
    prepareStreamLiveEdgeFollow()
    if (postSendScrollAnchorRef.current) return
    if (readingHistoryRef.current) return
    if (!autoFollowRef.current) return
    if (Date.now() < sendScrollLockUntilRef.current) return
    const el = parentRef.current
    if (!el) return
    lastProgrammaticScrollRef.current = Date.now()
    applyStreamFollowBottomInset()
    el.scrollTop = el.scrollHeight
    lastScrollTopRef.current = el.scrollTop
    lastScrollHeightRef.current = el.scrollHeight
  }, [applyStreamFollowBottomInset, prepareStreamLiveEdgeFollow])

  /** 用户发送等场景：无视 autoFollow / 历史阅读锁，强制贴底并恢复跟随 */
  const forceFollowBottom = useCallback(() => {
    autoFollowRef.current = true
    holdHistoryScrollRef.current = false
    readingHistoryRef.current = false
    pendingOlderLoadAnchorRef.current = null
    wasInOlderPrefetchZoneRef.current = false
    postSendScrollAnchorRef.current = false
    if (bottomSpacerRef.current) {
      // 流式中仍留底部吸附余量；空闲时清掉
      bottomSpacerRef.current.style.height = streamActiveRef.current
        ? `${STREAM_FOLLOW_BOTTOM_INSET_PX}px`
        : '0px'
    }
    if (rafScheduledRef.current) {
      cancelAnimationFrame(rafScheduledRef.current)
      rafScheduledRef.current = 0
    }
    rafScheduledRef.current = requestAnimationFrame(() => {
      rafScheduledRef.current = 0
      const el = parentRef.current
      if (!el) return
      lastProgrammaticScrollRef.current = Date.now()
      el.scrollTop = el.scrollHeight
      lastScrollTopRef.current = el.scrollTop
    })
  }, [])
  const forceFollowBottomRef = useRef(forceFollowBottom)
  forceFollowBottomRef.current = forceFollowBottom

  /** 右侧面板开/关：同步 UI 状态（贴底跟随已在 render 阶段解除） */
  useLayoutEffect(() => {
    setShowNewMsgBtn(false)
  }, [layoutKey])

  const syncScrollJumpButtons = useCallback(() => {
    const el = parentRef.current
    if (!el) return
    const { showTop, showBottom } = readScrollJumpVisibility(el, {
      showTop: showScrollTopBtnRef.current,
      showBottom: showScrollBottomBtnRef.current,
    })
    setShowScrollTopBtn((prev) => (prev === showTop ? prev : showTop))
    setShowScrollBottomBtn((prev) => (prev === showBottom ? prev : showBottom))
  }, [])

  const markUserScrollAway = useCallback((opts?: { showNewMsg?: boolean }) => {
    const until = Date.now() + 900
    userScrollAwayIntentUntilRef.current = Math.max(userScrollAwayIntentUntilRef.current, until)
    lastUserScrollAtRef.current = Date.now()
    postSendScrollAnchorRef.current = false
    autoFollowRef.current = false
    userScrolledAwayDuringStreamRef.current = true
    readingHistoryRef.current = true
    cancelPendingScrollRaf(rafScheduledRef)
    if (postStreamPinRafRef.current) {
      cancelAnimationFrame(postStreamPinRafRef.current)
      postStreamPinRafRef.current = 0
    }
    if (opts?.showNewMsg && streamActiveRef.current) {
      setShowNewMsgBtn(true)
    }
  }, [])

  /** 流式结束：开启有硬封顶的贴底窗口（只在 true→false / streamEnded 调用） */
  const beginPostStreamFollowWindow = useCallback(() => {
    const now = Date.now()
    postStreamFollowStartedAtRef.current = now
    postStreamFollowUntilRef.current = now + POST_STREAM_FOLLOW_MS
  }, [])

  /** 对账 reload 等：短暂续期，但不得超过本轮起点 + MAX */
  const bumpPostStreamFollowWindow = useCallback((extraMs = 1500) => {
    const started = postStreamFollowStartedAtRef.current
    if (!started) {
      beginPostStreamFollowWindow()
      return
    }
    const cap = started + POST_STREAM_FOLLOW_MAX_MS
    const next = Math.min(cap, Date.now() + extraMs)
    if (next > postStreamFollowUntilRef.current) {
      postStreamFollowUntilRef.current = next
    }
  }, [beginPostStreamFollowWindow])

  /** 流式结束后轻量贴底：单帧合并，不做虚拟列表多遍 boot（那是抖动主因） */
  const pinPostStreamBottomFrame = useCallback(() => {
    if (holdHistoryScrollRef.current) return
    if (userScrolledAwayDuringStreamRef.current) return
    if (Date.now() <= userScrollAwayIntentUntilRef.current) return
    if (postStreamPinRafRef.current) return
    postStreamPinRafRef.current = requestAnimationFrame(() => {
      postStreamPinRafRef.current = 0
      if (holdHistoryScrollRef.current) return
      if (userScrolledAwayDuringStreamRef.current) return
      if (Date.now() <= userScrollAwayIntentUntilRef.current) return
      if (Date.now() > postStreamFollowUntilRef.current) return
      autoFollowRef.current = true
      readingHistoryRef.current = false
      postSendScrollAnchorRef.current = false
      if (bottomSpacerRef.current) {
        bottomSpacerRef.current.style.height = '0px'
      }
      const el = parentRef.current
      if (!el) return
      lastProgrammaticScrollRef.current = Date.now()
      el.scrollTop = el.scrollHeight
      lastScrollTopRef.current = el.scrollTop
      lastScrollHeightRef.current = el.scrollHeight
    })
  }, [])

  /** 流式结束后合并多次 rows/高度变化触发的贴底，避免上下闪动 */
  const schedulePostStreamScrollToBottom = useCallback(() => {
    // 窗口未开启或已过期则不贴：禁止在 RO/rows 路径里偷偷续开窗口
    if (Date.now() > postStreamFollowUntilRef.current) return
    // 先同步贴一次：收拢动画开始前就锁在底部，减少「闪到中间」
    if (!holdHistoryScrollRef.current && !userScrolledAwayDuringStreamRef.current) {
      autoFollowRef.current = true
      readingHistoryRef.current = false
      postSendScrollAnchorRef.current = false
      if (bottomSpacerRef.current) {
        bottomSpacerRef.current.style.height = '0px'
      }
      const elNow = parentRef.current
      if (elNow) {
        lastProgrammaticScrollRef.current = Date.now()
        elNow.scrollTop = elNow.scrollHeight
        lastScrollTopRef.current = elNow.scrollTop
        lastScrollHeightRef.current = elNow.scrollHeight
      }
    }
    if (postStreamScrollTimerRef.current) {
      window.clearTimeout(postStreamScrollTimerRef.current)
    }
    // 再短延时补贴：等折叠/换行完成后再锁一次（轻量，最多 2 遍）
    postStreamScrollTimerRef.current = window.setTimeout(() => {
      postStreamScrollTimerRef.current = 0
      if (holdHistoryScrollRef.current) return
      if (userScrolledAwayDuringStreamRef.current) return
      if (Date.now() > postStreamFollowUntilRef.current) return
      autoFollowRef.current = true
      readingHistoryRef.current = false
      postSendScrollAnchorRef.current = false
      if (bottomSpacerRef.current) {
        bottomSpacerRef.current.style.height = '0px'
      }
      const el = parentRef.current
      if (!el) return
      lastProgrammaticScrollRef.current = Date.now()
      requestAnimationFrame(() => {
        if (userScrolledAwayDuringStreamRef.current) return
        const node = parentRef.current
        if (!node) return
        bootScrollToBottom(node, { virtualScroll: virtualBootScrollRef.current, maxPasses: 2 })
        lastScrollTopRef.current = node.scrollTop
        syncScrollJumpButtons()
      })
    }, 48)
  }, [syncScrollJumpButtons])

  /** 上滑分页插入后恢复阅读位置（虚拟列表用 stable key 锚定，避免 scrollHeight 估高不准） */
  const applyOlderScrollAnchor = useCallback((pass: 'layout' | 'raf' = 'layout') => {
    const pending = pendingOlderLoadAnchorRef.current
    if (!pending) return
    const el = parentRef.current
    if (!el) {
      pendingOlderLoadAnchorRef.current = null
      holdHistoryScrollRef.current = false
      return
    }

    holdHistoryScrollRef.current = true
    const useVirtual = historyItemsCountRef.current > HISTORY_FLAT_LIST_MAX_ROWS
    const items = historyItemsRef.current
    const sk = String(sessionKeyRef.current || 'default')
    let targetTop = el.scrollTop

    const anchorIndex = pending.anchorStableKey
      ? findHistoryIndexByStableKey(items, sk, pending.anchorStableKey)
      : pending.anchorHistoryIndex

    if (useVirtual && anchorIndex >= 0 && virtualScrollToIndexRef.current) {
      virtualScrollToIndexRef.current(anchorIndex, 'start')
      const content = contentRef.current
      const anchorEl = content?.querySelector(
        `[data-history-index="${anchorIndex}"]`,
      ) as HTMLElement | null
      if (anchorEl) {
        const scrollerTop = el.getBoundingClientRect().top
        const currentOffset = Math.round(anchorEl.getBoundingClientRect().top - scrollerTop)
        const adjust = currentOffset - pending.anchorViewportOffset
        if (Math.abs(adjust) > 1) {
          el.scrollTop = Math.max(0, el.scrollTop + adjust)
        }
      } else {
        const delta = el.scrollHeight - pending.scrollHeight
        el.scrollTop = pending.scrollTop + Math.max(0, delta)
      }
      targetTop = el.scrollTop
    } else {
      const delta = el.scrollHeight - pending.scrollHeight
      targetTop = pending.scrollTop + Math.max(0, delta)
      el.scrollTop = targetTop
    }

    lastScrollTopRef.current = targetTop
    lastProgrammaticScrollRef.current = Date.now()

    if (pass === 'raf') {
      pendingOlderLoadAnchorRef.current = null
      holdHistoryScrollRef.current = false
      olderLoadCooldownUntilRef.current = Date.now() + 700
      syncScrollJumpButtons()
    }
  }, [syncScrollJumpButtons])

  /** 发送消息后：滚到最新用户消息顶部，下方留空间看流式回复（不受「正在看历史」锁影响） */
  const scrollToLatestMessageTop = useCallback((targetIndex: number) => {
    if (targetIndex < 0) return

    holdHistoryScrollRef.current = false
    readingHistoryRef.current = false
    pendingOlderLoadAnchorRef.current = null
    wasInOlderPrefetchZoneRef.current = false
    // 短暂钉住用户消息；流式有内容后 prepareStreamLiveEdgeFollow 会解除并贴底
    autoFollowRef.current = false
    postSendScrollAnchorRef.current = true
    userScrolledAwayDuringStreamRef.current = false
    sendScrollLockUntilRef.current = Date.now() + 280
    setShowNewMsgBtn(false)
    cancelPendingScrollRaf(rafScheduledRef)

    const token = ++sendScrollTokenRef.current

    const applyScroll = (): boolean => {
      if (token !== sendScrollTokenRef.current) return true
      // 已交给流式贴底：停止反复钉用户消息，避免和 stick-to-bottom 抢 scrollTop
      if (
        streamActiveRef.current &&
        autoFollowRef.current &&
        !postSendScrollAnchorRef.current
      ) {
        return true
      }
      const scroller = parentRef.current
      const content = contentRef.current
      if (!scroller || !content) return false

      if (bottomSpacerRef.current) {
        // 短留白：给首帧回复一点落点，随后流式贴底会收成 STREAM_FOLLOW_BOTTOM_INSET
        bottomSpacerRef.current.style.height = `${Math.min(
          96,
          Math.round(scroller.clientHeight * 0.12),
        )}px`
      }

      virtualScrollToIndexRef.current?.(targetIndex, 'start')

      const target = content.querySelector(
        `[data-history-index="${targetIndex}"]`,
      ) as HTMLElement | null
      if (!target) return false

      const scrollerRect = scroller.getBoundingClientRect()
      const itemRect = target.getBoundingClientRect()
      const itemTopInContent =
        itemRect.top - scrollerRect.top + scroller.scrollTop - 12
      lastProgrammaticScrollRef.current = Date.now()
      scroller.scrollTop = Math.max(0, itemTopInContent)
      lastScrollTopRef.current = scroller.scrollTop
      syncScrollJumpButtons()

      const verifyRect = target.getBoundingClientRect()
      const offsetFromTop = verifyRect.top - scrollerRect.top
      return offsetFromTop >= -4 && offsetFromTop <= 28
    }

    let frames = 0
    const settle = () => {
      if (token !== sendScrollTokenRef.current) return
      const ok = applyScroll()
      frames += 1
      if (!ok && frames < 16) {
        requestAnimationFrame(settle)
        return
      }
      if (!ok && bottomSpacerRef.current) {
        bottomSpacerRef.current.style.height = '0px'
      }
    }

    if (!applyScroll()) {
      requestAnimationFrame(settle)
    } else {
      requestAnimationFrame(() => {
        if (token !== sendScrollTokenRef.current) return
        if (!applyScroll()) settle()
      })
    }
  }, [syncScrollJumpButtons])

  /** 点击「↓ 新消息」/ 跳转底部：滚到底部并恢复跟随 */
  const handleScrollToBottom = useCallback(() => {
    postSendScrollAnchorRef.current = false
    autoFollowRef.current = true
    readingHistoryRef.current = false
    userScrolledAwayDuringStreamRef.current = false
    setShowNewMsgBtn(false)
    if (bottomSpacerRef.current) {
      bottomSpacerRef.current.style.height = streamActiveRef.current
        ? `${STREAM_FOLLOW_BOTTOM_INSET_PX}px`
        : '0px'
    }
    const el = parentRef.current
    if (!el) return
    lastProgrammaticScrollRef.current = Date.now()
    bootScrollToBottom(el, { virtualScroll: virtualBootScrollRef.current, maxPasses: 12 })
    lastScrollTopRef.current = el.scrollTop
    syncScrollJumpButtons()
  }, [syncScrollJumpButtons])

  const handleNewMsgClick = handleScrollToBottom

  const handleScrollToTop = useCallback(() => {
    autoFollowRef.current = false
    userScrolledAwayDuringStreamRef.current = streamActiveRef.current
    cancelPendingScrollRaf(rafScheduledRef)
    if (bottomSpacerRef.current) {
      bottomSpacerRef.current.style.height = '0px'
    }
    const el = parentRef.current
    if (!el) return
    lastProgrammaticScrollRef.current = Date.now()
    el.scrollTop = 0
    lastScrollTopRef.current = 0
    syncScrollJumpButtons()
    if (streamActiveRef.current) {
      setShowNewMsgBtn(true)
    }
  }, [syncScrollJumpButtons])

  useEffect(() => {
    installMessageListDebugGlobal()
  }, [])

  /** 须在 boot 的 useLayoutEffect 之前同步重置，避免沿用上一会话的 sessionBootedRef 导致跳过 onViewReady */
  const prevSessionKeyForBootRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    const prevSk = prevSessionKeyForBootRef.current
    prevSessionKeyForBootRef.current = String(sessionKey || '')
    // 仅「会话真的切换」时把当前 rows 标成 stale；首次挂载 / 同 key 重挂（路由切回）不得跳过 boot，
    // 否则 viewReady 永假 → 永久 react-vlist-scroller--booting（白屏但 DOM 有内容）。
    const isSessionSwitch = prevSk != null && prevSk !== String(sessionKey || '')
    autoFollowRef.current = true
    lastScrollTopRef.current = 0
    sessionBootedRef.current = false
    bootTokenRef.current += 1
    staleRowsAtSwitchRef.current = isSessionSwitch ? rows : null
    // 对齐当前会话流式状态，避免切到流式会话时 sendStarted 误判为「刚发送」
    prevIsSendingRef.current = streamActiveRef.current
    prevIsSendingPropRef.current = isSending
    lastSessionKeyForSendRef.current = String(sessionKey || '')
    prevHistoryLenRef.current = 0
    prevHistoryLoadingRef.current = historyLoading
    prevRowsLenRef.current = 0
    // 重置 streamActive 跳变追踪，避免从流式中的会话切到新会话时误设 postStreamFollowUntilRef
    prevStreamActiveRef.current = false
    // 清除 post-stream 贴底窗口，避免新会话 boot 时被 historyLoading effect 误跳过
    postStreamFollowUntilRef.current = 0
    postStreamFollowStartedAtRef.current = 0
    if (postStreamScrollTimerRef.current) {
      window.clearTimeout(postStreamScrollTimerRef.current)
      postStreamScrollTimerRef.current = 0
    }
    if (postStreamPinRafRef.current) {
      cancelAnimationFrame(postStreamPinRafRef.current)
      postStreamPinRafRef.current = 0
    }
    sendScrollLockUntilRef.current = 0
    sendScrollTokenRef.current += 1
    postSendScrollAnchorRef.current = false
    if (bottomSpacerRef.current) {
      bottomSpacerRef.current.style.height = '0px'
    }
    cancelPendingScrollRaf(rafScheduledRef)
    userScrolledAwayDuringStreamRef.current = false
    userScrollAwayIntentUntilRef.current = 0
    lastUserScrollAtRef.current = 0
    holdHistoryScrollRef.current = false
    readingHistoryRef.current = false
    pendingOlderLoadAnchorRef.current = null
    prevLastHistoryTailKeyRef.current = ''
    wasInOlderPrefetchZoneRef.current = false
    olderLoadCooldownUntilRef.current = 0
    setViewReady(false)
    setShowNewMsgBtn(false)
    setShowScrollTopBtn(false)
    setShowScrollBottomBtn(false)
  }, [sessionKey])

  /**
   * streamActive true→false 时立即设置 post-stream 贴底窗口。
   * 不依赖下方 streamEnded effect（后者可能被 historyLoading guard 拦截导致 postStreamFollowUntilRef 漏设）。
   * 这是修复「流式结束后 reloadHistoryFromDb 触发 historyLoading→闪烁+滚动停在中间」的关键。
   */
  useLayoutEffect(() => {
    if (prevStreamActiveRef.current && !streamActive) {
      beginPostStreamFollowWindow()
      // 取消流式贴底 rAF，避免宽限期结束后仍写入 36px spacer 与 0 抢高度
      cancelPendingScrollRaf(rafScheduledRef)
      if (bottomSpacerRef.current) {
        bottomSpacerRef.current.style.height = '0px'
      }
    }
    prevStreamActiveRef.current = streamActive
  }, [streamActive, beginPostStreamFollowWindow])

  /** 历史 API 重载：须重新 boot，不能沿用上次 sessionBootedRef（流式进行中跳过，避免整页闪白） */
  useLayoutEffect(() => {
    const wasLoading = prevHistoryLoadingRef.current
    prevHistoryLoadingRef.current = historyLoading
    if (historyLoading && !wasLoading && !streamActiveRef.current) {
      // 流式结束后 DB 对账触发的 reload：保持 viewReady，避免闪烁和滚动位置丢失
      if (Date.now() < postStreamFollowUntilRef.current) {
        // 短暂续期（有硬封顶），覆盖后续可能的多次 reload
        bumpPostStreamFollowWindow(2000)
        return
      }
      sessionBootedRef.current = false
      bootTokenRef.current += 1
      setViewReady(false)
    }
  }, [historyLoading, sessionKey, bumpPostStreamFollowWindow])

  /** 空会话先 boot 后 rows 到达：须对真实历史再贴底一次（流式进行中跳过） */
  useLayoutEffect(() => {
    const prevLen = prevRowsLenRef.current
    const len = rows.length
    prevRowsLenRef.current = len
    if (historyLoading || len === 0 || prevLen !== 0 || streamActiveRef.current) return
    if (sessionBootedRef.current && viewReady) {
      sessionBootedRef.current = false
      bootTokenRef.current += 1
      setViewReady(false)
    }
  }, [rows.length, historyLoading, sessionKey, viewReady])

  /** 历史 API 就绪后：隐藏挂载 → 多帧贴底直到稳定 → 再显示（仅会话切换时） */
  useLayoutEffect(() => {
    if (historyLoading) return

    // ★ 会话切换后子组件 layout effect 先于父组件 useThreadHistory 更新 rows 执行；
    // 此时 rows 仍是旧会话引用，跳过 boot 等父级 setRows 后下一帧再 boot
    if (staleRowsAtSwitchRef.current && rows === staleRowsAtSwitchRef.current) return

    if (instantOpenRef.current && hasContent && !streamActiveRef.current) {
      const token = ++bootTokenRef.current
      const useVirtual = historyItemsCountRef.current > HISTORY_FLAT_LIST_MAX_ROWS
      const revealInstantOpen = () => {
        if (token !== bootTokenRef.current) return
        staleRowsAtSwitchRef.current = null
        sessionBootedRef.current = true
        autoFollowRef.current = true
        setViewReady(true)
        onViewReadyRef.current?.()
        syncScrollJumpButtons()
      }
      const scrollBottomOnce = () => {
        const node = parentRef.current
        if (!node) return
        virtualBootScrollRef.current?.()
        node.scrollTop = node.scrollHeight
        lastScrollTopRef.current = node.scrollTop
      }

      if (useVirtual) {
        // 缓存打开 + 虚拟列表：在 booting 隐藏态下一帧贴底再揭开，避免可见时多帧估高抖动
        scrollBottomOnce()
        requestAnimationFrame(() => {
          scrollBottomOnce()
          revealInstantOpen()
        })
        return
      }

      scrollBottomOnce()
      revealInstantOpen()
      return
    }

    if (!hasContent) {
      staleRowsAtSwitchRef.current = null
      sessionBootedRef.current = true
      setViewReady(true)
      onViewReadyRef.current?.()
      return
    }

    if (sessionBootedRef.current) return

    const finishBoot = (bootToken: number) => {
      const el = parentRef.current
      if (el) {
        bootScrollToBottom(el, { virtualScroll: virtualBootScrollRef.current, maxPasses: 12 })
        lastScrollTopRef.current = el.scrollTop
      }
      staleRowsAtSwitchRef.current = null
      sessionBootedRef.current = true
      autoFollowRef.current = true
      // 先贴底再揭开：否则估高未完成时会先闪顶部/中间，再跳到底（个别长气泡会话更明显）
      requestAnimationFrame(() => {
        const node = parentRef.current
        if (!node || bootToken !== bootTokenRef.current) return
        bootScrollToBottom(node, { virtualScroll: virtualBootScrollRef.current, maxPasses: 8 })
        lastScrollTopRef.current = node.scrollTop
        requestAnimationFrame(() => {
          if (bootToken !== bootTokenRef.current) return
          const n2 = parentRef.current
          if (n2) {
            bootScrollToBottom(n2, { virtualScroll: virtualBootScrollRef.current, maxPasses: 8 })
            lastScrollTopRef.current = n2.scrollTop
          }
          setViewReady(true)
          onViewReadyRef.current?.()
          syncScrollJumpButtons()
        })
      })
    }

    const runBoot = () => {
      const el = parentRef.current
      if (!el) return false

      const token = ++bootTokenRef.current
      setViewReady(false)
      autoFollowRef.current = true
      if (bottomSpacerRef.current) {
        bottomSpacerRef.current.style.height = '0px'
      }

      let frame = 0
      const settle = () => {
        if (token !== bootTokenRef.current) return
        const node = parentRef.current
        if (!node) return
        bootScrollToBottom(node, { virtualScroll: virtualBootScrollRef.current, maxPasses: 12 })
        lastScrollTopRef.current = node.scrollTop
        frame += 1
        const pinned = isPinnedToBottom(node, 12)
        if (pinned || frame >= 16) {
          finishBoot(token)
          return
        }
        requestAnimationFrame(settle)
      }

      bootScrollToBottom(el, { virtualScroll: virtualBootScrollRef.current, maxPasses: 12 })
      requestAnimationFrame(settle)
      return true
    }

    if (!runBoot()) {
      requestAnimationFrame(() => {
        if (sessionBootedRef.current) return
        if (!runBoot()) finishBoot(++bootTokenRef.current)
      })
    }
  }, [sessionKey, historyLoading, hasContent, rows.length, rows, syncScrollJumpButtons, instantOpen])

  /** 兜底：有内容却一直 !viewReady（例如路由切回 remount 后 boot 被跳过）→ 强制揭开，避免永久白屏 */
  useEffect(() => {
    if (viewReady || historyLoading || !hasContent) return
    let cancelled = false
    const t = window.setTimeout(() => {
      if (cancelled) return
      sessionBootedRef.current = true
      staleRowsAtSwitchRef.current = null
      setViewReady(true)
      onViewReadyRef.current?.()
      const el = parentRef.current
      if (el) {
        bootScrollToBottom(el, { virtualScroll: virtualBootScrollRef.current, maxPasses: 8 })
        lastScrollTopRef.current = el.scrollTop
      }
    }, 400)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [viewReady, historyLoading, hasContent, sessionKey])

  /** 上滑关闭跟随，滑回底部再打开；流式时用户不在底部显示「新消息」按钮（仅就绪后监听） */
  useEffect(() => {
    const el = parentRef.current
    if (!el || !hasContent || !viewReady) return

    const onScroll = () => {
      const st = el.scrollTop
      const sh = el.scrollHeight
      const distBottom = sh - (st + el.clientHeight)
      const prevSh = lastScrollHeightRef.current || sh
      const heightDelta = sh - prevSh
      lastScrollHeightRef.current = sh
      const { showTop, showBottom } = readScrollJumpVisibility(el, {
        showTop: showScrollTopBtnRef.current,
        showBottom: showScrollBottomBtnRef.current,
      })
      setShowScrollTopBtn((prev) => (prev === showTop ? prev : showTop))
      setShowScrollBottomBtn((prev) => (prev === showBottom ? prev : showBottom))
      const inPrefetchZone = shouldPrefetchOlderHistory(el)
      if (!inPrefetchZone) {
        wasInOlderPrefetchZoneRef.current = false
      }
      if (
        inPrefetchZone &&
        !wasInOlderPrefetchZoneRef.current &&
        Date.now() >= olderLoadCooldownUntilRef.current &&
        historyHasMoreRef.current &&
        !historyLoadingOlderRef.current &&
        onLoadOlderRef.current &&
        !pendingOlderLoadAnchorRef.current
      ) {
        wasInOlderPrefetchZoneRef.current = true
        const anchor = findAnchorHistoryIndexInViewport(contentRef.current, el)
        const anchorItem = historyItemsRef.current[anchor.index]
        const sk = String(sessionKeyRef.current || 'default')
        const anchorStableKey = anchorItem
          ? historyItemStableKey(sk, anchorItem.row, anchorItem.i)
          : ''
        markUserScrollAway()
        pendingOlderLoadAnchorRef.current = {
          scrollHeight: el.scrollHeight,
          scrollTop: st,
          historyItemsLenBefore: historyItemsCountRef.current,
          anchorHistoryIndex: anchor.index,
          anchorViewportOffset: anchor.viewportOffset,
          anchorStableKey,
          attempts: 0,
        }
        void Promise.resolve(onLoadOlderRef.current()).catch(() => {
          pendingOlderLoadAnchorRef.current = null
          wasInOlderPrefetchZoneRef.current = false
        })
      }
      if (Date.now() - lastProgrammaticScrollRef.current < 120) {
        lastScrollTopRef.current = st
        return
      }
      const prev = lastScrollTopRef.current
      const preserveSendAnchor = shouldPreserveSendScrollAnchor(
        postSendScrollAnchorRef,
        sendScrollLockUntilRef,
      )
      if (st < prev - 1 && distBottom > 48) {
        const settlingPostStream = Date.now() <= postStreamFollowUntilRef.current
        const userScrollAwayIntent =
          readingHistoryRef.current ||
          userScrolledAwayDuringStreamRef.current ||
          Date.now() <= userScrollAwayIntentUntilRef.current
        if (
          isFoldInducedScrollAway({
            heightDelta,
            scrollTopDelta: st - prev,
            distBottom,
            streamActive: streamActiveRef.current,
            settlingPostStream,
            userScrollAwayIntent,
          })
        ) {
          // 思考/Exploring 折叠（含流式刚结束收拢）：保持贴底，勿当成手动离开底部
          autoFollowRef.current = true
          userScrolledAwayDuringStreamRef.current = false
          readingHistoryRef.current = false
          lastProgrammaticScrollRef.current = Date.now()
          if (bottomSpacerRef.current && !streamActiveRef.current) {
            bottomSpacerRef.current.style.height = '0px'
          }
          el.scrollTop = el.scrollHeight
          lastScrollTopRef.current = el.scrollTop
          lastScrollHeightRef.current = el.scrollHeight
          setShowNewMsgBtn(false)
          return
        }
        markUserScrollAway({ showNewMsg: true })
      } else if (st !== prev) {
        lastUserScrollAtRef.current = Date.now()
      }
      if (distBottom <= 48 && !preserveSendAnchor && !holdHistoryScrollRef.current) {
        autoFollowRef.current = true
        readingHistoryRef.current = false
        userScrolledAwayDuringStreamRef.current = false
        userScrollAwayIntentUntilRef.current = 0
        setShowNewMsgBtn(false)
      }
      lastScrollTopRef.current = st
    }
    const onWheel = (e: WheelEvent) => {
      const distBottom = el.scrollHeight - (el.scrollTop + el.clientHeight)
      const preserveSendAnchor = shouldPreserveSendScrollAnchor(
        postSendScrollAnchorRef,
        sendScrollLockUntilRef,
      )
      if (e.deltaY < 0 && distBottom > 48) {
        markUserScrollAway({ showNewMsg: true })
        return
      }
      if (e.deltaY > 0 && distBottom - e.deltaY <= 48 && !preserveSendAnchor && !holdHistoryScrollRef.current) {
        autoFollowRef.current = true
        readingHistoryRef.current = false
        userScrolledAwayDuringStreamRef.current = false
        userScrollAwayIntentUntilRef.current = 0
        setShowNewMsgBtn(false)
      }
    }

    lastScrollTopRef.current = el.scrollTop
    lastScrollHeightRef.current = el.scrollHeight
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
    }
  }, [sessionKey, hasContent, viewReady, markUserScrollAway])

  /** 上拉插入历史后恢复视口锚点 */
  useLayoutEffect(() => {
    const pending = pendingOlderLoadAnchorRef.current
    if (!pending || historyLoadingOlder) return
    if (historyItemsCountRef.current <= pending.historyItemsLenBefore) {
      pendingOlderLoadAnchorRef.current = null
      holdHistoryScrollRef.current = false
      olderLoadCooldownUntilRef.current = Date.now() + 700
      wasInOlderPrefetchZoneRef.current = false
      return
    }
    applyOlderScrollAnchor('layout')
    requestAnimationFrame(() => applyOlderScrollAnchor('raf'))
  }, [rows.length, historyLoadingOlder, applyOlderScrollAnchor])

  /** 流式输出时：未手动离开则 stick-to-bottom；发送锚定只短暂存在 */
  useLayoutEffect(() => {
    if (!viewReady || !sessionBootedRef.current || !streamActive) return
    if (userScrolledAwayDuringStreamRef.current) {
      const el = parentRef.current
      if (!el) return
      const distBottom = el.scrollHeight - (el.scrollTop + el.clientHeight)
      setShowNewMsgBtn(distBottom > 48)
      return
    }
    // 有流式内容或仅在执行中：解除发送锚定，持续贴底
    prepareStreamLiveEdgeFollow()
    syncScrollToBottom()
    setShowNewMsgBtn(false)
  }, [
    streamDisplayTick,
    liveStreamPaintEpoch,
    streamRow,
    viewReady,
    streamActive,
    syncScrollToBottom,
    prepareStreamLiveEdgeFollow,
  ])

  /**
   * 流式区高度变化（推理块、Exploring 折叠、Markdown 换行、paintPlainStreamDom 写入）时同步贴底。
   * ★ 关键：deps 不能含 streamRow / historyItems.length / streamActive —— 这些在每个流式 tick 都变，
   * 会导致 RO 断开重连，恰好漏掉 paintPlainStreamDom 写入新文本后的高度变化，视口卡在旧位置。
   * RO 观察 contentRef.current（稳定元素），只需在 viewReady 时创建一次即可。
   */
  useEffect(() => {
    const content = contentRef.current
    if (!content || !viewReady || !sessionBootedRef.current) return

    const ro = new ResizeObserver(() => {
      if (holdHistoryScrollRef.current) return
      const settlingPostStream = Date.now() <= postStreamFollowUntilRef.current
      if (settlingPostStream) {
        // 收拢缩高：单帧合并轻量贴底。勿再 schedule 多遍 bootScroll，否则会与 RO 形成上下打架。
        pinPostStreamBottomFrame()
        return
      }
      // 用户明确上滑离开 live edge：不抢滚动
      if (userScrolledAwayDuringStreamRef.current) return
      if (streamActiveRef.current) {
        prepareStreamLiveEdgeFollow()
      } else if (readingHistoryRef.current) {
        return
      }
      if (!autoFollowRef.current) return
      syncScrollToBottom()
    })
    ro.observe(content)
    return () => {
      ro.disconnect()
    }
  }, [viewReady, syncScrollToBottom, pinPostStreamBottomFrame, prepareStreamLiveEdgeFollow])

  useEffect(() => {
    if (!viewReady || !hasContent) return
    syncScrollJumpButtons()
  }, [viewReady, hasContent, historyItems.length, syncScrollJumpButtons])

  /** 用户发送 / 新增用户消息：滚动到最后一条消息出现在视口顶部，下方留空间看流式回复 */
  useLayoutEffect(() => {
    if (!viewReady || !sessionBootedRef.current || historyLoading || !hasContent) return

    const wasActive = prevIsSendingRef.current
    prevIsSendingRef.current = streamActive

    const prevLen = prevHistoryLenRef.current
    const len = historyItems.length
    const tailKey =
      len > 0
        ? historyItemStableKey(
            String(sessionKey || ''),
            historyItems[len - 1].row,
            historyItems[len - 1].i,
          )
        : ''
    const prependedOlder =
      len > prevLen && tailKey !== '' && tailKey === prevLastHistoryTailKeyRef.current
    prevLastHistoryTailKeyRef.current = tailKey
    prevHistoryLenRef.current = len

    const streamEnded = wasActive && !streamActive
    if (streamEnded) {
      // 结束后思考/工具会收拢缩高：先清误判锁，立刻贴底，再进入短窗口持续跟
      userScrolledAwayDuringStreamRef.current = false
      readingHistoryRef.current = false
      autoFollowRef.current = true
      postSendScrollAnchorRef.current = false
      cancelPendingScrollRaf(rafScheduledRef)
      beginPostStreamFollowWindow()
      if (bottomSpacerRef.current) {
        bottomSpacerRef.current.style.height = '0px'
      }
      const el = parentRef.current
      if (el) {
        lastProgrammaticScrollRef.current = Date.now()
        el.scrollTop = el.scrollHeight
        lastScrollTopRef.current = el.scrollTop
        lastScrollHeightRef.current = el.scrollHeight
      }
      schedulePostStreamScrollToBottom()
      return
    }

    const trailingUser = lastHistoryRole === 'user'
    const sendStarted = streamActive && !wasActive && trailingUser
    const userAppended =
      len > prevLen &&
      historyItems[len - 1]?.row.role === 'user'

    if (sendStarted || userAppended) {
      if (tailKey && tailKey === lastSendScrollTailRef.current) return
      lastSendScrollTailRef.current = tailKey
      // 发送后锚定最新用户消息（即使刚才在翻历史，也不能停在旧视口）
      scrollToLatestMessageTop(len - 1)
      return
    }

    if (len > prevLen && !prependedOlder && !readingHistoryRef.current) {
      followBottomIfNeeded()
    }
  }, [
    streamActive,
    lastHistoryRole,
    historyItems.length,
    historyItems,
    sessionKey,
    historyLoading,
    hasContent,
    viewReady,
    followBottomIfNeeded,
    forceFollowBottom,
    schedulePostStreamScrollToBottom,
    beginPostStreamFollowWindow,
    scrollToLatestMessageTop,
    syncScrollToBottom,
  ])

  /**
   * rows 替换后保持贴底（仅流式结束后的 DB 对账窗口）：
   * 普通 reopen / 缓存 soft 更新不再 forceFollow，避免长会话打开时二次贴底抖动。
   */
  useLayoutEffect(() => {
    if (!viewReady || !sessionBootedRef.current || historyLoading || !hasContent) return
    if (holdHistoryScrollRef.current) return
    if (readingHistoryRef.current) return
    if (userScrolledAwayDuringStreamRef.current) return
    if (!autoFollowRef.current) return
    const inPostStream = Date.now() <= postStreamFollowUntilRef.current
    if (!inPostStream) return
    // 轻量单帧贴底即可；勿每次 rows 引用变化都跑 bootScroll 多遍
    pinPostStreamBottomFrame()
  }, [rows, viewReady, historyLoading, hasContent, pinPostStreamBottomFrame])

  if (!hasContent) {
    if (historyLoading) {
      return (
        <div className="react-vlist-scroller chat-messages-inner react-chat-history-inner-quiet">
          <div className="react-chat-skeleton-list" aria-hidden>
            <div className="react-chat-skeleton-item react-chat-skeleton-item--user" />
            <div className="react-chat-skeleton-item react-chat-skeleton-item--ai" />
            <div className="react-chat-skeleton-item react-chat-skeleton-item--user" />
          </div>
        </div>
      )
    }
    if (!showHomeDashboard) {
      return (
        <div className="react-vlist-scroller chat-messages-inner react-chat-history-inner-quiet">
          <div className="react-chat-empty-thread" role="status">
            暂无消息，可在下方继续输入
          </div>
        </div>
      )
    }
    return (
      <div className="react-vlist-scroller chat-messages-inner chat-messages-inner--home">
        <EvoFlowHomeDashboard onPrompt={onQuickPrompt} />
      </div>
    )
  }

  const awaitingBoot = !historyLoading && hasContent && !viewReady
  const bootingClass = awaitingBoot ? ' react-vlist-scroller--booting' : ''
  const streamingClass = streamActive ? ' react-vlist-scroller--streaming' : ''

  const showScrollJumpBtns =
    viewReady && hasContent && (showScrollTopBtn || showScrollBottomBtn)

  return (
    <div className="react-vlist-scroll-wrap">
      {showScrollJumpBtns ? (
        <div className="react-chat-scroll-jump-group" aria-label="快速滚动">
          {showScrollTopBtn ? (
            <button
              type="button"
              className="react-chat-scroll-jump-btn"
              onClick={handleScrollToTop}
              title="到顶部"
              aria-label="滚动到顶部"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          ) : null}
          {showScrollBottomBtn ? (
            <button
              type="button"
              className="react-chat-scroll-jump-btn"
              onClick={handleScrollToBottom}
              title="到底部"
              aria-label="滚动到底部"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 5v14M19 12l-7 7-7-7" />
              </svg>
            </button>
          ) : null}
        </div>
      ) : null}
      <div
        ref={parentRef}
        className={`react-vlist-scroller chat-messages-inner${bootingClass}${streamingClass}`}
        aria-busy={awaitingBoot || undefined}
      >
      {historyLoadingOlder ? (
        <div className="react-chat-history-older-loading" role="status" aria-live="polite">
          加载更早消息…
        </div>
      ) : null}
      <div
        ref={contentRef}
        className={`react-vlist-content${
          historyItems.length > HISTORY_FLAT_LIST_MAX_ROWS ? ' react-vlist-content--virtual' : ''
        }`}
      >
        <HistoryBody
          historyItems={historyItems}
          parentRef={parentRef}
          autoFollowRef={autoFollowRef}
          holdHistoryScrollRef={holdHistoryScrollRef}
          readingHistoryRef={readingHistoryRef}
          lastUserScrollAtRef={lastUserScrollAtRef}
          virtualBootScrollRef={virtualBootScrollRef}
          virtualScrollToIndexRef={virtualScrollToIndexRef}
          virtualScrollToOffsetRef={virtualScrollToOffsetRef}
          sessionKey={sessionKey}
          historyLoading={historyLoading}
          toolApprovalHost={historyToolApprovalHost}
          streamToolApprovalHost={streamToolApprovalHost}
          streamContinuedRowIndex={streamContinuedRowIndex}
          isSending={streamActive}
          lastAssistantRowIndex={lastAssistantRowIndex}
          liveTurnAssistantRunId={liveTurnAssistantRunId}
          liveTurnTimingActive={!!liveTurnTimingActive}
          executionToolTiming={executionToolTiming}
          hostedExecutionTiming={hostedExecutionTiming}
          hostedGoalActive={hostedGoalActive}
          toolApprovalUiDisabled={toolApprovalUiDisabled}
          suppressPlanExecPromptNoise={suppressPlanExecPromptNoise}
          hideSubagentInnerTools={hideSubagentInnerTools}
          onOpenFile={onOpenFile}
          onOpenKnowledgeMap={onOpenKnowledgeMap}
          onToolApproval={onToolApproval}
          toolApprovalBusy={toolApprovalBusy}
          showApprovalPauseHint={showApprovalPauseHint}
          liveActivityDockLabel={liveActivityDockLabel}
          liveTurnElapsedSec={liveTurnElapsedSec}
          onCopy={onCopy}
          onRetry={onRetry}
          onEdit={onEdit}
          onFork={onFork}
          assistantAgent={assistantAgent}
          assistantAgentLabel={assistantAgentLabel}
        />
        {showSeparateStreamPin && streamRow ? (
          <div className="react-vlist-item react-vlist-item--turn react-vlist-stream-pin">
            <MemoMessageRow
              row={streamRow}
              isStreaming
              liveActivityDockLabel={liveActivityDockLabel}
              liveTurnElapsedSec={liveTurnElapsedSec}
              showToolTiming={false}
              onOpenFile={onOpenFile}
              onOpenKnowledgeMap={onOpenKnowledgeMap}
              onToolApproval={onToolApproval}
              toolApprovalBusy={toolApprovalBusy}
              interactiveToolApproval={
                toolApprovalUiDisabled
                  ? false
                  : toolApprovalInteractiveForItem(streamToolApprovalHost, {
                      kind: 'stream',
                      row: streamRow,
                      i: -1,
                    }, { continuedStreamRowIndex: streamContinuedRowIndex })
              }
              suppressPlanExecPromptNoise={suppressPlanExecPromptNoise}
              hideSubagentInnerTools={hideSubagentInnerTools}
              sessionKey={sessionKey}
              assistantAgent={assistantAgent}
              assistantAgentLabel={assistantAgentLabel}
            />
          </div>
        ) : null}
        {recentArtifacts.length > 0 ? (
          <div className="react-chat-inline-artifacts" role="list" aria-label="本轮产物">
            <div className="react-chat-inline-artifacts-title">
              <Package className="react-chat-inline-artifacts-title-icon" aria-hidden />
              本轮产物
            </div>
            <ul className="react-chat-inline-artifacts-list">
              {recentArtifacts.map((it) => {
                const label = chatArtifactDisplayLabel(it)
                return (
                  <li key={it.id}>
                    <button
                      type="button"
                      className="react-chat-inline-artifact-chip"
                      title={it.path || it.url || label}
                      onClick={() => onOpenArtifact?.(it)}
                    >
                      <span className="react-chat-inline-artifact-icon" aria-hidden>
                        {it.type === 'image' ? (
                          <Image size={14} />
                        ) : it.type === 'video' ? (
                          <Video size={14} />
                        ) : it.type === 'url' ? (
                          <Link size={14} />
                        ) : it.type === 'html' ? (
                          <Globe size={14} />
                        ) : it.type === 'text' ? (
                          <FileText size={14} />
                        ) : it.type === 'platform' ? (
                          <Database size={14} />
                        ) : (
                          <FileCode2 size={14} />
                        )}
                      </span>
                      <span className="react-chat-inline-artifact-label">{label}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        ) : null}
        <div ref={bottomSpacerRef} style={{ height: '0px', flexShrink: 0 }} />
      </div>
      {showNewMsgBtn ? (
        <button
          type="button"
          className="react-chat-new-msg-btn"
          onClick={handleNewMsgClick}
          aria-label="滚动到最新消息"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M19 12l-7 7-7-7" />
          </svg>
          新消息
        </button>
      ) : null}
      </div>
    </div>
  )
})
