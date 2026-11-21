import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearEmployeePaneSenders,
  findEmployeePaneSender,
  registerEmployeePaneSender,
} from '../src/lib/right-stage/employee-pane-send-bridge.ts'

/**
 * 【self-evolution-bot · 2026-11-21 · 第109轮 · 模型:deepseek-v4.1-flash-1017】
 * 改了什么：新增员工面板发送桥的判据测试（纯 JS，.test.js 里不能写 TS 类型注解，
 *   否则 rollup 解析直接失败、整个文件 0 测试）。
 * 为什么（用户 2026-11-21 点破）：「我在右侧面板手打能看到实时结果，你后台触发页面上啥也
 *   看不到。」要「和手打一样」，发送动作必须发生在面板这一侧（live SSE）；服务端经
 *   `/main-cdp/action employeeChatSend` 找到本桥里的 handleSend 来驱动。
 *   桥找不到时**绝不能猜屏**——发给错的员工比不发更糟。
 * 判据（可反证）：把「多于一个同 code 就返回 null」改成返回第一个 → 第 3 条必须红。
 */

const SK_A = 'proactive:reviewer:chat:a'
const SK_B = 'proactive:reviewer:chat:b'

describe('employee-pane-send-bridge', () => {
  beforeEach(() => {
    clearEmployeePaneSenders()
  })

  it('按 agentCode + sessionKey 精确命中', () => {
    const sentA = []
    const sentB = []
    registerEmployeePaneSender({
      agentCode: 'reviewer',
      sessionKey: SK_A,
      send: (t) => sentA.push(t),
    })
    registerEmployeePaneSender({
      agentCode: 'reviewer',
      sessionKey: SK_B,
      send: (t) => sentB.push(t),
    })

    findEmployeePaneSender('reviewer', SK_A)('to-A')
    findEmployeePaneSender('reviewer', SK_B)('to-B')

    expect(sentA).toEqual(['to-A'])
    expect(sentB).toEqual(['to-B'])
  })

  it('会话键没回填时，同 code 只有一个面板 → 允许命中', () => {
    const sent = []
    registerEmployeePaneSender({
      agentCode: 'reviewer',
      sessionKey: '',
      send: (t) => sent.push(t),
    })

    findEmployeePaneSender('reviewer', SK_A)('hi')
    expect(sent).toEqual(['hi'])
  })

  it('同 code 有多个面板且会话键对不上 → 返回 null，绝不猜屏', () => {
    registerEmployeePaneSender({
      agentCode: 'reviewer',
      sessionKey: SK_A,
      send: () => {},
    })
    registerEmployeePaneSender({
      agentCode: 'reviewer',
      sessionKey: SK_B,
      send: () => {},
    })

    expect(findEmployeePaneSender('reviewer', 'proactive:reviewer:chat:c')).toBeNull()
  })

  it('注销只删自己那条，不误删新挂载', () => {
    const disposeOld = registerEmployeePaneSender({
      agentCode: 'reviewer',
      sessionKey: SK_A,
      send: () => {},
    })
    const sentNew = []
    registerEmployeePaneSender({
      agentCode: 'reviewer',
      sessionKey: SK_A,
      send: (t) => sentNew.push(t),
    })

    // 旧组件的清理函数晚到时，不许把新组件注册的 sender 删掉
    disposeOld()
    findEmployeePaneSender('reviewer', SK_A)('after-dispose')
    expect(sentNew).toEqual(['after-dispose'])
  })
})
