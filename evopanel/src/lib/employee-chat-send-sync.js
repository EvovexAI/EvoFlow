/**
 * platform employees.chat_send → 打开右栏员工对话 + 走主聊同款 chatSend。
 * 小薇不跟流；结果用 employees.messages 回看。
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
