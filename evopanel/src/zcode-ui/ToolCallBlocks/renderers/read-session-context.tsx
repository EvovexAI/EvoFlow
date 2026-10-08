import { BookOpenTextIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

const READ_SESSION_CONTEXT_TOOL_ICON = (
  <BookOpenTextIcon className="size-4 shrink-0 text-foreground-subtle" />
);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return undefined;
}

function readNestedRecordField(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = value[key];
    if (isPlainRecord(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function extractTextContent(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? value : undefined;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractTextContent(item))
      .filter((item): item is string => item !== undefined);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  if (!isPlainRecord(value)) {
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      return String(value);
    }

    return undefined;
  }

  const directText = readStringField(value, [
    "content",
    "output",
    "result",
    "text",
    "message",
    "error",
  ]);
  if (directText) {
    return directText;
  }

  const nestedRecord = readNestedRecordField(value, ["rawOutput", "output"]);
  if (nestedRecord) {
    const nestedText = extractTextContent(nestedRecord);
    if (nestedText) {
      return nestedText;
    }
  }

  const content = value.content;
  if (Array.isArray(content)) {
    const contentText = extractTextContent(content);
    if (contentText) {
      return contentText;
    }
  }

  return undefined;
}

function readRawInput(raw: unknown): unknown {
  if (!isPlainRecord(raw)) {
    return undefined;
  }

  return raw.rawInput ?? raw.input;
}

function readRawOutput(raw: unknown): unknown {
  if (!isPlainRecord(raw)) {
    return undefined;
  }

  return raw.rawOutput ?? raw.output;
}

function extractQuery(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): string | undefined {
  if (typeof toolCall.input === "string") {
    const trimmed = toolCall.input.trim();
    return trimmed.length > 0 ? toolCall.input : undefined;
  }

  for (const candidate of [
    toolCall.input,
    toolCall.output,
    readRawInput(toolCall.raw),
    readRawOutput(toolCall.raw),
  ]) {
    if (!isPlainRecord(candidate)) {
      continue;
    }

    const query = readStringField(candidate, ["query", "prompt", "question"]);
    if (query) {
      return query;
    }
  }

  return undefined;
}

function extractSessionId(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): string | undefined {
  for (const candidate of [
    toolCall.input,
    toolCall.output,
    readRawInput(toolCall.raw),
    readRawOutput(toolCall.raw),
  ]) {
    if (!isPlainRecord(candidate)) {
      continue;
    }

    const sessionId = readStringField(candidate, ["sessionId", "session_id"]);
    if (sessionId) {
      return sessionId;
    }
  }

  return undefined;
}

function extractResultContent(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): string | undefined {
  const outputText = extractTextContent(toolCall.output);
  if (outputText) {
    return outputText;
  }

  return extractTextContent(readRawOutput(toolCall.raw));
}

export function ReadSessionContextToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCallNode, isRunning, statusLabel, errorText } = context;
  const { toolCall } = toolCallNode;
  const query = extractQuery(toolCall);
  const sessionId = extractSessionId(toolCall);
  const resultContent = extractResultContent(toolCall);
  const visibleResult = toolCall.status === "failed" ? errorText : resultContent;
  const fallbackTitle = intl.formatMessage({ id: "chat.toolCall.sessionContext.title" });
  const primaryText = useMemo(
    () => <span className="min-w-0 truncate">{query ?? toolCall.title ?? fallbackTitle}</span>,
    [fallbackTitle, query, toolCall.title],
  );
  const secondaryText = useMemo(
    () =>
      sessionId ? (
        <code className="min-w-0 truncate rounded-md bg-surface px-1.5 py-0.5 font-mono text-ui-base text-foreground-subtle">
          {sessionId}
        </code>
      ) : undefined,
    [sessionId],
  );
  const renderContent = useCallback(
    () => (
      <div className="space-y-3 rounded-xl border border-border bg-panel px-4 py-3">
        {query ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-base font-medium uppercase text-foreground-subtle">
              {intl.formatMessage({
                id: "chat.toolCall.sessionContext.query",
              })}
            </h4>
            <p className="whitespace-pre-wrap break-words text-ui-base text-foreground">{query}</p>
          </section>
        ) : null}
        <section className="space-y-1.5">
          <h4 className="text-ui-base font-medium uppercase text-foreground-subtle">
            {intl.formatMessage({
              id: "chat.toolCall.sessionContext.result",
            })}
          </h4>
          {visibleResult ? (
            <MessageResponse
              className="min-w-0 break-words text-ui-base"
              workspacePath={context.workspacePath}
              theme={context.theme}
              codePreviewSettings={context.codePreviewSettings}
              onOpenCodeViewer={context.onOpenCodeViewer}
              onOpenFileLink={context.onOpenFileLink}
              onOpenExternalUrl={context.onOpenBrowserUrl}
            >
              {visibleResult}
            </MessageResponse>
          ) : (
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({
                id: "chat.toolCall.sessionContext.noResult",
              })}
            </p>
          )}
        </section>
      </div>
    ),
    [
      context.codePreviewSettings,
      context.onOpenBrowserUrl,
      context.onOpenCodeViewer,
      context.onOpenFileLink,
      context.theme,
      context.workspacePath,
      intl,
      query,
      visibleResult,
    ],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={READ_SESSION_CONTEXT_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={context.canToggle ?? true}
        forceOpen={context.forceOpen ?? false}
        hideSecondaryTextWhenOpen
        kindLabel={intl.formatMessage({
          id: isRunning
            ? "chat.toolCall.sessionContext.reading"
            : "chat.toolCall.kind.sessionContext",
        })}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        secondaryText={secondaryText}
        statusLabel={statusLabel}
        statusTooltip={toolCall.status === "failed" ? errorText : undefined}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={isRunning}
        title={toolCall.title}
        renderContent={renderContent}
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
