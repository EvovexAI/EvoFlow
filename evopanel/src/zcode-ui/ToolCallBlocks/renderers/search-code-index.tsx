/**
 * search_code_index 专属工具卡（V4 面板）。
 *
 * 必须在 family=search 之前认领：否则会落到不可展开的 SearchToolCallBlock。
 * 卡面与 assets / platform 对齐——折叠条用 kind + 摘要 + secondary 状态，
 * 展开区直接出检索报告，不走 ai-elements 那套 Parameters / Result 大写分区。
 */
import { SearchIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { getSearchPrimaryText } from "@/ToolCallBlocks/renderers/search.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

const SEARCH_CODE_INDEX_ICON = (
  <SearchIcon className="size-4 shrink-0 text-foreground-subtle" />
);

/** 工具名识别：只认 `search_code_index`，不与 `search_content` / `search` 混。 */
export function isSearchCodeIndexToolCall(toolCall: {
  toolName?: string | null;
  kind?: string | null;
}): boolean {
  const name = String(toolCall.toolName || "").trim().toLowerCase();
  if (name === "search_code_index") {
    return true;
  }
  const rawKind = toolCall.kind as unknown;
  const kindList = Array.isArray(rawKind) ? rawKind : [rawKind];
  return kindList.some(
    (item) => String(item || "").trim().toLowerCase() === "search_code_index",
  );
}

/** 从工具正文抽出 `[index] …` 时效性行，折叠条旁 / 展开顶栏可复用。 */
export function readSearchCodeIndexFreshness(output: unknown): string {
  const text = typeof output === "string" ? output : "";
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  const notes: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith("[index]")) {
      if (notes.length > 0) break;
      continue;
    }
    notes.push(trimmed.replace(/^\[index\]\s*/i, "").trim());
    if (notes.length >= 2) break;
  }
  return notes.filter(Boolean).join(" · ");
}

function readOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output == null) return "";
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

/**
 * 与 search family 默认一致：摘要行已有 query，展开只露结果。
 * 仍导出供单测锁定「不得退回 Parameters 复古分区」。
 */
export function buildSearchCodeIndexDisplayModel(
  base: ToolCallBlockRenderContext["displayModel"],
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
  errorText?: string,
): ToolCallBlockRenderContext["displayModel"] {
  return {
    ...base,
    inlinePreview: { type: "none" },
    showSummaryFileLink: false,
    showInput: false,
    showOutput: toolCall.output !== undefined || Boolean(errorText),
    showKind: false,
  };
}

export function SearchCodeIndexToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCallNode, isRunning, statusLabel, errorText } = context;
  const { toolCall } = toolCallNode;

  const summaryText = getSearchPrimaryText(intl, toolCall.input);
  const outputText = readOutputText(toolCall.output);
  const freshness = useMemo(
    () => readSearchCodeIndexFreshness(toolCall.output),
    [toolCall.output],
  );
  const primaryText = useMemo(
    () => <span className="min-w-0 truncate text-foreground-subtlest">{summaryText}</span>,
    [summaryText],
  );

  const handleLoadFullToolCallFields = context.onLoadFullToolCallFields;
  const renderContent = useCallback(() => {
    if (errorText) {
      return (
        <div className="max-h-60 overflow-auto rounded-xl border border-border bg-destructive/10 px-3 py-3 text-ui-sm text-destructive whitespace-pre-wrap break-words">
          {errorText}
        </div>
      );
    }
    if (!outputText.trim()) {
      return (
        <p className="px-1 text-ui-sm text-foreground-subtlest">
          {isRunning ? "检索中…" : "暂无检索结果"}
        </p>
      );
    }
    return (
      <>
        {freshness ? (
          <p className="mb-2 px-1 text-ui-sm text-foreground-subtlest">{freshness}</p>
        ) : null}
        <pre className="max-h-60 overflow-auto rounded-xl border border-border bg-muted/15 px-3 py-3 text-ui-sm whitespace-pre-wrap break-words text-foreground">
          {outputText}
        </pre>
        <ToolSnapshotFieldNotice
          refs={toolCall.snapshotRefs ?? []}
          onLoadFullToolCallFields={
            handleLoadFullToolCallFields
              ? () => handleLoadFullToolCallFields(toolCall.toolId)
              : undefined
          }
        />
      </>
    );
  }, [
    errorText,
    freshness,
    handleLoadFullToolCallFields,
    isRunning,
    outputText,
    toolCall.snapshotRefs,
    toolCall.toolId,
  ]);

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={SEARCH_CODE_INDEX_ICON}
      showIcon={context.showIcon !== false}
      canToggle={context.canToggle ?? true}
      forceOpen={context.forceOpen ?? false}
      kindLabel={context.kindLabelOverride ?? "代码索引"}
      sourceLabel={context.sourceLabel}
      primaryText={primaryText}
      // 与 assets / platform 同一套：成功态状态词走 secondary，失败才抬到 statusLabel。
      secondaryText={toolCall.status === "failed" ? undefined : statusLabel}
      statusLabel={toolCall.status === "failed" ? statusLabel : undefined}
      statusTooltip={toolCall.status === "failed" ? errorText : undefined}
      showFailureStatus={toolCall.status === "failed"}
      isRunning={isRunning}
      title={summaryText}
      renderContent={renderContent}
    />
  );
}
