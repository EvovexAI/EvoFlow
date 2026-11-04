/**
 * 小V立绘动画 —— 纯 canvas 2D 渲染，不依赖 React / DOM 框架。
 *
 * 移植自桌面宠物（PySide6）的「拆层立绘」做法，几何与配色一一对应：
 * - 立绘按脖子切成「头层 / 身体层」两个 srcRect，头绕脖子轴旋转，接缝被 OVERLAP 挡住
 * - 眨眼 = 取眼睛区域纵向压缩，先铺一层肤色再贴，压缩边缘不会露眼眶
 * - 说话 = 先铺肤色盖掉立绘自带的抿嘴，再按音节包络画「上宽下窄 + 嘴角上翘」的笑口
 * - listening = 手扶着耳朵在听：袖子从身侧弯上来，竖掌贴在头侧
 * - coding = 坐姿立绘（第二张图）敲键盘：键光连闪、双手点按、脑袋一顿一顿
 *
 * 所有绘制都在 200x200 的设计空间里完成，调用方负责设置 transform。
 * 源坐标按 840x1333（站姿）/ 1024x852（坐姿）原始立绘量，运行时乘 K（实际图宽 / 原图宽）换算。
 */

export type PetMode = 'idle' | 'listening' | 'thinking' | 'answering' | 'coding' | 'dancing' | 'teaching'

export const PET_IMG_URL = '/assets/xiaoxi/girl.webp'
export const PET_DESK_IMG_URL = '/assets/xiaoxi/girl_desk.webp'
/** 贴图手：ImageGen 按角色画风生成、tools/make_hands.py 抠图（与桌面端共用素材） */
export const PET_HAND_URLS = {
  open: '/assets/xiaoxi/hand_open.png',
  relax: '/assets/xiaoxi/hand_relax.png',
  point: '/assets/xiaoxi/hand_point.png',
} as const
export type PetHandName = keyof typeof PET_HAND_URLS
/** 调用方把加载好的手部贴图传进来；没加载完成时回退到程序化手掌 */
export type PetHandImages = Partial<Record<PetHandName, CanvasImageSource & { width?: number; height?: number }>>
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

/* ── 坐姿立绘几何（按 1024x852 原图量，与桌面端 D_* 一一对应） ── */
const D_IMG_W = 1024
const D_IMG_H = 852
const D_WIDTH = 196 // 整张坐姿图在 200 设计空间里的宽度
const D_BOTTOM = 197 // 图底边落点
const D_NECK_Y = 492
const D_OVERLAP = 120
const D_EYES: ReadonlyArray<readonly [number, number]> = [
  [430, 330],
  [600, 325],
]
const D_EYE_HALF: readonly [number, number] = [56, 38]
const D_MOUTH: readonly [number, number] = [505, 426]
const D_MOUTH_HALF: readonly [number, number] = [17, 12]
const D_BLUSH: ReadonlyArray<readonly [number, number]> = [
  [430, 396],
  [601, 392],
]
const D_HANDS: ReadonlyArray<readonly [number, number]> = [
  [380, 700],
  [585, 694],
]
const D_HAND_HALF: readonly [number, number] = [52, 40]
const D_KB: readonly [number, number, number, number] = [467, 748, 386, 84]
const D_SKIN_HI = '#E8E0E3'
const D_SKIN_LO = '#E1D8DC'

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
  if (mode === 'coding') return [0.34, 0.62 * syllable(t * 0.55), 0.26]
  if (mode === 'dancing') {
    // 边跳边跟着哼：笑得最开、腮红最浓
    return [0.95, 0.5 * syllable(t * 1.25), 0.6 + 0.15 * Math.sin(t * 3.3)]
  }
  if (mode === 'teaching') {
    // 讲课：一直在说，句读之间换气
    return [0.55, 0.85 * syllable(t * 0.9), 0.32]
  }
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
  eyes: ReadonlyArray<readonly [number, number]>,
  eyeHalf: readonly [number, number],
  blink: number,
  smile: number,
): void {
  if (blink < 0.03 && smile < 0.4) return
  const [hw, hh] = eyeHalf
  const b = Math.min(1, blink)
  for (const [ex, ey] of eyes) {
    // 显示坐标用 sx/sy（840 口径 → 设计空间）；k 只用于源像素换算，二者相乘会随素材尺寸漂移
    const cx = left + ex * sx
    const cy = topY + ey * sy
    const rx = hw * sx * 1.06
    const ry = hh * sy * 1.12

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
  hi: string = SKIN_HI,
  lo: string = SKIN_LO,
): void {
  let [smile, opn] = expression(mode, t)
  smile = Math.max(0, Math.min(1, smile))
  opn = Math.max(0, Math.min(1, opn))

  // 盖掉立绘自带的抿嘴：范围刚好盖住原来那张小嘴，别在脸上留下亮斑
  const cov = ctx.createRadialGradient(cx, cy - hh * 0.05, 0, cx, cy - hh * 0.05, hw * 1.08)
  cov.addColorStop(0, rgba(hi, 1))
  cov.addColorStop(0.55, rgba(hi, 240))
  cov.addColorStop(0.85, rgba(hi, 90))
  cov.addColorStop(1, rgba(lo, 0))
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
  const shape =
    mode === 'answering' || mode === 'teaching' ? 0.86 + 0.3 * Math.abs(Math.sin(t * 9.1 + 1.1)) : 1
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
 * 贴图手：把抠好的真手 sprite 画在 (cx,cy)——腕口 pivot，绕腕旋转。
 * h 是目标高度（设计空间 px）；mirror 把右手变成左手。
 * 返回 false 表示贴图没加载好，调用方走程序化手掌回退。
 */
function drawHandSprite(
  ctx: CanvasRenderingContext2D,
  hands: PetHandImages | null,
  name: PetHandName,
  cx: number,
  cy: number,
  rot: number,
  h: number,
  mirror = false,
): boolean {
  const sp = hands?.[name]
  if (!sp) return false
  const iw = sp.width ?? 0
  const ih = sp.height ?? 0
  if (!iw || !ih) return false
  const w = h * (iw / ih)
  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate(rot)
  if (mirror) ctx.scale(-1, 1)
  ctx.drawImage(sp, -w / 2, -h + 2, w, h)
  ctx.restore()
  return true
}

/** 聆听：一只手举起来扶着头侧——耳朵被长发盖着，掌心贴上去就是"扶耳"。 */
function drawHandOnEar(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  left: number,
  topY: number,
  hands: PetHandImages | null,
): void {
  const P = (x: number, y: number): [number, number] => [left + x * sx, topY + y * sy]
  const [ax, ay] = P(706, 706) // 臂根（藏进身体轮廓）
  const [bx, by] = P(716, 560)
  const [wx, wy] = P(655, 470) // 手腕

  ctx.lineCap = 'round'
  // 小臂袖子：先描边层再亮层，读得出是一条手臂
  ctx.beginPath()
  ctx.moveTo(ax, ay)
  ctx.quadraticCurveTo(bx, by, wx, wy)
  ctx.strokeStyle = rgba('#9FB4C6', 150)
  ctx.lineWidth = 48 * sx
  ctx.stroke()
  const sg = ctx.createLinearGradient(ax, ay, wx, wy)
  sg.addColorStop(0, '#C7D6E2')
  sg.addColorStop(1, '#F0F5FA')
  ctx.strokeStyle = sg
  ctx.lineWidth = 43 * sx
  ctx.stroke()

  // 腕口
  const [cx, cy] = P(652, 468)
  ctx.fillStyle = '#EDF3F8'
  ctx.strokeStyle = rgba('#9FB4C6', 120)
  ctx.lineWidth = Math.max(0.6, 1.8 * sx)
  ctx.beginPath()
  ctx.ellipse(cx, cy, 26 * sx, 17 * sy, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()

  // 手掌：贴图手（真手形）绕腕微转；没加载好时回退到程序化椭圆
  const [px, py] = P(645, 425)
  if (drawHandSprite(ctx, hands, 'relax', px, py, -0.24, 26)) return
  ctx.save()
  ctx.translate(px, py)
  ctx.rotate(-0.24)
  const pg = ctx.createLinearGradient(0, -55 * sy, 0, 40 * sy)
  pg.addColorStop(0, SKIN_HI)
  pg.addColorStop(1, SKIN_LO)
  ctx.fillStyle = pg
  ctx.strokeStyle = rgba('#D9A8A6', 140)
  ctx.lineWidth = Math.max(0.7, 2.0 * sx)
  ctx.beginPath()
  ctx.ellipse(0, 0, 27 * sx, 56 * sy, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
  ctx.beginPath()
  ctx.ellipse(-24 * sx, 30 * sy, 11 * sx, 14 * sy, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
  ctx.strokeStyle = rgba('#D9A8A6', 130)
  ctx.lineWidth = Math.max(0.5, 1.3 * sx)
  for (const dx of [-13, 0, 13]) {
    ctx.beginPath()
    ctx.moveTo(dx * sx, -46 * sy)
    ctx.quadraticCurveTo((dx + 2) * sx, -22 * sy, dx * sx, 0)
    ctx.stroke()
  }
  ctx.restore()
}

/** 画一条"袖子手臂"：粗描边双层（描边层 + 亮层），浅色贴近裙子，读得出是一条手臂。 */
function drawSleeveArm(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  a: [number, number],
  b: [number, number],
  w: [number, number],
  widthDesign = 8,
): void {
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(a[0], a[1])
  ctx.quadraticCurveTo(b[0], b[1], w[0], w[1])
  ctx.strokeStyle = rgba('#A9C0D2', 130)
  ctx.lineWidth = widthDesign + 1.4
  ctx.stroke()
  const sg = ctx.createLinearGradient(a[0], a[1], w[0], w[1])
  sg.addColorStop(0, '#CBDCE9')
  sg.addColorStop(1, '#EDF3F9')
  ctx.strokeStyle = sg
  ctx.lineWidth = widthDesign
  ctx.stroke()
}

/** 张开的竖长手掌（指缝 + 拇指），在 (x,y) 处绕腕旋转。 */
function drawOpenPalm(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  x: number,
  y: number,
  rot: number,
): void {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(rot)
  const pg = ctx.createLinearGradient(0, -58 * sy, 0, 44 * sy)
  pg.addColorStop(0, SKIN_HI)
  pg.addColorStop(1, SKIN_LO)
  ctx.fillStyle = pg
  ctx.strokeStyle = rgba('#D9A8A6', 150)
  ctx.lineWidth = Math.max(0.8, 2.2 * sx)
  ctx.beginPath()
  ctx.ellipse(0, 0, 26 * sx, 60 * sy, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
  ctx.beginPath()
  ctx.ellipse(-20 * sx, 14 * sy, 9 * sx, 16 * sy, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
  ctx.strokeStyle = rgba('#D9A8A6', 160)
  ctx.lineWidth = Math.max(0.6, 1.4 * sx)
  for (const dx of [-15, -5, 5, 15]) {
    ctx.beginPath()
    ctx.moveTo(dx * sx, -50 * sy)
    ctx.quadraticCurveTo((dx + 2) * sx, -26 * sy, dx * sx, 6 * sy)
    ctx.stroke()
  }
  ctx.restore()
}

/** dancing：双手举过头顶，跟着节拍反相挥。 */
function drawDanceHands(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  left: number,
  topY: number,
  t: number,
  hands: PetHandImages | null,
): void {
  const P = (x: number, y: number): [number, number] => [left + x * sx, topY + y * sy]
  const beat = t * 3.3
  for (const sgn of [-1, 1] as const) {
    const phase = sgn < 0 ? beat : beat + Math.PI
    drawSleeveArm(
      ctx,
      sx,
      sy,
      P(420 + sgn * 290, 700),
      P(420 + sgn * 372, 430),
      P(420 + sgn * 278, 108 + 12 * Math.sin(phase)),
    )
    const [wx, wy] = P(420 + sgn * 278, 108 + 12 * Math.sin(phase))
    // 贴图真手（左镜像）；没加载好时回退到程序化手掌
    if (
      !drawHandSprite(
        ctx,
        hands,
        'open',
        wx,
        wy,
        Math.sin(phase) * 0.32 * sgn + sgn * 0.15,
        27,
        sgn < 0,
      )
    ) {
      drawOpenPalm(ctx, sx, sy, wx, wy, Math.sin(phase) * 0.32 * sgn + sgn * 0.15)
    }
  }
}

/** dancing：音符从身体两侧飘上来（别飘到脸上）。 */
function drawNotes(ctx: CanvasRenderingContext2D, t: number): void {
  const cols = ['#7FC8FF', '#F2A6C0', '#9EE6C8']
  const xs = [34, 166, 52]
  for (let i = 0; i < 3; i++) {
    const ph = (t * 0.42 + i * 0.37) % 1
    const x = xs[i] + Math.sin(ph * 5 + i * 2) * 4
    const y = 138 - ph * 80
    const a = Math.round(235 * Math.sin(ph * Math.PI))
    if (a <= 8) continue
    const col = cols[i]
    const s = 1.15 + 0.15 * Math.sin(t * 6 + i)
    ctx.fillStyle = rgba(col, a)
    ctx.beginPath()
    ctx.ellipse(x - 2.9 * s, y + 3.6 * s, 3.7 * s, 2.9 * s, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = rgba(col, a)
    ctx.lineWidth = Math.max(1, 1.3 * s)
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(x + 0.6 * s, y + 3.6 * s)
    ctx.lineTo(x + 0.6 * s, y - 6.5 * s)
    ctx.quadraticCurveTo(x + 5.5 * s, y - 5 * s, x + 6.5 * s, y - 1.5 * s)
    ctx.stroke()
  }
}

/** teaching：身旁的小白板，要点一条条"写"出来。 */
function drawBoard(ctx: CanvasRenderingContext2D, t: number): void {
  const x0 = 132
  const y0 = 34
  const bw = 60
  const bh = 74
  ctx.fillStyle = rgba('#33425C', 40)
  ctx.beginPath()
  ctx.roundRect(x0 + 2.5, y0 + 3, bw, bh, 6)
  ctx.fill()
  ctx.fillStyle = '#F7FAFD'
  ctx.strokeStyle = rgba('#9FB4C6', 220)
  ctx.lineWidth = 1.6
  ctx.beginPath()
  ctx.roundRect(x0, y0, bw, bh, 6)
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = rgba('#7FA8D9', 200)
  ctx.beginPath()
  ctx.roundRect(x0 + 7, y0 + 8, bw * 0.52, 4.4, 2.2)
  ctx.fill()
  const cycle = (t * 0.45) % 1
  for (let i = 0; i < 3; i++) {
    const yy = y0 + 22 + i * 14
    const frac = Math.max(0, Math.min(1, cycle * 3.8 - i))
    ctx.fillStyle = rgba('#8FA9C4', 200)
    ctx.beginPath()
    ctx.arc(x0 + 4.2, yy + 1.7, 1.5, 0, Math.PI * 2)
    ctx.fill()
    if (frac <= 0.02) {
      ctx.fillStyle = rgba('#C3D2E0', 130)
      ctx.beginPath()
      ctx.roundRect(x0 + 8, yy, 6, 3.4, 1.7)
      ctx.fill()
    } else {
      ctx.fillStyle = rgba('#5B7FA6', 235)
      ctx.beginPath()
      ctx.roundRect(x0 + 8, yy, Math.max(6, (bw - 16) * frac), 3.4, 1.7)
      ctx.fill()
    }
  }
}

/** teaching：右臂抬向白板，食指手随音节比划。 */
function drawTeachArm(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  left: number,
  topY: number,
  t: number,
  hands: PetHandImages | null,
): void {
  const P = (x: number, y: number): [number, number] => [left + x * sx, topY + y * sy]
  const swing = Math.sin(t * 6.3) * 0.1 * (0.35 + 0.65 * syllable(t * 0.9))
  drawSleeveArm(ctx, sx, sy, P(700, 690), P(758, 560), P(738, 420))
  const [wx, wy] = P(738, 420)
  if (!drawHandSprite(ctx, hands, 'point', wx, wy, swing - 0.45, 25)) {
    drawOpenPalm(ctx, sx, sy, wx, wy, swing - 0.45)
  }
}

/** 两只手合成一个 0~1 的"正在敲"的强度，喂给键光和身体起伏。 */
export function tapEnergy(t: number): number {
  let e = 0
  for (let i = 0; i < 2; i++) {
    e = Math.max(e, Math.max(0, Math.sin(t * 34.5 + i * 1.9)) ** 2)
  }
  return e
}

/** 坐姿键盘光：AO → 冷蓝背光 → 前缘灯条 → 按键点亮 → 加色晕光。 */
function drawKbLights(
  ctx: CanvasRenderingContext2D,
  s: number,
  left: number,
  top: number,
  t: number,
  energy: number,
): void {
  const [kx, ky, kw, kh] = D_KB
  const cx = left + kx * s
  const cy = top + ky * s
  const w = kw * s
  const h = kh * s
  const rows = 4
  const cols = 15

  const keyPos = (r: number, c: number): [number, number, number] => {
    const yy = cy - h * 0.26 + r * h * 0.175
    const inset = w * (0.052 + 0.02 * r)
    const span = w - inset * 2
    return [cx - w / 2 + inset + (span * (c + 0.5)) / cols, yy, span / cols]
  }

  // 键盘压在桌面上的暗部
  let g = ctx.createRadialGradient(cx, cy + h * 0.4, 0, cx, cy + h * 0.4, w * 0.5)
  g.addColorStop(0, rgba('#2F4A66', 58))
  g.addColorStop(1, rgba('#2F4A66', 0))
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.ellipse(cx, cy + h * 0.42, w * 0.5, h * 0.34, 0, 0, Math.PI * 2)
  ctx.fill()

  // 键帽常亮背光：整块键区罩冷蓝，白键帽先压暗，光才看得见
  g = ctx.createLinearGradient(0, cy - h * 0.42, 0, cy + h * 0.46)
  g.addColorStop(0, rgba('#2E5E8C', 96))
  g.addColorStop(0.55, rgba('#2A5C8A', 74))
  g.addColorStop(1, rgba('#20486E', 96))
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.roundRect(cx - w * 0.455, cy - h * 0.36, w * 0.91, h * 0.8, h * 0.12)
  ctx.fill()

  // 前缘灯条：一道实打实的青色亮边，随敲击节奏一明一暗
  g = ctx.createLinearGradient(0, cy + h * 0.22, 0, cy + h * 0.5)
  g.addColorStop(0, rgba('#7FE4FF', 0))
  g.addColorStop(0.3, rgba('#5FDAFF', 140 + 110 * energy))
  g.addColorStop(0.62, rgba('#22B6F0', 80 + 80 * energy))
  g.addColorStop(1, rgba('#1272A8', 0))
  ctx.fillStyle = g
  ctx.fillRect(cx - w * 0.43, cy + h * 0.22, w * 0.86, h * 0.3)

  // 被按下的键：每只手在自己掌下点亮
  const hits: Array<[[number, number, number], number]> = []
  for (let i = 0; i < 2; i++) {
    const [hx] = D_HANDS[i]
    const baseC = ((left + hx * s - (cx - w / 2)) / w) * cols
    for (let j = 0; j < 3; j++) {
      const tick = t * 9.5 + i * 1.7 + j * 0.33
      const kk = Math.floor(tick)
      const frac = tick - kk
      if (frac > 0.72) continue
      const c = Math.max(0, Math.min(cols - 1, Math.trunc(baseC + ((kk * 5 + j * 7 + i * 3) % 5) - 2)))
      const r = (kk * 3 + j * 2 + i) % rows
      hits.push([keyPos(r, c), (1 - frac / 0.72) ** 1.4])
    }
  }
  for (const [[x, y, cell], a] of hits) {
    ctx.fillStyle = rgba('#8FEBFF', 60 + 175 * a)
    ctx.beginPath()
    ctx.roundRect(x - cell * 0.34, y, cell * 0.68, h * 0.09, h * 0.03)
    ctx.fill()
  }

  // 加色层：晕光 + 灯条外扩柔光
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  for (const [[x, y, cell], a] of hits) {
    g = ctx.createRadialGradient(x, y + h * 0.04, 0, x, y + h * 0.04, cell * 1.35)
    g.addColorStop(0, rgba('#6FE0FF', 120 * a))
    g.addColorStop(0.4, rgba('#35A8FF', 56 * a))
    g.addColorStop(1, rgba('#35A8FF', 0))
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.ellipse(x, y + h * 0.04, cell * 1.35, h * 0.17, 0, 0, Math.PI * 2)
    ctx.fill()
  }
  g = ctx.createLinearGradient(0, cy + h * 0.1, 0, cy + h * 0.66)
  g.addColorStop(0, rgba('#38B8FF', 0))
  g.addColorStop(0.34, rgba('#38B8FF', 46 + 84 * energy))
  g.addColorStop(1, rgba('#38B8FF', 0))
  ctx.fillStyle = g
  ctx.fillRect(cx - w * 0.48, cy + h * 0.1, w * 0.96, h * 0.56)
  ctx.restore()
}

/** 坐姿双手：直接从坐姿立绘抠手区域贴回（真手形）。实手以腕为轴抬起/压扁随节拍敲击，先拖影再实手。 */
function drawTypingHands(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  dk: number,
  s: number,
  left: number,
  top: number,
  t: number,
): void {
  const [hw, hh] = D_HAND_HALF
  for (let i = 0; i < 2; i++) {
    const [hx, hy] = D_HANDS[i]
    const bx = left + hx * s
    const by = top + hy * s
    const rx = hw * s
    const ry = hh * s
    const ph = t * 34.5 + i * 1.9
    const hit = Math.max(0, Math.sin(ph)) ** 2
    const tap = Math.max(0, Math.sin(ph * 0.5 + 0.7)) ** 2
    const k = Math.min(1, hit * 0.72 + tap * 0.28)
    // 抬起：指尖以腕为轴离键（纵向收）；落下：压扁加宽（击键的力道感）
    const dy = -k * 3.2
    const hNow = ry * 2 * (1 - 0.16 * k)
    const wNow = rx * 2 * (1 + 0.05 * k)
    const dx = Math.sin(t * 17.3 + i * 2.4) * s * 2
    const sx0 = (hx - hw) * dk
    const sy0 = (hy - hh) * dk
    const sw = hw * 2 * dk
    const sh = hh * 2 * dk

    // 拖影：贴着手部区域的运动模糊（不能抬进袖口，否则会复制出矩形色块）
    ctx.globalAlpha = 0.06 + 0.38 * k
    ctx.drawImage(
      img,
      sx0,
      sy0,
      sw,
      sh,
      bx + dx - wNow * 0.48,
      by + dy - 2.6 - hNow * 0.44,
      wNow * 0.96,
      hNow * 0.88,
    )
    // 实手：在动位置盖回去（抬到最高时露出原位烙手 ~3px，天然是接触阴影）
    ctx.globalAlpha = 0.97
    ctx.drawImage(img, sx0, sy0, sw, sh, bx - wNow / 2, by + dy - hNow / 2, wNow, hNow)
    ctx.globalAlpha = 1
  }
}

/** coding：坐姿敲键盘整帧（1024x852 立绘，几何与桌面端 D_* 一致）。 */
function drawDeskFrame(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource & { width?: number; naturalWidth?: number },
  t: number,
  blink: number,
): void {
  ctx.clearRect(0, 0, PET_DESIGN_SIZE, PET_DESIGN_SIZE)
  const dk = ((img as HTMLImageElement).naturalWidth || D_IMG_W) / D_IMG_W
  const s = D_WIDTH / D_IMG_W
  const left = 100 - D_WIDTH / 2
  const top = D_BOTTOM - D_IMG_H * s

  const tap = tapEnergy(t)
  // 身体只做慢呼吸起伏 + 极轻的击键下沉——大幅快抖会变成"胳膊在动"
  const bodyDy = -(0.5 + 0.5 * Math.sin(t * 1.9)) * 1.1 - tap * 0.5

  // 桌面落地的影子
  let g = ctx.createRadialGradient(100, 195, 0, 100, 195, 96)
  g.addColorStop(0, rgba('#2E3B52', 60))
  g.addColorStop(1, rgba('#2E3B52', 0))
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.ellipse(100, 195, 96, 9, 0, 0, Math.PI * 2)
  ctx.fill()

  // 身体层
  const cut = D_NECK_Y - D_OVERLAP
  ctx.drawImage(
    img,
    0,
    cut * dk,
    D_IMG_W * dk,
    (D_IMG_H - cut) * dk,
    left,
    top + cut * s + bodyDy,
    D_WIDTH,
    (D_IMG_H - cut) * s,
  )

  drawKbLights(ctx, s, left, top, t, tap)
  drawTypingHands(ctx, img, dk, s, left, top, t)

  // 头层：跟着按键一顿一顿
  const nod = Math.sin(t * 6.3) * 1.5 + Math.sin(t * 2.2) * 0.8
  const neck = top + D_NECK_Y * s + bodyDy
  ctx.save()
  ctx.translate(100, neck)
  ctx.rotate((-1.2 + nod * 0.55) * RAD)
  ctx.translate(-100, -neck)

  const hy = top + bodyDy * 1.05
  ctx.drawImage(
    img,
    0,
    0,
    D_IMG_W * dk,
    (D_NECK_Y + D_OVERLAP) * dk,
    left,
    hy,
    D_WIDTH,
    (D_NECK_Y + D_OVERLAP) * s,
  )

  const [smile, , blush] = expression('coding', t)
  for (const [bx2, by2] of D_BLUSH) {
    drawBlush(ctx, left + bx2 * s, hy + by2 * s, 32 * s, 22 * s, blush * 1.05)
  }
  drawEyes(ctx, img as HTMLImageElement, dk, s, s, left, hy, D_EYES, D_EYE_HALF, blink, smile)
  drawMouth(
    ctx,
    left + D_MOUTH[0] * s,
    hy + D_MOUTH[1] * s,
    D_MOUTH_HALF[0] * s,
    D_MOUTH_HALF[1] * s,
    'coding',
    t,
    D_SKIN_HI,
    D_SKIN_LO,
  )
  ctx.restore()

  // 屏幕反光：从键盘方向打上来的一点冷光
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  const [kx, ky] = D_KB
  g = ctx.createRadialGradient(left + kx * s, top + (ky - 190) * s, 0, left + kx * s, top + (ky - 190) * s, 100 * 0.44 * 2)
  g.addColorStop(0, rgba('#5FB4FF', 22))
  g.addColorStop(1, rgba('#5FB4FF', 0))
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.ellipse(left + (kx - 20) * s, top + (ky - 200) * s, 100 * 0.44 * 2, 100 * 0.3 * 2, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/**
 * 画一帧。ctx 的 transform 需已把 200x200 设计空间映射到目标区域。
 * @param k 实际图宽 / 840（源坐标换算系数）
 * @param deskImg 坐姿立绘（coding 态用），1024x852 口径
 */
export function drawPetFrame(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource & { width?: number; naturalWidth?: number; height?: number },
  mode: PetMode,
  t: number,
  blink: number,
  k: number,
  deskImg?: CanvasImageSource & { width?: number; naturalWidth?: number } | null,
  hands?: PetHandImages | null,
): void {
  if (mode === 'coding' && deskImg) {
    drawDeskFrame(ctx, deskImg, t, blink)
    return
  }
  ctx.clearRect(0, 0, PET_DESIGN_SIZE, PET_DESIGN_SIZE)

  const sy = BODY_H / IMG_H
  const sx = sy * WIDE
  const w = IMG_W * sx
  const left = 100 - w / 2
  const topY = FOOT_Y - IMG_H * sy
  const beat = t * 3.3
  const bob = mode === 'dancing' ? -Math.abs(Math.sin(beat)) * 4.6 : Math.sin(t * 1.55) * 2.1

  // 脚下淡影：没有它整个人像贴纸浮在光晕上
  const sw = Math.max(24, 40 - bob * 0.8)
  const shadow = ctx.createRadialGradient(100, 191, 0, 100, 191, sw)
  shadow.addColorStop(0, rgba('#33425C', 64))
  shadow.addColorStop(1, rgba('#33425C', 0))
  ctx.fillStyle = shadow
  ctx.beginPath()
  ctx.ellipse(100, 191, sw, 9, 0, 0, Math.PI * 2)
  ctx.fill()

  // teaching：小白板画在身后（身体层之前），像立在她身侧
  if (mode === 'teaching') drawBoard(ctx, t)

  // ── 身体层 ──
  const cut = NECK_Y - OVERLAP
  const bodyTop = topY + cut * sy + bob * 0.55
  ctx.drawImage(img, 0, cut * k, IMG_W * k, (IMG_H - cut) * k, left, bodyTop, w, (IMG_H - cut) * sy)

  // ── 头层：绕脖子转 ──
  const base =
    mode === 'thinking' ? -4.2 : mode === 'listening' ? 5.2 : mode === 'answering' ? -1.4 : 0
  // 思考态保持歪头但不摇摆（用户要求：思考时不要来回动）；空闲缓慢摆动，跳舞跟节拍摇
  const sway =
    mode === 'dancing' ? Math.sin(beat) * 2.6 : mode === 'idle' ? Math.sin(t * 0.9) * 1.7 : 0
  let nod = 0
  if (mode === 'answering') nod = Math.sin(t * 9.7) * 1.9 + Math.sin(t * 3.4) * 1.1
  else if (mode === 'dancing') nod = Math.sin(beat * 0.5) * 1.6
  else if (mode === 'teaching') nod = Math.sin(t * 1.55) * 0.9 + syllable(t * 0.9) * 1.2
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
      left + bx * sx,
      hy + by * sy,
      BLUSH_HALF[0] * sx,
      BLUSH_HALF[1] * sy,
      blush,
    )
  }
  drawEyes(
    ctx,
    img as HTMLImageElement,
    k,
    sx,
    sy,
    left,
    hy,
    EYES,
    EYE_HALF,
    blink,
    smile,
  )
  drawMouth(
    ctx,
    left + MOUTH[0] * sx,
    hy + MOUTH[1] * sy,
    MOUTH_HALF[0] * sx,
    MOUTH_HALF[1] * sy,
    mode,
    t,
  )
  if (mode === 'listening') {
    // 手扶着耳朵在听：画在五官之后，手掌盖在耳侧头发上
    drawHandOnEar(ctx, sx, sy, left, hy, hands ?? null)
  }
  ctx.restore()

  if (mode === 'thinking') drawDots(ctx, t)
  else if (mode === 'listening') drawArcs(ctx, 150, 74, t, '#7FC8FF', 3, 8, 6.4, 72)
  else if (mode === 'answering') drawArcs(ctx, 137, 88, t, '#A6DCFF', 3, 6.4, 5.4, 54)
  if (mode === 'dancing') {
    // 双手举过头顶挥舞 + 音符（画在头后，手在发梢前）
    drawDanceHands(ctx, sx, sy, left, topY + bob * 0.55, t, hands ?? null)
    drawNotes(ctx, t)
  } else if (mode === 'teaching') {
    drawTeachArm(ctx, sx, sy, left, topY + bob * 0.55, t, hands ?? null)
  }
}
