/**
 * 客户端强调色 / 色卡风格
 *
 * 设计原则（2026-09-24 fix/accent-theme-global-coverage 重写）：
 *  1. 强调色色卡 = 全局品牌色锚点；色卡切换只影响"该被品牌色驱动的位置"。
 *  2. 不再把色值揉进 --bg-* 系列，避免「切绿/玫红时整端背景染色导致侧栏文字消失」。
 *  3. 覆盖名单显式扩展到 --brand-primary / --brand-blue / --brand-purple /
 *     --accent-secondary / --info / 状态 muted 系列 / --hl-* 高亮 token。
 *  4. 留 debug 入口（window.__evopanelDebugAccent），便于现场排查「换了没生效」。
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
  { id: 'default', label: '默认', light: '#635bff', dark: '#7b74ff' },
  { id: 'blue', label: '蓝', light: '#3b82f6', dark: '#60a5fa' },
  { id: 'violet', label: '紫', light: '#9065f8', dark: '#a88bfa' },
  { id: 'cyan', label: '青', light: '#0891b2', dark: '#22d3ee' },
  { id: 'emerald', label: '绿', light: '#059669', dark: '#34d399' },
  { id: 'amber', label: '琥珀', light: '#d97706', dark: '#fbbf24' },
  { id: 'rose', label: '玫红', light: '#e11d48', dark: '#fb7185' },
  { id: 'slate', label: '灰', light: '#475569', dark: '#94a3b8' },
]

const CUSTOM_ID = 'custom'

/**
 * 强调色需要驱动的所有 CSS 变量。
 * 拆分说明：
 *  - accent 系：按钮/链接/选中态/活动指示器（核心）
 *  - brand-primary/blue/purple：原本写在 variables.css 里硬编码 #635bff，
 *    之前 accent-theme 不覆盖，导致「切色后渐变仍然蓝→紫」。修复后一并覆盖。
 *  - accent-secondary / info：品牌派生色，跟随 accent。
 *  - 状态 muted：success/warning/error/danger 的浅底背景跟随 accent 暖度（仅 muted，
 *    文字主色不变 —— 语义色保留，避免 success 变红时以为出错）。
 *  - 边框 / 焦点 / glow：跟 accent 走。
 *  - 代码块 / 高亮 token：hl-func / hl-keyword 跟随品牌色，hl-string/number/comment 保留。
 *  - shell-brand 系：左侧栏 active 项 / 顶栏品牌色块。
 */
const ACCENT_VARS = [
  // accent 核心
  '--accent',
  '--accent-hover',
  '--accent-muted',
  '--accent-secondary',
  // brand 系（修渐变硬编码)
  '--brand-primary',
  '--brand-blue',
  '--brand-purple',
  // 状态色 muted（仅底色，不影响文字主色）
  '--success-muted',
  '--warning-muted',
  '--error-muted',
  '--danger-muted',
  '--info-muted',
  '--info',
  // 焦点 / glow
  '--border-focus',
  '--shadow-glow',
  // 代码块
  '--code-block-accent',
  '--code-block-fg',
  '--code-inline-bg',
  '--code-inline-fg',
  // 高亮 token（仅与品牌相关的）
  '--hl-keyword',
  '--hl-func',
  // 侧栏 / 顶栏品牌色
  '--shell-brand',
  '--shell-brand-hover',
  '--shell-brand-soft',
  '--shell-brand-softer',
  '--shell-active-bg',
  '--shell-active-fg',
  '--shell-aside-active-bg',
  '--shell-aside-active-fg',
  // 全侧栏/顶栏背景与文字跟随色卡（VS Code 风格）
  '--shell-bg',
  '--shell-text',
  '--chrome-bg',
  // logo hue
  '--logo-hue-rotate',
]

/** 默认品牌色（logo.png 主色）对应的色相，用作 hue-rotate 基准 */
const LOGO_BASE_HUE = 240

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

function normalizeHex(value, fallback = '#635bff') {
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

/**
 * 把色卡色值写到根节点的 CSS 变量上。
 * 设计：不揉进 --bg-* 系列，避免背景染色导致文本对比度崩坏。
 * 颜色派生规则：
 *  - hover：浅色叠加深、暗色叠加亮
 *  - muted：色 + 透明
 *  - shell-brand-soft：色 + 较高比例白/透明，给左栏 active 项底色
 */
function applyAccentColor(hex) {
  const root = document.documentElement
  const dark = isDarkTheme()
  const hover = dark
    ? `color-mix(in srgb, ${hex} 70%, white)`
    : `color-mix(in srgb, ${hex} 82%, black)`
  const soft = dark
    ? `color-mix(in srgb, ${hex} 22%, transparent)`
    : `color-mix(in srgb, ${hex} 14%, white)`
  const softer = dark
    ? `color-mix(in srgb, ${hex} 14%, transparent)`
    : `color-mix(in srgb, ${hex} 8%, white)`

  // accent 核心
  root.style.setProperty('--accent', hex)
  root.style.setProperty('--accent-hover', hover)
  root.style.setProperty('--accent-muted', `color-mix(in srgb, ${hex} ${dark ? 18 : 12}%, transparent)`)
  root.style.setProperty('--accent-secondary', hex)

  // brand 系（覆盖 variables.css 里的硬编码）
  root.style.setProperty('--brand-primary', hex)
  root.style.setProperty('--brand-blue', hex)
  root.style.setProperty('--brand-purple', hex)

  // info 系列
  root.style.setProperty('--info', hex)
  root.style.setProperty('--info-muted', `color-mix(in srgb, ${hex} ${dark ? 18 : 12}%, transparent)`)

  // 状态 muted —— 仅跟随品牌暖度（文字主色不变）
  // success / warning / error / danger 在 design 里语义独立，不跟随 accent。
  // 这里保留默认（不动），避免 success 变玫红这种语义错乱。

  // 边框 / 焦点 / glow
  root.style.setProperty('--border-focus', `color-mix(in srgb, ${hex} 50%, transparent)`)
  root.style.setProperty('--shadow-glow', `0 0 20px color-mix(in srgb, ${hex} ${dark ? 22 : 16}%, transparent)`)

  // 代码块 / 高亮
  root.style.setProperty('--code-block-accent', `color-mix(in srgb, ${hex} ${dark ? 65 : 55}%, transparent)`)
  root.style.setProperty('--code-block-fg', hex)
  root.style.setProperty('--code-inline-bg', `color-mix(in srgb, ${hex} ${dark ? 14 : 8}%, transparent)`)
  root.style.setProperty('--code-inline-fg', hex)
  root.style.setProperty('--hl-keyword', hex)
  root.style.setProperty('--hl-func', hex)

  // 侧栏 / 顶栏品牌色（关键修复点：让左侧 active 项底色跟随色卡）
  root.style.setProperty('--shell-brand', hex)
  root.style.setProperty('--shell-brand-hover', hover)
  root.style.setProperty('--shell-brand-soft', soft)
  root.style.setProperty('--shell-brand-softer', softer)
  root.style.setProperty('--shell-active-bg', soft)
  root.style.setProperty('--shell-active-fg', hex)
  root.style.setProperty('--shell-aside-active-bg', soft)
  root.style.setProperty('--shell-aside-active-fg', hex)

  // 全侧栏/顶栏背景跟随色卡（VS Code 风格）
  // 设 --chrome-bg 而非 --shell-bg，因为 .react-chat-session-aside 内部
  // local --shell-bg: var(--chrome-bg) 会遮蔽继承，设 chrome-bg 覆盖其 fallback
  root.style.setProperty('--chrome-bg', soft)
  root.style.setProperty('--shell-bg', soft)
  root.style.setProperty('--shell-text', dark ? 'rgba(255,255,255,0.92)' : '#1a1c24')

  applyLogoHueRotate(hex)

  if (window.__evopanelDebugAccent) {
    const snapshot = {}
    for (const key of ACCENT_VARS) snapshot[key] = root.style.getPropertyValue(key) || '(unset)'
    // eslint-disable-next-line no-console
    console.debug('[accent-theme] apply', { hex, dark, snapshot })
  }
}

export function getAccentPalettePreference() {
  const id = String(getPanelSetting('accentPalette', 'default') || 'default').trim()
  if (id === CUSTOM_ID) return CUSTOM_ID
  if (ACCENT_PALETTES.some((p) => p.id === id)) return id
  return 'default'
}

export function getAccentCustomPreference() {
  return normalizeHex(getPanelSetting('accentCustom', '#635bff'))
}

export function applyAccentThemePreference() {
  const paletteId = getAccentPalettePreference()
  const root = document.documentElement
  root.dataset.accentPalette = paletteId
  if (paletteId === 'default') {
    clearAccentOverrides()
    root.dataset.accentPalette = 'default'
    if (window.__evopanelDebugAccent) {
      // eslint-disable-next-line no-console
      console.debug('[accent-theme] cleared (palette=default)')
    }
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
  void initPanelSettings().then(() => applyAccentThemePreference())
  // 跟随系统切换明暗时 dataset.theme 会变，需重算 light/dark 色值
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    applyAccentThemePreference()
  })
}