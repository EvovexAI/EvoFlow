/**
 * 助手正文中的 @@路径@@ → 可点击预览。
 * 约定：首尾各一对 @@；优先工作区绝对路径（POSIX `/…` 或 Windows `D:/…`）。
 * （IDE 输入框里的 @文件 是结构化提及；Evopanel 在渲染正文里用闭合 @@…@@ 标定范围。）
 */

import { normalizeWorkspaceRelPath } from './workspace-api-scope.js'
import { isImagePathLike } from './chat-image-src.js'
import { getChatWorkspaceRoot } from './chat-workspace-context.js'
import { healStrippedAbsolutePath, isAbsoluteHostPath } from './workspace-abs-path.js'

export { healStrippedAbsolutePath, isAbsoluteHostPath } from './workspace-abs-path.js'

const FENCE_RE = /```[\w]*\r?\n[\s\S]*?```/g

/**
 * Capture path inside @@…@@.
 * Supports absolute POSIX (`/Users/…`), Windows (`D:/…` / `D:\…`), and legacy relative (`outputs/…`).
 * Do NOT strip a leading `/` — that used to turn `/Users/a/b` into `Users/a/b` and double-join the root.
 */
const AT_PATH_CLOSED_RE = /@@([^@\r\n]+?)@@/gi

function basenameFromPath(p) {
  const s = String(p || '').replace(/\\/g, '/').trim()
  const parts = s.split('/').filter(Boolean)
  return parts[parts.length - 1] || s
}

/**
 * @param {string} path
 */
function normalizeMentionPath(path) {
  const raw = String(path || '').trim()
  if (!raw) return ''
  const healed = healStrippedAbsolutePath(raw)
  if (isAbsoluteHostPath(healed)) {
    return healed.replace(/\\/g, '/')
  }
  return normalizeWorkspaceRelPath(healed)
}

/** Relative outputs/uploads → absolute path when workspace root is bound. */
function mentionPathForMarkdown(relPath) {
  const path = normalizeMentionPath(relPath)
  if (!path) return ''
  if (isAbsoluteHostPath(path)) return path
  const root = getChatWorkspaceRoot()
  if (!root) return path
  const lower = path.toLowerCase()
  if (lower.startsWith('outputs/') || lower.startsWith('uploads/')) {
    const sep = root.includes('\\') ? '\\' : '/'
    const sub = path.replace(/^\/+/, '').replace(/\//g, sep)
    return `${root.replace(/[/\\]+$/, '')}${sep}${sub}`
  }
  return path
}

/**
 * 将正文里的 @@路径@@ 转为 markdown 链接（跳过 fenced code）。
 * @param {string} text
 * @returns {string}
 */
export function linkifyWorkspaceAtMentions(text) {
  const src = String(text || '')
  if (!src) return src
  const out = []
  let last = 0
  FENCE_RE.lastIndex = 0
  let m
  while ((m = FENCE_RE.exec(src)) !== null) {
    if (m.index > last) {
      out.push(linkifyChunk(src.slice(last, m.index)))
    }
    out.push(m[0])
    last = m.index + m[0].length
  }
  if (last < src.length) out.push(linkifyChunk(src.slice(last)))
  return out.join('')
}

/** @param {string} chunk */
function linkifyChunk(chunk) {
  // Models often wrap @@path@@ in backticks; unwrap so we don't emit
  // `` `[📄…](evoflow-file:…)` `` which becomes inert <code> text.
  const unwrapped = String(chunk || '').replace(/`@@([^@\r\n]+?)@@`/g, '@@$1@@')
  return unwrapped.replace(AT_PATH_CLOSED_RE, (_full, rawPath) => {
    const path = normalizeMentionPath(rawPath)
    if (!path) return _full
    const name = basenameFromPath(path)
    if (isImagePathLike(name)) {
      const href = mentionPathForMarkdown(rawPath) || path
      return `![${name}](${href})`
    }
    const href = `evoflow-file:${encodeURIComponent(path)}`
    return `[📄 ${name}](${href})`
  })
}
