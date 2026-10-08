import { ReplyIcon } from "lucide-react";
import { useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";

const RESPOND_TO_COORDINATOR_TOOL_ICON = (
  <ReplyIcon className="size-4 shrink-0 text-foreground-subtle" />
);

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

function readSummary(input: unknown): string | undefined {
  const summary = toRecord(input)?.summary;
  return typeof summary === "string" && summary.trim().length > 0 ? summary : undefined;
}

export function RespondToCoordinatorToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const display = readToolResultDisplay(toolCall.raw);
  const responseDisplay = display?.kind === "respond_to_coordinator" ? display : undefined;
  const summary = readSummary(toolCall.input);
  const isDenied = toolCall.status === "denied";
  const isStopped = toolCall.status === "stopped";
  const isExecutionFailed = toolCall.status === "failed";
  const isFailed =
    !isDenied && !isStopped && (isExecutionFailed || responseDisplay?.status === "failed");
  const kindLabelId = context.isRunning
    ? "chat.toolCall.respondToCoordinator.replying"
    : "chat.toolCall.kind.response";
  const statusLabelId = isFailed
    ? "chat.toolCall.status.failed"
    : isDenied
      ? "chat.toolCall.status.denied"
      : isStopped
        ? "chat.toolCall.status.stopped"
        : responseDisplay?.status === "success"
          ? "chat.toolCall.respondToCoordinator.queued"
          : undefined;
  const primaryText = useMemo(
    () => (
      <span className="min-w-0 truncate">
        {summary ?? toolCall.title ?? "RespondToCoordinator"}
      </span>
    ),
    [summary, toolCall.title],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={RESPOND_TO_COORDINATOR_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={false}
        kindLabel={intl.formatMessage({ id: kindLabelId })}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        statusLabel={statusLabelId ? intl.formatMessage({ id: statusLabelId }) : undefined}
        showStatusLabel={statusLabelId != null}
        statusTooltip={isExecutionFailed ? context.errorText : undefined}
        showFailureStatus={isFailed}
        isRunning={context.isRunning}
        title={toolCall.title}
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
