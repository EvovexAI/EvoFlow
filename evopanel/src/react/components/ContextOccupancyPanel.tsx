import { useMemo, useState } from 'react'
import {
  contextBreakdownFromSnapshot,
  contextOccupancyFromSnapshot,
  formatContextTokensCompact,
  formatTokenCountDisplay,
  type ContextUsageSnapshot,
} from '../lib/context-usage.js'
import type { TokenTotals } from '../chat-types.js'

type Props = {
  usage: ContextUsageSnapshot | null
  tokenTotals?: TokenTotals | null
  onManualCompact?: () => void
  manualCompactDisabled?: boolean
  compacting?: boolean
  className?: string
}

function cacheHitLine(tokenTotals: TokenTotals | null | undefined): string | null {
  if (!tokenTotals) return null
  const hit = Math.max(0, Number(tokenTotals.cacheRead) || 0)
  const miss = Math.max(0, Number(tokenTotals.cacheMiss) || 0)
  const creation = Math.max(0, Number(tokenTotals.cacheCreation) || 0)
  if (hit <= 0 && miss <= 0 && creation <= 0) return null
  const denom = hit + miss
  const rate = denom > 0 ? `${((hit / denom) * 100).toFixed(0)}%` : null
  const parts: string[] = []
  if (rate) parts.push(`命中率 ${rate}`)
  if (hit > 0) parts.push(`命中 ${formatTokenCountDisplay(hit)}`)
  if (creation > 0) parts.push(`写入 ${formatTokenCountDisplay(creation)}`)
  if (miss > 0) parts.push(`未命中 ${formatTokenCountDisplay(miss)}`)
  return parts.join(' · ')
}

/** DeepSeek-style occupancy: % + figures + bar; developer details collapsed. */
export function ContextOccupancyPanel({
  usage,
  tokenTotals = null,
  onManualCompact,
  manualCompactDisabled = false,
  compacting = false,
  className = '',
}: Props) {
  const occupancy = useMemo(() => contextOccupancyFromSnapshot(usage), [usage])
  const breakdown = useMemo(() => contextBreakdownFromSnapshot(usage), [usage])
  const cacheLine = useMemo(() => cacheHitLine(tokenTotals), [tokenTotals])
  const [detailsOpen, setDetailsOpen] = useState(false)

  if (!occupancy) {
    return (
      <div className={`react-chat-ctx-meter${className ? ` ${className}` : ''}`}>
        <p className="react-chat-ctx-meter-hint">暂无上下文数据</p>
      </div>
    )
  }

  const { percent, usedTokens, contextWindow } = occupancy
  const breakdownTotal = breakdown
    ? breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens
    : 0
  const messageCount =
    usage?.messageCount != null && Number.isFinite(Number(usage.messageCount))
      ? Math.max(0, Math.round(Number(usage.messageCount)))
      : null
  const toolCount =
    usage?.toolCount != null && Number.isFinite(Number(usage.toolCount))
      ? Math.max(0, Math.round(Number(usage.toolCount)))
      : null
  const promptTokens =
    tokenTotals != null && Number.isFinite(Number(tokenTotals.input))
      ? Math.max(0, Math.round(Number(tokenTotals.input)))
      : null
  const completionTokens =
    tokenTotals != null && Number.isFinite(Number(tokenTotals.output))
      ? Math.max(0, Math.round(Number(tokenTotals.output)))
      : null
  const rows = [
    { key: 'system', label: '系统提示词', tokens: breakdown?.systemTokens ?? 0, tone: 'system' as const, countLabel: null as string | null },
    {
      key: 'tools',
      label: '工具',
      tokens: breakdown?.toolsTokens ?? 0,
      tone: 'tools' as const,
      countLabel: toolCount != null && toolCount > 0 ? `${toolCount} 个` : null,
    },
    {
      key: 'messages',
      label: '对话消息',
      tokens: breakdown?.messageTokens ?? 0,
      tone: 'messages' as const,
      countLabel: messageCount != null && messageCount > 0 ? `${messageCount} 条` : null,
    },
  ]
  const segments =
    !breakdown || breakdownTotal <= 0
      ? [{ key: 'total', tone: 'total' as const, width: percent }]
      : rows
          .map((row) => ({
            key: row.key,
            tone: row.tone,
            width: (percent * row.tokens) / breakdownTotal,
          }))
          .filter((s) => s.width > 0)

  const hasDeveloperDetails =
    Boolean(breakdown) ||
    Boolean(cacheLine) ||
    promptTokens != null ||
    completionTokens != null ||
    (toolCount != null && toolCount > 0)

  return (
    <div className={`react-chat-ctx-meter${className ? ` ${className}` : ''}`}>
      <div className="react-chat-ctx-meter-header">
        <span className="react-chat-ctx-meter-headline">上下文</span>
        <span className="react-chat-ctx-meter-percent">{percent}%</span>
        {onManualCompact ? (
          <button
            type="button"
            className="react-chat-ctx-meter-compact-btn"
            disabled={manualCompactDisabled || compacting}
            title="压缩上下文"
            onClick={(e) => {
              e.stopPropagation()
              onManualCompact()
            }}
          >
            {compacting || manualCompactDisabled ? '压缩中' : '压缩'}
          </button>
        ) : null}
        <span className="react-chat-ctx-meter-figures">
          {formatContextTokensCompact(usedTokens)} / {formatContextTokensCompact(contextWindow)} tokens
        </span>
      </div>
      <div className="react-chat-ctx-meter-bar" aria-hidden>
        {segments.map((seg) => (
          <div
            key={seg.key}
            className={`react-chat-ctx-meter-segment is-${seg.tone}`}
            style={{ width: `${seg.width}%` }}
          />
        ))}
      </div>
      {usage?.compacted ||
      (usage?.beforeTokens != null && usage.beforeTokens > usage.usedTokens) ? (
        <p className="react-chat-ctx-meter-compact-note">
          {usage.beforeTokens != null && usage.beforeTokens > usage.usedTokens
            ? `已压缩 ${formatContextTokensCompact(usage.beforeTokens)} → ${formatContextTokensCompact(usage.usedTokens)}`
            : '上下文已压缩'}
        </p>
      ) : null}
      {hasDeveloperDetails ? (
        <details
          className="react-chat-ctx-meter-details"
          open={detailsOpen}
          onToggle={(e) => setDetailsOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary>运行统计</summary>
          {(messageCount != null && messageCount > 0) || (toolCount != null && toolCount > 0) ? (
            <p className="react-chat-ctx-meter-counts" title="进入模型上下文的消息条数 / 绑定工具数">
              {[
                messageCount != null && messageCount > 0 ? `${messageCount} 条消息` : null,
                toolCount != null && toolCount > 0 ? `${toolCount} 个工具` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          ) : null}
          {breakdown ? (
            <dl className="react-chat-ctx-meter-rows">
              {rows.map((row) => (
                <div key={row.key} className="react-chat-ctx-meter-row">
                  <dt>
                    <span className={`react-chat-ctx-meter-swatch is-${row.tone}`} aria-hidden />
                    {row.label}
                    {row.countLabel ? (
                      <span className="react-chat-ctx-meter-count">{row.countLabel}</span>
                    ) : null}
                  </dt>
                  <dd>~{formatContextTokensCompact(row.tokens)}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="react-chat-ctx-meter-hint">跑一轮对话后显示系统 / 工具 / 消息拆分</p>
          )}
          {promptTokens != null || completionTokens != null ? (
            <dl className="react-chat-ctx-meter-rows">
              {promptTokens != null ? (
                <div className="react-chat-ctx-meter-row">
                  <dt>Prompt Tokens</dt>
                  <dd>{formatTokenCountDisplay(promptTokens)}</dd>
                </div>
              ) : null}
              {completionTokens != null ? (
                <div className="react-chat-ctx-meter-row">
                  <dt>Completion Tokens</dt>
                  <dd>{formatTokenCountDisplay(completionTokens)}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          {cacheLine ? (
            <p className="react-chat-ctx-meter-cache" title="本会话累计 Prompt Cache">
              缓存 {cacheLine}
            </p>
          ) : null}
        </details>
      ) : null}
    </div>
  )
}
