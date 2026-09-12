/**
 * Strip TypeScript from copied glass-shader and inject EvoFlow geometry hooks.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '../..')
const srcPath = path.join(root, 'evopanel/vendor/liquid-glass-theme/src/client/glass-shader.ts')
const outPath = path.join(__dirname, '../src/lib/liquid-glass/glass-shader.js')

let s = fs.readFileSync(srcPath, 'utf8')

const defaults = `export const DEFAULT_GLASS_SHADER_OPTIONS = {
  l1Blur: 14,
  modalBlur: 24,
  l1Opacity: 0.32,
  l1Border: 0.22,
  ior: 1.3,
  bulge: 1.8,
  dispersion: 0.035,
  bevel: 0.015,
  lensBlur: 2.5,
  darkening: 0.14,
  rimIntensity: 0.45,
  lightAngle: 135,
  vibrancy: 1.12,
  rippleAmp: 0.3,
  dropShadowOpacity: 0.18,
  dropShadowBlur: 12,
  dropShadowY: 4,
  bgBlur: 0,
  bgLiquidEnabled: true,
  bgLiquidAmp: 0.55,
  bgLiquidScale: 1.2,
  bgLiquidSpeed: 1,
  bgLiquidDispersion: 0.02,
}
`

s = s.replace(/export interface ShaderOptions[\s\S]*?^}/m, defaults)
s = s.replace(/export interface GlassShaderHandle[\s\S]*?^}/m, '')

s = s.replace(
  /function createLiquidGlassShader\(canvas: HTMLCanvasElement, currentOpts: ShaderOptions\): GlassShaderHandle \{/,
  'function createLiquidGlassShader(canvas, currentOpts, hooks) {'
)

s = s.replace(
  /export function attachLiquidGlassShader\(canvas: HTMLCanvasElement, currentOpts: ShaderOptions\): GlassShaderHandle \{/,
  'export function attachLiquidGlassShader(canvas, currentOpts, hooks) {'
)

s = s.replace(/: GlassShaderHandle/g, '')
s = s.replace(/: ShaderOptions/g, '')
s = s.replace(/: HTMLCanvasElement/g, '')
s = s.replace(/: HTMLImageElement \| HTMLVideoElement/g, '')
s = s.replace(/: HTMLImageElement \| null/g, '')
s = s.replace(/: HTMLVideoElement \| null/g, '')
s = s.replace(/: string/g, '')
s = s.replace(/: number/g, '')
s = s.replace(/: PointerEvent/g, '')
s = s.replace(/<HTMLElement>/g, '')
s = s.replace(/ as HTMLElement/g, '')
s = s.replace(/ as any/g, '')
s = s.replace(/\?: number/g, '')
s = s.replace(/\| null/g, '')
s = s.replace(/Partial<ShaderOptions>/g, 'object')

// Replace drawScene body with hook
s = s.replace(
  /function drawScene\(\) \{[\s\S]*?sceneCtx!\.fillRect\(0, 0, w, h\)\n  \}/,
  `function drawScene(time) {
    if (hooks?.drawScene) hooks.drawScene(sceneCtx, sceneCanvas.width, sceneCanvas.height, opts, time)
  }`
)

// Remove wallpaper loader block
s = s.replace(
  /let customImg[\s\S]*?if \(opts\.wallpaper\) loadWallpaper\(opts\.wallpaper\)\n\n/,
  ''
)

s = s.replace(
  /if \(next\.wallpaper !== undefined\) \{[\s\S]*?\}\n/,
  ''
)

// Replace DOM scan in frame with collectGeometry
const geoBlock = `
      const geo = hooks?.collectGeometry ? hooks.collectGeometry(dpr, screenH, now) : null
      const sidebarWidthPx = geo?.sidebarWidthPx ?? 0
      gl.uniform1f(uSidebarWidthPx, sidebarWidthPx)

      const chat = geo?.chat
      gl.uniform1i(uHasChatLoc, chat?.has ? 1 : 0)
      gl.uniform4f(uChatRectLoc, chat?.centerX ?? 0, chat?.centerY ?? 0, chat?.halfW ?? 0, chat?.halfH ?? 0)
      gl.uniform1f(uChatRadiusLoc, chat?.radius ?? 0)

      const header = geo?.header
      gl.uniform1i(uHasHeaderLoc, header?.has ? 1 : 0)
      gl.uniform4f(uHeaderRectLoc, header?.centerX ?? 0, header?.centerY ?? 0, header?.halfW ?? 0, header?.halfH ?? 0)

      const modal = geo?.modal
      const hasModal = modal?.has ? 1 : 0
      gl.uniform1i(uHasModalLoc, hasModal)
      gl.uniform4f(uModalRectLoc, modal?.modalCenterX ?? 0, modal?.modalCenterY ?? 0, modal?.modalHalfW ?? 0, modal?.modalHalfH ?? 0)
      gl.uniform1f(uModalRadiusLoc, modal?.modalRadius ?? 0)
      gl.uniform1f(uModalProgressLoc, modal?.modalProgress ?? 0)

      gl.uniform1i(uPopoverCountLoc, 0)
      gl.uniform1f(uL1Blur, opts.l1Blur * dpr)
      gl.uniform1f(uModalBlurLoc, (opts.modalBlur ?? 24) * dpr)
      gl.uniform1f(uL1Opacity, opts.l1Opacity)
      gl.uniform1f(uL1Border, opts.l1Border)

      let count = 0
      lensBuffer.fill(0)
      radiiBuffer.fill(0)
      layersBuffer.fill(0)
      const lensList = geo?.lenses || []
      for (let i = 0; i < lensList.length && count < 64; i++) {
        const L = lensList[i]
        lensBuffer[count * 4 + 0] = L.centerX
        lensBuffer[count * 4 + 1] = L.centerY
        lensBuffer[count * 4 + 2] = L.halfW
        lensBuffer[count * 4 + 3] = L.halfH
        radiiBuffer[count] = L.radius
        layersBuffer[count] = 0
        count++
      }
      gl.uniform4fv(uLensesLoc, lensBuffer)
      gl.uniform1fv(uLensRadiiLoc, radiiBuffer)
      gl.uniform1fv(uLensLayersLoc, layersBuffer)
      gl.uniform1i(uLensCountLoc, count)
`

s = s.replace(
  /\/\/ 0\. 禁用 popover[\s\S]*?gl\.uniform1i\(uLensCountLoc, count\)/,
  geoBlock.trim()
)

s = s.replace(/drawScene\(\)/g, 'drawScene(time)')
s = s.replace(
  /export function attachLiquidGlassShader\(canvas, currentOpts, hooks\) \{[\s\S]*?let active = createLiquidGlassShader\(canvas, lastOpts\)/,
  (m) => m.replace('createLiquidGlassShader(canvas, lastOpts)', 'createLiquidGlassShader(canvas, lastOpts, hooks)')
)

s = s.replace(
  /active = createLiquidGlassShader\(canvas, lastOpts\)/g,
  'active = createLiquidGlassShader(canvas, lastOpts, hooks)'
)

fs.writeFileSync(outPath, s)
console.log('Wrote', outPath, s.length, 'bytes')
