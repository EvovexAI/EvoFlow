// @ts-nocheck — mechanical P142 extract.
/**
 * Set chat summary display mode and collapse right stage when opening panel.
 * Extracted from ChatApp.tsx (P142).
 *
 * 例外：工作流 / 节点 / 员工 / 浏览器进度签开着时，状态卡与侧栏可并存——
 * 否则 publishPlatformEntries → panel 模式会 collapse 掉刚打开的工作流侧栏
 * （表现为「对话一结束侧栏自己折起来了」）。
 */
import { isProgressStageKind } from '../../../lib/right-stage/open-progress-from-panel-set.js'
import { logRightStage } from '../../../lib/right-stage/panel-set-debug-log.js'
import { rightStageStore } from '../../../lib/right-stage/right-stage-store.js'

export type SetChatPanelDisplayModeCtx = Record<string, any>

function shouldKeepRightStageOpenWithPanel(): boolean {
  try {
    const snap = rightStageStore.getSnapshot?.() || {}
    const tabs = Array.isArray(snap.tabs) ? snap.tabs : []
    const kinds = [
      snap.surface?.kind,
      ...tabs.map((t) => t?.kind),
    ]
    return kinds.some((k) => {
      const kind = String(k || '').trim()
      return kind === 'browser' || isProgressStageKind(kind)
    })
  } catch {
    return false
  }
}

export function setChatPanelDisplayMode(
  ctx: SetChatPanelDisplayModeCtx,
  mode: string,
): void {
  ctx.setChatPanelMode(mode)
  ctx.saveChatSummaryDisplayMode(mode)
  if (mode === 'panel') {
    if (shouldKeepRightStageOpenWithPanel()) {
      // 进度签已在：状态卡可并存；若此前被误 fold，这里再展开。
      try {
        rightStageStore.expand?.()
      } catch {
        /* ignore */
      }
      logRightStage('setChatPanelDisplayMode:panel KEEP+expand right-stage (progress/browser)', {
        mode,
      }, { store: rightStageStore })
      return
    }
    // 悬浮卡与专用侧栏互斥：展开卡片时关掉侧栏（无进度签时）。
    logRightStage('setChatPanelDisplayMode:panel → collapseRightStage', { mode }, {
      stack: true,
      store: rightStageStore,
    })
    ctx.collapseRightStage()
  }
}
