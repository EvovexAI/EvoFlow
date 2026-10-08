/**
 * GetWorkflowRun 工具卡的**情势截面**：阶段轨 + 健康行（花名册在
 * get-workflow-run-roster.tsx）。
 *
 * 两条纪律与模型面
 * （apps/zcode-cli/packages/core/src/tool/handlers/get-workflow-run-format-roster.ts）一字不差：
 *   1. **缺席即不画**。没有时刻就没有年龄，没有读数就没有那一格；`0` 是一件事实，
 *      而「不知道」是另一件——绝不用 0 顶替后者。
 *   2. 所有年龄对**快照时刻** `generatedAt` 算，不对 `Date.now()` 算：一张三天前的卡
 *      重新打开时读数不能跟着今天漂。`generatedAt` 缺席就一个年龄都不画。
 *
 * 布局：一律换行行（flex-wrap），没有定宽表格——手机窄屏下要能折行而不是横向溢出。
 */

import type { ToolCallGetWorkflowRunDisplay } from "@zcode/shared/zcode-protocol-v4";
import { throttleReasonLabel } from "@/app-shell/workflowRunThrottle.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatWorkflowAge, formatWorkflowDuration } from "@/lib/workflowObservationFormat.js";

type WorkflowRunPhaseView = NonNullable<ToolCallGetWorkflowRunDisplay["phases"]>[number];
type WorkflowRunHealthView = NonNullable<ToolCallGetWorkflowRunDisplay["health"]>;

const I18N_PREFIX = "chat.toolCall.workflow.getRun.";

/** 情势区块的容器：与同一张卡里的日志面板同款低层容器，不是第二种卡面。 */
export const SITUATION_BLOCK_CLASS =
  "min-w-0 space-y-1 rounded-lg border border-border bg-surface px-2 py-1.5";

/** 情势区块里的一行：窄屏折行，基线对齐（数字与文字混排时才不会互相顶高）。 */
export const SITUATION_ROW_CLASS = "flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5";

/**
 * 阶段状态词的语义色。与 run 整体状态同一套判断（run-status-presentation.ts）：
 * 在动的用活动色 warning，完成用 success，还没发生的最弱，终态没结算的居中。
 */
const PHASE_STATE_TEXT: Record<WorkflowRunPhaseView["state"], string> = {
  done: "text-success",
  current: "text-warning",
  ahead: "text-foreground-subtlest",
  unfinished: "text-foreground-subtle",
};

/**
 * 阶段轨：一行一个阶段，声明序。`ahead` 的行只有序号、名字和状态词——它还没发生过，
 * 没有轮次也没有步数可说。
 */
export function WorkflowRunPhaseTrack({
  phases,
  generatedAt,
  terminal,
}: {
  phases: readonly WorkflowRunPhaseView[];
  generatedAt: number | undefined;
  terminal: boolean;
}) {
  const { intl } = useZCodeIntl();
  if (phases.length === 0) return null;
  return (
    <div className={SITUATION_BLOCK_CLASS} data-testid="workflow-run-phases">
      {phases.map((phase, index) => {
        const cells: string[] = [];
        // rounds 为 0 只可能是 `ahead`：没进过的阶段说不出「进过几次」。
        if (phase.rounds > 0) {
          cells.push(
            intl.formatMessage(
              { id: `${I18N_PREFIX}phase.${phase.rounds === 1 ? "roundsOne" : "rounds"}` },
              { count: phase.rounds },
            ),
          );
        }
        if (phase.nodesSettled > 0) {
          cells.push(
            intl.formatMessage(
              { id: `${I18N_PREFIX}phase.settled` },
              { count: phase.nodesSettled },
            ),
          );
        }
        if (phase.nodesRunning > 0) {
          // 终态 run 里的「还在跑」是没结算，不是在动。
          cells.push(
            intl.formatMessage(
              { id: `${I18N_PREFIX}phase.${terminal ? "unfinished" : "running"}` },
              { count: phase.nodesRunning },
            ),
          );
        }
        const duration = phaseDuration(phase, generatedAt, terminal, intl.formatMessage);
        return (
          <div className={SITUATION_ROW_CLASS} key={`${phase.name}-${index}`}>
            <span className="shrink-0 tabular-nums text-foreground-subtlest">{index + 1}.</span>
            <span className="min-w-0 break-words text-foreground">{phase.name}</span>
            <span className={`shrink-0 ${PHASE_STATE_TEXT[phase.state]}`}>
              {intl.formatMessage({ id: `${I18N_PREFIX}phase.state.${phase.state}` })}
            </span>
            {cells.map((cell) => (
              <span className="text-foreground-subtle" key={cell}>
                {cell}
              </span>
            ))}
            {duration === undefined ? null : (
              <span className="text-foreground-subtlest">{duration}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

type FormatMessage = ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"];

function phaseDuration(
  phase: WorkflowRunPhaseView,
  generatedAt: number | undefined,
  terminal: boolean,
  formatMessage: FormatMessage,
): string | undefined {
  if (phase.enteredAt === undefined) return undefined;
  if (phase.exitedAt !== undefined) return formatWorkflowDuration(phase.exitedAt - phase.enteredAt);
  // 没有离开时刻：活着的 run 说「到现在为止」；终态 run 什么也不说——它的离开时刻无人记录，
  // 拿快照时刻去减等于把进程死后的那几个小时算进这个阶段。
  if (terminal) return undefined;
  const soFar = formatWorkflowAge(generatedAt, phase.enteredAt);
  return soFar === undefined
    ? undefined
    : formatMessage({ id: `${I18N_PREFIX}phase.soFar` }, { duration: soFar });
}

/**
 * 健康行：run 整体还在不在动，一行读数。
 *
 * `stalled` 只对活着的 run 有意义（终态 run 当然不动了）；终态 run 换成一句 **leftover 说明**
 * ——花名册里那些标着运行中的行是进程死在它们下面的残留。这是本张卡上唯一一处「把不知道
 * 说出口」的地方（另一处是待答问题不可见的提示）：沉默会被读成「它们还在跑」。
 *
 * `consecutiveFailures` / `cachedSteps` 只在大于 0 时出现：这两个读数为 0 时不是新闻，
 * 而卡面比模型面更吝惜行。
 */
export function WorkflowRunHealthLine({
  health,
  generatedAt,
  terminal,
}: {
  health: WorkflowRunHealthView;
  generatedAt: number | undefined;
  terminal: boolean;
}) {
  const { intl } = useZCodeIntl();
  const cells: string[] = [];

  const lastProgress = formatWorkflowAge(generatedAt, health.lastProgressAt);
  if (lastProgress !== undefined) {
    cells.push(
      intl.formatMessage({ id: `${I18N_PREFIX}health.lastProgress` }, { age: lastProgress }),
    );
  }

  if (health.concurrency !== undefined) {
    const { effective, cap, reason, since } = health.concurrency;
    cells.push(intl.formatMessage({ id: `${I18N_PREFIX}health.concurrency` }, { effective, cap }));
    // 原因与起始时刻各占一格，不塞进括号：括号的形状中英文不同，而这一行本来就是按格读的。
    // reason 是开放字符串，认识的映射成短标签，不认识的原样显示。
    if (reason !== undefined) cells.push(throttleReasonLabel(reason, intl.formatMessage));
    const sinceAge = formatWorkflowAge(generatedAt, since);
    if (sinceAge !== undefined) {
      cells.push(
        intl.formatMessage({ id: `${I18N_PREFIX}health.concurrencySince` }, { age: sinceAge }),
      );
    }
  }

  if (!terminal) {
    const stalledAge = formatWorkflowAge(generatedAt, health.stalledSince);
    cells.push(
      health.stalledSince === undefined
        ? intl.formatMessage({ id: `${I18N_PREFIX}health.notStalled` })
        : stalledAge === undefined
          ? intl.formatMessage({ id: `${I18N_PREFIX}health.stalledNoClock` })
          : intl.formatMessage({ id: `${I18N_PREFIX}health.stalled` }, { age: stalledAge }),
    );
  }

  if (health.consecutiveFailures > 0) {
    cells.push(
      intl.formatMessage(
        {
          id: `${I18N_PREFIX}health.${health.consecutiveFailures === 1 ? "failuresOne" : "failures"}`,
        },
        { count: health.consecutiveFailures },
      ),
    );
  }
  if (health.cachedSteps > 0) {
    cells.push(
      intl.formatMessage(
        {
          id: `${I18N_PREFIX}health.${health.cachedSteps === 1 ? "cachedStepsOne" : "cachedSteps"}`,
        },
        { count: health.cachedSteps },
      ),
    );
  }

  const leftover = terminal ? health.leftoverRunning : undefined;
  if (cells.length === 0 && leftover === undefined) return null;
  return (
    <div className="min-w-0 space-y-1" data-testid="workflow-run-health">
      {cells.length === 0 ? null : (
        <div className={`${SITUATION_ROW_CLASS} text-ui-sm text-foreground-subtlest`}>
          {cells.map((cell) => (
            <span key={cell}>{cell}</span>
          ))}
        </div>
      )}
      {leftover === undefined ? null : (
        <p className="break-words text-ui-sm text-warning" data-testid="workflow-run-leftover">
          {intl.formatMessage(
            { id: `${I18N_PREFIX}health.${leftover === 1 ? "leftoverOne" : "leftover"}` },
            { count: leftover },
          )}
        </p>
      )}
    </div>
  );
}
