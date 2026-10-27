/**
 * 小V语音全屏：复用主对话 tools-scan 的 platform 右栏逻辑。
 *
 * 权威入口与旧 tools 扫描一致：`syncPlatformFeedbackFromTools`
 * （内部 applyPlatformFeedbackFromToolResult + maybeAutoOpenPlatformProgress）。
 * ui.show / artifacts / web-embed 本身由 ws-client → applyRightStageAgUiCustom 落地；
 * 本文件只补 V4 时间线缺席时的 platform 进度 autoOpen。
 */

import { syncPlatformFeedbackFromTools } from '../right-stage/platform-feedback.js'
import { rightStageStore } from '../right-stage/right-stage-store.js'
import { allowXwVoiceSummary, isXwVoiceMode } from '../xw-voice-mode.js'

/** @type {Set<string>} */
const _seen = new Set()

/**
 * @param {unknown[]} tools
 */
export function maybeAutoOpenXiaomiPlatformTools(tools) {
  if (!isXwVoiceMode()) return
  if (!Array.isArray(tools) || !tools.length) return

  const { shown } = syncPlatformFeedbackFromTools(tools, _seen, { existingEntries: [] })
  if (!shown.length) return

  // 平台工具已落地：允许状态卡；进度/壳页 show() 后若仍收起则展开（唤醒 left-only 竞态）
  allowXwVoiceSummary()
  try {
    if (rightStageStore.getSnapshot().collapsed) {
      rightStageStore.expand()
    }
  } catch {
    /* ignore */
  }

  if (_seen.size > 256) {
    const oldest = _seen.values().next().value
    if (oldest) _seen.delete(oldest)
  }
}

export function resetXiaomiPlatformAutoOpen() {
  _seen.clear()
}
