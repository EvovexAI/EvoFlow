import { FileOutputIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";

const TASK_OUTPUT_TOOL_ICON = <FileOutputIcon className="size-4 shrink-0 text-foreground-subtle" />;

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readTaskId(input: unknown): string | undefined {
  const taskId = toRecord(input)?.task_id;
  return typeof taskId === "string" && taskId.trim().length > 0 ? taskId : undefined;
}

function isFailedTaskStatus(status: string | undefined): boolean {
  const normalized = status?.trim().toLowerCase();
  return normalized === "failed" || normalized === "lost";
}

function isStoppedTaskStatus(status: string | undefined): boolean {
  const normalized = status?.trim().toLowerCase();
  return normalized === "cancelled" || normalized === "killed" || normalized === "stopped";
}

export function TaskOutputToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const display = readToolResultDisplay(toolCall.raw);
  const taskOutputDisplay = display?.kind === "task_output" ? display : undefined;
  const taskId = readTaskId(toolCall.input);
  const taskStatus = taskOutputDisplay?.taskStatus;
  const normalizedTaskStatus = taskStatus?.trim().toLowerCase();
  const isDenied = toolCall.status === "denied";
  const isStopped = toolCall.status === "stopped";
  const isExecutionFailed = toolCall.status === "failed";
  const isTaskFailed = isFailedTaskStatus(taskStatus);
  const showFailureStatus = !isDenied && !isStopped && (isExecutionFailed || isTaskFailed);
  const output = taskOutputDisplay?.output;
  const hasOutput = output !== undefined;

  let outcomeLabel: string | undefined;
  if (isExecutionFailed) {
    outcomeLabel = intl.formatMessage({ id: "chat.toolCall.status.failed" });
  } else if (isDenied) {
    outcomeLabel = intl.formatMessage({ id: "chat.toolCall.status.denied" });
  } else if (isStopped) {
    outcomeLabel = intl.formatMessage({ id: "chat.toolCall.status.stopped" });
  } else if (taskOutputDisplay?.retrievalStatus === "not_ready") {
    outcomeLabel = intl.formatMessage({ id: "chat.toolCall.taskOutput.running" });
  } else if (taskOutputDisplay?.retrievalStatus === "timeout") {
    outcomeLabel = intl.formatMessage({ id: "chat.toolCall.taskOutput.timeout" });
  } else if (isTaskFailed) {
    outcomeLabel = intl.formatMessage({ id: "chat.toolCall.taskOutput.taskFailed" });
  } else if (isStoppedTaskStatus(taskStatus)) {
    outcomeLabel = intl.formatMessage({ id: "chat.toolCall.taskOutput.taskStopped" });
  } else if (normalizedTaskStatus === "pending" || normalizedTaskStatus === "running") {
    outcomeLabel = intl.formatMessage({ id: "chat.toolCall.taskOutput.running" });
  } else if (normalizedTaskStatus && normalizedTaskStatus !== "completed") {
    outcomeLabel = taskStatus ?? normalizedTaskStatus;
  } else if (taskOutputDisplay?.retrievalStatus === "success") {
    // 类别标签只能说明这是 TaskOutput，不能替代 display 已确认的成功读取结果。
    outcomeLabel = intl.formatMessage({ id: "chat.toolCall.taskOutput.retrieved" });
  }
  const kindLabel = intl.formatMessage({
    id: context.isRunning ? "chat.toolCall.taskOutput.fetching" : "chat.toolCall.kind.taskOutput",
  });

  const primaryText = useMemo(
    () => (
      <code className="min-w-0 truncate font-mono">{taskId ?? toolCall.title ?? "TaskOutput"}</code>
    ),
    [taskId, toolCall.title],
  );
  const renderContent = useCallback(
    () => (
      <div className="rounded-lg border border-border bg-panel px-4 py-3">
        <pre className="max-h-25 overflow-auto whitespace-pre-wrap break-words font-mono text-ui-base text-foreground-subtle">
          {output}
        </pre>
        {taskOutputDisplay?.truncated === true ? (
          <p className="mt-3 text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.taskOutput.truncated" })}
          </p>
        ) : null}
      </div>
    ),
    [intl, output, taskOutputDisplay?.truncated],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={TASK_OUTPUT_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={hasOutput && (context.canToggle ?? true)}
        forceOpen={hasOutput && (context.forceOpen ?? false)}
        kindLabel={kindLabel}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        statusLabel={outcomeLabel}
        showStatusLabel={outcomeLabel != null}
        statusTooltip={isExecutionFailed ? context.errorText : undefined}
        showFailureStatus={showFailureStatus}
        isRunning={context.isRunning}
        title={toolCall.title}
        renderContent={hasOutput ? renderContent : undefined}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </>
  );
}
