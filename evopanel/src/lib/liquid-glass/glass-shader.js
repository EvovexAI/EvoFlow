/**
 * WebGL 6.0 Multi-Tier Physical Liquid Glass Optics Engine.
 * Shader sources: glass-shader-glsl.js · Runtime: glass-shader-runtime.js
 */

export const DEFAULT_GLASS_SHADER_OPTIONS = {
  l1Blur: 14,
  modalBlur: 26,
  l1Opacity: 0.12,
  l1Border: 0.28,
  ior: 1.48,
  bulge: 1.72,
  dispersion: 0.07,
  bevel: 0.014,
  lensBlur: 2.4,
  refThickness: 22,
  fresnelFactor: 0.48,
  glareFactor: 0.62,
  darkening: 0.06,
  rimIntensity: 0.45,
  lightAngle: -45,
  vibrancy: 1.05,
  rippleAmp: 0.28,
  dropShadowOpacity: 0.22,
  dropShadowBlur: 14,
  dropShadowY: 5,
  bgBlur: 0,
  bgLiquidEnabled: true,
  bgLiquidAmp: 0.38,
  bgLiquidScale: 1.22,
  bgLiquidSpeed: 0.65,
  bgLiquidDispersion: 0.032,
}

export { attachLiquidGlassShader } from './glass-shader-runtime.js'
