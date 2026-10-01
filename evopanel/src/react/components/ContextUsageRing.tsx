import { createPortal } from 'react-dom'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  contextUsageLevel,
  contextUsageRatio,
  type ContextUsageSnapshot,
} from '../lib/context-usage.js'
import type { TokenTotals } from '../chat-types.js'
import { cn } from '../lib/utils.js'

type Props = {
  usage: ContextUsageSnapshot | null
  tokenTotals?: TokenTotals | null
  compacting?: boolean
  className?: string
  /** Manual compaction from the open panel (DeepSeek: ring opens panel). */
  onManualCompact?: () => void
  manualCompactDisabled?: boolean
}

// ZCode-style constants (14px ring matching the toolbar icon size)
const ICON_RADIUS = 6
const ICON_VIEWBOX = 14
const ICON_CENTER = 7
const ICON_STROKE_WIDTH = 2

type ContextUsageBreakdownSource = 'messages' | 'system_prompt' | 'meta_user_context' | 'skills' | 'tool_prompt' | 'system_tool_schemas' | 'mcp_tool_schemas'

interface BreakdownsSegment {
  chars: number
  percent: number
  source: ContextUsageBreakdownSource
}

const CONTEXT_PROGRESS_TONE_COLORS = [
  '#6366f1', // indigo-500: messages / primary
  'color-mix(in oklab, #6366f1 78%, transparent)',
  'color-mix(in oklab, #6366f1 58%, transparent)',
  'color-mix(in oklab, #6366f1 42%, transparent)',
  'color-mix(in oklab, #6366f1 28%, transparent)',
] as const

const CACHE_HIT_RATE_DISPLAY_THRESHOLD = 0.78

const BREAKDOWN_SOURCE_LABEL: Record<ContextUsageBreakdownSource, string> = {
  messages: '对话消息',
  system_prompt: '系统提示词',
  meta_user_context: '用户上下文',
  skills: '技能',
  tool_prompt: '工具提示',
  system_tool_schemas: '系统工具',
  mcp_tool_schemas: 'MCP 工具',
}

const BREAKDOWN_SOURCE_ORDER: Record<ContextUsageBreakdownSource, number> = {
  messages: 0,
  system_prompt: 1,
  meta_user_context: 2,
  skills: 3,
  tool_prompt: 4,
  system_tool_schemas: 5,
  mcp_tool_schemas: 6,
}

// Build ZCode-style breakdown segments from snapshot
function buildContextUsageBreakdownSegments(
  breakdown: readonly { source: string; chars: number }[] | undefined,
): BreakdownsSegment[] {
  const charsBySource = new Map<ContextUsageBreakdownSource, number>()
  for (const item of breakdown ?? []) {
    const source = item.source as ContextUsageBreakdownSource
    const chars = Number(item.chars)
    if (!Number.isFinite(chars) || chars <= 0) continue
    charsBySource.set(source, (charsBySource.get(source) ?? 0) + chars)
  }
  const totalChars = [...charsBySource.values()].reduce((sum, c) => sum + c, 0)
  if (totalChars <= 0) return []
  return [...charsBySource.entries()]
    .map(([source, chars]) => ({ chars, percent: chars / totalChars, source }))
    .sort(
      (a, b) =>
        b.chars - a.chars ||
        BREAKDOWN_SOURCE_ORDER[a.source] - BREAKDOWN_SOURCE_ORDER[b.source],
    )
}

// Format compact token count (ZCode style: 10k, 1.2M)
function formatCompact(value: number): string {
  const v = Math.max(0, Math.round(value))
  if (v < 1000) return String(v)
  if (v < 1_000_000) return `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}k`
  return `${(v / 1_000_000).toFixed(1)}M`
}

// Cache hit rate label
function cacheHitRateLabel(rate: number | null | undefined): string | null {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return null
  if (rate < CACHE_HIT_RATE_DISPLAY_THRESHOLD) return null
  return `${Math.round(rate * 100)}%`
}

// Legacy cache from tokenTotals (EvoFlow original shape)
function legacyCacheLine(tokenTotals: TokenTotals | null | undefined): string | null {
  if (!tokenTotals) return null
  const hit = Math.max(0, Number(tokenTotals.cacheRead) || 0)
  const miss = Math.max(0, Number(tokenTotals.cacheMiss) || 0)
  const creation = Math.max(0, Number(tokenTotals.cacheCreation) || 0)
  if (hit <= 0 && miss <= 0 && creation <= 0) return null
  const denom = hit + miss
  const rate = denom > 0 ? `${((hit / denom) * 100).toFixed(0)}%` : null
  const parts: string[] = []
  if (rate) parts.push(`命中率 ${rate}`)
  if (hit > 0) parts.push(`命中 ${formatCompact(hit)}`)
  if (creation > 0) parts.push(`写入 ${formatCompact(creation)}`)
  if (miss > 0) parts.push(`未命中 ${formatCompact(miss)}`)
  return parts.join(' · ')
}

// ZCode-style ring icon component
function ContextRingIcon({ percent }: { percent: number }) {
  const circumference = 2 * Math.PI * ICON_RADIUS
  const dashOffset = circumference * (1 - Math.min(Math.max(percent, 0), 1))
  return (
    <svg
      aria-hidden="true"
      className="size-3.5"
      focusable="false"
      style={{ color: 'currentcolor' }}
      viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`}
    >
      <circle
        cx={ICON_CENTER}
        cy={ICON_CENTER}
        fill="none"
        opacity="0.25"
        r={ICON_RADIUS}
        stroke="currentColor"
        strokeWidth={ICON_STROKE_WIDTH}
      />
      <circle
        cx={ICON_CENTER}
        cy={ICON_CENTER}
        fill="none"
        opacity="0.7"
        r={ICON_RADIUS}
        stroke="currentColor"
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        strokeWidth={ICON_STROKE_WIDTH}
        style={{ transform: 'rotate(-90deg)', transformOrigin: 'center' }}
      />
    </svg>
  )
}

export function ContextUsageRing({
  usage,
  tokenTotals = null,
  compacting = false,
  className = '',
  onManualCompact,
  manualCompactDisabled = false,
}: Props) {
  const [displayRatio, setDisplayRatio] = useState(0)
  const [open, setOpen] = useState(false)
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const prevUsedRef = useRef(0)

  // Create / destroy a dedicated div in document.body for the portal panel
  useEffect(() => {
    const host = document.createElement('div')
    host.setAttribute('data-context-usage-ring-portal', 'true')
    document.body.appendChild(host)
    setPortalRoot(host)
    return () => {
      document.body.removeChild(host)
    }
  }, [])

  const targetRatio = useMemo(() => {
    if (!usage || usage.windowTokens <= 0) return 0
    return contextUsageRatio(usage.usedTokens, usage.windowTokens)
  }, [usage])

  const available = !!(usage && usage.windowTokens > 0 && usage.usedTokens > 0)

  useEffect(() => {
    if (!usage) {
      queueMicrotask(() => setDisplayRatio(0))
      prevUsedRef.current = 0
      return
    }
    const shrunk = usage.compacted && usage.usedTokens < prevUsedRef.current
    prevUsedRef.current = usage.usedTokens
    if (shrunk) {
      const id = window.requestAnimationFrame(() => setDisplayRatio(targetRatio))
      return () => window.cancelAnimationFrame(id)
    }
    setDisplayRatio(targetRatio)
  }, [usage, targetRatio])

  useEffect(() => {
    if (!available && open) setOpen(false)
  }, [available, open])

  if (!available || !usage) return null

  const level = contextUsageLevel(displayRatio)
  const pctLabel = Math.round(displayRatio * 100)
  const usedTokens = usage.usedTokens
  const contextWindow = usage.windowTokens

  // ZCode-style summary label
  const compactSummaryLabel = `${formatCompact(usedTokens)} / ${formatCompact(contextWindow)} (${pctLabel}%)`

  // Breakdown segments (from ZCode breakdown or legacy fallback)
  const breakdownSegments = useMemo(() => {
    if (usage.breakdown && usage.breakdown.length > 0) {
      return buildContextUsageBreakdownSegments(usage.breakdown)
    }
    // Legacy fallback: build from system/tools/messages tokens
    const charsBySource: Map<ContextUsageBreakdownSource, number> = new Map()
    const addLegacy = (source: ContextUsageBreakdownSource, tokens: number | null | undefined) => {
      if (tokens != null && tokens > 0) charsBySource.set(source, tokens)
    }
    addLegacy('system_prompt', usage.systemTokens)
    addLegacy('tool_prompt', usage.toolsTokens)
    addLegacy('messages', usage.messageTokens)
    const total = [...charsBySource.values()].reduce((s, c) => s + c, 0)
    if (total <= 0) return []
    return [...charsBySource.entries()]
      .map(([source, chars]) => ({ chars, percent: chars / total, source }))
      .sort((a, b) => b.chars - a.chars || BREAKDOWN_SOURCE_ORDER[a.source] - BREAKDOWN_SOURCE_ORDER[b.source])
  }, [usage])

  // Cache hit rate
  const cacheHitRate = usage.cache?.hitRate ?? null
  const cacheHitRateStr = cacheHitRateLabel(cacheHitRate)
  const legacyCacheLineStr = legacyCacheLine(tokenTotals)

  // Prompt / completion tokens from tokenTotals
  const promptTokens =
    tokenTotals != null && Number.isFinite(Number(tokenTotals.input))
      ? Math.max(0, Math.round(Number(tokenTotals.input)))
      : null
  const completionTokens =
    tokenTotals != null && Number.isFinite(Number(tokenTotals.output))
      ? Math.max(0, Math.round(Number(tokenTotals.output)))
      : null

  // Message / tool counts
  const messageCount =
    usage?.messageCount != null && Number.isFinite(Number(usage.messageCount))
      ? Math.max(0, Math.round(Number(usage.messageCount)))
      : null
  const toolCount =
    usage?.toolCount != null && Number.isFinite(Number(usage.toolCount))
      ? Math.max(0, Math.round(Number(usage.toolCount)))
      : null

  // Compact note
  const compactNote = (() => {
    if (usage.beforeTokens != null && usage.beforeTokens > usage.usedTokens) {
      return `已压缩 ${formatCompact(usage.beforeTokens)} → ${formatCompact(usage.usedTokens)}`
    }
    if (usage.compacted) return '上下文已压缩'
    return null
  })()

  const percentFormatter = useMemo(
    () =>
      new Intl.NumberFormat(undefined, {
        maximumFractionDigits: 1,
        style: 'percent',
      }),
    [],
  )

  // Compute portal panel position: anchored above the button
  const panelStyle = (() => {
    if (!rootRef.current) return {}
    const rect = rootRef.current.getBoundingClientRect()
    return {
      position: 'fixed' as const,
      left: rect.left,
      top: rect.top - 6,
      transform: 'translateY(-100%)',
    }
  })()

  const panel = open && portalRoot ? (
    <div
      className="react-chat-context-ring-panel react-chat-context-ring-panel--zcode"
      role="dialog"
      aria-label="上下文占用"
      style={panelStyle}
      onMouseLeave={() => setOpen(false)}
    >
      {/* Header: title + summary */}
      <div className="react-chat-ctx-zcode-header">
        <span className="react-chat-ctx-zcode-title">上下文</span>
        <span className="react-chat-ctx-zcode-summary">{compactSummaryLabel}</span>
      </div>

      {/* Compact note if any */}
      {compactNote ? (
        <p className="react-chat-ctx-zcode-compact-note">{compactNote}</p>
      ) : null}

      {/* Message / tool counts */}
      {(messageCount != null && messageCount > 0) || (toolCount != null && toolCount > 0) ? (
        <p className="react-chat-ctx-zcode-counts" title="进入模型上下文的消息条数 / 绑定工具数">
          {[
            messageCount != null && messageCount > 0 ? `${messageCount} 条消息` : null,
            toolCount != null && toolCount > 0 ? `${toolCount} 个工具` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      ) : null}

      {/* Breakdown rows */}
      {breakdownSegments.length > 0 ? (
        <div className="react-chat-ctx-zcode-breakdown">
          {breakdownSegments.map((seg, index) => (
            <div key={seg.source} className="react-chat-ctx-zcode-breakdown-row">
              <span
                className="react-chat-ctx-zcode-breakdown-dot"
                style={{ backgroundColor: CONTEXT_PROGRESS_TONE_COLORS[Math.min(index, CONTEXT_PROGRESS_TONE_COLORS.length - 1)] }}
              />
              <span className="react-chat-ctx-zcode-breakdown-label">
                {BREAKDOWN_SOURCE_LABEL[seg.source] ?? seg.source}
              </span>
              <span className="react-chat-ctx-zcode-breakdown-pct">
                {percentFormatter.format(seg.percent)}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {/* Cache hit rate */}
      {cacheHitRateStr ? (
        <p className="react-chat-ctx-zcode-cache">
          缓存命中率 <span>{cacheHitRateStr}</span>
        </p>
      ) : null}

      {/* Legacy cache line */}
      {legacyCacheLineStr && !cacheHitRateStr ? (
        <p className="react-chat-ctx-zcode-cache">缓存 {legacyCacheLineStr}</p>
      ) : null}

      {/* Prompt / completion tokens */}
      {promptTokens != null || completionTokens != null ? (
        <dl className="react-chat-ctx-zcode-tokens">
          {promptTokens != null ? (
            <div className="react-chat-ctx-zcode-token-row">
              <dt>Prompt Tokens</dt>
              <dd>{formatCompact(promptTokens)}</dd>
            </div>
          ) : null}
          {completionTokens != null ? (
            <div className="react-chat-ctx-zcode-token-row">
              <dt>Completion Tokens</dt>
              <dd>{formatCompact(completionTokens)}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {/* Manual compact button */}
      {onManualCompact ? (
        <button
          type="button"
          className="react-chat-ctx-zcode-compact-btn"
          disabled={manualCompactDisabled || compacting}
          onClick={(e) => {
            e.stopPropagation()
            onManualCompact()
          }}
        >
          {compacting || manualCompactDisabled ? '压缩中' : '压缩上下文'}
        </button>
      ) : null}
    </div>
  ) : null

  return (
    <>
      <span
        ref={rootRef}
        className={cn('react-chat-context-ring-wrap', className)}
        onMouseEnter={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        {/* ZCode-style circular trigger button */}
        <button
          type="button"
          className={cn(
            'react-chat-context-ring react-chat-context-ring--zcode',
            `react-chat-context-ring--${level}`,
            compacting && 'is-compacting',
            usage.compacted && 'is-compacted',
          )}
          aria-label={`今日余额 ${compactSummaryLabel}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-chat-toolbar-popover-trigger="true"
          data-testid="chat-context-usage-trigger"
          data-state={open ? 'open' : 'closed'}
          title={open ? undefined : compactSummaryLabel}
          data-tauri-no-drag
        >
          <ContextRingIcon percent={displayRatio} />
        </button>
      </span>
      {portalRoot ? createPortal(panel, portalRoot) : null}
    </>
  )
}
