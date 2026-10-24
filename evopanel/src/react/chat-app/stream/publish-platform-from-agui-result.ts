/**
 * 从 AG-UI TOOL_CALL_RESULT 即时发布右上角「平台」通知。
 * 必须在 shouldApplyChatEvent gate 之前调用：V4 双 runId / sealing 期间
 * gate 常把 RESULT 整段丢掉，导致流式过程中平台通知不亮、刷新后才从 artifacts 出现。
 */
import { EventType } from '@ag-ui/core'
import {
  applyPlatformFeedbackFromToolResult,
  latestPlatformRunEntryId,
  parsePlatformUiFeedback,
  type PlatformRunEntry,
} from '../../../lib/right-stage/platform-feedback.js'

export type PublishPlatformFromAgUiResultCtx = {
  isBackground: boolean
  aguiEvent: { type?: unknown; toolCallId?: unknown; toolCallName?: unknown; content?: unknown }
  /** 当前会话 aguiTurn（可为空：工具名可从 event / content 兜底） */
  toolCallNameFromTurn?: string
  platformUiFromTurn?: Record<string, unknown> | null
  platformMetaFromTurn?: {
    platformOk?: boolean
    platformAction?: string
    platformItem?: unknown
    platformAgent?: unknown
    platformRole?: unknown
    platformSettings?: unknown
    platformClientEffect?: string
  } | null
  argsText?: string
  platformFeedbackSeenRef: { current: Set<string> }
  turnPlatformEntriesRef: { current: PlatformRunEntry[] }
  publishPlatformEntries: (entries: PlatformRunEntry[], focusEntryId?: string) => void
  toast: (message: string, kind?: string) => void
}

function rebuildContentFromPlatformUi(
  meta: PublishPlatformFromAgUiResultCtx['platformMetaFromTurn'],
  platformUi: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ok: meta?.platformOk !== false,
    action: meta?.platformAction,
    item: meta?.platformItem,
    agent: meta?.platformAgent,
    role: meta?.platformRole,
    settings: meta?.platformSettings,
    ui: platformUi,
    client_effect: meta?.platformClientEffect,
  }
}

function resolveResultContent(
  ctx: PublishPlatformFromAgUiResultCtx,
): unknown {
  const evContent = ctx.aguiEvent.content
  let resultContent: unknown =
    typeof evContent === 'string'
      ? evContent
      : evContent != null
        ? evContent
        : undefined

  const platformUi = ctx.platformUiFromTurn
  if (platformUi && typeof platformUi === 'object') {
    if (resultContent == null || resultContent === '') {
      return rebuildContentFromPlatformUi(ctx.platformMetaFromTurn, platformUi)
    }
    if (typeof resultContent === 'string') {
      try {
        const parsed = JSON.parse(resultContent) as Record<string, unknown>
        if (parsed && typeof parsed === 'object' && !parsed.ui) {
          return { ...parsed, ui: platformUi }
        }
      } catch {
        /* keep string */
      }
    }
  }
  return resultContent
}

/** @returns true 若已发布（或已见过） */
export function publishPlatformFromAgUiResult(ctx: PublishPlatformFromAgUiResultCtx): boolean {
  if (ctx.isBackground) return false
  const type = String(ctx.aguiEvent.type || '')
  if (type !== String(EventType.TOOL_CALL_RESULT) && type !== 'TOOL_CALL_RESULT') return false

  const toolCallId = String(ctx.aguiEvent.toolCallId || '').trim()
  if (!toolCallId) return false
  if (ctx.platformFeedbackSeenRef.current.has(toolCallId)) return true

  const toolName = String(
    ctx.toolCallNameFromTurn || ctx.aguiEvent.toolCallName || '',
  )
    .trim()
    .toLowerCase()

  const resultContent = resolveResultContent(ctx)
  // 工具名丢失时：只要 content 能解析出平台 ui 也发布
  if (toolName && toolName !== 'platform') return false
  if (!toolName) {
    if (!parsePlatformUiFeedback(resultContent, ctx.argsText)) return false
  }

  const feedback = applyPlatformFeedbackFromToolResult(resultContent, {
    argsText: ctx.argsText,
    toolCallId,
    existingEntries: ctx.turnPlatformEntriesRef.current,
    notifyEmployeesRoster: false,
  })
  if (!feedback) return false

  ctx.platformFeedbackSeenRef.current.add(toolCallId)
  ctx.publishPlatformEntries(feedback.entries, latestPlatformRunEntryId(feedback.entries))
  ctx.toast(
    feedback.ui.title,
    feedback.ui.kind === 'warning' ? 'warning' : feedback.ui.kind === 'error' ? 'error' : 'success',
  )
  return true
}
