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

/** 员工面板发送目标选择结果。 */
export type PaneSendTarget = {
  /** 允许直接调用面板 sender（否则必须走 pending-open 切会话）。 */
  useSender: boolean
  /** 走 pending-open 时要把消息排进哪个会话键。 */
  pendingSessionKey: string
  mode: 'pane-live' | 'pending-open' | 'pending-open-switch'
}

/**
 * 决定这条消息该由「面板当前 sender」发，还是先切/开会话再发。
 *
 * 【self-evolution-bot · 2026-11-22 · 第126轮 · 模型:deepseek-v4.1-flash】
 * 为什么单独抽出来：本轮现网实证（19:46:57 agent=case-fullstack-dev）——
 *   后端已按 busy 判据 mint 了新会话并把新键传进来，但面板挂的是旧的 busy 会话，
 *   `findEmployeePaneSenderEntry` exact 未命中 → `code-fallback` 拿到旧 sender，
 *   `sender(text)` 把话塞进了正在跑的旧会话（回执 `sessionKeyMatched=false`）。
 *   「派单开新对话」这条修复因此在面板路径上完全失效。
 * 判据（可反证）：
 *   · 请求键非空且命中面板键 → pane-live（直接用 sender）；
 *   · 请求键非空但**不同** → pending-open-switch（绝不 code-fallback 发送）；
 *   · 请求键为空（面板刚开、键未回填）→ 允许按 code 兜底 pane-live。
 */
export function decidePaneSendTarget(input: {
  requestedSessionKey: string
  /** 命中的面板 sender 真实会话键（未命中传空）。 */
  actualSessionKey: string
  /** exact = code+sk 命中；code-fallback = 仅按 code 命中；null = 没命中。 */
  matched: 'exact' | 'code-fallback' | null
  /** 回落打开面板时使用的会话键（通常是请求键）。 */
  fallbackSessionKey?: string
}): PaneSendTarget {
  const requested = String(input.requestedSessionKey || '').trim()
  const actual = String(input.actualSessionKey || '').trim()
  const fallback = String(input.fallbackSessionKey || requested || '').trim()
  if (!requested) {
    // 面板刚打开、键还没回填 → 只能按 code 兜底
    return {
      useSender: input.matched === 'exact' || input.matched === 'code-fallback',
      pendingSessionKey: actual || fallback,
      mode: 'pane-live',
    }
  }
  if (requested === actual) {
    return { useSender: true, pendingSessionKey: requested, mode: 'pane-live' }
  }
  // 键不一致：无论 matched 是 exact 还是 code-fallback，都不许把这条塞进旧会话。
  return { useSender: false, pendingSessionKey: requested, mode: 'pending-open-switch' }
}
