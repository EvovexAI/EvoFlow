/** 行级流式状态唯一来源：仅续流 merge 目标行在 streamActive 时为 true */
export function resolveMessageRowIsStreaming(
  rowIndex: number,
  streamContinuedRowIndex: number,
  streamActive: boolean,
): boolean {
  return streamContinuedRowIndex >= 0 && rowIndex === streamContinuedRowIndex && streamActive
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
