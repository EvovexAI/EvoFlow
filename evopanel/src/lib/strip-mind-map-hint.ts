/**
 * 后端在每次工具调用结果末尾追加形如 "\n\n[思维导图提示] ..." 的提醒文本（mind_map_hints.py）。
 * 这段是给调度模型看的内部提示，不应在用户可见的弹窗 / 详情区中显示。
 *
 * 这里提供统一的剥离函数：找到 [思维导图提示] 第一次出现的位置，丢弃从该位置直到字符串末尾的所有内容。
 */
const HINT_MARKER = '[思维导图提示]'

/** Leading ``[rg] /path/to/rg.exe`` binary banner from host-direct rg tool (not semantic notes). */
const RG_BINARY_BANNER_RE = /^\[rg\]\s+\S*(?:[/\\](?:rg|ripgrep)(?:\.exe)?)\s*$/i

export function stripRgBinaryBanner(text: string | null | undefined): string {
  if (text == null) return ''
  const lines = String(text).split('\n')
  if (lines.length > 0 && RG_BINARY_BANNER_RE.test(lines[0].trim())) {
    return lines.slice(1).join('\n').replace(/^\n+/, '')
  }
  return String(text)
}

/** User-visible tool output: drop rg binary banner and mind-map hints. */
export function stripToolOutputForDisplay(text: string | null | undefined): string {
  return stripMindMapHint(stripRgBinaryBanner(text))
}

export function stripMindMapHint(text: string | null | undefined): string {
  if (text == null) return ''
  const s = String(text)
  const idx = s.indexOf(HINT_MARKER)
  if (idx < 0) return s
  // 同时把紧挨在标记前的若干换行 / 空白也剥掉，避免末尾留一段空白
  let end = idx
  while (end > 0 && /\s/.test(s[end - 1])) end -= 1
  return s.slice(0, end)
}

/** 便利方法：用于可能为 undefined 的可选字段，保持原 undefined 语义 */
export function stripMindMapHintOpt(text: string | null | undefined): string | undefined {
  if (text == null) return undefined
  return stripMindMapHint(text)
}
