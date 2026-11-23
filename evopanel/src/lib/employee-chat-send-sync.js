/**
 * platform employees.chat_send → 打开右栏员工对话，把首条消息交给面板输入区同款发送链路。
 * 小薇不跟流；结果用 employees.messages 回看。
 *
 * 故意不在这里直接 api.chatSend：与人对齐时，由 V4EmployeeProcessPane.handleSend
 * 先 ensureThread 再发，右栏才能立刻订到正确 thread。
 */
import { openEmployeeProcessInRightStage } from './right-stage/open-employee-process-stage.js'
import { getCurrentRightStageSessionKey } from './right-stage/right-stage-scope.js'
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

  // 标签归属钉在「当前 UI 会话」（主聊 / 部门群），不要空着靠 freeze——
  // 空归属在草稿/切会话时会被滤掉，表现为「右栏有内容但上面没标签、点不回去」。
  // 【self-evolution-bot · 2026-11-20 · 第100轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：服务端 wake 已受理（queued=true）时，**只开面板不再 pendingSend**；
  //   wake 没受理才回退到面板本地发送。
  // 为什么（现网取证 2026-11-20 20:07）：chat_send 服务端跑了（落 task 桶 20:07:33 回一条），
  //   前端 pendingSend 又跑了一遍（落 chat 桶 20:07:34 再回一条）——同一句话两遍、两个桶。
  //   第100轮把服务端 pin 到同一个 chat 桶后，两遍会挤进同一屏，用户会看到两条一样的消息。
  // 判据：服务端已真跑（queued）→ 前端只负责把那一屏拉开；服务端没跑（queued=false/失败）→
  //   前端本地发，保证用户仍有来有回（手机/主聊场景没有面板，走的是服务端那条腿）。
  const serverHandled = obj.queued === true
  // 【self-evolution-bot · 2026-11-21 · 第109轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：判据从「panel_delivery 标记」升级成「panel_dispatch 实况」。
  //   panel_dispatch 取值：pane-live（面板已在自己 chatSend → live SSE）/
  //   pending-open（面板刚拉开、首发排队）/ 空（服务端 CDP 没驱到，前端得自己发）。
  // 为什么（用户 2026-11-21 点破）：「我在右侧面板手打能看到实时结果，你后台触发页面上啥也
  //   看不到。」第108轮只回 panel_delivery 标记、指望前端补发 —— 但只要这次调用不经过
  //   agui 工具结果同步（Xiaomi 主聊 / 手机 / 别的 agent），标记就没人消费，面板照样没流。
  //   现在服务端经 CDP 直接把面板驱起来，前端只需按实况决定补不补，不再靠猜。
  // 判据（可反证）：panel_dispatch='pane-live' 时若还 pendingSend，同一句话必发两遍；
  //   panel_dispatch 为空（CDP 不可用）时若不 pendingSend，用户就真的看不到任何回话。
  const panelDelivery = obj.panel_delivery === true
  const panelDispatch = String(obj.panel_dispatch || '').trim()
  // 【self-evolution-bot · 2026-11-22 · 第127轮 · 模型:deepseek-v4.1-flash】
  // 改了什么：`panelDroveIt` 补上 `pending-open-switch`。
  // 为什么（本轮现网实证 22:01:57）：后端已 mint 新会话、CDP 回 `pending-open-switch`，
  //   后端 `employees.py` 的 panel_dispatch 白名单也已认它（= 面板侧会发、且已把正文
  //   写进签 data 的 pendingSendMessage）。前端这里漏认，就会判成「面板没接管」
  //   → 再补一条 pendingSend —— 同一句话两条投递源，正是「发两遍」的现成配方。
  //   两端口径必须一致：后端说接管了，前端就不许再补。
  // 注意：这里**只**认同口径，不额外传 pending；正文已由 CDP 那条腿带进签 data。
  const panelDroveIt =
    panelDispatch === 'pane-live' ||
    panelDispatch === 'pending-open' ||
    panelDispatch === 'pending-open-switch'
  const pendingSendMessage = panelDroveIt ? undefined : panelDelivery || !serverHandled ? message : undefined
  logRightStagePlatform('employee_chat_send.send-owner', {
    serverHandled,
    panelDelivery,
    panelDispatch: panelDispatch || null,
    // 【self-evolution-bot · 2026-11-22 · 第127轮 · 模型:deepseek-v4.1-flash】
    // 改了什么：日志字段改成与实际投递判据一致（原来写 `!serverHandled || panelDelivery`，
    //   那是旧算式，跟上面真正的三元判据不同源）。
    // 为什么：判据改了日志不改 = 下次照日志排查会被指向错误方向（本轮我就是先被它带偏）。
    willPendingSend: Boolean(pendingSendMessage),
    agentCode,
    sessionKey,
  })
  const ownerSk = String(getCurrentRightStageSessionKey() || '').trim() || undefined
  const tabId = openEmployeeProcessInRightStage(
    {
      taskId: taskId || '',
      agentCode,
      roleName,
      title: roleName || undefined,
      busy: true,
      employeeSessionKey: sessionKey,
      pendingSendMessage,
    },
    { layout: 'wide', sessionKey: ownerSk },
  )
  logRightStageTrigger('employee_chat_send.open done', {
    tabId: tabId || null,
    agentCode,
    sessionKey,
    ownerSessionKey: ownerSk || null,
    roleName: roleName || null,
    pendingSendLen: message.length,
    ms: Date.now() - t0,
  })
  return Boolean(tabId)
}
