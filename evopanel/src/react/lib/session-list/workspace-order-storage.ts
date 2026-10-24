/** 任务列表工作区分组的手动排序（拖拽后持久化，localStorage，仅本机偏好） */
export const SS_WORKSPACE_GROUP_ORDER = 'evopanel_shell_workspace_order'

export function loadWorkspaceGroupOrder(): string[] {
  try {
    const raw = localStorage.getItem(SS_WORKSPACE_GROUP_ORDER)
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

export function saveWorkspaceGroupOrder(keys: string[]): void {
  try {
    const seen = new Set<string>()
    const out: string[] = []
    for (const v of keys) {
      const k = String(v || '').trim()
      if (!k || seen.has(k)) continue
      seen.add(k)
      out.push(k)
    }
    localStorage.setItem(SS_WORKSPACE_GROUP_ORDER, JSON.stringify(out))
  } catch {
    /* ignore */
  }
}
