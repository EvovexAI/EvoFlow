/**
 * LEGACY / AG-UI 热路径：从 TOOL_CALL_RESULT 发右上角「平台」toast +（可选）autoOpen。
 *
 * ⚠️ 默认产品聊天是 V4 时间线。工作流侧栏 autoOpen 的权威入口在：
 *   `zcode-ui/v4/ConversationTurnGroup.tsx` → `applyV4PlatformProgressAutoOpen`
 * 修「workflow.run 侧栏没开」请先改 V4 + `agui_mirror._platform_ui_display_block`，
 * 不要只改本文件以为就够了。
 *
 * 本文件仍保留：V4 闸门下 TOOL_CALL_RESULT 仍放行，双轨要同步 toast / seen；
 * 必须在 shouldApplyChatEvent gate 之前调用，否则 sealing 期间 RESULT 被丢掉。
 */
import { EventType } from '@ag-ui/core'
import {
  applyPlatformFeedbackFromToolResult,
  latestPlatformRunEntryId,
  maybeAutoOpenPlatformProgress,
  parsePlatformUiFeedback,
  type PlatformRunEntry,
} from '../../../lib/right-stage/platform-feedback.js'

export type PublishPlatformFromAgUiResultCtx = {
  isBackground: boolean
  aguiEvent: {
    type?: unknown
    toolCallId?: unknown
    toolCallName?: unknown
    content?: unknown
    platform_ui?: unknown
  }
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

function peekClientEffect(raw: unknown): string {
  if (!raw) return ''
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return String((raw as Record<string, unknown>).client_effect || '').trim()
  }
  if (typeof raw === 'string') {
    try {
      const o = JSON.parse(raw)
      return o && typeof o === 'object' ? String(o.client_effect || '').trim() : ''
    } catch {
      return ''
    }
  }
  return ''
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

  const wireUi =
    ctx.aguiEvent.platform_ui && typeof ctx.aguiEvent.platform_ui === 'object'
      ? (ctx.aguiEvent.platform_ui as Record<string, unknown>)
      : null
  const platformUi =
    (ctx.platformUiFromTurn && typeof ctx.platformUiFromTurn === 'object'
      ? ctx.platformUiFromTurn
      : null) || wireUi
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

  // 已见过（常见：tools-scan 先标 seen）：仍尝试 autoOpen，避免侧栏永远不开
  if (ctx.platformFeedbackSeenRef.current.has(toolCallId)) {
    const ui =
      parsePlatformUiFeedback(resultContent, ctx.argsText) ||
      (ctx.platformUiFromTurn && typeof ctx.platformUiFromTurn === 'object'
        ? parsePlatformUiFeedback(
            rebuildContentFromPlatformUi(ctx.platformMetaFromTurn, ctx.platformUiFromTurn),
            ctx.argsText,
          )
        : null)
    maybeAutoOpenPlatformProgress(ui)
    return true
  }

  // roster 可关（避免与 tools-scan 双刷）；chat_send 必须开，否则右栏只有空壳 ui.show
  const feedback = applyPlatformFeedbackFromToolResult(resultContent, {
    argsText: ctx.argsText,
    toolCallId,
    existingEntries: ctx.turnPlatformEntriesRef.current,
    notifyEmployeesRoster: false,
    syncEmployeeChatSend: true,
  })
  if (!feedback) {
    // chat_send 可能只有 client_effect、无 parseable ui：sync 已在上面跑过
    const effect = peekClientEffect(resultContent)
    if (effect === 'employee_chat_send') {
      ctx.platformFeedbackSeenRef.current.add(toolCallId)
      return true
    }
    return false
  }

  ctx.platformFeedbackSeenRef.current.add(toolCallId)
  ctx.publishPlatformEntries(feedback.entries, latestPlatformRunEntryId(feedback.entries))
  ctx.toast(
    feedback.ui.title,
    feedback.ui.kind === 'warning' ? 'warning' : feedback.ui.kind === 'error' ? 'error' : 'success',
  )
  // workflow.run / resume / recover：结果一到就拉开右栏工作流，不必再调 ui.show
  maybeAutoOpenPlatformProgress(feedback.ui)
  return true
}
