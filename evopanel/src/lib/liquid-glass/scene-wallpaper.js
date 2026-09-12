/**
 * Liquid glass scene backdrop: bundled wallpapers / videos + animated blobs.
 */
import {
  hasCustomBackground,
  isVideoBackgroundPreference,
  isVideoMediaUrl,
  resolveBackgroundImageUrl,
} from '../appearance-background.js'
import { getLiquidGlassPreset } from './presets.js'
import { getLiquidGlassFlowSpeedPreference, getLiquidGlassPresetPreference, getLiquidGlassReadabilityDimPreference } from './settings.js'

const LG_BASE = '/assets/liquid-glass'
const MAX_READABILITY_DIM = 90

/** @type {HTMLImageElement | null} */
let _wallpaperImg = null
/** @type {HTMLVideoElement | null} */
let _wallpaperVideo = null
let _wallpaperUrl = ''
let _wallpaperKind = 'none'

function isDarkTheme() {
  return document.documentElement.dataset.theme === 'dark'
}

function disposeWallpaperMedia() {
  _wallpaperImg = null
  if (_wallpaperVideo) {
    _wallpaperVideo.pause()
    _wallpaperVideo.removeAttribute('src')
    _wallpaperVideo.load()
    _wallpaperVideo = null
  }
  _wallpaperKind = 'none'
}

/**
 * @returns {{ kind: 'image' | 'video', url: string }}
 */
export function getEffectiveReadabilityDim() {
  const user = getLiquidGlassReadabilityDimPreference()
  const media = resolveLiquidGlassSceneMedia()
  if (media.kind === 'video') return Math.min(MAX_READABILITY_DIM, user + 22)
  return user
}

export function syncLiquidGlassBgFlags() {
  const media = resolveLiquidGlassSceneMedia()
  const root = document.documentElement
  root.dataset.lgVideoBg = media.kind === 'video' ? '1' : '0'
  const dim = getEffectiveReadabilityDim() / 100
  root.style.setProperty('--ef-lg-readability-dim', String(dim))
}

function drawReadabilityVeil(ctx, w, h, dimPercent) {
  const t = Math.max(0, Math.min(0.72, dimPercent / 100))
  if (t <= 0.001) return
  const dark = isDarkTheme()
  ctx.fillStyle = dark ? `rgba(4, 6, 14, ${t * 0.9})` : `rgba(248, 250, 252, ${t * 0.82})`
  ctx.fillRect(0, 0, w, h)
  const vig = ctx.createRadialGradient(
    w * 0.5,
    h * 0.42,
    Math.min(w, h) * 0.18,
    w * 0.5,
    h * 0.5,
    Math.max(w, h) * 0.82
  )
  vig.addColorStop(0, 'rgba(0,0,0,0)')
  vig.addColorStop(1, dark ? `rgba(0,0,0,${t * 0.38})` : `rgba(15,23,42,${t * 0.22})`)
  ctx.fillStyle = vig
  ctx.fillRect(0, 0, w, h)
}

export function resolveLiquidGlassSceneMedia() {
  if (hasCustomBackground()) {
    const custom = resolveBackgroundImageUrl()
    if (custom) {
      const kind = isVideoBackgroundPreference() || isVideoMediaUrl(custom) ? 'video' : 'image'
      return { kind, url: custom }
    }
  }
  const presetId = getLiquidGlassPresetPreference()
  const preset = getLiquidGlassPreset(presetId)
  const dark = isDarkTheme()
  if (preset.wallpaperVideo) {
    return { kind: 'video', url: `${LG_BASE}/${preset.wallpaperVideo}` }
  }
  if (dark && preset.wallpaperDark) {
    return { kind: 'image', url: `${LG_BASE}/${preset.wallpaperDark}` }
  }
  if (preset.wallpaper) {
    return { kind: 'image', url: `${LG_BASE}/${preset.wallpaper}` }
  }
  return {
    kind: 'image',
    url: dark ? `${LG_BASE}/bg-tahoe-dark.webp` : `${LG_BASE}/bg-ui.svg`,
  }
}

/** @deprecated use resolveLiquidGlassSceneMedia */
export function resolveLiquidGlassSceneWallpaperUrl() {
  return resolveLiquidGlassSceneMedia().url
}

function loadWallpaperImage(url, onReady) {
  disposeWallpaperMedia()
  _wallpaperUrl = url
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.onload = () => {
    if (_wallpaperUrl !== url) return
    _wallpaperImg = img
    _wallpaperKind = 'image'
    if (typeof onReady === 'function') onReady()
  }
  img.onerror = () => {
    if (_wallpaperUrl === url) disposeWallpaperMedia()
  }
  img.src = url
}

function loadWallpaperVideo(url, onReady) {
  disposeWallpaperMedia()
  _wallpaperUrl = url
  const video = document.createElement('video')
  video.muted = true
  video.loop = true
  video.playsInline = true
  video.autoplay = true
  video.crossOrigin = 'anonymous'
  video.setAttribute('playsinline', '')
  video.preload = 'auto'
  const ready = () => {
    if (_wallpaperUrl !== url) return
    _wallpaperVideo = video
    _wallpaperKind = 'video'
    void video.play().catch(() => {})
    if (typeof onReady === 'function') onReady()
  }
  video.addEventListener('loadeddata', ready, { once: true })
  video.addEventListener('canplay', ready, { once: true })
  video.onerror = () => {
    if (_wallpaperUrl === url) disposeWallpaperMedia()
  }
  video.src = url
  video.load()
}

export function loadLiquidGlassWallpaper(url, onReady) {
  const next = String(url || '').trim()
  if (!next) {
    _wallpaperUrl = ''
    disposeWallpaperMedia()
    return
  }
  if (next === _wallpaperUrl) {
    if (_wallpaperKind === 'image' && _wallpaperImg && _wallpaperImg.complete) {
      if (typeof onReady === 'function') onReady()
      return
    }
    if (_wallpaperKind === 'video' && _wallpaperVideo && _wallpaperVideo.readyState >= 2) {
      if (typeof onReady === 'function') onReady()
      return
    }
  }
  if (isVideoMediaUrl(next)) {
    loadWallpaperVideo(next, onReady)
    return
  }
  loadWallpaperImage(next, onReady)
}

export function syncLiquidGlassWallpaper(onReady) {
  const media = resolveLiquidGlassSceneMedia()
  loadLiquidGlassWallpaper(media.url, () => {
    syncLiquidGlassBgFlags()
    if (typeof onReady === 'function') onReady()
  })
}

export function getLoadedWallpaper() {
  return _wallpaperImg
}

export function getLoadedWallpaperVideo() {
  return _wallpaperVideo
}

function blobColor(hue, sat, light, alpha, dark) {
  const l = dark ? Math.max(16, light - 32) : light
  const s = dark ? Math.min(88, sat + 10) : sat
  return `hsla(${hue}, ${s}%, ${l}%, ${alpha})`
}

function drawCoverMedia(ctx, media, w, h) {
  const mw = media.videoWidth || media.naturalWidth || media.width
  const mh = media.videoHeight || media.naturalHeight || media.height
  if (!mw || !mh) return
  const sRatio = w / h
  const mRatio = mw / mh
  let dw = w
  let dh = h
  let dx = 0
  let dy = 0
  if (sRatio > mRatio) {
    dh = w / mRatio
    dy = (h - dh) * 0.5
  } else {
    dw = h * mRatio
    dx = (w - dw) * 0.5
  }
  ctx.drawImage(media, dx, dy, dw, dh)
}

function drawProceduralCheckerboard(ctx, w, h, dark) {
  const size = Math.max(28, Math.round(Math.min(w, h) / 24))
  ctx.fillStyle = dark ? '#1a1a22' : '#e4e8f0'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = dark ? '#2a2a36' : '#d0d6e4'
  for (let y = 0; y < h + size; y += size) {
    for (let x = 0; x < w + size; x += size) {
      const cell = Math.floor(x / size) + Math.floor(y / size)
      if (cell % 2 === 0) continue
      ctx.fillRect(x, y, size, size)
    }
  }
}

function drawAnimatedBlobs(ctx, w, h, time) {
  const dark = isDarkTheme()
  const presetId = getLiquidGlassPresetPreference()
  const preset = getLiquidGlassPreset(presetId)
  const speed = getLiquidGlassFlowSpeedPreference()
  const base = dark ? '#05050a' : '#e8ecf6'
  ctx.fillStyle = base
  ctx.fillRect(0, 0, w, h)

  ctx.save()
  ctx.globalCompositeOperation = dark ? 'screen' : 'multiply'
  const hues = preset.hues || []
  for (let i = 0; i < hues.length; i++) {
    const hue = hues[i]
    const phase = time * speed * (0.14 + i * 0.04)
    const cx = w * (0.2 + 0.6 * (0.5 + 0.5 * Math.sin(phase * 0.55 + i * 1.9)))
    const cy = h * (0.15 + 0.7 * (0.5 + 0.5 * Math.cos(phase * 0.45 + i * 2.3)))
    const r = Math.min(w, h) * (0.26 + 0.08 * Math.sin(phase * 0.38 + i * 0.8))
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
    const alpha = dark ? 0.52 : 0.62
    grad.addColorStop(0, blobColor(hue, preset.saturation, preset.lightness, alpha, dark))
    grad.addColorStop(0.45, blobColor(hue, preset.saturation, preset.lightness, alpha * 0.65, dark))
    grad.addColorStop(1, blobColor(hue, preset.saturation, preset.lightness, 0, dark))
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, h)
  }
  ctx.restore()
}

export function isLiquidGlassVideoBackground() {
  return document.documentElement.dataset.lgVideoBg === '1'
}

export function paintLiquidGlassScene(ctx, w, h, time) {
  const dark = isDarkTheme()
  const dim = getEffectiveReadabilityDim()

  const hasVideo = _wallpaperKind === 'video' && _wallpaperVideo && _wallpaperVideo.readyState >= 2
  const hasImage =
    _wallpaperKind === 'image' && _wallpaperImg && _wallpaperImg.complete && _wallpaperImg.naturalWidth > 0

  if (hasVideo) {
    drawCoverMedia(ctx, _wallpaperVideo, w, h)
    drawReadabilityVeil(ctx, w, h, dim)
    return
  }

  if (hasImage) {
    drawCoverMedia(ctx, _wallpaperImg, w, h)
    drawReadabilityVeil(ctx, w, h, dim)
    return
  }

  drawAnimatedBlobs(ctx, w, h, time)
  drawProceduralCheckerboard(ctx, w, h, dark)
}
