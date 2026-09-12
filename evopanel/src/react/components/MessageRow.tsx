import { useRef, useState, useLayoutEffect, useCallback } from 'react'
import { useLiveStreamOverlayRow } from '../hooks/useLiveStreamOverlayRow.js'
import { MarkdownHtml } from './MarkdownHtml.js'
import { AnimatedTokenInline } from './AnimatedTokenDisplay.js'
import { MessageMedia } from './MessageMedia.js'
import AgentAvatar from './AgentAvatar.js'
import type { AgentAvatarAgent } from '../lib/agent-avatar.js'
import {
  flattenStreamDisplayText,
  flattenStreamDisplayTextRaw,
  isToolRunning,
  resolveDisplayReasoningSegments,
  turnHasVisibleChatTools,
  filterToolsForChatPanelDisplay,
  filterDisplaySegmentsForChatPanel,
} from '../../lib/chat-normalize.js'
import {
  buildAssistantBubbleDisplayPlan,
  type AssistantBubblePlanInput,
  type AssistantBubbleDisplayPlan,
} from '../lib/message-row-display-plan.js'

/**
 * AssistantBody 派生链缓存键值对。
 * 针对已持久化的 row（非流式），其衍生数据（plan, tools, segments 等）是纯函数且不变的。
 * 使用 WeakMap 确保不阻碍 GC，同时避免重复计算导致的长对话卡顿。
 */
type AssistantBodyCacheEntry = {
  suppressPlanExecPromptNoise: boolean
  interactiveToolApproval: boolean
  /** O(1) 形状签名：React 正常不可变更新会换 row 引用（缓存自动失效），此字段防原地突变的脏读 */
  signature: string
  bundle: AssistantBodyDerivedBundle
}

type AssistantBodyDerivedBundle = {
  tools: unknown[]
  displaySegments: MessageSegment[]
  rawText: string
  text: string
  reasoning: string
  reasoningSegments: string[]
  askBubbleHint: string | null
  plan: AssistantBubbleDisplayPlan
}

const assistantBodyCache = new WeakMap<DisplayRow, AssistantBodyCacheEntry>()

/**
 * 纯函数：计算 AssistantBody 所需的所有派生数据。
 * 注意：此函数必须保持纯净，仅依赖入参。
 */
function computeAssistantBodyBundle(
  row: DisplayRow,
  isStreaming: boolean,
  suppressPlanExecPromptNoise: boolean,
  interactiveToolApproval: boolean,
  liveActivityDockLabel: string | undefined,
): AssistantBodyDerivedBundle {
  const rawTools = row.tools || []
  const rawSegments = row.segments as MessageSegment[] | undefined
  
  // 1. 工具与片段预处理
  const workerPrepared = prepareWorkerToolsForDisplayRow(rawTools, rawSegments)
  const panelToolsSource = omitWorkerParentWhenExpanded(workerPrepared.tools)
  const tools = filterToolsForChatPanelDisplay(panelToolsSource)
  const segments = filterDisplaySegmentsForChatPanel(workerPrepared.segments, panelToolsSource)
  
  // 2. 文本与推理处理
  const rawText = row.text || ''
  const hasToolsInTurnEarly = turnHasVisibleChatTools(tools, segments)
  const text = hasToolsInTurnEarly
    ? visibleExploringInnerText(rawText, suppressPlanExecPromptNoise, isStreaming, tools)
    : visibleAssistantText(rawText, tools, suppressPlanExecPromptNoise, isStreaming)
  
  const reasoning = typeof row.reasoningPreview === 'string' ? row.reasoningPreview : ''
  const reasoningSegments = resolveDisplayReasoningSegments({
    ...row,
    segments,
    reasoningPreview: reasoning,
  })

  // 3. 辅助字段
  const askBubbleHint = extractAskClarificationBubbleHint(tools)
  const textTrimmed = String(text || '').trim()
  
  // 4. 状态标签（流式与非流式逻辑不同）
  const systemActivityLabel = String(
    isStreaming && liveActivityDockLabel !== undefined
      ? liveActivityDockLabel
      : row.systemActivity || '',
  ).trim()
  
  const streamThinkingLabel =
    systemActivityLabel ||
    (isStreaming && !textTrimmed && hasInFlightAskClarificationTools(tools) ? '询问中' : '正在思考')

  // 5. 时间线与 Plan 构建
  const displaySegments = buildDisplayTimeline(segments as MessageSegment[], tools, {
    rawText,
    reasoningPreview: reasoning,
  })
  
  const streamPlainLiveRaw = flattenStreamDisplayTextRaw(segments, rawText)
  const hasReasoningStreamUiEarly =
    // @ts-ignore
    (segments || []).some((s) => s.kind === 'reasoning') ||
    reasoningSegments.length > 0 ||
    !!String(reasoning || '').trim()
    
  const plainShowThinkingCursor =
    !!isStreaming && !streamPlainLiveRaw && !hasReasoningStreamUiEarly && !systemActivityLabel

  const planInput: AssistantBubblePlanInput = {
    row,
    displaySegments,
    tools,
    rawText,
    text,
    textTrimmed: !!textTrimmed,
    reasoningPreview: reasoning,
    reasoningSegments,
    isStreaming: !!isStreaming,
    interactiveToolApproval,
    suppressPlanExecPromptNoise,
    hasToolsInTurnEarly,
    systemActivityLabel,
    streamThinkingLabel,
    legacyHasTools: tools.length > 0,
    legacyShowBody: !!textTrimmed || !!isStreaming || !!askBubbleHint,
    plainBodyRaw: streamPlainLiveRaw,
    plainShowThinkingCursor,
    aguiTurn: row.aguiTurn ?? null,
  }

  const plan = buildAssistantBubbleDisplayPlan(planInput)

  return {
    tools,
    displaySegments,
    rawText,
    text,
    reasoning,
    reasoningSegments,
    askBubbleHint,
    plan,
  }
}
import { buildDisplayTimeline } from '../lib/message-row-timeline.js'
import { omitWorkerParentWhenExpanded, prepareWorkerToolsForDisplayRow } from '../worker-file-tools.js'
import { visibleAssistantText, visibleExploringInnerText } from '../lib/message-row-visible-text.js'
import { extractEvoAssetCitations } from '../lib/evo-asset-citation.js'
import { AssetCitationChips } from './AssetCitationChips.js'
import {
  extractAskClarificationBubbleHint,
  formatUserClarificationBubbleText,
} from '../lib/clarify-chat-display.js'
import { formatUserToolApprovalBubbleText, isHiddenToolApprovalUserMessage } from '../../lib/tool-approval.js'
import { sanitizeGoalClosureBody } from '../lib/goalClosureLocal.js'
import { resolveUserMessageSkillDisplay } from '../lib/preferred-skill-display.js'
import type { DisplayRow, MessageSegment, SubagentStreamTask, TerminalStreamTask } from '../chat-types.js'
import { AssistantBubbleSlotView } from './AssistantBubbleSlotView.js'
import { HoverBubble } from './HoverBubble.js'
import { logStreamCompareUiDisplay, logStreamCompareUiChunks, logStreamCompareUiStreamTools } from '../lib/stream-compare-file-log.js'
import { logStreamSourceConsoleIfChanged } from '../stream-console-mirror.js'
import { resolveTurnDurationLabel } from '../lib/turn-timing.js'

/** ask 工具在气泡内被隐藏；需识别「仍在进行」以显示「询问中…」，不能只依赖 isToolRunning（首帧常无 status） */
function hasInFlightAskClarificationTools(tools: unknown[]) {
  if (!Array.isArray(tools) || !tools.length) return false
  for (const x of tools) {
    const r = x as Record<string, unknown>
    const n = String(r.name || r.tool_name || '').toLowerCase()
    if (n !== 'ask_clarification') continue
    if (isToolRunning(x)) return true
    const st = String(r.status || '').toLowerCase()
    if (['pending', 'executing', 'active', 'waiting_user', 'waiting_dispatch'].includes(st)) return true
    if (['ok', 'completed', 'done', 'error', 'cancelled', 'failed'].includes(st)) continue
    const out = r.output
    const hasOut =
      out != null &&
      out !== '' &&
      !(typeof out === 'object' && !Array.isArray(out) && Object.keys(out as object).length === 0)
    if (!hasOut) return true
  }
  return false
}

/** 飞书复盘摘要气泡（与 [目标 Agent] 区分） */
const HOSTED_CLOSURE_PREFIX = '[目标汇报]'

function parseHostedClosureSystemText(text: string): { outcome: string; md: string } | null {
  const raw = String(text || '').replace(/^\uFEFF/, '').trimStart()
  if (!raw.startsWith(HOSTED_CLOSURE_PREFIX)) return null
  const rest = raw.slice(HOSTED_CLOSURE_PREFIX.length).replace(/^\n+/, '')
  const m = rest.match(/^\*\*结束\*\*:\s*([^\n]+)\n\n([\s\S]*)$/s)
  if (m) {
    return { outcome: m[1].trim(), md: sanitizeGoalClosureBody(m[2]) }
  }
  return { outcome: '', md: sanitizeGoalClosureBody(rest) }
}

/** 解析目标模式行末尾 `| step=N`（与 useGoalMode appendGoalOutput 一致） */
function splitGoalModeBody(raw: string): { body: string; step: number | null } {
  const s = String(raw || '').trim()
  const m = s.match(/\s*\|\s*step=(\d+)\s*$/i)
  if (!m || m.index == null) return { body: s, step: null }
  const n = parseInt(m[1], 10)
  const body = s.slice(0, m.index).trim()
  return { body, step: Number.isFinite(n) ? n : null }
}

/** useGoalMode 写入主会话的系统行前缀 */
const HOSTED_AGENT_CHAT_PREFIX = '[目标模式] '

function formatTime(ts?: number | string) {
  if (ts == null || ts === '') return ''
  const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const h = d.getHours().toString().padStart(2, '0')
  const m = d.getMinutes().toString().padStart(2, '0')
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (isToday) return `${h}:${m}`
  const mon = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  return `${mon}-${day} ${h}:${m}`
}

/** 用户气泡正文：固定可视高度，过长时框内滚动（不再展开/收起） */
function ScrollableUserText({
  text,
  className,
}: {
  text: string
  className: string
}) {
  return (
    <div key={text} className="msg-user-text-wrap">
      <div className={className}>{text}</div>
    </div>
  )
}

/** 用户消息气泡内原地编辑（ChatGPT / runtime 式） */
function UserMessageInlineEditor({
  initialText,
  busy,
  onCancel,
  onSubmit,
}: {
  initialText: string
  busy?: boolean
  onCancel: () => void
  onSubmit: (text: string) => void | Promise<void>
}) {
  const [draft, setDraft] = useState(initialText)
  const [submitting, setSubmitting] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = taRef.current
    if (!el) return
    el.focus()
    el.selectionStart = el.value.length
    el.selectionEnd = el.value.length
    el.style.height = 'auto'
    el.style.height = `${Math.max(72, Math.min(el.scrollHeight, 280))}px`
  }, [])

  const resize = useCallback(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.max(72, Math.min(el.scrollHeight, 280))}px`
  }, [])

  const submit = useCallback(async () => {
    const t = String(draft || '').trim()
    if (!t || submitting || busy) return
    setSubmitting(true)
    try {
      await onSubmit(t)
    } finally {
      setSubmitting(false)
    }
  }, [draft, submitting, busy, onSubmit])

  const disabled = submitting || !!busy

  return (
    <div className="msg-user-inline-edit" style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
      <textarea
        ref={taRef}
        className="msg-user-inline-edit-textarea"
        value={draft}
        disabled={disabled}
        rows={3}
        aria-label="编辑消息"
        style={{
          width: '100%',
          minHeight: 72,
          maxHeight: 280,
          boxSizing: 'border-box',
          margin: 0,
          padding: '8px 10px',
          border: '1px solid #d0d5dd',
          borderRadius: 10,
          background: '#ffffff',
          color: '#1f2937',
          caretColor: '#1f2937',
          WebkitTextFillColor: '#1f2937',
          fontSize: 14,
          lineHeight: 1.45,
          outline: 'none',
          boxShadow: 'none',
          resize: 'vertical',
        }}
        onChange={(e) => {
          setDraft(e.target.value)
          resize()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            if (!disabled) onCancel()
            return
          }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            void submit()
          }
        }}
      />
      <div className="msg-user-inline-edit-actions">
        <button
          type="button"
          className="msg-user-inline-edit-btn msg-user-inline-edit-btn--ghost"
          disabled={disabled}
          onClick={onCancel}
          style={{
            appearance: 'none',
            border: '1px solid #d0d5dd',
            borderRadius: 8,
            padding: '5px 12px',
            fontSize: 12,
            fontWeight: 500,
            background: '#fff',
            color: '#475467',
            cursor: disabled ? 'not-allowed' : 'pointer',
          }}
        >
          取消
        </button>
        <button
          type="button"
          className="msg-user-inline-edit-btn msg-user-inline-edit-btn--primary"
          disabled={disabled || !String(draft || '').trim()}
          onClick={() => void submit()}
          style={{
            appearance: 'none',
            border: '1px solid #344054',
            borderRadius: 8,
            padding: '5px 12px',
            fontSize: 12,
            fontWeight: 500,
            background: '#344054',
            color: '#fff',
            cursor: disabled || !String(draft || '').trim() ? 'not-allowed' : 'pointer',
          }}
        >
          {submitting ? '发送中…' : '发送'}
        </button>
      </div>
    </div>
  )
}

/** 消息操作栏：hover 时浮现，支持复制/重试/编辑（同会话回溯）/分叉 */
function MessageActionBar({
  role,
  text,
  isStreaming,
  onCopy,
  onRetry,
  onEdit,
  onFork,
}: {
  role: 'user' | 'assistant'
  text: string
  isStreaming: boolean
  onCopy?: (text: string) => void
  onRetry?: () => void
  onEdit?: () => void
  onFork?: () => void
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    const t = String(text || '').trim()
    if (!t) return
    try {
      navigator.clipboard?.writeText(t)
    } catch {
      // ignore
    }
    onCopy?.(t)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }, [text, onCopy])

  if (isStreaming) return null

  return (
    <div className="msg-action-bar" role="group" aria-label="消息操作">
      <button
        type="button"
        className="msg-action-btn"
        onClick={handleCopy}
        title="复制"
        aria-label="复制消息"
      >
        {copied ? '✓' : '⧉'}
      </button>
      {role === 'assistant' && onRetry ? (
        <button
          type="button"
          className="msg-action-btn"
          onClick={onRetry}
          title="重新生成"
          aria-label="重新生成"
        >
          ↻
        </button>
      ) : null}
      {role === 'assistant' && onFork ? (
        <button
          type="button"
          className="msg-action-btn msg-action-btn--fork"
          onClick={onFork}
          title="从当前对话分出新会话：复制到此处为止的历史，原会话不变"
          aria-label="从当前对话分出新会话：复制到此处为止的历史，原会话不变"
        >
          <svg
            className="msg-action-fork-icon"
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
        </button>
      ) : null}
      {role === 'user' && onEdit ? (
        <button
          type="button"
          className="msg-action-btn"
          onClick={onEdit}
          title="编辑这条消息"
          aria-label="编辑这条消息"
        >
          ✎
        </button>
      ) : null}
    </div>
  )
}

export function MessageRow({
  row,
  isStreaming,
  showToolTiming = false,
  suppressPlanExecPromptNoise = false,
  suppressExploringFold = false,
  onOpenFile,
  onOpenKnowledgeMap,
  onToolApproval,
  toolApprovalBusy,
  interactiveToolApproval = false,
  hideSubagentInnerTools = false,
  sessionKey,
  liveActivityDockLabel,
  liveTurnElapsedSec,
  onCopy,
  onRetry,
  onEdit,
  onFork,
  assistantAgentLabel,
  assistantAgent,
}: {
  row: DisplayRow
  isStreaming?: boolean
  showToolTiming?: boolean
  /** 下方面板已有计划条时，隐藏助手复述的「计划已落库/开始执行」类话术 */
  suppressPlanExecPromptNoise?: boolean
  /** 工作轨迹：跳过 Exploring/Explored 折叠壳 */
  suppressExploringFold?: boolean
  hideSubagentInnerTools?: boolean
  sessionKey?: string
  /** 与左侧会话列表同源：resolveLiveStreamActivity.dockLabel；undefined=未接入实时源 */
  liveActivityDockLabel?: string
  /** 本轮原始耗时（秒）；优先于从 dockLabel 反解析 */
  liveTurnElapsedSec?: number
  onOpenFile?: (rawUrl: string, name?: string) => void
  onOpenKnowledgeMap?: () => void
  onToolApproval?: (
    action: 'approve' | 'approve_all' | 'deny' | 'grant_all' | 'approve_remember',
    toolCallId?: string,
    hint?: { tool_name?: string; summary?: string; args?: Record<string, unknown> },
  ) => void
  toolApprovalBusy?: boolean
  interactiveToolApproval?: boolean
  /** 复制消息回调 */
  onCopy?: (text: string) => void
  /** 重新生成（仅 assistant 消息） */
  onRetry?: () => void
  /** 编辑已发送的用户消息（同会话撤回本条及之后并重发） */
  onEdit?: (text: string, messageId?: string) => void | Promise<void>
  /** 从此条 assistant 消息处分叉会话 */
  onFork?: (messageId?: string) => void
  /** 当前会话 Agent 展示名 */
  assistantAgentLabel?: string
  /** 当前会话 Agent（头像） */
  assistantAgent?: AgentAvatarAgent | null
}) {
  const bubbleRef = useRef<HTMLDivElement>(null)
  const displayRow = useLiveStreamOverlayRow(row, sessionKey, !!isStreaming)
  const [userEditing, setUserEditing] = useState(false)

  useLayoutEffect(() => {
    if (!isStreaming) return
    const el = bubbleRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [isStreaming, displayRow.text, displayRow.reasoningPreview, displayRow.segments])

  if (displayRow.role === 'user') {
    const fromText = String(displayRow.text || '')
    const fromSegments = flattenStreamDisplayText(displayRow.segments || [], '')
    const rawUserText = fromText || fromSegments
    if (isHiddenToolApprovalUserMessage(rawUserText)) {
      return null
    }
    const skillDisplay = resolveUserMessageSkillDisplay(displayRow)
    const userText = skillDisplay.text || rawUserText
    const clarifySummary = formatUserClarificationBubbleText(userText)
    const approvalSummary = formatUserToolApprovalBubbleText(userText)
    const userShown = clarifySummary ?? approvalSummary ?? userText
    const hasUserText = String(userShown || '').trim().length > 0
    const preferredSkills = skillDisplay.preferredSkills || (skillDisplay.preferredSkill ? [skillDisplay.preferredSkill] : [])
    const contextFiles = Array.isArray(displayRow.contextFiles) ? displayRow.contextFiles : []
    const canInlineEdit = !!onEdit && !clarifySummary && !approvalSummary && !displayRow.pendingInject
    const mid = String(displayRow.messageId || '').trim() || undefined

    return (
      <article className={`msg msg-turn msg-turn--user msg-user${userEditing ? ' is-editing' : ''}`}>
        <div className="msg-turn-user-row">
          <div className="msg-turn-body msg-user-stack">
            {userEditing ? (
              <UserMessageInlineEditor
                initialText={userText}
                onCancel={() => setUserEditing(false)}
                onSubmit={async (nextText) => {
                  await onEdit?.(nextText, mid)
                  setUserEditing(false)
                }}
              />
            ) : (
              <div className="msg-bubble msg-turn-user-bubble">
                {preferredSkills.length > 0 ? (
                  <div className="msg-user-skill-pills">
                    {preferredSkills.map((sk) => (
                      <HoverBubble key={sk.name} text={`使用技能：${sk.label}`} side="top" align="start" maxWidth={320}>
                        <div className="msg-user-skill-pill">
                          <span className="msg-user-skill-pill-icon" aria-hidden>
                            {sk.icon || '🧩'}
                          </span>
                          <span className="msg-user-skill-pill-label">{sk.label}</span>
                        </div>
                      </HoverBubble>
                    ))}
                  </div>
                ) : null}
                {contextFiles.length > 0 ? (
                  <div className="msg-user-context-files" aria-label="附加工作区文件">
                    {contextFiles.map((f) => (
                      <HoverBubble key={f.path} text={f.path} side="top" align="start" maxWidth={420}>
                        <span className="msg-user-context-file-pill">
                          @{f.name || f.path}
                        </span>
                      </HoverBubble>
                    ))}
                  </div>
                ) : null}
                <MessageMedia
                  images={displayRow.images}
                  videos={displayRow.videos}
                  audios={displayRow.audios}
                  files={displayRow.files}
                  onOpenFile={onOpenFile}
                />
                {hasUserText ? (
                  <ScrollableUserText
                    text={userShown}
                    className={
                      clarifySummary || approvalSummary ? 'msg-user-clarify-summary' : 'msg-user-text'
                    }
                  />
                ) : null}
              </div>
            )}
            {!userEditing ? (
              <div className="msg-meta msg-turn-user-meta">
                <span className="msg-time">
                  {displayRow.pendingInject ? <span className="msg-pending-badge">⏳ 待处理</span> : null}
                  {formatTime(displayRow.timestamp)}
                </span>
                <MessageActionBar
                  role="user"
                  text={userText}
                  isStreaming={false}
                  onCopy={onCopy}
                  onEdit={canInlineEdit ? () => setUserEditing(true) : undefined}
                />
              </div>
            ) : null}
          </div>
        </div>
      </article>
    )
  }

  if (displayRow.role === 'assistant' || displayRow.role === '_stream') {
    const hasTools = Array.isArray(displayRow.tools) && displayRow.tools.length > 0
    const hasFinalText = String(displayRow.text || '').trim().length > 0
    const assistantVariant =
      isStreaming && (hasTools || !hasFinalText)
        ? 'running'
        : !isStreaming && hasTools && hasFinalText
          ? 'delivery'
          : 'normal'
    return (
      <article
        className={`msg msg-turn msg-turn--assistant msg-ai msg-turn--${assistantVariant}${
          isStreaming ? ' msg-ai-streaming' : ''
        }`}
        data-assistant-variant={assistantVariant}
      >
        <header className="msg-ai-head msg-turn-assistant-header">
          <span className="msg-ai-avatar" aria-hidden>
            {assistantAgent ? (
              <AgentAvatar
                className="msg-ai-avatar-agent"
                agent={assistantAgent}
                agentCode={assistantAgent.agent_code || undefined}
                size={18}
              />
            ) : (
              <img className="msg-ai-avatar-logo" src="/images/logo.png" alt="" width="18" height="18" />
            )}
          </span>
          <span className="msg-ai-head-label">
            {assistantAgentLabel ||
              String(assistantAgent?.agent_name || '').trim() ||
              'EvoFlow · Agent'}
          </span>
          <span className="msg-ai-head-time">{formatTime(displayRow.timestamp)}</span>
        </header>
        <div className="msg-bubble msg-turn-assistant-content" ref={bubbleRef}>
          <AssistantBody
            row={displayRow}
            isStreaming={isStreaming}
            showToolTiming={showToolTiming}
            suppressPlanExecPromptNoise={suppressPlanExecPromptNoise}
            suppressExploringFold={suppressExploringFold}
            onOpenFile={onOpenFile}
            onOpenKnowledgeMap={onOpenKnowledgeMap}
            onToolApproval={onToolApproval}
            toolApprovalBusy={toolApprovalBusy}
            interactiveToolApproval={interactiveToolApproval}
            hideSubagentInnerTools={hideSubagentInnerTools}
            sessionKey={sessionKey}
            liveActivityDockLabel={liveActivityDockLabel}
            liveTurnElapsedSec={liveTurnElapsedSec}
          />
          <MessageMedia
            images={displayRow.images}
            videos={displayRow.videos}
            audios={displayRow.audios}
            files={displayRow.files}
            onOpenFile={onOpenFile}
          />
          {!isStreaming
            ? (() => {
                const cites = extractEvoAssetCitations(String(displayRow.text || '')).entries
                return cites.length ? <AssetCitationChips entries={cites} /> : null
              })()
            : null}
        </div>
        {(!isStreaming || displayRow.tokenStr) && (
          <div className="msg-meta msg-turn-assistant-meta">
            {!isStreaming && displayRow.durationStr ? (
              <span className="msg-duration">⏱ {displayRow.durationStr}</span>
            ) : null}
            {displayRow.tokenStr ? (
              <>
                {!isStreaming && displayRow.durationStr ? <span className="meta-sep">·</span> : null}
                <AnimatedTokenInline tokenStr={displayRow.tokenStr} animate={!!isStreaming} />
              </>
            ) : null}
            <MessageActionBar
              role="assistant"
              text={String(displayRow.text || '')}
              isStreaming={!!isStreaming}
              onCopy={onCopy}
              onRetry={onRetry}
              onFork={
                onFork
                  ? () => onFork(String(displayRow.messageId || '').trim() || undefined)
                  : undefined
              }
            />
          </div>
        )}
      </article>
    )
  }

  const sysText = String(displayRow.text || '')
  const closure = parseHostedClosureSystemText(sysText)
  if (closure) {
    return (
      <div className="msg msg-system msg-system--hosted-closure">
        <div className="msg-bubble msg-bubble--system-closure">
          <div className="msg-ai-ask-inline msg-ai-ask-inline--closure-report">
            <div className="msg-ai-ask-inline-label msg-ai-ask-inline-label--closure">
              <span>✅ 目标汇报</span>
              {closure.outcome ? (
                <span className="msg-ai-ask-inline-step msg-ai-ask-inline-step--closure" title="结束原因">
                  · {closure.outcome}
                </span>
              ) : null}
            </div>
            {closure.md ? (
              <div className="msg-ai-ask-inline-md msg-text react-chat-hosted-closure-md">
                <MarkdownHtml text={closure.md} onOpenWorkspaceFile={onOpenFile} />
              </div>
            ) : null}
          </div>
        </div>
        {displayRow.timestamp ? (
          <div className="msg-meta">
            <span className="msg-time">{formatTime(displayRow.timestamp)}</span>
          </div>
        ) : null}
      </div>
    )
  }

  if (sysText.startsWith(HOSTED_AGENT_CHAT_PREFIX)) {
    const after = sysText.slice(HOSTED_AGENT_CHAT_PREFIX.length).trim()
    const { body, step } = splitGoalModeBody(after)
    return (
      <div className="msg msg-system msg-system--hosted-callout">
        <div className="msg-bubble msg-bubble--system-callout">
          <div className="msg-ai-ask-inline msg-ai-ask-inline--hosted">
            <div className="msg-ai-ask-inline-label msg-ai-ask-inline-label--with-step">
              <span>目标</span>
              {step != null ? (
                <span className="msg-ai-ask-inline-step" title={`调度第 ${step} 步`}>
                  · step {step}
                </span>
              ) : null}
            </div>
            <div className="msg-ai-ask-inline-body">{body}</div>
          </div>
        </div>
        {displayRow.timestamp ? (
          <div className="msg-meta">
            <span className="msg-time">{formatTime(displayRow.timestamp)}</span>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="msg msg-system">
      <div className="msg-bubble">{displayRow.text}</div>
    </div>
  )
}

/**
 * O(1) 形状签名生成器。
 * 用于检测 row 是否发生了原地突变（虽然 React 模式下极少发生，但作为安全网）。
 */
function assistantRowCacheSignature(row: DisplayRow): string {
  const t = row.tools || []
  const s = row.segments as MessageSegment[] | undefined
  return `${t.length}|${row.text?.length || 0}|${s?.length || 0}|${row.reasoningPreview?.length || 0}`
}

function AssistantBody({
  row,
  isStreaming,
  showToolTiming = false,
  suppressPlanExecPromptNoise = false,
  suppressExploringFold = false,
  onOpenFile,
  onOpenKnowledgeMap,
  onToolApproval,
  toolApprovalBusy,
  interactiveToolApproval = false,
  hideSubagentInnerTools = false,
  sessionKey,
  liveActivityDockLabel,
  liveTurnElapsedSec,
}: {
  row: DisplayRow
  isStreaming?: boolean
  showToolTiming?: boolean
  suppressPlanExecPromptNoise?: boolean
  suppressExploringFold?: boolean
  hideSubagentInnerTools?: boolean
  sessionKey?: string
  /** 与左侧会话列表同源：resolveLiveStreamActivity.dockLabel */
  liveActivityDockLabel?: string
  /** 本轮原始耗时（秒）；优先于从 dockLabel 反解析 */
  liveTurnElapsedSec?: number
  onOpenFile?: (rawUrl: string, name?: string) => void
  onOpenKnowledgeMap?: () => void
  onToolApproval?: (
    action: 'approve' | 'approve_all' | 'deny' | 'grant_all' | 'approve_remember',
    toolCallId?: string,
    hint?: { tool_name?: string; summary?: string; args?: Record<string, unknown> },
  ) => void
  toolApprovalBusy?: boolean
  interactiveToolApproval?: boolean
}) {
  // 1. 缓存策略：仅对非流式行启用缓存（流式行实时变化，缓存无意义且易脏）
  const cacheable = !isStreaming
  let bundle: AssistantBodyDerivedBundle | undefined

  if (cacheable) {
    const entry = assistantBodyCache.get(row)
    const signature = assistantRowCacheSignature(row)
    if (
      entry &&
      entry.suppressPlanExecPromptNoise === suppressPlanExecPromptNoise &&
      entry.interactiveToolApproval === interactiveToolApproval &&
      entry.signature === signature
    ) {
      bundle = entry.bundle
    }
  }

  // 2. 缓存未命中则实时计算
  if (!bundle) {
    bundle = computeAssistantBodyBundle(
      row,
      !!isStreaming,
      !!suppressPlanExecPromptNoise,
      !!interactiveToolApproval,
      liveActivityDockLabel,
    )
    if (cacheable) {
      assistantBodyCache.set(row, {
        suppressPlanExecPromptNoise,
        interactiveToolApproval,
        signature: assistantRowCacheSignature(row),
        bundle,
      })
    }
  }

  const { tools, displaySegments, rawText, reasoning, askBubbleHint, plan } = bundle

  // 3. 剩余轻量级派生（JSX 元素等，不适合进缓存）
  const subagentTasks = row.subagentTasks as Record<string, SubagentStreamTask> | undefined
  const terminalStreams = row.terminalStreams as Record<string, TerminalStreamTask> | undefined

  const askInline = askBubbleHint ? (
    <div className="msg-ai-ask-inline">
      <div className="msg-ai-ask-inline-label">询问</div>
      <div className="msg-ai-ask-inline-body">{askBubbleHint}</div>
    </div>
  ) : null

  const compareSessionKey = String(sessionKey || '').trim() || undefined
  if (row.role === '_stream' && isStreaming) {
    logStreamSourceConsoleIfChanged(row, compareSessionKey)
    logStreamCompareUiDisplay({ row, plan, sessionKey: compareSessionKey })
    logStreamCompareUiChunks({ row, plan, sessionKey: compareSessionKey })
    logStreamCompareUiStreamTools({ row, tools, sessionKey: compareSessionKey, isStreaming: !!isStreaming })
  }

  const durationLabel = resolveTurnDurationLabel({
    elapsedSec: liveTurnElapsedSec,
    sealedDurationStr: row.durationStr,
    // Compat only: older paths that only expose composite dock copy.
    dockLabelCompat: liveActivityDockLabel,
  })

  return (
    <AssistantBubbleSlotView
      plan={plan}
      displaySegments={displaySegments}
      tools={tools}
      rawText={rawText}
      reasoningPreview={reasoning}
      isStreaming={!!isStreaming}
      askInline={askInline}
      suppressPlanExecPromptNoise={suppressPlanExecPromptNoise}
      interactiveToolApproval={interactiveToolApproval}
      subagentTasks={subagentTasks}
      terminalStreams={terminalStreams}
      onOpenFile={onOpenFile}
      onOpenKnowledgeMap={onOpenKnowledgeMap}
      onToolApproval={onToolApproval}
      toolApprovalBusy={toolApprovalBusy}
      hideSubagentInnerTools={hideSubagentInnerTools}
      showToolTiming={showToolTiming}
      suppressExploringFold={suppressExploringFold}
      sessionKey={sessionKey}
      compareSessionKey={compareSessionKey}
      durationLabel={durationLabel}
      liveTokenStr={row.tokenStr}
    />
  )
}