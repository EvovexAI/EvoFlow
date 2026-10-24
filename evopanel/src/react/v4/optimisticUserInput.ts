/**
 * 发送瞬间：本地乐观用户气泡尚未进 V4 投影时，在时间线尾部补一行合成 userInput，
 * 避免为等 echo 整树切回老面板（会闪出整段本地历史用户消息）。
 */
import type {
  ConversationRow,
  UserInputRow,
} from '@zcode/shared/zcode-protocol-v4'

/** 与 chat-app-view 的 echo 判定一致：只看窗口尾部最近一条 userInput。 */
export function v4WindowHasUserText(
  rows: ReadonlyArray<{ kind?: string; text?: string }> | null | undefined,
  text: string,
): boolean {
  const needle = String(text || '').trim()
  if (!needle || !rows?.length) return false
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (String(row?.kind || '') !== 'userInput') continue
    const t = String(row?.text || '').trim()
    if (!t) return false
    return t === needle || t.endsWith(needle) || needle.endsWith(t)
  }
  return false
}

export function mergeOptimisticUserInputRow(
  rows: readonly ConversationRow[],
  text: string | null | undefined,
): readonly ConversationRow[] {
  const needle = String(text || '').trim()
  if (!needle) return rows
  if (v4WindowHasUserText(rows, needle)) return rows

  const now = Date.now()
  let maxRowId = 0
  for (const row of rows) {
    const id = Number(row.rowId) || 0
    if (id > maxRowId) maxRowId = id
  }

  const optimistic: UserInputRow = {
    rowId: maxRowId + 1,
    turnId: `optimistic-${now}`,
    kind: 'userInput',
    text: needle,
    origin: 'realUser',
    createdAt: now,
    createdAtSeq: 0,
  }
  return [...rows, optimistic]
}
