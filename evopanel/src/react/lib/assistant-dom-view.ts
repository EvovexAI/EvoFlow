/**
 * v5.9 compare-log：把 MessageRow 即将渲染的助手气泡折叠面板转换为「用户看到什么」
 * 的 1:1 DOM 视角树，喂给 stream-compare ui-display。
 *
 * 设计要点：
 * - 不读 DOM（也不必读）：纯数据构造 —— `MessageRow` 已经有 plan/tools/rawText/displaySegments
 *   这些事实来源，再叠加 MessageRow 内 `isStreaming` / `workedLabelOut` 决定 fold 开关 + gear。
 * - 与 AssistantBubbleSlotView 渲染时序保持一致：fold 默认 = isStreaming（manual 状态首次 render
 *   不会触发；同 v5.6 TurnHistoryFold 行为），history piece role 与 ExploringActivityChunk 同源。
 * - 输出 UiDomChunk[]：交给 `logStreamCompareDomView` 写到 ui-display.log 的 [dom-view] section。
 */
import type { DisplayRow, MessageSegment } from '../chat-types.js'
import type { AssistantBubbleDisplayPlan, AssistantBubbleSlot } from './message-row-display-plan.js'
import type { SegmentDisplayChunk, ActivityPiece } from './exploring-activity-group.js'
import type { UiDomChunk, UiDomPiece } from './stream-compare-file-log.js'

export function buildAssistantDomView(opts: {
  row: DisplayRow
  plan: AssistantBubbleDisplayPlan
  isStreaming: boolean
  workedLabel: string
  /**
   * 整 thread 是否还在跑（与左下「停止」按钮同源 = sessionRuntime.turnPhase
   * ∈ {outbound, live, reattaching, sealing}）。v5.10 反馈：
   *   - 旧实现 `gear = isStreaming` 会让历史 turn row 在 RUN_FINISHED 之后立刻 off
   *   - 用户期望「整个对话跑完才不显示」= 跟停止按钮同步
   *   也就是 sealing 阶段（RUN_FINISHED → turnPhase=idle 之间）齿轮也亮着
   *   2026-10-10 用户追加反馈：foldOpen 也用同一信号 —— 否则历史 row 折叠后
   *   内容（含 final-reply、tools、reasoning）全藏起来，看不到最新。
   */
  threadBusy?: boolean
  /** 已工作的回合默认折叠（已工作 / 已停止）；工作中（isStreaming）默认展开 */
  /** 收集触发本回合的 file changes（DOM 上显示在气泡底部） */
  fileChanges?: string[]
}): {
  head: string
  foldOpen: boolean
  gear: 'off' | 'streaming' | 'spinner'
  chunks: UiDomChunk[]
    fileChanges: string[]
} {
  const tools = (opts.row.tools as unknown[]) || []
  const displayChunks = opts.plan.layout?.displayChunks ?? []
  const chunks: UiDomChunk[] = []
  for (const slot of opts.plan.slots) {
    pushSlot(slot, tools, displayChunks, chunks)
  }
  // v5.10：gear + foldOpen 都跟 threadBusy 绑（与停止按钮同源）。
  //  - threadBusy=true  → spinner（thread 还在跑：outbound/live/reattaching/sealing）
  //  - threadBusy=false → off 且折叠（thread 已彻底结束，turnPhase=idle）
  // 历史 row 在 sealing 阶段也保持展开，让用户看到 final-reply 正文（2026-10-10 反馈：
  //   「封存后整段折叠，看不到最新文字」= 之前 foldOpen 只看 isStreaming）。
  const turnAlive = !!opts.threadBusy
  const gear = turnAlive ? 'spinner' : 'off'
  const foldOpen = turnAlive
  if (turnAlive) {
    chunks.push({ kind: 'spinner', label: '生成中' })
  }
  return {
    head: opts.workedLabel || '',
    foldOpen,
    gear,
    chunks,
    fileChanges: opts.fileChanges || [],
  }
}

function pushSlot(
  slot: AssistantBubbleSlot,
  tools: unknown[],
  displayChunks: SegmentDisplayChunk[],
  out: UiDomChunk[],
): void {
  if (slot.kind === 'chunk') {
    const chunk = slot.chunk
    if (chunk.kind === 'text') {
      out.push({
        kind: 'msg-text',
        role: 'final-reply',
        text: chunk.text || '',
        markdown: extractMarkdownShape(chunk.text || ''),
      })
    } else if (chunk.kind === 'activity') {
      out.push({
        kind: 'flat-activity',
        pieces: buildActivityPieces(chunk.pieces, tools),
      })
    } else if (chunk.kind === 'tools-standalone') {
      const list = chunk.ids
        .map((id) => findToolById(tools, id))
        .filter((t): t is Record<string, unknown> => !!t)
        .map(toolToChip)
      out.push({ kind: 'flat-activity', pieces: [{ kind: 'tools', role: 'latest', tools: list }] })
    }
    return
  }
  if (slot.kind === 'plan-top') {
    out.push({
      kind: 'msg-text',
      role: 'plan-text',
      text: slot.text || '',
      markdown: extractMarkdownShape(slot.text || ''),
    })
    return
  }
  if (slot.kind === 'top-reasoning') {
    out.push({
      kind: 'msg-text',
      role: 'top-reasoning',
      text: slot.text || '',
    })
    return
  }
  if (slot.kind === 'reasoning-pending') {
    out.push({
      kind: 'msg-text',
      role: 'reasoning-pending',
      text: slot.text || '',
    })
    return
  }
  if (slot.kind === 'live-tail') {
    out.push({
      kind: 'msg-text',
      role: 'live-tail',
      text: slot.text || '',
      markdown: extractMarkdownShape(slot.text || ''),
    })
    return
  }
  if (slot.kind === 'plain-body') {
    out.push({
      kind: 'msg-text',
      role: 'plain-body',
      text: slot.text || '',
      markdown: extractMarkdownShape(slot.text || ''),
    })
    return
  }
  if (slot.kind === 'legacy-body') {
    out.push({
      kind: 'msg-text',
      role: 'final-reply',
      text: slot.text || '',
      markdown: extractMarkdownShape(slot.text || ''),
    })
    return
  }
  if (slot.kind === 'legacy-tools') {
    out.push({
      kind: 'legacy-tools',
      tools: tools.filter((t) => !!t && typeof t === 'object').map((t) => {
        const rec = t as Record<string, unknown>
        return {
          name: String(resolveEffectiveToolNameLocal(rec) || '?'),
          status: String(rec.status ?? 'unknown'),
          id: String(rec.tool_call_id ?? rec.id ?? ''),
        }
      }),
    })
    return
  }
  if (slot.kind === 'orphan-tools') {
    out.push({
      kind: 'legacy-tools',
      tools: slot.tools.filter((t) => !!t && typeof t === 'object').map((t) => {
        const rec = t as Record<string, unknown>
        return {
          name: String(resolveEffectiveToolNameLocal(rec) || '?'),
          status: String(rec.status ?? 'unknown'),
          id: String(rec.tool_call_id ?? rec.id ?? ''),
        }
      }),
    })
    return
  }
  if (slot.kind === 'tool-row') {
    const list = slot.toolCallIds
      .map((id) => findToolById(tools, id))
      .filter((t): t is Record<string, unknown> => !!t)
      .map(toolToChip)
    out.push({ kind: 'flat-activity', pieces: [{ kind: 'tools', role: 'latest', tools: list }] })
    return
  }
  // thinking-wait：目前不直接渲染 DOM（已被 spinner 替代），跳过
}

function buildActivityPieces(pieces: ActivityPiece[], tools: unknown[]): UiDomPiece[] {
  // 2026-10-10 反馈后：折叠态全量显示（v5.5「仅 last text = latest」规则下线）。
  //   所有 piece 在 DOM 与日志中都标 latest，CSS 折叠时不再按 role 隐藏。
  //   仍保留 [data-piece-role="history"] 隐藏逃生口（CSS 侧未删），便于未来按需开启。
  return pieces.map((p, pi) => {
    if (p.kind === 'tools') {
      const list: { name: string; status: string; file?: string; diff?: string; elapsed?: string; time?: string; id: string }[] = []
      for (const id of p.ids) {
        const t = findToolById(tools, id)
        if (t) list.push(toolToChip(t))
      }
      return { kind: 'tools', role: 'latest', tools: list }
    }
    if (p.kind === 'text') {
      return {
        kind: 'text',
        role: 'latest',
        text: p.text || '',
      }
    }
    // reasoning
    return {
      kind: 'reasoning',
      role: 'latest',
      text: p.text || '',
      durationLabel:
        p.startedAtMs != null && p.endedAtMs != null
          ? `${Math.max(0, Math.round((p.endedAtMs - p.startedAtMs) / 1000))}s`
          : undefined,
    }
  })
}

function findToolById(tools: unknown[], id: string): Record<string, unknown> | null {
  for (const raw of tools) {
    if (!raw || typeof raw !== 'object') continue
    const rec = raw as Record<string, unknown>
    const tcid = String(rec.tool_call_id ?? rec.id ?? '').trim()
    if (tcid === id) return rec
  }
  return null
}

export function toolToChip(t: Record<string, unknown>): {
  name: string
  status: string
  file?: string
  diff?: string
  elapsed?: string
  time?: string
  id: string
} {
  const name = String(resolveEffectiveToolNameLocal(t) || '?')
  const status = String(t.status ?? t.state ?? 'unknown')
  const id = String(t.tool_call_id ?? t.id ?? '')
  // 抓 file 路径：args.path / args.file / args.target_file / displayPath
  const args = (t.args && typeof t.args === 'object' ? t.args : t.input && typeof t.input === 'object' ? t.input : t) as Record<string, unknown>
  const file =
    String(args.path ?? args.file ?? args.target_file ?? args.notebook_path ?? args.target_path ?? t.displayPath ?? '') || undefined
  // diff 摘要：search_replace / write 工具可能带 stat
  const stat = t.stat
  let diff: string | undefined
  if (stat && typeof stat === 'object') {
    const s = stat as Record<string, unknown>
    const add = Number(s.additions ?? s.add ?? 0)
    const del = Number(s.deletions ?? s.remove ?? 0)
    if (add || del) diff = `+${add} −${del}`
  } else {
    const add = Number(t.additions ?? 0)
    const del = Number(t.deletions ?? 0)
    if (add || del) diff = `+${add} −${del}`
  }
  // elapsed：粗略；< 1s 显示毫秒，≥ 1s 显示秒
  const started = parseTimeMsLocal(t._uiStartedAtMs ?? t.startedAtMs)
  const ended = parseTimeMsLocal(t._uiEndedAtMs ?? t.endedAtMs)
  let elapsed: string | undefined
  if (started != null && ended != null) {
    const ms = Math.max(0, ended - started)
    if (ms < 1000) {
      elapsed = `${ms}毫秒`
    } else {
      const s = Math.round(ms / 1000)
      elapsed = `${s}秒`
    }
  }
  // time：绝对时间戳 HH:MM
  const start = started ?? parseTimeMsLocal(t.time ?? t.messageTimestamp)
  let time: string | undefined
  if (start != null) {
    const d = new Date(start)
    if (!Number.isNaN(d.getTime())) {
      const hh = String(d.getHours()).padStart(2, '0')
      const mm = String(d.getMinutes()).padStart(2, '0')
      time = `${hh}:${mm}`
    }
  }
  return { name, status, file: file || undefined, diff, elapsed, time, id }
}

function parseTimeMsLocal(v: unknown): number | null {
  if (v == null) return null
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Date.parse(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

function resolveEffectiveToolNameLocal(t: Record<string, unknown>): string {
  // 与 stream-compare-file-log.ts 内 toolRowChip 同源
  const raw =
    t.toolName ??
    t.effective_tool_name ??
    t.resolved_tool_name ??
    t.tool_name ??
    t.name ??
    ''
  return String(raw).trim()
}

function extractMarkdownShape(md: string): { paragraphs: number; tables: number; lists: number; codeBlocks: number } {
  if (!md) return { paragraphs: 0, tables: 0, lists: 0, codeBlocks: 0 }
  const paragraphs = (md.match(/\n\n+|\r\n\r\n+/g)?.length ?? 0) + (md.trim() ? 1 : 0)
  const tables = (md.match(/\|.*\|/g) || []).length > 0 ? 1 : 0
  const lists = (md.match(/^\s*[-*+]\s+/gm) || []).length > 0 ? 1 : 0
  const codeBlocks = (md.match(/```/g) || []).length >= 2 ? 1 : 0
  return { paragraphs, tables, lists, codeBlocks }
}

// Re-export for callers that want to type MessageSegment from the same file
export type { MessageSegment }
