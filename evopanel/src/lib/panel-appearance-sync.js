/**
 * 将 platform 工具（appearance.patch 等）写入的 panel.ui 同步到当前 EvoPanel 界面。
 */
import {
  applyPanelSettingsFromRemote,
  cancelPendingPanelSettingsPatch,
  reloadPanelSettings,
} from './panel-settings.js'

function parseToolResultObject(raw) {
  if (!raw) return null
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw
  const text = String(raw || '').trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function parseArgsAction(argsText) {
  const text = String(argsText || '').trim()
  if (!text) return ''
  try {
    const args = JSON.parse(text)
    return String(args?.action || '').trim().toLowerCase()
  } catch {
    return ''
  }
}

function shouldSyncAppearance(obj, argsText) {
  if (!obj || obj.ok === false) return false
  const action = String(obj.action || '').trim().toLowerCase()
  if (obj.client_effect === 'panel_settings') return true
  if (action === 'appearance.patch') return true
  if (parseArgsAction(argsText) === 'appearance.patch') return true
  return false
}

/**
 * @param {unknown} raw 工具返回 JSON 字符串或对象
 * @param {{ argsText?: string }} [opts]
 * @returns {Promise<boolean>} 是否已触发外观同步
 */
export async function syncPanelAppearanceFromToolResult(raw, opts = {}) {
  const obj = parseToolResultObject(raw)
  if (!shouldSyncAppearance(obj, opts?.argsText)) return false

  cancelPendingPanelSettingsPatch()

  const settings = obj?.settings
  if (settings && typeof settings === 'object' && Object.keys(settings).length) {
    applyPanelSettingsFromRemote(settings)
  }

  await reloadPanelSettings({ force: true })
  return true
}

/**
 * 监听全局 platform 工具结果（含 GlobalAssistant 等入口）。
 */
export function initPanelAppearanceSync() {
  if (typeof window === 'undefined') return
  window.addEventListener('evopanel:platform-tool-result', (ev) => {
    const detail = ev?.detail
    const raw = detail?.result ?? detail?.content ?? detail
    const argsText = detail?.argsText ?? detail?.args
    void syncPanelAppearanceFromToolResult(raw, { argsText })
  })
}
