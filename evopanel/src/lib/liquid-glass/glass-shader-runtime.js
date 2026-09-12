/**
 * WebGL runtime for EvoFlow liquid glass (ported from DSH glass-shader.ts, MIT)
 * Blur passes inspired by liquid-glass-studio (MIT)
 */
import { FS_SRC, VS_SRC } from './glass-shader-glsl.js'
import { BLUR_H_FS, BLUR_V_FS, BLUR_VS } from './glass-blur-glsl.js'
import { computeGaussianKernelByRadius } from './gaussian-kernel.js'

function noopHandle() {
  return { update: () => {}, dispose: () => {}, active: false }
}

function compileProgram(gl, vsSrc, fsSrc) {
  function compileShader(type, src) {
    const s = gl.createShader(type)
    if (!s) return null
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error('[EfLiquidGlass] shader compile:', gl.getShaderInfoLog(s))
      gl.deleteShader(s)
      return null
    }
    return s
  }
  const vs = compileShader(gl.VERTEX_SHADER, vsSrc)
  const fs = compileShader(gl.FRAGMENT_SHADER, fsSrc)
  if (!vs || !fs) return null
  const prog = gl.createProgram()
  if (!prog) return null
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('[EfLiquidGlass] shader link:', gl.getProgramInfoLog(prog))
    return null
  }
  return prog
}

function createFramebuffer(gl, width, height) {
  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  const fb = gl.createFramebuffer()
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  return { fb, texture }
}

function createLiquidGlassShader(canvas, currentOpts, hooks) {
  let opts = { ...currentOpts }
  let disposed = false
  let animId = 0

  const sceneCanvas = document.createElement('canvas')
  sceneCanvas.width = 1920
  sceneCanvas.height = 1080
  const sceneCtx = sceneCanvas.getContext('2d')

  const gl = canvas.getContext('webgl', { alpha: false, antialias: false }) ||
    canvas.getContext('experimental-webgl')
  if (!gl || !sceneCtx) return noopHandle()

  const prog = compileProgram(gl, VS_SRC, FS_SRC)
  if (!prog) return noopHandle()
  const blurHProg = compileProgram(gl, BLUR_VS, BLUR_H_FS)
  const blurVProg = compileProgram(gl, BLUR_VS, BLUR_V_FS)
  const hasBlur = !!(blurHProg && blurVProg)

  gl.useProgram(prog)

  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW
  )
  const aPos = gl.getAttribLocation(prog, 'a_pos')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

  let blurFboH = null
  let blurFboV = null
  let blurKernel = computeGaussianKernelByRadius(opts.blurPassRadius ?? 12)

  function ensureBlurTargets(w, h) {
    if (!hasBlur) return
    if (blurFboH && blurFboH.width === w && blurFboH.height === h) return
    blurFboH = { ...createFramebuffer(gl, w, h), width: w, height: h }
    blurFboV = { ...createFramebuffer(gl, w, h), width: w, height: h }
  }

  function runBlurPass(program, srcTex, dstFb) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstFb)
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.useProgram(program)
    const uTexLoc = gl.getUniformLocation(program, 'u_texture')
    const uResLoc = gl.getUniformLocation(program, 'u_resolution')
    const uRadius = gl.getUniformLocation(program, 'u_blurRadius')
    const uWeights = gl.getUniformLocation(program, 'u_blurWeights[0]') || gl.getUniformLocation(program, 'u_blurWeights')
    const blurAPos = gl.getAttribLocation(program, 'a_pos')
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, srcTex)
    gl.uniform1i(uTexLoc, 0)
    gl.uniform2f(uResLoc, canvas.width, canvas.height)
    gl.uniform1i(uRadius, blurKernel.radius)
    gl.uniform1fv(uWeights, blurKernel.kernel)
    gl.enableVertexAttribArray(blurAPos)
    gl.vertexAttribPointer(blurAPos, 2, gl.FLOAT, false, 0, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  const u = (name) => gl.getUniformLocation(prog, name)
  const uTex = u('u_texture')
  const uBlurredTex = u('u_blurred_texture')
  const uHasBlurred = u('u_has_blurred')
  const uRes = u('u_resolution')
  const uSidebarWidthPx = u('u_sidebar_width_px')
  const uModalRectLoc = u('u_modal_rect')
  const uModalRadiusLoc = u('u_modal_radius')
  const uModalProgressLoc = u('u_modal_progress')
  const uHasModalLoc = u('u_has_modal')
  const uPopoverCountLoc = u('u_popover_count')
  const uPopoversLoc = u('u_popovers[0]') || u('u_popovers')
  const uPopoverRadiiLoc = u('u_popover_radii[0]') || u('u_popover_radii')
  const uL1Blur = u('u_l1_blur')
  const uModalBlurLoc = u('u_modal_blur')
  const uL1Opacity = u('u_l1_opacity')
  const uL1Border = u('u_l1_border')
  const uHasChatLoc = u('u_has_chat')
  const uChatRectLoc = u('u_chat_rect')
  const uChatRadiusLoc = u('u_chat_radius')
  const uHasHeaderLoc = u('u_has_header')
  const uHeaderRectLoc = u('u_header_rect')
  const uLensesLoc = u('u_lenses[0]') || u('u_lenses')
  const uLensRadiiLoc = u('u_lens_radii[0]') || u('u_lens_radii')
  const uLensLayersLoc = u('u_lens_layers[0]') || u('u_lens_layers')
  const uLensCountLoc = u('u_lens_count')
  const uTime = u('u_time')
  const uIor = u('u_ior')
  const uBulge = u('u_bulge')
  const uDispersion = u('u_dispersion')
  const uBevel = u('u_bevel_width')
  const uLensBlur = u('u_lens_blur')
  const uRefThickness = u('u_ref_thickness')
  const uFresnelFactor = u('u_fresnel_factor')
  const uGlareFactor = u('u_glare_factor')
  const uDarkening = u('u_darkening')
  const uRimIntensity = u('u_rim_intensity')
  const uLightAngle = u('u_light_angle')
  const uVibrancy = u('u_vibrancy')
  const uRippleAmp = u('u_ripple_amp')
  const uShadowOpacity = u('u_shadow_opacity')
  const uShadowBlur = u('u_shadow_blur')
  const uShadowOffsetY = u('u_shadow_offset_y')
  const uBgLiquidEnabled = u('u_bg_liquid_enabled')
  const uBgAmp = u('u_bg_amp')
  const uBgScale = u('u_bg_scale')
  const uBgSpeed = u('u_bg_speed')
  const uBgDispersion = u('u_bg_dispersion')
  const uRip0 = u('u_ripple0')
  const uRip1 = u('u_ripple1')

  const ripples = [
    { x: 0, y: 0, time: -10, amp: 0 },
    { x: 0, y: 0, time: -10, amp: 0 },
  ]
  let ripIdx = 0
  let targetFrameMs = 1000 / 45
  let lastFrameTime = 0
  let animRunning = true
  const MAX_GLASS_W = 2560
  const MAX_GLASS_H = 1440

  function isVideoBg() {
    return document.documentElement.dataset.lgVideoBg === '1'
  }

  function perfProfile() {
    const video = isVideoBg()
    return {
      targetFrameMs: video ? 1000 / 28 : 1000 / 45,
      maxDpr: video ? 1.25 : 1.75,
      sceneScale: video ? 0.72 : 1,
    }
  }

  function scheduleFrame() {
    if (!disposed && animRunning) animId = requestAnimationFrame(frame)
  }

  const onVisibility = () => {
    animRunning = !document.hidden
    if (animRunning && !disposed) scheduleFrame()
  }
  document.addEventListener('visibilitychange', onVisibility)

  const onPointerDown = (e) => {
    const x = (e.clientX / window.innerWidth - 0.5) * (window.innerWidth / window.innerHeight)
    const y = 0.5 - e.clientY / window.innerHeight
    ripples[ripIdx] = { x, y, time: performance.now() * 0.001, amp: 1.0 }
    ripIdx = (ripIdx + 1) % 2
  }
  window.addEventListener('pointerdown', onPointerDown, { passive: true })

  function resize() {
    const profile = perfProfile()
    targetFrameMs = profile.targetFrameMs
    const dpr = Math.min(window.devicePixelRatio || 1, profile.maxDpr)
    const w = Math.min(window.innerWidth, MAX_GLASS_W)
    const h = Math.min(window.innerHeight, MAX_GLASS_H)
    canvas.width = Math.floor(w * dpr)
    canvas.height = Math.floor(h * dpr)
    sceneCanvas.width = Math.max(1, Math.floor(canvas.width * profile.sceneScale))
    sceneCanvas.height = Math.max(1, Math.floor(canvas.height * profile.sceneScale))
    gl.viewport(0, 0, canvas.width, canvas.height)
    ensureBlurTargets(canvas.width, canvas.height)
  }
  const onResize = () => {
    resize()
    if (!disposed && animRunning) scheduleFrame()
  }
  window.addEventListener('resize', onResize)
  resize()

  const lensBuffer = new Float32Array(64 * 4)
  const radiiBuffer = new Float32Array(64)
  const layersBuffer = new Float32Array(64)
  const frostBuffer = new Float32Array(16 * 4)
  const frostRadiiBuffer = new Float32Array(16)

  function applyGeometry(dpr, screenH, now) {
    const geo = hooks?.collectGeometry ? hooks.collectGeometry(dpr, screenH, now) : null

    let frostCount = 0
    frostBuffer.fill(0)
    frostRadiiBuffer.fill(0)
    for (const panel of geo?.frostPanels || []) {
      if (frostCount >= 16) break
      frostBuffer[frostCount * 4] = panel.centerX
      frostBuffer[frostCount * 4 + 1] = panel.centerY
      frostBuffer[frostCount * 4 + 2] = panel.halfW
      frostBuffer[frostCount * 4 + 3] = panel.halfH
      frostRadiiBuffer[frostCount] = panel.radius
      frostCount++
    }
    gl.uniform4fv(uPopoversLoc, frostBuffer)
    gl.uniform1fv(uPopoverRadiiLoc, frostRadiiBuffer)
    gl.uniform1i(uPopoverCountLoc, frostCount)
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
    gl.uniform4f(
      uModalRectLoc,
      modal?.modalCenterX ?? 0,
      modal?.modalCenterY ?? 0,
      modal?.modalHalfW ?? 0,
      modal?.modalHalfH ?? 0
    )
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
    for (const L of geo?.lenses || []) {
      if (count >= 64) break
      lensBuffer[count * 4] = L.centerX
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
  }

  function frame(now) {
    if (disposed || !animRunning) return
    if (now - lastFrameTime < targetFrameMs) {
      scheduleFrame()
      return
    }
    lastFrameTime = now
    try {
      const time = now * 0.001
      if (hooks?.drawScene) {
        hooks.drawScene(sceneCtx, sceneCanvas.width, sceneCanvas.height, opts, time)
      }

      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sceneCanvas)

      let hasBlurred = 0
      if (hasBlur && blurFboH && blurFboV && (opts.blurPassRadius ?? 0) > 0) {
        runBlurPass(blurHProg, tex, blurFboH.fb)
        runBlurPass(blurVProg, blurFboH.texture, blurFboV.fb)
        hasBlurred = 1
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.useProgram(prog)
      gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      gl.enableVertexAttribArray(aPos)
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

      const dpr = window.devicePixelRatio || 1
      const screenH = window.innerHeight
      applyGeometry(dpr, screenH, now)

      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.uniform1i(uTex, 0)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, hasBlurred ? blurFboV.texture : tex)
      gl.uniform1i(uBlurredTex, 1)
      gl.uniform1i(uHasBlurred, hasBlurred)

      gl.uniform2f(uRes, canvas.width, canvas.height)
      gl.uniform1f(uTime, time)
      gl.uniform1f(uIor, opts.ior)
      gl.uniform1f(uBulge, opts.bulge)
      gl.uniform1f(uDispersion, opts.dispersion)
      gl.uniform1f(uBevel, opts.bevel)
      gl.uniform1f(uLensBlur, opts.lensBlur * dpr)
      gl.uniform1f(uRefThickness, opts.refThickness ?? 20)
      gl.uniform1f(uFresnelFactor, opts.fresnelFactor ?? 0.38)
      gl.uniform1f(uGlareFactor, opts.glareFactor ?? 0.42)
      gl.uniform1f(uDarkening, opts.darkening)
      gl.uniform1f(uRimIntensity, opts.rimIntensity)
      gl.uniform1f(uLightAngle, opts.lightAngle)
      gl.uniform1f(uVibrancy, opts.vibrancy)
      gl.uniform1f(uRippleAmp, opts.rippleAmp)
      gl.uniform1f(uShadowOpacity, opts.dropShadowOpacity)
      gl.uniform1f(uShadowBlur, opts.dropShadowBlur * dpr)
      gl.uniform1f(uShadowOffsetY, opts.dropShadowY * dpr)
      gl.uniform1i(uBgLiquidEnabled, opts.bgLiquidEnabled ? 1 : 0)
      gl.uniform1f(uBgAmp, opts.bgLiquidAmp)
      gl.uniform1f(uBgScale, opts.bgLiquidScale)
      gl.uniform1f(uBgSpeed, opts.bgLiquidSpeed)
      gl.uniform1f(uBgDispersion, opts.bgLiquidDispersion)
      gl.uniform4f(uRip0, ripples[0].x, ripples[0].y, ripples[0].time, ripples[0].amp)
      gl.uniform4f(uRip1, ripples[1].x, ripples[1].y, ripples[1].time, ripples[1].amp)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    } catch (err) {
      console.error('[EfLiquidGlass] frame error:', err)
    } finally {
      scheduleFrame()
    }
  }
  scheduleFrame()

  return {
    update: (next) => {
      opts = { ...opts, ...next }
      if (next.blurPassRadius != null) {
        blurKernel = computeGaussianKernelByRadius(next.blurPassRadius)
      }
      resize()
      if (!disposed && animRunning) scheduleFrame()
    },
    dispose: () => {
      disposed = true
      cancelAnimationFrame(animId)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVisibility)
    },
    active: true,
  }
}

export function attachLiquidGlassShader(canvas, currentOpts, hooks) {
  let lastOpts = { ...currentOpts }
  let active = createLiquidGlassShader(canvas, lastOpts, hooks)
  let disposed = false
  let contextLost = false

  const onContextLost = (event) => {
    event.preventDefault()
    contextLost = true
    active.dispose()
  }
  const onContextRestored = () => {
    if (disposed || !contextLost) return
    contextLost = false
    active = createLiquidGlassShader(canvas, lastOpts, hooks)
  }

  canvas.addEventListener('webglcontextlost', onContextLost, { passive: false })
  canvas.addEventListener('webglcontextrestored', onContextRestored)

  return {
    get active() {
      return !disposed && !contextLost && active.active !== false
    },
    update: (next) => {
      lastOpts = { ...lastOpts, ...next }
      if (!contextLost && !disposed) active.update(next)
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      canvas.removeEventListener('webglcontextlost', onContextLost)
      canvas.removeEventListener('webglcontextrestored', onContextRestored)
      active.dispose()
    },
  }
}
