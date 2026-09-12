/** 侧栏收藏的工作空间（钉到对话列表上方快捷入口） */
export const SS_PINNED_WORKSPACES = 'evopanel_shell_workspace_pinned'

export function loadPinnedWorkspaceKeys(): string[] {
  try {
    const raw = localStorage.getItem(SS_PINNED_WORKSPACES)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    const out: string[] = []
    for (const v of parsed) {
      const k = String(v || '').trim()
      if (!k || seen.has(k)) continue
      seen.add(k)
      out.push(k)
    }
    return out
  } catch {
    return []
  }
}

export function savePinnedWorkspaceKeys(keys: string[]): void {
  try {
    const seen = new Set<string>()
    const out: string[] = []
    for (const v of keys) {
      const k = String(v || '').trim()
      if (!k || seen.has(k)) continue
      seen.add(k)
      out.push(k)
    }
    localStorage.setItem(SS_PINNED_WORKSPACES, JSON.stringify(out))
  } catch {
    /* ignore */
  }
}
