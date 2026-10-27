/**
 * 带 action 枚举的 builtin 工具卡（tasks / assets）：
 * 折叠条显示「动作 · 摘要」，避免 Fallback 的「工具调用 / 执行中」。
 */
import { useCallback, useMemo, type ReactNode } from "react";
import { ToolCallBody } from "@/ToolCallBlocks/ToolCallBody.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

export type ActionNamedToolConfig = {
  kindLabel: string
  icon: ReactNode
  /** 从 input 解析 action 字面量（含流式半截 JSON） */
  readAction: (input: unknown) => string
  /** action → 中文短标签 */
  labelForAction: (action: string) => string
  /** 折叠条右侧可读摘要 */
  readBrief: (input: unknown) => string
}

export function ActionNamedToolCallBlock({
  context,
  config,
}: {
  context: ToolCallBlockRenderContext
  config: ActionNamedToolConfig
}) {
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
  const action = config.readAction(toolCall.input);
  const actionLabel = config.labelForAction(action);
  const brief = config.readBrief(toolCall.input);
  const kindLabel = context.kindLabelOverride ?? config.kindLabel;
  const primaryText = brief ? `${actionLabel} · ${brief}` : actionLabel;

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
      </>
    ),
    [
      childToolList,
      codePreviewSettings,
      displayModel,
      handleLoadFullToolCallFields,
      onOpenBrowserUrl,
      onOpenCodeViewer,
      onOpenFileLink,
      theme,
      toolCall,
      workspacePath,
    ],
  );

  const primaryTextNode = useMemo(
    () => <span className="min-w-0 truncate text-foreground-subtlest">{primaryText}</span>,
    [primaryText],
  );

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={config.icon}
      showIcon={context.showIcon !== false}
      canToggle={context.canToggle ?? true}
      forceOpen={context.forceOpen ?? false}
      kindLabel={kindLabel}
      sourceLabel={context.sourceLabel}
      primaryText={primaryTextNode}
      secondaryText={toolCall.status === "failed" ? undefined : statusLabel}
      statusLabel={toolCall.status === "failed" ? statusLabel : undefined}
      statusTooltip={toolCall.status === "failed" ? errorText : undefined}
      showFailureStatus={toolCall.status === "failed"}
      isRunning={isRunning}
      title={primaryText}
      renderContent={renderContent}
    />
  );
}
