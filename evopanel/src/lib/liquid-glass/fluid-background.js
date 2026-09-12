import { ACCENT_THEME_EVENT } from '../accent-theme.js'
import { paintLiquidGlassScene, syncLiquidGlassWallpaper } from './scene-wallpaper.js'
import {
  getLiquidGlassEnabled,
  LIQUID_GLASS_EVENT,
} from './settings.js'

const CANVAS_ID = 'ef-fluid-canvas'
const MAX_RIPPLES = 8

/** @type {HTMLCanvasElement | null} */
let _canvas = null
/** @type {CanvasRenderingContext2D | null} */
let _ctx = null
/** @type {number | null} */
let _raf = null
let _start = 0
let _accentHue = 238
/** @type {{ x: number, y: number, born: number, amp: number }[]} */
let _ripples = []
/** @type {HTMLCanvasElement | null} */
let _noisePattern = null
let _pointerBound = false
let _lastTick = 0

function readAccentHue() {
  try {
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    if (!accent) return 238
    if (accent.startsWith('#')) {
      const hex = accent.slice(1)
      const r = parseInt(hex.slice(0, 2), 16) / 255
      const g = parseInt(hex.slice(2, 4), 16) / 255
      const b = parseInt(hex.slice(4, 6), 16) / 255
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      if (max === min) return 238
      const d = max - min
      let hue = 0
      if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0)) / 6
      else if (max === g) hue = ((b - r) / d + 2) / 6
      else hue = ((r - g) / d + 4) / 6
      return hue * 360
    }
  } catch {
    /* ignore */
  }
  return 238
}

function isDarkTheme() {
  return document.documentElement.dataset.theme === 'dark'
}

function ensureNoisePattern() {
  if (_noisePattern) return _noisePattern
  const n = document.createElement('canvas')
  n.width = 128
  n.height = 128
  const nx = n.getContext('2d')
  if (!nx) return null
  const img = nx.createImageData(128, 128)
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 200 + Math.floor(Math.random() * 55)
    img.data[i] = v
    img.data[i + 1] = v
    img.data[i + 2] = v
    img.data[i + 3] = 18
  }
  nx.putImageData(img, 0, 0)
  _noisePattern = n
  return n
}

function ensureCanvas() {
  const host = document.getElementById('evopanel-app-wallpaper')
  if (!host) return null
  let canvas = host.querySelector(`#${CANVAS_ID}`)
  if (!(canvas instanceof HTMLCanvasElement)) {
    canvas = document.createElement('canvas')
    canvas.id = CANVAS_ID
    canvas.setAttribute('aria-hidden', 'true')
    host.prepend(canvas)
  }
  _canvas = canvas
  _ctx = canvas.getContext('2d', { alpha: true })
  return canvas
}

function resizeCanvas() {
  if (!_canvas || !_ctx) return
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
  const maxW = 1920
  const maxH = 1080
  const w = Math.min(window.innerWidth, maxW)
  const h = Math.min(window.innerHeight, maxH)
  _canvas.width = Math.floor(w * dpr)
  _canvas.height = Math.floor(h * dpr)
  _canvas.style.width = `${w}px`
  _canvas.style.height = `${h}px`
  _ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function addRipple(x, y) {
  _ripples.push({ x, y, born: performance.now(), amp: 0.85 + Math.random() * 0.3 })
  if (_ripples.length > MAX_RIPPLES) _ripples.shift()
}

function drawRipples(ctx, w, h, now, dark) {
  for (let i = _ripples.length - 1; i >= 0; i--) {
    const r = _ripples[i]
    const age = (now - r.born) / 1000
    if (age > 2.4) {
      _ripples.splice(i, 1)
      continue
    }
    const radius = age * Math.min(w, h) * 0.15
    const fade = Math.max(0, 1 - age / 2.4)
    const ringW = Math.max(2, radius * 0.08)
    ctx.save()
    ctx.beginPath()
    ctx.arc(r.x, r.y, radius, 0, Math.PI * 2)
    ctx.strokeStyle = dark
      ? `rgba(180, 210, 255, ${0.22 * fade * r.amp})`
      : `rgba(90, 110, 220, ${0.18 * fade * r.amp})`
    ctx.lineWidth = ringW
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(r.x, r.y, radius * 0.72, 0, Math.PI * 2)
    ctx.strokeStyle = dark
      ? `rgba(255, 255, 255, ${0.08 * fade})`
      : `rgba(255, 255, 255, ${0.35 * fade})`
    ctx.lineWidth = ringW * 0.5
    ctx.stroke()
    ctx.restore()
  }
}

function drawFrame(t) {
  if (!_canvas || !_ctx) return
  const ctx = _ctx
  const w = _canvas.clientWidth
  const h = _canvas.clientHeight
  const dark = isDarkTheme()
  const elapsed = (t - _start) / 1000

  ctx.clearRect(0, 0, w, h)
  paintLiquidGlassScene(ctx, w, h, elapsed)

  const noise = ensureNoisePattern()
  if (noise) {
    ctx.save()
    ctx.globalAlpha = dark ? 0.35 : 0.22
    const pat = ctx.createPattern(noise, 'repeat')
    if (pat) {
      ctx.fillStyle = pat
      ctx.fillRect(0, 0, w, h)
    }
    ctx.restore()
  }

  drawRipples(ctx, w, h, t, dark)

  const veil = ctx.createLinearGradient(0, 0, w, h)
  if (dark) {
    veil.addColorStop(0, 'rgba(0,0,0,0.08)')
    veil.addColorStop(0.5, 'rgba(0,0,0,0.02)')
    veil.addColorStop(1, 'rgba(0,0,0,0.28)')
  } else {
    veil.addColorStop(0, 'rgba(255,255,255,0.18)')
    veil.addColorStop(0.5, 'rgba(255,255,255,0.06)')
    veil.addColorStop(1, 'rgba(255,255,255,0.22)')
  }
  ctx.fillStyle = veil
  ctx.fillRect(0, 0, w, h)
}

function tick(t) {
  if (!getLiquidGlassEnabled()) {
    stopFluidBackground()
    return
  }
  // Do not keep scheduling rAF while occluded — that still wakes CPU/GPU on Mac.
  if (document.hidden) {
    cancelFluidAnimation()
    return
  }
  if (_lastTick && t - _lastTick < 1000 / 30) {
    _raf = requestAnimationFrame(tick)
    return
  }
  _lastTick = t
  if (!_start) _start = t
  drawFrame(t)
  _raf = requestAnimationFrame(tick)
}

function cancelFluidAnimation() {
  if (_raf != null) {
    cancelAnimationFrame(_raf)
    _raf = null
  }
}

function bindPointerRipples() {
  if (_pointerBound) return
  _pointerBound = true
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!getLiquidGlassEnabled()) return
      if (e.button !== 0) return
      addRipple(e.clientX, e.clientY)
    },
    { passive: true }
  )
}

export function startFluidBackground() {
  if (!getLiquidGlassEnabled()) {
    stopFluidBackground()
    return
  }
  bindPointerRipples()
  syncLiquidGlassWallpaper()
  _accentHue = readAccentHue()
  const host = document.getElementById('evopanel-app-wallpaper')
  if (host) host.hidden = false
  const canvas = ensureCanvas()
  if (!canvas) return
  canvas.hidden = false
  resizeCanvas()
  cancelFluidAnimation()
  if (_canvas && (_canvas.clientWidth < 2 || _canvas.clientHeight < 2)) {
    requestAnimationFrame(() => startFluidBackground())
    return
  }
  _start = 0
  _raf = requestAnimationFrame(tick)
}

export function stopFluidBackground() {
  cancelFluidAnimation()
  _ripples = []
  _lastTick = 0
  if (_canvas) _canvas.hidden = true
}

export function syncFluidBackground() {
  if (getLiquidGlassEnabled()) startFluidBackground()
  else stopFluidBackground()
}

export function initFluidBackground() {
  _accentHue = readAccentHue()
  window.addEventListener('resize', () => {
    if (!getLiquidGlassEnabled()) return
    resizeCanvas()
  })
  window.addEventListener(LIQUID_GLASS_EVENT, syncFluidBackground)
  window.addEventListener(ACCENT_THEME_EVENT, () => {
    _accentHue = readAccentHue()
  })
  window.addEventListener('evopanel:panel-settings-changed', syncFluidBackground)
  document.addEventListener('visibilitychange', () => {
    if (!getLiquidGlassEnabled()) return
    if (document.hidden) {
      cancelFluidAnimation()
      return
    }
    if (_raf == null && _canvas && !_canvas.hidden) {
      _raf = requestAnimationFrame(tick)
    }
  })
}
