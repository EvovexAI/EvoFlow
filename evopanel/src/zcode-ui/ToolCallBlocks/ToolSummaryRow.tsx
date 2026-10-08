import type { KeyboardEvent, ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import { testId, TID_TOOL_SUMMARY_TRIGGER } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { CollapsibleTrigger } from "@/components/ui/collapsible.js";
import { QueuedSummaryContent } from "@/ToolCallBlocks/QueuedSummaryContent.js";

export interface ToolSummaryAction {
  ariaLabel: string;
  onActivate: () => void;
  testId?: string;
}

function handleToolSummaryActionKeyDown(
  event: Pick<KeyboardEvent<HTMLDivElement>, "key" | "preventDefault">,
  onActivate: () => void,
): boolean {
  if (event.key !== "Enter" && event.key !== " ") {
    return false;
  }

  event.preventDefault();
  onActivate();
  return true;
}

interface ToolSummaryRowProps {
  action?: ToolSummaryAction;
  animateContent: boolean;
  canToggle: boolean;
  contentKey: string;
  contentRefreshVersion?: string;
  diffCount?: ReactNode;
  disableContentAnimation: boolean;
  forceOpen: boolean;
  icon: ReactNode;
  isExpanded: boolean;
  kindDetail?: ReactNode;
  kindLabel: ReactNode;
  kindLabelClassName: string;
  primaryText: ReactNode;
  prioritizePrimaryText?: boolean;
  secondaryText?: ReactNode;
  separator?: ReactNode;
  showIcon: boolean;
  sourceLabel?: ReactNode;
  statusNode?: ReactNode;
  title?: string;
  toggleAriaLabel: string;
  toolId: string;
}

function SummaryLeadingContent({
  icon,
  kindDetail,
  kindLabel,
  kindLabelClassName,
  showIcon,
  sourceLabel,
  prioritizePrimaryText,
}: Pick<
  ToolSummaryRowProps,
  | "icon"
  | "kindDetail"
  | "kindLabel"
  | "kindLabelClassName"
  | "prioritizePrimaryText"
  | "showIcon"
  | "sourceLabel"
>) {
  return (
    <>
      {showIcon ? (
        <span className="shrink-0 text-foreground-subtlest [&_svg]:text-foreground-subtlest">
          {icon}
        </span>
      ) : null}
      {kindLabel != null && kindLabel !== false && kindLabel !== "" ? (
        <span
          className={cn(
            "tool-summary-kind-label",
            kindLabelClassName,
            prioritizePrimaryText && "@max-[360px]/conversation:hidden",
          )}
        >
          {kindLabel}
        </span>
      ) : null}
      {kindDetail ? <span className="min-w-0 shrink-0">{kindDetail}</span> : null}
      {sourceLabel ? (
        <span
          className={cn(
            "shrink-0 rounded border border-border bg-background-alt px-1.5 py-0.5 text-ui-xs leading-none text-foreground-subtlest",
            prioritizePrimaryText && "@max-[360px]/conversation:hidden",
          )}
        >
          {sourceLabel}
        </span>
      ) : null}
    </>
  );
}

function SummaryContent({
  animateContent,
  contentKey,
  contentRefreshVersion,
  diffCount,
  disableContentAnimation,
  isExpanded,
  primaryText,
  prioritizePrimaryText,
  secondaryText,
  separator,
  statusNode,
}: Pick<
  ToolSummaryRowProps,
  | "animateContent"
  | "contentKey"
  | "contentRefreshVersion"
  | "diffCount"
  | "disableContentAnimation"
  | "isExpanded"
  | "primaryText"
  | "prioritizePrimaryText"
  | "secondaryText"
  | "separator"
  | "statusNode"
>) {
  const hasSummaryContent = [primaryText, secondaryText, diffCount, statusNode].some(
    (node) => node != null && node !== false && node !== "",
  );

  // 展开态可能主动清空摘要，但渲染空 flex 容器的话，标题行的 gap
  // 会在“类别—空容器—箭头”之间计算两次，视觉上形成一块异常大的空白。
  if (!hasSummaryContent) {
    return null;
  }

  return (
    <div
      className={cn(
        "tool-summary-content min-w-0 flex max-w-full items-center gap-2 text-foreground-subtlest",
        prioritizePrimaryText && "flex-1 overflow-hidden",
      )}
    >
      {separator != null ? (
        <span className="shrink-0 text-foreground-subtlest">{separator}</span>
      ) : null}
      <QueuedSummaryContent
        contentKey={contentKey}
        contentRefreshVersion={contentRefreshVersion}
        primaryText={primaryText}
        secondaryText={secondaryText}
        trailingText={diffCount}
        enabled={animateContent && !isExpanded}
        disableAnimation={disableContentAnimation}
      />
      {statusNode}
    </div>
  );
}

export function ToolSummaryRow(props: ToolSummaryRowProps) {
  const { action, canToggle, forceOpen, isExpanded, title, toggleAriaLabel, toolId } = props;
  const sharedContent = (
    <>
      <SummaryLeadingContent {...props} />
      <SummaryContent {...props} />
    </>
  );

  if (action) {
    return (
      <div
        data-testid={action.testId ?? testId(TID_TOOL_SUMMARY_TRIGGER, toolId)}
        role="button"
        tabIndex={0}
        aria-label={action.ariaLabel}
        onClick={action.onActivate}
        onKeyDown={(event) => handleToolSummaryActionKeyDown(event, action.onActivate)}
        className="group/tool-summary inline-flex max-w-full cursor-pointer items-center gap-2 self-start text-left text-ui-base transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
        title={title}
      >
        {sharedContent}
      </div>
    );
  }

  if (canToggle) {
    return (
      <CollapsibleTrigger asChild>
        <div
          data-testid={testId(TID_TOOL_SUMMARY_TRIGGER, toolId)}
          role="button"
          tabIndex={0}
          aria-expanded={isExpanded}
          aria-label={toggleAriaLabel}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") {
              return;
            }

            // 摘要内可能包含文件预览按钮，因此不能用满宽 button 包裹整行。
            // 保留 div trigger，并在这里补齐 Enter/Space 的展开能力。
            event.preventDefault();
            event.currentTarget.click();
          }}
          className="group/tool-summary inline-flex max-w-full cursor-pointer items-center gap-2 self-start text-left text-ui-base transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
          title={title}
        >
          {sharedContent}
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-4 text-foreground-subtlest opacity-0 transition-transform transition-opacity duration-200 ease-out will-change-transform group-hover/tool-summary:opacity-100 shrink-0",
              isExpanded ? "rotate-90 opacity-100" : "rotate-0",
              forceOpen && "opacity-100",
            )}
          />
        </div>
      </CollapsibleTrigger>
    );
  }

  return (
    <div
      data-testid={testId(TID_TOOL_SUMMARY_TRIGGER, toolId)}
      className="group/tool-summary cursor-default flex w-full items-center gap-2 text-left text-ui-base transition-colors focus-visible:outline-none"
      title={title}
    >
      {sharedContent}
    </div>
  );
}
