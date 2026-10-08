import type {
  ActiveWorkSummary,
  ConversationRow,
  PendingInteraction,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * 等待用户操作时，弹窗/问答卡已经是唯一进度反馈，不能再显示 loading。
 * 这里只识别权限确认与 AskUserQuestion；ExitPlanMode 等其它 userInput 语义保持独立。
 * 软门禁后 workspaceHookReview 不再阻塞聊天。
 */
export function hasChatLoadingBlockingInteraction(
  interactions: readonly PendingInteraction[],
): boolean {
  return interactions.some(
    (interaction) =>
      interaction.payload.kind === "permission" ||
      (interaction.payload.kind === "userInput" &&
        interaction.payload.toolName === "AskUserQuestion"),
  );
}

export function hasChatLoadingBlockingActiveWork(
  activeWorks: readonly ActiveWorkSummary[],
): boolean {
  return activeWorks.some((work) => work.kind === "compact" || work.kind === "goalVerifier");
}

function hasChatLoadingBlockingMaintenanceRow(rows: readonly ConversationRow[]): boolean {
  return rows.some(
    (row) =>
      row.kind === "timelineMarker" &&
      ((row.marker.type === "compact" && row.marker.status === "running") ||
        (row.marker.type === "goalVerify" && row.marker.outcome === "running")),
  );
}

export function shouldShowTurnChatLoading({
  blockedByActiveWork,
  blockedByInteraction,
  isLastTurn,
  isRunning,
  rows,
}: {
  blockedByActiveWork: boolean;
  blockedByInteraction: boolean;
  isLastTurn: boolean;
  isRunning: boolean;
  rows: readonly ConversationRow[];
}): boolean {
  if (!isLastTurn || !isRunning || blockedByActiveWork || blockedByInteraction) {
    return false;
  }

  // pendingInteractions / activeWorks 是权威事实源，但恢复或乱序窗口
  // 可能先只有行状态；行级 fallback 避免权限、compact、goal verifier 已出现时
  // 底部 loading 短暂闪回。
  return (
    !rows.some((row) => row.kind === "toolCall" && row.status === "pendingApproval") &&
    !hasChatLoadingBlockingMaintenanceRow(rows)
  );
}
