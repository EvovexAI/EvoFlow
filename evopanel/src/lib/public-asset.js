/**
 * Resolve a path under Vite ``public/`` (e.g. ``icons/openai.svg``).
 * Honours ``import.meta.env.BASE_URL`` so Tauri / nested deploys don't 404.
 */
export function publicAssetUrl(relPath) {
  const clean = String(relPath || '').replace(/^\/+/, '')
  let base = '/'
  try {
    base = String(import.meta.env?.BASE_URL || '/')
  } catch {
    /* non-vite */
  }
  if (!base.endsWith('/')) base += '/'
  return `${base}${clean}`
}

/** Vendor / channel icons under ``public/icons/*.svg``. */
export function publicIconUrl(name) {
  const n = String(name || '').trim().replace(/\.svg$/i, '')
  if (!n) return publicAssetUrl('icons/assistant.svg')
  return publicAssetUrl(`icons/${n}.svg`)
}
