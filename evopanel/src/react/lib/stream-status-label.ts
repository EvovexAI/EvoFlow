/** 流式状态行：去掉末尾 … / ... / ..，避免与动画点重复 */
export function normalizeStreamStatusLabel(label: string): string {
  return String(label || '')
    .replace(/(\.\.\.|…|\.\.)$/, '')
    .trim()
}
