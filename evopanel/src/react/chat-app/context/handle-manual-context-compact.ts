/**
 * Manual context compaction for the selected session.
 * Extracted from ChatApp.tsx (P21).
 */
import type { Dispatch, SetStateAction } from 'react'
import { toast } from '../../../components/toast.js'
import { requestManualContextCompaction } from '../../lib/manual-context-compaction.js'
import { mergeContextUsageSnapshots } from '../../lib/context-usage.js'
import type { ContextUsageSnapshot } from '../../lib/context-usage.js'
import {
  dispatchSessionTurnEvent,
  resetSessionLiveStreamDisplay,
} from '../../lib/session-runtime-store.js'
import {
  clearSessionExecutionProbe,
  fetchAndCacheSessionExecutionState,
} from '../../lib/session-execution/probe-cache.js'
import { setV4TimelineBusy } from '../../v4/v4-timeline-busy-store.js'

export type HandleManualContextCompactCtx = {
  selectedSessionKey: string
  manualContextCompacting: boolean
  setManualContextCompacting: (v: boolean) => void
  setContextUsageBySession: Dispatch<
    SetStateAction<Record<string, ContextUsageSnapshot>>
  >
}

/** 压缩是维护动作，不是对话 turn；结束后清掉可能钉住停止钮的残留 busy。 */
function settleUiAfterManualCompact(sessionKey: string): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  try {
    resetSessionLiveStreamDisplay(sk)
    dispatchSessionTurnEvent(sk, { type: 'TURN_IDLE' })
    setV4TimelineBusy(sk, false)
    clearSessionExecutionProbe(sk)
  } catch {
    /* best-effort */
  }
  void fetchAndCacheSessionExecutionState(sk).catch(() => {
    /* best-effort */
  })
  // 触发 V4 soft catchup：后端 compact 已 catchup settle control；这里再拉一次投影。
  try {
    const tid =
      typeof document !== "undefined"
        ? String(
            document
              .querySelector('[data-v4-chat-host-visible="1"]')
              ?.getAttribute("data-v4-chat-host") || "",
          ).trim()
        : ""
    if (tid) {
      void import("../../v4/V4StreamRowsBridge.js").then((m) => {
        m.refreshEvoflowV4Session?.(tid, { softIntervalMs: 500 })
      })
    }
  } catch {
    /* best-effort */
  }
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
    settleUiAfterManualCompact(sk)
  }
}
