/**
 * 语音舞台中心的小V。
 *
 * 渲染逻辑全在 xiaoxi-pet-render.ts（纯 canvas，可单独跑）；这里只负责：
 * 加载立绘（站姿 + 坐姿两张）、按舞台尺寸算位置（把「脚」落在 72% 高度，避开底部字幕区）、
 * 按帧循环、眨眼计时。
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

    const loop = (now: number) => {
      if (cancelled) return
      raf = requestAnimationFrame(loop)
      if (document.hidden) return
      if (now - last < 33) return // 30fps：舞台里还有一个 360 点阵球在跑
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

      const scale = canvas.width / PET_DESIGN_SIZE || 1
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
      drawPetFrame(
        ctx,
        img,
        modeRef.current,
        t,
        blink,
        img.naturalWidth / 840,
        deskImg.complete && deskImg.naturalWidth > 0 ? deskImg : null,
      )
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
