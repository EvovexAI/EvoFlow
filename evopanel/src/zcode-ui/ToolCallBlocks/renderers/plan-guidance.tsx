import { NotepadText } from "lucide-react";
import { useCallback } from "react";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { ToolOutput } from "@/components/ai-elements/tool.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getToolCallErrorText } from "@/lib/toolError.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

const PLAN_GUIDANCE_TOOL_ICON = <NotepadText className="size-4 shrink-0 text-foreground-subtle" />;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return undefined;
}

function extractGuidanceMarkdown(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): string | undefined {
  for (const candidate of [toolCall.output, toolCall.input]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }

    if (isRecord(candidate)) {
      const directText = readStringField(candidate, ["text", "content", "output"]);
      if (directText) {
        return directText;
      }
    }
  }

  if (!isRecord(toolCall.raw)) {
    return undefined;
  }

  const rawOutputText =
    typeof toolCall.raw.rawOutput === "string"
      ? toolCall.raw.rawOutput.trim()
      : isRecord(toolCall.raw.rawOutput)
        ? readStringField(toolCall.raw.rawOutput, ["text", "content", "output"])
        : undefined;
  if (rawOutputText) {
    return rawOutputText;
  }

  const content = Array.isArray(toolCall.raw.content) ? toolCall.raw.content : [];
  for (const item of content) {
    if (!isRecord(item)) {
      continue;
    }

    const nested = isRecord(item.content) ? item.content : item;
    const nestedText = readStringField(nested, ["text", "content", "output"]);
    if (nestedText) {
      return nestedText;
    }
  }

  return undefined;
}

export function PlanGuidanceToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const errorText = getToolCallErrorText(toolCall);
  const guidanceMarkdown = extractGuidanceMarkdown(toolCall);
  const renderContent = useCallback(
    () =>
      guidanceMarkdown ? (
        <div className="ml-2 space-y-2 border-border border-l pl-3.5 border-border">
          <MessageResponse
            className="min-w-0 break-words [&_h1]:text-foreground-subtlest [&_h2]:text-foreground-subtlest [&_h3]:text-foreground-subtlest [&_li]:text-foreground-subtlest [&_p]:text-foreground-subtlest"
            workspacePath={context.workspacePath}
            theme={context.theme}
            codePreviewSettings={context.codePreviewSettings}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            onOpenExternalUrl={context.onOpenBrowserUrl}
          >
            {guidanceMarkdown}
          </MessageResponse>
        </div>
      ) : (
        <ToolOutput errorText={errorText} output={errorText ? undefined : toolCall.output} />
      ),
    [
      context.codePreviewSettings,
      context.onOpenBrowserUrl,
      context.onOpenCodeViewer,
      context.onOpenFileLink,
      context.theme,
      context.workspacePath,
      errorText,
      guidanceMarkdown,
      toolCall.output,
    ],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={PLAN_GUIDANCE_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={context.canToggle ?? true}
        forceOpen={context.forceOpen ?? false}
        kindLabel={intl.formatMessage({ id: "planTool.guidance.enterMode" })}
        sourceLabel={context.sourceLabel}
        primaryText={null}
        secondaryText={undefined}
        statusLabel={toolCall.status === "failed" ? context.statusLabel : undefined}
        statusTooltip={toolCall.status === "failed" ? errorText : undefined}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={context.isRunning}
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
