/**
 * Manual context compaction for the selected session.
 * Extracted from ChatApp.tsx (P21).
 */
import type { Dispatch, SetStateAction } from 'react'
import { toast } from '../../../components/toast.js'
import { requestManualContextCompaction } from '../../lib/manual-context-compaction.js'
import { mergeContextUsageSnapshots } from '../../lib/context-usage.js'
import type { ContextUsageSnapshot } from '../../lib/context-usage.js'

export type HandleManualContextCompactCtx = {
  selectedSessionKey: string
  manualContextCompacting: boolean
  setManualContextCompacting: (v: boolean) => void
  setContextUsageBySession: Dispatch<
    SetStateAction<Record<string, ContextUsageSnapshot>>
  >
}

export async function handleManualContextCompact(
  ctx: HandleManualContextCompactCtx,
): Promise<void> {
  const sk = String(ctx.selectedSessionKey || '').trim()
  if (!sk || ctx.manualContextCompacting) return
  ctx.setManualContextCompacting(true)
  try {
    const { snapshot, response } = await requestManualContextCompaction(sk)
    if (snapshot) {
      ctx.setContextUsageBySession((prev) => ({
        ...prev,
        [sk]: mergeContextUsageSnapshots(prev[sk], snapshot),
      }))
    }
    if (response.changed) {
      const saved =
        response.beforeGateTokens > response.afterGateTokens
          ? response.beforeGateTokens - response.afterGateTokens
          : 0
      toast(
        saved > 0
          ? `上下文已压缩（-${Math.round((saved / Math.max(response.beforeGateTokens, 1)) * 100)}%）`
          : '上下文已压缩',
        'success',
      )
    } else {
      toast('当前上下文无需压缩', 'info')
    }
  } catch (err) {
    toast(`压缩失败：${String((err as Error)?.message || err)}`, 'error')
  } finally {
    ctx.setManualContextCompacting(false)
  }
}
