import { SquareTerminalIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { getExecuteSecondaryText } from "@/ToolCallBlocks/renderers/execute.js";

const EXECUTE_GROUP_ICON = (
  <SquareTerminalIcon className="size-4 shrink-0 text-foreground-subtle" />
);

// V4 row 进入共享 renderer 前会把 inputStreaming/pendingApproval 统一适配为 pending。
const ACTIVE_STATUSES = new Set(["pending", "in_progress"]);

function formatCompletedSummary(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  childStatuses: string[],
) {
  const parts = [
    intl.formatMessage(
      {
        id:
          childStatuses.length === 1
            ? "chat.toolCall.executeGroup.command.one"
            : "chat.toolCall.executeGroup.command.other",
      },
      { count: childStatuses.length },
    ),
  ];
  const failedCount = childStatuses.filter((status) => status === "failed").length;
  const stoppedCount = childStatuses.filter((status) => status === "stopped").length;
  if (failedCount > 0) {
    parts.push(
      intl.formatMessage({ id: "chat.toolCall.executeGroup.failed" }, { count: failedCount }),
    );
  }
  if (stoppedCount > 0) {
    parts.push(
      intl.formatMessage({ id: "chat.toolCall.executeGroup.stopped" }, { count: stoppedCount }),
    );
  }
  return parts.join(", ");
}

export function ExecuteGroupToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCallNode, isRunning, statusLabel, isOfficeMode = false } = context;
  const { toolCall, childToolCalls } = toolCallNode;
  const latestActiveChild = childToolCalls.findLast((child) =>
    ACTIVE_STATUSES.has(child.toolCall.status),
  );
  const latestChild = latestActiveChild ?? childToolCalls.at(-1);
  const latestCommand =
    !isOfficeMode && latestChild ? getExecuteSecondaryText(latestChild.toolCall.input) : undefined;
  const runningActionLabel = latestCommand
    ? intl.formatMessage({ id: "chat.toolCall.execute.running" })
    : undefined;
  const runningPrimaryText = useMemo(
    () =>
      runningActionLabel ? (
        <span className="shrink-0 text-foreground-subtle">{runningActionLabel}</span>
      ) : null,
    [runningActionLabel],
  );
  const runningSecondaryText = useMemo(
    () =>
      latestCommand ? (
        // Tailwind v4 preflight 会给 code 默认 mono 字体，
        // 不显式指定时运行态命令会和 execute/explore 收起态的 sans 约定不一致。
        <code className="min-w-0 truncate font-sans">{latestCommand}</code>
      ) : undefined,
    [latestCommand],
  );
  const completedSummary = formatCompletedSummary(
    intl,
    childToolCalls.map((child) => child.toolCall.status),
  );
  const renderContent = useCallback(
    () => (
      <div className="ml-2 space-y-2 border-border border-l pl-3.5">
        {childToolCalls.map((child) => (
          <ToolCallBlock
            key={child.toolCall.toolId}
            toolCallNode={child}
            workspacePath={context.workspacePath}
            showIcon={false}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
            onOpenAutomationsMain={context.onOpenAutomationsMain}
            onLoadFullToolCallFields={context.onLoadFullToolCallFields}
          />
        ))}
      </div>
    ),
    [
      childToolCalls,
      context.onLoadFullToolCallFields,
      context.onOpenAutomationsMain,
      context.onOpenBrowserUrl,
      context.onOpenCodeViewer,
      context.onOpenFileLink,
      context.workspacePath,
    ],
  );

  // 只在 Execute 阶段运行时滚动新增 command；阶段结束必须立即清空旧队列并显示最终统计。
  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={EXECUTE_GROUP_ICON}
      canToggle={!isOfficeMode && (context.canToggle ?? true)}
      forceOpen={!isOfficeMode && (context.forceOpen ?? false)}
      kindLabel={intl.formatMessage({ id: "chat.toolCall.executeGroup.label" })}
      expandedKindLabel={intl.formatMessage({
        id: "chat.toolCall.executeGroup.label",
      })}
      primaryText={isRunning && runningActionLabel ? runningPrimaryText : completedSummary}
      secondaryText={isRunning ? runningSecondaryText : undefined}
      summaryContentSeparator="·"
      expandedPrimaryText={completedSummary}
      // ToolLayout 默认会在展开态沿用 secondaryText，导致命令数量后残留当前命令。
      // 父组展开后由子 tool summary 表达当前命令，因此这里必须显式清空。
      expandedSecondaryText={null}
      animateSummaryContent={isRunning}
      disableSummaryContentAnimation={context.disableSummaryContentAnimation}
      summaryContentKey={
        isRunning && latestChild
          ? `execute:${toolCall.toolId}:${latestChild.toolCall.toolId}:${runningActionLabel ?? "running"}:${latestCommand ?? "command"}`
          : `execute:${toolCall.toolId}:done:${completedSummary}`
      }
      statusLabel={statusLabel}
      isRunning={isRunning}
      title={isOfficeMode ? undefined : isRunning && latestCommand ? latestCommand : toolCall.title}
      expandedTitle={toolCall.title}
      renderContent={renderContent}
    />
  );
}
