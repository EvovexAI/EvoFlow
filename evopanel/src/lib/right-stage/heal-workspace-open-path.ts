/**
 * 对话里常只给文件名或漏掉 projects/<ep>/outputs/。
 * 打开前用 resolve-target + find-files 把路径纠到磁盘真实位置。
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

    const found = await api.searchWorkspaceFiles(workspaceRoot || '', leaf, 8, threadId)
    const files = Array.isArray(found?.files) ? found.files : []
    const exact = files.filter(
      (f: { path?: string; name?: string }) =>
        String(f?.name || '').toLowerCase() === leaf.toLowerCase() ||
        String(f?.path || '')
          .replace(/\\/g, '/')
          .toLowerCase()
          .endsWith(`/${leaf.toLowerCase()}`),
    )
    const pick = exact[0] || files[0]
    const rel = String(pick?.path || '').trim()
    if (!rel) return candidate
    if (isAbsoluteHostPath(rel)) return normalizePathId(rel)
    if (!workspaceRoot) return candidate
    return normalizePathId(resolveWorkspaceRelativeHostPath(rel, workspaceRoot))
  } catch {
    return candidate
  }
}
