/**
 * Patch session permission preset from the composer more/permission menu.
 * Extracted from ChatApp.tsx (P54).
 */
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { toast } from '../../../components/toast.js'
import { toUserFacingError } from '../../../lib/user-facing-error.js'
import type { ChatSessionRow } from '../../chat-types.js'

export type ApplyMoreMenuSessionApprovalPolicyCtx = {
  sessionRef: MutableRefObject<string>
  selectedSessionKey: string
  ensureChatSessionKey: () => Promise<string | null>
  setSessions: Dispatch<SetStateAction<ChatSessionRow[]>>
  setToolApprovalPolicyTick: Dispatch<SetStateAction<number>>
  permissionPresetToast: (presetId: string) => string
}

export async function applyMoreMenuSessionApprovalPolicy(
  ctx: ApplyMoreMenuSessionApprovalPolicyCtx,
  presetId: string,
  opts?: { quiet?: boolean },
): Promise<void> {
  const sk = (await ctx.ensureChatSessionKey()) || ctx.sessionRef.current || ctx.selectedSessionKey
  if (!sk) return
  const [{ patchSessionPermissionPreset }, { wsClient: wsClientMod }] = await Promise.all([
    import('../../../lib/tool-approval-settings.js'),
    import('../../../lib/ws-client.js'),
  ])
  let result: {
    permission_preset?: string | null
    effective_permission_preset?: string | null
    tool_approval_policy?: unknown
    effective_policy?: unknown
    [key: string]: unknown
  }
  try {
    result = await patchSessionPermissionPreset(sk, presetId)
  } catch (err) {
    // 静默失败会让用户以为已保存（刷新后回跳旧档位）——必须可见。
    toast(
      `权限档位保存失败：${toUserFacingError((err as Error)?.message || err)}`,
      'error',
    )
    throw err
  }
  // Force local context so session-list refresh cannot fall back to global grant_all.
  wsClientMod.applySessionToolApprovalPolicy(sk, {
    ...result,
    permission_preset: result.permission_preset || presetId,
    effective_permission_preset: result.effective_permission_preset || presetId,
  })
  const effPreset = result.effective_permission_preset || presetId
  const explicitPreset = result.permission_preset || presetId
  ctx.setSessions((prev) =>
    prev.map((s) => {
      if (String(s.sessionKey || '') !== sk) return s
      const sessionCtx: Record<string, unknown> =
        s.context && typeof s.context === 'object' ? { ...s.context } : {}
      sessionCtx.permission_preset = explicitPreset
      sessionCtx.effective_permission_preset = effPreset
      if (result.tool_approval_policy) {
        sessionCtx.tool_approval_policy = result.tool_approval_policy
      }
      const effPolicy = result.effective_policy || result.tool_approval_policy
      if (effPolicy) {
        sessionCtx.effective_tool_approval_policy = effPolicy
      }
      return { ...s, context: sessionCtx }
    }),
  )
  ctx.setToolApprovalPolicyTick((n) => n + 1)
  if (!opts?.quiet) {
    toast(ctx.permissionPresetToast(presetId), 'success')
  }
}
