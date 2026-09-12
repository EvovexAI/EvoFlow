export const SS_EXPANDED_WORKSPACES = 'evopanel_shell_workspace_expanded'

export function loadExpandedWorkspaceKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(SS_EXPANDED_WORKSPACES)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.map((v) => String(v || '').trim()).filter(Boolean))
  } catch {
    return new Set()
  }
}

export function saveExpandedWorkspaceKeys(keys: Set<string>): void {
  try {
    localStorage.setItem(SS_EXPANDED_WORKSPACES, JSON.stringify([...keys]))
  } catch {
    /* ignore */
  }
}
