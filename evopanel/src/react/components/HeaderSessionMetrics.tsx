import { AnimatedTokenDisplay } from './AnimatedTokenDisplay.js'
import { ContextUsageRing } from './ContextUsageRing.js'
import { HoverBubble } from './HoverBubble.js'
import { buildHeaderMetricsBubbleText, type ContextUsageSnapshot } from '../lib/context-usage.js'
import type { TokenTotals } from '../chat-types.js'

type Props = {
  contextUsage: ContextUsageSnapshot | null
  tokenTotals: TokenTotals | null
  compacting?: boolean
  tokenAnimating?: boolean
  onManualCompact?: () => void
  manualCompactDisabled?: boolean
}

export function HeaderSessionMetrics({
  contextUsage,
  tokenTotals,
  compacting = false,
  tokenAnimating = false,
  onManualCompact,
  manualCompactDisabled = false,
}: Props) {
  const hasTokens = !!(tokenTotals && tokenTotals.total > 0)
  const hasContextUsage = !!(
    contextUsage &&
    contextUsage.windowTokens > 0 &&
    contextUsage.usedTokens > 0
  )
  if (!hasTokens && !hasContextUsage) return null

  // Token totals keep the old hover bubble; context ring opens its own panel.
  const tokenBubble = hasTokens
    ? buildHeaderMetricsBubbleText(null, tokenTotals)
    : ''

  return (
    <div className="react-chat-header-metrics" data-tauri-no-drag>
      {hasContextUsage ? (
        <ContextUsageRing
          usage={contextUsage}
          tokenTotals={tokenTotals}
          compacting={compacting}
          onManualCompact={onManualCompact}
          manualCompactDisabled={manualCompactDisabled}
        />
      ) : null}
      {hasTokens ? (
        <HoverBubble text={tokenBubble} side="bottom" align="end" maxWidth={420} disabled={!tokenBubble}>
          <AnimatedTokenDisplay
            className="react-chat-tokens"
            input={tokenTotals!.input}
            output={tokenTotals!.output}
            total={tokenTotals!.total}
            cacheRead={tokenTotals!.cacheRead}
            animate={tokenAnimating}
          />
        </HoverBubble>
      ) : null}
    </div>
  )
}
