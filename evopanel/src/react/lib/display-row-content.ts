/**
 * DisplayRow 内容可见性判定。
 *
 * 从 ChatApp.tsx 抽离：Stream 域与 Row 域共用，故独立成共享模块以避免互相 import 成环。
 */
import type { DisplayRow } from '../chat-types.js'

/** 行是否有任何可见产出（正文 / 工具 / 媒体）。空串与空数组均不算。 */
export function rowHasVisibleContent(row: DisplayRow | undefined): boolean {
  if (!row) return false
  if (String(row.text || '').trim()) return true
  if ((row.tools || []).length) return true
  if ((row.images || []).length) return true
  if ((row.videos || []).length) return true
  if ((row.audios || []).length) return true
  if ((row.files || []).length) return true
  return false
}
