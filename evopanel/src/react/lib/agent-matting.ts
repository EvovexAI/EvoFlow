/**
 * Lightweight image matting for agent custom avatars (corner flood-fill heuristic).
 * For photos without alpha, removes near-uniform background. Transparent PNG/WebP pass through.
 */

export type MatteResult = {
  blob: Blob
  aspect: number
  width: number
  height: number
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to load image'))
    }
    img.src = url
  })
}

function hasAlpha(data: ImageData): boolean {
  const a = data.data
  for (let i = 3; i < a.length; i += 4) {
    if (a[i] < 250) return true
  }
  return false
}

function floodAlpha(data: ImageData, tolerance = 28): void {
  const { width, height, data: px } = data
  const visited = new Uint8Array(width * height)
  const queue: number[] = []
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const i = y * width + x
    if (visited[i]) return
    visited[i] = 1
    queue.push(i)
  }
  for (let x = 0; x < width; x++) {
    push(x, 0)
    push(x, height - 1)
  }
  for (let y = 0; y < height; y++) {
    push(0, y)
    push(width - 1, y)
  }
  const sample = (i: number) => [px[i * 4], px[i * 4 + 1], px[i * 4 + 2]] as const
  const bg = sample(queue[0] ?? 0)
  const dist = (i: number) => {
    const r = px[i * 4]
    const g = px[i * 4 + 1]
    const b = px[i * 4 + 2]
    return Math.max(Math.abs(r - bg[0]), Math.abs(g - bg[1]), Math.abs(b - bg[2]))
  }
  while (queue.length) {
    const i = queue.pop()!
    if (dist(i) > tolerance) continue
    px[i * 4 + 3] = 0
    const x = i % width
    const y = (i / width) | 0
    push(x - 1, y)
    push(x + 1, y)
    push(x, y - 1)
    push(x, y + 1)
  }
}

export async function matteImageFile(file: File, maxDim = 1024): Promise<MatteResult> {
  const img = await loadImage(file)
  let { width, height } = img
  const scale = Math.min(1, maxDim / Math.max(width, height))
  width = Math.max(1, Math.round(width * scale))
  height = Math.max(1, Math.round(height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')
  ctx.drawImage(img, 0, 0, width, height)
  const imageData = ctx.getImageData(0, 0, width, height)
  if (!hasAlpha(imageData)) {
    floodAlpha(imageData)
    ctx.putImageData(imageData, 0, 0)
  }
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/webp', 0.92)
  })
  return { blob, aspect: width / height, width, height }
}

export const DEFAULT_HEAD_BOX = { x: 0.2, y: 0.02, w: 0.6, h: 0.38 }
