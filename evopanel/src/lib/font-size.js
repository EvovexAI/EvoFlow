import { getPanelSetting, patchPanelSettings } from './panel-settings.js'

export const FONT_SIZE_EVENT = 'evopanel-font-size-changed'

const FONT_SCALE_KEY = 'evopanel-font-scale'
const MIN_FONT_SCALE = 0.75
const MAX_FONT_SCALE = 1.5
const DEFAULT_FONT_SCALE = 0.9
const BASE_FONT_SIZES = {
  xs: 11,
  sm: 13,
  md: 14,
  lg: 16,
  xl: 20,
  '2xl': 24,
}

function clampFontScale(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_FONT_SCALE
  return Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, n))
}

function legacyFontSizeToScale(value) {
  return {
    small: 0.92,
    medium: DEFAULT_FONT_SCALE,
    large: 1.12,
    'extra-large': 1.22,
  }[value] || DEFAULT_FONT_SCALE
}

function roundPx(value) {
  return Math.round(value * 10) / 10
}

export function normalizeFontScale(value) {
  return clampFontScale(value)
}

export function getFontScalePreference() {
  const configured = getPanelSetting('fontScale', null)
  if (configured != null) return normalizeFontScale(configured)
  return legacyFontSizeToScale(getPanelSetting('fontSize', 'medium'))
}

export function applyFontSizePreference(value = getFontScalePreference()) {
  const scale = normalizeFontScale(value)
  const root = document.documentElement
  root.dataset.fontSize = 'custom'
  root.style.setProperty('--font-size-xs', `${roundPx(BASE_FONT_SIZES.xs * scale)}px`)
  root.style.setProperty('--font-size-sm', `${roundPx(BASE_FONT_SIZES.sm * scale)}px`)
  root.style.setProperty('--font-size-md', `${roundPx(BASE_FONT_SIZES.md * scale)}px`)
  root.style.setProperty('--font-size-lg', `${roundPx(BASE_FONT_SIZES.lg * scale)}px`)
  root.style.setProperty('--font-size-xl', `${roundPx(BASE_FONT_SIZES.xl * scale)}px`)
  root.style.setProperty('--font-size-2xl', `${roundPx(BASE_FONT_SIZES['2xl'] * scale)}px`)
  root.style.setProperty('--chat-font-size-base', `${roundPx(14 * scale)}px`)
  root.style.setProperty('--chat-font-size-xs', `${roundPx(10 * scale)}px`)
  root.style.setProperty('--chat-font-size-sm', `${roundPx(11 * scale)}px`)
  root.style.setProperty('--chat-font-size-md', `${roundPx(12 * scale)}px`)
  root.style.setProperty('--chat-font-size-lg', `${roundPx(13 * scale)}px`)
}

export function previewFontScale(value) {
  applyFontSizePreference(value)
}

export function setFontScalePreference(value) {
  const next = normalizeFontScale(value)
  try {
    localStorage.setItem(FONT_SCALE_KEY, String(next))
  } catch {
    /* ignore */
  }
  applyFontSizePreference(next)
  void patchPanelSettings({ fontScale: next })
  window.dispatchEvent(new CustomEvent(FONT_SIZE_EVENT, { detail: next }))
}

export function initFontSizePreference() {
  applyFontSizePreference()
  window.addEventListener('evopanel:panel-settings-loaded', () => applyFontSizePreference())
  window.addEventListener('evopanel:panel-settings-changed', () => applyFontSizePreference())
}
