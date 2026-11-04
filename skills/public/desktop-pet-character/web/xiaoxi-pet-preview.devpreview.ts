/* 临时验收页：五种状态各一帧，大图 */
import {
  drawPetFrame,
  PET_DESK_IMG_URL,
  PET_IMG_URL,
  type PetMode,
} from '../react/components/xiaoxi-pet-render.js'

const SIZE = 620
const img = new Image()
img.src = PET_IMG_URL
const desk = new Image()
desk.src = PET_DESK_IMG_URL
const params = new URLSearchParams(location.search)
const t0 = Number(params.get('t') || 3.2)

Promise.all([
  new Promise((ok) => (img.onload = ok)),
  new Promise((ok) => (desk.onload = ok)),
]).then(() => {
  const row = document.getElementById('light') as HTMLDivElement
  const k = img.naturalWidth / 840
  const modes: PetMode[] = [
    'idle',
    'listening',
    'thinking',
    'answering',
    'coding',

  ]
  for (const m of modes) {
    const cv = document.createElement('canvas')
    cv.width = SIZE
    cv.height = SIZE
    cv.style.width = `${SIZE}px`
    cv.style.height = `${SIZE}px`
    const ctx = cv.getContext('2d')!
    ctx.setTransform(SIZE / 200, 0, 0, SIZE / 200, 0, 0)
    drawPetFrame(ctx, img, m, t0, 0, k, desk)
    const label = document.createElement('span')
    label.textContent = m
    const cell = document.createElement('div')
    cell.className = 'cell'
    cell.append(cv, label)
    row.append(cell)
  }
  document.title = 'ready'
})
export {}
