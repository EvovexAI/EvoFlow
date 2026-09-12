import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/lib/liquid-glass/glass-shader.js')
let s = fs.readFileSync(file, 'utf8')

s = s.replace(/gl!/g, 'gl')
s = s.replace(/sceneCtx!/g, 'sceneCtx')
s = s.replace(/function compileShader\(type, src\): WebGLShader\s*/g, 'function compileShader(type, src) ')
s = s.replace(/let chatEl: HTMLElement\s*=/g, 'let chatEl =')
s = s.replace(/let headerEl: HTMLElement\s*=/g, 'let headerEl =')
s = s.replace(/let modalEl: HTMLElement\s*=/g, 'let modalEl =')
s = s.replace(/let cachedLensElements: HTMLElement\[\] = \[\]/g, '')
s = s.replace(/let cachedPopoverElements: HTMLElement\[\] = \[\]/g, '')
s = s.replace(/\(event: Event\)/g, '(event)')

s = s.replace(
  /function drawCover\(media[\s\S]*?\n  \}\n\n  function drawScene/,
  'function drawScene'
)

const geoBlock = `const geo = hooks?.collectGeometry ? hooks.collectGeometry(dpr, screenH, now) : null

      gl.uniform1i(uPopoverCountLoc, 0)
      gl.uniform1f(uSidebarWidthPx, geo?.sidebarWidthPx ?? 0)

      const chat = geo?.chat
      gl.uniform1i(uHasChatLoc, chat?.has ? 1 : 0)
      gl.uniform4f(uChatRectLoc, chat?.centerX ?? 0, chat?.centerY ?? 0, chat?.halfW ?? 0, chat?.halfH ?? 0)
      gl.uniform1f(uChatRadiusLoc, chat?.radius ?? 0)

      const header = geo?.header
      gl.uniform1i(uHasHeaderLoc, header?.has ? 1 : 0)
      gl.uniform4f(uHeaderRectLoc, header?.centerX ?? 0, header?.centerY ?? 0, header?.halfW ?? 0, header?.halfH ?? 0)

      const modal = geo?.modal
      gl.uniform1i(uHasModalLoc, modal?.has ? 1 : 0)
      gl.uniform4f(uModalRectLoc, modal?.modalCenterX ?? 0, modal?.modalCenterY ?? 0, modal?.modalHalfW ?? 0, modal?.modalHalfH ?? 0)
      gl.uniform1f(uModalRadiusLoc, modal?.modalRadius ?? 0)
      gl.uniform1f(uModalProgressLoc, modal?.modalProgress ?? 0)

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
      gl.uniform1i(uLensCountLoc, count)`

s = s.replace(
  /\/\/ 0\. 禁用 popover[\s\S]*?gl\.uniform1i\(uLensCountLoc, count\)/,
  geoBlock
)

s = s.replace(
  /let currentModalProgress[\s\S]*?let cachedPopoverElements[\s\S]*?\n\n  function frame/,
  'function frame'
)

s = s.replace(
  /dispose: \(\) => \{[\s\S]*?customImg = null\n    \},/,
  `dispose: () => {
      disposed = true
      cancelAnimationFrame(animId)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('resize', resize)
    },`
)

s = s.replace(
  /update: \(next\) => \{\n      opts = \{ \.\.\.opts, \.\.\.next \}\n          \},/,
  `update: (next) => {
      opts = { ...opts, ...next }
    },`
)

fs.writeFileSync(file, s)
console.log('fixed', file)
