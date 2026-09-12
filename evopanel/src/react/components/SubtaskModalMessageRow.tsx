/**
 * 子任务详情弹窗消息行：复用主会话 MessageRow（工具折叠 / 时间线），
 * 仅对无 segments 的纯流式文本做换行合并，避免一字一行。
 */
import { flattenStreamDisplayText, normalizeTime, assistantBodiesLooselySame } from '../../lib/chat-normalize.js'
import {
  joinTextContentParts,
  normalizeSubtaskResultForDisplay,
} from '../../lib/subtask-result-display.js'
import type { DisplayRow } from '../chat-types.js'
import { ensureSubtaskRowSegments, rowHasStructuredTimeline } from '../../lib/subtask-modal-rows.js'
import { MessageRow } from './MessageRow.js'

export type SubtaskModalRow = {
  role?: string
  text?: string
  tools?: unknown[]
  segments?: unknown[]
  timestamp?: number | string
}

/** 合并 row.text + segments 内所有 text 段并修复流式换行（相同正文不重复拼接） */
export function prepareSubtaskModalDisplayText(row: SubtaskModalRow | null | undefined): string {
  if (!row) return ''
  const rawText = String(row.text || '')
  const fromSeg = flattenStreamDisplayText(row.segments as Parameters<typeof flattenStreamDisplayText>[0], '')
  if (rawText && fromSeg && assistantBodiesLooselySame(rawText, fromSeg)) {
    const prefer = fromSeg.length >= rawText.length ? fromSeg : rawText
    return normalizeSubtaskResultForDisplay(prefer).trim()
  }
  return normalizeSubtaskResultForDisplay(joinTextContentParts([rawText, fromSeg])).trim()
}

function toDisplayRow(row: SubtaskModalRow): DisplayRow {
  const roleRaw = String(row?.role || '').trim()
  const role: DisplayRow['role'] =
    roleRaw === 'user' ? 'user' : roleRaw === '_stream' ? '_stream' : 'assistant'
  const hasTimeline = rowHasStructuredTimeline(row)
  const ts = normalizeTime(row.timestamp)
  let text = hasTimeline ? String(row.text || '') : prepareSubtaskModalDisplayText(row)
  let segments = hasTimeline ? (row.segments as DisplayRow['segments']) : undefined
  // Structured timeline already carries text segments — drop mirrored row.text.
  if (hasTimeline && text && Array.isArray(segments) && segments.length) {
    const fromSeg = flattenStreamDisplayText(segments as Parameters<typeof flattenStreamDisplayText>[0], '')
    if (fromSeg && assistantBodiesLooselySame(text, fromSeg)) text = ''
  }
  const base: DisplayRow = {
    ...(row as DisplayRow),
    role,
    text,
    segments,
    tools: Array.isArray(row.tools) ? row.tools : undefined,
    timestamp: typeof ts === 'number' ? ts : undefined,
  }
  return ensureSubtaskRowSegments(base) as DisplayRow
}

export function SubtaskModalMessageRow({
  row,
  sessionKey,
  isStreaming = false,
  hideMetaTime = false,
  showToolTiming = false,
  suppressExploringFold = false,
  onOpenWorkspaceFile,
}: {
  row: SubtaskModalRow
  /** 工具详情懒加载用会话标识 */
  sessionKey?: string
  isStreaming?: boolean
  /** 外层已画左侧时钟时，隐藏气泡下的时间 */
  hideMetaTime?: boolean
  /** 工具行展示绝对时间（工作轨迹） */
  showToolTiming?: boolean
  /** 工作轨迹：不包 Exploring/Explored */
  suppressExploringFold?: boolean
  onOpenWorkspaceFile?: (rawPath: string, displayName?: string) => void
}) {
  const role = String(row?.role || '').trim()
  if (role !== 'user' && role !== 'assistant' && role !== '_stream') return null

  const displayRow = toDisplayRow(row)
  const hasText = String(displayRow.text || '').trim().length > 0
  const hasTimeline =
    rowHasStructuredTimeline(row) ||
    (Array.isArray(displayRow.segments) && displayRow.segments.length > 0)
  if (!hasText && !hasTimeline) return null

  return (
    <div
      className={
        hideMetaTime || suppressExploringFold
          ? `pro-trail-msg-hide-meta-time${suppressExploringFold ? ' pro-trail-msg-flat-tools' : ''}`
          : undefined
      }
    >
      <MessageRow
        row={displayRow}
        isStreaming={isStreaming}
        hideSubagentInnerTools={false}
        suppressPlanExecPromptNoise
        showToolTiming={showToolTiming}
        suppressExploringFold={suppressExploringFold}
        sessionKey={sessionKey}
        onOpenFile={onOpenWorkspaceFile}
      />
    </div>
  )
}
