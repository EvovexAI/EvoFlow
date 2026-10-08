import { CircleStopIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";

const TASK_STOP_TOOL_ICON = <CircleStopIcon className="size-4 shrink-0 text-foreground-subtle" />;

const HOOK_ADDITIONAL_CONTEXT_MARKER = "\n\n[Hook additional context]";

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  const markerIndex = value.indexOf(HOOK_ADDITIONAL_CONTEXT_MARKER);
  const serialized = markerIndex >= 0 ? value.slice(0, markerIndex) : value;
  try {
    const parsed: unknown = JSON.parse(serialized);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readStringField(
  value: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return undefined;
}

function readRawRecord(raw: unknown, keys: readonly string[]) {
  const record = toRecord(raw);
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = toRecord(record[key]);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

function compactLegacyTaskStopResult(
  message: string | undefined,
  taskId: string | undefined,
  command: string | undefined,
): string | undefined {
  if (!message || !taskId || command === undefined) {
    return message;
  }

  // 旧 snapshot 只保存了会重复 command/prompt 的标准成功文案。
  // 仅做完整模板匹配，避免裁剪 provider 返回的自定义结果。
  const standardMessage = `Successfully stopped task: ${taskId} (${command})`;
  return message === standardMessage ? `Successfully stopped task: ${taskId}` : message;
}

function DetailField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="space-y-1">
      <dt className="text-ui-base font-medium text-foreground-subtle">{label}</dt>
      <dd
        className={
          mono
            ? "whitespace-pre-wrap break-words font-mono text-ui-base text-foreground"
            : "whitespace-pre-wrap break-words text-ui-base leading-5 text-foreground"
        }
      >
        {value}
      </dd>
    </div>
  );
}

export function TaskStopToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const display = readToolResultDisplay(toolCall.raw);
  const taskStopDisplay = display?.kind === "task_stop" ? display : undefined;
  const input = toRecord(toolCall.input) ?? readRawRecord(toolCall.raw, ["rawInput", "input"]);
  const output = toRecord(toolCall.output) ?? readRawRecord(toolCall.raw, ["rawOutput", "output"]);
  const taskId =
    taskStopDisplay?.taskId ??
    readStringField(output, ["task_id"]) ??
    readStringField(input, ["task_id", "shell_id"]);
  const taskType = taskStopDisplay?.taskType ?? readStringField(output, ["task_type"]);
  const displayCommand = taskStopDisplay?.command;
  const legacyCommand = readStringField(output, ["command"]);
  const isLocalAgentTask = taskType === "local_agent";
  // 旧 local_agent 快照的 command 可能是完整 prompt，只有 Core 投影的 display 才能作为短 description 展示。
  const taskDetail = isLocalAgentTask ? displayCommand : (displayCommand ?? legacyCommand);
  const resultCommand = displayCommand ?? legacyCommand;
  const outputMessage = taskStopDisplay?.message ?? readStringField(output, ["message"]);
  const detailsTruncated = taskStopDisplay?.truncated === true;
  const isDenied = toolCall.status === "denied";
  const isStopped = toolCall.status === "stopped";
  const isFailed = toolCall.status === "failed";
  const isUnsuccessful = isFailed || isDenied || isStopped;
  const resultMessage = isUnsuccessful
    ? (context.errorText ?? outputMessage)
    : compactLegacyTaskStopResult(outputMessage, taskId, resultCommand);
  const hasDetails = Boolean(taskType || taskDetail || resultMessage || detailsTruncated);
  const kindLabelId = context.isRunning
    ? "chat.toolCall.taskStop.stopping"
    : "chat.toolCall.kind.taskStop";
  const statusLabelId = isFailed
    ? "chat.toolCall.status.failed"
    : isDenied
      ? "chat.toolCall.status.denied"
      : isStopped
        ? "chat.toolCall.status.stopped"
        : undefined;
  const primaryText = useMemo(
    () => (
      <code className="min-w-0 truncate font-mono">{taskId ?? toolCall.title ?? "TaskStop"}</code>
    ),
    [taskId, toolCall.title],
  );
  const renderContent = useCallback(
    () => (
      <div className="rounded-lg border border-border bg-panel px-4 py-3">
        <dl className="space-y-3">
          {taskType ? (
            <DetailField
              label={intl.formatMessage({ id: "chat.toolCall.taskStop.taskType" })}
              value={taskType}
              mono
            />
          ) : null}
          {taskDetail ? (
            <DetailField
              label={intl.formatMessage({
                id: isLocalAgentTask
                  ? "chat.toolCall.taskStop.description"
                  : "chat.toolCall.taskStop.command",
              })}
              value={taskDetail}
              mono={!isLocalAgentTask}
            />
          ) : null}
          {resultMessage ? (
            <DetailField
              label={intl.formatMessage({ id: "chat.toolCall.taskStop.result" })}
              value={resultMessage}
            />
          ) : null}
        </dl>
        {detailsTruncated ? (
          <p className="mt-3 text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.taskStop.truncated" })}
          </p>
        ) : null}
      </div>
    ),
    [detailsTruncated, intl, isLocalAgentTask, resultMessage, taskDetail, taskType],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={TASK_STOP_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={hasDetails && (context.canToggle ?? true)}
        forceOpen={hasDetails && (context.forceOpen ?? false)}
        kindLabel={intl.formatMessage({ id: kindLabelId })}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        statusLabel={statusLabelId ? intl.formatMessage({ id: statusLabelId }) : undefined}
        showStatusLabel={statusLabelId != null}
        statusTooltip={isFailed ? resultMessage : undefined}
        showFailureStatus={isFailed}
        isRunning={context.isRunning}
        title={toolCall.title}
        renderContent={hasDetails ? renderContent : undefined}
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
