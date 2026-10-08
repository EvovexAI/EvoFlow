import type { ConversationRow, WorkflowLaunchMeta } from "@zcode/shared/zcode-protocol-v4";

/**
 * 直接启动的来龙去脉：作用域、说明、实参与
 * 「由你从工作流中枢启动」的时刻。只有中枢启动的 run 才有——它挂在启动轮 turnHeader / userInput 行的
 * `workflowLaunch` 元数据上（同一个 toolCallId）；工具路径发起的 run 在行窗口里找不到这一份，返回
 * undefined，侧板便没有这一节。turnHeader 优先（活投影权威，`startedAt` 就是启动时刻），回落到用户
 * 可见行上的同一份（冷恢复 hydration 也写在 userInput 行）。
 */
interface WorkflowLaunchProvenance {
  meta: WorkflowLaunchMeta;
  startedAt?: number;
}

export function resolveWorkflowLaunchProvenance(
  rows: readonly ConversationRow[] | undefined,
  toolCallId: string,
): WorkflowLaunchProvenance | undefined {
  let fallback: WorkflowLaunchProvenance | undefined;
  for (const row of rows ?? []) {
    if (row.kind === "turnHeader" && row.workflowLaunch?.toolCallId === toolCallId) {
      return { meta: row.workflowLaunch, startedAt: row.startedAt };
    }
    if (
      fallback === undefined &&
      row.kind === "userInput" &&
      row.workflowLaunch?.toolCallId === toolCallId
    ) {
      fallback = { meta: row.workflowLaunch, startedAt: row.createdAt };
    }
  }
  return fallback;
}
