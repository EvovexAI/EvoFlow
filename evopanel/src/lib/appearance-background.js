/**
 * 客户端自定义背景图 + 不透明度
 * 路径持久化：panel.ui.backgroundImage / backgroundOpacity
 * Web 选图的 data URL 存 localStorage，避免撑爆 SQLite
 */
import { getPanelSetting, patchPanelSettings } from './panel-settings.js'

function isLiquidGlassWallpaperActive() {
  return !!getPanelSetting('liquidGlassEnabled', false)
}

export const BACKGROUND_EVENT = 'evopanel-background-changed'

const LS_BG_DATA = 'evopanel-bg-image-data'
const LS_BG_VIDEO_DATA = 'evopanel-bg-video-data'
const LOCAL_MARKER = '__local__'
const LOCAL_VIDEO_MARKER = '__local_video__'
const LOCAL_VIDEO_SESSION_MARKER = '__local_video_session__'
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_VIDEO_BYTES = 50 * 1024 * 1024
const MAX_VIDEO_DATA_URL_BYTES = 12 * 1024 * 1024

/** @type {string} */
let _sessionVideoBlobUrl = ''
const DEFAULT_BG_URL = '/assets/evoflow_card_png_assets/home_background.png'
const MIN_OPACITY = 0.05
const MAX_OPACITY = 1
const DEFAULT_OPACITY = 0.35

/** @type {((path: string) => string) | null} */
let _convertFileSrc = null
if (typeof window !== 'undefined') {
  import('@tauri-apps/api/core')
    .then((m) => {
      _convertFileSrc = typeof m.convertFileSrc === 'function' ? m.convertFileSrc : null
      if (_convertFileSrc && getBackgroundImagePreference()) {
        applyBackgroundPreference()
      }
    })
    .catch(() => {})
}

function clampOpacity(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_OPACITY
  return Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, n))
}

function readLocalVideoData() {
  try {
    const v = localStorage.getItem(LS_BG_VIDEO_DATA)
    return v && v.startsWith('data:video/') ? v : ''
  } catch {
    return ''
  }
}

function writeLocalVideoData(dataUrl) {
  try {
    if (!dataUrl) localStorage.removeItem(LS_BG_VIDEO_DATA)
    else localStorage.setItem(LS_BG_VIDEO_DATA, dataUrl)
  } catch {
    /* quota / private mode */
  }
}

function revokeSessionVideoUrl() {
  if (_sessionVideoBlobUrl) {
    URL.revokeObjectURL(_sessionVideoBlobUrl)
    _sessionVideoBlobUrl = ''
  }
}

export function isVideoBackgroundPreference(stored = getBackgroundImagePreference()) {
  const raw = String(stored || '').trim()
  return raw === LOCAL_VIDEO_MARKER || raw === LOCAL_VIDEO_SESSION_MARKER
}

export function isVideoMediaUrl(url) {
  const raw = String(url || '').trim()
  if (!raw) return false
  if (raw.startsWith('data:video/')) return true
  return /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(raw)
}

function readLocalBgData() {
  try {
    const v = localStorage.getItem(LS_BG_DATA)
    return v && v.startsWith('data:image/') ? v : ''
  } catch {
    return ''
  }
}

function writeLocalBgData(dataUrl) {
  try {
    if (!dataUrl) localStorage.removeItem(LS_BG_DATA)
    else localStorage.setItem(LS_BG_DATA, dataUrl)
  } catch {
    /* quota / private mode */
  }
}

function isFilesystemPath(value) {
  const s = String(value || '')
  return /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\') || (s.startsWith('/') && !s.startsWith('/assets/'))
}

/**
 * @param {string} stored
 * @returns {string} CSS url(...) 可用的绝对/相对 URL，空表示无自定义
 */
export function resolveBackgroundImageUrl(stored = getBackgroundImagePreference()) {
  const raw = String(stored || '').trim()
  if (!raw) return ''
  if (raw === LOCAL_MARKER) return readLocalBgData()
  if (raw === LOCAL_VIDEO_MARKER) return readLocalVideoData()
  if (raw === LOCAL_VIDEO_SESSION_MARKER) return _sessionVideoBlobUrl
  if (raw.startsWith('data:') || raw.startsWith('blob:') || raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('asset://') || raw.startsWith('asset:')) {
    return raw
  }
  if (raw.startsWith('/') || raw.startsWith('./')) return raw
  if (isFilesystemPath(raw) && _convertFileSrc) {
    try {
      return _convertFileSrc(raw)
    } catch {
      return ''
    }
  }
  return raw
}

export function getBackgroundImagePreference() {
  return String(getPanelSetting('backgroundImage', '') || '').trim()
}

export function getBackgroundOpacityPreference() {
  return clampOpacity(getPanelSetting('backgroundOpacity', DEFAULT_OPACITY))
}

export function hasCustomBackground() {
  const stored = getBackgroundImagePreference()
  if (!stored) return false
  if (stored === LOCAL_VIDEO_SESSION_MARKER && !_sessionVideoBlobUrl) return false
  return !!resolveBackgroundImageUrl(stored)
}

function cssUrl(url) {
  const escaped = String(url).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `url("${escaped}")`
}

export function applyBackgroundPreference() {
  const root = document.documentElement
  const stored = getBackgroundImagePreference()
  const resolved = resolveBackgroundImageUrl(stored)
  const opacity = getBackgroundOpacityPreference()
  const isVideo = isVideoBackgroundPreference(stored) || isVideoMediaUrl(resolved)
  const imageUrl = !isVideo && resolved ? resolved : DEFAULT_BG_URL
  const custom = !!resolved

  root.dataset.customBg = custom ? '1' : '0'
  root.dataset.customBgVideo = custom && isVideo ? '1' : '0'
  if (!isVideo) {
    root.style.setProperty('--app-bg-image', cssUrl(imageUrl))
  } else {
    root.style.removeProperty('--app-bg-image')
  }
  root.style.setProperty('--app-bg-opacity', String(opacity))
  const veil = Math.max(0.2, Math.min(0.92, 1 - opacity * 0.75))
  root.style.setProperty('--app-bg-veil', String(veil))

  ensureWallpaperEl()
  syncTranslucentUi()
}

/** 液态玻璃 或 自定义墙纸：共用分层半透明 UI（见 liquid-glass.css） */
export function syncTranslucentUi() {
  const root = document.documentElement
  const on = isLiquidGlassWallpaperActive() || hasCustomBackground()
  root.dataset.translucentUi = on ? '1' : '0'
}

function ensureWallpaperEl() {
  let el = document.getElementById('evopanel-app-wallpaper')
  if (!el) {
    el = document.createElement('div')
    el.id = 'evopanel-app-wallpaper'
    el.setAttribute('aria-hidden', 'true')
    document.body?.prepend(el)
  }
  const custom = document.documentElement.dataset.customBg === '1'
  el.hidden = !(custom || isLiquidGlassWallpaperActive())
}

export { ensureWallpaperEl }

export function previewBackgroundOpacity(value) {
  const opacity = clampOpacity(value)
  const root = document.documentElement
  root.style.setProperty('--app-bg-opacity', String(opacity))
  const veil = Math.max(0.2, Math.min(0.92, 1 - opacity * 0.75))
  root.style.setProperty('--app-bg-veil', String(veil))
}

export function setBackgroundOpacityPreference(value) {
  const next = clampOpacity(value)
  void patchPanelSettings({ backgroundOpacity: next })
  applyBackgroundPreference()
  window.dispatchEvent(new CustomEvent(BACKGROUND_EVENT, { detail: { backgroundOpacity: next } }))
}

/**
 * @param {string} value 文件路径、data URL，或空字符串清除
 */
export function setBackgroundImagePreference(value) {
  const raw = String(value || '').trim()
  if (!raw) {
    writeLocalBgData('')
    writeLocalVideoData('')
    revokeSessionVideoUrl()
    void patchPanelSettings({ backgroundImage: '' })
    applyBackgroundPreference()
    window.dispatchEvent(new CustomEvent(BACKGROUND_EVENT, { detail: { backgroundImage: '' } }))
    return
  }
  if (raw.startsWith('data:image/')) {
    writeLocalVideoData('')
    revokeSessionVideoUrl()
    writeLocalBgData(raw)
    void patchPanelSettings({ backgroundImage: LOCAL_MARKER })
    applyBackgroundPreference()
    window.dispatchEvent(new CustomEvent(BACKGROUND_EVENT, { detail: { backgroundImage: LOCAL_MARKER } }))
    return
  }
  if (raw.startsWith('data:video/')) {
    writeLocalBgData('')
    revokeSessionVideoUrl()
    writeLocalVideoData(raw)
    void patchPanelSettings({ backgroundImage: LOCAL_VIDEO_MARKER })
    applyBackgroundPreference()
    window.dispatchEvent(new CustomEvent(BACKGROUND_EVENT, { detail: { backgroundImage: LOCAL_VIDEO_MARKER } }))
    return
  }
  writeLocalBgData('')
  writeLocalVideoData('')
  revokeSessionVideoUrl()
  void patchPanelSettings({ backgroundImage: raw })
  applyBackgroundPreference()
  window.dispatchEvent(new CustomEvent(BACKGROUND_EVENT, { detail: { backgroundImage: raw } }))
}

export function clearBackgroundImagePreference() {
  setBackgroundImagePreference('')
}

/**
 * 从 File / Blob 读入并保存为自定义背景（图片或视频）
 * @param {Blob} file
 * @returns {Promise<{ kind: 'image' | 'video', url: string, persistent: boolean }>}
 */
export function setBackgroundMediaFromBlob(file) {
  if (!file || !(file instanceof Blob)) {
    return Promise.reject(new Error('invalid file'))
  }
  if (file.type.startsWith('video/')) {
    return setBackgroundVideoFromBlob(file)
  }
  return setBackgroundImageFromBlob(file).then((url) => ({ kind: 'image', url, persistent: true }))
}

function setBackgroundVideoFromBlob(file) {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_VIDEO_BYTES) {
      reject(new Error('视频过大（请小于 50MB）'))
      return
    }
    if (file.size > MAX_VIDEO_DATA_URL_BYTES) {
      revokeSessionVideoUrl()
      writeLocalVideoData('')
      writeLocalBgData('')
      _sessionVideoBlobUrl = URL.createObjectURL(file)
      void patchPanelSettings({ backgroundImage: LOCAL_VIDEO_SESSION_MARKER })
      applyBackgroundPreference()
      window.dispatchEvent(new CustomEvent(BACKGROUND_EVENT, { detail: { backgroundImage: LOCAL_VIDEO_SESSION_MARKER } }))
      resolve({ kind: 'video', url: _sessionVideoBlobUrl, persistent: false })
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      if (!result.startsWith('data:video/')) {
        reject(new Error('请选择视频文件'))
        return
      }
      try {
        writeLocalBgData('')
        revokeSessionVideoUrl()
        writeLocalVideoData(result)
        void patchPanelSettings({ backgroundImage: LOCAL_VIDEO_MARKER })
        applyBackgroundPreference()
        window.dispatchEvent(new CustomEvent(BACKGROUND_EVENT, { detail: { backgroundImage: LOCAL_VIDEO_MARKER } }))
        resolve({ kind: 'video', url: result, persistent: true })
      } catch {
        reject(new Error('视频保存失败（可能超出浏览器存储限额）'))
      }
    }
    reader.onerror = () => reject(reader.error || new Error('读取失败'))
    reader.readAsDataURL(file)
  })
}

/**
 * 从 File / Blob 读入并保存为自定义背景图
 * @param {Blob} file
 */
export function setBackgroundImageFromBlob(file) {
  return new Promise((resolve, reject) => {
    if (!file || !(file instanceof Blob)) {
      reject(new Error('invalid file'))
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      reject(new Error('图片过大（请小于 8MB）'))
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      if (!result.startsWith('data:image/')) {
        reject(new Error('请选择图片文件'))
        return
      }
      setBackgroundImagePreference(result)
      resolve(result)
    }
    reader.onerror = () => reject(reader.error || new Error('读取失败'))
    reader.readAsDataURL(file)
  })
}

export function initAppearanceBackground() {
  // 首次应用：先使用当前缓存值（可能为默认值），等 panel-settings-loaded 后重新应用
  applyBackgroundPreference()
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => ensureWallpaperEl(), { once: true })
  } else {
    ensureWallpaperEl()
  }
  // panel 设置加载完成后重新应用（确保持久化的值被正确加载）
  window.addEventListener('evopanel:panel-settings-loaded', () => {
    applyBackgroundPreference()
  })
  window.addEventListener('evopanel:panel-settings-changed', () => {
    applyBackgroundPreference()
  })
  window.addEventListener('evopanel-liquid-glass-changed', () => {
    ensureWallpaperEl()
    syncTranslucentUi()
  })
}

/**
 * 等待 panel 设置加载完成后再应用背景（供 main.js 按需调用）
 * 解决 initAppearanceBackground 在 initPanelSettings 完成前调用导致默认值覆盖的问题
 */
export async function applyBackgroundAfterSettingsLoaded() {
  // 等待 panel 设置加载完成（如果已加载则立即返回）
  const { initPanelSettings } = await import('./panel-settings.js')
  await initPanelSettings()
  applyBackgroundPreference()
}

export { DEFAULT_OPACITY as DEFAULT_BACKGROUND_OPACITY, MIN_OPACITY as MIN_BACKGROUND_OPACITY, MAX_OPACITY as MAX_BACKGROUND_OPACITY }
