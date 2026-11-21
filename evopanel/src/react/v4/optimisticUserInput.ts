/**
 * 发送瞬间：本地乐观用户气泡尚未进 V4 投影时，在时间线尾部补一行合成 userInput，
 * 避免为等 echo 整树切回老面板（会闪出整段本地历史用户消息）。
 *
 * 文案优先来自 host 的 pendingOptimisticUserText（轻量 flushSync），
 * 不要依赖同帧 setRows(全量历史)——那会重建 ConversationTimeline。
 *
 * 权威投影一旦出现同文案 userInput，必须清掉 pendingOptimisticUserText，
 * 否则 turn 结束后 pending 仍在，空 stub / 重连窗口会让乐观行再次叠上去 → 双份气泡。
 *
 * 2026-11-21（对齐 ZCode sourceCommandId 认领语义）：echo/认领从「文本 endsWith 匹配」
 * 升级为 **entityId(messageId) 精确匹配优先**。链路：handle-send 生成稳定
 * optimisticMessageId → chatSend opts（LangGraph input 消息 id + transcript message_id，
 * 同一 id）→ mirror 的 userInput 行 entityId（404 remint 去重也认它）→ 投影行回带。
 * 文本匹配降级为无 id 场景（旧客户端 / IM 渠道）的兜底——文本匹配在长回合把 userInput
 * 挤出尾窗后 echo 永不命中，乐观行会叠挂（2026-11-08 实锤）。
 */
import type {
  ConversationRow,
  UserInputRow,
} from '@zcode/shared/zcode-protocol-v4'
import { logChatTurnUserBubbleVisible } from '../lib/chat-turn-timing-log.js'

/** 在途发送的稳定消息 id（按会话键，发送即覆写；不清理——echo 判定先看文本非空才用）。 */
const pendingMessageIdBySession = new Map<string, string>()

export function setPendingOptimisticMessageId(sessionKey: string | null | undefined, messageId: string): void {
  const sk = String(sessionKey || '').trim()
  const mid = String(messageId || '').trim()
  if (!sk || !mid) return
  pendingMessageIdBySession.set(sk, mid)
}

export function getPendingOptimisticMessageId(sessionKey: string | null | undefined): string {
  const sk = String(sessionKey || '').trim()
  if (!sk) return ''
  return pendingMessageIdBySession.get(sk) || ''
}

export function clearPendingOptimisticMessageId(sessionKey: string | null | undefined): void {
  const sk = String(sessionKey || '').trim()
  if (!sk) return
  pendingMessageIdBySession.delete(sk)
}

/** 窗口内是否存在 entityId（message_id）精确命中的 realUser 行——认领的正路。 */
export function v4WindowHasUserMessageId(
  rows: ReadonlyArray<{ kind?: string; origin?: string; entityId?: string }> | null | undefined,
  messageId: string | null | undefined,
): boolean {
  const mid = String(messageId || '').trim()
  if (!mid || !rows?.length) return false
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (String(row?.kind || '') !== 'userInput') continue
    if (String(row?.origin || '') !== 'realUser') continue
    if (String(row?.entityId || '').trim() === mid) return true
  }
  return false
}

/** 与 chat-app-view 的 echo 判定一致：entityId 精确匹配优先，回退文本匹配（只看尾部最近一条非空 userInput）。 */
export function v4WindowHasUserText(
  rows: ReadonlyArray<{ kind?: string; text?: string; origin?: string; entityId?: string }> | null | undefined,
  text: string,
  messageId?: string | null,
): boolean {
  if (v4WindowHasUserMessageId(rows, messageId)) return true
  const mid = String(messageId || '').trim()
  const needle = String(text || '').trim()
  if (!needle || !rows?.length) return false
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (String(row?.kind || '') !== 'userInput') continue
    // 在途消息 id 在场时：带**不同** entityId 的行明确属于其他消息——即使文本相同也不认领
    // （同文案二次发送实锤场景）；文本兜底只认无 entityId 的行（IM/旧路径）。
    if (mid && String(row?.entityId || '').trim()) continue
    const t = String(row?.text || '').trim()
    // 空 userInput（纯附件占位 / 未填完 stub）不能否决 echo，否则乐观气泡会叠在真消息上。
    if (!t) continue
    return t === needle || t.endsWith(needle) || needle.endsWith(t)
  }
  return false
}

export function mergeOptimisticUserInputRow(
  rows: readonly ConversationRow[],
  text: string | null | undefined,
  messageId?: string | null,
): readonly ConversationRow[] {
  const needle = String(text || '').trim()
  if (!needle) return rows
  if (v4WindowHasUserText(rows, needle, messageId)) return rows

  const now = Date.now()
  let maxRowId = 0
  for (const row of rows) {
    const id = Number(row.rowId) || 0
    if (id > maxRowId) maxRowId = id
  }

  const mid = String(messageId || '').trim()
  const optimistic: UserInputRow = {
    rowId: maxRowId + 1,
    turnId: `optimistic-${now}`,
    kind: 'userInput',
    text: needle,
    origin: 'realUser',
    createdAt: now,
    createdAtSeq: 0,
    ...(mid ? { entityId: mid } : {}),
  } as UserInputRow
  // 乐观气泡真正并入时间线 = 用户可见上屏（计时表「出泡」列）
  try {
    logChatTurnUserBubbleVisible()
  } catch {
    /* overlay timing only */
  }
  return [...rows, optimistic]
}
