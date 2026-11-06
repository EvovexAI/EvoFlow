/**
 * 群聊嵌套 @ 接力策略：防「打个招呼」被互相点名拖成死循环。
 *
 * - 寒暄类：同一轮 root 下每人最多叫醒一次
 * - 真派活：允许同人再被叫醒（招呼打完还能接任务）
 * - 成员（depth≥1）回复里的寒暄/@报到 不再自动接力
 */

/** 本轮防重键 */
export function deptGroupWakeChainKey(
  rootMsgId: string,
  targetAgentCode: string,
  opts?: { fromAgentCode?: string; goal?: string },
): string {
  const root = String(rootMsgId || '').trim() || 'root'
  const code = String(targetAgentCode || '').trim()
  const goal = String(opts?.goal || '').trim()
  // 真派活：不与寒暄占坑互相挡；同 from→to + 目标摘要 去重即可
  if (goal && !isTrivialGroupNestGoal(goal)) {
    const from = String(opts?.fromAgentCode || '').trim() || 'any'
    const g = goal.replace(/\s+/g, ' ').slice(0, 48).toLowerCase()
    return `${root}|work|${from}->${code}|${g}`
  }
  return `${root}|->${code}`
}

/**
 * 寒暄 / 报到 / 「你也出来说句话」类目标：不应再自动叫醒。
 * 含明确派活动词时放行。
 */
export function isTrivialGroupNestGoal(goal: string): boolean {
  const raw = String(goal || '').trim()
  if (!raw) return true
  const t = raw.replace(/\s+/g, '')

  // 明确派活 → 允许嵌套
  if (
    /请?(帮)?(我)?(去)?(改|修|查|做|写|补|实现|排查|交付|跟进|接手|处理|推进|评估|设计|联调|上线|发布|评审|返工|验收)/.test(
      t,
    )
  ) {
    return false
  }
  if (/任务|bug|缺陷|需求|方案|接口|PR|合并|部署|上线|deadline|截止|校验|持久化|localStorage/.test(t)) {
    return false
  }

  if (
    t.length <= 36 &&
    /^(收到|好的|嗯|明白了?|OK|ok)[!！。.~]*$/i.test(t)
  ) {
    return true
  }
  // 「在」「在呢」「在的」可叠说（在呢在呢）
  if (t.length <= 24 && /^(在的?|在呢?)+[!！。.~]*$/.test(t)) {
    return true
  }
  if (
    /打个招呼|打声招呼|回个话|回一声|出来回|出来说句话|报个到|说句你好|跟大家问个好|跟老板打个招呼|简单打个招呼/.test(
      t,
    )
  ) {
    return true
  }
  // 「老板找你 / 在这儿吗」类点名报到，且无明显派活
  if (/老板找你|在这儿吗|在吗|露个面/.test(t) && t.length < 80) {
    return true
  }
  // 「在群里回个话」且无明显派活
  if (/回个话|说句话|露个面/.test(t) && t.length < 100) {
    return true
  }
  return false
}

/** depth≥1 的成员回复：寒暄类 @ 不接力；depth=0（管家首轮分流）仍可 @ 多人 */
export function shouldAutoNestWake(opts: {
  fromDepth: number
  goal: string
}): boolean {
  if (opts.fromDepth >= 1 && isTrivialGroupNestGoal(opts.goal)) return false
  return true
}
