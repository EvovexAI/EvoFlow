/* eslint-disable max-lines -- Explore 聚合渲染同时维护分类、父级摘要和可复用子工具摘要，拆开会让父子展示规则更难对齐 */
import { SearchIcon } from "lucide-react";
import { extractPlanStepsFromToolInput, extractPlanStepsFromToolOutput } from "@zcode/shared";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getExecuteSecondaryText } from "@/ToolCallBlocks/renderers/execute.js";
import { buildReadSummary, ReadFileChip } from "@/ToolCallBlocks/renderers/read.js";
import { getSearchPrimaryText } from "@/ToolCallBlocks/renderers/search.js";
import { renderFilePath } from "@/ToolCallBlocks/shared.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { useCallback, type ReactNode } from "react";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import type { ZCodePlanStep } from "@zcode/shared";

const EXPLORE_TOOL_ICON = <SearchIcon className="size-4 shrink-0 text-foreground-subtle" />;

type IntlLike = {
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string;
};

type ExploreChildSummary = {
  animationKey: string;
  primaryText: ReactNode;
  secondaryText?: ReactNode;
  title?: string;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapShellCommand(command: string): string {
  const trimmed = command.trim();
  const shellCommandMatch = trimmed.match(/^(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+([\s\S]+)$/i);
  if (!shellCommandMatch?.[1]) {
    return trimmed;
  }

  const rawInnerCommand = shellCommandMatch[1].trim();
  if (
    (rawInnerCommand.startsWith('"') && rawInnerCommand.endsWith('"')) ||
    (rawInnerCommand.startsWith("'") && rawInnerCommand.endsWith("'"))
  ) {
    return rawInnerCommand.slice(1, -1).trim();
  }

  return rawInnerCommand;
}

function collectCommandStrings(input: unknown): string[] {
  const commandCandidates: string[] = [];

  const collectFromValue = (value: unknown) => {
    if (typeof value === "string") {
      const command = value.trim();
      if (command.length > 0) {
        commandCandidates.push(command);
      }
      return;
    }

    if (!Array.isArray(value)) {
      return;
    }

    if (value.every((item) => typeof item === "string")) {
      const commandParts = value as string[];
      const shellCommandIndex = commandParts.findIndex((part) => part === "-lc");
      if (shellCommandIndex >= 0 && typeof commandParts[shellCommandIndex + 1] === "string") {
        const shellCommand = commandParts[shellCommandIndex + 1]!.trim();
        if (shellCommand.length > 0) {
          commandCandidates.push(shellCommand);
          return;
        }
      }

      const joinedCommand = commandParts.join(" ").trim();
      if (joinedCommand.length > 0) {
        commandCandidates.push(joinedCommand);
      }
      return;
    }

    for (const item of value) {
      if (!isPlainRecord(item)) {
        continue;
      }

      const parsedCommand = item.cmd;
      if (typeof parsedCommand === "string" && parsedCommand.trim().length > 0) {
        commandCandidates.push(parsedCommand.trim());
      }
    }
  };

  collectFromValue(input);

  if (!isPlainRecord(input)) {
    return Array.from(
      new Set(
        commandCandidates.flatMap((candidate) => unwrapShellCommand(candidate).split(/&&|\|\||;/g)),
      ),
    )
      .map((item) => item.trim())
      .filter(Boolean);
  }

  for (const key of ["command", "cmd", "script", "parsed_cmd"] as const) {
    collectFromValue(input[key]);
  }

  return Array.from(
    new Set(
      commandCandidates.flatMap((candidate) => unwrapShellCommand(candidate).split(/&&|\|\||;/g)),
    ),
  )
    .map((item) => item.trim())
    .filter(Boolean);
}

type ExploreBucket = "search" | "list" | "file";

function getBucketLabel(intl: IntlLike, bucket: ExploreBucket, count: number) {
  switch (bucket) {
    case "search":
      return intl.formatMessage({
        id:
          count === 1
            ? "chat.toolCall.explore.bucket.search.one"
            : "chat.toolCall.explore.bucket.search.other",
      });
    case "list":
      return intl.formatMessage({
        id:
          count === 1
            ? "chat.toolCall.explore.bucket.list.one"
            : "chat.toolCall.explore.bucket.list.other",
      });
    case "file":
      return intl.formatMessage({
        id:
          count === 1
            ? "chat.toolCall.explore.bucket.file.one"
            : "chat.toolCall.explore.bucket.file.other",
      });
    default:
      return intl.formatMessage({ id: "chat.toolCall.explore.bucket.items" });
  }
}

function classifyExploreToolCall({
  kind,
  title,
  input,
}: {
  kind: string;
  title?: string;
  input: unknown;
}): ExploreBucket {
  const fingerprint = `${kind} ${title ?? ""}`.toLowerCase();
  const command = collectCommandStrings(input).join(" ; ").toLowerCase();

  if (
    /(\bgrep\b|\bsearch\b|\bfetch\b|\bweb.?search\b|\bweb.?fetch\b)/i.test(fingerprint) ||
    /(^|\s)(rg|grep|ripgrep|git\s+grep)(\s|$)/i.test(command)
  ) {
    return "search";
  }

  if (
    /(\bglob\b|\bfind\b|\blist\b|\btree\b|\bdir\b|\bls\b)/i.test(fingerprint) ||
    /(^|\s)(ls|find|tree|dir)(\s|$)/i.test(command)
  ) {
    return "list";
  }

  return "file";
}

function formatExploreSummary(intl: IntlLike, counts: Record<ExploreBucket, number>) {
  const summaryParts: string[] = [];

  if (counts.search > 0) {
    summaryParts.push(`${counts.search} ${getBucketLabel(intl, "search", counts.search)}`);
  }
  if (counts.list > 0) {
    summaryParts.push(`${counts.list} ${getBucketLabel(intl, "list", counts.list)}`);
  }
  if (counts.file > 0) {
    summaryParts.push(`${counts.file} ${getBucketLabel(intl, "file", counts.file)}`);
  }

  return summaryParts.length > 0
    ? summaryParts.join(", ")
    : intl.formatMessage({ id: "chat.toolCall.explore.emptySummary" });
}

function getChildActionKindLabel(
  intl: IntlLike,
  family: ReturnType<typeof resolveToolCallIdentity>["family"],
) {
  switch (family) {
    case "file-read":
      return intl.formatMessage({ id: "chat.toolCall.read.reading" });
    case "search":
      return intl.formatMessage({ id: "chat.toolCall.search.searching" });
    case "shell":
      return intl.formatMessage({ id: "chat.toolCall.execute.running" });
    default:
      return intl.formatMessage({ id: "chat.toolCall.status.running" });
  }
}

function renderChildActionKindPrefix(actionKindLabel: string | null, content: ReactNode) {
  if (!actionKindLabel) {
    return content;
  }

  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-foreground-subtle">{actionKindLabel}</span>
      {content}
    </span>
  );
}

function readTodoPlanFromToolCall(
  childToolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): ZCodePlanStep[] | null {
  return (
    extractPlanStepsFromToolOutput({
      title: childToolCall.title,
      kind: childToolCall.kind,
      output: childToolCall.output,
    }) ??
    extractPlanStepsFromToolInput({
      title: childToolCall.title,
      kind: childToolCall.kind,
      input: childToolCall.input,
    })
  );
}

function getTodoChildSummary(
  intl: IntlLike,
  childToolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): ExploreChildSummary | null {
  const plan = readTodoPlanFromToolCall(childToolCall);
  if (!plan || plan.length === 0) {
    return {
      animationKey: `todo:${childToolCall.toolId}:empty`,
      primaryText: (
        <span className="min-w-0 truncate">
          {intl.formatMessage({ id: "chat.toolCall.todo.updating" })}
        </span>
      ),
      title: childToolCall.title,
    };
  }

  const completedCount = plan.filter((step) => step.status === "completed").length;
  const activeStep =
    plan.find((step) => step.status === "in_progress") ??
    plan.find((step) => step.status !== "completed") ??
    plan.at(-1);
  const isComplete = completedCount === plan.length;
  const actionLabel = intl.formatMessage({
    id: isComplete ? "chat.toolCall.todo.updated" : "chat.toolCall.todo.updating",
  });
  const progressText = `${completedCount}/${plan.length}`;
  const primaryText = activeStep?.title ? `${progressText} · ${activeStep.title}` : progressText;

  return {
    animationKey: `todo:${childToolCall.toolId}:${completedCount}:${plan.length}:${activeStep?.id ?? "none"}:${activeStep?.title ?? ""}`,
    primaryText: (
      <span className="inline-flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-foreground-subtle">{actionLabel}</span>
        <span className="min-w-0 truncate">{primaryText}</span>
      </span>
    ),
    title: activeStep?.title ?? childToolCall.title,
  };
}

function getLatestExploreChildSummary(
  intl: IntlLike,
  childToolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
  context: ToolCallBlockRenderContext,
  options: { includeChildActionKindLabel?: boolean } = {},
): ExploreChildSummary | null {
  const childIdentity = resolveToolCallIdentity(childToolCall);
  const actionKindLabel =
    options.includeChildActionKindLabel === true
      ? getChildActionKindLabel(intl, childIdentity.family)
      : null;

  if (childIdentity.family === "todo") {
    return getTodoChildSummary(intl, childToolCall);
  }

  if (childIdentity.family === "file-read") {
    const readSummary = buildReadSummary(childToolCall);
    if (!readSummary) {
      return null;
    }
    const canOpenPreview = readSummary.entryType === "file" && Boolean(context.onOpenCodeViewer);
    const openFilePreview = () => {
      if (readSummary.entryType !== "file") {
        return;
      }

      context.onOpenCodeViewer?.({
        type: "file",
        title: readSummary.fileName,
        path: readSummary.path,
      });
    };

    return {
      animationKey: `read:${childToolCall.toolId}:${actionKindLabel ?? "plain"}:${readSummary.path}`,
      primaryText: renderChildActionKindPrefix(
        actionKindLabel,
        <ReadFileChip summary={readSummary} clickable={canOpenPreview} onClick={openFilePreview} />,
      ),
      secondaryText: renderFilePath(readSummary.filePath),
      title: readSummary.path,
    };
  }

  if (childIdentity.family === "search") {
    const primaryText = getSearchPrimaryText(intl, childToolCall.input);

    return {
      animationKey: `search:${childToolCall.toolId}:${actionKindLabel ?? "plain"}:${primaryText}`,
      primaryText: renderChildActionKindPrefix(
        actionKindLabel,
        <span className="min-w-0 truncate">{primaryText}</span>,
      ),
      title: primaryText,
    };
  }

  if (childIdentity.family === "shell") {
    const secondaryText =
      getExecuteSecondaryText(childToolCall.input) ?? childToolCall.title ?? childToolCall.kind;

    return {
      animationKey: `shell:${childToolCall.toolId}:${actionKindLabel ?? "plain"}:${secondaryText}`,
      primaryText: actionKindLabel ? (
        <span className="shrink-0 text-foreground-subtle">{actionKindLabel}</span>
      ) : null,
      secondaryText: <code className="min-w-0 truncate font-sans">{secondaryText}</code>,
      title: typeof secondaryText === "string" ? secondaryText : childToolCall.title,
    };
  }

  const fallbackText =
    childToolCall.title ??
    childToolCall.kind ??
    intl.formatMessage({ id: "chat.toolCall.explore.emptySummary" });

  return {
    animationKey: `tool:${childToolCall.toolId}:${actionKindLabel ?? "plain"}:${fallbackText}`,
    primaryText: renderChildActionKindPrefix(
      actionKindLabel,
      <span className="min-w-0 truncate">{fallbackText}</span>,
    ),
    title: typeof fallbackText === "string" ? fallbackText : childToolCall.title,
  };
}

export function getLatestExploreChildSummaryFromChildren(
  intl: IntlLike,
  childToolCalls: readonly TaskChatToolCallTreeNode[],
  context: ToolCallBlockRenderContext,
  options: { includeChildActionKindLabel?: boolean } = {},
) {
  for (let index = childToolCalls.length - 1; index >= 0; index -= 1) {
    const childToolCall = childToolCalls[index]?.toolCall;
    if (!childToolCall) {
      continue;
    }

    const summary = getLatestExploreChildSummary(intl, childToolCall, context, options);
    if (summary) {
      return summary;
    }
  }

  return null;
}

export function ExploreToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCallNode, isRunning, statusLabel, errorText } = context;
  const { toolCall, childToolCalls } = toolCallNode;
  const counts = childToolCalls.reduce<Record<ExploreBucket, number>>(
    (acc, childToolCallNode) => {
      const bucket = classifyExploreToolCall({
        kind: childToolCallNode.toolCall.kind,
        title: childToolCallNode.toolCall.title,
        input: childToolCallNode.toolCall.input,
      });
      acc[bucket] += 1;
      return acc;
    },
    { search: 0, list: 0, file: 0 },
  );
  const summary = formatExploreSummary(intl, counts);
  const kindLabel = intl.formatMessage({
    id: "chat.toolCall.explore.label",
  });
  const collapsedChildSummary = isRunning
    ? getLatestExploreChildSummaryFromChildren(intl, childToolCalls, context, {
        includeChildActionKindLabel: true,
      })
    : null;
  const renderContent = useCallback(
    () =>
      childToolCalls.length > 0 ? (
        <div className="ml-2 space-y-2 border-border border-l pl-3.5 border-border">
          {childToolCalls.map((childToolCallNode) => (
            <ToolCallBlock
              key={childToolCallNode.toolCall.toolId}
              toolCallNode={childToolCallNode}
              workspacePath={context.workspacePath}
              showIcon={false}
              onOpenCodeViewer={context.onOpenCodeViewer}
              onOpenFileLink={context.onOpenFileLink}
              onOpenBrowserUrl={context.onOpenBrowserUrl}
              onOpenAutomationsMain={context.onOpenAutomationsMain}
              onLoadFullToolCallFields={context.onLoadFullToolCallFields}
            />
          ))}
        </div>
      ) : null,
    [
      childToolCalls,
      context.onLoadFullToolCallFields,
      context.onOpenAutomationsMain,
      context.onOpenBrowserUrl,
      context.onOpenCodeViewer,
      context.onOpenFileLink,
      context.workspacePath,
    ],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={EXPLORE_TOOL_ICON}
        canToggle={context.canToggle ?? true}
        forceOpen={context.forceOpen ?? false}
        kindLabel={kindLabel}
        expandedKindLabel={kindLabel}
        sourceLabel={context.sourceLabel}
        primaryText={collapsedChildSummary ? collapsedChildSummary.primaryText : summary}
        expandedPrimaryText={summary}
        secondaryText={collapsedChildSummary?.secondaryText}
        expandedSecondaryText={null}
        summaryContentSeparator="·"
        animateSummaryContent
        disableSummaryContentAnimation={context.disableSummaryContentAnimation}
        summaryContentKey={
          collapsedChildSummary?.animationKey ??
          `explore:${toolCall.toolId}:${isRunning ? "running" : "done"}:${summary}`
        }
        statusLabel={statusLabel}
        statusTooltip={toolCall.status === "failed" ? errorText : undefined}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={isRunning}
        title={collapsedChildSummary?.title ?? (isRunning ? summary : toolCall.title)}
        expandedTitle={toolCall.title}
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
