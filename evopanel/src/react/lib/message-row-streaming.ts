/** 行级流式状态唯一来源：仅续流 merge 目标行在 streamActive 时为 true */
export function resolveMessageRowIsStreaming(
  rowIndex: number,
  streamContinuedRowIndex: number,
  streamActive: boolean,
): boolean {
  return streamContinuedRowIndex >= 0 && rowIndex === streamContinuedRowIndex && streamActive
}

/**
 * 左下角齿轮宿主：必须与右下角停止按钮同源（isSending = selectedTurnBusy）。
 * 不跟 streamActive / suppressStreamUiAfterSeal 走——审批续流空窗里 stream UI 被压制时
 * 停止按钮仍亮，齿轮也必须挂在同一活跃回合上。
 */
export function resolveMessageRowThreadBusy(
  rowIndex: number,
  gearHostRowIndex: number,
  isSending: boolean,
): boolean {
  return !!isSending && gearHostRowIndex >= 0 && rowIndex === gearHostRowIndex
}

/**
 * 忙碌时齿轮挂哪一行：优先续流合并目标；否则可续写的 incomplete/审批气泡；
 * 都没有则 -1（由独立 _stream pin 挂齿轮）。
 */
export function resolveGearHostRowIndex(opts: {
  isSending: boolean
  streamContinuedRowIndex: number
  continuationTargetIndex: number
}): number {
  if (!opts.isSending) return -1
  if (opts.streamContinuedRowIndex >= 0) return opts.streamContinuedRowIndex
  if (opts.continuationTargetIndex >= 0) return opts.continuationTargetIndex
  return -1
}
/**
 * final 后 streamActive grace 残留的空占位清理判定。
 * 仅 isSending=false（本轮已结束）时允许清理；多轮续跑（collab/goal）新一轮
 * run 开始、run_started 尚未写 runId 时 acceptsContinuation=false，isSending=true
 * 期间必须保持「运行中」骨架，否则新流 placeholder 一闪而过消失。
 */
export function shouldDropEmptyStreamPlaceholder(
  emptyPlaceholder: boolean,
  isSending: boolean,
  last:
    | {
        role?: string
        durationStr?: string
        tokenStr?: string
        incompleteStream?: boolean
      }
    | undefined,
  acceptsContinuation: boolean,
): boolean {
  return (
    emptyPlaceholder &&
    !isSending &&
    last?.role === 'assistant' &&
    !!(last.durationStr || last.tokenStr) &&
    !last.incompleteStream &&
    !acceptsContinuation
  )
}
