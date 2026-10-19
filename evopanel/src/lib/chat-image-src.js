/**
 * Resolve image URLs for chat markdown / MessageMedia.
 * Prefer workspace absolute paths + Gateway serve-file; fall back to /mnt/user-data when unbound.
 * Bare host paths are never returned as <img> src (browsers cannot load them).
 */

import { apiUrl } from './api-client.js'
import { getChatWorkspaceRoot } from './chat-workspace-context.js'

/**
 * 截图已在工具卡上。模型若把 browser_snapshots 落盘路径 / 文件名写进正文，
 * Streamdown 会变成 [Image blocked]。渲染前剥掉这类引用。
 */
export function stripBrowserSnapshotFileMentions(text) {
  return String(text || '')
    .replace(/@@[^@\r\n]*browser_snapshots[^@\r\n]*@@/gi, '')
    .replace(/!\[[^\]]*\]\([^)]*browser_snapshots[^)]*\)/gi, '')
    // 模型偶发把 API 地址也 @@ 进正文
    .replace(/@@[^@\r\n]*\/browser-snapshots\/[^@\r\n]*@@/gi, '')
    .replace(/!\[[^\]]*\]\([^)]*\/browser-snapshots\/[^)]*\)/gi, '')
    // 仅文件名：@@aaa35130e2da4b3f.png@@ / [Image blocked: aaa….png]
    .replace(/@@\s*[0-9a-f]{12,32}\.png\s*@@/gi, '')
    .replace(/截图文件：\s*(?:\[Image blocked:[^\]]*\]\s*)?/gi, '')
    .replace(/\[Image blocked:\s*[0-9a-f]{12,32}\.png\s*\]/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
}

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|heic|svg|bmp)(\?|$)/i
const OUTPUTS_MARKER = 'outputs'

/** @type {((path: string) => string) | null} */
let _convertFileSrc = null
if (typeof window !== 'undefined') {
  import('@tauri-apps/api/core')
    .then((m) => {
      _convertFileSrc = typeof m.convertFileSrc === 'function' ? m.convertFileSrc : null
    })
    .catch(() => {})
}

export function isImagePathLike(pathOrUrl) {
  return IMAGE_EXT_RE.test(String(pathOrUrl || '').trim())
}

function _serveFileUrl(root, filePath) {
  const r = String(root || '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
  const p = String(filePath || '').trim()
  if (!r || !p) return ''
  return apiUrl(
    `/workspaces/serve-file?root=${encodeURIComponent(r)}&path=${encodeURIComponent(p)}`,
  )
}

function _isWindowsAbs(u) {
  return /^[a-zA-Z]:[\\/]/.test(String(u || '').trim())
}

function _isUnixAbs(u) {
  const s = String(u || '').trim()
  return s.startsWith('/') && !s.startsWith('/mnt/user-data')
}

/** Parent directory of an absolute path (POSIX-normalized). */
function _parentDir(absPath) {
  const n = String(absPath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
  const i = n.lastIndexOf('/')
  if (i <= 0) return ''
  // ``D:/file.png`` → ``D:/``
  if (/^[a-zA-Z]:$/.test(n.slice(0, i))) return `${n.slice(0, i)}/`
  return n.slice(0, i)
}

function _pathUnderRoot(root, filePath) {
  const r = String(root || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
  const f = String(filePath || '')
    .trim()
    .replace(/\\/g, '/')
    .toLowerCase()
  if (!r || !f) return false
  return f === r || f.startsWith(`${r}/`)
}

function _tryConvertFileSrc(absPath) {
  if (!_convertFileSrc) return ''
  const p = String(absPath || '').trim()
  if (!p) return ''
  try {
    const out = _convertFileSrc(p)
    return typeof out === 'string' && out ? out : ''
  } catch {
    return ''
  }
}

/**
 * Infer a usable serve-file root from an absolute file path.
 * - ``…/outputs|uploads/…`` → project root above that marker
 * - otherwise → parent directory of the file (Gateway allows abs path outside root)
 */
export function inferWorkspaceRootFromFilePath(filePath) {
  const norm = String(filePath || '').trim().replace(/\\/g, '/')
  const win = /^([a-zA-Z]:)\/(.+?)\/(outputs|uploads)\//i.exec(norm)
  if (win) return `${win[1]}/${win[2]}`.replace(/\/+$/, '')
  const posix = /^(\/.+?)\/(outputs|uploads)\//i.exec(norm)
  if (posix) return posix[1].replace(/\/+$/, '')
  return _parentDir(norm)
}

/** Pick serve-file root + optional Tauri asset URL for a host absolute path. */
function _resolveAbsoluteLocalSrc(absPath) {
  const u = String(absPath || '').trim()
  if (!u) return ''
  const chatRoot = String(getChatWorkspaceRoot() || '').trim()
  const inferred = inferWorkspaceRootFromFilePath(u)

  let serveRoot = ''
  if (chatRoot && _pathUnderRoot(chatRoot, u)) serveRoot = chatRoot
  else if (inferred) serveRoot = inferred
  else if (chatRoot) serveRoot = chatRoot

  // Outside bound workspace: prefer Tauri asset protocol when available.
  if (chatRoot && !_pathUnderRoot(chatRoot, u)) {
    const tauri = _tryConvertFileSrc(u)
    if (tauri) return tauri
  }

  if (serveRoot) {
    const url = _serveFileUrl(serveRoot, u)
    if (url) return url
  }

  const tauri = _tryConvertFileSrc(u)
  if (tauri) return tauri

  // Last resort: parent dir as root (never return bare host path as img src).
  const parent = _parentDir(u)
  if (parent) return _serveFileUrl(parent, u) || ''
  return ''
}

/**
 * Normalize local paths for markdown / img src.
 * - ``D:\foo\bar.png`` → ``D:/foo/bar.png`` (markdown eats ``\``)
 * - ``D:githubEvoFlowoutputsfile.png`` → recover slashes before ``outputs/``
 */
export function normalizeLocalImagePath(raw) {
  const s = String(raw || '').trim()
  if (!s || /^https?:\/\//i.test(s) || s.startsWith('data:')) return s

  if (_isWindowsAbs(s)) {
    return s.replace(/\\/g, '/')
  }
  if (_isUnixAbs(s)) {
    return s
  }

  // Markdown-corrupted Windows path: drive letter then no slash until end
  const driveMatch = /^([a-zA-Z]):([^/\\]+)$/i.exec(s)
  if (driveMatch && isImagePathLike(s)) {
    const drive = driveMatch[1]
    const rest = driveMatch[2]
    const outIdx = rest.toLowerCase().indexOf(OUTPUTS_MARKER)
    if (outIdx > 0) {
      const before = rest.slice(0, outIdx)
      let after = rest.slice(outIdx + OUTPUTS_MARKER.length)
      if (after.startsWith('/') || after.startsWith('\\')) after = after.slice(1)
      return `${drive}:/${before}/${OUTPUTS_MARKER}/${after}`
    }
    const upIdx = rest.toLowerCase().indexOf('uploads')
    if (upIdx > 0) {
      const before = rest.slice(0, upIdx)
      let after = rest.slice(upIdx + 'uploads'.length)
      if (after.startsWith('/') || after.startsWith('\\')) after = after.slice(1)
      return `${drive}:/${before}/uploads/${after}`
    }
  }

  return s.replace(/\\/g, '/')
}

/** @param {string} rawPathOrUrl */
export function resolveChatImageSrc(rawPathOrUrl) {
  const u = normalizeLocalImagePath(rawPathOrUrl)
  if (!u) return ''
  if (u.startsWith('data:image/') || /^https?:\/\//i.test(u)) return u

  // Screenshot tool results use Gateway paths, not workspace files.
  const snapshot = u.match(/(\/api\/threads\/[^/?#]+\/browser-snapshots\/[0-9a-f]{12,32})/i)
  if (snapshot) return apiUrl(snapshot[1].slice(4))

  const root = String(getChatWorkspaceRoot() || '').trim()
  const norm = u.replace(/\\/g, '/')

  // 模型正文常引用落盘绝对路径（~/.evoflow(-dev)/browser_snapshots/...）；
  // 转成 Gateway 截图 URL，否则 markdown 安全层会变成 [Image blocked]。
  const localSnap = norm.match(
    /(?:^|\/)(?:\.?evoflow(?:-dev)?\/)?(?:profiles\/[^/]+\/)?browser_snapshots\/([^/]+)\/([0-9a-f]{12,32})(?:\.png)?$/i,
  )
  if (localSnap) {
    return apiUrl(`/threads/${localSnap[1]}/browser-snapshots/${localSnap[2]}`)
  }

  if (_isWindowsAbs(u) || /^[a-zA-Z]:\//.test(norm) || _isUnixAbs(u)) {
    return _resolveAbsoluteLocalSrc(u)
  }

  if (u.startsWith('/mnt/user-data/')) return u

  const lower = norm.toLowerCase()
  if (lower.startsWith('outputs/') || lower.startsWith('/outputs/')) {
    const rel = norm.replace(/^\/+/, '').replace(/^outputs\//i, '')
    if (root) {
      const abs = `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/outputs/${rel}`
      return _serveFileUrl(root, abs)
    }
    const encoded = rel
      .split('/')
      .filter(Boolean)
      .map((seg) => encodeURIComponent(seg))
      .join('/')
    return `/mnt/user-data/outputs/${encoded}`
  }

  return u.startsWith('/') ? u : `/${u.replace(/^\/+/, '')}`
}

const _WORKSPACE_IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|svg|heic)(\?|$)/i
const _WORKSPACE_VIDEO_EXT = /\.(mp4|webm|mov|mkv|m4v)(\?|$)/i
const _WORKSPACE_AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac|flac)(\?|$)/i

export function isWorkspaceImagePath(path) {
  return _WORKSPACE_IMAGE_EXT.test(String(path || '').trim())
}

export function isWorkspaceVideoPath(path) {
  return _WORKSPACE_VIDEO_EXT.test(String(path || '').trim())
}

export function isWorkspaceAudioPath(path) {
  return _WORKSPACE_AUDIO_EXT.test(String(path || '').trim())
}

export function isWorkspaceMediaBinaryPath(path) {
  const p = String(path || '').trim()
  return isWorkspaceImagePath(p) || isWorkspaceVideoPath(p) || isWorkspaceAudioPath(p)
}

export function resolveWorkspaceMediaKind(path) {
  const p = String(path || '').trim()
  if (isWorkspaceImagePath(p)) return 'image'
  if (isWorkspaceVideoPath(p)) return 'video'
  if (isWorkspaceAudioPath(p)) return 'audio'
  return null
}

/** Workspace-relative media file → inline preview fields (skip text read API). */
export function buildWorkspaceMediaPreviewFields(workspaceRoot, relPath) {
  const path = String(relPath || '').trim()
  if (!isWorkspaceMediaBinaryPath(path)) return null
  const mediaKind = resolveWorkspaceMediaKind(path)
  const mediaSrc = resolveWorkspaceRelMediaSrc(workspaceRoot, path)
  if (!mediaKind || !mediaSrc) return null
  return { mediaSrc, mediaKind }
}

/** Workspace-relative or absolute path → serve-file / mnt URL for inline media preview. */
export function resolveWorkspaceRelMediaSrc(workspaceRoot, relPath) {
  const rel = String(relPath || '').trim().replace(/\\/g, '/')
  if (!rel) return ''
  if (rel.startsWith('data:') || /^https?:\/\//i.test(rel)) return rel
  const root = String(workspaceRoot || getChatWorkspaceRoot() || '').trim()
  if (/^[a-zA-Z]:/.test(rel) || (rel.startsWith('/') && !rel.startsWith('/mnt/'))) {
    return resolveChatImageSrc(rel)
  }
  if (root) {
    const abs = `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/${rel.replace(/^\/+/, '')}`
    return resolveChatImageSrc(abs)
  }
  return resolveChatImageSrc(rel)
}
