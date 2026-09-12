/**
 * Resolve image URLs for chat markdown / MessageMedia.
 * Prefer workspace absolute paths + Gateway serve-file; fall back to /mnt/user-data when unbound.
 */

import { apiUrl } from './api-client.js'
import { getChatWorkspaceRoot } from './chat-workspace-context.js'

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|heic|svg|bmp)(\?|$)/i
const OUTPUTS_MARKER = 'outputs'

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

/** Infer workspace root from ``D:/project/outputs/file.png``. */
export function inferWorkspaceRootFromFilePath(filePath) {
  const norm = String(filePath || '').trim().replace(/\\/g, '/')
  const m = /^([a-zA-Z]:)\/(.+?)\/(outputs|uploads)\//i.exec(norm)
  if (m) return `${m[1]}/${m[2]}`.replace(/\/+$/, '')
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

  const root = getChatWorkspaceRoot() || inferWorkspaceRootFromFilePath(u)
  const norm = u.replace(/\\/g, '/')

  if (_isWindowsAbs(u) || /^[a-zA-Z]:\//.test(norm) || _isUnixAbs(u)) {
    const effectiveRoot = root || inferWorkspaceRootFromFilePath(u)
    if (effectiveRoot) return _serveFileUrl(effectiveRoot, u)
    return u
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
