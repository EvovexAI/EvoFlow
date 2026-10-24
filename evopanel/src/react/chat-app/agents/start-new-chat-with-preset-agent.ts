/**
 * Switch the current session's agent/role (keeps history).
 * Extracted from ChatApp.tsx (P53).
 */
import type { Dispatch, SetStateAction } from 'react'
import { toast } from '../../../components/toast.js'
import { toUserFacingError } from '../../../lib/user-facing-error.js'
import { isProactiveSessionKey } from '../../lib/session-list/workspace-groups.js'
import { resolveSessionAgentCodeForUi } from '../utils/session-meta.js'
import type { AgentPickerRow } from '../../lib/agent-tags.js'
import type { ChatSessionRow } from '../../chat-types.js'

export type StartNewChatWithPresetAgentCtx = {
  selectedSessionKey: string
  agents: AgentPickerRow[]
  setRoleSwitchBusy: (v: boolean) => void
  setBottomRoleOpen: (v: boolean) => void
  setRoleUiNonce: Dispatch<SetStateAction<number>>
  setSessions: Dispatch<SetStateAction<ChatSessionRow[]>>
  ensureChatSessionKey: () => Promise<string | null>
}

export async function startNewChatWithPresetAgent(
  ctx: StartNewChatWithPresetAgentCtx,
  agentCodeRaw: string,
): Promise<void> {
  const code = (agentCodeRaw || '').trim().toLowerCase()
  if (!code) return
  ctx.setRoleSwitchBusy(true)
  ctx.setBottomRoleOpen(false)
  try {
    const { api } = await import('../../../lib/tauri-api.js')
    const sk = (ctx.selectedSessionKey || (await ctx.ensureChatSessionKey()) || '').trim()
    if (!sk) return
    if (isProactiveSessionKey(sk)) {
      toast('智能体员工会话岗位已固定，不能切换角色', 'info')
      return
    }
    if (resolveSessionAgentCodeForUi(sk) === code) {
      toast('当前已是该角色', 'info')
      return
    }

    const agentRow = ctx.agents.find(
      (a) => String(a?.agent_code || '').trim().toLowerCase() === code,
    )
    const label =
      (agentRow && String(agentRow.agent_name || '').trim()) ||
      (code === 'main' ? 'EvoFlow' : code === 'claude-code' ? '代码助手' : code)

    if (code === 'main') {
      await api.chatUpdateContext(sk, {
        use_claude_code_chat: false,
        agent_name: 'main',
        agent_id: 'main',
        collab_phase: 'idle',
        collab_task_id: null,
        model_name: null,
      })
      ctx.setSessions((prev) =>
        prev.map((s) =>
          String(s.sessionKey || '') === sk ? { ...s, agentId: 'main', modelName: null } : s,
        ),
      )
      ctx.setRoleUiNonce((n) => n + 1)
      toast('已切换为 EvoFlow（当前会话）', 'success')
      return
    }
    if (code === 'claude-code') {
      await api.chatUpdateContext(sk, {
        use_claude_code_chat: true,
        agent_name: 'claude-code',
        collab_phase: 'idle',
        collab_task_id: null,
        model_name: null,
      })
      ctx.setSessions((prev) =>
        prev.map((s) =>
          String(s.sessionKey || '') === sk
            ? { ...s, agentId: 'claude-code', modelName: null }
            : s,
        ),
      )
      ctx.setRoleUiNonce((n) => n + 1)
      toast('已切换为代码助手模式（当前会话）', 'success')
      return
    }

    await api.chatUpdateContext(sk, {
      use_claude_code_chat: false,
      agent_name: code,
      agent_id: code,
      collab_phase: 'idle',
      collab_task_id: null,
      model_name: null,
    })
    ctx.setSessions((prev) =>
      prev.map((s) =>
        String(s.sessionKey || '') === sk ? { ...s, agentId: code, modelName: null } : s,
      ),
    )
    ctx.setRoleUiNonce((n) => n + 1)
    toast(`已切换为「${label}」（当前会话，历史消息保留）`, 'success')
  } catch (e) {
    toast(
      toUserFacingError((e as Record<string, unknown>)?.message || e || '切换角色失败', '切换角色失败'),
      'error',
    )
  } finally {
    ctx.setRoleSwitchBusy(false)
  }
}
