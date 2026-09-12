import {
  assistantBodiesLooselySame,
  isToolRunning,
  toolOmitFromChatPanel,
  turnHasVisibleChatTools,
} from '../../lib/chat-normalize.js'
import { isToolPendingApproval } from '../../lib/tool-approval.js'
import {
  resolveToolKey,
} from '../../lib/tool-display.js'
import type { MessageSegment } from '../chat-types.js'
import { resolveToolByFilterId } from './tool-filter-id-resolve.js'
import {
  accumulateFileEditStatsFromTools,
  formatFileEditDiffStatBrief,
} from '../file-diff-util.js'

/**
 * 主会话 assistant 气泡排版：
 *
 * **Plan** — 开场计划正文（顶栏）
 * **Exploring** — 思考 + 全部工具 + 工具间旁白（单一折叠）
 * **Final** — 最终总结（最下）
 */

/** 工具批次之前的短开场白（计划顶栏），区别于探索内长旁白 */
export function isShortOpeningPlanText(text: string): boolean {
  const t = String(text || '').trim()
  if (!t) return false
  if (t.length > 120) return false
  if (/继续|排查|深入|还没|让我/.test(t)) return false
  return true
}

/** 写入 / 替换 / 删除：不进 Exploring，在气泡里单独展示 */
const WORKSPACE_FILE_MUTATION_KINDS = new Set([
  'write',
  'write_to_file',
  'write_file',
  'replace',
  'replace_in_file',
  'str_replace',
  'delete',
  'delete_file',
])

export function isWorkspaceFileMutationToolKind(toolKind: string): boolean {
  return WORKSPACE_FILE_MUTATION_KINDS.has(String(toolKind || '').trim().toLowerCase())
}

function segmentHasExploringTools(
  seg: MessageSegment,
  tools: unknown[],
  interactiveToolApproval: boolean,
): boolean {
  if (seg.kind === 'reasoning') return true
  if (seg.kind === 'tools') {
    const { exploring } = splitToolIdsForExploring(seg.ids, tools, interactiveToolApproval)
    return exploring.length > 0
  }
  return false
}

function segmentIsStandaloneFileMutationOnly(
  seg: MessageSegment,
  tools: unknown[],
  interactiveToolApproval: boolean,
): boolean {
  if (seg.kind !== 'tools') return false
  const { exploring, standalone } = splitToolIdsForExploring(seg.ids, tools, interactiveToolApproval)
  if (!standalone.length || exploring.length) return false
  return standalone.every((id) => {
    const t = findToolByCallId(tools, id)
    if (!t) return false
    return isWorkspaceFileMutationToolKind(resolveToolKey(t as Record<string, unknown>))
  })
}

function hasExploringSegmentBefore(
  segments: MessageSegment[],
  index: number,
  tools: unknown[],
  interactiveToolApproval: boolean,
): boolean {
  for (let j = index - 1; j >= 0; j--) {
    if (segmentHasExploringTools(segments[j], tools, interactiveToolApproval)) return true
  }
  return false
}

function hasExploringSegmentAfter(
  segments: MessageSegment[],
  index: number,
  tools: unknown[],
  interactiveToolApproval: boolean,
): boolean {
  for (let j = index + 1; j < segments.length; j++) {
    if (segmentHasExploringTools(segments[j], tools, interactiveToolApproval)) return true
  }
  return false
}

/** 跳过 hidden-only tools 段，看后面是否还有可见 Exploring 工具 */
function hasVisibleExploringSegmentAfterSkippingHidden(
  segments: MessageSegment[],
  index: number,
  tools: unknown[],
  interactiveToolApproval: boolean,
): boolean {
  for (let j = index + 1; j < segments.length; j++) {
    const seg = segments[j]
    if (seg.kind === 'reasoning') continue
    if (seg.kind !== 'tools') return false
    const { exploring, standalone } = splitToolIdsForExploring(
      seg.ids,
      tools,
      interactiveToolApproval,
    )
    if (standalone.length) return false
    if (exploring.length) return true
  }
  return false
}

function hasStandaloneFileMutationAfter(
  segments: MessageSegment[],
  index: number,
  tools: unknown[],
  interactiveToolApproval: boolean,
): boolean {
  for (let j = index + 1; j < segments.length; j++) {
    if (segmentHasExploringTools(segments[j], tools, interactiveToolApproval)) return false
    if (segmentIsStandaloneFileMutationOnly(segments[j], tools, interactiveToolApproval)) return true
  }
  return false
}

/** 正文后第一个 tools 段是否为 Exploring 类（非 write/delete 等独立文件变更） */
function nextToolsSegmentIsExploringOnly(
  segments: MessageSegment[],
  index: number,
  tools: unknown[],
  interactiveToolApproval: boolean,
): boolean {
  for (let j = index + 1; j < segments.length; j++) {
    const s = segments[j]
    if (s.kind !== 'tools') continue
    if (segmentIsStandaloneFileMutationOnly(s, tools, interactiveToolApproval)) return false
    const { exploring } = splitToolIdsForExploring(s.ids, tools, interactiveToolApproval)
    if (exploring.length > 0) return true
    // legacy/hidden-only tools 段：仍视为探索批次后的短旁白锚点
    return (s.ids || []).some((raw) => {
      const id = String(raw).trim()
      return id && !!findToolByCallId(tools, id)
    })
  }
  return false
}

/** tools 段是否全部为 panel 隐藏工具（scenario / todo_write 等） */
export function toolsSegmentIsHiddenOnly(
  seg: MessageSegment,
  tools: unknown[],
  interactiveToolApproval: boolean,
  messageStreaming = false,
): boolean {
  if (seg.kind !== 'tools' || !(seg.ids?.length || 0)) return false
  const { exploring, standalone } = splitToolIdsForExploring(
    seg.ids || [],
    tools,
    interactiveToolApproval,
    messageStreaming,
  )
  return exploring.length === 0 && standalone.length === 0
}

/** 首个可见 Exploring 工具前的计划/开场正文：顶栏或独立 text chunk，不进 Exploring。
 *  注意：Exploring 之后的模型回复正文（哪怕看起来像「计划」）一律收进折叠，不再顶栏重复显示。
 */
export function isPreToolsPlanTextSegment(
  segments: MessageSegment[],
  index: number,
  tools: unknown[],
  interactiveToolApproval: boolean,
): boolean {
  const seg = segments[index]
  if (seg.kind !== 'text') return false
  if (!String(seg.text || '').trim()) return false
  let hasExploringTool = false
  for (let j = 0; j < index; j++) {
    const prev = segments[j]
    if (prev.kind === 'text' && String(prev.text || '').trim()) return false
    if (prev.kind === 'tools' && (prev.ids?.length || 0) > 0) {
      if (!toolsSegmentIsHiddenOnly(prev, tools, interactiveToolApproval)) {
        hasExploringTool = true
      }
    }
  }
  // 只要前面已经出现过可见 Exploring 工具，该正文就不再是「计划顶栏」
  if (hasExploringTool) return false
  return true
}

/** 工具批次之间的正文：进 Exploring；计划与最终总结留在外面（流式期间同样外显，不藏进折叠） */
export function isInterExploringTextSegment(
  segments: MessageSegment[],
  index: number,
  tools: unknown[],
  interactiveToolApproval: boolean,
  messageStreaming = false,
): boolean {
  const seg = segments[index]
  if (seg.kind !== 'text') return false
  if (!String(seg.text || '').trim()) return false
  if (isPreToolsPlanTextSegment(segments, index, tools, interactiveToolApproval)) {
    if (isShortOpeningPlanText(String(seg.text || ''))) return false
    if (!messageStreaming) return false
    return hasExploringSegmentBefore(segments, index, tools, interactiveToolApproval)
  }
  if (!hasExploringSegmentBefore(segments, index, tools, interactiveToolApproval)) return false
  const text = String(seg.text || '')
  // 流式期间：正文先于 tool_calls 到达时，紧跟 hidden-only tools 段也应收进 Exploring
  if (messageStreaming) {
    const laterTools = segments.slice(index + 1).some((s) => s.kind === 'tools')
    const hasReasoningAfter = segments.some((s, j) => j > index && s?.kind === 'reasoning')
    const toolsStillRunning = (tools || []).some((x) => isToolRunning(x))
    const exploringToolsFollow = nextToolsSegmentIsExploringOnly(
      segments,
      index,
      tools,
      interactiveToolApproval,
    )
    if (hasReasoningAfter || toolsStillRunning || exploringToolsFollow) {
      if (hasRichAnswerMarkup(text)) return false
      return true
    }
    const exploringAfter =
      hasExploringSegmentAfter(segments, index, tools, interactiveToolApproval) ||
      hasVisibleExploringSegmentAfterSkippingHidden(
        segments,
        index,
        tools,
        interactiveToolApproval,
      )
    if (!exploringAfter) {
      // 仅工具轮次间隙 open tail：收进 Exploring 避免与底部 live-tail 双显；最终回复仍留底部
      if (
        !laterTools &&
        !toolsStillRunning &&
        turnHasVisibleChatTools(tools, segments) &&
        isLastTextSegmentInTimeline(segments, index) &&
        !isLikelyFinalReplyText(text, tools) &&
        !(
          FINAL_REPLY_HINT.test(text) &&
          !/(?:继续|下一|再查|接着|然后|收到)/.test(text)
        )
      ) {
        return true
      }
      return false
    }
    if (hasRichAnswerMarkup(text)) return false
    if (isLikelyFinalReplyText(text, tools)) return false
    return true
  }
  // 后面还有探索类工具 → 视为工具间旁白，勿因「已/分析」等词误判为最终总结而切断 Exploring
  if (hasExploringSegmentAfter(segments, index, tools, interactiveToolApproval)) return true
  return hasStandaloneFileMutationAfter(segments, index, tools, interactiveToolApproval)
}

const FINAL_REPLY_HINT =
  /(?:总结|综上|因此|结论|建议|可以|结果|完成|如下|分析|说明|实现|修改|已|成功|失败)/

/** 表格 / 多级标题等：应留在折叠外作最终回复，不进 Exploring */
export function hasRichAnswerMarkup(text: string): boolean {
  const t = String(text || '').trim()
  if (!t) return false
  if (/<table[\s>]/i.test(t)) return true
  const pipeRows = t.split('\n').filter((line) => /^\s*\|.+\|\s*$/.test(line))
  if (pipeRows.length >= 2) return true
  if ((t.match(/^#{1,3}\s+/gm) || []).length >= 2 && t.length >= 64) return true
  if ((t.match(/^[-*]\s+/gm) || []).length >= 4 && t.length >= 120) return true
  return false
}

export function isLikelyFinalReplyText(text: string, tools: unknown[]): boolean {
  const t = String(text || '').trim()
  if (!t) return false
  if ((tools || []).some((x) => isToolRunning(x))) return false
  if (hasRichAnswerMarkup(t)) return true
  if (t.length >= 200) return true
  if (FINAL_REPLY_HINT.test(t) && t.length >= 48) return true
  if (t.split('\n').filter((line) => line.trim()).length >= 3 && t.length >= 96) return true
  return false
}

function hasAnyExploringSegmentBefore(
  segments: MessageSegment[],
  index: number,
  tools: unknown[],
  interactiveToolApproval: boolean,
): boolean {
  for (let j = index - 1; j >= 0; j--) {
    if (segmentHasExploringTools(segments[j], tools, interactiveToolApproval)) return true
  }
  return false
}

function isLastTextSegmentInTimeline(segments: MessageSegment[], index: number): boolean {
  for (let j = index + 1; j < segments.length; j++) {
    // @ts-ignore
    if (segments[j].kind === 'text' && String(segments[j].text || '').trim()) return false
  }
  return true
}

/** 折叠外的「最终回复」正文（流式期间也外显） */
export function isFinalReplyTextSegment(
  segments: MessageSegment[],
  index: number,
  tools: unknown[],
  interactiveToolApproval: boolean,
  _messageStreaming = false,
): boolean {
  const seg = segments[index]
  if (!seg || seg.kind !== 'text') return false
  if (!String(seg.text || '').trim()) return false
  if (isInterExploringTextSegment(segments, index, tools, interactiveToolApproval, false)) return false
  return hasAnyExploringSegmentBefore(segments, index, tools, interactiveToolApproval)
}

/** activity 时间线内是否含实际工具段（纯思考不计为「步骤」） */
export function activityPiecesHasToolSteps(pieces?: ActivityPiece[]): boolean {
  return !!pieces?.some(
    (p) => p.kind === 'tools' && p.ids.some((id) => String(id).trim()),
  )
}

/** Exploring 标题元信息：工具/轮次文案 + 整轮文件变更累加统计 */
export function exploringHeaderToolMeta(
  tools: unknown[],
  activityPieces?: ActivityPiece[],
  turnTools?: unknown[],
): { toolLabel: string; fileStats: { added: number; removed: number } } {
  const toolCount =
    tools && tools.length
      ? tools.length
      : (() => {
          if (!activityPieces) return 0
          const seen = new Set<string>()
          for (const p of activityPieces) {
            if (p.kind !== 'tools') continue
            for (const id of p.ids) {
              const s = String(id).trim()
              if (s) seen.add(s)
            }
          }
          return seen.size
        })()

  const toolLabel =
    toolCount === 0
      ? ''
      : `${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}`

  const fileStats = accumulateFileEditStatsFromTools(turnTools ?? tools)
  return { toolLabel, fileStats }
}

/** Exploring 标题后：「3工具 2轮 +12 −3」（整轮文件变更 +/- 累加） */
export function exploringHeaderToolSummary(
  tools: unknown[],
  activityPieces?: ActivityPiece[],
  turnTools?: unknown[],
): string {
  const { toolLabel, fileStats } = exploringHeaderToolMeta(tools, activityPieces, turnTools)
  if (!toolLabel) return ''

  const parts = [toolLabel]
  const fileStatBrief = formatFileEditDiffStatBrief(fileStats)
  if (fileStatBrief) parts.push(fileStatBrief)

  return parts.join(' ')
}

export function exploringActivityStepCount(pieces: ActivityPiece[], _tools: unknown[] = []): number {
  let n = 0
  for (const p of pieces) {
    if (p.kind === 'reasoning') n++
    else if (p.kind === 'tools' && p.ids.length) n++
  }
  return n
}

export type ActivityPiece =
  | { kind: 'reasoning'; text: string; segIndex: number; id?: string }
  | { kind: 'text'; text: string; segIndex: number }
  | { kind: 'tools'; ids: string[]; segIndex: number }

export type SegmentDisplayChunk =
  | { kind: 'text'; text: string; segIndex: number }
  /** 同一批次 Exploring：工具之间的 reasoning + 多段 tools */
  | { kind: 'activity'; pieces: ActivityPiece[]; startIndex: number }
  /** 授权 / 子智能体等，不进入 Exploring */
  | { kind: 'tools-standalone'; ids: string[]; segIndex: number }

/** 批准后尚未落到 ok/error 前：仍单独展示，避免从「待授权卡片」突然收进 Exploring 导致正文跑到工具下方 */
function toolApprovalKeepsStandalone(tool: Record<string, unknown>): boolean {
  const st = String(tool.status || '').toLowerCase()
  if (
    st === 'approved' ||
    st === 'approved_waiting' ||
    st === 'awaiting_other_approval'
  ) {
    return true
  }
  try {
    const blob =
      typeof tool.output === 'string'
        ? tool.output
        : typeof tool.content === 'string'
          ? tool.content
          : typeof tool.result === 'string'
            ? tool.result
            : null
    if (blob && blob.trim().startsWith('{')) {
      const obj = JSON.parse(blob)
      const metaSt = String(obj?._evoflow_tool?.status || '').toLowerCase()
      if (
        metaSt === 'approved' ||
        metaSt === 'approved_waiting' ||
        metaSt === 'awaiting_other_approval'
      ) {
        return true
      }
    }
  } catch {
    /* ignore */
  }
  return false
}

/** 与 ToolCallList 一致：授权闸门 / 询问类必须单独展示，其余进 Exploring */
export function toolBreaksExploringGroup(
  tool: unknown,
  interactiveToolApproval: boolean,
): boolean {
  const t = tool as Record<string, unknown>
  if (isToolPendingApproval(t) && interactiveToolApproval) return true
  // 刚批准、仍在执行：保持 standalone（文件行 UI + 正文仍在工具上方），勿立刻折进 Exploring
  if (interactiveToolApproval && toolApprovalKeepsStandalone(t)) return true
  if (resolveToolKey(t) === 'ask_clarification') return true
  return false
}

function findToolByCallId(tools: unknown[], id: string): unknown | undefined {
  const want = String(id || '').trim()
  if (!want) return undefined
  for (const raw of tools || []) {
    const o = raw as Record<string, unknown>
    const rid = o.id != null && String(o.id).trim() !== '' ? String(o.id).trim() : ''
    const rtc =
      o.tool_call_id != null && String(o.tool_call_id).trim() !== ''
        ? String(o.tool_call_id).trim()
        : ''
    if (rid === want || rtc === want) return raw
  }
  return undefined
}

/** 按是否进入 Exploring 拆分同一段 tools 内的 id（避免 search + write 混在同一段） */
export function splitToolIdsForExploring(
  ids: string[],
  tools: unknown[],
  interactiveToolApproval: boolean,
  messageStreaming = false,
): { exploring: string[]; standalone: string[] } {
  const exploring: string[] = []
  const standalone: string[] = []
  for (const raw of ids || []) {
    const id = String(raw).trim()
    if (!id) continue
    const t = findToolByCallId(tools, id)
    // 流式 hydrate 前不把未知 id 当可见 exploring，以便 hidden-only 段能切断 activity 批次
    if (!t) {
      if (messageStreaming) continue
      exploring.push(id)
      continue
    }
    if (toolOmitFromChatPanel(t)) continue
    if (toolBreaksExploringGroup(t, interactiveToolApproval)) standalone.push(id)
    else exploring.push(id)
  }
  return { exploring, standalone }
}

function isExploringPieceSegment(seg: MessageSegment): boolean {
  return seg.kind === 'reasoning' || seg.kind === 'tools'
}

function pushActivityPiece(
  buf: ActivityPiece[],
  seg: MessageSegment,
  segIndex: number,
  segments: MessageSegment[],
  tools: unknown[],
  interactiveToolApproval: boolean,
): void {
  if (seg.kind === 'reasoning') {
    if (String(seg.text ?? '').length) {
      buf.push({
        kind: 'reasoning',
        text: seg.text,
        segIndex,
        ...(seg.id ? { id: seg.id } : {}),
      })
    }
    return
  }
  if (seg.kind === 'text') {
    if (
      isPreToolsPlanTextSegment(segments, segIndex, tools, interactiveToolApproval) &&
      isShortOpeningPlanText(String(seg.text || ''))
    ) {
      return
    }
    const text = String(seg.text || '').trim()
    if (text) buf.push({ kind: 'text', text: seg.text, segIndex })
    return
  }
  if (seg.kind === 'tools' && seg.ids?.length) {
    buf.push({ kind: 'tools', ids: [...seg.ids], segIndex })
  }
}

/**
 * 将 segments 切成：正文 | Exploring 批次（reasoning↔tools↔工具间正文）| 独立工具段。
 * 规则：连续 reasoning/tools/工具间 text 合并；计划与最终总结为外部 text。
 */
export function groupSegmentsForExploringDisplay(
  segments: MessageSegment[],
  tools: unknown[],
  interactiveToolApproval: boolean,
  messageStreaming = false,
): SegmentDisplayChunk[] {
  const out: SegmentDisplayChunk[] = []
  const standaloneToolIdsShown = new Set<string>()
  let i = 0
  while (i < segments.length) {
    const seg = segments[i]
    if (
      seg.kind === 'text' &&
      !isInterExploringTextSegment(segments, i, tools, interactiveToolApproval, messageStreaming)
    ) {
      out.push({ kind: 'text', text: seg.text, segIndex: i })
      i++
      continue
    }
    if (!isExploringPieceSegment(seg) && seg.kind !== 'text') {
      i++
      continue
    }

    const activityBuf: ActivityPiece[] = []
    let startIndex = i
    while (i < segments.length) {
      const s = segments[i]
      if (s.kind === 'text') {
        if (
          !isInterExploringTextSegment(segments, i, tools, interactiveToolApproval, messageStreaming)
        ) {
          break
        }
        pushActivityPiece(activityBuf, s, i, segments, tools, interactiveToolApproval)
        i++
        continue
      }
      if (!isExploringPieceSegment(s)) break
      if (s.kind === 'reasoning') {
        if (
          messageStreaming &&
          activityBuf.length > 0 &&
          activityBuf[activityBuf.length - 1]?.kind === 'tools'
        ) {
          out.push({ kind: 'activity', pieces: [...activityBuf], startIndex })
          activityBuf.length = 0
          startIndex = i
        }
        // 空 reasoning 占位段仅用于切断工具批次，不渲染正文
        if (String(s.text ?? '').trim()) {
          pushActivityPiece(activityBuf, s, i, segments, tools, interactiveToolApproval)
        }
        i++
        continue
      }
      if (s.kind === 'tools') {
        if (toolsSegmentIsHiddenOnly(s, tools, interactiveToolApproval, messageStreaming) && activityBuf.length) {
          out.push({ kind: 'activity', pieces: [...activityBuf], startIndex })
          activityBuf.length = 0
          startIndex = i + 1
        }
        let exploringRun: string[] = []
        const flushExploringRun = () => {
          if (!exploringRun.length) return
          activityBuf.push({ kind: 'tools', ids: [...exploringRun], segIndex: i })
          exploringRun = []
        }
        for (const raw of s.ids) {
          const id = String(raw).trim()
          if (!id) continue
          const t = findToolByCallId(tools, id)
          if (!t) {
            if (messageStreaming) continue
            if (!exploringRun.includes(id)) exploringRun.push(id)
            continue
          }
          if (toolOmitFromChatPanel(t)) continue
          if (toolBreaksExploringGroup(t, interactiveToolApproval)) {
            flushExploringRun()
            if (activityBuf.length) {
              out.push({ kind: 'activity', pieces: [...activityBuf], startIndex })
              activityBuf.length = 0
            }
            if (!standaloneToolIdsShown.has(id)) {
              standaloneToolIdsShown.add(id)
              out.push({ kind: 'tools-standalone', ids: [id], segIndex: i })
            }
          } else if (!exploringRun.includes(id)) {
            exploringRun.push(id)
          }
        }
        flushExploringRun()
        i++
        continue
      }
      pushActivityPiece(activityBuf, s, i, segments, tools, interactiveToolApproval)
      i++
    }
    if (activityBuf.length) {
      out.push({ kind: 'activity', pieces: activityBuf, startIndex })
    }
  }
  return out
}

/**
 * 整轮合并为单一 Exploring 折叠：全部 activity + tools-standalone 收成一块；
 * 活动间的 text 吸收进合并 activity 内部（保持到达顺序），不再上推/下沉。
 * 活动前的 text 保留为外部计划正文，活动后的 text 保留为外部最终总结。
 */
export function collapseTurnToSingleExploringChunk(
  chunks: SegmentDisplayChunk[],
): SegmentDisplayChunk[] {
  const firstExploringIdx = chunks.findIndex(
    (c) => c.kind === 'activity' || c.kind === 'tools-standalone',
  )
  if (firstExploringIdx < 0) return chunks

  const lastExploringIdx = chunks.reduce(
    (max, c, i) => (c.kind === 'activity' || c.kind === 'tools-standalone' ? i : max),
    -1,
  )

  const mergedPieces: ActivityPiece[] = []
  let activityStartIndex = -1
  for (let i = firstExploringIdx; i <= lastExploringIdx; i++) {
    const c = chunks[i]
    if (c.kind === 'activity') {
      if (activityStartIndex < 0) activityStartIndex = c.startIndex
      mergedPieces.push(...c.pieces)
    } else if (c.kind === 'tools-standalone') {
      if (activityStartIndex < 0) activityStartIndex = c.segIndex
      mergedPieces.push({ kind: 'tools', ids: [...c.ids], segIndex: c.segIndex })
    } else if (c.kind === 'text') {
      // 活动间正文：吸收进合并 activity，保持到达顺序
      const text = String(c.text || '').trim()
      if (text) mergedPieces.push({ kind: 'text', text: c.text, segIndex: c.segIndex })
    }
  }
  if (!mergedPieces.length) return chunks

  const merged: SegmentDisplayChunk = {
    kind: 'activity',
    pieces: mergedPieces,
    startIndex: activityStartIndex >= 0 ? activityStartIndex : 0,
  }

  const out: SegmentDisplayChunk[] = []
  // 活动前的 text 保留为外部计划正文
  for (let i = 0; i < firstExploringIdx; i++) {
    if (chunks[i].kind === 'text') out.push(chunks[i])
  }
  out.push(merged)
  // 活动后的 text 保留为外部最终总结
  for (let i = lastExploringIdx + 1; i < chunks.length; i++) {
    if (chunks[i].kind === 'text') out.push(chunks[i])
  }
  return out
}

/** 去掉无可见内容的 activity；将仅 tools 的孤儿批次并入下一段 Exploring */
export function mergeOrphanToolsOnlyActivityChunks(
  chunks: SegmentDisplayChunk[],
  tools: unknown[],
): SegmentDisplayChunk[] {
  const out: SegmentDisplayChunk[] = []
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]
    if (c.kind !== 'activity') {
      out.push(c)
      continue
    }
    const hasReasoningOrText = c.pieces.some(
      (p) =>
        (p.kind === 'reasoning' || p.kind === 'text') && String(p.text || '').trim(),
    )
    const visibleTools = toolsForActivityPieces(c.pieces, tools)
    if (!hasReasoningOrText && visibleTools.length === 0) continue
    const isToolsOnly =
      !hasReasoningOrText && visibleTools.length > 0 && c.pieces.every((p) => p.kind === 'tools')
    const next = chunks[i + 1]
    const nextHasReasoningOrText =
      next?.kind === 'activity' &&
      next.pieces.some(
        (p) =>
          (p.kind === 'reasoning' || p.kind === 'text') && String(p.text || '').trim(),
      )
    // 只把「紧邻下一段含思考/旁白」的孤儿 tools 批并入下一段；禁止链式合并多个 tools-only
    // 批次，否则多轮 drain 产生的 [tools][tools][tools][reasoning…] 会收成「全部工具在前」。
    if (isToolsOnly && nextHasReasoningOrText) {
      out.push({
        kind: 'activity',
        pieces: [...c.pieces, ...next.pieces],
        startIndex: c.startIndex,
      })
      i++
      continue
    }
    out.push(c)
  }
  return out
}

/** 流式期间合并相邻 Exploring 批次（工具间短旁白曾切断 activity 时的兜底） */
export function coalesceAdjacentActivityChunks(
  chunks: SegmentDisplayChunk[],
  messageStreaming = false,
): SegmentDisplayChunk[] {
  if (!messageStreaming || !chunks.length) return chunks
  const out: SegmentDisplayChunk[] = []
  for (const c of chunks) {
    if (c.kind === 'activity') {
      const prev = out[out.length - 1]
      if (prev?.kind === 'activity') {
        const prevHasTools = prev.pieces.some((p) => p.kind === 'tools')
        const curHasTools = c.pieces.some((p) => p.kind === 'tools')
        if (!prevHasTools && !curHasTools) {
          // 流式期间保持 reasoning 批次独立，避免 chunk#0 吞并多轮思考
          if (!messageStreaming) {
            out[out.length - 1] = {
              kind: 'activity',
              pieces: [...prev.pieces, ...c.pieces],
              startIndex: prev.startIndex,
            }
            continue
          }
        }
      }
    }
    out.push(c)
  }
  return out
}

/** 同一 tool_call_id 只保留首个 tools-standalone chunk（timeline 重放时的兜底） */
export function dedupeStandaloneToolChunks(chunks: SegmentDisplayChunk[]): SegmentDisplayChunk[] {
  const seen = new Set<string>()
  const out: SegmentDisplayChunk[] = []
  for (const c of chunks) {
    if (c.kind !== 'tools-standalone') {
      out.push(c)
      continue
    }
    const id = String(c.ids[0] || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(c)
  }
  return out
}

/** 合并连续、实质相同的 text chunk（流式封存段 + final 段只保留较长一条） */
export function dedupeLooseDuplicateTextChunks(chunks: SegmentDisplayChunk[]): SegmentDisplayChunk[] {
  const out: SegmentDisplayChunk[] = []
  for (const c of chunks) {
    if (c.kind !== 'text') {
      out.push(c)
      continue
    }
    const t = String(c.text || '').trim()
    if (!t) continue
    const prev = out.length > 0 ? out[out.length - 1] : null
    if (prev?.kind === 'text') {
      const p = String(prev.text || '').trim()
      if (assistantBodiesLooselySame(p, t)) {
        if (t.length >= p.length) out[out.length - 1] = c
        continue
      }
    }
    out.push(c)
  }
  return out
}

/** 从 Exploring 批次收集工具行（保持 tools 数组顺序） */
export function toolsForActivityPieces(
  pieces: ActivityPiece[],
  tools: unknown[],
): unknown[] {
  const idOrder: string[] = []
  const seen = new Set<string>()
  for (const p of pieces) {
    if (p.kind !== 'tools') continue
    for (const raw of p.ids) {
      const id = String(raw).trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      idOrder.push(id)
    }
  }
  return idOrder.map((id) => resolveToolByFilterId(tools, id)).filter(Boolean) as unknown[]
}

export function reasoningPiecesInActivity(pieces: ActivityPiece[]): ActivityPiece[] {
  return pieces.filter((p): p is Extract<ActivityPiece, { kind: 'reasoning' }> => p.kind === 'reasoning')
}