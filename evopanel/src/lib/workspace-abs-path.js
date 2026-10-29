/**
 * Host absolute-path detection + healing (no imports from workspace-api-scope /
 * mention-display — keeps the dependency graph acyclic).
 */

import { getChatWorkspaceRoot } from './chat-workspace-context.js'

/** Strip quotes / backticks / zero-width junk that break absolute-path detection. */
export function cleanHostPath(path) {
  let s = String(path || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
  // Repeated wraps: `path`, "path", 'path'
  for (let i = 0; i < 3; i++) {
    const next = s.replace(/^[`'"“”‘’]+|[`'"“”‘’]+$/g, '').trim()
    if (next === s) break
    s = next
  }
  // Trailing punctuation from copy/paste
  s = s.replace(/[，,;；]+$/g, '').trim()
  return s
}

/** @param {string} path */
export function isAbsoluteHostPath(path) {
  const s = cleanHostPath(path).replace(/\\/g, '/')
  if (!s) return false
  if (/^[a-zA-Z]:[\\/]/.test(s)) return true
  if (s.startsWith('/') && !s.startsWith('//')) return true
  return false
}

/**
 * Heal citations that lost absolute-path markers:
 * - POSIX: ``Users/a/.evoflow/x`` → ``/Users/a/.evoflow/x`` when root is ``/Users/a/.evoflow``
 * - Windows: ``:/dev/proj/x`` or ``/dev/proj/x`` → ``D:/dev/proj/x`` when root is ``D:/dev/proj``
 *   (drive letter dropped by URL/scheme parsing of ``D:/…``).
 * @param {string} path
 * @param {string} [workspaceRoot]
 */
export function healStrippedAbsolutePath(path, workspaceRoot) {
  const raw = cleanHostPath(path).replace(/\\/g, '/')
  if (!raw) return raw
  // Already a Windows abs path — nothing to heal.
  if (/^[a-zA-Z]:\//.test(raw)) return raw

  const root = cleanHostPath(workspaceRoot || getChatWorkspaceRoot() || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
  if (!root) return raw

  const drive = root.match(/^([a-zA-Z]):\//)?.[1]
  if (drive) {
    // ``:/dev/proj/out`` (letter stripped, colon kept)
    if (raw.startsWith(':/')) {
      const restored = `${drive}${raw}`
      if (restored === root || restored.startsWith(`${root}/`)) return restored
    }
    // ``/dev/proj/out`` (drive+colon stripped; looks like POSIX abs — still heal against Windows root)
    if (raw.startsWith('/') && !raw.startsWith('//')) {
      const restored = `${drive}:${raw}`
      if (restored === root || restored.startsWith(`${root}/`)) return restored
    }
    // ``dev/proj/out`` (fully stripped prefix of Windows root)
    const rootNoDrive = root.replace(/^[a-zA-Z]:\//, '')
    if (raw === rootNoDrive || raw.startsWith(`${rootNoDrive}/`)) {
      return `${drive}:/${raw}`
    }
    return raw
  }

  // POSIX root: restore leading slash when model omitted it.
  if (!root.startsWith('/')) return raw
  if (raw.startsWith('/')) return raw
  const rootNoSlash = root.replace(/^\/+/, '')
  if (raw === rootNoSlash || raw.startsWith(`${rootNoSlash}/`)) {
    return `/${raw}`
  }
  return raw
}

/**
 * 对话 / 产出里常出现半路径（``projects\\out\\a.mp4``）。先 heal 盘符剥落，
 * 仍非绝对路径时拼到会话或员工绑定的 workspace 根上。
 * @param {string} path
 * @param {string} [workspaceRoot]
 * @returns {string}
 */
export function resolveWorkspaceRelativeHostPath(path, workspaceRoot) {
  const raw = cleanHostPath(path)
  if (!raw) return ''
  const rootHint = cleanHostPath(workspaceRoot || getChatWorkspaceRoot() || '')
  const healed = healStrippedAbsolutePath(raw, rootHint)
  if (isAbsoluteHostPath(healed)) return healed
  if (!rootHint) return healed || raw

  // ``../`` 会逃逸 workspace，保持原样交给下游报错，不擅自拼接。
  const posixRel = raw.replace(/\\/g, '/')
  if (posixRel === '..' || posixRel.startsWith('../')) return healed || raw

  const rel = posixRel.replace(/^\.\/+/, '').replace(/^\/+/, '')
  if (!rel) return rootHint

  const useBackslash = rootHint.includes('\\') && !rootHint.includes('/')
  const sep = useBackslash ? '\\' : '/'
  const normalizedRoot = rootHint.replace(/[/\\]+$/, '')
  const normalizedRel = rel.replace(/[/\\]+/g, sep)
  return `${normalizedRoot}${sep}${normalizedRel}`
}

/** Native OS separators for shell / explorer (Windows needs backslashes). */
export function toNativeHostPath(path) {
  const s = cleanHostPath(path)
  if (!s) return s
  if (/^[a-zA-Z]:[\\/]/.test(s) || /^\\\\/.test(s)) {
    return s.replace(/\//g, '\\')
  }
  return s
}
