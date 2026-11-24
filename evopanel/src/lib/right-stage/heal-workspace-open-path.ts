/**
 * 对话里常只给文件名或漏掉 projects/<ep>/outputs/。
 * 打开前用 resolve-target + find-files 把路径纠到磁盘真实位置。
 *
 * 额外：会话根绑在 showcase 某一叶子（如 aigc/infinite-canvas）时，相对
 * ``projects/<slug>/…`` 会拼到错误根下；此时沿祖先目录搜同名 leaf / 同
 * ``projects/`` 后缀，命中 sibling 树（如 ai-creative-ad-video）。
 */
import { getChatWorkspaceRoot } from '../chat-workspace-context.js'
import {
  isAbsoluteHostPath,
  resolveWorkspaceRelativeHostPath,
} from '../workspace-abs-path.js'

function basename(path: string): string {
  const parts = String(path || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
  return parts[parts.length - 1] || path || ''
}

function normalizePathId(path: string): string {
  return String(path || '').replace(/\\/g, '/')
}

function parentDir(path: string): string {
  const n = normalizePathId(path).replace(/\/+$/, '')
  const i = n.lastIndexOf('/')
  if (i <= 0) return ''
  // Keep Windows drive root like ``D:``
  if (/^[a-zA-Z]:$/i.test(n.slice(0, i))) return n.slice(0, i + 1).replace(/\/$/, '') + '/'
  return n.slice(0, i)
}

/** ``…/projects/<slug>/rest`` 或相对 ``projects/<slug>/rest`` → 后缀（含 projects/）。 */
export function extractProjectsRelativeSuffix(path: string): string {
  const n = normalizePathId(path).replace(/^\.\/+/, '')
  if (!n) return ''
  const lower = n.toLowerCase()
  const idx = lower.lastIndexOf('/projects/')
  if (idx >= 0) return n.slice(idx + 1)
  if (lower.startsWith('projects/')) return n
  return ''
}

/**
 * 命中 ``…/<skill>/projects/…`` 时，把预览工作区根抬到 ``<skill>``，
 * 避免面包屑仍显示错误的会话叶子根（infinite-canvas）。
 */
export function inferWorkspaceRootFromHealedPath(
  healedPath: string,
  fallbackRoot?: string | null,
): string {
  const n = normalizePathId(healedPath)
  const suffix = extractProjectsRelativeSuffix(n)
  if (suffix && n.toLowerCase().endsWith(suffix.toLowerCase())) {
    const root = n.slice(0, n.length - suffix.length).replace(/\/+$/, '')
    if (root && isAbsoluteHostPath(root)) return root
  }
  const fb = String(fallbackRoot || '').trim()
  return fb ? normalizePathId(fb) : ''
}

function ancestorRoots(workspaceRoot: string, maxHops = 3): string[] {
  const out: string[] = []
  let cur = normalizePathId(workspaceRoot).replace(/\/+$/, '')
  for (let i = 0; i < maxHops; i += 1) {
    const parent = parentDir(cur).replace(/\/+$/, '')
    if (!parent || parent === cur) break
    // Drive-only ``D:`` / ``D:/`` — stop
    if (/^[a-zA-Z]:$/i.test(parent.replace(/\/+$/, ''))) break
    out.push(parent)
    cur = parent
  }
  return out
}

type SearchHit = { path?: string; name?: string }

function pickProjectsAwareHit(
  files: SearchHit[],
  leaf: string,
  projectsSuffix: string,
): SearchHit | null {
  const leafLc = leaf.toLowerCase()
  const suffixLc = projectsSuffix.toLowerCase()
  const exact = files.filter(
    (f) =>
      String(f?.name || '').toLowerCase() === leafLc ||
      normalizePathId(String(f?.path || ''))
        .toLowerCase()
        .endsWith(`/${leafLc}`),
  )
  if (suffixLc) {
    const bySuffix = exact.find((f) =>
      normalizePathId(String(f?.path || '')).toLowerCase().endsWith(suffixLc),
    )
    if (bySuffix) return bySuffix
    const anySuffix = files.find((f) =>
      normalizePathId(String(f?.path || '')).toLowerCase().endsWith(suffixLc),
    )
    if (anySuffix) return anySuffix
  }
  return exact[0] || files[0] || null
}

function joinHitPath(relOrAbs: string, searchRoot: string): string {
  const rel = String(relOrAbs || '').trim()
  if (!rel) return ''
  if (isAbsoluteHostPath(rel)) return normalizePathId(rel)
  return normalizePathId(resolveWorkspaceRelativeHostPath(rel, searchRoot))
}

async function searchUnderRoot(
  api: {
    searchWorkspaceFiles: (
      root: string,
      query: string,
      limit?: number,
      threadId?: string,
    ) => Promise<{ files?: SearchHit[] }>
    resolveWorkspaceTarget?: (
      root: string,
      path: string,
      threadId?: string,
    ) => Promise<{ exists?: boolean; resolved?: string }>
  },
  searchRoot: string,
  leaf: string,
  projectsSuffix: string,
  threadId?: string,
): Promise<string | null> {
  if (!searchRoot) return null
  // Prefer exact projects/ suffix probe when we have one.
  if (projectsSuffix) {
    try {
      const probe = normalizePathId(
        resolveWorkspaceRelativeHostPath(projectsSuffix, searchRoot),
      )
      if (api.resolveWorkspaceTarget) {
        const info = await api.resolveWorkspaceTarget(searchRoot, probe, threadId)
        const resolved = String(info?.resolved || '').trim()
        if (info?.exists && resolved) return normalizePathId(resolved)
      }
    } catch {
      /* fall through to find-files */
    }
  }
  try {
    const found = await api.searchWorkspaceFiles(searchRoot, leaf, 12, threadId)
    const files = Array.isArray(found?.files) ? found.files : []
    const pick = pickProjectsAwareHit(files, leaf, projectsSuffix)
    if (!pick) return null
    const joined = joinHitPath(String(pick.path || ''), searchRoot)
    return joined || null
  } catch {
    return null
  }
}

export async function healWorkspaceOpenPath(
  path: string,
  opts?: { workspaceRoot?: string | null; threadId?: string | null },
): Promise<string> {
  const raw = String(path || '').trim()
  if (!raw) return raw
  const workspaceRoot =
    String(opts?.workspaceRoot || '').trim() || String(getChatWorkspaceRoot() || '').trim()
  const threadId = String(opts?.threadId || '').trim() || undefined
  const joined = normalizePathId(
    resolveWorkspaceRelativeHostPath(raw, workspaceRoot || ''),
  )
  const candidate = isAbsoluteHostPath(joined) ? joined : raw
  const projectsSuffix = extractProjectsRelativeSuffix(candidate) || extractProjectsRelativeSuffix(raw)

  try {
    const { api } = await import('../tauri-api.js')
    if (workspaceRoot || threadId) {
      try {
        const info = await api.resolveWorkspaceTarget(
          workspaceRoot || '',
          candidate,
          threadId,
        )
        const resolved = String(info?.resolved || '').trim()
        if (info?.exists && resolved) {
          return normalizePathId(resolved)
        }
      } catch {
        /* try find-files */
      }
    }

    const leaf = basename(candidate)
    if (!leaf || leaf.length < 3) return candidate
    if (!workspaceRoot && !threadId) return candidate

    const underBound = await searchUnderRoot(
      api,
      workspaceRoot || '',
      leaf,
      projectsSuffix,
      threadId,
    )
    if (underBound) return underBound

    // Bound root miss（典型：infinite-canvas + projects/ 实际在 sibling skill 树）
    // → 沿祖先目录搜同名 / 同 projects 后缀。
    for (const ancestor of ancestorRoots(workspaceRoot)) {
      const hit = await searchUnderRoot(api, ancestor, leaf, projectsSuffix, threadId)
      if (hit) return hit
    }

    return candidate
  } catch {
    return candidate
  }
}

/**
 * 打开前验存在，避免右栏落「file not found」死标签。
 * 只有后端明确说不存在才判 false；查询不了（无 root / api 缺失 / 报错）不拦截，
 * 保持旧行为——拦错一个真文件比放过一个死路径伤得多。
 */
export async function hostFileExists(
  path: string,
  opts?: { workspaceRoot?: string | null; threadId?: string | null },
): Promise<boolean> {
  const raw = String(path || '').trim()
  if (!raw) return false
  const workspaceRoot = String(opts?.workspaceRoot || '').trim()
  const threadId = String(opts?.threadId || '').trim() || undefined
  if (!workspaceRoot && !threadId && !isAbsoluteHostPath(raw)) return true
  try {
    const { api } = await import('../tauri-api.js')
    const info = await api.resolveWorkspaceTarget(workspaceRoot, raw, threadId)
    return info?.exists === true
  } catch {
    return true
  }
}
