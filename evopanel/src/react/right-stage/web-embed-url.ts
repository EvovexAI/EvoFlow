/**
 * URL helpers for the right-stage web-embed panel.
 * Chromium blocks file:// inside http(s)/tauri iframes — resolve locals via Tauri asset protocol.
 */

export type ResolvedWebEmbed = {
  /** iframe src (http/https/asset/blob) — empty when using srcDoc only */
  src: string
  /** Prefer srcDoc for local HTML (avoids Windows iframe+asset quirks) */
  srcDoc?: string
  /** True when this origin cannot embed the local path */
  localBlocked?: boolean
  /** Revoke blob URLs created for this resolve */
  revoke?: () => void
}

let _convertFileSrc: ((path: string, protocol?: string) => string) | null | undefined

async function getConvertFileSrc(): Promise<((path: string, protocol?: string) => string) | null> {
  if (_convertFileSrc !== undefined) return _convertFileSrc
  if (typeof window === 'undefined' || !(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    _convertFileSrc = null
    return null
  }
  try {
    const m = await import('@tauri-apps/api/core')
    _convertFileSrc = typeof m.convertFileSrc === 'function' ? m.convertFileSrc : null
  } catch {
    _convertFileSrc = null
  }
  return _convertFileSrc
}

/** Reset cached convertFileSrc (tests). */
export function resetWebEmbedConvertFileSrcCache(): void {
  _convertFileSrc = undefined
}

export function isLocalFileUrl(raw: string): boolean {
  const value = String(raw || '').trim()
  if (!value) return false
  if (/^file:/i.test(value)) return true
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true
  if (value.startsWith('\\\\')) return true
  // Absolute POSIX path that is not a site-root relative web path we already serve
  if (/^\/[^/]/.test(value) && !value.startsWith('/assets/') && !value.startsWith('/mnt/')) return true
  return false
}

/**
 * Normalize address-bar / paste input. Preserves file:// and local paths;
 * bare hostnames become https://…
 */
export function normalizeWebEmbedUserUrl(raw: string): string {
  const value = String(raw || '').trim()
  if (!value) return ''
  if (/^(https?|file|asset|blob|data):/i.test(value)) return value
  if (/^[a-zA-Z]:[\\/]/.test(value)) {
    return `file:///${value.replace(/\\/g, '/')}`
  }
  if (value.startsWith('\\\\')) {
    return `file://${value.replace(/\\/g, '/')}`
  }
  if (value.startsWith('/') && !value.startsWith('//')) {
    return `file://${value}`
  }
  return `https://${value}`
}

/** file:// or OS path → absolute filesystem path for convertFileSrc / shell open. */
export function localUrlToFsPath(raw: string): string {
  const value = String(raw || '').trim()
  if (!value) return ''
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/')) {
    return value.replace(/\//g, value.includes('\\') ? '\\' : '/')
  }
  if (!/^file:/i.test(value)) return ''
  try {
    const u = new URL(value)
    let path = decodeURIComponent(u.pathname || '')
    // file:///C:/foo → /C:/foo on Chromium; strip leading slash for Windows drive
    if (/^\/[a-zA-Z]:/.test(path)) path = path.slice(1)
    // file://server/share → \\server\share
    if (u.hostname) {
      return `\\\\${u.hostname}${path.replace(/\//g, '\\')}`
    }
    return path
  } catch {
    return value.replace(/^file:\/\//i, '').replace(/^\/([a-zA-Z]:)/, '$1')
  }
}

export function formatWebEmbedDisplayUrl(raw: string): string {
  const url = String(raw || '').trim()
  if (!url) return ''
  if (isLocalFileUrl(url)) {
    const path = localUrlToFsPath(url) || url
    return path.replace(/\\/g, '/')
  }
  try {
    const u = new URL(url, typeof window !== 'undefined' ? window.location.origin : undefined)
    const port = u.port ? `:${u.port}` : ''
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')
    return `${u.hostname}${port}${path}${u.search || ''}`
  } catch {
    return url
  }
}

function parentDirPath(filePath: string): string {
  const norm = String(filePath || '').replace(/\\/g, '/')
  const idx = norm.lastIndexOf('/')
  if (idx <= 0) return norm
  return norm.slice(0, idx + 1)
}

function injectHtmlBaseHref(html: string, baseHref: string): string {
  const raw = String(html || '')
  const href = String(baseHref || '').trim()
  if (!raw || !href || /<base\s/i.test(raw)) return raw
  const tag = `<base href="${href.replace(/"/g, '&quot;')}" />`
  if (/<head[\s>]/i.test(raw)) {
    return raw.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${tag}`)
  }
  if (/<html[\s>]/i.test(raw)) {
    return raw.replace(/<html(\s[^>]*)?>/i, (m) => `${m}<head>${tag}</head>`)
  }
  return `${tag}${raw}`
}

function looksLikeHtmlPath(filePath: string): boolean {
  return /\.html?$/i.test(String(filePath || '').split(/[?#]/)[0] || '')
}

/**
 * Resolve a panel URL into iframe-safe src / srcDoc.
 * Local files require Tauri convertFileSrc (+ assetProtocol).
 */
export async function resolveWebEmbedSrc(
  pageUrl: string,
  opts?: { convertFileSrc?: ((path: string, protocol?: string) => string) | null },
): Promise<ResolvedWebEmbed> {
  const url = String(pageUrl || '').trim()
  if (!url) return { src: '' }
  if (!isLocalFileUrl(url)) return { src: url }

  const filePath = localUrlToFsPath(url)
  if (!filePath) return { src: '', localBlocked: true }

  const convert =
    opts?.convertFileSrc !== undefined ? opts.convertFileSrc : await getConvertFileSrc()
  if (!convert) {
    return { src: '', localBlocked: true }
  }

  let assetUrl = ''
  try {
    assetUrl = convert(filePath)
  } catch {
    return { src: '', localBlocked: true }
  }
  if (!assetUrl) return { src: '', localBlocked: true }

  if (!looksLikeHtmlPath(filePath)) {
    return { src: assetUrl }
  }

  // Prefer srcDoc for HTML: WebView2 often refuses asset:// HTML as iframe src.
  try {
    const res = await fetch(assetUrl)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    let html = await res.text()
    try {
      const baseDir = parentDirPath(filePath)
      const baseAsset = convert(baseDir.replace(/\/$/, '') || baseDir)
      const baseHref = baseAsset.endsWith('/') ? baseAsset : `${baseAsset}/`
      html = injectHtmlBaseHref(html, baseHref)
    } catch {
      /* keep html without base */
    }
    return { src: '', srcDoc: html }
  } catch {
    // Fall back to direct asset URL (works on some platforms)
    return { src: assetUrl }
  }
}

/** Open URL or local path with system handler when possible. */
export async function openWebEmbedExternally(pageUrl: string): Promise<void> {
  const url = String(pageUrl || '').trim()
  if (!url) return
  if (isLocalFileUrl(url)) {
    const path = localUrlToFsPath(url) || url
    const fileUrl = /^file:/i.test(url)
      ? url
      : /^[a-zA-Z]:/.test(path)
        ? `file:///${path.replace(/\\/g, '/')}`
        : `file://${path.startsWith('/') ? '' : '/'}${path.replace(/\\/g, '/')}`
    try {
      const { open } = await import('@tauri-apps/plugin-shell')
      await open(fileUrl)
      return
    } catch {
      /* fall through */
    }
  }
  if (typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}
