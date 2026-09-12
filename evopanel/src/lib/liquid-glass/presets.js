/** @typedef {{ id: string, label: string, hues: number[], saturation: number, lightness: number, wallpaper?: string, wallpaperDark?: string, wallpaperVideo?: string }} LiquidGlassPreset */

/** @type {LiquidGlassPreset[]} */
export const LIQUID_GLASS_PRESETS = [
  {
    id: 'aurora',
    label: '极光',
    hues: [220, 260, 190, 310],
    saturation: 78,
    lightness: 58,
    wallpaper: 'bg-aurora.jpg',
    wallpaperDark: 'bg-tahoe-dark.jpg',
    wallpaperVideo: 'bg-video-scenery.mp4',
  },
  {
    id: 'deep-sea',
    label: '深海',
    hues: [200, 215, 185, 230],
    saturation: 70,
    lightness: 42,
    wallpaper: 'bg-ocean.jpg',
    wallpaperVideo: 'bg-video-fish.mp4',
  },
  {
    id: 'ember',
    label: '暮焰',
    hues: [15, 35, 280, 50],
    saturation: 72,
    lightness: 52,
    wallpaper: 'bg-text.jpg',
    wallpaperVideo: 'bg-video-demo.mp4',
  },
  {
    id: 'minimal',
    label: '极简',
    hues: [230, 240, 220, 250],
    saturation: 42,
    lightness: 72,
    wallpaper: 'bg-ui.svg',
    wallpaperDark: 'bg-pet-butterfly.jpg',
  },
  {
    id: 'aquarium',
    label: '游鱼',
    hues: [195, 210, 175, 230],
    saturation: 68,
    lightness: 48,
    wallpaper: 'bg-aquarium.jpg',
    wallpaperVideo: 'bg-video-fish.mp4',
  },
]

/** @param {string} id */
export function getLiquidGlassPreset(id) {
  const key = String(id || 'aurora').trim()
  return LIQUID_GLASS_PRESETS.find((p) => p.id === key) || LIQUID_GLASS_PRESETS[0]
}
