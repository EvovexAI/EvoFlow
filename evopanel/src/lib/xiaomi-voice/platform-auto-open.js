/**
 * 小V语音全屏：复用主对话 tools-scan 的 platform 右栏逻辑。
 *
 * 权威入口与旧 tools 扫描一致：`syncPlatformFeedbackFromTools`
 * （内部 applyPlatformFeedbackFromToolResult + maybeAutoOpenPlatformProgress）。
 * ui.show / artifacts / web-embed 本身由 ws-client → applyRightStageAgUiCustom 落地；
 * 本文件只补 V4 时间线缺席时的 platform 进度 autoOpen。
 */

import { logRightStage } from '../right-stage/panel-set-debug-log.js'
import {
  parsePlatformUiFeedback,
  syncPlatformFeedbackFromTools,
  tryAutoOpenPlatformProgress,
} from '../right-stage/platform-feedback.js'
import { rightStageStore } from '../right-stage/right-stage-store.js'
import { allowXwVoiceSummary, isXwVoiceMode } from '../xw-voice-mode.js'

/** @type {Set<string>} */
const _seen = new Set()

/**
 * @param {Record<string, unknown>} row
 */
function rebuildFromPlatformUi(row) {
  const ui =
    (row.platform_ui && typeof row.platform_ui === 'object' && !Array.isArray(row.platform_ui)
      ? row.platform_ui
      : null) ||
    (row.platformUi && typeof row.platformUi === 'object' && !Array.isArray(row.platformUi)
      ? row.platformUi
      : null)
  if (!ui) return null
  return {
    ok: row.platform_ok !== false && row.platformOk !== false,
    action: row.platform_action || row.platformAction || ui.action,
    item: row.platform_item || row.platformItem,
    agent: row.platform_agent || row.platformAgent,
    role: row.platform_role || row.platformRole,
    ui,
  }
}

/**
 * @param {unknown[]} tools
 */
export function maybeAutoOpenXiaomiPlatformTools(tools) {
  if (!isXwVoiceMode()) {
    logRightStage('xiaomi platform autoOpen skipped', { reason: 'not-xw-voice' })
    return
  }
  if (!Array.isArray(tools) || !tools.length) return

  const platformRows = tools.filter((t) => {
    if (!t || typeof t !== 'object') return false
    const name = String(
      /** @type {Record<string, unknown>} */ (t).name ||
        /** @type {Record<string, unknown>} */ (t).tool_kind ||
        '',
    )
      .trim()
      .toLowerCase()
    return name === 'platform'
  })
  if (!platformRows.length) return

  const beforeSeen = _seen.size
  const { shown } = syncPlatformFeedbackFromTools(tools, _seen, { existingEntries: [] })
  logRightStage('xiaomi platform autoOpen scan', {
    platformCount: platformRows.length,
    shownCount: shown.length,
    newlySeen: _seen.size - beforeSeen,
    sample: platformRows.slice(0, 3).map((t) => {
      const row = /** @type {Record<string, unknown>} */ (t)
      return {
        id: String(row.id || row.toolCallId || row.tool_call_id || '').trim(),
        status: row.status,
        phase: row._aguiPhase,
        hasPlatformUi: Boolean(row.platform_ui || row.platformUi),
        outputType: typeof row.output,
        outputLen: typeof row.output === 'string' ? row.output.length : row.output != null ? 1 : 0,
      }
    }),
  })

  // sync 未解析出反馈时：用 platform_ui 旁路再试（正文被 slim 空时）
  if (!shown.length) {
    for (const raw of platformRows) {
      const row = /** @type {Record<string, unknown>} */ (raw)
      const id = String(row.id || row.toolCallId || row.tool_call_id || '').trim()
      if (id && _seen.has(id)) continue
      const rebuilt = rebuildFromPlatformUi(row)
      const output =
        rebuilt ||
        (typeof row.output === 'string'
          ? row.output
          : row.output && typeof row.output === 'object'
            ? row.output
            : null)
      if (!output) {
        logRightStage('xiaomi platform autoOpen miss', {
          id,
          reason: 'no-output-no-platform_ui',
        })
        if (id) _seen.add(id)
        continue
      }
      const argsText =
        typeof row.argsText === 'string'
          ? row.argsText
          : typeof row.input === 'string'
            ? row.input
            : row.input && typeof row.input === 'object'
              ? JSON.stringify(row.input)
              : undefined
      const ui = parsePlatformUiFeedback(output, argsText)
      const diag = tryAutoOpenPlatformProgress(ui)
      logRightStage('xiaomi platform autoOpen fallback', {
        id,
        opened: diag.opened,
        reason: diag.reason,
        action: diag.action,
        actions: diag.actions,
      })
      if (id) _seen.add(id)
      if (diag.opened) {
        allowXwVoiceSummary()
        if (rightStageStore.getSnapshot().collapsed) rightStageStore.expand()
      }
    }
    return
  }

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
