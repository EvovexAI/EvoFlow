/**
 * 工作流签 → 拉数绑定解析。
 *
 * 【self-evolution-bot · 2026-11-21 · 第109轮 · 模型:deepseek-v4.1-flash-1017】
 * 为什么单独抽出来：这段判据原来内联在 render-right-stage-body 的 JSX 里，无法被测试盯住，
 * 于是「显式指定了任务却被当前会话覆盖」这个缺陷一路活到了现网。
 * 判据：surface.data.mainTaskId 显式存在时（platform ui.show / panel_set 指定），
 * 绑定必须以它为准 —— 不许继承当前会话的 thread，否则 fetchCollabTaskRow 会先按
 * sessionKey/threadId 反查到**另一个任务**，标题和节点数全错。
 */

export type CollabWorkflowStageBinding = {
  mainTaskId: string
  leadThreadId: string
  /** 与当前会话共享同一任务时才复用会话侧实时数据 */
  useShared: boolean
}

export function resolveCollabWorkflowStageBinding(opts: {
  surfaceData?: Record<string, unknown> | null
  fallbackMainTaskId?: string | null
  fallbackLeadThreadId?: string | null
  sharedMainTask?: unknown
}): CollabWorkflowStageBinding {
  const data = opts.surfaceData || {}
  const explicitMainTaskId = String(data.mainTaskId || '').trim()
  const mainTaskId = String(explicitMainTaskId || opts.fallbackMainTaskId || '').trim()
  // 显式任务时只认 surface.data.leadThreadId，不回落到当前会话 thread
  const leadThreadId = String(
    explicitMainTaskId ? data.leadThreadId || '' : data.leadThreadId || opts.fallbackLeadThreadId || '',
  ).trim()
  const useShared =
    !!mainTaskId &&
    mainTaskId === String(opts.fallbackMainTaskId || '').trim() &&
    opts.sharedMainTask != null
  return { mainTaskId, leadThreadId, useShared }
}
