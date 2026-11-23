/**
 * 员工对话面板「平台排队首条消息」（pendingSendMessage）的准入判据。
 *
 * 【self-evolution-bot · 2026-11-22 · 第127轮 · 模型:deepseek-v4.1-flash】
 * 改了什么：把原先散在 `V4EmployeeProcessPane` effect 里的 if 链抽成纯函数 + 一个在途登记表。
 * 为什么（现网实证 2026-11-22 22:01:57，agent=case-fullstack-dev）：
 *   后端 busy 判据已正确 mint 新会话、CDP 也回了 `pending-open-switch`，
 *   右栏按流程开了签、把这句话写进了 tab data —— 但**全库 grep 那句话 0 条**。
 *   消息不是「发错地方」，是**根本没发**：面板当时 `sending=true`（上一轮还在流式），
 *   旧 effect 第一句 `if (sending) return` 既不排队也不留痕；随后签被重开、
 *   tab data 里的 pendingSendMessage 被覆盖 → 这句话彻底消失。
 *
 * 旧代码还有第二处结构缺陷：**先 `clearEmployeeProcessPendingSend` 再 `handleSend`**，
 * 一旦发送失败（会话解析失败 / 网络错），消息已被清空、无重试、无留痕。
 *
 * 判据（只回答「该不该发」，不负责副作用）：
 * - 面板自己正忙（sending=true）→ `hold`：**不许消费**（不写已发标记、不清 tab data）。
 *   `sending` 翻回 false 时 effect 依赖变化会重跑，那时再发。
 * - 同一句已经成功发过 → `already-sent`；同一句另有实例正在发 → `in-flight`。
 *   后者用模块级登记表兜住「发送途中换签 / 重挂载」导致的重复发送
 *   （实例内的 ref 在重挂载后就没了，所以不能只靠 ref）。
 * - 只有 `send` 分支允许清 tab data，且必须在**发送成功之后**。
 */

/** 同一句 pending 的幂等键：员工 + 目标会话 + 正文。 */
export function pendingSendDedupeKey(input: {
  agentCode?: string | null
  sessionKey?: string | null
  text?: string | null
}): string {
  const code = String(input.agentCode ?? '').trim()
  const sk = String(input.sessionKey ?? '').trim()
  const text = String(input.text ?? '').trim()
  if (!code && !sk && !text) return ''
  return `${code}||${sk}||${text}`
}

/**
 * 在途登记（模块级，跨重挂载）：key = dedupeKey。
 * 只在「真开始发」到「发完（成败皆算）」之间占用，**不**记「已发过」——
 * 因为「已发过」只对同一个面板实例有意义，跨实例记会吞掉用户稍后重发的同一句话。
 */
const inflightKeys = new Set<string>()

/** 占坑。返回 false 表示别的实例正在发同一句，调用方必须放弃（不得清 tab data）。 */
export function markPendingSendInflight(dedupeKey: string): boolean {
  const key = String(dedupeKey || '').trim()
  if (!key) return true
  if (inflightKeys.has(key)) return false
  inflightKeys.add(key)
  return true
}

export function clearPendingSendInflight(dedupeKey: string): void {
  const key = String(dedupeKey || '').trim()
  if (key) inflightKeys.delete(key)
}

/** 仅测试用：清空在途登记，避免用例之间串味。 */
export function __resetPendingSendInflightForTests(): void {
  inflightKeys.clear()
}

export type PendingSendDecision =
  | { action: 'send'; dedupeKey: string }
  | { action: 'hold'; reason: 'session-busy'; dedupeKey: string }
  | { action: 'skip'; reason: 'empty' | 'no-agent' | 'already-sent' | 'in-flight' }

export function decidePendingSend(input: {
  pendingText?: string | null
  agentCode?: string | null
  sessionKey?: string | null
  /** 本实例上一次**成功**发送的 dedupe 键。 */
  sentKey?: string | null
  /** 面板这一侧是否正忙（sending=true / 上一轮流式未结束）。 */
  sessionBusy?: boolean
}): PendingSendDecision {
  const text = String(input.pendingText ?? '').trim()
  const code = String(input.agentCode ?? '').trim()
  if (!text) return { action: 'skip', reason: 'empty' }
  if (!code) return { action: 'skip', reason: 'no-agent' }
  const dedupeKey = pendingSendDedupeKey({
    agentCode: code,
    sessionKey: input.sessionKey,
    text,
  })
  const sentKey = String(input.sentKey ?? '').trim()
  if (sentKey && sentKey === dedupeKey) {
    return { action: 'skip', reason: 'already-sent' }
  }
  if (inflightKeys.has(dedupeKey)) {
    return { action: 'skip', reason: 'in-flight' }
  }
  // 忙时必须 hold（不能 skip）：skip 会把这句话丢掉，hold 会在 sending 变 false 后重试。
  if (input.sessionBusy) return { action: 'hold', reason: 'session-busy', dedupeKey }
  return { action: 'send', dedupeKey }
}
