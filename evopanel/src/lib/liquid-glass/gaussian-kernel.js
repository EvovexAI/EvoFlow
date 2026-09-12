/** Gaussian kernel for separable blur (from liquid-glass-studio, MIT) */
export const MAX_BLUR_RADIUS = 24

export function computeGaussianKernelByRadius(radius) {
  const r = Math.max(1, Math.min(MAX_BLUR_RADIUS, Math.round(radius)))
  const sigma = r / 3
  const kernel = new Float32Array(MAX_BLUR_RADIUS + 1)
  let sum = 0
  for (let i = 0; i <= r; i++) {
    const weight = Math.exp(-0.5 * (i * i) / (sigma * sigma))
    kernel[i] = weight
    sum += i === 0 ? weight : weight * 2
  }
  for (let i = 0; i <= r; i++) kernel[i] /= sum
  return { radius: r, kernel }
}
