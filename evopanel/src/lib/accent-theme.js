/**
 * 客户端强调色 / 色卡风格
 * 持久化：panel.ui.accentPalette + accentCustom（并镜像 localStorage 供冷启动）
 */
import {
  getPanelSetting,
  patchPanelSettings,
  initPanelSettings,
  mirrorAccentToLocalStorage,
} from './panel-settings.js'

export const ACCENT_THEME_EVENT = 'evopanel-accent-theme-changed'

/** @typedef {{ id: string, label: string, light: string, dark: string }} AccentPalette */

/** @type {AccentPalette[]} */
export const ACCENT_PALETTES = [
  { id: 'default', label: '默认', light: '#5b5fef', dark: '#8186f5' },
  { id: 'blue', label: '蓝', light: '#5b5fef', dark: '#8186f5' },
  { id: 'violet', label: '紫', light: '#9065f8', dark: '#a88bfa' },
  { id: 'cyan', label: '青', light: '#0891b2', dark: '#22d3ee' },
  { id: 'emerald', label: '绿', light: '#059669', dark: '#34d399' },
  { id: 'amber', label: '琥珀', light: '#d97706', dark: '#fbbf24' },
  { id: 'rose', label: '玫红', light: '#e11d48', dark: '#fb7185' },
  { id: 'slate', label: '灰', light: '#777e92', dark: '#94a3b8' },
]

const CUSTOM_ID = 'custom'
const ACCENT_VARS = [
  '--accent',
  '--accent-hover',
  '--accent-muted',
  '--border-focus',
  '--shadow-glow',
  '--code-block-accent',
  '--code-inline-bg',
  // 侧栏 / 顶栏品牌色（与 --accent 同步，避免硬编码紫）
  '--shell-brand',
  '--shell-brand-hover',
  '--shell-brand-soft',
  // Logo 色相偏移（PNG 用 hue-rotate 跟随色卡）
  '--logo-hue-rotate',
  // 面板 / 背景氛围色
  '--bg-primary',
  '--bg-secondary',
  '--bg-tertiary',
  '--bg-card',
  '--bg-card-hover',
  '--bg-glass',
  '--bg-glass-hover',
  '--border-primary',
  '--border-secondary',
]

/** 默认品牌色（logo.png 主色）对应的色相，用作 hue-rotate 基准 */
const LOGO_BASE_HUE = 238

function hexToHue(hex) {
  const h = normalizeHex(hex)
  const r = parseInt(h.slice(1, 3), 16) / 255
  const g = parseInt(h.slice(3, 5), 16) / 255
  const b = parseInt(h.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max === min) return LOGO_BASE_HUE
  const d = max - min
  let hue = 0
  if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) hue = ((b - r) / d + 2) / 6
  else hue = ((r - g) / d + 4) / 6
  return hue * 360
}

function applyLogoHueRotate(hex) {
  const root = document.documentElement
  const rot = Math.round((((hexToHue(hex) - LOGO_BASE_HUE) % 360) + 360) % 360)
  if (!rot) {
    root.style.removeProperty('--logo-hue-rotate')
    return
  }
  root.style.setProperty('--logo-hue-rotate', `${rot}deg`)
}

function normalizeHex(value, fallback = '#5b5fef') {
  const raw = String(value || '').trim()
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase()
  if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
    const r = raw[1]
    const g = raw[2]
    const b = raw[3]
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }
  return fallback
}

function isDarkTheme() {
  return (document.documentElement.dataset.theme || 'light') === 'dark'
}

function resolvePaletteColor(paletteId, customHex) {
  if (paletteId === CUSTOM_ID) return normalizeHex(customHex)
  const found = ACCENT_PALETTES.find((p) => p.id === paletteId)
  if (!found || found.id === 'default') return null
  return isDarkTheme() ? found.dark : found.light
}

function clearAccentOverrides() {
  const root = document.documentElement
  for (const key of ACCENT_VARS) root.style.removeProperty(key)
  delete root.dataset.accentPalette
}

function applyAccentColor(hex) {
  const root = document.documentElement
  const dark = isDarkTheme()
  const hover = dark
    ? `color-mix(in srgb, ${hex} 70%, white)`
    : `color-mix(in srgb, ${hex} 82%, black)`
  root.style.setProperty('--accent', hex)
  root.style.setProperty('--accent-hover', hover)
  root.style.setProperty('--accent-muted', `color-mix(in srgb, ${hex} ${dark ? 18 : 12}%, transparent)`)
  root.style.setProperty('--shell-brand', hex)
  root.style.setProperty('--shell-brand-hover', hover)
  root.style.setProperty('--shell-brand-soft', `color-mix(in srgb, ${hex} ${dark ? 18 : 12}%, transparent)`)
  applyLogoHueRotate(hex)
  root.style.setProperty('--border-focus', `color-mix(in srgb, ${hex} 50%, transparent)`)
  root.style.setProperty('--shadow-glow', `0 0 20px color-mix(in srgb, ${hex} ${dark ? 18 : 12}%, transparent)`)
  root.style.setProperty('--code-block-accent', `color-mix(in srgb, ${hex} ${dark ? 65 : 55}%, transparent)`)
  root.style.setProperty('--code-inline-bg', `color-mix(in srgb, ${hex} ${dark ? 14 : 8}%, transparent)`)

  // 面板/背景：把色卡揉进主背景与卡片面，让整体氛围跟着变
  if (dark) {
    root.style.setProperty('--bg-primary', `color-mix(in srgb, ${hex} 14%, #07070c)`)
    root.style.setProperty('--bg-secondary', `color-mix(in srgb, ${hex} 12%, #101018)`)
    root.style.setProperty('--bg-tertiary', `color-mix(in srgb, ${hex} 16%, #171722)`)
    root.style.setProperty('--bg-card', `color-mix(in srgb, ${hex} 10%, transparent)`)
    root.style.setProperty('--bg-card-hover', `color-mix(in srgb, ${hex} 16%, transparent)`)
    root.style.setProperty('--bg-glass', `color-mix(in srgb, ${hex} 12%, transparent)`)
    root.style.setProperty('--bg-glass-hover', `color-mix(in srgb, ${hex} 18%, transparent)`)
    root.style.setProperty('--border-primary', `color-mix(in srgb, ${hex} 22%, rgba(255, 255, 255, 0.08))`)
    root.style.setProperty('--border-secondary', `color-mix(in srgb, ${hex} 14%, rgba(255, 255, 255, 0.04))`)
  } else {
    root.style.setProperty('--bg-primary', `color-mix(in srgb, ${hex} 6%, #f6f7fb)`)
    root.style.setProperty('--bg-secondary', `#f8f9fc`)
    root.style.setProperty('--bg-tertiary', `color-mix(in srgb, ${hex} 8%, #f0f2f7)`)
    root.style.setProperty('--bg-card', `#ffffff`)
    root.style.setProperty('--bg-card-hover', `color-mix(in srgb, ${hex} 6%, #f0f2f7)`)
    root.style.setProperty('--bg-glass', `color-mix(in srgb, ${hex} 6%, transparent)`)
    root.style.setProperty('--bg-glass-hover', `color-mix(in srgb, ${hex} 10%, transparent)`)
    root.style.setProperty('--border-primary', `color-mix(in srgb, ${hex} 12%, #e8eaf1)`)
    root.style.setProperty('--border-secondary', `color-mix(in srgb, ${hex} 8%, #f0f1f6)`)
  }
}

export function getAccentPalettePreference() {
  const id = String(getPanelSetting('accentPalette', 'default') || 'default').trim()
  if (id === CUSTOM_ID) return CUSTOM_ID
  if (ACCENT_PALETTES.some((p) => p.id === id)) return id
  return 'default'
}

export function getAccentCustomPreference() {
  return normalizeHex(getPanelSetting('accentCustom', '#5b5fef'))
}

export function applyAccentThemePreference() {
  const paletteId = getAccentPalettePreference()
  const root = document.documentElement
  root.dataset.accentPalette = paletteId
  if (paletteId === 'default') {
    clearAccentOverrides()
    root.dataset.accentPalette = 'default'
    return
  }
  const hex = resolvePaletteColor(paletteId, getAccentCustomPreference())
  if (!hex) {
    clearAccentOverrides()
    return
  }
  applyAccentColor(hex)
}

/** 仅预览自定义色，不写入持久化 */
export function previewAccentCustom(hex) {
  const next = normalizeHex(hex)
  document.documentElement.dataset.accentPalette = 'custom'
  applyAccentColor(next)
}

export function setAccentPalettePreference(paletteId) {
  const next = String(paletteId || 'default').trim()
  const id = next === CUSTOM_ID || ACCENT_PALETTES.some((p) => p.id === next) ? next : 'default'
  mirrorAccentToLocalStorage(id, id === CUSTOM_ID ? getAccentCustomPreference() : undefined)
  void patchPanelSettings({ accentPalette: id })
  applyAccentThemePreference()
  window.dispatchEvent(new CustomEvent(ACCENT_THEME_EVENT, { detail: { accentPalette: id } }))
}

export function setAccentCustomPreference(hex) {
  const next = normalizeHex(hex)
  mirrorAccentToLocalStorage(CUSTOM_ID, next)
  void patchPanelSettings({ accentPalette: CUSTOM_ID, accentCustom: next })
  applyAccentThemePreference()
  window.dispatchEvent(new CustomEvent(ACCENT_THEME_EVENT, { detail: { accentPalette: CUSTOM_ID, accentCustom: next } }))
}

export function initAccentThemePreference() {
  applyAccentThemePreference()
  window.addEventListener('evopanel:panel-settings-loaded', () => applyAccentThemePreference())
  window.addEventListener('evopanel:panel-settings-changed', () => applyAccentThemePreference())
  window.addEventListener('evopanel-theme-pref-changed', () => applyAccentThemePreference())
  // 显式等待面板设置加载完成后再应用一次，避免时序问题导致持久化的色卡未生效
  void initPanelSettings().then(() => applyAccentThemePreference())
  // 跟随系统切换明暗时 dataset.theme 会变，需重算 light/dark 色值
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    applyAccentThemePreference()
  })
}
