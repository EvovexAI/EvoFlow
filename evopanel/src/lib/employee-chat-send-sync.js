/**
 * platform employees.chat_send â ćĺźĺłć ĺĺˇĽĺŻščŻ + čľ°ä¸ťčĺćŹž chatSendă
 * ĺ°čä¸čˇćľďźçťćç¨ employees.messages ĺçă
 */
import { openEmployeeProcessInRightStage } from './right-stage/open-employee-process-stage.js'
import {
  isProactiveSessionKey,
  parseProactiveSessionKey,
} from '../react/lib/session-list/workspace-groups.js'

function parseToolResultObject(raw) {
  if (!raw) return null
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw
  const text = String(raw || '').trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function patchProactiveChatContext(sessionKey) {
  if (!isProactiveSessionKey(sessionKey)) return
  const parsed = parseProactiveSessionKey(sessionKey)
  try {
    const { api } = await import('./tauri-api.js')
    const patch = {
      source: 'proactive',
      proactive_agent_code: parsed.agentCode || null,
      employee_talk_mode: 'chat',
    }
    if (parsed.kind === 'task' && parsed.taskId) {
      patch.workspace_kind = 'task'
      patch.related_task_id = parsed.taskId
    } else if (parsed.kind === 'chat') {
      patch.workspace_kind = 'chat'
      patch.related_task_id = null
    } else if (parsed.kind === 'duty') {
      patch.workspace_kind = 'duty'
    }
    await api.chatUpdateContext?.(sessionKey, patch)
  } catch {
    /* ignore */
  }
}

/**
 * @param {unknown} raw
 * @param {{ argsText?: string }} [opts]
 * @returns {Promise<boolean>}
 */
export async function syncEmployeeChatSendFromToolResult(raw, opts = {}) {
  void opts
  const obj = parseToolResultObject(raw)
  if (!obj || obj.ok === false || obj.pending_confirm === true) return false
  if (String(obj.client_effect || '').trim() !== 'employee_chat_send') return false

  const agentCode = String(obj.agent_code || obj.agentCode || '').trim()
  const message = String(obj.message || '').trim()
  const sessionKey = String(obj.session_key || obj.sessionKey || '').trim()
  const taskId = String(obj.task_id || obj.taskId || '').trim()
  const roleName = String(obj.role_name || obj.roleName || obj.name || '').trim()
  if (!agentCode || !message || !sessionKey) return false

  // 后端应已吐 proactive:{agentCode}:…；若仍是主聊 key，绝不能往主会话 chatSend
  if (!isProactiveSessionKey(sessionKey)) {
    console.warn('[employee-chat-send] refuse non-proactive session_key', sessionKey)
    return false
  }
  const parsed = parseProactiveSessionKey(sessionKey)
  if (String(parsed.agentCode || '').trim() !== agentCode) {
    console.warn('[employee-chat-send] session_key agent mismatch', {
      sessionKey,
      agentCode,
      parsed: parsed.agentCode,
    })
    return false
  }

  try {
    const { ensureRightStageKindsRegistered } = await import(
      '../react/right-stage/register-kinds.js'
    )
    ensureRightStageKindsRegistered()
  } catch {
    /* optional */
  }

  openEmployeeProcessInRightStage(
    {
      taskId: taskId || '',
      agentCode,
      roleName,
      title: roleName || undefined,
      busy: true,
      employeeSessionKey: sessionKey,
    },
    { layout: 'wide' },
  )

  try {
    await patchProactiveChatContext(sessionKey)
    const { api } = await import('./tauri-api.js')
    await api.chatSend(sessionKey, message, [], undefined, {
      source: 'employees.chat_send',
    })
    return true
  } catch (e) {
    console.warn('[employee-chat-send] chatSend failed', e)
    return false
  }
}
