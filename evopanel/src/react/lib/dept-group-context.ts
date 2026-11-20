/**
 * 部门群聊「群近期发言」上下文组装：按 **token 预算**裁剪，不按条数、不按天。
 *
 * 【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
 *
 * 为什么改：原实现是写死的 `slice(-8)` + 每条 `slice(0,240)`（HomeDeptGroupChat）。
 * 条数上限和真实上下文压力无关——8 条长的和 8 条短的差好几倍 token，
 * 而观众/用户看到的是「忽然不记得刚才说的话」或「莫名带上很久以前的旧话」。
 *
 * 用户 2026-11-20 明确：**不按天翻篇**。因此判据统一成 token 预算：
 * 从最新一条往前累加，超预算就停，拿到的正好是「最近且装得下的那几条」。
 */

/** 粗估 token：CJK 每字约 1 token，其余约 4 字符 1 token。 */
export function estimateTokens(text: string): number {
  const s = String(text || '')
  if (!s) return 0
  let cjk = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    if (
      (c >= 0x3000 && c <= 0x303f) || // CJK 标点
      (c >= 0x3400 && c <= 0x4dbf) || // 扩展 A
      (c >= 0x4e00 && c <= 0x9fff) || // 基本区
      (c >= 0xff00 && c <= 0xffef) // 全角
    ) {
      cjk += 1
    }
  }
  const rest = Math.max(0, [...s].length - cjk)
  return cjk + Math.ceil(rest / 4)
}

export type DeptGroupContextMsg = {
  kind: string
  text?: string
  agentName?: string
  agentCode?: string
  streaming?: boolean
}

export type BuildRecentGroupContextOpts = {
  /** token 预算，默认 2000（与原 L1 设计值一致） */
  budgetTokens?: number
  /** 单条最多保留多少字符，默认 240（沿用原实现，防单条长文吃掉全部预算） */
  perMsgCap?: number
  /** 最多回溯多少条（防极端情况下扫全表），默认 120 */
  maxScan?: number
}

/**
 * 从最新往前累加组装「群近期发言」，直到 token 预算用完。
 *
 * 与旧的 `slice(-8)` 相比：
 * - 短消息多带几条（信息更全），长消息少带（不撑爆）；
 * - 总量有上界，且上界与真实压力同量纲（token），不是与压力无关的条数。
 */
export function buildRecentGroupContext(
  msgs: DeptGroupContextMsg[],
  opts?: BuildRecentGroupContextOpts,
): string {
  const budget = Math.max(1, opts?.budgetTokens ?? 2000)
  const perMsgCap = Math.max(1, opts?.perMsgCap ?? 240)
  const maxScan = Math.max(1, opts?.maxScan ?? 120)
  const list = Array.isArray(msgs) ? msgs : []
  const picked: string[] = []
  let used = 0
  let scanned = 0
  for (let i = list.length - 1; i >= 0 && scanned < maxScan; i -= 1) {
    const m = list[i]
    if (!m || m.kind === 'system' || m.streaming) continue
    const text = String(m.text || '').trim()
    if (!text) continue
    scanned += 1
    const who = m.kind === 'user' ? '用户' : String(m.agentName || m.agentCode || '成员')
    const line = `${who}：${text.slice(0, perMsgCap)}`
    const cost = estimateTokens(line) + 1 // +1 换行
    if (used + cost > budget) break
    used += cost
    picked.push(line)
  }
  return picked.reverse().join('\n')
}
