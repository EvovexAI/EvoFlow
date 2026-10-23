import { WrenchIcon } from "lucide-react";
import { useCallback, type ReactNode } from "react";
import { ToolCallBody } from "@/ToolCallBlocks/ToolCallBody.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  isPlatformToolCall,
  PlatformToolCallBlock,
  readPlatformToolAction,
  readPlatformToolBrief,
} from "@/ToolCallBlocks/renderers/platform.js";
import {
  platformActionShortLabelZh,
  platformDomainLabelZh,
} from "../../../lib/platform-action-labels.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

const FALLBACK_TOOL_ICON = <WrenchIcon className="size-4 shrink-0 text-foreground-subtle" />;

interface FallbackToolCallBlockProps extends ToolCallBlockRenderContext {
  iconOverride?: ReactNode;
  hideRawFallback?: boolean;
  summaryOnly?: boolean;
  summaryTextOverride?: ReactNode;
}

export function FallbackToolCallBlock(context: FallbackToolCallBlockProps) {
  const { intl } = useZCodeIntl();
  const {
    toolCallNode,
    isRunning,
    statusLabel,
    errorText,
    childToolList,
    displayModel,
    workspacePath,
    theme,
    codePreviewSettings,
    onOpenCodeViewer,
    onOpenFileLink,
    onOpenBrowserUrl,
  } = context;
  const { toolCall } = toolCallNode;
  // 兜底：若 resolveRenderer 未认领到 platform，仍避免「Platform / 工具调用」
  if (isPlatformToolCall(toolCall) && !context.summaryOnly) {
    return <PlatformToolCallBlock {...context} />;
  }
  const platformAction = isPlatformToolCall(toolCall)
    ? readPlatformToolAction(toolCall.input)
    : "";
  const platformLabel = platformAction
    ? platformActionShortLabelZh(platformAction, { max: 24 }) ||
      platformDomainLabelZh(platformAction.split(".")[0] || "") ||
      "平台管理"
    : "";
  const platformBrief = platformAction ? readPlatformToolBrief(toolCall.input) : "";
  const kindLabel = platformLabel
    ? "平台"
    : toolCall.kind.length > 0
      ? toolCall.kind[0]!.toUpperCase() + toolCall.kind.slice(1)
      : toolCall.kind;
  const hasInlinePreview = displayModel.inlinePreview.type !== "none";
  const handleLoadFullToolCallFields = context.onLoadFullToolCallFields;
  const renderContent = useCallback(
    () => (
      <>
        <ToolCallBody
          childToolList={childToolList}
          displayModel={displayModel}
          toolCall={toolCall}
          workspacePath={workspacePath}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          onOpenCodeViewer={onOpenCodeViewer}
          onOpenFileLink={onOpenFileLink}
          onOpenBrowserUrl={onOpenBrowserUrl}
        />
        <ToolSnapshotFieldNotice
          refs={toolCall.snapshotRefs ?? []}
          onLoadFullToolCallFields={
            handleLoadFullToolCallFields
              ? () => handleLoadFullToolCallFields(toolCall.toolId)
              : undefined
          }
        />
        {!hasInlinePreview && !context.hideRawFallback ? (
          <pre className="px-4 py-3 rounded-xl bg-surface text-ui-xs mt-1 text-foreground-subtle max-h-50 overflow-auto">
            {JSON.stringify(toolCall, null, 2)}
          </pre>
        ) : null}
      </>
    ),
    [
      childToolList,
      codePreviewSettings,
      displayModel,
      handleLoadFullToolCallFields,
      hasInlinePreview,
      onOpenBrowserUrl,
      onOpenCodeViewer,
      onOpenFileLink,
      theme,
      toolCall,
      workspacePath,
    ],
  );

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={context.iconOverride ?? FALLBACK_TOOL_ICON}
      showIcon={context.showIcon !== false}
      canToggle={context.canToggle ?? true}
      forceOpen={context.forceOpen ?? false}
      kindLabel={context.summaryOnly ? null : (context.kindLabelOverride ?? kindLabel)}
      sourceLabel={context.sourceLabel}
      primaryText={
        context.summaryOnly
          ? (context.summaryTextOverride ?? null)
          : platformLabel
            ? platformBrief
              ? `${platformLabel} · ${platformBrief}`
              : platformLabel
            : (toolCall.title ?? intl.formatMessage({ id: "chat.toolCall.toolCall" }))
      }
      secondaryText={context.summaryOnly || toolCall.status === "failed" ? undefined : statusLabel}
      statusLabel={toolCall.status === "failed" ? statusLabel : undefined}
      statusTooltip={toolCall.status === "failed" ? errorText : undefined}
      showFailureStatus={toolCall.status === "failed"}
      isRunning={isRunning}
      title={
        context.summaryOnly && typeof context.summaryTextOverride === "string"
          ? context.summaryTextOverride
          : platformLabel || toolCall.title
      }
      renderContent={renderContent}
    />
  );
}
