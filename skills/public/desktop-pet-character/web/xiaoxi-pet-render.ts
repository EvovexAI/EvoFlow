/**
 * 小汐立绘动画 —— 纯 canvas 2D 渲染，不依赖 React / DOM 框架。
 *
 * 移植自桌面宠物（PySide6）的「拆层立绘」做法，几何与配色一一对应：
 * - 立绘按脖子切成「头层 / 身体层」两个 srcRect，头绕脖子轴旋转，接缝被 OVERLAP 挡住
 * - 眨眼 = 取眼睛区域纵向压缩，先铺一层肤色再贴，压缩边缘不会露眼眶
 * - 说话 = 先铺肤色盖掉立绘自带的抿嘴，再按音节包络画「上宽下窄 + 嘴角上翘」的笑口
 *
 * 所有绘制都在 200x200 的设计空间里完成，调用方负责设置 transform。
 * 源坐标按 840x1333 原始立绘量，运行时乘 K（实际图宽 / 840）换算，换图尺寸不影响。
 */

export type PetMode = 'idle' | 'listening' | 'thinking' | 'answering'

export const PET_IMG_URL = '/assets/xiaoxi/girl.webp'
export const PET_DESIGN_SIZE = 200
/** 脚底在设计空间里的 y：定位时用它把人物「站」在指定高度 */
export const PET_FOOT_Y = 188

/* ── 立绘几何（按 840x1333 原始立绘量） ── */
const IMG_W = 840
const IMG_H = 1333
const BODY_H = 156
const WIDE = 1.07
const FOOT_Y = PET_FOOT_Y
const NECK_Y = 560
const OVERLAP = 110
const EYES: ReadonlyArray<readonly [number, number]> = [
  [306, 371],
  [485, 368],
]
const EYE_HALF: readonly [number, number] = [35, 46]
const MOUTH: readonly [number, number] = [397, 450]
const MOUTH_HALF: readonly [number, number] = [24, 13]
const BLUSH: ReadonlyArray<readonly [number, number]> = [
  [310, 418],
  [486, 415],
]
const BLUSH_HALF: readonly [number, number] = [32, 22]
const SKIN_HI = '#F2E0E0'
const SKIN_LO = '#EFD9D8'

const RAD = Math.PI / 180
const rgbCache = new Map<string, string>()

function rgbTriple(hex: string): string {
  let v = rgbCache.get(hex)
  if (!v) {
    const h = hex.replace('#', '')
    v = `${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)}`
    rgbCache.set(hex, v)
  }
  return v
}

/** Qt 里 alpha 是 0..255，这里保持同一口径（调用处直接写 Qt 的数值）。 */
export function rgba(hex: string, alpha255: number): string {
  const a = Math.max(0, Math.min(1, alpha255 / 255))
  return `rgba(${rgbTriple(hex)},${a.toFixed(3)})`
}

/** 说话音节包络：三层不同频率叠加 + 换气时的短暂闭口。 */
export function syllable(t: number): number {
  const a = Math.abs(Math.sin(t * 12.6))
  const b = Math.abs(Math.sin(t * 5.1 + 1.2))
  const c = Math.abs(Math.sin(t * 21.3 + 0.4))
  const env = 0.5 * a + 0.32 * b + 0.18 * c
  const slow = 0.5 + 0.5 * Math.sin(t * 1.9)
  const v = env * (0.68 + 0.54 * slow)
  const gap = Math.pow(Math.max(0, Math.sin(t * 1.15 + 2.2)), 8)
  return Math.max(0, Math.min(1, v * (1 - 0.85 * gap)))
}

/** 每种模式一套表情参数：(笑意, 张口度, 腮红)。 */
export function expression(mode: PetMode, t: number): [number, number, number] {
  if (mode === 'answering') return [0.72, syllable(t), 0.5 + 0.14 * Math.sin(t * 3.1)]
  if (mode === 'listening') return [0.82 + 0.07 * Math.sin(t * 2.1), 0.03, 0.3]
  if (mode === 'thinking') return [0.22, 0.05 + 0.04 * Math.abs(Math.sin(t * 1.4)), 0.1]
  return [
    0.46 + 0.09 * Math.sin(t * 0.62) + 0.05 * Math.sin(t * 1.7),
    0,
    0.2 + 0.06 * Math.sin(t * 0.62),
  ]
}

function drawEyes(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  k: number,
  sx: number,
  sy: number,
  left: number,
  topY: number,
  blink: number,
  smile: number,
): void {
  if (blink < 0.03 && smile < 0.4) return
  const [hw, hh] = EYE_HALF
  const b = Math.min(1, blink)
  for (const [ex, ey] of EYES) {
    const cx = left + ex * k * sx
    const cy = topY + ey * k * sy
    const rx = hw * k * sx * 1.06
    const ry = hh * k * sy * 1.12

    if (b >= 0.03) {
      const g = ctx.createLinearGradient(0, cy - ry, 0, cy + ry)
      g.addColorStop(0, SKIN_HI)
      g.addColorStop(1, SKIN_LO)
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
      ctx.fill()

      const hNow = ry * 2 * Math.max(0.06, 1 - 0.94 * b)
      ctx.drawImage(
        img,
        (ex - hw) * k,
        (ey - hh) * k,
        hw * 2 * k,
        hh * 2 * k,
        cx - rx,
        cy - hNow / 2,
        rx * 2,
        hNow,
      )

      if (b > 0.55) {
        ctx.strokeStyle = rgba('#6E7FA0', ((b - 0.55) / 0.45) * 235)
        ctx.lineWidth = Math.max(0.7, ry * 0.26)
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(cx - rx * 0.92, cy - ry * 0.1)
        ctx.quadraticCurveTo(cx, cy + ry * 0.42, cx + rx * 0.92, cy - ry * 0.1)
        ctx.stroke()
      }
    }

    // 笑眼：眼尾两道极淡的上挑
    if (smile > 0.4) {
      ctx.strokeStyle = rgba('#D98E96', 90 * Math.min(1, (smile - 0.4) / 0.45))
      ctx.lineWidth = Math.max(0.45, ry * 0.13)
      ctx.lineCap = 'round'
      for (const sgn of [-1, 1]) {
        ctx.beginPath()
        ctx.moveTo(cx + sgn * rx * 0.78, cy + ry * 1.02)
        ctx.lineTo(cx + sgn * rx * 0.56, cy + ry * 1.24)
        ctx.stroke()
      }
    }
  }
}

function drawBlush(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  k: number,
): void {
  if (k <= 0.02) return
  const rx = Math.max(hw * 1.35, hh * 1.3)
  const ry = hh * 1.3
  const kk = Math.min(1, k)
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rx)
  g.addColorStop(0, rgba('#F58B84', 50 * kk))
  g.addColorStop(0.45, rgba('#F58B84', 30 * kk))
  g.addColorStop(1, rgba('#F58B84', 0))
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
  ctx.fill()
}

function drawMouth(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  mode: PetMode,
  t: number,
): void {
  let [smile, opn] = expression(mode, t)
  smile = Math.max(0, Math.min(1, smile))
  opn = Math.max(0, Math.min(1, opn))

  // 盖掉立绘自带的抿嘴：范围刚好盖住原来那张小嘴，别在脸上留下亮斑
  const cov = ctx.createRadialGradient(cx, cy - hh * 0.05, 0, cx, cy - hh * 0.05, hw * 1.08)
  cov.addColorStop(0, rgba(SKIN_HI, 1))
  cov.addColorStop(0.55, rgba(SKIN_HI, 240))
  cov.addColorStop(0.85, rgba(SKIN_HI, 90))
  cov.addColorStop(1, rgba(SKIN_LO, 0))
  ctx.fillStyle = cov
  ctx.beginPath()
  ctx.ellipse(cx, cy - hh * 0.05, hw * 1.08, hh * 1.1, 0, 0, Math.PI * 2)
  ctx.fill()

  const lift = hh * (0.3 + 0.78 * smile) // 嘴角上扬量：表情的「笑」全在这里
  let w2 = hw * (1.0 + 0.1 * smile)

  if (opn < 0.14) {
    // ── 闭口：一条清楚的笑弧 ──
    ctx.strokeStyle = rgba('#C46E7A', 190)
    ctx.lineWidth = Math.max(0.7, hh * 0.26)
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(cx - w2, cy - lift)
    ctx.quadraticCurveTo(cx - w2 * 0.35, cy + hh * 0.16, cx, cy + hh * 0.24)
    ctx.quadraticCurveTo(cx + w2 * 0.35, cy + hh * 0.16, cx + w2, cy - lift)
    ctx.stroke()

    ctx.strokeStyle = rgba('#F1BDBB', 100)
    ctx.lineWidth = Math.max(0.4, hh * 0.15)
    ctx.beginPath()
    ctx.moveTo(cx - w2 * 0.46, cy + hh * 0.44)
    ctx.quadraticCurveTo(cx, cy + hh * 0.66, cx + w2 * 0.46, cy + hh * 0.44)
    ctx.stroke()
    return
  }

  // ── 开口说话 ──
  const oh = hh * (0.48 + 3.1 * opn)
  // 宽度单独走一条包络：有的音节是「啊」（竖），有的是「咿」（横）
  const shape = mode === 'answering' ? 0.86 + 0.3 * Math.abs(Math.sin(t * 9.1 + 1.1)) : 1
  w2 = hw * (1.14 + 0.3 * opn) * shape
  const cornerX = w2 * 1.06
  const vy = cy - oh * 0.22 // 张大时视觉重心上移，别把下巴吃光
  const corner = vy - lift // 嘴角永远高于上唇中线
  const topY = corner + oh * 0.34 // 上唇中线低于嘴角 = 笑口（几何永远成立）

  const cavity = new Path2D()
  cavity.moveTo(cx - cornerX, corner)
  cavity.quadraticCurveTo(cx - w2 * 0.52, topY - hh * 0.03, cx, topY)
  cavity.quadraticCurveTo(cx + w2 * 0.52, topY - hh * 0.03, cx + cornerX, corner)
  cavity.quadraticCurveTo(cx + cornerX * 0.64, vy + oh * 0.88, cx, vy + oh * 0.99)
  cavity.quadraticCurveTo(cx - cornerX * 0.64, vy + oh * 0.88, cx - cornerX, corner)
  cavity.closePath()

  const cg = ctx.createLinearGradient(0, topY, 0, vy + oh)
  cg.addColorStop(0, '#7E3A48')
  cg.addColorStop(0.42, '#A95665')
  cg.addColorStop(1, '#C87B85')
  ctx.fillStyle = cg
  ctx.strokeStyle = rgba('#B2606D', 210)
  ctx.lineWidth = Math.max(0.5, hh * 0.17)
  ctx.fill(cavity)
  ctx.stroke(cavity)

  // 口腔深处的阴影
  const deep = ctx.createRadialGradient(cx, topY + oh * 0.1, 0, cx, topY + oh * 0.1, w2 * 1.05)
  deep.addColorStop(0, rgba('#6E2F3C', 150))
  deep.addColorStop(1, rgba('#6E2F3C', 0))
  ctx.fillStyle = deep
  ctx.beginPath()
  ctx.ellipse(cx, topY + oh * 0.16, w2 * 0.98, oh * 0.52, 0, 0, Math.PI * 2)
  ctx.fill()

  // 上排牙齿：裁在口腔里，紧贴上唇内缘
  if (opn > 0.2) {
    ctx.save()
    ctx.clip(cavity)
    ctx.fillStyle = rgba('#FCEBE7', 95 + 70 * Math.min(1, (opn - 0.2) / 0.5))
    ctx.fillRect(cx - w2 * 0.62, topY - hh * 0.06, w2 * 1.24, oh * 0.15)
    ctx.restore()
  }

  // 舌头（扁一点，别像含了颗糖）
  if (opn > 0.34) {
    ctx.fillStyle = rgba('#CE7A85', 150)
    ctx.beginPath()
    ctx.ellipse(cx, vy + oh * 0.72, w2 * 0.4, oh * 0.12, 0, 0, Math.PI * 2)
    ctx.fill()
  }

  // 下唇外缘柔光
  ctx.strokeStyle = rgba('#EFB2B8', 120)
  ctx.lineWidth = Math.max(0.4, hh * 0.15)
  ctx.beginPath()
  ctx.moveTo(cx - cornerX * 0.58, vy + oh * 0.98)
  ctx.quadraticCurveTo(cx, vy + oh * 1.1, cx + cornerX * 0.58, vy + oh * 0.98)
  ctx.stroke()

  // 嘴角笑纹：把「在笑」这件事说清楚
  if (smile > 0.25) {
    ctx.strokeStyle = rgba('#C0707C', 200 * Math.min(1, (smile - 0.25) / 0.45))
    ctx.lineWidth = Math.max(0.45, hh * 0.15)
    for (const sgn of [-1, 1]) {
      ctx.beginPath()
      ctx.moveTo(cx + sgn * cornerX * 0.98, corner + hh * 0.22)
      ctx.quadraticCurveTo(
        cx + sgn * cornerX * 1.16,
        corner - hh * 0.16,
        cx + sgn * cornerX * 1.06,
        corner - hh * 0.72,
      )
      ctx.stroke()
    }
  }
}

/** 耳侧声波：聆听 / 播报时从脸侧向外散的三道弧。 */
function drawArcs(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  phase: number,
  color: string,
  count: number,
  r0: number,
  gap: number,
  span: number,
): void {
  ctx.lineCap = 'round'
  for (let i = 0; i < count; i++) {
    const k = (Math.sin(phase * 2.4 - i * 0.9) + 1) * 0.5
    const r = r0 + i * gap
    ctx.strokeStyle = rgba(color, 45 + 155 * k * (1 - i * 0.15))
    ctx.lineWidth = 2.2
    ctx.beginPath()
    ctx.arc(cx, cy, r, -span * 0.5 * RAD, span * 0.5 * RAD)
    ctx.stroke()
  }
}

/** 思考：脑侧三个上浮的小点。 */
function drawDots(ctx: CanvasRenderingContext2D, phase: number): void {
  const pts: Array<[number, number, number]> = [
    [133, 32, 4.2],
    [141, 24, 3.2],
    [148, 17, 2.3],
  ]
  for (let i = 0; i < pts.length; i++) {
    const [x, y, r] = pts[i]
    const k = (Math.sin(phase * 2.6 - i * 0.8) + 1) * 0.5
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 2.8)
    g.addColorStop(0, rgba('#8FC8FF', 26 + 58 * k))
    g.addColorStop(1, rgba('#8FC8FF', 0))
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(x, y, r * 2.8, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = rgba('#F2F8FF', 150 + 100 * k)
    ctx.beginPath()
    ctx.arc(x, y, r * (0.9 + 0.1 * k), 0, Math.PI * 2)
    ctx.fill()
  }
}

/**
 * 画一帧。ctx 的 transform 需已把 200x200 设计空间映射到目标区域。
 * @param k 实际图宽 / 840（源坐标换算系数）
 */
export function drawPetFrame(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource & { width?: number; naturalWidth?: number; height?: number },
  mode: PetMode,
  t: number,
  blink: number,
  k: number,
): void {
  ctx.clearRect(0, 0, PET_DESIGN_SIZE, PET_DESIGN_SIZE)

  const sy = BODY_H / IMG_H
  const sx = sy * WIDE
  const w = IMG_W * sx
  const left = 100 - w / 2
  const topY = FOOT_Y - IMG_H * sy
  const bob = Math.sin(t * 1.55) * 2.1

  // 脚下淡影：没有它整个人像贴纸浮在光晕上
  const sw = Math.max(24, 40 - bob * 0.8)
  const shadow = ctx.createRadialGradient(100, 191, 0, 100, 191, sw)
  shadow.addColorStop(0, rgba('#33425C', 64))
  shadow.addColorStop(1, rgba('#33425C', 0))
  ctx.fillStyle = shadow
  ctx.beginPath()
  ctx.ellipse(100, 191, sw, 9, 0, 0, Math.PI * 2)
  ctx.fill()

  // ── 身体层 ──
  const cut = NECK_Y - OVERLAP
  const bodyTop = topY + cut * sy + bob * 0.55
  ctx.drawImage(img, 0, cut * k, IMG_W * k, (IMG_H - cut) * k, left, bodyTop, w, (IMG_H - cut) * sy)

  // ── 头层：绕脖子转 ──
  const base =
    mode === 'thinking' ? -4.2 : mode === 'listening' ? 5.2 : mode === 'answering' ? -1.4 : 0
  const sway = mode === 'idle' ? Math.sin(t * 0.9) * 1.7 : Math.sin(t * 1.6) * 0.9
  let nod = 0
  if (mode === 'answering') nod = Math.sin(t * 9.7) * 1.9 + Math.sin(t * 3.4) * 1.1
  else if (mode === 'thinking') nod = -Math.sin(t * 1.2)
  const rot = base + sway + nod

  const neck = topY + NECK_Y * sy + bob
  const headSrcH = NECK_Y + OVERLAP
  ctx.save()
  ctx.translate(100, neck)
  ctx.rotate(rot * RAD)
  ctx.translate(-100, -neck)

  let hy = topY + bob * 0.85
  if (mode === 'answering') hy -= syllable(t) * 1.3 // 说话时脑袋跟着音节轻点

  ctx.drawImage(img, 0, 0, IMG_W * k, headSrcH * k, left, hy, w, headSrcH * sy)

  const [smile, , blush] = expression(mode, t)
  for (const [bx, by] of BLUSH) {
    drawBlush(
      ctx,
      left + bx * k * sx,
      hy + by * k * sy,
      BLUSH_HALF[0] * k * sx,
      BLUSH_HALF[1] * k * sy,
      blush,
    )
  }
  drawEyes(ctx, img as HTMLImageElement, k, sx, sy, left, hy, blink, smile)
  drawMouth(
    ctx,
    left + MOUTH[0] * k * sx,
    hy + MOUTH[1] * k * sy,
    MOUTH_HALF[0] * k * sx,
    MOUTH_HALF[1] * k * sy,
    mode,
    t,
  )
  ctx.restore()

  if (mode === 'thinking') drawDots(ctx, t)
  else if (mode === 'listening') drawArcs(ctx, 150, 74, t, '#7FC8FF', 3, 8, 6.4, 72)
  else if (mode === 'answering') drawArcs(ctx, 126, 96, t, '#A6DCFF', 3, 6.4, 5.4, 54)
}
