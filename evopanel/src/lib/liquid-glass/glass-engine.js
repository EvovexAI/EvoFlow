/**
 * EvoFlow WebGL 液态玻璃引擎（基于 DSH glass-shader，MIT）
 */
import { attachLiquidGlassShader, DEFAULT_GLASS_SHADER_OPTIONS } from './glass-shader.js'
import { collectEvoFlowGlassGeometry } from './dom-geometry.js'
import { BACKGROUND_EVENT } from '../appearance-background.js'
import {
  paintLiquidGlassScene,
  syncLiquidGlassWallpaper,
  getEffectiveReadabilityDim,
  syncLiquidGlassBgFlags,
  isLiquidGlassVideoBackground,
} from './scene-wallpaper.js'
import {
  getLiquidGlassBlurPreference,
  getLiquidGlassEnabled,
  getLiquidGlassFlowSpeedPreference,
  LIQUID_GLASS_EVENT,
  LIQUID_GLASS_READABILITY_PREVIEW_EVENT,
} from './settings.js'

const WEBGL_CANVAS_ID = 'ef-glass-webgl-canvas'

/** @type {ReturnType<typeof attachLiquidGlassShader> | null} */
let _shader = null
/** @type {HTMLCanvasElement | null} */
let _canvas = null
let _wallpaperBound = false

function ensureWebglCanvas() {
  const host = document.getElementById('evopanel-app-wallpaper')
  if (!host) return null
  let canvas = host.querySelector(`#${WEBGL_CANVAS_ID}`)
  if (!(canvas instanceof HTMLCanvasElement)) {
    const fluid = host.querySelector('#ef-fluid-canvas')
    if (fluid) fluid.remove()
    canvas = document.createElement('canvas')
    canvas.id = WEBGL_CANVAS_ID
    canvas.setAttribute('aria-hidden', 'true')
    host.prepend(canvas)
  }
  _canvas = canvas
  return canvas
}

function drawScene(ctx, w, h, _opts, time) {
  paintLiquidGlassScene(ctx, w, h, time)
}

function buildShaderOptions() {
  const blur = getLiquidGlassBlurPreference()
  const flow = getLiquidGlassFlowSpeedPreference()
  const dim = getEffectiveReadabilityDim() / 100
  const video = isLiquidGlassVideoBackground()
  const blurRadius = Math.min(10, Math.max(2, Math.round(blur * 0.2 + dim * 4)))
  return {
    ...DEFAULT_GLASS_SHADER_OPTIONS,
    l1Blur: blur + dim * 16,
    modalBlur: Math.min(56, blur + 8 + dim * 10),
    lensBlur: Math.max(1.6, blur * 0.2 + dim * 2.5),
    blurPassRadius: video ? Math.min(6, blurRadius) : blurRadius,
    l1Opacity: 0.1 + dim * 0.48,
    darkening: 0.04 + dim * 0.12,
    bgLiquidSpeed: flow * 0.62,
    bgLiquidAmp: video ? 0.2 : 0.28 + flow * 0.1,
    bgLiquidDispersion: video ? 0.015 : 0.028 + flow * 0.008,
    bgLiquidEnabled: !video,
  }
}

function bindWallpaperListeners() {
  if (_wallpaperBound) return
  _wallpaperBound = true
  const refresh = () => {
    syncLiquidGlassWallpaper()
    syncLiquidGlassBgFlags()
  }
  window.addEventListener(BACKGROUND_EVENT, refresh)
  window.addEventListener(LIQUID_GLASS_EVENT, refresh)
  window.addEventListener('evopanel:panel-settings-changed', refresh)
}

export function isWebglGlassSupported() {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl') || c.getContext('experimental-webgl'))
  } catch {
    return false
  }
}

export function refreshGlassShaderOptions() {
  syncLiquidGlassBgFlags()
  if (_shader?.active) _shader.update(buildShaderOptions())
}

export function startGlassEngine() {
  if (!getLiquidGlassEnabled()) {
    stopGlassEngine()
    return false
  }
  const canvas = ensureWebglCanvas()
  if (!canvas) return false

  bindWallpaperListeners()
  syncLiquidGlassWallpaper()
  syncLiquidGlassBgFlags()

  canvas.hidden = false
  canvas.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:0;display:block;'

  const hooks = {
    drawScene,
    collectGeometry: collectEvoFlowGlassGeometry,
  }

  if (_shader?.active) {
    syncLiquidGlassBgFlags()
    _shader.update(buildShaderOptions())
    document.documentElement.dataset.liquidGlassWebgl = '1'
    return true
  }

  if (_shader) {
    _shader.dispose()
    _shader = null
  }

  _shader = attachLiquidGlassShader(canvas, buildShaderOptions(), hooks)
  if (!_shader?.active) {
    _shader?.dispose()
    _shader = null
    document.documentElement.dataset.liquidGlassWebgl = '0'
    return false
  }

  document.documentElement.dataset.liquidGlassWebgl = '1'
  return true
}

export function stopGlassEngine() {
  if (_shader) {
    _shader.dispose()
    _shader = null
  }
  if (_canvas) {
    _canvas.hidden = true
    _canvas = null
  }
  document.documentElement.dataset.liquidGlassWebgl = '0'
}

export function syncGlassEngine() {
  if (getLiquidGlassEnabled() && isWebglGlassSupported()) {
    return startGlassEngine()
  }
  stopGlassEngine()
  return false
}

export function initGlassEngine() {
  window.addEventListener('resize', () => {
    if (_shader?.active) _shader.update(buildShaderOptions())
  })
  window.addEventListener(LIQUID_GLASS_READABILITY_PREVIEW_EVENT, () => {
    refreshGlassShaderOptions()
  })
}

