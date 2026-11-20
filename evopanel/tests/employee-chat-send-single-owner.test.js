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
})
