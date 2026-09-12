import { ensureWallpaperEl, syncTranslucentUi } from '../appearance-background.js'
import { startFluidBackground, stopFluidBackground, initFluidBackground } from './fluid-background.js'
import { initGlassEngine, startGlassEngine, stopGlassEngine, syncGlassEngine, isWebglGlassSupported } from './glass-engine.js'
import { syncLiquidGlassWallpaper, syncLiquidGlassBgFlags } from './scene-wallpaper.js'
import {
  getLiquidGlassBlurPreference,
  getLiquidGlassEnabled,
  getLiquidGlassFlowSpeedPreference,
  getLiquidGlassPresetPreference,
  getLiquidGlassReadabilityDimPreference,
  previewLiquidGlassReadabilityDim,
  LIQUID_GLASS_EVENT,
} from './settings.js'

export { LIQUID_GLASS_EVENT } from './settings.js'
export {
  getLiquidGlassEnabled,
  getLiquidGlassPresetPreference,
  getLiquidGlassBlurPreference,
  getLiquidGlassFlowSpeedPreference,
  setLiquidGlassEnabled,
  setLiquidGlassPresetPreference,
  setLiquidGlassBlurPreference,
  setLiquidGlassFlowSpeedPreference,
  setLiquidGlassReadabilityDimPreference,
  previewLiquidGlassBlur,
  previewLiquidGlassReadabilityDim,
  getLiquidGlassReadabilityDimPreference,
  MIN_LIQUID_GLASS_BLUR,
  MAX_LIQUID_GLASS_BLUR,
  MIN_LIQUID_GLASS_FLOW,
  MAX_LIQUID_GLASS_FLOW,
  MIN_LIQUID_GLASS_READABILITY_DIM,
  MAX_LIQUID_GLASS_READABILITY_DIM,
} from './settings.js'
export { LIQUID_GLASS_PRESETS, getLiquidGlassPreset } from './presets.js'

function startLiquidGlassRuntime() {
  ensureWallpaperEl()
  if (isWebglGlassSupported()) {
    stopFluidBackground()
    const ok = startGlassEngine()
    if (!ok) {
      stopGlassEngine()
      startFluidBackground()
    }
  } else {
    stopGlassEngine()
    startFluidBackground()
  }
}

function stopLiquidGlassRuntime() {
  stopGlassEngine()
  stopFluidBackground()
  document.documentElement.dataset.liquidGlassWebgl = '0'
}

export function applyLiquidGlassPreference() {
  const root = document.documentElement
  const enabled = getLiquidGlassEnabled()
  root.dataset.liquidGlass = enabled ? '1' : '0'
  root.style.setProperty('--ef-glass-blur', `${getLiquidGlassBlurPreference()}px`)
  root.style.setProperty('--ef-glass-flow', String(getLiquidGlassFlowSpeedPreference()))
  root.dataset.liquidGlassPreset = getLiquidGlassPresetPreference()
  if (enabled) {
    syncLiquidGlassBgFlags()
    requestAnimationFrame(() => startLiquidGlassRuntime())
  } else {
    root.dataset.lgVideoBg = '0'
    root.style.removeProperty('--ef-lg-readability-dim')
    stopLiquidGlassRuntime()
  }
  syncTranslucentUi()
}

export function initLiquidGlass() {
  initFluidBackground()
  initGlassEngine()
  applyLiquidGlassPreference()
  window.addEventListener(LIQUID_GLASS_EVENT, applyLiquidGlassPreference)
  window.addEventListener('evopanel:panel-settings-changed', applyLiquidGlassPreference)
  window.addEventListener('evopanel:panel-settings-loaded', applyLiquidGlassPreference)
  const themeObserver = new MutationObserver(() => {
    if (getLiquidGlassEnabled()) {
      syncLiquidGlassWallpaper()
      syncLiquidGlassBgFlags()
    }
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
}

export function isLiquidGlassWallpaperActive() {
  return getLiquidGlassEnabled()
}
