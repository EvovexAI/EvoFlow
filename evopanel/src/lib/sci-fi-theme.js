/**
 * 科技风 (Sci-Fi Theme) 管理
 * 赛博朋克风格：深蓝黑底 + 霓虹青描边 + 网格 + 扫描线
 */
import { getPanelSetting, patchPanelSettings } from './panel-settings.js'

export const SCIFI_UI_EVENT = 'evopanel-scifi-ui-changed'
export const SCIFI_UI_PREF_KEY = 'sciFiUIEnabled'

/** 获取科技风开启状态 —— 默认 true(新装即科技风) */
export function getSciFiUIEnabled() {
  return !!getPanelSetting(SCIFI_UI_PREF_KEY, true)
}

/** 切换科技风 */
export function setSciFiUIEnabled(enabled) {
  const next = !!enabled
  void patchPanelSettings({ [SCIFI_UI_PREF_KEY]: next })
  applySciFiUIPreference(next)
  window.dispatchEvent(new CustomEvent(SCIFI_UI_EVENT, { detail: { enabled: next } }))
}

/** 切换（toggle） */
export function toggleSciFiUI() {
  setSciFiUIEnabled(!getSciFiUIEnabled())
}

/** 应用科技风偏好到 DOM */
export function applySciFiUIPreference(enabled) {
  const root = document.documentElement
  if (enabled) {
    root.dataset.scifiUi = '1'
  } else {
    root.dataset.scifiUi = '0'
  }
}

/** 初始化：启动时按偏好应用科技风 */
export function initSciFiUI() {
  const enabled = getSciFiUIEnabled()
  applySciFiUIPreference(enabled)

  // 液态玻璃开启时，提示用户二选一
  const lgEnabled = !!getPanelSetting('liquidGlassEnabled', false)
  if (enabled && lgEnabled) {
    // 科技风优先级更高，安静关闭液态玻璃
    // （不在这里自动关，避免副作用；由用户在设置里手动切换）
  }

  // 监听设置变化
  window.addEventListener('evopanel:panel-settings-loaded', () => {
    applySciFiUIPreference(getSciFiUIEnabled())
  })
  window.addEventListener('evopanel:panel-settings-changed', () => {
    applySciFiUIPreference(getSciFiUIEnabled())
  })
}
