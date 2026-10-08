/**
 * ChatApp.tsx module-顶层 helper 集合（v3.5 阶段 F2 commit 1 抽出）。
 *
 * 主题：**stream-snapshot** —— 把当前 stream state 投影成"对外可见"的
 * 局部快照,供 live run snapshot / display segments / wire block 等
 * 场景使用。
 *
 * 三个函数都是 streamProject 投影 + 序列处理,纯函数无副作用。
 */
import { parseStreamBlockWire, type StreamBlockWire } from '../../lib/content-blocks.js'
import { flattenStreamDisplayText } from '../../../lib/chat-normalize.js'
import { streamProject } from '../../lib/stream-state.js'

/** 把 stream state 投影成纯文本(给 live run snapshot / partial text 用)。 */
export function flattenLiveSnapshotText(S: Parameters<typeof streamProject>[0]): string {
  const proj = streamProject(S)
  return flattenStreamDisplayText(proj.segments, proj.text)
}

/** 把 stream state 投影成"对外可见"的 live run snapshot payload(partialText + partialDisplaySegments)。 */
export function buildLiveRunSnapshotPayload(S: Parameters<typeof streamProject>[0]) {
  const proj = streamProject(S)
  const segments = Array.isArray(proj.segments) && proj.segments.length ? proj.segments : []
  return {
    partialText: flattenStreamDisplayText(proj.segments, proj.text),
    partialDisplaySegments: segments,
  }
}

/** 从 chat wire payload 提取 block wire 信息,组装成 StreamBlockWire 或返回 undefined。 */
export function blockWireFromChatPayload(payload: Record<string, unknown>): StreamBlockWire | undefined {
  return (
    parseStreamBlockWire({
      blockId: payload.blockId,
      blockKind: payload.blockKind,
      seq: payload.blockSeq ?? payload.seq,
    }) ?? undefined
  )
}
