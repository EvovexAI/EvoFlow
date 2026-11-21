/**
 * 员工对话面板「直接发送」桥。
 *
 * 为什么需要它（用户 2026-11-21 第 109 轮点破）：
 * 「我在右侧面板手打消息，能看到实时结果；你后台触发，页面上啥也看不到。」
 * 用户在面板里手打走的是 ChatApp 的 chatSend（live SSE，逐字流）。平台工具
 * employees.chat_send 走 wake 是后台轮次，没有 SSE，只能等整轮跑完轮询快照。
 *
 * 所以工具侧要能**直接驱动面板自己发**：`/main-cdp/action employeeChatSend`
 * → 本桥 → 面板 handleSend → api.chatSend → live SSE。
 *
 * 面板挂载时注册，卸载时注销；未注册（面板没开）时调用方回落到
 * `openEmployeeProcessInRightStage({pendingSendMessage})` 打开面板再发。
 */

/** 【self-evolution-bot · 2026-11-21 · 第109轮 · 模型:deepseek-v4.1-flash-1017】 */
/** 返回 false = 面板没接住（忙/不可用），调用方不得当作已送达。 */
export type EmployeePaneSender = (text: string) => boolean | Promise<boolean> | void

type Entry = {
  code: string
  sessionKey: string
  send: EmployeePaneSender
  at: number
}

const senders = new Map<string, Entry>()

function norm(v: unknown): string {
  return String(v ?? '').trim()
}

function keyOf(code: string, sessionKey: string): string {
  return `${norm(code).toLowerCase()}||${norm(sessionKey)}`
}

/**
 * 注册当前面板的发送函数。返回注销函数。
 * 同一 key 被新挂载覆盖（React StrictMode 双挂载 / 换会话都不应留旧引用）。
 */
export function registerEmployeePaneSender(params: {
  agentCode: string
  sessionKey: string
  send: EmployeePaneSender
}): () => void {
  const code = norm(params.agentCode)
  const sessionKey = norm(params.sessionKey)
  if (!code) return () => {}
  const key = keyOf(code, sessionKey)
  const entry: Entry = { code, sessionKey, send: params.send, at: Date.now() }
  senders.set(key, entry)
  return () => {
    // 只删「还是我自己」的那条，避免新挂载被旧的注销函数误删
    if (senders.get(key) === entry) senders.delete(key)
  }
}

/**
 * 找面板发送函数。
 * 先按 code+sessionKey 精确命中；没有再按 code 找**唯一**一个（面板刚打开、
 * 会话键还没回填时用），多于一个就放弃——宁可回落 pendingSend，也不猜错屏。
 */
export function findEmployeePaneSender(
  agentCode: string,
  sessionKey?: string,
): EmployeePaneSender | null {
  const code = norm(agentCode).toLowerCase()
  const sk = norm(sessionKey)
  if (!code) return null
  const exact = senders.get(keyOf(code, sk))
  if (exact) return exact.send
  const sameCode = Array.from(senders.values()).filter(
    (e) => e.code.toLowerCase() === code,
  )
  if (sameCode.length === 1) return sameCode[0].send
  return null
}

export function clearEmployeePaneSenders(): void {
  senders.clear()
}
