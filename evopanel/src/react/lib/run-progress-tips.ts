/**
 * 运行旁白 tip：挂在气泡底部 StreamRunStatusLine（生成中旁），不进 Agent 卡片顶栏。
 */

export const RUN_PROGRESS_TIPS: readonly string[] = [
  '小提示：越具体的需求，越容易一次做对。',
  '技巧：复杂任务可以拆成「先查再改、再验证」。',
  '冷知识：缓存命中多，往往说明上下文复用得很充分。',
  'Tips：中途可以继续补充约束，下一轮会接着用。',
  '小贴士：产物出来后，点侧栏里的「产物」能直接打开。',
  '技巧：需要改风格时，直接说「更短 / 更正式 / 更口语」。',
  '冷知识：工具调用越多，不代表越慢——有时是在避免胡猜。',
  'Tips：卡住时，把期望结果和反例一起说清楚会更快。',
  '小提示：长文生成前，先约定结构，返工会少很多。',
  '冷知识：输入 Token 常比输出大——模型先读懂再动手。',
  'Tips：并行子任务跑的时候，主线仍在协调结果。',
  '小贴士：盯着步骤勾选，就能跟上当前在干什么。',
  '技巧：同一会话里上下文会累积，换话题可开新对话。',
  '冷知识：滚动的 Token 数字来自本轮模型调用的累计用量。',
]

/** 按墙上时钟取稳定 tip，便于轮播间隔内不抖。 */
export function pickRunProgressTip(atMs = Date.now(), intervalMs = 9000): string {
  const list = RUN_PROGRESS_TIPS
  if (!list.length) return ''
  const idx = Math.floor(Math.max(0, atMs) / Math.max(1000, intervalMs)) % list.length
  return list[idx] || list[0]
}
