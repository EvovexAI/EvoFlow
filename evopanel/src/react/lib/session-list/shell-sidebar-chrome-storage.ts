/**
 * 侧栏「任务 / BOT」视图与 BOT 筛选的持久化（跨刷新 / 冷启动对齐上次关闭态）。
 */

export const LS_SHELL_SIDEBAR_VIEW_MODE = 'evopanel_shell_sidebar_view_mode'
export const LS_SHELL_FOCUSED_EMPLOYEE = 'evopanel_shell_focused_employee'

export type ShellSidebarViewMode = 'grouped' | 'project'

export function loadShellSidebarViewMode(): ShellSidebarViewMode {
  try {
    const raw = String(localStorage.getItem(LS_SHELL_SIDEBAR_VIEW_MODE) || '').trim()
    if (raw === 'project' || raw === 'grouped') return raw
    // 旧版第三 Tab「部门」已撤；落在 BOT，进群仍从部门头走
    if (raw === 'depts') return 'project'
  } catch {
    /* ignore */
  }
  return 'grouped'
}

export function saveShellSidebarViewMode(mode: ShellSidebarViewMode): void {
  try {
    localStorage.setItem(LS_SHELL_SIDEBAR_VIEW_MODE, mode)
  } catch {
    /* ignore */
  }
}

export function loadFocusedEmployeeCode(): string | null {
  try {
    const raw = String(localStorage.getItem(LS_SHELL_FOCUSED_EMPLOYEE) || '').trim()
    return raw || null
  } catch {
    return null
  }
}

export function saveFocusedEmployeeCode(code: string | null): void {
  try {
    const v = String(code || '').trim()
    if (!v) localStorage.removeItem(LS_SHELL_FOCUSED_EMPLOYEE)
    else localStorage.setItem(LS_SHELL_FOCUSED_EMPLOYEE, v)
  } catch {
    /* ignore */
  }
}

/** BOT 侧栏部门筛选：空=全部部门；`__unassigned__`=未分部门；其余为部门 id / name:… */
export const LS_SHELL_FOCUSED_BOT_DEPT = 'evopanel_shell_focused_bot_dept'

export function loadFocusedBotDeptKey(): string | null {
  try {
    const raw = String(localStorage.getItem(LS_SHELL_FOCUSED_BOT_DEPT) || '').trim()
    return raw || null
  } catch {
    return null
  }
}

export function saveFocusedBotDeptKey(key: string | null): void {
  try {
    const v = String(key || '').trim()
    if (!v) localStorage.removeItem(LS_SHELL_FOCUSED_BOT_DEPT)
    else localStorage.setItem(LS_SHELL_FOCUSED_BOT_DEPT, v)
  } catch {
    /* ignore */
  }
}
