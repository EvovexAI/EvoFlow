// 侧栏任务行标题下的工作流运行行：
// Workflow 图标 + 迷你轨道灯 + 当前 phase 名。一眼看懂「这个会话在跑工作流、跑到哪一站」，
// 别的都不画：没有光晕、没有行进虚线、没有问题 chip（升级问答由主代理作答，不是用户）、
// 没有子代理数、没有箭头——那些进 hover tooltip。结束的 run 只剩一个中性词，颜色只留给灯。
import { useEffect, useMemo, type MouseEvent } from "react";
import { Workflow } from "lucide-react";
import type {
  SessionWorkflowActivity,
  SessionWorkflowRunSummary,
} from "@zcode/shared/zcode-protocol-v4";
import { isSessionWorkflowRunLive } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  STATUS_DOT,
  readWorkflowRunStopReason,
  workflowRunStopReasonMessageId,
} from "@/components/workflow-graph/run-status-presentation.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { getWorkflowRunAckStore, useWorkflowRunAcknowledged } from "@/lib/workflowRunAckStore.js";
import {
  foldWorkflowRunRail,
  selectWorkflowRunLines,
  settledWorkflowRunIds,
  workflowRunParallelPhaseLabel,
  type WorkflowRunRail,
} from "@/lib/workflowRunLine.js";
import { useWorkflowRunOpen } from "@/v4/workflowRunOpenContext.js";

export interface TaskWorkflowRunLinesIntl {
  formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
}

interface TaskWorkflowRunLinesProps {
  activity: SessionWorkflowActivity | undefined;
  /** 会话是否正被打开：为真时确认它所有已结束的 run（结束的行随即折叠）。 */
  isActive: boolean;
  intl: TaskWorkflowRunLinesIntl;
  /** 点击打开 run pane 所需的会话地址；缺席（手机首页）时运行行不是按钮。 */
  session?: { workspacePath: string; workspaceIdentity?: string; sessionId: string };
  /** compact = 手机远控行（24px、更小字号）。 */
  density?: "default" | "compact";
  className?: string;
}

const TRACE_FAINT = "var(--color-workflow-trace)";
const TRACE_STRONG = "var(--color-workflow-trace-strong)";
const SEPARATOR = " · ";

function RunRail({ rail, intl }: { rail: WorkflowRunRail; intl: TaskWorkflowRunLinesIntl }) {
  if (rail.implicit) {
    return (
      <span
        data-workflow-run-rail="true"
        data-implicit="true"
        className="flex shrink-0 items-center"
      >
        <span aria-hidden="true" className={cn("size-1.5 rounded-full", STATUS_DOT.running)} />
      </span>
    );
  }
  return (
    <span data-workflow-run-rail="true" className="flex shrink-0 items-center">
      {rail.stations.map((station, index) => (
        <span key={`${station.name}:${index}`} className="flex items-center">
          {index > 0 ? (
            station.twin === true ? (
              // 双线段：本站与前一站并行，控制流没有从那站走到这站。两条 1px 线相距 2px
              // （容器 4px，上下各贴一条），宽度与墨色规则与普通段完全相同。
              <span
                aria-hidden="true"
                data-rail-segment={station.reached ? "strong" : "faint"}
                data-rail-twin="true"
                className="flex h-1 w-1.5 flex-col justify-between"
              >
                <span
                  className="h-px w-full"
                  style={{ backgroundColor: station.reached ? TRACE_STRONG : TRACE_FAINT }}
                />
                <span
                  className="h-px w-full"
                  style={{ backgroundColor: station.reached ? TRACE_STRONG : TRACE_FAINT }}
                />
              </span>
            ) : (
              <span
                aria-hidden="true"
                data-rail-segment={station.reached ? "strong" : "faint"}
                className="h-px w-1.5"
                style={{ backgroundColor: station.reached ? TRACE_STRONG : TRACE_FAINT }}
              />
            )
          ) : null}
          <span
            aria-hidden="true"
            data-rail-station={station.status}
            title={station.name}
            className={cn("size-1.5 rounded-full", STATUS_DOT[station.status])}
          />
        </span>
      ))}
      {rail.hidden > 0 ? (
        <span className="ml-1 text-ui-xs leading-none text-foreground-subtlest">
          {intl.formatMessage(
            { id: "taskList.workflowRun.moreStations" },
            { count: String(rail.hidden) },
          )}
        </span>
      ) : null}
    </span>
  );
}

function runStatusWord(run: SessionWorkflowRunSummary, intl: TaskWorkflowRunLinesIntl): string {
  return intl.formatMessage({ id: `chat.toolCall.workflow.run.status.${run.status}` });
}

/** 行上的词：在跑 → 当前 phase 名（无阶段词汇表 → 「Workflow」）；结束 → 中性词（+ phase / 原因）。 */
function runLineText(
  run: SessionWorkflowRunSummary,
  rail: WorkflowRunRail,
  intl: TaskWorkflowRunLinesIntl,
): string {
  if (isSessionWorkflowRunLive(run.status)) {
    if (rail.implicit) {
      return intl.formatMessage({ id: "chat.toolCall.workflow.graph.phase.workflow" });
    }
    return run.currentPhase ?? runStatusWord(run, intl);
  }
  const word = runStatusWord(run, intl);
  if (run.status === "errored" && run.currentPhase !== undefined) {
    return `${word}${SEPARATOR}${run.currentPhase}`;
  }
  const reason = readWorkflowRunStopReason(run);
  if (reason !== undefined) {
    return `${word}${SEPARATOR}${intl.formatMessage({ id: workflowRunStopReasonMessageId(reason) })}`;
  }
  return word;
}

function runName(run: SessionWorkflowRunSummary, intl: TaskWorkflowRunLinesIntl): string {
  return run.name ?? intl.formatMessage({ id: "chat.toolCall.workflow.graph.phase.workflow" });
}

/** tooltip 第二行：`{phase} · {n agents working} · {elapsed}`，缺的段落省略。 */
function runTooltipDescription(
  run: SessionWorkflowRunSummary,
  intl: TaskWorkflowRunLinesIntl,
): string | undefined {
  const parts: string[] = [];
  // 并行时「当前阶段」不再是一个站：同时在跑的几站并排列出，谁都不比谁更当前。
  const parallel = workflowRunParallelPhaseLabel(run.phases);
  if (parallel !== undefined) parts.push(parallel);
  else if (run.currentPhase !== undefined) parts.push(run.currentPhase);
  if (isSessionWorkflowRunLive(run.status) && run.agentsWorking > 0) {
    parts.push(
      intl.formatMessage(
        { id: "chat.toolCall.workflow.card.agentsWorking" },
        { count: String(run.agentsWorking) },
      ),
    );
  }
  if (run.startedAt !== undefined) parts.push(formatTaskRelativeTime(run.startedAt, intl));
  return parts.length === 0 ? undefined : parts.join(SEPARATOR);
}

export function TaskWorkflowRunLines({
  activity,
  isActive,
  intl,
  session,
  density = "default",
  className,
}: TaskWorkflowRunLinesProps) {
  const isAcknowledged = useWorkflowRunAcknowledged();
  const openRun = useWorkflowRunOpen();
  const settledKey = settledWorkflowRunIds(activity).join(" ");
  // 打开会话 = 确认它此刻所有已结束的 run；会话保持打开时 run 结束也立即确认（在读者眼前折叠）。
  useEffect(() => {
    if (!isActive || settledKey.length === 0) return;
    getWorkflowRunAckStore().acknowledge(settledKey.split(" "));
  }, [isActive, settledKey]);
  const selection = useMemo(
    () => selectWorkflowRunLines(activity, isAcknowledged),
    [activity, isAcknowledged],
  );
  if (selection.lines.length === 0) return null;
  const interactive = openRun !== null && session !== undefined;
  const compact = density === "compact";

  return (
    <div
      data-workflow-run-lines="true"
      className={cn("flex min-w-0 max-w-full flex-col items-start", className)}
    >
      {selection.lines.map((run) => {
        const rail = foldWorkflowRunRail(run.phases);
        const text = runLineText(run, rail, intl);
        const name = runName(run, intl);
        const statusWord = runStatusWord(run, intl);
        const ariaLabel = intl.formatMessage(
          { id: "taskList.workflowRun.ariaLabel" },
          { name, status: statusWord },
        );
        const content = (
          <>
            <Workflow aria-hidden="true" className="size-3 shrink-0 text-foreground-subtle" />
            <RunRail rail={rail} intl={intl} />
            <span className="min-w-0 truncate">{text}</span>
          </>
        );
        const lineClassName = cn(
          "flex min-w-0 max-w-full items-center gap-1.5 rounded-md text-foreground-subtle",
          compact ? "h-6 text-ui-sm" : "h-5 text-ui-sm",
          interactive && "-ml-1 px-1 hover:bg-surface-hover hover:text-foreground",
        );
        const lineProps = {
          "data-workflow-run-line": "true",
          "data-run-id": run.runId,
          "data-run-status": run.status,
          className: lineClassName,
        };
        const line =
          interactive && session !== undefined && openRun !== null ? (
            <button
              type="button"
              {...lineProps}
              aria-label={ariaLabel}
              onClick={(event: MouseEvent<HTMLButtonElement>) => {
                // 行本身也可点（选中会话）；运行行是更具体的落点，不让点击再冒泡成一次普通选中。
                event.preventDefault();
                event.stopPropagation();
                openRun({
                  workspacePath: session.workspacePath,
                  ...(session.workspaceIdentity
                    ? { workspaceIdentity: session.workspaceIdentity }
                    : {}),
                  sessionId: session.sessionId,
                  run,
                });
              }}
            >
              {content}
            </button>
          ) : (
            <span {...lineProps} aria-label={ariaLabel}>
              {content}
            </span>
          );
        const description = runTooltipDescription(run, intl);
        return (
          <ControlHintTooltip
            key={run.runId}
            title={`${name}${SEPARATOR}${statusWord}`}
            {...(description === undefined ? {} : { description })}
            side="right"
            align="center"
          >
            {line}
          </ControlHintTooltip>
        );
      })}
      {selection.overflow > 0 ? (
        <span
          data-workflow-run-overflow={String(selection.overflow)}
          className={cn("text-foreground-subtlest", compact ? "h-6 text-ui-sm" : "h-5 text-ui-xs")}
        >
          {intl.formatMessage(
            { id: "taskList.workflowRun.moreRuns" },
            { count: String(selection.overflow) },
          )}
        </span>
      ) : null}
    </div>
  );
}
