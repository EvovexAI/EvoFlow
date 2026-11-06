/**
 * 工作流「编辑执行者」：优先复用员工编辑 sheet（showEditRoleModal）。
 * 网关预热未完成时先等就绪，避免 proactiveGetRole 直接 warming timeout。
 */
import { toast } from '../../../components/toast.js'
import { toUserFacingError } from '../../../lib/user-facing-error.js'
import type { AgentPickerRow } from '../../lib/agent-tags.ts'

function bumpOverlayZ(selector: string) {
  const el = document.querySelector(selector) as HTMLElement | null
  if (el) el.style.zIndex = '1000035'
}

function unwrapRole(res: unknown): Record<string, unknown> | null {
  if (!res || typeof res !== 'object') return null
  const obj = res as Record<string, unknown>
  const nested = obj.role
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return nested as Record<string, unknown>
  }
  if (obj.agent_code || obj.role_name || obj.config) {
    return obj
  }
  return null
}

function isWarmingError(err: unknown): boolean {
  const msg = String((err as Error)?.message || err || '')
  return /gateway warming|warming timeout|warm latch/i.test(msg)
}

async function ensureGatewayReady(): Promise<boolean> {
  const { isGatewayWarming, waitForBackendReady, isBackendReady } = await import(
    '../../../lib/tauri-api.js'
  )
  if (typeof isBackendReady === 'function' && isBackendReady() === true) return true
  if (typeof isGatewayWarming === 'function' && isGatewayWarming()) {
    toast('服务正在启动，稍等一下…', 'info')
    const ok = await waitForBackendReady?.(90_000).catch(() => false)
    return !!ok
  }
  return true
}

/** 与聊天「编辑员工」同一入口 */
async function openEmployeeSheet(
  code: string,
  onSaved?: () => void | Promise<void>,
): Promise<boolean> {
  const [{ api }, { showEditRoleModal }] = await Promise.all([
    import('../../../lib/tauri-api.js'),
    import('../../../lib/proactive-role-edit.js'),
  ])
  let res: unknown
  try {
    res = await api.proactiveGetRole(code)
  } catch (e) {
    if (isWarmingError(e)) throw e
    console.warn('[workflow-agent-editor] proactiveGetRole:', e)
    return false
  }
  const role = unwrapRole(res)
  if (!role) return false

  await showEditRoleModal(role, {
    sheetTitle: '编辑员工',
    sheetKicker: '员工',
    confirmLabel: '保存员工',
    allowAgentRebind: false,
    onSaved: async () => {
      await onSaved?.()
    },
  })
  bumpOverlayZ('.hire-overlay.modal-overlay')
  return !!document.querySelector('.hire-overlay.modal-overlay')
}

async function openGenericAgentEditor(
  code: string,
  agents: AgentPickerRow[],
  onSaved?: () => void | Promise<void>,
): Promise<void> {
  const { showEditRoleDialog } = await import('../../../pages/agents-role-ui.js')
  await showEditRoleDialog(
    document.body,
    {
      agents: Array.isArray(agents) ? agents : [],
      hiredCodes: new Set<string>(),
      onRefresh: async () => {
        await onSaved?.()
      },
    },
    code,
  )
  if (!document.querySelector('.role-editor-overlay')) {
    throw new Error(`找不到智能体「${code}」`)
  }
  bumpOverlayZ('.role-editor-overlay')
}

export async function openWorkflowAgentEditor(
  agentCode: string,
  agents: AgentPickerRow[],
  onSaved?: () => void | Promise<void>,
): Promise<void> {
  const code = String(agentCode || '').trim()
  if (!code) {
    toast('当前没有可编辑的执行者', 'warning')
    return
  }

  try {
    const ready = await ensureGatewayReady()
    if (!ready) {
      toast('服务还在启动，请稍后再点编辑', 'warning')
      return
    }

    toast('正在打开编辑…', 'info')
    if (await openEmployeeSheet(code, onSaved)) return
    await openGenericAgentEditor(code, agents, onSaved)
  } catch (e) {
    console.error('[workflow-agent-editor]', e)
    if (isWarmingError(e)) {
      toast('服务还在启动，请稍后再点编辑', 'warning')
      return
    }
    toast(toUserFacingError(e, '无法打开编辑'), 'error')
  }
}
