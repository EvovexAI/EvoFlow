/** Local workspace root takes precedence over LangGraph thread sandbox. */

import { healStrippedAbsolutePath } from './workspace-abs-path.js'
import { getChatWorkspaceRoot } from './chat-workspace-context.js'

/**
 * 本机模式下的有效工作空间根：会话绑定目录 → 面板 ``defaultProjectWorkspaceRoot`` → 仍无则交给后端 ``EVOFLOW_HOME``。
 * 注意：不要把 ``userWorkspaceRoot``（应用数据根）当作项目目录回退。
 * @param {string} localRoot - 当前会话 ``local_workspace_root``
 * @param {string} configuredRoot - 默认项目目录（panel ``defaultProjectWorkspaceRoot``）
 * @param {boolean} useVirtualPaths
 */
export function effectiveLocalWorkspaceRoot(localRoot, configuredRoot, useVirtualPaths = false) {
  if (useVirtualPaths) return ''
  const local = String(localRoot || '').trim()
  if (local) return local
  return String(configuredRoot || '').trim()
}

export function workspaceApiArgs(root, threadId, options = {}) {
  const useVirtual = !!options.useVirtualPaths
  const configured = String(options.configuredRoot || '').trim()
  const r = effectiveLocalWorkspaceRoot(root, configured, useVirtual)
  const t = String(threadId || '').trim()
  /** 已绑定/默认本机工作空间：相对 root 解析；不用 ``threads/{thread_id}/…`` */
  if (r) return { root: r, threadId: undefined }
  if (t) return { root: '', threadId: t }
  return { root: '', threadId: undefined }
}

/** 去掉 Markdown/HTML 污染（如 inline *斜体* 生成的 <em> 标签） */
export function stripPathMarkup(path) {
  return String(path || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .trim()
}

function boundRootHint(explicitRoot) {
  const r = String(explicitRoot || '').trim()
  if (r) return r
  return getChatWorkspaceRoot() || ''
}

/**
 * 去掉冗余 ``workspace/`` 前缀。绑定本机 root 时文件在选中目录下，不套 root/workspace/。
 * ``outputs/``、``uploads/`` 保留为默认子目录。
 * 本机绝对路径（``D:/…`` / ``/Users/…``）原样返回，禁止剥前导 ``/`` 再拼 root。
 */
export function stripBoundWorkspacePrefix(path) {
  let v = stripPathMarkup(path).replace(/\\/g, '/').replace(/^\.\//, '')
  if (!v) return ''
  // 绝对本机路径：绝不能 lstrip('/')，否则 /Users/a/b → Users/a/b 再拼 root
  if (/^[a-zA-Z]:\//.test(v)) return v
  if (v.startsWith(':/')) return v
  if (v.startsWith('/') && !v.startsWith('//')) {
    if (v === '/workspace' || v.startsWith('/workspace/')) {
      v = v.replace(/^\/+/, '')
    } else if (v.startsWith('/mnt/user-data/')) {
      v = v.slice('/mnt/user-data/'.length)
    } else {
      return v
    }
  } else {
    v = v.replace(/^\/+/, '')
  }
  if (v === 'workspace') return ''
  if (v.startsWith('workspace/')) return v.slice('workspace/'.length)
  return v
}

/**
 * @param {string} path
 * @param {string} [workspaceRoot] - 用于修复被剥盘符的 Windows 绝对路径
 */
export function normalizeWorkspaceRelPath(path, workspaceRoot) {
  const raw = stripPathMarkup(path)
  if (!raw) return ''
  const healed = healStrippedAbsolutePath(raw, boundRootHint(workspaceRoot)).replace(/\\/g, '/')
  if (/^[a-zA-Z]:\//.test(healed)) return healed
  if (
    healed.startsWith('/') &&
    !healed.startsWith('//') &&
    !healed.startsWith('/workspace') &&
    !healed.startsWith('/mnt/')
  ) {
    return healed
  }
  return stripBoundWorkspacePrefix(healed)
}

/**
 * 本机绝对路径 → 相对 bound root。
 * 有 ``workspaceRoot`` 时只剥 root 前缀（及 root 下遗留的 ``workspace/``），
 * **禁止**用全局 ``/outputs/`` 启发式——员工根若在 ``…/outputs/…/workspace/role`` 下会裁错再双拼。
 * @param {string} v
 * @param {string} [workspaceRoot]
 * @returns {string | null}
 */
export function absoluteHostPathToWorkspaceRel(v, workspaceRoot) {
  const s = String(v || '').trim()
  if (!/^[a-zA-Z]:[\\/]/.test(s) && !(s.startsWith('/') && !s.startsWith('//'))) return null
  const norm = s.replace(/\\/g, '/')
  const root = String(workspaceRoot || boundRootHint('') || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')

  if (root) {
    const rootL = root.toLowerCase()
    const pathL = norm.toLowerCase()
    if (pathL === rootL) return ''
    if (pathL.startsWith(`${rootL}/`)) {
      let rel = norm.slice(root.length + 1)
      if (rel === 'workspace') return ''
      if (rel.startsWith('workspace/')) rel = rel.slice('workspace/'.length)
      return rel || null
    }
    // Outside this root — keep absolute (caller should not join)
    return null
  }

  // No bound root: legacy marker heuristics (chat sandbox / old projects only)
  const lower = norm.toLowerCase()
  const markers = [
    ['/workspace/outputs/', 'outputs'],
    ['/outputs/', 'outputs'],
    ['/uploads/', 'uploads'],
    ['/workspace/', ''],
  ]
  for (const [marker, head] of markers) {
    const idx = lower.lastIndexOf(marker)
    if (idx < 0) continue
    const rel = norm.slice(idx + marker.length).replace(/^\/+/, '')
    if (!head) return rel || null
    return rel ? `${head}/${rel}` : head
  }
  return null
}

/** UI 展示用路径（不显示 workspace/ 前缀） */
export function formatWorkspacePathForDisplay(path) {
  const s = normalizeWorkspaceRelPath(path)
  return s || stripPathMarkup(path)
}

/**
 * 读取/预览 API 用路径：本机绝对路径原样保留（先修复剥盘符）；outputs/ 保留；workspace/ 剥掉后相对 root。
 * @param {string} path
 * @param {string} [workspaceRoot]
 */
export function normalizeWorkspaceReadPath(path, workspaceRoot) {
  const raw = stripPathMarkup(path)
  if (!raw) return ''
  const rootHint = boundRootHint(workspaceRoot)
  const healed = healStrippedAbsolutePath(raw, rootHint).replace(/\\/g, '/')

  // 本机绝对路径：原样交给后端（禁止 /outputs/ 裁成相对后再拼员工 root）
  if (/^[a-zA-Z]:\//.test(healed)) return healed
  if (
    healed.startsWith('/') &&
    !healed.startsWith('//') &&
    !healed.startsWith('/workspace') &&
    !healed.startsWith('/mnt/')
  ) {
    return healed
  }

  // 仅相对/虚拟路径走 marker；若误传了「嵌了整段 root」的相对串，先剥掉
  const deduped = stripEmbeddedWorkspaceRootPrefix(healed, rootHint)
  const fromWin = absoluteHostPathToWorkspaceRel(deduped, rootHint)
  if (fromWin != null && fromWin !== '') return stripBoundWorkspacePrefix(fromWin)

  // 虚拟路径
  if (deduped.startsWith('/mnt/user-data/')) {
    const v = deduped.slice('/mnt/user-data/'.length)
    const head = v.split('/').filter(Boolean)[0]
    if (head === 'outputs' || head === 'uploads') {
      return v.replace(/\/+/g, '/').replace(/^\//, '')
    }
    if (head === 'workspace') return stripBoundWorkspacePrefix(v)
    return stripBoundWorkspacePrefix(v)
  }
  if (deduped === '/workspace' || deduped.startsWith('/workspace/')) {
    return stripBoundWorkspacePrefix(deduped)
  }

  const head = deduped.replace(/^\/+/, '').split('/').filter(Boolean)[0]
  if (head === 'outputs' || head === 'uploads') {
    // 员工 root 已在 …/outputs/… 下时，勿把「含上级 outputs/…」的假相对路径原样留下
    const stripped = stripEmbeddedWorkspaceRootPrefix(deduped, rootHint)
    if (stripped !== deduped) return stripBoundWorkspacePrefix(stripped)
    return deduped.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/')
  }
  return stripBoundWorkspacePrefix(deduped)
}

/**
 * 相对路径若重复包含 bound root 的尾段（前端误裁绝对路径所致），剥成真正相对路径。
 * 例：root=``…/outputs/x/workspace/role``，key=``outputs/x/workspace/role/docs/a.md`` → ``docs/a.md``
 * @param {string} path
 * @param {string} [workspaceRoot]
 */
export function stripEmbeddedWorkspaceRootPrefix(path, workspaceRoot) {
  let key = String(path || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
  if (!key || /^[a-zA-Z]:\//.test(key) || (key.startsWith('/') && !key.startsWith('//'))) {
    return key
  }
  key = key.replace(/^\/+/, '')
  const root = String(workspaceRoot || boundRootHint('') || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
  if (!root) return key

  const parts = root.split('/').filter(Boolean)
  // Skip drive letter segment on Windows roots (``D:``)
  const start = /^[a-zA-Z]:$/.test(parts[0] || '') ? 1 : 0
  for (let i = start; i < parts.length; i++) {
    const suffix = parts.slice(i).join('/')
    if (!suffix) continue
    if (key === suffix) return ''
    if (key.startsWith(`${suffix}/`)) return key.slice(suffix.length + 1)
  }
  return key
}
