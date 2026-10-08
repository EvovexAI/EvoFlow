import { Library } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { FallbackToolCallBlock } from "@/ToolCallBlocks/renderers/fallback.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

const LIST_SAVED_WORKFLOWS_TOOL_ICON = (
  <Library className="size-4 shrink-0 text-foreground-subtle" />
);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

interface SavedWorkflowEntry {
  name: string;
  description: string | undefined;
  whenToUse: string | undefined;
  scope: string | undefined;
  path: string | undefined;
  argNames: string[];
}

interface InvalidSavedWorkflowEntry {
  path: string;
  reason: string | undefined;
}

interface ListSavedWorkflowsResult {
  workflows: SavedWorkflowEntry[];
  invalid: InvalidSavedWorkflowEntry[];
}

function parseJsonCandidate(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function readResultRecord(value: unknown): ListSavedWorkflowsResult | null {
  const normalized = parseJsonCandidate(value);
  if (!isPlainRecord(normalized) || !Array.isArray(normalized.workflows)) {
    return null;
  }

  const workflows: SavedWorkflowEntry[] = [];
  for (const entry of normalized.workflows) {
    if (!isPlainRecord(entry)) {
      continue;
    }
    const name = readTrimmedString(entry.name);
    if (name === undefined) {
      continue;
    }
    workflows.push({
      name,
      description: readTrimmedString(entry.description),
      whenToUse: readTrimmedString(entry.whenToUse),
      scope: readTrimmedString(entry.scope),
      path: readTrimmedString(entry.path),
      argNames: isPlainRecord(entry.args) ? Object.keys(entry.args) : [],
    });
  }

  const invalid: InvalidSavedWorkflowEntry[] = [];
  if (Array.isArray(normalized.invalid)) {
    for (const entry of normalized.invalid) {
      if (!isPlainRecord(entry)) {
        continue;
      }
      const path = readTrimmedString(entry.path);
      if (path === undefined) {
        continue;
      }
      invalid.push({ path, reason: readTrimmedString(entry.reason) });
    }
  }

  return { workflows, invalid };
}

/**
 * 结果读取顺序：**display 通道优先**——v4 wire 上 output.text
 * 是 formatModelContent 的 XML 风格投影，下面的 JSON 探针对它永不命中（会掉进
 * raw 兜底卡）；legacy JSON 探针保留，兜老会话与非 v4 宿主。一个都读不出来就交回
 * fallback——空列表与「读不懂」必须可分辨，不能把解析失败画成「这个项目里没有工作流」。
 */
function readListSavedWorkflowsResult(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): ListSavedWorkflowsResult | null {
  const display = readToolResultDisplay(toolCall.raw);
  if (display?.kind === "saved_workflow_list") {
    return {
      workflows: display.workflows.map((entry) => ({
        name: entry.name,
        description: entry.description,
        whenToUse: entry.whenToUse,
        scope: entry.scope,
        path: entry.path,
        argNames: [...entry.argNames],
      })),
      invalid: (display.invalid ?? []).map((entry) => ({
        path: entry.path,
        reason: entry.reason,
      })),
    };
  }

  const raw = isPlainRecord(toolCall.raw) ? toolCall.raw : null;
  for (const candidate of [toolCall.output, raw?.rawOutput, raw?.output, raw?.result]) {
    const result = readResultRecord(candidate);
    if (result) {
      return result;
    }
  }
  return null;
}

/**
 * ListSavedWorkflows 的聊天卡。
 *
 * 为什么值得一个专用 renderer：这个工具名没登记在 shared 的已知工具表里，通用路径是
 * `FallbackToolCallBlock`，而它的默认 display model 没有 inlinePreview，于是会把
 * `JSON.stringify(toolCall)` 整包摊进聊天区——对这个工具正好是最坏情况，因为那包 JSON
 * 就是全部工作流的 description / whenToUse / args 声明。
 *
 * 卡片只回答「有哪些、干什么用」；脚本本体本来就不在结果里（spec：一次列举不该把 20 段脚本
 * 灌进上下文）。坏文件单独一行——它们是**刻意可见**的，不静默跳过。
 */
export function ListSavedWorkflowsToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;

  const result = useMemo(() => readListSavedWorkflowsResult(toolCall), [toolCall]);

  const kindLabel = intl.formatMessage({
    id: context.isRunning
      ? "chat.toolCall.workflow.list.listing"
      : "chat.toolCall.workflow.list.listed",
  });
  const scopeProjectLabel = intl.formatMessage({
    id: "chat.permission.workflow.saved.scope.project",
  });
  const scopeGlobalLabel = intl.formatMessage({ id: "chat.toolCall.workflow.scope.global" });
  const emptyLabel = intl.formatMessage({ id: "chat.toolCall.workflow.list.empty" });

  const workflowCount = result?.workflows.length ?? 0;
  const invalidCount = result?.invalid.length ?? 0;
  // 轻量 intl 没有 ICU 复数，单复数各用独立 message key（同 workflow.error/errors 的先例）。
  const countLabel = intl.formatMessage(
    {
      id:
        workflowCount === 1
          ? "chat.toolCall.workflow.list.countOne"
          : "chat.toolCall.workflow.list.count",
    },
    { count: workflowCount },
  );
  const invalidLabel = intl.formatMessage(
    {
      id:
        invalidCount === 1
          ? "chat.toolCall.workflow.list.invalidOne"
          : "chat.toolCall.workflow.list.invalid",
    },
    { count: invalidCount },
  );

  // ToolLayout 是 memo 组件：内联 JSX prop 每次渲染都是新引用，会让记忆化失效。
  const primaryText = useMemo(
    () => (
      <span className="truncate text-foreground-subtlest">
        {workflowCount === 0 ? emptyLabel : countLabel}
      </span>
    ),
    [countLabel, emptyLabel, workflowCount],
  );

  const renderContent = useCallback(() => {
    if (!result) {
      return null;
    }

    return (
      <div className="mb-2 space-y-2" data-saved-workflow-list="true">
        {result.workflows.map((workflow) => (
          <div key={workflow.path ?? workflow.name} className="min-w-0 space-y-0.5">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span
                className="min-w-0 truncate font-mono text-ui-base text-foreground-subtle"
                title={workflow.path ?? workflow.name}
              >
                {workflow.name}
              </span>
              {workflow.scope === "global" ? (
                <span
                  data-workflow-scope-tag="global"
                  className="shrink-0 rounded-xs border border-border px-1.5 py-0.5 text-ui-xs leading-none text-foreground-subtlest"
                >
                  {scopeGlobalLabel}
                </span>
              ) : (
                <span className="shrink-0 text-ui-xs text-foreground-subtlest">
                  {workflow.scope === "project" ? scopeProjectLabel : workflow.scope}
                </span>
              )}
            </div>
            {workflow.description === undefined ? null : (
              <p className="min-w-0 whitespace-pre-wrap break-words text-ui-sm text-foreground-subtlest">
                {workflow.description}
              </p>
            )}
            {workflow.argNames.length === 0 ? null : (
              <div className="flex min-w-0 flex-wrap gap-1 pt-0.5">
                {workflow.argNames.map((argName) => (
                  <span
                    key={argName}
                    className="rounded-xs border border-border px-1.5 py-0.5 font-mono text-ui-xs leading-none text-foreground-subtlest"
                  >
                    {argName}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}

        {result.workflows.length === 0 ? (
          <p className="text-ui-sm text-foreground-subtlest">{emptyLabel}</p>
        ) : null}

        {result.invalid.length === 0 ? null : (
          <div className="space-y-0.5 rounded-lg border border-warning/40 px-2.5 py-2">
            <p className="text-ui-sm text-warning">{invalidLabel}</p>
            {result.invalid.map((entry) => (
              <p
                key={entry.path}
                className="min-w-0 truncate font-mono text-ui-xs text-foreground-subtlest"
                title={entry.reason ?? entry.path}
              >
                {entry.path}
              </p>
            ))}
          </div>
        )}
      </div>
    );
  }, [emptyLabel, invalidLabel, result, scopeGlobalLabel, scopeProjectLabel]);

  // 读不出结构化结果（老会话、失败、降级路径）就交回通用卡，而不是画一张空列表。
  if (!result) {
    return <FallbackToolCallBlock {...context} iconOverride={LIST_SAVED_WORKFLOWS_TOOL_ICON} />;
  }

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={LIST_SAVED_WORKFLOWS_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={context.canToggle ?? true}
        forceOpen={context.forceOpen ?? false}
        kindLabel={context.kindLabelOverride ?? kindLabel}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        statusLabel={context.statusLabel}
        statusTooltip={context.errorText}
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
