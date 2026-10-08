import { ArrowUpRightIcon } from "lucide-react";
import { useMemo } from "react";
import { WORKFLOW_CARD_ICON } from "@/components/workflow-timeline/WorkflowCardChrome.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";

export function WorkflowToolSummary({
  toolCallId,
  summary,
  onOpen,
  amend = false,
}: {
  toolCallId: string;
  summary: WorkflowRunCardSummary;
  onOpen?: () => void;
  /** AmendWorkflow 发起行：种类词换成「工作流已调整」。 */
  amend?: boolean;
}) {
  const { intl } = useZCodeIntl();
  // ToolLayout 是 memo 组件：primaryText 若是内联 JSX，每次渲染都会打破 memo（reactStableReferences 测试会拦下）。
  // 计数只说子代理；宿主没给子代理数时那一段留空，只剩 ↗。
  const agents = summary.agents;
  const primaryText = useMemo(
    () => (
      <span className="inline-flex min-w-0 items-center gap-2">
        <span aria-hidden>·</span>
        <span
          data-testid="workflow-summary-agents"
          className={
            onOpen
              ? "inline-flex items-center gap-2 group-hover/tool-summary:text-foreground group-focus-visible/tool-summary:text-foreground"
              : "inline-flex items-center gap-2"
          }
        >
          {agents === undefined
            ? null
            : intl.formatMessage(
                {
                  id:
                    agents === 1
                      ? "chat.toolCall.workflow.card.agent"
                      : "chat.toolCall.workflow.card.agents",
                },
                { count: agents },
              )}
          {onOpen ? <ArrowUpRightIcon aria-hidden className="size-4 shrink-0" /> : null}
        </span>
      </span>
    ),
    [agents, intl, onOpen],
  );
  return (
    <div
      data-testid="workflow-tool-summary"
      data-tool-call-id={toolCallId}
      data-workflow-run-id={summary.runId}
    >
      <ToolLayout
        toolId={toolCallId}
        icon={WORKFLOW_CARD_ICON}
        kindLabel={intl.formatMessage({
          id: amend ? "chat.toolCall.workflow.amend.amended" : "chat.toolCall.workflow.ran",
        })}
        canToggle={false}
        primaryText={primaryText}
        summaryAction={
          onOpen
            ? {
                ariaLabel: intl.formatMessage({ id: "chat.toolCall.workflow.openRunDetails" }),
                onActivate: onOpen,
              }
            : undefined
        }
      />
    </div>
  );
}
