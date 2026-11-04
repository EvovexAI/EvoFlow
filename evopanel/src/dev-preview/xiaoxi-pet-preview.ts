/* 临时验收页：七种状态各一帧，大图 */
import {
  drawPetFrame,
  PET_DESK_IMG_URL,
  PET_HAND_URLS,
  PET_IMG_URL,
  type PetHandImages,
  type PetMode,
} from '../react/components/xiaoxi-pet-render.js'

const SIZE = 620
const img = new Image()
img.src = PET_IMG_URL
const desk = new Image()
desk.src = PET_DESK_IMG_URL
const hands: PetHandImages = {}
const handLoads: Promise<void>[] = []
for (const [name, url] of Object.entries(PET_HAND_URLS)) {
  const h = new Image()
  h.src = url
  handLoads.push(
    new Promise((ok) => {
      h.onload = () => {
        hands[name as keyof typeof PET_HAND_URLS] = h
        ok()
      }
      h.onerror = () => ok()
    }),
  )
}
const params = new URLSearchParams(location.search)
const t0 = Number(params.get('t') || 3.2)

Promise.all([
  new Promise((ok) => (img.onload = ok)),
  new Promise((ok) => (desk.onload = ok)),
  ...handLoads,
]).then(() => {
  const row = document.getElementById('light') as HTMLDivElement
  const k = img.naturalWidth / 840
  const modes: PetMode[] = [
    'idle',
    'listening',
    'thinking',
    'answering',
    'coding',
    'dancing',
    'teaching',
  ]
  for (const m of modes) {
    const cv = document.createElement('canvas')
    cv.width = SIZE
    cv.height = SIZE
    cv.style.width = `${SIZE}px`
    cv.style.height = `${SIZE}px`
    const ctx = cv.getContext('2d')!
    ctx.setTransform(SIZE / 200, 0, 0, SIZE / 200, 0, 0)
    drawPetFrame(ctx, img, m, t0, 0, k, desk, hands)
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
