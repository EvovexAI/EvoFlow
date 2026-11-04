/**
 * 语音舞台中心的小V。
 *
 * 渲染逻辑全在 xiaoxi-pet-render.ts（纯 canvas，可单独跑）；这里只负责：
 * 加载立绘（站姿 + 坐姿两张）、按舞台尺寸算位置（把「脚」落在 72% 高度，避开底部字幕区）、
 * 按帧循环、眨眼计时，以及活动区域内的踱步（思考/空闲时慢慢走两步，其余状态站定）。
 */
import { useEffect, useRef } from 'react'
import {
  drawPetFrame,
  PET_DESIGN_SIZE,
  PET_DESK_IMG_URL,
  PET_FOOT_Y,
  PET_IMG_URL,
  type PetMode,
} from './xiaoxi-pet-render.js'
import './xiaoxi-stage-pet.css'

export type { PetMode }

/** 眨眼：闭合 0.15s，间隔 2.2~6.5s（与桌面宠物一致） */
const BLINK_DUR = 0.15

/** 会踱步的状态：思考时来回走两步、纯空闲时溜达；说话/聆听要稳，坐姿本来就固定 */
const WANDER_MODES: ReadonlySet<PetMode> = new Set<PetMode>(['idle', 'thinking'])
/** 活动区域：以舞台中心为原点，左右各占 canvas 宽度的比例 */
const WANDER_RANGE = 0.42
/** 踱步速度（canvas 像素/秒，按 canvas 实际宽度折算） */
const WANDER_SPEED = 0.055

export function XiaoxiStagePet({ mode }: { mode: PetMode }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const modeRef = useRef<PetMode>(mode)
  modeRef.current = mode

  useEffect(() => {
    const canvas = canvasRef.current
    const box = canvas?.parentElement
    if (!canvas || !box) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let cancelled = false
    let raf = 0
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const W = box.clientWidth
      const H = box.clientHeight
      if (!W || !H) return
      // 舞台高度有限（右侧面板打开时尤其矮），按短边收，别让人物顶到顶栏
      const size = Math.max(150, Math.min(W * 0.62, H * 0.62, 420))
      canvas.width = Math.round(size * dpr)
      canvas.height = Math.round(size * dpr)
      canvas.style.width = `${size}px`
      canvas.style.height = `${size}px`
      canvas.style.left = `${(W - size) / 2}px`
      canvas.style.top = `${H * 0.72 - (size * PET_FOOT_Y) / PET_DESIGN_SIZE}px`
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(box)

    const img = new Image()
    img.decoding = 'async'
    img.src = PET_IMG_URL
    const deskImg = new Image()
    deskImg.decoding = 'async'
    deskImg.src = PET_DESK_IMG_URL

    let t = 0
    let last = 0
    let nextBlink = 2.2
    let blinkAt = -1
    let blink = 0

    // 踱步：位置（相对舞台中心的像素偏移）、朝向、换向计时
    let wx = 0
    let wdir = 1
    let wTimer = 1.6
    let walkPhase = 0

    const loop = (now: number) => {
      if (cancelled) return
      raf = requestAnimationFrame(loop)
      if (document.hidden) return
      if (now - last < 33) return // 30fps：立绘帧率足够，省电
      const dt = Math.min(0.06, (now - last) / 1000)
      last = now
      if (!img.complete || img.naturalWidth === 0) return

      t += dt * (reduceMotion ? 0.3 : 1)

      if (blinkAt < 0 && t >= nextBlink) blinkAt = 0
      if (blinkAt >= 0) {
        blinkAt += dt / BLINK_DUR
        if (blinkAt >= 1) {
          blinkAt = -1
          blink = 0
          nextBlink = t + 2.2 + Math.random() * 4.3
        } else {
          blink = 1 - Math.abs(blinkAt * 2 - 1)
        }
      }

      // ── 活动区域内的踱步 ──
      const mode = modeRef.current
      const maxX = canvas.width * WANDER_RANGE
      let facing = 1
      if (!reduceMotion && WANDER_MODES.has(mode)) {
        wTimer -= dt
        if (wTimer <= 0) {
          // 换个方向溜达，偶尔停一下
          const r = Math.random()
          wdir = r < 0.42 ? -1 : r < 0.84 ? 1 : 0
          wTimer = 2.2 + Math.random() * 3.2
        }
        if (wdir !== 0) {
          wx += wdir * canvas.width * WANDER_SPEED * dt
          if (wx > maxX) {
            wx = maxX
            wdir = -1
          } else if (wx < -maxX) {
            wx = -maxX
            wdir = 1
          }
          walkPhase += dt * 7.2
        }
        facing = wdir === 0 ? 1 : wdir
      } else {
        // 站定：缓步走回中心
        wx += (0 - wx) * Math.min(1, dt * 2.2)
        if (Math.abs(wx) < 0.5) wx = 0
        wTimer = Math.min(wTimer, 1.2)
      }

      const scale = canvas.width / PET_DESIGN_SIZE || 1
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
      drawPetFrame(
        ctx,
        img,
        mode,
        t,
        blink,
        img.naturalWidth / 840,
        deskImg.complete && deskImg.naturalWidth > 0 ? deskImg : null,
      )

      // 位置/朝向：踱步偏移 + 翻面 + 走路时一点点摇摆，都走 transform，不碰布局
      const sway = walkPhase && wdir !== 0 ? Math.sin(walkPhase) * 0.9 : 0
      const bounce =
        walkPhase && wdir !== 0 ? Math.abs(Math.sin(walkPhase)) * canvas.width * 0.004 : 0
      const transform =
        wx === 0 && facing === 1 && !sway && !bounce
          ? ''
          : `translateX(${wx.toFixed(1)}px) translateY(${-bounce.toFixed(1)}px) scaleX(${facing}) rotate(${sway.toFixed(2)}deg)`
      if (canvas.style.transform !== transform) canvas.style.transform = transform
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  return <canvas ref={canvasRef} className="xws-pet" aria-hidden="true" data-tauri-no-drag="" />
}

export default XiaoxiStagePet
