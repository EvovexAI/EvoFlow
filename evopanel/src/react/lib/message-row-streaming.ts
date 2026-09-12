/** 行级流式状态唯一来源：仅续流 merge 目标行在 streamActive 时为 true */
export function resolveMessageRowIsStreaming(
  rowIndex: number,
  streamContinuedRowIndex: number,
  streamActive: boolean,
): boolean {
  return streamContinuedRowIndex >= 0 && rowIndex === streamContinuedRowIndex && streamActive
}
