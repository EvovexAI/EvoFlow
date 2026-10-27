/**
 * platform employees.chat_send → 打开右栏员工对话，把首条消息交给面板输入区同款发送链路。
 * 小薇不跟流；结果用 employees.messages 回看。
 *
 * 故意不在这里直接 api.chatSend：与人对齐时，由 V4EmployeeProcessPane.handleSend
 * 先 ensureThread 再发，右栏才能立刻订到正确 thread。
 */
import { openEmployeeProcessInRightStage } from './right-stage/open-employee-process-stage.js'
import {
  isProactiveSessionKey,
  parseProactiveSessionKey,
} from '../react/lib/session-list/workspace-groups.js'
import {
  logRightStagePlatform,
  logRightStageTrigger,
} from './right-stage/panel-set-debug-log.js'

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

/**
 * @param {unknown} raw
 * @param {{ argsText?: string }} [opts]
 * @returns {Promise<boolean>}
 */
export async function syncEmployeeChatSendFromToolResult(raw, opts = {}) {
  void opts
  const t0 = Date.now()
  const obj = parseToolResultObject(raw)
  if (!obj) {
    logRightStagePlatform('employee_chat_send.sync skip', { reason: 'not-object', rawType: typeof raw })
    return false
  }
  const clientEffect = String(obj.client_effect || '').trim()
  if (obj.ok === false || obj.pending_confirm === true) {
    logRightStagePlatform('employee_chat_send.sync skip', {
      reason: obj.pending_confirm ? 'pending_confirm' : 'ok=false',
      clientEffect: clientEffect || null,
      agentCode: obj.agent_code || obj.agentCode || null,
    })
    return false
  }
  if (clientEffect !== 'employee_chat_send') {
    return false
  }

  const agentCode = String(obj.agent_code || obj.agentCode || '').trim()
  const message = String(obj.message || '').trim()
  const sessionKey = String(obj.session_key || obj.sessionKey || '').trim()
  const taskId = String(obj.task_id || obj.taskId || '').trim()
  let roleName = String(obj.role_name || obj.roleName || obj.name || '').trim()
  if (roleName && agentCode && roleName.toLowerCase() === agentCode.toLowerCase()) {
    roleName = ''
  }

  logRightStagePlatform('employee_chat_send.sync hit', {
    agentCode: agentCode || null,
    taskId: taskId || null,
    sessionKey: sessionKey || null,
    roleName: roleName || null,
    messageLen: message.length,
    messagePreview: message.slice(0, 120),
    ignoredCallerSessionKey: obj.ignored_caller_session_key || null,
    queued: obj.queued === true,
  })

  if (!agentCode || !message || !sessionKey) {
    logRightStageTrigger('employee_chat_send.open refuse', {
      reason: 'missing-fields',
      hasAgent: Boolean(agentCode),
      hasMessage: Boolean(message),
      hasSessionKey: Boolean(sessionKey),
    })
    return false
  }

  if (!isProactiveSessionKey(sessionKey)) {
    logRightStageTrigger('employee_chat_send.open refuse', {
      reason: 'non-proactive-session_key',
      sessionKey,
      agentCode,
    })
    console.warn('[employee-chat-send] refuse non-proactive session_key', sessionKey)
    return false
  }
  const parsed = parseProactiveSessionKey(sessionKey)
  if (String(parsed.agentCode || '').trim() !== agentCode) {
    logRightStageTrigger('employee_chat_send.open refuse', {
      reason: 'session_key-agent-mismatch',
      sessionKey,
      agentCode,
      parsedAgent: parsed.agentCode || null,
    })
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

  const tabId = openEmployeeProcessInRightStage(
    {
      taskId: taskId || '',
      agentCode,
      roleName,
      title: roleName || undefined,
      busy: true,
      employeeSessionKey: sessionKey,
      pendingSendMessage: message,
    },
    { layout: 'wide' },
  )
  logRightStageTrigger('employee_chat_send.open done', {
    tabId: tabId || null,
    agentCode,
    sessionKey,
    roleName: roleName || null,
    pendingSendLen: message.length,
    ms: Date.now() - t0,
  })
  return Boolean(tabId)
}
