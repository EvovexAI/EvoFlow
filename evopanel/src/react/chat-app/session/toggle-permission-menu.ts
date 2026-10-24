/**
 * Toggle composer permission preset menu (mutually exclusive with other bottom menus).
 * Extracted from ChatApp.tsx (P61).
 */
import type { Dispatch, SetStateAction } from 'react'

export type TogglePermissionMenuCtx = {
  selectedSessionKey: string
  setBottomPermissionOpen: Dispatch<SetStateAction<boolean>>
  setModeMenuOpen: (open: boolean) => void
  setBottomModelOpen: (open: boolean) => void
  setBottomMoreOpen: (open: boolean) => void
  setBottomWorkspaceOpen: (open: boolean) => void
  setBottomRoleOpen: (open: boolean) => void
  setToolApprovalPolicyTick: Dispatch<SetStateAction<number>>
  fetchGlobalToolApprovalPolicy: () => Promise<unknown>
  fetchSessionToolApprovalPolicy: (sk: string) => Promise<unknown>
  applySessionToolApprovalPolicy: (sk: string, result: unknown) => void
}

export function togglePermissionMenu(ctx: TogglePermissionMenuCtx): void {
  ctx.setBottomPermissionOpen((v) => {
    const next = !v
    if (next) {
      // 打开时再拉一次全局默认，避免设置页改过而聊天菜单开关仍停在旧缓存
      void ctx.fetchGlobalToolApprovalPolicy().catch(() => {})
      if (ctx.selectedSessionKey) {
        void ctx
          .fetchSessionToolApprovalPolicy(ctx.selectedSessionKey)
          .then((result) => {
            ctx.applySessionToolApprovalPolicy(ctx.selectedSessionKey, result)
            ctx.setToolApprovalPolicyTick((n) => n + 1)
          })
          .catch(() => {})
      }
    }
    return next
  })
  ctx.setModeMenuOpen(false)
  ctx.setBottomModelOpen(false)
  ctx.setBottomMoreOpen(false)
  ctx.setBottomWorkspaceOpen(false)
  ctx.setBottomRoleOpen(false)
}
