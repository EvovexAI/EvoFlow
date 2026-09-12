/**
 * 流式 Exploring：强制只挂「当前一轮」展示单元。
 *
 * 硬约束（展示层）：
 *   同时只允许出现一遍：思考? → 正文? → 多个工具*
 *   一旦工具之后再次出现思考或正文，上一轮整段清空，从新内容起算。
 *   连续多段 tools、中间没有新思考/正文 → 仍属同一轮。
 */
import { isToolRunning } from '../../lib/chat-normalize.js'
import { isToolPendingApproval } from '../../lib/tool-approval.js'
import type { ActivityPiece } from './exploring-activity-group.js'
import { resolveToolByFilterId } from './tool-filter-id-resolve.js'

/** 流式期间默认只挂最新一轮 */
export const LIVE_TOOL_ROUND_WINDOW = 1

export type WindowLiveExploringPiecesInput = {
  pieces: ActivityPiece[]
  tools?: unknown[]
  keepLastToolRounds?: number
  /** false：历史 Explored，不做窗口 */
  isStreaming?: boolean
}

export type WindowLiveExploringPiecesResult = {
  visiblePieces: ActivityPiece[]
  hiddenToolRoundCount: number
  hiddenToolIds: string[]
}

function isToolsPiece(p: ActivityPiece | undefined): p is Extract<ActivityPiece, { kind: 'tools' }> {
  return !!p && p.kind === 'tools' && p.ids.some((id) => String(id || '').trim())
}

function isNonEmptyReasoning(p: ActivityPiece | undefined): boolean {
  return !!p && p.kind === 'reasoning' && !!String(p.text || '').trim()
}

function isNonEmptyText(p: ActivityPiece | undefined): boolean {
  return !!p && p.kind === 'text' && !!String(p.text || '').trim()
}

function collectToolRoundIndices(pieces: ActivityPiece[]): number[] {
  const out: number[] = []
  for (let i = 0; i < pieces.length; i++) {
    if (isToolsPiece(pieces[i])) out.push(i)
  }
  return out
}

function toolIdsMustForceKeep(tools: unknown[], ids: string[]): boolean {
  if (!ids.length) return false
  for (const rawId of ids) {
    const id = String(rawId || '').trim()
    if (!id) continue
    const tool = resolveToolByFilterId(tools, id)
    if (!tool) continue
    if (isToolRunning(tool) || isToolPendingApproval(tool)) return true
  }
  return false
}

function collectIdsFromToolsPiece(piece: Extract<ActivityPiece, { kind: 'tools' }>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of piece.ids) {
    const id = String(raw || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * 最新一轮起点（硬切轮）：
 * 工具已经出现过之后，每出现一次「思考」或「正文」，都开启新一轮并清空此前可见内容。
 * 若尚未切轮，返回 0（整段仍是当前轮）。
 */
export function findLatestDisplayRoundStart(pieces: ActivityPiece[]): number {
  const list = Array.isArray(pieces) ? pieces : []
  if (!list.length) return 0

  let sawTools = false
  let latestBoundary = 0
  for (let i = 0; i < list.length; i++) {
    const p = list[i]
    if (isToolsPiece(p)) {
      sawTools = true
      continue
    }
    if (!sawTools) continue
    // 工具后的思考 / 正文 → 强制新一轮
    if (isNonEmptyReasoning(p) || isNonEmptyText(p)) {
      latestBoundary = i
    }
  }
  return latestBoundary
}

function countHiddenToolRoundsBefore(pieces: ActivityPiece[], windowStart: number): {
  hiddenToolRoundCount: number
  hiddenToolIds: string[]
} {
  const hiddenToolIds: string[] = []
  let hiddenToolRoundCount = 0
  for (let i = 0; i < windowStart && i < pieces.length; i++) {
    const piece = pieces[i]
    if (!isToolsPiece(piece)) continue
    hiddenToolRoundCount += 1
    for (const id of collectIdsFromToolsPiece(piece)) hiddenToolIds.push(id)
  }
  return { hiddenToolRoundCount, hiddenToolIds }
}

/**
 * 流式只保留最新一轮；更早轮次进明细。
 * 硬约束：可见序列里不会叠两轮「思考/正文 + 工具」。
 */
export function windowLiveExploringPieces(
  input: WindowLiveExploringPiecesInput,
): WindowLiveExploringPiecesResult {
  const pieces = Array.isArray(input.pieces) ? input.pieces : []
  const tools = Array.isArray(input.tools) ? input.tools : []
  const empty: WindowLiveExploringPiecesResult = {
    visiblePieces: pieces,
    hiddenToolRoundCount: 0,
    hiddenToolIds: [],
  }

  if (!input.isStreaming) return empty

  const keepLast = Math.max(
    0,
    Number.isFinite(input.keepLastToolRounds as number)
      ? Math.floor(Number(input.keepLastToolRounds))
      : LIVE_TOOL_ROUND_WINDOW,
  )
  if (keepLast <= 0) return empty

  // 明细「完整过程」：不做直播裁剪
  const toolRoundCount = collectToolRoundIndices(pieces).length
  if (keepLast >= Math.max(toolRoundCount, 1) && keepLast > LIVE_TOOL_ROUND_WINDOW) {
    return empty
  }

  const roundStart = findLatestDisplayRoundStart(pieces)

  // 硬约束：只有「工具后的新思考/正文」才切轮；同轮内多 tools 全保留
  if (roundStart <= 0) return empty
  const windowStart = roundStart

  const forcedEarly = new Set<number>()
  for (let idx = 0; idx < windowStart; idx++) {
    const piece = pieces[idx]
    if (!isToolsPiece(piece)) continue
    if (toolIdsMustForceKeep(tools, piece.ids)) {
      forcedEarly.add(idx)
      for (let i = idx - 1; i >= 0; i--) {
        if (isToolsPiece(pieces[i])) break
        forcedEarly.add(i)
      }
    }
  }

  const visiblePieces: ActivityPiece[] = []
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]
    if (!piece) continue
    if (i >= windowStart || forcedEarly.has(i)) visiblePieces.push(piece)
  }

  const { hiddenToolRoundCount, hiddenToolIds } = countHiddenToolRoundsBefore(pieces, windowStart)
  const forcedHiddenIds = new Set<string>()
  for (const idx of forcedEarly) {
    const p = pieces[idx]
    if (isToolsPiece(p)) {
      for (const id of collectIdsFromToolsPiece(p)) forcedHiddenIds.add(id)
    }
  }
  const filteredHiddenIds = hiddenToolIds.filter((id) => !forcedHiddenIds.has(id))
  let filteredHiddenRounds = hiddenToolRoundCount
  for (const idx of forcedEarly) {
    if (isToolsPiece(pieces[idx])) filteredHiddenRounds = Math.max(0, filteredHiddenRounds - 1)
  }

  return {
    visiblePieces,
    hiddenToolRoundCount: filteredHiddenRounds,
    hiddenToolIds: filteredHiddenIds,
  }
}
