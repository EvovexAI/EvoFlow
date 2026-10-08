import { RotateCcw, Workflow } from "lucide-react";
import { useCallback, useMemo } from "react";
import { cn } from "@/components/lib/utils.js";
import {
  RUN_STATUS_DOT,
  RUN_STATUS_TEXT,
} from "@/components/workflow-graph/run-status-presentation.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";
import { ToolLayout } from "../ToolLayout.js";
import { WorkflowRunCompactCard } from "./workflow-run-compact-card.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

/** 紧凑 run 态卡的图标与 CreateWorkflow 同一枚（族内一致）；折叠态保留 RotateCcw 讲「恢复」。 */
const RESUME_WORKFLOW_RUN_TOOL_ICON = (
  <Workflow className="size-4 shrink-0 text-foreground-subtle" />
);
const RESUME_WORKFLOW_RUN_FALLBACK_ICON = (
  <RotateCcw className="size-4 shrink-0 text-foreground-subtle" />
);

/** 无 display 时的纯文本面板高度（照 get-workflow-run 的输出面板量级）。 */
const FALLBACK_OUTPUT_MAX_HEIGHT_CLASS = "max-h-60";

/**
 * ResumeWorkflowRun 的聊天卡。
 *
 * 两态：
 * - **run 已联接**（宿主按 display.runId 联接 workflowRuns 投影，`workflowRunCardJoin` 的
 *   byRunId 表）→ 复用 CreateWorkflow 的紧凑可点卡（`WorkflowRunCompactCard`），标签换
 *   「工作流实例已恢复」，状态点词/步数实时驱动，整卡点击打开侧栏 run 视图——tab 身份
 *   runId 键，与原始 create 卡打开的是同一个 tab。
 * - **未联接**（display 缺席的老会话 / 失败路径 / 投影尚未就绪）→ ToolLayout 折叠卡：
 *   runId（mono）+「后台运行中」状态点词（run 状态词汇表 running 档）+ 展开的本地化续跑
 *   说明；无 display 时有界纯文本面板，绝不 raw JSON dump。
 */
export function ResumeWorkflowRunToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;

  const display = readToolResultDisplay(toolCall.raw);
  const runDisplay = display?.kind === "resume_workflow_run" ? display : undefined;

  const kindLabel = intl.formatMessage({
    id: context.isRunning
      ? "chat.toolCall.workflow.resumeRun.resuming"
      : "chat.toolCall.workflow.resumeRun.label",
  });
  const backgroundLabel = intl.formatMessage({
    id: "chat.toolCall.workflow.resumeRun.inBackground",
  });
  const hintLabel = intl.formatMessage({ id: "chat.toolCall.workflow.resumeRun.hint" });

  const snapshotNotice = (
    <ToolSnapshotFieldNotice
      refs={toolCall.snapshotRefs ?? []}
      onLoadFullToolCallFields={
        context.onLoadFullToolCallFields
          ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
          : undefined
      }
    />
  );

  const onOpenWorkflowRun = context.onOpenWorkflowRun;

  // —— run 态：紧凑可点卡（与 CreateWorkflow 共享组件，语义见组件头注释）——
  if (context.workflowRun !== undefined) {
    const runStatusLabel = intl.formatMessage({
      id: `chat.toolCall.workflow.run.status.${context.workflowRun.status}`,
    });
    const runStepsLabel = intl.formatMessage(
      { id: "chat.toolCall.workflow.card.steps" },
      { done: context.workflowRun.nodesSettled, total: context.workflowRun.nodesTotal },
    );
    return (
      <WorkflowRunCompactCard
        ariaLabel={kindLabel}
        icon={RESUME_WORKFLOW_RUN_TOOL_ICON}
        labelText={kindLabel}
        primaryText={runDisplay?.runId ?? context.workflowRun.runId}
        workflowRun={context.workflowRun}
        statusLabel={runStatusLabel}
        stepsLabel={runStepsLabel}
        onOpen={onOpenWorkflowRun !== undefined ? () => onOpenWorkflowRun({}) : undefined}
        showIcon={context.showIcon !== false}
      >
        {snapshotNotice}
      </WorkflowRunCompactCard>
    );
  }

  // —— 折叠态：ToolLayout + 状态点词 + 展开说明 ——
  const runId = runDisplay?.runId;

  const primaryText = useMemo(
    () =>
      runId === undefined ? undefined : (
        <span className="min-w-0 truncate font-mono text-foreground-subtlest" title={runId}>
          {runId}
        </span>
      ),
    [runId],
  );

  // 状态词永远在圆点旁边：状态绝不只靠颜色或动画表达（DESIGN.md 可访问性规则）。
  // display 只在成功输出上构造，失败路径走 showFailureStatus + 文本面板。
  const statusLabel = useMemo(
    () =>
      runDisplay === undefined ? undefined : (
        <span className="flex shrink-0 items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn("size-1.5 rounded-full", RUN_STATUS_DOT.running)}
          />
          <span className={cn("text-ui-sm", RUN_STATUS_TEXT.running)}>{backgroundLabel}</span>
        </span>
      ),
    [backgroundLabel, runDisplay],
  );

  const renderContent = useCallback(() => {
    if (runDisplay === undefined) {
      // 无 display 的老会话 / 失败路径：formatModelContent 的文本投影也是有界信息，直接给
      // 面板，不做 JSON dump。
      const fallbackText =
        typeof toolCall.output === "string" && toolCall.output.trim().length > 0
          ? toolCall.output
          : undefined;
      if (fallbackText === undefined) return null;
      return (
        <pre
          className={`${FALLBACK_OUTPUT_MAX_HEIGHT_CLASS} mb-2 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 font-mono text-ui-base text-foreground-subtle`}
        >
          {fallbackText}
        </pre>
      );
    }
    return (
      <p className="mb-2 rounded-lg border border-border bg-panel px-4 py-3 text-ui-sm leading-5 text-foreground-subtle">
        {hintLabel}
      </p>
    );
  }, [hintLabel, runDisplay, toolCall.output]);

  const hasDetails =
    runDisplay !== undefined ||
    (typeof toolCall.output === "string" && toolCall.output.trim().length > 0);

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={RESUME_WORKFLOW_RUN_FALLBACK_ICON}
        showIcon={context.showIcon !== false}
        canToggle={hasDetails && (context.canToggle ?? true)}
        forceOpen={hasDetails && (context.forceOpen ?? false)}
        kindLabel={context.kindLabelOverride ?? kindLabel}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        secondaryText={undefined}
        statusLabel={statusLabel}
        showStatusLabel={statusLabel !== undefined}
        statusTooltip={context.errorText}
        showFailureStatus={toolCall.status === "failed"}
        isRunning={context.isRunning}
        title={toolCall.title}
        renderContent={hasDetails ? renderContent : undefined}
      />
      {snapshotNotice}
    </>
  );
}
