export type ContextUsageSnapshot = {
  usedTokens: number
  windowTokens: number
  messageCount?: number
  pct: number
  beforeTokens?: number | null
  compacted?: boolean
  note?: string
  /** System prompt tokens (skills catalog lives here). */
  systemTokens?: number | null
  /** Bound tool schema tokens. */
  toolsTokens?: number | null
  /** Conversation history / surface tokens (backend-measured). */
  messageTokens?: number | null
  toolCount?: number | null
  updatedAt: number
}

export function formatContextTokenCount(n: number): string {
  const v = Math.max(0, Math.round(n))
  if (v >= 100_000) return `${(v / 1000).toFixed(0)}k`
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}k`
  return String(v)
}

/** DeepSeek-style compact figures: 32K / 1.2M (uppercase K/M). */
export function formatContextTokensCompact(n: number): string {
  const v = Math.max(0, Math.round(n))
  const scaled = (x: number): string => (x >= 100 ? String(Math.round(x)) : String(Math.round(x * 10) / 10))
  if (v < 1_000) return String(v)
  if (v < 1_000_000) return `${scaled(v / 1_000)}K`
  return `${scaled(v / 1_000_000)}M`
}

export type ContextOccupancy = {
  percent: number
  usedTokens: number
  contextWindow: number
}

/** DeepSeek `contextOccupancy`: need used + window; % capped at 100. */
export function contextOccupancyFromSnapshot(
  snap: Pick<ContextUsageSnapshot, 'usedTokens' | 'windowTokens' | 'pct'> | null | undefined,
): ContextOccupancy | null {
  if (!snap) return null
  const used = Number(snap.usedTokens)
  const window = Number(snap.windowTokens)
  if (!Number.isFinite(used) || !Number.isFinite(window) || window <= 0) return null
  if (used <= 0 && !(typeof snap.pct === 'number' && snap.pct > 0)) return null
  const percent =
    typeof snap.pct === 'number' && snap.pct > 0
      ? Math.min(100, Math.round(snap.pct))
      : Math.min(100, Math.round((used / window) * 100))
  return { percent, usedTokens: Math.max(0, used), contextWindow: window }
}

export type ContextBreakdown = {
  systemTokens: number
  toolsTokens: number
  messageTokens: number
}

/**
 * DeepSeek-style composition from backend-measured parts.
 * Prefers explicit ``messageTokens``; only falls back to remainder when missing.
 */
export function contextBreakdownFromSnapshot(
  snap: ContextUsageSnapshot | null | undefined,
): ContextBreakdown | null {
  if (!snap) return null
  const used = Math.max(0, Number(snap.usedTokens) || 0)
  const system = snap.systemTokens != null && Number.isFinite(Number(snap.systemTokens))
    ? Math.max(0, Math.round(Number(snap.systemTokens)))
    : null
  const tools = snap.toolsTokens != null && Number.isFinite(Number(snap.toolsTokens))
    ? Math.max(0, Math.round(Number(snap.toolsTokens)))
    : null
  const messagesExplicit =
    snap.messageTokens != null && Number.isFinite(Number(snap.messageTokens))
      ? Math.max(0, Math.round(Number(snap.messageTokens)))
      : null
  if (system == null && tools == null && messagesExplicit == null) return null
  const sys = system ?? 0
  const tool = tools ?? 0
  const messageTokens =
    messagesExplicit != null ? messagesExplicit : Math.max(0, used - sys - tool)
  return { systemTokens: sys, toolsTokens: tool, messageTokens }
}

/** Compact display for large session totals (e.g. 2.60M, 19.0k). */
export function formatTokenCountDisplay(n: number): string {
  const v = Math.max(0, Math.round(n))
  if (v >= 1_000_000) {
    const m = v / 1_000_000
    if (m >= 100) return `${Math.round(m)}M`
    if (m >= 10) return `${m.toFixed(1)}M`
    return `${m.toFixed(2)}M`
  }
  return formatContextTokenCount(v)
}

export type SessionTokenStats = {
  input: number
  output: number
  cacheRead?: number
  cacheCreation?: number
  cacheMiss?: number
}

export function contextUsageRatio(usedTokens: number, windowTokens: number): number {
  if (!windowTokens || windowTokens <= 0) return 0
  return Math.min(1, Math.max(0, usedTokens / windowTokens))
}

export function contextUsageLevel(ratio: number): 'low' | 'medium' | 'high' | 'critical' {
  if (ratio >= 0.92) return 'critical'
  if (ratio >= 0.78) return 'high'
  if (ratio >= 0.5) return 'medium'
  return 'low'
}

export function buildContextUsageTitle(
  snap: Pick<ContextUsageSnapshot, 'usedTokens' | 'windowTokens' | 'messageCount' | 'beforeTokens' | 'compacted'>,
): string {
  const used = formatContextTokenCount(snap.usedTokens)
  const window = formatContextTokenCount(snap.windowTokens)
  const pct = snap.windowTokens > 0 ? ((snap.usedTokens / snap.windowTokens) * 100).toFixed(1) : '0'
  let head = `模型上下文  ${used} / ${window} tok · ${pct}%`
  if (snap.messageCount != null && snap.messageCount > 0) {
    head += ` · ${snap.messageCount} 条消息`
  }
  const lines = [head]
  if (snap.beforeTokens != null && snap.beforeTokens > snap.usedTokens) {
    const saved = snap.beforeTokens - snap.usedTokens
    const savedPct = snap.beforeTokens > 0 ? ((saved / snap.beforeTokens) * 100).toFixed(1) : '0'
    lines.push(`压缩  ${formatContextTokenCount(snap.beforeTokens)} → ${used} · -${savedPct}%`)
  } else if (snap.compacted) {
    lines.push('压缩  已压缩上下文')
  }
  return lines.join('\n')
}

/** Session cumulative token + prompt-cache breakdown for header hover bubble. */
export function buildSessionTokenBubbleText(stats: SessionTokenStats): string {
  const lines: string[] = [
    `会话累计  输入 ${formatTokenCountDisplay(stats.input)} · 输出 ${formatTokenCountDisplay(stats.output)}`,
  ]
  const hit = Math.max(0, Number(stats.cacheRead) || 0)
  const miss = Math.max(0, Number(stats.cacheMiss) || 0)
  const creation = Math.max(0, Number(stats.cacheCreation) || 0)
  if (hit > 0 || miss > 0 || creation > 0) {
    const denom = hit + miss
    const rate = denom > 0 ? `${((hit / denom) * 100).toFixed(1)}%` : '—'
    const parts = [`命中率 ${rate}`]
    if (hit > 0) parts.push(`命中 ${formatTokenCountDisplay(hit)}`)
    if (creation > 0) parts.push(`写入 ${formatTokenCountDisplay(creation)}`)
    if (miss > 0) parts.push(`未命中 ${formatTokenCountDisplay(miss)}`)
    lines.push(`缓存  ${parts.join(' · ')}`)
  }
  return lines.join('\n')
}

export function buildHeaderMetricsBubbleText(
  contextUsage: Pick<
    ContextUsageSnapshot,
    'usedTokens' | 'windowTokens' | 'messageCount' | 'beforeTokens' | 'compacted'
  > | null,
  tokenTotals: SessionTokenStats | null,
): string {
  const sections: string[] = []
  if (contextUsage && contextUsage.windowTokens > 0) {
    if (contextUsage.usedTokens > 0) {
      sections.push(buildContextUsageTitle(contextUsage))
    } else {
      sections.push(
        `模型上下文窗口 ${formatContextTokenCount(contextUsage.windowTokens)} tok\n发送消息后显示实际占用`,
      )
    }
  }
  if (tokenTotals && (tokenTotals.input > 0 || tokenTotals.output > 0)) {
    sections.push(buildSessionTokenBubbleText(tokenTotals))
  }
  return sections.join('\n\n')
}

/** Restore persisted context usage from session ``context.context_usage`` (Gateway snake_case). */
export function parseContextUsageFromSessionContext(
  ctx: Record<string, unknown> | null | undefined,
): ContextUsageSnapshot | null {
  if (!ctx || typeof ctx !== 'object') return null
  const raw = ctx.context_usage ?? ctx.contextUsage
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const usedTokens = Number(o.used_tokens ?? o.usedTokens) || 0
  const windowTokens = Number(o.window_tokens ?? o.windowTokens) || 0
  if (windowTokens <= 0) return null
  const messageCountRaw = o.message_count ?? o.messageCount
  const messageCount =
    messageCountRaw != null && Number.isFinite(Number(messageCountRaw))
      ? Number(messageCountRaw)
      : undefined
  const beforeRaw = o.before_tokens ?? o.beforeTokens
  const beforeTokens =
    beforeRaw != null && Number.isFinite(Number(beforeRaw)) ? Number(beforeRaw) : null
  const pctRaw = Number(o.pct)
  const pct =
    Number.isFinite(pctRaw) && pctRaw >= 0
      ? pctRaw
      : Math.round((usedTokens / windowTokens) * 1000) / 10
  const updatedRaw = o.updated_at_ms ?? o.updatedAt
  const updatedAt =
    updatedRaw != null && Number.isFinite(Number(updatedRaw)) ? Number(updatedRaw) : 0
  return {
    usedTokens,
    windowTokens,
    messageCount,
    pct,
    beforeTokens,
    compacted: Boolean(o.compacted),
    note: String(o.note || ''),
    systemTokens: (() => {
      const v = Number(o.system_tokens ?? o.systemTokens)
      return Number.isFinite(v) && v >= 0 ? v : null
    })(),
    toolsTokens: (() => {
      const v = Number(o.tools_tokens ?? o.toolsTokens)
      return Number.isFinite(v) && v >= 0 ? v : null
    })(),
    messageTokens: (() => {
      const v = Number(o.message_tokens ?? o.messageTokens ?? o.history_tokens ?? o.historyTokens)
      return Number.isFinite(v) && v >= 0 ? v : null
    })(),
    toolCount: (() => {
      const v = Number(o.tool_count ?? o.toolCount)
      return Number.isFinite(v) && v >= 0 ? v : null
    })(),
    updatedAt,
  }
}

export function mergeContextUsageSnapshots(
  prev: ContextUsageSnapshot | undefined,
  next: ContextUsageSnapshot,
): ContextUsageSnapshot {
  if (!prev) return next
  if ((prev.updatedAt || 0) > (next.updatedAt || 0)) return prev
  // Prefer newer snapshot, but keep overhead breakdown if the newer event omitted it.
  return {
    ...next,
    systemTokens: next.systemTokens ?? prev.systemTokens ?? null,
    toolsTokens: next.toolsTokens ?? prev.toolsTokens ?? null,
    messageTokens: next.messageTokens ?? prev.messageTokens ?? null,
    toolCount: next.toolCount ?? prev.toolCount ?? null,
  }
}
