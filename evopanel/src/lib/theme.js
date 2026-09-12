/**
 * 主题管理（日间/夜间模式 + 跟随系统）
 * 持久化：``evoflow_app_settings`` → ``panel.ui.theme``
 */
import { getPanelSetting, patchPanelSettings } from './panel-settings.js'

const THEME_KEY = 'evopanel-theme'

function emitThemePreferenceChanged() {
  window.dispatchEvent(new CustomEvent('evopanel-theme-pref-changed'))
}

function effectiveFromMedia() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** @returns {'light' | 'dark' | 'system'} */
export function getThemePreference() {
  const v = getPanelSetting('theme', 'system')
  if (v === 'light' || v === 'dark') return v
  return 'system'
}

/** @param {'light' | 'dark' | 'system'} pref */
export function setThemePreference(pref) {
  const next = pref === 'light' || pref === 'dark' ? pref : 'system'
  try {
    localStorage.setItem(THEME_KEY, next)
  } catch {
    /* ignore */
  }
  document.documentElement.dataset.theme = next === 'system' ? effectiveFromMedia() : next
  void patchPanelSettings({ theme: next })
  emitThemePreferenceChanged()
}

export function initTheme() {
  const pref = getThemePreference()
  if (pref === 'system') {
    document.documentElement.dataset.theme = effectiveFromMedia()
    return
  }
  if (pref === 'light' || pref === 'dark') {
    document.documentElement.dataset.theme = pref
    return
  }
  if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
    document.documentElement.dataset.theme = 'light'
    return
  }
  document.documentElement.dataset.theme = effectiveFromMedia()
}

/** 在「跟随系统」或未写入偏好时，随 OS 明暗切换更新界面 */
export function attachSystemThemeListener() {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const pref = getThemePreference()
    if (pref === 'light' || pref === 'dark') return
    document.documentElement.dataset.theme = effectiveFromMedia()
  })
  window.addEventListener('evopanel:panel-settings-loaded', () => {
    const pref = getThemePreference()
    document.documentElement.dataset.theme =
      pref === 'system' ? effectiveFromMedia() : pref === 'dark' ? 'dark' : 'light'
    // 主题确定后再通知色卡重算 light/dark，避免先应用色卡再改 data-theme
    emitThemePreferenceChanged()
  })
  window.addEventListener('evopanel:panel-settings-changed', () => {
    const pref = getThemePreference()
    document.documentElement.dataset.theme =
      pref === 'system' ? effectiveFromMedia() : pref === 'dark' ? 'dark' : 'light'
    emitThemePreferenceChanged()
  })
}

export function toggleTheme() {
  const current = document.documentElement.dataset.theme || 'light'
  const next = current === 'dark' ? 'light' : 'dark'
  setThemePreference(next)
  return next
}

export function getTheme() {
  return document.documentElement.dataset.theme || 'light'
}
