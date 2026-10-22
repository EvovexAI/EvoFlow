/**
 * Composer prompt enhance via wsClient.
 * Extracted from ChatApp.tsx (P20).
 */
import type { MutableRefObject } from 'react'
import { toast } from '../../../components/toast.js'
import { toUserFacingError } from '../../../lib/user-facing-error.js'
import { recentTranscriptForPromptEnhance } from '../utils/transcript-rows.js'
import type { DisplayRow } from '../../chat-types.js'

export type HandleEnhancePromptCtx = {
  rowsRef: MutableRefObject<DisplayRow[]>
  effectiveModelName: string | null | undefined
  selectedSessionKey: string
  sessionRef: MutableRefObject<string>
  enhancePrompt: (
    text: string,
    model?: string,
    recent?: unknown,
    sessionKey?: string,
  ) => Promise<{ text?: string }>
}

export async function handleEnhancePrompt(
  ctx: HandleEnhancePromptCtx,
  draft: string,
): Promise<string | null> {
  const text = String(draft || '').trim()
  if (!text) return null
  const recent = recentTranscriptForPromptEnhance(ctx.rowsRef.current)
  try {
    const { text: enhanced } = await ctx.enhancePrompt(
      text,
      ctx.effectiveModelName || undefined,
      recent.length ? recent : undefined,
      ctx.selectedSessionKey || ctx.sessionRef.current || undefined,
    )
    const next = String(enhanced || '').trim()
    if (!next || next === text) {
      toast('提示词已足够清晰', 'info')
      return text
    }
    toast('已优化提示词', 'success')
    return next
  } catch (err) {
    const e = err as Error & { status?: number }
    const msg = String(e?.message || err || '优化失败').toLowerCase()
    if (e?.status === 404 || msg.includes('not found')) {
      toast('提示词优化功能暂不可用，请稍后重试', 'error')
    } else {
      toast(toUserFacingError(e?.message || err, '优化失败，请稍后重试'), 'error')
    }
    return null
  }
}
