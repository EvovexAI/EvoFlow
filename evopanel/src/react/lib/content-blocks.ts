import type { MessageSegment } from '../chat-types.js'

export type ContentBlockKind = 'plan_text' | 'reasoning' | 'tools' | 'body_text'

export type StreamBlockWire = {
  blockId: string
  blockKind: ContentBlockKind
  seq: number
}

export type ContentBlock = {
  id: string
  kind: ContentBlockKind
  seq: number
  status: 'open' | 'closed'
  text?: string
  toolIds?: string[]
}

export function parseStreamBlockWire(raw: unknown): StreamBlockWire | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const blockId = o.blockId != null ? String(o.blockId).trim() : ''
  const blockKind = o.blockKind != null ? String(o.blockKind).trim() : ''
  const seqRaw = o.seq
  const seq = typeof seqRaw === 'number' && Number.isFinite(seqRaw) ? seqRaw : Number(seqRaw)
  if (!blockId || !blockKind || !Number.isFinite(seq)) return null
  if (
    blockKind !== 'plan_text' &&
    blockKind !== 'reasoning' &&
    blockKind !== 'tools' &&
    blockKind !== 'body_text'
  ) {
    return null
  }
  return { blockId, blockKind: blockKind as ContentBlockKind, seq }
}

export function parseBlockWireFromEvf(data: Record<string, unknown> | null | undefined): StreamBlockWire | null {
  if (!data) return null
  const blockId = data.block_id != null ? String(data.block_id).trim() : ''
  const blockKind = data.block_kind != null ? String(data.block_kind).trim() : ''
  const seqRaw = data.seq
  const seq = typeof seqRaw === 'number' && Number.isFinite(seqRaw) ? seqRaw : Number(seqRaw)
  if (!blockId || !blockKind || !Number.isFinite(seq)) return null
  return parseStreamBlockWire({ blockId, blockKind, seq })
}

// @ts-ignore
function insertBlockIdInOrder(order: string[], blockId: string, seq: number): string[] {
  if (order.includes(blockId)) return order
  const next = [...order, blockId]
  next.sort((a, b) => {
    const sa = a === blockId ? seq : undefined
    const sb = b === blockId ? seq : undefined
    return (sa ?? 0) - (sb ?? 0)
  })
  return next
}

export function upsertBlockInState(
  state: {
    blocks: Record<string, ContentBlock>
    blockOrder: string[]
  },
  wire: StreamBlockWire,
  patch: Partial<Pick<ContentBlock, 'text' | 'toolIds' | 'status'>>,
): { blocks: Record<string, ContentBlock>; blockOrder: string[] } {
  const prev = state.blocks[wire.blockId]
  const block: ContentBlock = {
    id: wire.blockId,
    kind: wire.blockKind,
    seq: wire.seq,
    status: patch.status ?? prev?.status ?? 'open',
    text: patch.text ?? prev?.text ?? '',
    toolIds: patch.toolIds ?? prev?.toolIds ?? [],
  }
  const blocks = { ...state.blocks, [wire.blockId]: block }
  let blockOrder = state.blockOrder
  if (!blockOrder.includes(wire.blockId)) {
    blockOrder = [...blockOrder, wire.blockId].sort(
      (a, b) => (blocks[a]?.seq ?? 0) - (blocks[b]?.seq ?? 0),
    )
  }
  return { blocks, blockOrder }
}

export function appendBlockText(
  state: { blocks: Record<string, ContentBlock>; blockOrder: string[] },
  wire: StreamBlockWire,
  piece: string,
): { blocks: Record<string, ContentBlock>; blockOrder: string[] } {
  const prev = state.blocks[wire.blockId]
  const text = `${prev?.text || ''}${piece}`
  return upsertBlockInState(state, wire, { text, status: 'open' })
}

export function appendBlockToolId(
  state: { blocks: Record<string, ContentBlock>; blockOrder: string[] },
  wire: StreamBlockWire,
  toolCallId: string,
): { blocks: Record<string, ContentBlock>; blockOrder: string[] } {
  const cid = String(toolCallId || '').trim()
  if (!cid) return state
  const prev = state.blocks[wire.blockId]
  const toolIds = [...(prev?.toolIds || [])]
  if (!toolIds.includes(cid)) toolIds.push(cid)
  return upsertBlockInState(state, wire, { toolIds, status: 'open' })
}

export function closeBlockInState(
  state: { blocks: Record<string, ContentBlock>; blockOrder: string[] },
  wire: StreamBlockWire,
): { blocks: Record<string, ContentBlock>; blockOrder: string[] } {
  return upsertBlockInState(state, wire, { status: 'closed' })
}

export function segmentsFromBlockState(
  blocks: Record<string, ContentBlock>,
  blockOrder: string[],
): MessageSegment[] {
  const out: MessageSegment[] = []
  for (const id of blockOrder) {
    const b = blocks[id]
    if (!b) continue
    const meta = { id: b.id, seq: b.seq, blockKind: b.kind }
    if (b.kind === 'tools') {
      const ids = (b.toolIds || []).filter((x) => String(x || '').trim())
      if (ids.length) out.push({ ...meta, kind: 'tools', ids })
      continue
    }
    if (b.kind === 'reasoning') {
      const text = String(b.text || '')
      if (text.trim()) out.push({ ...meta, kind: 'reasoning', text })
      continue
    }
    if (b.kind === 'plan_text' || b.kind === 'body_text') {
      const text = String(b.text || '')
      if (text.trim()) out.push({ ...meta, kind: 'text', text })
    }
  }
  return out
}

export function reasoningFromBlockState(
  blocks: Record<string, ContentBlock>,
  blockOrder: string[],
): { segments: string[]; preview: string | null } {
  const segments: string[] = []
  for (const id of blockOrder) {
    const b = blocks[id]
    if (b?.kind !== 'reasoning') continue
    const t = String(b.text || '').trim()
    if (t) segments.push(b.text || '')
  }
  return {
    segments,
    preview: segments.length ? segments[segments.length - 1] : null,
  }
}

export function hasBlockTimeline(blockOrder: string[] | undefined): boolean {
  return Array.isArray(blockOrder) && blockOrder.length > 0
}

export function collectToolIdsFromBlockState(
  blocks: Record<string, ContentBlock>,
  blockOrder: string[],
): Set<string> {
  const out = new Set<string>()
  for (const id of blockOrder) {
    const b = blocks[id]
    if (b?.kind !== 'tools') continue
    for (const tid of b.toolIds || []) {
      const t = String(tid || '').trim()
      if (t) out.add(t)
    }
  }
  return out
}

export function turnHasToolsBlock(
  blocks: Record<string, ContentBlock>,
  blockOrder: string[] | undefined,
): boolean {
  if (!hasBlockTimeline(blockOrder)) return false
  return (blockOrder || []).some((id) => blocks[id]?.kind === 'tools')
}

/**
 * block 权威路径下 openText 是全量累积（跨工具批次，applyTextPiece 每条 piece 都写入
 * openText，而 block 只接收带 wire 的片段）。flush 时只追加 openText 中超出当前 block
 * 已有文本的「真正新尾巴」，避免把全量累积（含更早 block 的正文）无分隔符粘回当前 block
 * 造成重复与 Markdown 段落断裂。
 *
 * 两种 openText 形态都要兼容：
 *  - 全量累积（常见）：openText 末尾即当前 block 全文 → 已捕获，不追加；
 *    若其后还有未带 wire 的尾巴，则只追加该后缀。
 *  - 续写尾巴（abort / 旧契约，见 content-blocks.test.js）：openText 仅是 block 缺失的
 *    续写部分 → 原样直接追加（如 block="rep" + openText="ort tail" → "report tail"）。
 *
 * 「block 全文出现在 openText 中（前缀或中部）」意味着该 block 文本已被捕获、其后是
 * 新内容 → 必须用双换行分隔，避免 Markdown 标题/段落硬拼。
 */
function normalizeBlockSuffixSeparator(suffix: string): string {
  const s = String(suffix || '')
  if (!s) return ''
  // 已以双换行开头 → 保持
  if (/^\n{2,}/.test(s)) return s
  // 以单换行开头 → 提升为双换行（标题与正文间单换行不会产生段落断行）
  if (/^\n/.test(s)) return `\n\n${s.replace(/^\n+/, '')}`
  // 非换行开头（含空格）→ 补双换行
  return `\n\n${s}`
}

function streamOpenTextSuffixAfterBlock(blockText: string, openText: string): string {
  const bt = String(blockText || '')
  const ot = String(openText || '')
  if (!ot) return ''
  if (!bt) return ot
  if (ot === bt) return ''
  // openText 末尾即 block 全文（最常见：post-tool 正文已被该 block 捕获）→ 无新内容
  if (ot.endsWith(bt)) return ''
  // block 已包含 openText（累积重放早段）→ 无新内容
  if (bt.endsWith(ot)) return ''
  // openText 以 block 开头（累积重放）→ 追加后缀，补双换行避免硬拼
  if (ot.startsWith(bt)) {
    return normalizeBlockSuffixSeparator(ot.slice(bt.length))
  }
  // block 全文出现在 openText 中部（全量累积 + block 之后还有未带 wire 的尾巴）→ 取其后缀
  if (bt.length >= 3 && ot.includes(bt)) {
    const idx = ot.lastIndexOf(bt)
    return normalizeBlockSuffixSeparator(ot.slice(idx + bt.length))
  }
  // openText 是 block 的直接续写（abort / 未带 wire 的尾巴）→ 原样追加，保留旧契约
  return ot
}

/** Merge trailing openText into the last plan/body block before finalize (abort / stop). */
export function flushOpenTextIntoBlockState(state: {
  blocks: Record<string, ContentBlock>
  blockOrder: string[]
  openText?: string
}): { blocks: Record<string, ContentBlock>; blockOrder: string[]; openText: string } {
  const tail = String(state.openText || '')
  if (!tail.trim() || !hasBlockTimeline(state.blockOrder)) {
    return { blocks: state.blocks, blockOrder: state.blockOrder, openText: tail }
  }
  const blocks = { ...state.blocks }
  const blockOrder = [...state.blockOrder]
  for (let i = blockOrder.length - 1; i >= 0; i--) {
    const id = blockOrder[i]
    const b = blocks[id]
    if (!b || (b.kind !== 'body_text' && b.kind !== 'plan_text')) continue
    const suffix = streamOpenTextSuffixAfterBlock(b.text || '', tail)
    if (suffix) {
      blocks[id] = { ...b, text: `${b.text || ''}${suffix}` }
    }
    return { blocks, blockOrder, openText: '' }
  }
  // No body_text/plan_text block found: create one so the streamed text is not lost.
  const maxSeq = blockOrder.reduce((m, id) => Math.max(m, blocks[id]?.seq ?? 0), 0)
  const flushWire: StreamBlockWire = {
    blockId: `body_text:flushed:${maxSeq + 1}`,
    blockKind: 'body_text',
    seq: maxSeq + 1,
  }
  const flushed = upsertBlockInState({ blocks, blockOrder }, flushWire, {
    text: tail,
    status: 'closed',
  })
  return { blocks: flushed.blocks, blockOrder: flushed.blockOrder, openText: '' }
}

export function findOpenToolsBlockWire(
  blocks: Record<string, ContentBlock>,
  blockOrder: string[],
): StreamBlockWire | undefined {
  for (let i = blockOrder.length - 1; i >= 0; i--) {
    const b = blocks[blockOrder[i]]
    if (b?.kind !== 'tools') continue
    // Skip closed tools blocks: a new tool batch must not append ids to an
    // already-sealed block (smaller seq) — that causes the new tools to render
    // at the old block's position instead of at the bottom.
    if (b.status === 'closed') continue
    // If a reasoning block was allocated after this tools block, the prior tool
    // batch ended; reusing would sort new tools above that reasoning.
    const hasReasoningAfter = blockOrder
      .slice(i + 1)
      .some((id) => blocks[id]?.kind === 'reasoning')
    if (hasReasoningAfter) continue
    return { blockId: b.id, blockKind: 'tools', seq: b.seq }
  }
  return undefined
}

/** Keep tools block toolIds in sync while streaming (block path skips legacy timeline). */
export function registerToolEntriesOnBlockState(
  state: { blocks: Record<string, ContentBlock>; blockOrder: string[] },
  entries: unknown[],
  block?: StreamBlockWire,
): { blocks: Record<string, ContentBlock>; blockOrder: string[] } {
  if (!entries.length) return state
  // Resolve target wire: prefer explicitly provided block (if not yet closed),
  // then fall back to an open tools block. Closed blocks are never reused -
  // new tool ids must not be appended to a sealed block (smaller seq) or they
  // render above earlier content.
  let wire: StreamBlockWire | undefined
  if (block?.blockId && block.blockKind === 'tools') {
    const existing = state.blocks[block.blockId]
    const blockIdx = state.blockOrder.indexOf(block.blockId)
    const hasReasoningAfter =
      blockIdx >= 0 &&
      state.blockOrder
        .slice(blockIdx + 1)
        .some((id) => state.blocks[id]?.kind === 'reasoning')
    if ((!existing || existing.status !== 'closed') && !hasReasoningAfter) {
      wire = block
    }
  }
  if (!wire && hasBlockTimeline(state.blockOrder)) {
    wire = findOpenToolsBlockWire(state.blocks, state.blockOrder)
  }
  if (!wire) return state
  let blocks = state.blocks
  let blockOrder = state.blockOrder
  for (const e of entries) {
    const o = e as Record<string, unknown>
    const id = String(o.id ?? o.tool_call_id ?? '').trim()
    if (!id) continue
    const patched = appendBlockToolId({ blocks, blockOrder }, wire, id)
    blocks = patched.blocks
    blockOrder = patched.blockOrder
  }
  return { blocks, blockOrder }
}

export function sortSegmentsBySeq(segments: MessageSegment[]): MessageSegment[] {
  return enforceSegmentDisplayOrder(segments)
}

/**
 * 展示层 seq 强制规则（唯一入口）：
 * - wire seq 全唯一 → 严格按 1,2,3… 升序排列；
 * - seq 重复或缺失 → 以当前数组到达顺序为准，重编号为 1..n（禁止按重复 seq 把后段 tools 抽到前段正文前）。
 */
export function enforceSegmentDisplayOrder(segments: MessageSegment[]): MessageSegment[] {
  const list = (Array.isArray(segments) ? segments : []).filter(Boolean)
  if (list.length < 2) return list

  const allHaveSeq = list.every((s) => typeof s.seq === 'number' && Number.isFinite(s.seq))
  if (allHaveSeq) {
    const seqs = list.map((s) => s.seq as number)
    if (new Set(seqs).size === seqs.length) {
      return [...list].sort((a, b) => (a.seq as number) - (b.seq as number))
    }
  }
  return list.map((seg, i) => ({ ...seg, seq: i + 1 }))
}

/** @deprecated use enforceSegmentDisplayOrder */
export function assignMonotonicDisplaySeq(segments: MessageSegment[]): MessageSegment[] {
  return enforceSegmentDisplayOrder(segments)
}

function toolIdsFromToolsSegment(seg: MessageSegment): string[] {
  if (seg.kind !== 'tools') return []
  return [
    ...new Set(
      (seg.ids || []).map((id) => String(id).trim()).filter(Boolean),
    ),
  ]
}

/**
 * Drop tools segments whose call ids were already placed earlier in the timeline.
 * Prevents compacted+live merge / orphan insert from duplicating tool rows at the tail.
 */
export function dedupeToolsTimelineSegments(segments: MessageSegment[]): MessageSegment[] {
  const list = (Array.isArray(segments) ? segments : []).filter(Boolean)
  if (list.length < 2) return list
  const seen = new Set<string>()
  const out: MessageSegment[] = []
  for (const seg of list) {
    if (seg.kind !== 'tools') {
      out.push(seg)
      continue
    }
    const ids = toolIdsFromToolsSegment(seg)
    if (!ids.length) continue
    const novel = ids.filter((id) => !seen.has(id))
    if (!novel.length) continue
    for (const id of novel) seen.add(id)
    out.push(novel.length === ids.length ? seg : { ...seg, ids: novel })
  }
  return out
}