import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import {
  RUN_STATUS_DOT,
  RUN_STATUS_TEXT,
} from "@/components/workflow-graph/run-status-presentation.js";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";

function isInteractiveDescendant(target: EventTarget | null, card: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  const interactive = target.closest("button, a, input, textarea, select, [role='button']");
  // 卡片自身带 role=button，closest 会让卡片任意位置都命中自己，那样「点击卡片打开详情」
  // 就永远不执行（plan 卡的原始 bug）。这里只拦截真实子控件。
  return interactive !== null && interactive !== card;
}

/**
 * workflow run 的紧凑可点卡——CreateWorkflow 与 ResumeWorkflowRun 工具卡共享的「run 态第三态」。
 *
 * 整卡就是入口（DESIGN.md 的语义色 + 现有的 run 状态词汇表）：实测的可发现性失败正是
 * 因为入口曾经埋在展开后的卡体里。两个调用方只换 labelText 与 primaryText（create 用
 * 工作流名、resume 用 runId），状态点词与步数都由联接摘要实时驱动。
 *
 * `onOpen` 缺席即纯展示态：不加 role/tabIndex/hover——宿主只在确实有可打开的 run 时注入
 * 回调（`ToolCallBlockRenderContext.onOpenWorkflowRun` 的门控语义）。
 */
export function WorkflowRunCompactCard({
  ariaLabel,
  icon,
  labelText,
  primaryText,
  primaryTitle,
  workflowRun,
  statusLabel,
  stepsLabel,
  onOpen,
  showIcon,
  children,
}: {
  ariaLabel: string;
  icon: ReactNode;
  labelText: string;
  primaryText: string;
  primaryTitle?: string;
  workflowRun: WorkflowRunCardSummary;
  statusLabel: string;
  stepsLabel: string;
  onOpen: (() => void) | undefined;
  showIcon: boolean;
  /** 卡片下方的附加内容（如 ToolSnapshotFieldNotice），随卡渲染。 */
  children?: ReactNode;
}) {
  // 整卡点击 / Enter / Space —— 逐字照 switch-mode.tsx 的 plan 卡习语，包括两条守卫的理由：
  // 卡片自身带 role=button，所以判定必须排除卡片本身，否则「点卡片打开详情」永不执行；
  // 而子控件的 keydown 会继续冒泡到整卡，一次键盘操作会打开两次详情页。
  const handleCardClick = (event: MouseEvent<HTMLElement>) => {
    if (!onOpen) return;
    if (!isInteractiveDescendant(event.target, event.currentTarget)) onOpen();
  };
  const handleCardKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!onOpen) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    if (isInteractiveDescendant(event.target, event.currentTarget)) return;
    event.preventDefault();
    onOpen();
  };

  return (
    <>
      <section
        aria-label={ariaLabel}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-xl border border-card-border bg-card px-3 py-2.5 text-foreground shadow-xs outline-none transition-colors",
          onOpen
            ? "hover:border-border-hover focus-visible:border-input-border-focused focus-visible:ring-2 focus-visible:ring-ring/40"
            : undefined,
        )}
        data-testid="workflow-run-card"
        data-workflow-run-id={workflowRun.runId}
        data-workflow-run-status={workflowRun.status}
        onClick={handleCardClick}
        onKeyDown={handleCardKeyDown}
        role={onOpen ? "button" : undefined}
        tabIndex={onOpen ? 0 : undefined}
      >
        {showIcon ? icon : null}
        <span className="shrink-0 text-ui-base font-medium text-foreground-subtle">
          {labelText}
        </span>
        {/* 工作流名称是界面标题，使用默认字体，避免被当作代码以等宽字体展示。 */}
        <span
          className="min-w-0 flex-1 truncate text-ui-base text-foreground-subtlest"
          title={primaryTitle ?? primaryText}
        >
          {primaryText}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {/* 状态词永远在圆点旁边：状态绝不只靠颜色或动画表达。 */}
          <span
            aria-hidden="true"
            className={cn("size-1.5 shrink-0 rounded-full", RUN_STATUS_DOT[workflowRun.status])}
          />
          <span className={cn("text-ui-sm", RUN_STATUS_TEXT[workflowRun.status])}>
            {statusLabel}
          </span>
        </span>
        {/* 步数是「已排程的里结算了几个」，不是全程百分比——动态工作流没有静态总数。 */}
        <span className="shrink-0 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
          {stepsLabel}
        </span>
      </section>
      {children}
    </>
  );
}
