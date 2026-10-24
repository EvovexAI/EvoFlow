/**
 * Truncate transcript from a user message and re-send the edited draft.
 * Extracted from ChatApp.tsx (P51).
 */
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { toast } from '../../../components/toast.js'
import { toUserFacingError } from '../../../lib/user-facing-error.js'
import {
  commitActiveSessionRuntime,
  getSessionRuntime,
} from '../../lib/session-runtime-store.js'
import type { DisplayRow } from '../../chat-types.js'

export type HandleEditMessageCtx = {
  selectedSessionKey: string
  sessionRef: MutableRefObject<string>
  rowsRef: MutableRefObject<DisplayRow[]>
  seenRunIdsRef: MutableRefObject<Set<string>>
  activeChatRunIdRef: MutableRefObject<string | null>
  setRows: Dispatch<SetStateAction<DisplayRow[]>>
  handleSend: (
    text: string,
    attachments?: Array<{ mimeType: string; content: string }>,
  ) => Promise<unknown> | unknown
}

export async function handleEditMessage(
  ctx: HandleEditMessageCtx,
  text: string,
  messageId?: string,
  images?: Array<{ mediaType: string; data?: string; url?: string }>,
): Promise<void> {
  const draft = String(text || '').trim()
  const mid = String(messageId || '').trim()
  const key = String(ctx.selectedSessionKey || ctx.sessionRef.current || '').trim()
  if (!draft) return
  if (!key) {
    toast('当前没有选中会话', 'error')
    throw new Error('no session')
  }

  // 无 messageId：无法安全截断（历史行缺 id 时刷新后再试）
  if (!mid) {
    toast('无法定位该消息，请刷新会话后再编辑', 'error')
    throw new Error('missing messageId')
  }

  try {
    const { api } = await import('../../../lib/tauri-api.js')
    await api.chatSessionsTruncate(key, { fromMessageId: mid })

    // 同一会话内截掉该条及之后的 UI 行
    const prev = ctx.rowsRef.current || []
    let cutIdx = prev.findIndex((r) => String(r.messageId || '').trim() === mid)
    if (cutIdx < 0) {
      // 兜底：按正文匹配最近一条 user（编辑后文案可能已变，尽量用原 id）
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i]?.role !== 'user') continue
        if (String(prev[i]?.text || '').trim() === draft) {
          cutIdx = i
          break
        }
      }
    }
    if (cutIdx >= 0) {
      const next = prev.slice(0, cutIdx)
      ctx.rowsRef.current = next
      ctx.setRows(next)
      try {
        const rt = getSessionRuntime(key)
        commitActiveSessionRuntime(key, {
          rows: next,
          stream: rt.stream,
          seenRunIds: ctx.seenRunIdsRef.current,
          activeChatRunId: ctx.activeChatRunIdRef.current,
        })
      } catch {
        /* ignore */
      }
    }

    // 用编辑后的正文重新发送（不塞底部输入框）；带留存/新加的图片
    const attachments = (images || [])
      .filter((img) => img.data)
      .map((img) => ({ mimeType: img.mediaType || 'image/png', content: img.data! }))
    await ctx.handleSend(draft, attachments)
  } catch (e) {
    toast(toUserFacingError((e as Error)?.message || e || '编辑失败'), 'error')
    throw e
  }
}
