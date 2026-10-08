import type { ReactNode } from "react";
import { ChevronRightIcon, ListIcon, Maximize2Icon, Workflow } from "lucide-react";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  RUN_STATUS_DOT,
  RUN_STATUS_TEXT,
  STATUS_DOT,
  readWorkflowRunStopReason,
  workflowRunStopReasonMessageId,
  isWorkflowRunSuperseded,
} from "@/components/workflow-graph/run-status-presentation.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 工作流卡的表头与页脚。
 *
 * 不走 `ToolLayout`：它的摘要行是 `inline-flex self-start`，右对齐的状态簇放不进去。表头一行：
 * 图标 + 种类词 + 名字，右侧灯 + 状态词 + 等宽细节 + [⤢] + chevron。站数超过一列时不再有秩带：
 * 看不见的站在时间线自己的边檐上。
 */
export const WORKFLOW_CARD_ICON = <Workflow className="size-4 shrink-0 text-foreground-subtle" />;

/** 联接到 run 之后的种类词：同一个 run 在卡上、轮尾摘要里、通知里、详情页里必须叫同一个名字。 */
export const WORKFLOW_RUN_KIND_ID: Record<WorkflowRunState["status"], string> = {
  pending: "chat.toolCall.workflow.card.started",
  running: "chat.toolCall.workflow.card.running",
  completed: "chat.toolCall.workflow.card.completed",
  errored: "chat.toolCall.workflow.card.errored",
  stopped: "chat.toolCall.workflow.card.stopped",
};
/**
 * run 不在活投影里（八条上限淘汰 / 冷恢复无 journal 命中）时的中性种类词：卡只说「这里曾有一条 run」，
 * 不冒充某个终态。
 */
export const WORKFLOW_RUN_ENDED_KIND_ID = "chat.toolCall.workflow.card.ended";

/** 被修订替代的 run 的种类词。 */
export const WORKFLOW_RUN_SUPERSEDED_KIND_ID = "chat.toolCall.workflow.card.superseded";

/**
 * 种类词的唯一入口：stopped ∧ superseded 说「已被替代」，其余按状态查表。三处消费（卡、轮尾摘要、
 * 旧宿主运行卡）都走这里，否则同一个被替代的 run 会在一处叫「已停止」、另一处叫「已被替代」。
 */
export function workflowRunKindMessageId(run: {
  status: WorkflowRunState["status"];
  stopReason?: unknown;
}): string {
  return isWorkflowRunSuperseded(run)
    ? WORKFLOW_RUN_SUPERSEDED_KIND_ID
    : WORKFLOW_RUN_KIND_ID[run.status];
}

/** run 级状态：灯 + 词，永远成对出现（不变式 3）。 */
export function WorkflowRunStatus({
  className,
  status,
  run,
  testId,
}: {
  /** 缺席时取 `run.status`（两者至少给一个）。 */
  status?: WorkflowRunState["status"];
  /**
   * 带 `stopReason` 的来源对象（投影 run / 联接摘要）：`stopped` 时原因词跟在状态词后。
   * 按结构读，不绑死某个协议类型。
   *
   * `resumable` 是**状态位**，跟着 run 从 CLI 过来，
   * 在场即为 true 时在原因词之后再加一个词。UI 绝不按 status 推导它——「已停止」并不蕴含可恢复。
   */
  run?:
    | { status: WorkflowRunState["status"]; stopReason?: unknown; resumable?: unknown }
    | undefined;
  className?: string;
  testId?: string;
}) {
  const { intl } = useZCodeIntl();
  const effectiveStatus = status ?? run?.status ?? "pending";
  const reason =
    run === undefined ? undefined : readWorkflowRunStopReason({ ...run, status: effectiveStatus });
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5", className)}>
      <span
        aria-hidden
        className={cn("wf-lamp size-2 shrink-0 rounded-full", RUN_STATUS_DOT[effectiveStatus])}
      />
      {/* 状态词按值换：旧词退场新词进场。 */}
      <span
        className={cn("wf-swap text-ui-sm", RUN_STATUS_TEXT[effectiveStatus])}
        data-testid={testId}
        key={effectiveStatus}
      >
        {intl.formatMessage({ id: `chat.toolCall.workflow.run.status.${effectiveStatus}` })}
      </span>
      {reason ? (
        <span
          className="text-ui-sm text-foreground-subtlest"
          data-testid={testId ? `${testId}-reason` : undefined}
        >
          · {intl.formatMessage({ id: workflowRunStopReasonMessageId(reason) })}
        </span>
      ) : null}
      {/* 第三个词：这条 run 还能接着跑。「停止」这个动词只说了动作，说不了后果——把后果放回
          状态行，用户就不必先点开详情页才知道自己没有丢掉什么。 */}
      {run?.resumable === true ? (
        <span
          className="text-ui-sm text-foreground-subtlest"
          data-testid={testId ? `${testId}-resumable` : undefined}
        >
          · {intl.formatMessage({ id: "chat.toolCall.workflow.run.resumable" })}
        </span>
      ) : null}
    </span>
  );
}

/** 静态（尚未联接 run）的状态：空环灯 + 一个词（「compiled」）。 */
export function WorkflowStaticStatus({ word }: { word: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", STATUS_DOT.pending)} />
      <span className="text-ui-sm text-foreground-subtle" data-testid="workflow-card-static-status">
        {word}
      </span>
    </span>
  );
}

export function WorkflowCardHeader({
  detail,
  detailTitle,
  expanded,
  kind,
  leading,
  live = false,
  name,
  onOpenDetails,
  onToggle,
  status,
  toggleLabel: toggleLabelOverride,
  trailing,
}: {
  /** 种类词；字符串时按文案换词（换字即重挂，播 wf-swap）。 */
  kind: ReactNode;
  name: string;
  /** 运行中的种类词扫光（与 ToolLayout 的 isRunning 同一表达）。 */
  live?: boolean;
  status?: ReactNode;
  detail?: string;
  /** 细节串的 tooltip；只有子代理模型在场时才给（强度与规范串住在这里）。 */
  detailTitle?: string;
  /** 状态之前的插槽（轮尾摘要的待答问题芯片）。 */
  leading?: ReactNode;
  /** 细节之后、⤢ 之前的插槽（轮尾摘要把 Resume 放进表头）。 */
  trailing?: ReactNode;
  onOpenDetails?: () => void;
  expanded: boolean;
  /** 缺席即不可折叠（forceOpen / canToggle=false）。 */
  onToggle?: () => void;
  /** chevron 的无障碍名；缺席时是工具卡的「展开 / 收起工具详情」。 */
  toggleLabel?: string;
}) {
  const { intl } = useZCodeIntl();
  const openLabel = intl.formatMessage({ id: "chat.toolCall.workflow.openRunDetails" });
  const toggleLabel =
    toggleLabelOverride ??
    intl.formatMessage({
      id: expanded ? "chat.toolCall.collapseDetails" : "chat.toolCall.expandDetails",
    });
  return (
    <div
      className="flex min-w-0 items-center gap-2 text-ui-base"
      data-testid="workflow-card-header"
    >
      {WORKFLOW_CARD_ICON}
      {/* 种类词按文案换（key=文案，旧词退场新词进场）。换词的 wf-swap 必须包在扫光的
          animated-gradient-text **外面**：background-clip:text 只裁到自己这一层的文字，
          子元素一旦被 transform/opacity 动画提到独立图层，字就成了透明——表头上只剩一段空白。 */}
      <span className="shrink-0 whitespace-nowrap font-medium" data-testid="workflow-card-kind">
        <span className="wf-swap" key={typeof kind === "string" ? kind : undefined}>
          <span className={live ? "animated-gradient-text" : "text-foreground"}>{kind}</span>
        </span>
      </span>
      <span
        // 名称是 UI 文本；工具摘要与取消等状态共用的卡片表头都要经过同一修正。
        className="min-w-0 flex-1 truncate text-foreground-subtle"
        data-testid="workflow-card-name"
        title={name}
      >
        {name}
      </span>
      {/* 右簇可压缩，簇里只有细节串会让位：芯片、状态与按钮都是 shrink-0（Button 基类自带），
          细节串 min-w-0 + truncate，于是负空间全落在它身上，Configure / Stop / ⤢ 留在卡内。
          簇上的 min-w-0 是必需的，别当成冗余删掉：flex item 的 automatic minimum size 等于
          min-content，而 truncate 的 `white-space:nowrap` 让细节串的 min-content 就是整串字宽
          ——`overflow:hidden` 与子元素的 min-w-0 都不会把它算小。不写簇的 min-w-0，簇的地板
          就是「整串细节 + 按钮」，它一个像素都不会缩，按钮照样被顶出卡外（本次修复的起因）。
          浏览器实测（卡宽逐档收窄）：修复前 520px 起按钮就出界；修复后 290px 以上零溢出，
          带待答问题芯片时 380px——芯片也是 shrink-0，它把地板整体抬高。 */}
      <span className="flex min-w-0 items-center gap-2">
        {leading}
        {status}
        {detail === undefined || detail.length === 0 ? null : (
          <span
            className="min-w-0 truncate text-ui-base tabular-nums text-foreground-subtlest"
            data-testid="workflow-card-detail"
            {...(detailTitle === undefined ? {} : { title: detailTitle })}
          >
            {detail}
          </span>
        )}
        {trailing}
        {onOpenDetails === undefined ? null : (
          <ControlHintTooltip title={openLabel} side="top">
            <Button
              aria-label={openLabel}
              data-testid="workflow-card-open-details"
              onClick={onOpenDetails}
              size="icon-md"
              type="button"
              variant="ghost"
            >
              <Maximize2Icon className="size-3.5" />
            </Button>
          </ControlHintTooltip>
        )}
        {onToggle === undefined ? null : (
          <Button
            aria-expanded={expanded}
            aria-label={toggleLabel}
            data-testid="workflow-card-toggle"
            onClick={onToggle}
            size="icon-md"
            type="button"
            variant="ghost"
          >
            <ChevronRightIcon
              className={cn("size-4 transition-transform", expanded && "rotate-90")}
            />
          </Button>
        )}
      </span>
    </div>
  );
}

/** 页脚摘要行：灯 + 状态词 + 清单图标 + 各段用 `·` 隔开 + 末尾控件（失败态的 Resume）。 */
export function WorkflowCardFooter({
  parts = [],
  status,
  trailing,
}: {
  status: WorkflowRunState["status"];
  /** 摘要各段；缺席或为空时只画灯、状态词与 trailing。 */
  parts?: readonly string[];
  trailing?: ReactNode;
}) {
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-sm text-foreground-subtle"
      data-testid="workflow-card-footer"
    >
      <WorkflowRunStatus status={status} />
      {parts.length > 0 ? (
        <>
          <ListIcon aria-hidden className="size-3.5 shrink-0 text-foreground-subtlest" />
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 tabular-nums">
            {parts.map((part, i) => (
              <span className="flex items-center gap-x-2" key={i}>
                {i > 0 ? (
                  <span aria-hidden className="text-foreground-subtlest">
                    ·
                  </span>
                ) : null}
                <span>{part}</span>
              </span>
            ))}
          </span>
        </>
      ) : null}
      {trailing}
    </div>
  );
}
