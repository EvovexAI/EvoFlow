/**
 * Open employee role sheet or agent edit dialog for the current chat role.
 * Extracted from ChatApp.tsx (P37).
 */
import { toast } from '../../../components/toast.js'
import type { AgentPickerRow } from '../../lib/agent-tags.js'

export type OpenCurrentAgentEditorCtx = {
  agents: AgentPickerRow[]
  currentRoleCodeForUi: string | null | undefined
  employeeSessionAgentCode: string | null | undefined
  isProactiveEmployeeSession: boolean
  refreshAgentsList: () => Promise<void>
  setRoleUiNonce: (fn: (n: number) => number) => void
}

export function openCurrentAgentEditor(ctx: OpenCurrentAgentEditorCtx): void {
  // 员工会话：打开「编辑员工」岗位 sheet，不打开智能体编辑器 / 不切换其他人
  if (ctx.isProactiveEmployeeSession) {
    const code = String(ctx.employeeSessionAgentCode || '').trim()
    if (!code) {
      toast('当前没有可编辑的员工', 'warning')
      return
    }
    void Promise.all([
      import('../../../lib/tauri-api.js'),
      import('../../../lib/proactive-role-edit.js'),
    ])
      .then(async ([{ api }, { showEditRoleModal }]) => {
        const res = (await api.proactiveGetRole(code)) as { role?: unknown } | unknown
        const role =
          res && typeof res === 'object' && 'role' in (res as object)
            ? (res as { role?: unknown }).role || res
            : res
        if (!role || typeof role !== 'object') {
          toast('找不到当前员工', 'error')
          return
        }
        await showEditRoleModal(role, {
          sheetTitle: '编辑员工',
          sheetKicker: '员工',
          confirmLabel: '保存员工',
          allowAgentRebind: false,
          onSaved: async () => {
            await ctx.refreshAgentsList()
            ctx.setRoleUiNonce((n) => n + 1)
          },
        })
      })
      .catch((e) => {
        toast(`无法打开编辑：${(e as Error)?.message || e}`, 'error')
      })
    return
  }

  const code = String(ctx.currentRoleCodeForUi || '').trim()
  if (!code) {
    toast('当前没有可编辑的智能体', 'warning')
    return
  }
  void import('../../../pages/agents-role-ui.js')
    .then(({ showEditRoleDialog }) => {
      const page = document.querySelector('.role-page') || document.body
      const state = {
        agents: Array.isArray(ctx.agents) ? ctx.agents : [],
        hiredCodes: new Set<string>(),
        onRefresh: async () => {
          await ctx.refreshAgentsList()
          ctx.setRoleUiNonce((n) => n + 1)
        },
      }
      return showEditRoleDialog(page, state, code)
    })
    .catch((e) => {
      toast(`无法打开编辑：${(e as Error)?.message || e}`, 'error')
    })
}
