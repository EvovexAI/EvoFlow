import { getPanelSetting, patchPanelSettings } from '../panel-settings.js'

export const LIQUID_GLASS_EVENT = 'evopanel-liquid-glass-changed'
export const LIQUID_GLASS_READABILITY_PREVIEW_EVENT = 'evopanel-lg-readability-preview'

const MIN_BLUR = 4
const MAX_BLUR = 28
const MIN_FLOW = 0.2
const MAX_FLOW = 2.5
const DEFAULT_PRESET = 'aurora'
const DEFAULT_BLUR = 14
const DEFAULT_FLOW = 0.55
const MIN_READABILITY_DIM = 0
const MAX_READABILITY_DIM = 90
const DEFAULT_READABILITY_DIM = 36

/** @type {number | null} */
let _readabilityPreview = null

function clamp(n, min, max) {
  const v = Number(n)
  if (!Number.isFinite(v)) return min
  return Math.min(max, Math.max(min, v))
}

export function getLiquidGlassEnabled() {
  return !!getPanelSetting('liquidGlassEnabled', false)
}

export function getLiquidGlassPresetPreference() {
  return String(getPanelSetting('liquidGlassPreset', DEFAULT_PRESET) || DEFAULT_PRESET).trim() || DEFAULT_PRESET
}

export function getLiquidGlassBlurPreference() {
  return clamp(getPanelSetting('liquidGlassBlur', DEFAULT_BLUR), MIN_BLUR, MAX_BLUR)
}

export function getLiquidGlassFlowSpeedPreference() {
  return clamp(getPanelSetting('liquidGlassFlowSpeed', DEFAULT_FLOW), MIN_FLOW, MAX_FLOW)
}

export function getLiquidGlassReadabilityDimPreference() {
  if (_readabilityPreview != null) return _readabilityPreview
  return clamp(getPanelSetting('liquidGlassReadabilityDim', DEFAULT_READABILITY_DIM), MIN_READABILITY_DIM, MAX_READABILITY_DIM)
}

export function setLiquidGlassReadabilityDimPreference(value) {
  _readabilityPreview = null
  const dim = clamp(value, MIN_READABILITY_DIM, MAX_READABILITY_DIM)
  void patchPanelSettings({ liquidGlassReadabilityDim: dim })
  window.dispatchEvent(new CustomEvent(LIQUID_GLASS_EVENT))
}

export function previewLiquidGlassReadabilityDim(value) {
  _readabilityPreview = clamp(value, MIN_READABILITY_DIM, MAX_READABILITY_DIM)
  window.dispatchEvent(new CustomEvent(LIQUID_GLASS_READABILITY_PREVIEW_EVENT))
}

export function setLiquidGlassEnabled(value) {
  void patchPanelSettings({ liquidGlassEnabled: !!value })
  window.dispatchEvent(new CustomEvent(LIQUID_GLASS_EVENT))
}

export function setLiquidGlassPresetPreference(value) {
  const preset = String(value || DEFAULT_PRESET).trim() || DEFAULT_PRESET
  void patchPanelSettings({ liquidGlassPreset: preset })
  window.dispatchEvent(new CustomEvent(LIQUID_GLASS_EVENT))
}

export function setLiquidGlassBlurPreference(value) {
  const blur = clamp(value, MIN_BLUR, MAX_BLUR)
  void patchPanelSettings({ liquidGlassBlur: blur })
  window.dispatchEvent(new CustomEvent(LIQUID_GLASS_EVENT))
}

export function setLiquidGlassFlowSpeedPreference(value) {
  const speed = clamp(value, MIN_FLOW, MAX_FLOW)
  void patchPanelSettings({ liquidGlassFlowSpeed: speed })
  window.dispatchEvent(new CustomEvent(LIQUID_GLASS_EVENT))
}

export function previewLiquidGlassBlur(value) {
  document.documentElement.style.setProperty('--ef-glass-blur', `${clamp(value, MIN_BLUR, MAX_BLUR)}px`)
}

export {
  MIN_BLUR as MIN_LIQUID_GLASS_BLUR,
  MAX_BLUR as MAX_LIQUID_GLASS_BLUR,
  MIN_FLOW as MIN_LIQUID_GLASS_FLOW,
  MAX_FLOW as MAX_LIQUID_GLASS_FLOW,
  MIN_READABILITY_DIM as MIN_LIQUID_GLASS_READABILITY_DIM,
  MAX_READABILITY_DIM as MAX_LIQUID_GLASS_READABILITY_DIM,
  DEFAULT_BLUR as DEFAULT_LIQUID_GLASS_BLUR,
  DEFAULT_FLOW as DEFAULT_LIQUID_GLASS_FLOW,
  DEFAULT_READABILITY_DIM as DEFAULT_LIQUID_GLASS_READABILITY_DIM,
}
