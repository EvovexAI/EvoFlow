import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * 【self-evolution-bot · 2026-11-20 · 第100轮 · 模型:deepseek-v4.1-flash-1017】
 * 改了什么：`employees.chat_send` 的前端同步只允许「一个 owner」发消息——
 *   服务端 wake 已受理（queued=true）时前端只开面板、不再 pendingSend；否则前端本地发。
 * 为什么（现网取证 2026-11-20 20:07:30 → 20:07:47）：同一句话被跑了两遍——
 *   服务端落 task 桶 20:07:33 回一条，前端 pendingSend 落 chat 桶 20:07:34 又回一条。
 *   第100轮把服务端 pin 到同一个 chat 桶后，两遍会挤进同一屏，用户直接看到两条一样的消息。
 *
 * 判据（可反证）：把 `serverHandled` 改回恒 false（即恢复旧行为），
 * 「queued=true 时不 pendingSend」这条必须红。
 */

const openEmployeeProcessInRightStage = vi.fn(() => 'tab-1')

vi.mock('../src/lib/right-stage/open-employee-process-stage.js', () => ({
  openEmployeeProcessInRightStage: (...args) => openEmployeeProcessInRightStage(...args),
}))
vi.mock('../src/lib/right-stage/right-stage-scope.js', () => ({
  getCurrentRightStageSessionKey: () => 'agent:main:abc',
}))
vi.mock('../src/lib/right-stage/panel-set-debug-log.js', () => ({
  logRightStagePlatform: () => {},
  logRightStageTrigger: () => {},
}))
vi.mock('../src/react/right-stage/register-kinds.js', () => ({
  ensureRightStageKindsRegistered: () => {},
}))

const SK = 'proactive:reviewer:chat:dept-e52862be9e71'

function result(overrides) {
  return {
    ok: true,
    client_effect: 'employee_chat_send',
    agent_code: 'reviewer',
    role_name: '审核员',
    message: '只回一句话',
    session_key: SK,
    ...overrides,
  }
}

describe('employee-chat-send-sync: 一个 owner', () => {
  beforeEach(() => {
    openEmployeeProcessInRightStage.mockClear()
  })

  it('服务端已受理（queued=true）→ 只开面板，不 pendingSend', async () => {
    const { syncEmployeeChatSendFromToolResult } = await import(
      '../src/lib/employee-chat-send-sync.js'
    )
    const ok = await syncEmployeeChatSendFromToolResult(result({ queued: true }))

    expect(ok).toBe(true)
    expect(openEmployeeProcessInRightStage).toHaveBeenCalledTimes(1)
    const payload = openEmployeeProcessInRightStage.mock.calls[0][0]
    expect(payload.employeeSessionKey).toBe(SK)
    expect(payload.pendingSendMessage).toBeUndefined()
  })

  it('服务端没跑起来（queued=false）→ 前端本地发，保证有来有回', async () => {
    const { syncEmployeeChatSendFromToolResult } = await import(
      '../src/lib/employee-chat-send-sync.js'
    )
    await syncEmployeeChatSendFromToolResult(result({ queued: false }))

    const payload = openEmployeeProcessInRightStage.mock.calls[0][0]
    expect(payload.pendingSendMessage).toBe('只回一句话')
  })

  it('开场（无 queued 字段）→ 前端本地发', async () => {
    const { syncEmployeeChatSendFromToolResult } = await import(
      '../src/lib/employee-chat-send-sync.js'
    )
    await syncEmployeeChatSendFromToolResult(result({}))

    const payload = openEmployeeProcessInRightStage.mock.calls[0][0]
    expect(payload.pendingSendMessage).toBe('只回一句话')
  })

  // 【self-evolution-bot · 2026-11-21 · 第109轮 · 模型:deepseek-v4.1-flash-1017】
  // 改了什么：补两条「服务端已驱面板」的判据。
  // 为什么（用户 2026-11-21 点破）：「我在右侧面板手打能看到实时结果，你后台触发页面上啥也看不到。」
  //   现在 deliver="panel" 由服务端经 CDP 直接把面板 handleSend 驱起来（live SSE），
  //   前端必须**不再补发**；CDP 不可用时（panel_dispatch 空）前端必须补发，保住有来有回。
  it('服务端已驱动面板（panel_dispatch=pane-live）→ 前端不再补发，避免两遍', async () => {
    const { syncEmployeeChatSendFromToolResult } = await import(
      '../src/lib/employee-chat-send-sync.js'
    )
    await syncEmployeeChatSendFromToolResult(
      result({ queued: false, panel_delivery: true, panel_dispatch: 'pane-live' }),
    )

    const payload = openEmployeeProcessInRightStage.mock.calls[0][0]
    expect(payload.pendingSendMessage).toBeUndefined()
  })

  it('面板刚拉开排队首发（panel_dispatch=pending-open）→ 同样不再补发', async () => {
    const { syncEmployeeChatSendFromToolResult } = await import(
      '../src/lib/employee-chat-send-sync.js'
    )
    await syncEmployeeChatSendFromToolResult(
      result({ queued: false, panel_delivery: true, panel_dispatch: 'pending-open' }),
    )

    const payload = openEmployeeProcessInRightStage.mock.calls[0][0]
    expect(payload.pendingSendMessage).toBeUndefined()
  })

  // 【self-evolution-bot · 2026-11-22 · 第127轮 · 模型:deepseek-v4.1-flash】
  // 改了什么：补 `pending-open-switch` 用例。
  // 为什么（现网实证 22:01:57）：后端 mint 新会话 + panel_dispatch=pending-open-switch，
  //   前端漏认这个值 → 判成「面板没接管」→ 又补一条 pendingSend，同一句两条投递源。
  // 判据（可反证）：把 panelDroveIt 里的 pending-open-switch 去掉，本用例必红。
  it('会话切换排队（panel_dispatch=pending-open-switch）→ 前端不再补发', async () => {
    const { syncEmployeeChatSendFromToolResult } = await import(
      '../src/lib/employee-chat-send-sync.js'
    )
    await syncEmployeeChatSendFromToolResult(
      result({ queued: false, panel_delivery: true, panel_dispatch: 'pending-open-switch' }),
    )

    const payload = openEmployeeProcessInRightStage.mock.calls[0][0]
    expect(payload.pendingSendMessage).toBeUndefined()
  })

  it('CDP 不可用（panel_dispatch 空）→ 前端必须补发，否则用户什么都看不到', async () => {
    const { syncEmployeeChatSendFromToolResult } = await import(
      '../src/lib/employee-chat-send-sync.js'
    )
    await syncEmployeeChatSendFromToolResult(
      result({ queued: false, panel_delivery: true, panel_dispatch: '' }),
    )

    const payload = openEmployeeProcessInRightStage.mock.calls[0][0]
    expect(payload.pendingSendMessage).toBe('只回一句话')
  })
})
