/**
 * search_code_index 专属工具卡（V4 面板）。
 *
 * 【self-evolution-bot · 2026-11-17 · 第33轮】用户报：「调用 search_code_index 后，
 * V4 面板只能看到工具被调用了，看不到下拉的搜索结果，点了也展不开」。
 *
 * 根因（不是没命中 renderer，是命中了不该命中的那个）：
 * `lib/toolIdentity.ts` 的 `resolveLegacyKindFamily` 用
 *   /^(?:search|grep|find|…)(?:_|$)/
 * 判 family，`search_code_index` 以 `search_` 开头 → 落进 `search` family →
 * `resolveRenderer.ts` 返回 `SearchToolCallBlock`。而那个组件是给「一行摘要式检索」
 * 设计的，写死了 `canToggle={false}` 且 `content={null}`，于是：
 *   - 摘要能显示（所以「能看到工具被调用了」）
 *   - 展开被 `isExpanded = !hasSummaryAction && (forceOpen || (canToggle && isOpen))`
 *     永久压成 false（canToggle=false）→ 点了没反应
 *   - 内容恒为 null → 就算展开也没有东西
 *
 * 为什么不直接把 `search.tsx` 的 canToggle 改成 true：
 * 那个组件同时服务 web_search / grep / find / glob / list 等大量工具，
 * 它们的结果是「一行一条」，展开只会多出一堆噪音；而 search_code_index 的
 * 结果是一份结构化检索报告（Symbols / Content / Imports / Read catalog），
 * 必须能展开读。两者卡面语义不同，按仓库既有惯例「按工具名先分流、排在 family 之前」
 * 单独立卡（同 platform / tasks / assets / knowledge 的做法）。
 */
import { SearchIcon } from "lucide-react";
import { useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolCallBody } from "@/ToolCallBlocks/ToolCallBody.js";
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
  // kind 是数组型（ChatToolCall.kind: string[]）时按任一元素命中；旧投影给的是字符串。
  const rawKind = toolCall.kind as unknown;
  const kindList = Array.isArray(rawKind) ? rawKind : [rawKind];
  return kindList.some(
    (item) => String(item || "").trim().toLowerCase() === "search_code_index",
  );
}

/** 覆盖 search family 默认「只露 Result」：代码索引卡必须能看 Parameters + Result。 */
export function buildSearchCodeIndexDisplayModel(
  base: ToolCallBlockRenderContext["displayModel"],
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
  errorText?: string,
): ToolCallBlockRenderContext["displayModel"] {
  return {
    ...base,
    inlinePreview: { type: "none" },
    showSummaryFileLink: false,
    showInput: toolCall.input !== undefined,
    showOutput: toolCall.output !== undefined || Boolean(errorText),
    showKind: false,
  };
}

export function SearchCodeIndexToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCallNode, isRunning, statusLabel, errorText } = context;
  const { toolCall } = toolCallNode;

  // 摘要行复用检索族已有的文案解析（识得 query / queries 两种入参形态），
  // 保证「参数怎么填都能读出一句人话」，而不是把整包 JSON 摊在标题里。
  const summaryText = getSearchPrimaryText(intl, toolCall.input);
  const primaryText = useMemo(
    () => <span className="truncate">{summaryText}</span>,
    [summaryText],
  );
  const displayModel = useMemo(
    () => buildSearchCodeIndexDisplayModel(context.displayModel, toolCall, errorText),
    [context.displayModel, toolCall, errorText],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={SEARCH_CODE_INDEX_ICON}
        showIcon={context.showIcon !== false}
        // 与 search.tsx 的 canToggle={false} 相反：本工具的产出一份结构化检索报告，
        // 用户的核心诉求就是「点开看命中了哪些文件」。
        canToggle={context.canToggle ?? true}
        forceOpen={context.forceOpen ?? false}
        kindLabel={context.kindLabelOverride ?? "代码索引"}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        statusLabel={statusLabel}
        statusTooltip={toolCall.status === "failed" ? errorText : undefined}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={isRunning}
        title={toolCall.title}
        renderContent={() => (
          <ToolCallBody
            childToolList={context.childToolList}
            displayModel={displayModel}
            toolCall={toolCall}
            workspacePath={context.workspacePath}
            theme={context.theme}
            codePreviewSettings={context.codePreviewSettings}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
          />
        )}
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
