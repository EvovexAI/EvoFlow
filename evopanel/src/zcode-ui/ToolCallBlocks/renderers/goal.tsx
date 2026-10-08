import { GoalIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

const GOAL_TOOL_ICON = <GoalIcon className="size-4 shrink-0 text-foreground-subtle" />;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNestedValue(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!isPlainRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function normalizeResultValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function isEmptyResultValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === "string") {
    return value.trim().length === 0;
  }
  return false;
}

function stringifyResultValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isSameResultValue(left: unknown, right: unknown): boolean {
  if (isEmptyResultValue(left) || isEmptyResultValue(right)) {
    return false;
  }

  return stringifyResultValue(left) === stringifyResultValue(right);
}

function readPrimaryResult(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): unknown {
  for (const candidate of [
    toolCall.output,
    readNestedValue(toolCall.raw, ["result", "content"]),
    readNestedValue(toolCall.raw, ["rawOutput"]),
    readNestedValue(toolCall.raw, ["output"]),
  ]) {
    const normalized = normalizeResultValue(candidate);
    if (!isEmptyResultValue(normalized)) {
      return normalized;
    }
  }

  return undefined;
}

function readAdditionalContent(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
  primaryResult: unknown,
): unknown {
  for (const candidate of [
    toolCall.content,
    readNestedValue(toolCall.raw, ["content"]),
    readNestedValue(toolCall.raw, ["result", "display"]),
  ]) {
    const normalized = normalizeResultValue(candidate);
    if (!isEmptyResultValue(normalized) && !isSameResultValue(normalized, primaryResult)) {
      return normalized;
    }
  }

  return undefined;
}

function buildGoalResultPayload(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
  errorText: string | undefined,
) {
  const primaryResult = readPrimaryResult(toolCall);
  const content = readAdditionalContent(toolCall, primaryResult);
  const thought = normalizeResultValue(toolCall.thought);
  const payload: Record<string, unknown> = {
    status: toolCall.status,
  };

  if (!isEmptyResultValue(primaryResult)) {
    payload.result = primaryResult;
  }
  if (!isEmptyResultValue(content)) {
    payload.content = content;
  }
  if (
    !isEmptyResultValue(thought) &&
    !isSameResultValue(thought, primaryResult) &&
    !isSameResultValue(thought, content)
  ) {
    payload.thought = thought;
  }
  if (errorText) {
    payload.error = errorText;
  }

  return payload;
}

function formatResultPayload(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function GoalToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const resultPayload = buildGoalResultPayload(toolCall, context.errorText);
  const resultText = formatResultPayload(resultPayload);
  const goalLabel = intl.formatMessage({ id: "chat.toolCall.goal.label" });
  const primaryText = useMemo(
    () => <span className="min-w-0 truncate">{toolCall.title ?? goalLabel}</span>,
    [goalLabel, toolCall.title],
  );
  const handleLoadFullToolCallFields = context.onLoadFullToolCallFields;
  const renderContent = useCallback(
    () => (
      <>
        <div className="space-y-2">
          <h4 className="text-ui-base font-medium uppercase tracking-wide text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.result" })}
          </h4>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface px-3 py-3 font-mono text-ui-base text-foreground">
            {resultText}
          </pre>
        </div>
        <ToolSnapshotFieldNotice
          refs={toolCall.snapshotRefs ?? []}
          onLoadFullToolCallFields={
            handleLoadFullToolCallFields
              ? () => handleLoadFullToolCallFields(toolCall.toolId)
              : undefined
          }
        />
      </>
    ),
    [handleLoadFullToolCallFields, intl, resultText, toolCall.snapshotRefs, toolCall.toolId],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={GOAL_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={context.canToggle ?? true}
        forceOpen={context.forceOpen ?? false}
        kindLabel={goalLabel}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        secondaryText={toolCall.status === "failed" ? undefined : context.statusLabel}
        statusLabel={toolCall.status === "failed" ? context.statusLabel : undefined}
        statusTooltip={toolCall.status === "failed" ? context.errorText : undefined}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={context.isRunning}
        title={toolCall.title}
        renderContent={renderContent}
      />
    </>
  );
}
