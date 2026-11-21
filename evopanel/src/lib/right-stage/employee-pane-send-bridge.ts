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
 * 找面板发送函数**及其真实会话键**。
 * 先按 code+sessionKey 精确命中；没有再按 code 找**唯一**一个（面板刚打开、
 * 会话键还没回填时用），多于一个就放弃——宁可回落 pendingSend，也不猜错屏。
 *
 * 【self-evolution-bot · 2026-11-21 · 第112轮 · 模型:deepseek-v4.1-flash-1017】
 * 改了什么：返回整个 Entry（含面板真实 sessionKey / matched 命中方式），
 *   不再只回 send；旧的 findEmployeePaneSender 保留为薄包装。
 * 为什么（本轮真机实测）：给 dev-fullstack 发消息，工具回执写
 *   `session_key=proactive:dev-fullstack:chat:dept-4de7e33a602b`（服务端算出来的），
 *   但面板那个签实际挂在 `chat:2026-11-21T13-20-20.208Z` —— 桥走的是「按 code 兜底」
 *   那一支，消息真落进了面板的会话。回执却回显了**传进来的** sk，等于说 A 做 B。
 *   用户照回执的 sk 去查，读到的是另一条（或空）会话。
 * 判据：回执的 session_key 必须是**实际发送者**的 sk；不一致时必须显式暴露，
 *   不许拿意图值冒充事实。
 */
export type EmployeePaneSenderHit = {
  send: EmployeePaneSender
  /** 面板此刻真实使用的会话键（可能就是传入值，也可能是兜底命中的那一个）。 */
  sessionKey: string
  /** exact = code+sk 精确命中；code-fallback = 按 code 唯一兜底。 */
  matched: 'exact' | 'code-fallback'
}

export function findEmployeePaneSenderEntry(
  agentCode: string,
  sessionKey?: string,
): EmployeePaneSenderHit | null {
  const code = norm(agentCode).toLowerCase()
  const sk = norm(sessionKey)
  if (!code) return null
  const exact = senders.get(keyOf(code, sk))
  if (exact) return { send: exact.send, sessionKey: exact.sessionKey, matched: 'exact' }
  const sameCode = Array.from(senders.values()).filter(
    (e) => e.code.toLowerCase() === code,
  )
  if (sameCode.length === 1) {
    return { send: sameCode[0].send, sessionKey: sameCode[0].sessionKey, matched: 'code-fallback' }
  }
  return null
}

/** 兼容旧调用：只取发送函数。 */
export function findEmployeePaneSender(
  agentCode: string,
  sessionKey?: string,
): EmployeePaneSender | null {
  return findEmployeePaneSenderEntry(agentCode, sessionKey)?.send ?? null
}

export function clearEmployeePaneSenders(): void {
  senders.clear()
}
