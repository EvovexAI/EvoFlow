import { useRef, useState, useLayoutEffect, useCallback, useEffect, useMemo, memo } from 'react'
import { ChevronDown, ChevronUp, Copy, Pencil } from 'lucide-react'
import { MarkdownHtml } from './MarkdownHtml.js'
import { AnimatedTokenInline } from './AnimatedTokenDisplay.js'
import { MessageMedia } from './MessageMedia.js'
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

/** 回合开始时间按 runId/messageId 记忆（流式→封存行对象重建时恢复，容量有限自动淘汰） */
const turnStartMsByRunKey = new Map<string, number>()

function rememberTurnStartMs(key: string, ms: number) {
  // v5.7 修复：tool call 期间 displaySegments/_uiStartedAtMs 可能引入"新时间戳"，
  //   覆盖了真实回合开始 → 折叠头「工作中」会从 8 秒跳回 0 秒。
  //   改为：只在第一次设定时锁定，不再被后续"更晚"或"更早"的时间戳覆盖。
  //   真正的回合开始 = 第一次看到该 runId 时的最早时间戳。
  const existing = turnStartMsByRunKey.get(key)
  if (existing != null) {
    // 已锁定：仅当新值显著更早（>1s）才更新（防御性，正常不会发生）
    if (ms < existing - 1000) turnStartMsByRunKey.set(key, ms)
    return
  }
  turnStartMsByRunKey.set(key, ms)
  if (turnStartMsByRunKey.size > 200) {
    const oldest = turnStartMsByRunKey.keys().next().value
    if (oldest != null) turnStartMsByRunKey.delete(oldest)
  }
}

function recallTurnStartMs(key: string): number | null {
  return turnStartMsByRunKey.get(key) ?? null
}

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
  flatTimeline: boolean,
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
    flatTimeline,
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
import { AssistantSelectionMenu } from './AssistantSelectionMenu.js'
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
import {
  logStreamCompareUiDisplay,
  logStreamCompareUiChunks,
  logStreamCompareUiStreamTools,
  logStreamCompareDomView,
  logStreamCompareVisualMirror,
} from '../lib/stream-compare-file-log.js'
import { buildAssistantDomView } from '../lib/assistant-dom-view.js'
import { logStreamSourceConsoleIfChanged } from '../stream-console-mirror.js'
import {
  formatTurnDurationStr,
  parseTurnTimestampMs,
  resolveTurnDurationLabel,
} from '../lib/turn-timing.js'

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

/** 用户气泡正文：固定可视高度，过长时框内滚动 */
function ScrollableUserText({ text, className }: { text: string; className: string }) {
  return (
    <div key={text} className="msg-user-text-wrap">
      <div className={className}>{text}</div>
    </div>
  )
}

const USER_TEXT_COLLAPSED_MAX_HEIGHT_PX = 120
const USER_TEXT_OVERFLOW_TOLERANCE_PX = 1

function UserTextCollapsible({ text, className }: { text: string; className: string }) {
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [contentScrollHeight, setContentScrollHeight] = useState(
    USER_TEXT_COLLAPSED_MAX_HEIGHT_PX,
  )
  const [expandable, setExpandable] = useState(false)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    setExpanded(false)
  }, [text])

  useEffect(() => {
    const content = contentRef.current
    if (!content) {
      setExpandable(false)
      return
    }
    let rafId = 0
    const update = () => {
      const nextScrollHeight = content.scrollHeight
      setContentScrollHeight((current) => (current === nextScrollHeight ? current : nextScrollHeight))
      if (!expanded) {
        const nextExpandable =
          nextScrollHeight > USER_TEXT_COLLAPSED_MAX_HEIGHT_PX + USER_TEXT_OVERFLOW_TOLERANCE_PX
        setExpandable((current) => (current === nextExpandable ? current : nextExpandable))
      }
    }
    const schedule = () => {
      if (rafId) return
      rafId = window.requestAnimationFrame(() => {
        rafId = 0
        update()
      })
    }
    schedule()
    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null
    observer?.observe(content)
    window.addEventListener('resize', schedule)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', schedule)
      if (rafId) window.cancelAnimationFrame(rafId)
    }
  }, [text, expanded])

  const resolvedMaxHeight = expanded
    ? Math.max(contentScrollHeight, USER_TEXT_COLLAPSED_MAX_HEIGHT_PX)
    : USER_TEXT_COLLAPSED_MAX_HEIGHT_PX

  return (
    <div className="msg-user-input-collapsible" data-conversation-selectable="true">
      <div
        ref={contentRef}
        data-v4-user-input-collapsible-content="true"
        style={{ maxHeight: `${resolvedMaxHeight}px` }}
        className={`msg-user-input-collapsible-content${
          !expanded && expandable ? ' is-clamped' : ''
        }`}
      >
        <ScrollableUserText text={text} className={className} />
      </div>
      {expandable ? (
        <div
          data-v4-user-input-collapsible-toggle-row="true"
          className={`msg-user-input-collapse-toggle-row${expanded ? ' is-expanded' : ''}`}
        >
          <button
            type="button"
            data-v4-user-input-collapsible-toggle="true"
            className="msg-user-input-collapse-toggle"
            aria-label={expanded ? '收起' : '展开'}
            aria-expanded={expanded}
            title={expanded ? '收起' : '展开'}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? (
              <ChevronUp size={16} strokeWidth={1.5} aria-hidden />
            ) : (
              <ChevronDown size={16} strokeWidth={1.5} aria-hidden />
            )}
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** 用户消息气泡内原地编辑（ChatGPT / runtime 式）；支持移除/添加图片附件 */
function UserMessageInlineEditor({
  initialText,
  initialImages,
  busy,
  onCancel,
  onSubmit,
}: {
  initialText: string
  /** 编辑态图片：mediaType + base64 data（无 url 形态的历史图不可编辑则原样保留） */
  initialImages?: Array<{ mediaType: string; data?: string; url?: string }>
  busy?: boolean
  onCancel: () => void
  onSubmit: (text: string, images: Array<{ mediaType: string; data?: string; url?: string }>) => void | Promise<void>
}) {
  const [draft, setDraft] = useState(initialText)
  const [images, setImages] = useState<Array<{ mediaType: string; data?: string; url?: string }>>(
    () => (Array.isArray(initialImages) ? [...initialImages] : []),
  )
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [submitting, setSubmitting] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const removeImage = (idx: number) => setImages((prev) => prev.filter((_, i) => i !== idx))
  const addImageFiles = (files: FileList | null) => {
    if (!files?.length) return
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue
      const reader = new FileReader()
      reader.onload = () => {
        const data = String(reader.result || '').split(',')[1] || ''
        if (data) setImages((prev) => [...prev, { mediaType: f.type || 'image/png', data }])
      }
      reader.readAsDataURL(f)
    }
  }

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
      await onSubmit(t, images)
    } finally {
      setSubmitting(false)
    }
  }, [draft, images, submitting, busy, onSubmit])

  const disabled = submitting || !!busy

  return (
    <div className="msg-user-inline-edit" style={{ display: 'flex', flexDirection: 'column', gap: 8, width: 'fit-content', maxWidth: 'max-content', alignSelf: 'flex-end' }}>
      <textarea
        ref={taRef}
        className="msg-user-inline-edit-textarea"
        value={draft}
        disabled={disabled}
        rows={3}
        aria-label="编辑消息"
        style={{
          width: 'fit-content',
          minWidth: 200,
          maxWidth: '100%',
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
        {images.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {images.map((img, i) => (
              <div
                key={`${i}-${(img.data || img.url || '').slice(-12)}`}
                style={{ position: 'relative', width: 56, height: 56, borderRadius: 8, overflow: 'hidden', border: '1px solid #d0d5dd', background: '#f4f5fb' }}
              >
                <img
                  src={img.data ? `data:${img.mediaType || 'image/png'};base64,${img.data}` : img.url || ''}
                  alt=""
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
                <button
                  type="button"
                  aria-label="移除图片"
                  onClick={() => removeImage(i)}
                  disabled={disabled}
                  style={{ position: 'absolute', top: 2, right: 2, width: 18, height: 18, borderRadius: '50%', border: 'none', background: 'rgba(0,0,0,.62)', color: '#fff', fontSize: 11, lineHeight: '18px', padding: 0, cursor: 'pointer' }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            style={{ border: '1px dashed #d0d5dd', background: 'transparent', color: '#475467', borderRadius: 8, padding: '4px 10px', fontSize: 12, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1 }}
          >
            ＋ 添加图片
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              addImageFiles(e.target.files)
              e.currentTarget.value = ''
            }}
          />
        </div>
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

/** 消息操作栏：ZCode MessageActions 同款，hover 时浮现；按钮使用 Lucide 图标 */
function MessageActionBarInner({
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
    window.setTimeout(() => setCopied(false), 1200)
  }, [text, onCopy])

  if (isStreaming) return null

  return (
    <>
      <button
        type="button"
        className="msg-action-btn"
        onClick={handleCopy}
        title="复制"
        aria-label="复制消息"
      >
        {copied ? (
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-4" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        ) : (
          <Copy size={16} strokeWidth={1.5} aria-hidden />
        )}
      </button>
      {role === 'user' && onEdit ? (
        <button
          type="button"
          className="msg-action-btn"
          onClick={onEdit}
          title="编辑"
          aria-label="编辑这条消息"
        >
          <Pencil size={16} strokeWidth={1.5} aria-hidden />
        </button>
      ) : null}
      {role === 'assistant' && onRetry ? (
        <button
          type="button"
          className="msg-action-btn"
          onClick={onRetry}
          title="重新生成"
          aria-label="重新生成"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
            <path d="M8 16H3v5" />
          </svg>
        </button>
      ) : null}
      {role === 'assistant' && onFork ? (
        <button
          type="button"
          className="msg-action-btn"
          onClick={onFork}
          title="从当前对话分出新会话"
          aria-label="从当前对话分出新会话"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
        </button>
      ) : null}
    </>
  )
}

/**
 * props 引用稳定（text / onCopy / onEdit / isStreaming）时跳过整函数体重渲染。
 * 避免了用户行/已封存 assistant 行在 SSE delta 期间跟随 MessageRow rerender
 * 而触发不必要的重画——但 MessageActionBar 内部「复制成功」等 useState 状态仍
 * 保留在 hook 作用域，rAF/React 19 下 memo 跳过整函数不会丢失状态。
 */
const MessageActionBar = memo(MessageActionBarInner)

export function MessageRow({
  row,
  isStreaming: _isStreamingDeprecated,
  threadBusy = false,
  showToolTiming = false,
  suppressPlanExecPromptNoise = false,
  suppressExploringFold = false,
  flatTimeline = true,
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
}: {
  row: DisplayRow
  /**
   * @deprecated ZCode v4 对齐后不再使用；保留只在调用方为非 streaming 路径时
   * 兼容传 false（MessageVirtualList 已停传，由 row.state 单一来源决定）。
   */
  isStreaming?: boolean
  /**
   * 整 thread 是否还在跑（与左下「停止」按钮同源：sessionRuntime.turnPhase
   * ∈ {outbound, live, reattaching, sealing}）。v5.10：用来决定 TurnHistoryFold
   * 头部的 gear + foldOpen —— 旧实现把 foldOpen 绑在 per-row `isStreaming` 上，
   * 2026-10-10 用户反馈：RUN_FINISHED 之后历史 row 整段折叠（final-reply 看不到）。
   * 改 threadBusy 后：sealing 阶段整段保持展开直到 thread 真正结束。
   * 默认 false。MessageVirtualList 顶层注入。
   */
  threadBusy?: boolean
  showToolTiming?: boolean
  /** 下方面板已有计划条时，隐藏助手复述的「计划已落库/开始执行」类话术 */
  suppressPlanExecPromptNoise?: boolean
  /** 工作轨迹：跳过 Exploring/Explored 折叠壳 */
  suppressExploringFold?: boolean
  /** ZCode 式扁平内联时间线：activity chunk 不套「探索中」外壳（默认 true） */
  flatTimeline?: boolean
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
  onEdit?: (text: string, messageId?: string, images?: Array<{ mediaType: string; data?: string; url?: string }>) => void | Promise<void>
  /** 从此条 assistant 消息处分叉会话 */
  onFork?: (messageId?: string) => void
  /** 当前会话 Agent 展示名 */
  assistantAgentLabel?: string
  /** 当前会话 Agent（头像） */
  assistantAgent?: AgentAvatarAgent | null
}) {
  const bubbleRef = useRef<HTMLDivElement>(null)
  // 单一真相源：row 自身已经包含所有渲染所需信息（state / text / segments
  // / reasoning），由 buildStreamDisplayRow 在 commit 时一次性投影完成。
  // 旧 applyLiveStreamOverlay 二次 patch 已删除，避免 row 引用与新 live 值错位。
  const displayRow = row
  // row.state 是单一真相源；弃用 prop 仅保持向后兼容（默认 false）。
  const isStreamingEffective = row.state === 'streaming' || (row.state === undefined && false)

  // 【调试】追踪 isStreamingEffective 变化（齿轮显示/消失）
  const prevStreamingRef = useRef(isStreamingEffective)
  useEffect(() => {
    const prev = prevStreamingRef.current
    if (prev !== isStreamingEffective) {
      console.log(
        `[GearDebug] isStreamingEffective changed: ${prev} → ${isStreamingEffective}`,
        '| row.role:', row.role,
        '| row.state:', row.state,
        '| row.runId:', row.runId,
        '| tools count:', Array.isArray(row.tools) ? row.tools.length : 'N/A',
        '| text len:', (row.text || '').length,
        '| segments count:', Array.isArray(row.segments) ? row.segments.length : 'N/A',
        '| timestamp:', new Date().toISOString(),
      )
      prevStreamingRef.current = isStreamingEffective
    }
  }, [isStreamingEffective, row.role, row.state, row.runId, row.tools, row.text, row.segments])

  const [userEditing, setUserEditing] = useState(false)

  /**
   * 稳定回调：onFork 每次 MessageRow rerender 都新建 arrow 会让 MessageActionBar memo
   * 失效；这里 memo 化，让非流式行（即 assistant ActionBar）props 引用保持稳定，
   * 避免 SSE delta 期间 AssistantBody 子树被无效重画。
   */
  const forkHandler = useMemo(
    () => (onFork ? () => onFork(String(displayRow.messageId || '').trim() || undefined) : undefined),
    [onFork, displayRow.messageId],
  )

  useEffect(() => {
    if (!isStreamingEffective) return
    const el = bubbleRef.current
    if (!el) return
    // 流式正文增长：把 bubble 贴底。原 useLayoutEffect 同步写 scrollTop 触发
    // 同步 reflow（layout thrashing），每 token 一次 render 都阻塞 paint。
    // 改 rAF 异步贴底：等本帧 layout 完成后再读 scrollHeight，避免和 React 提交
    // 抢 layout 通道。
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(raf)
  }, [isStreamingEffective, displayRow.text, displayRow.reasoningPreview, displayRow.segments])

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
    // ZCode 对齐：附件/引用/媒体外置到气泡上方，纯附件消息不渲染空气泡
    const hasUserAttachments =
      preferredSkills.length > 0 ||
      contextFiles.length > 0 ||
      [displayRow.images, displayRow.videos, displayRow.audios, displayRow.files].some(
        (m) => Array.isArray(m) && m.length > 0,
      )
    const hasUserBubble = hasUserText || clarifySummary || approvalSummary
    const canInlineEdit = !!onEdit && !clarifySummary && !approvalSummary && !displayRow.pendingInject
    const mid = String(displayRow.messageId || '').trim() || undefined

    return (
      <article className={`msg msg-turn msg-turn--user msg-user${userEditing ? ' is-editing' : ''} group/user-row`}>
        {/* ZCode 对齐：附件/引用/技能 → 气泡 → 状态 → 操作栏 依次堆叠 */}
        {hasUserAttachments ? (
          <div className="msg-user-attachments" data-v4-user-input-attachments="true">
            {preferredSkills.length > 0 ? (
              <div className="msg-user-skill-pills">
                {preferredSkills.map((sk) => (
                  <HoverBubble key={sk.name} text={`使用技能：${sk.label}`} side="top" align="end" maxWidth={320}>
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
                  <HoverBubble key={f.path} text={f.path} side="top" align="end" maxWidth={420}>
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
          </div>
        ) : null}

        {userEditing ? (
          /* ZCode 对齐：编辑态使用独立 textarea，不是气泡包裹 */
          <div className="msg-user-edit-bubble">
            <UserMessageInlineEditor
              initialText={userText}
              initialImages={displayRow.images as Array<{ mediaType: string; data?: string; url?: string }> | undefined}
              onCancel={() => setUserEditing(false)}
              onSubmit={async (nextText, images) => {
                await onEdit?.(nextText, mid, images)
                setUserEditing(false)
              }}
            />
          </div>
        ) : (
          <>
            {hasUserBubble ? (
              <div className="msg-bubble msg-turn-user-bubble" data-v4-user-input-bubble="true">
                {/* ZCode 对齐：气泡内嵌 ConversationUserInputBody 同款结构 */}
                <div data-conversation-selectable="true">
                  {hasUserText ? (
                    <UserTextCollapsible
                      text={userShown}
                      className={
                        clarifySummary || approvalSummary ? 'msg-user-clarify-summary' : 'msg-user-text'
                      }
                    />
                  ) : null}
                </div>
              </div>
            ) : null}
          </>
        )}

        {/* ZCode 对齐：状态文本（⏳ 待处理等） */}
        {displayRow.pendingInject ? (
          <div className="msg-status" data-v4-user-input-status="true">
            <span className="msg-pending-badge">⏳ 待处理</span>
          </div>
        ) : null}

        {/* ZCode 对齐：操作栏（hover 浮现）+ 时间戳 */}
        {!userEditing ? (
          <div className="msg-action-bar" role="group" aria-label="消息操作">
            <MessageActionBar
              role="user"
              text={userText}
              isStreaming={false}
              onCopy={onCopy}
              onEdit={canInlineEdit ? () => setUserEditing(true) : undefined}
            />
            <span className="msg-time" style={{ marginLeft: 6 }}>
              {formatTime(displayRow.timestamp)}
            </span>
          </div>
        ) : null}
      </article>
    )
  }

  if (displayRow.role === 'assistant' || displayRow.role === '_stream') {
    const hasTools = Array.isArray(displayRow.tools) && displayRow.tools.length > 0
    const hasFinalText = String(displayRow.text || '').trim().length > 0
    const assistantVariant =
      isStreamingEffective && (hasTools || !hasFinalText)
        ? 'running'
        : !isStreamingEffective && hasTools && hasFinalText
          ? 'delivery'
          : 'normal'
    return (
      <article
        className={`msg msg-turn msg-turn--assistant msg-ai msg-turn--${assistantVariant}${
          isStreamingEffective ? ' msg-ai-streaming' : ''
        }`}
        data-assistant-variant={assistantVariant}
      >
        <div className="msg-bubble msg-turn-assistant-content" ref={bubbleRef}>
          <AssistantBody
            row={displayRow}
            isStreaming={isStreamingEffective}
            threadBusy={threadBusy}
            showToolTiming={showToolTiming}
            suppressPlanExecPromptNoise={suppressPlanExecPromptNoise}
            suppressExploringFold={suppressExploringFold}
            flatTimeline={flatTimeline}
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
          {!isStreamingEffective
            ? (() => {
                const cites = extractEvoAssetCitations(String(displayRow.text || '')).entries
                return cites.length ? <AssetCitationChips entries={cites} /> : null
              })()
            : null}
          {!isStreamingEffective ? <AssistantSelectionMenu containerRef={bubbleRef} /> : null}
        </div>
        {(!isStreamingEffective || displayRow.tokenStr) && (
          <div className="msg-meta msg-turn-assistant-meta">
            <div className="msg-assistant-actions">
              {!isStreamingEffective && displayRow.durationStr ? (
                <span className="msg-duration">⏱ {displayRow.durationStr}</span>
              ) : null}
              {displayRow.tokenStr ? (
                <>
                  {!isStreamingEffective && displayRow.durationStr ? <span className="meta-sep">·</span> : null}
                  <AnimatedTokenInline tokenStr={displayRow.tokenStr} animate={!!isStreamingEffective} />
                </>
              ) : null}
            </div>
            <MessageActionBar
              role="assistant"
              text={String(displayRow.text || '')}
              isStreaming={isStreamingEffective}
              onCopy={onCopy}
              onRetry={onRetry}
              onFork={forkHandler}
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
  threadBusy = false,
  showToolTiming = false,
  suppressPlanExecPromptNoise = false,
  suppressExploringFold = false,
  flatTimeline = true,
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
  /**
   * 整 thread 是否还在跑（与左下「停止」按钮同源）。v5.10：透传到
   * buildAssistantDomView 决定 gear + foldOpen。详见 MessageRow 顶部注释。
   */
  threadBusy?: boolean
  showToolTiming?: boolean
  suppressPlanExecPromptNoise?: boolean
  suppressExploringFold?: boolean
  /** ZCode 式扁平内联时间线（默认 true） */
  flatTimeline?: boolean
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
      flatTimeline !== false,
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

  // 「已工作」时长：流式期间每秒滴答（回合开始 = 最早思考/工具时间戳，兜底为流式首帧）；
  // 完成后优先 row.durationStr，缺数据时用回合开始到行封存时间估算。
  const turnStartCandidateMs = (() => {
    let start: number | null = null
    for (const seg of displaySegments) {
      if (seg.kind !== 'reasoning' || seg.startedAtMs == null) continue
      if (start == null || seg.startedAtMs < start) start = seg.startedAtMs
    }
    for (const raw of tools) {
      const t = raw as Record<string, unknown>
      const s = parseTurnTimestampMs(t._uiStartedAtMs ?? t.time ?? t.messageTimestamp)
      if (s != null && (start == null || s < start)) start = s
    }
    return start
  })()
  const [turnStartFallbackMs, setTurnStartFallbackMs] = useState<number | null>(null)
  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    if (!isStreaming) {
      setTurnStartFallbackMs(null)
      return
    }
    setTurnStartFallbackMs((prev) => prev ?? Date.now())
    setNowTick(Date.now())
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [isStreaming])
  const turnStartMs = turnStartCandidateMs ?? turnStartFallbackMs
  // 流式→封存切换时行对象会重建，封存行可能丢时间戳：按 runId/messageId 记忆回合开始，
  // 保证「已工作」头部在回合结束后不闪退。
  // v5.7 修复：tool call 期间 displaySegments 的 _uiStartedAtMs 可能引入"新时间戳"，
  //   导致 turnStartCandidateMs 在回合中跳到 tool 开始时间（晚于真实回合开始），
  //   让「工作中 N 秒」在 tool 触发瞬间跳回 0~1 秒。
  //   修复：先 recall（已锁定的回合开始），有就锁定；没有才用 turnStartMs 初始化记忆。
  //   这样 turnStartMsResolved 在整回合内单调。
  const turnRunKey = String(row.runId || row.messageId || '')
  const rememberedStart = turnRunKey ? recallTurnStartMs(turnRunKey) : null
  const turnStartMsResolved = rememberedStart ?? turnStartMs
  if (turnRunKey && turnStartMs != null && rememberedStart == null) {
    rememberTurnStartMs(turnRunKey, turnStartMs)
  }
  const workedDurationLabel = (() => {
    if (isStreaming) {
      if (turnStartMsResolved == null) return ''
      const sec = Math.round((nowTick - turnStartMsResolved) / 1000)
      return sec >= 1 ? formatTurnDurationStr(sec) : ''
    }
    // 被打断的回合(ZCode「已停止」):标记优先于时长
    if (String(row.turnState || '').trim() === 'interrupted') return 'stopped'
    if (durationLabel) return durationLabel
    const rowTs = parseTurnTimestampMs(row.timestamp)
    if (turnStartMsResolved == null || rowTs == null || rowTs <= turnStartMsResolved) return ''
    const sec = Math.round((rowTs - turnStartMsResolved) / 1000)
    return sec >= 1 ? formatTurnDurationStr(sec) : ''
  })()

  /** 回合中断标记透传给折叠头(ZCode「已停止」) */
  const turnInterrupted = workedDurationLabel === 'stopped' || String(row.turnState || '').trim() === 'interrupted'
  const workedLabelOut = workedDurationLabel === 'stopped' ? '' : workedDurationLabel

  // v5.9 compare-log：DOM 视角 1:1 快照。
  // 覆盖：_stream / assistant 助手行，工作中 + 已工作都写。
  // 2026-10-10 反馈：foldOpen + gear 都跟 threadBusy 走（与左下「停止」按钮同源）。
  //   旧实现 foldOpen = isStreaming 会让历史 row 在 RUN_FINISHED 之后立刻折叠，
  //   用户看不到 final-reply。改 threadBusy 后：sealing 阶段整段保持展开。
  if (row.role === '_stream' || row.role === 'assistant') {
    const domView = buildAssistantDomView({
      row,
      plan,
      isStreaming: !!isStreaming,
      threadBusy: !!threadBusy,
      workedLabel: workedLabelOut
        ? isStreaming
          ? `工作中 ${workedLabelOut}`
          : `已工作 ${workedLabelOut}`
        : '',
    })
  logStreamCompareDomView({
    sessionKey: compareSessionKey,
    runId: row.runId,
    foldOpen: domView.foldOpen,
    head: domView.head,
    gear: domView.gear,
    chunks: domView.chunks,
    fileChanges: domView.fileChanges,
    diag: {
      rowRole: row.role,
      rowState: row.state,
      isStreamingEffective: !!isStreaming,
      turnStartMsResolved,
      // v5.9：plan.slots 的内容（每段 kind/text[head]）便于诊断「正文不流畅」时
      // dom-view chunks 为何与 plan.slots 不一致。
      slots: plan.slots.map((s) => {
        if (s.kind === 'chunk') {
          const c = s.chunk
          return `chunk#${s.chunkIndex} ${c.kind}${c.kind === 'text' ? ` len=${String(c.text || '').length}` : ''}`
        }
        if (s.kind === 'plain-body' || s.kind === 'live-tail' || s.kind === 'plan-top' ||
            s.kind === 'top-reasoning' || s.kind === 'reasoning-pending' || s.kind === 'legacy-body') {
          return `${s.kind} len=${String(s.text || '').length}`
        }
        if (s.kind === 'tool-row') {
          return `tool-row[${s.toolCallIds.length}]`
        }
        return s.kind
      }),
      segmentsCount: Array.isArray(row.segments) ? row.segments.length : 0,
      rowTextLen: String(row.text || '').length,
      rawTextLen: String(rawText || '').length,
      toolsCount: Array.isArray(row.tools) ? row.tools.length : 0,
      segmentsToolIds: Array.isArray(row.segments)
        ? row.segments.filter((s) => s.kind === 'tools').map((s) => s.ids?.length || 0)
        : [],
      toolStatus: Array.isArray(row.tools)
        ? row.tools.map((t) => String((t as { status?: unknown } | null)?.status || '?'))
        : [],
    },
  })
  // v5.10 visual-mirror：行级「页面长啥样」流水（sig 去重，变化才写）。
  logStreamCompareVisualMirror({
    sessionKey: compareSessionKey,
    runId: row.runId,
    foldOpen: domView.foldOpen,
    head: domView.head,
    gear: domView.gear,
    chunks: domView.chunks,
    fileChanges: domView.fileChanges,
    diag: {
      turnStartMsResolved,
      isStreamingEffective: !!isStreaming,
    },
  })
}

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
      durationLabel={workedLabelOut}
      turnInterrupted={turnInterrupted}
      liveTokenStr={row.tokenStr}
      messageId={row.messageId}
      runId={row.runId}
      threadBusy={!!threadBusy}
    />
  )
}