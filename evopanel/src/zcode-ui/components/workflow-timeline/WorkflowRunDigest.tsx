import { useMemo, useState } from "react";
import {
  MessageCircleQuestionIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
  SquareIcon,
} from "lucide-react";
import { TID_CHAT_WORKFLOW_RUN_DIGEST, testId } from "@zcode/shared";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/fileSummaryTypes.js";
import { buildWorkflowTimeline, type TimelinePill } from "./timeline-model.js";
import { workflowCardDetail } from "./timeline-summary.js";
import {
  WORKFLOW_RUN_ENDED_KIND_ID,
  WorkflowCardHeader,
  workflowRunKindMessageId,
} from "./WorkflowCardChrome.js";
import { WorkflowArtifactStrip } from "./WorkflowArtifactStrip.js";
import {
  useWorkflowRunSettingsPopoverState,
  WorkflowRunSettingsPopover,
  type WorkflowRunSettingsHost,
} from "./WorkflowRunSettingsPopover.js";
import { timelineHeight, WorkflowTimeline } from "./WorkflowTimeline.js";
import { WorkflowTruncatedNotice } from "./WorkflowTruncatedNotice.js";

/** 下方运行卡默认展开，无箭头但仍可收起；状态由标题表达。 */
export interface WorkflowRunDigestProps {
  name: string;
  runId: string;
  /** 该 run 的发起图（按发起 toolCallId 查到）；缺席即画不出阶段线（行窗口没带发起行）。 */
  graph: WorkflowCausalityGraphData | undefined;
  /**
   * 活投影的联接摘要。缺席 = run 不在投影里（八条上限淘汰 / 冷恢复无 journal 命中）：卡退成中性单行
   * ——种类词「工作流已结束」、无灯无轨道无 Cancel / Resume，只留 ⤢（侧板会说「不再实时追踪」）。
   */
  summary: WorkflowRunCardSummary | undefined;
  /** 该 run 停驻的待答问题数；> 0 时表头出现警示色芯片。 */
  pendingQuestions?: number;
  /**
   * 打开 run 详情；缺席即无 ⤢、芯片不可点、「还有 n 个」那一行是静态的。带 `landing` 时详情页落到
   * 那一站：只有那一行会带，⤢ 与问题芯片开的是整个 run。
   */
  onOpenRun?: (landing?: { phaseId: string }) => void;
  /** 恢复 run；只在 `summary.resumable` 且回调在场时渲染 Resume。 */
  onResume?: () => void;
  /**
   * 停止 run；只在 running 且回调
   * 在场时渲染 Stop，与 Resume 占同一个位置——两个互斥状态，用户从卡上就看到 run 的两条出路。
   */
  onCancel?: () => void;
  /** 点一枚药丸开那个子代理的 transcript；缺席即药丸不可点。 */
  onOpenPill?: (pill: TimelinePill) => void;
  /** 点脚本药丸开脚本 transcript、落到那一站；缺席即脚本药丸不可点。 */
  onOpenWorkspace?: (pill: TimelinePill) => void;
  /** 点一枚产物药丸开产物 tab；缺席即产物药丸禁用。 */
  onOpenArtifact?: (artifactId: string) => void;
  /**
   * providerId → provider 名（宿主从会话的模型清单给，见 useWorkflowSubagentModelProviderName）。
   * 缺席即拼名退回裸 modelId——**永远不显示 providerId**（团队套餐的它是一个 UUID）。
   */
  subagentModelProviderName?: (providerId: string) => string | undefined;
  /**
   * 「配置」弹层的宿主。在场即表头有
   * Configure 钮——宿主只在回调在场且 run 能配置时给它。
   */
  settingsHost?: WorkflowRunSettingsHost;
  /** testid 后缀（unit.key + toolCallId）。 */
  testIdKey: string;
}

export function WorkflowRunDigest({
  graph,
  name,
  onOpenArtifact,
  onOpenPill,
  onOpenRun,
  onOpenWorkspace,
  onResume,
  onCancel,
  pendingQuestions = 0,
  runId,
  settingsHost,
  subagentModelProviderName,
  summary,
  testIdKey,
}: WorkflowRunDigestProps) {
  const { intl } = useZCodeIntl();
  const run = summary?.run;
  const [expanded, setExpanded] = useState(true);

  // 阶段线只在有活投影且有图时画：没有投影的图全是 pending 灯，会把一条已完成的 run 画成没跑过。
  const model = useMemo(
    () =>
      graph !== undefined && graph.steps.length > 0 && run !== undefined
        ? buildWorkflowTimeline(graph, run)
        : undefined,
    [graph, run],
  );
  const hasRail = model !== undefined && model.stations.length > 0;
  const shown = useMemo(
    () =>
      expanded || !model
        ? model
        : {
            ...model,
            stations: model.stations.map((station) => ({ ...station, pills: [] })),
          },
    [expanded, model],
  );
  // 去掉箭头不代表取消折叠。仅空白区域切换，子控件继续执行各自的操作。
  const hitsControl = (target: EventTarget | null, root: HTMLElement) => {
    const control =
      target instanceof Element
        ? target.closest("button, a, input, textarea, select, [role='button']")
        : null;
    return control !== null && control !== root;
  };

  const format = intl.formatMessage.bind(intl);
  // 卡上刻意**不**画 lineage：
  // 「调整自 / 已被替代」两句只在详情页与确认窗说；卡只换种类词——卡上太吵。
  // 细节串的最后一段是子代理模型名（没指定过模型就没有这一段），强度与规范串进 tooltip。
  const cardDetail = workflowCardDetail(format, model, graph, run, subagentModelProviderName);
  const live = summary?.status === "running";
  const kind = format({
    id: summary === undefined ? WORKFLOW_RUN_ENDED_KIND_ID : workflowRunKindMessageId(summary),
  });
  const questionsLabel =
    pendingQuestions > 0
      ? format(
          {
            id:
              pendingQuestions === 1
                ? "chat.toolCall.workflow.digest.question"
                : "chat.toolCall.workflow.digest.questions",
          },
          { count: pendingQuestions },
        )
      : undefined;
  const questions =
    questionsLabel === undefined ? undefined : onOpenRun === undefined ? (
      <span
        className="wf-arrive flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--color-warning)_12%,transparent)] py-0.5 pl-1.5 pr-2 text-ui-xs font-medium text-warning"
        data-testid="workflow-digest-questions"
      >
        <MessageCircleQuestionIcon aria-hidden className="size-3" />
        {questionsLabel}
      </span>
    ) : (
      <button
        className="wf-arrive flex shrink-0 cursor-pointer items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--color-warning)_12%,transparent)] py-0.5 pl-1.5 pr-2 text-ui-xs font-medium text-warning outline-none transition-colors hover:bg-[color-mix(in_oklab,var(--color-warning)_20%,transparent)] focus-visible:ring-2 focus-visible:ring-ring/40"
        data-testid="workflow-digest-questions"
        onClick={() => onOpenRun()}
        type="button"
      >
        <MessageCircleQuestionIcon aria-hidden className="size-3" />
        {questionsLabel}
      </button>
    );
  const resume =
    summary?.resumable === true && onResume !== undefined ? (
      <Button
        data-testid="workflow-digest-resume"
        onClick={onResume}
        size="default"
        type="button"
        variant="outline"
      >
        <RotateCcwIcon className="size-3.5" />
        {format({ id: "chat.toolCall.workflow.run.resume" })}
      </Button>
    ) : undefined;
  // Stop 与 Resume 互斥（running vs 已停），共用表头右侧同一个位置。走详情页同一条命令。
  // 点下 Stop 后按钮进入禁用的「正在停止…」态，直到投影把状态换掉：按 status 键控重挂，状态一变
  // 按钮就是新的（cancelled → resume 后再 running 亦然）。复位曾是按 status 跑的
  // effect setState，每次状态变化都在投影帧的同步提交之后再补一笔更新——与工作流卡 React #185 崩溃
  // 的抛点同形；键控重挂没有第二次提交。
  const cancel =
    live && onCancel !== undefined ? (
      <CancelRunButton key={summary?.status} onCancel={onCancel} />
    ) : undefined;
  // Configure 排在 Resume / Stop 之前、每种状态里都在同一个位置，所以它出现与否从不挪动 ⤢。
  const configure =
    settingsHost !== undefined && run !== undefined ? (
      <ConfigureRunButton host={settingsHost} run={run} />
    ) : undefined;

  return (
    <section
      aria-label={kind}
      className={cn(
        "wf-motion wf-arrive flex w-full min-w-0 flex-col gap-1 rounded-xl border border-border/70 bg-card/70 px-3.5 pb-2 pt-1.5 outline-none",
        hasRail && "cursor-pointer focus-visible:ring-2 focus-visible:ring-ring/40",
      )}
      data-expanded={hasRail ? String(expanded) : undefined}
      data-testid={testId(TID_CHAT_WORKFLOW_RUN_DIGEST, testIdKey)}
      data-workflow-run-digest="true"
      data-workflow-run-id={runId}
      data-workflow-run-status={summary?.status ?? "absent"}
      role={hasRail ? "button" : undefined}
      tabIndex={hasRail ? 0 : undefined}
      aria-expanded={hasRail ? expanded : undefined}
      onClick={(event) => {
        if (hasRail && !hitsControl(event.target, event.currentTarget))
          setExpanded((value) => !value);
      }}
      onKeyDown={(event) => {
        if (
          !hasRail ||
          hitsControl(event.target, event.currentTarget) ||
          (event.key !== "Enter" && event.key !== " ")
        )
          return;
        event.preventDefault();
        setExpanded((value) => !value);
      }}
    >
      <WorkflowCardHeader
        detail={cardDetail?.detail}
        {...(cardDetail?.title === undefined ? {} : { detailTitle: cardDetail.title })}
        expanded={expanded}
        kind={kind}
        leading={questions}
        live={live}
        name={name}
        trailing={
          configure === undefined ? (
            (resume ?? cancel)
          ) : (
            <>
              {configure}
              {resume ?? cancel}
            </>
          )
        }
        {...(onOpenRun === undefined ? {} : { onOpenDetails: () => onOpenRun() })}
      />
      {shown === undefined || !hasRail ? null : (
        // 收起时只隐藏代理，保留阶段线作为运行进度概览。
        <div
          className={cn("wf-digest-plot overflow-hidden")}
          data-testid="workflow-digest-plot"
          style={{ height: timelineHeight(shown) + 8 }}
        >
          <WorkflowTimeline
            className="py-1"
            model={shown}
            {...(onOpenPill === undefined ? {} : { onOpenPill })}
            {...(onOpenWorkspace === undefined ? {} : { onOpenWorkspace })}
            {...(onOpenRun === undefined
              ? {}
              : { onOpenMore: (station) => onOpenRun({ phaseId: station.id }) })}
          />
        </div>
      )}
      {/* 时间线下的那一句「仅展示 n/m 步的详情」：表头的计数已经是真实步数，这一行只说
          停在界上的是**详情**。收起态也在——它解释的是上面那些数，不是药丸。
          没有轨道的卡（行窗口里翻不到发起行）按规范是**单行**，也没有任何计数可供限定，
          这一句跟着一起缺席。 */}
      {hasRail ? <WorkflowTruncatedNotice run={run} testId="workflow-digest-truncated" /> : null}
      {/* 产物条（追记「产物药丸」）：run 的交付物，收起与展开态都在——它是收据上最有用的一行。 */}
      {run?.artifacts !== undefined && run.artifacts.length > 0 ? (
        <WorkflowArtifactStrip
          artifacts={run.artifacts}
          className="pb-0.5 pt-0.5"
          moreTestId="workflow-digest-artifacts-more"
          pillTestId="workflow-digest-artifact"
          testId="workflow-digest-artifacts"
          {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
        />
      ) : null}
    </section>
  );
}

/**
 * 表头的 Configure 钮：滑杆图标的 ghost
 * `icon-md`，与 Stop 同形——表头容不下一枚带字的按钮。点它在自己下方开「配置」弹层。
 */
function ConfigureRunButton({
  host,
  run,
}: {
  host: WorkflowRunSettingsHost;
  run: WorkflowRunState;
}) {
  const { intl } = useZCodeIntl();
  const { anchorRef, open, setOpen, toggleFrom } = useWorkflowRunSettingsPopoverState();
  const label = intl.formatMessage({ id: "chat.toolCall.workflow.run.settings.title" });
  return (
    <>
      <ControlHintTooltip title={label} side="top">
        <Button
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={label}
          data-testid="workflow-digest-configure"
          onClick={(event) => toggleFrom(event.currentTarget)}
          size="icon-md"
          type="button"
          variant="ghost"
        >
          <SlidersHorizontalIcon className="size-3.5" />
        </Button>
      </ControlHintTooltip>
      <WorkflowRunSettingsPopover
        anchorRef={anchorRef}
        host={host}
        onOpenChange={setOpen}
        open={open}
        run={run}
      />
    </>
  );
}

/**
 * 表头的 Stop 钮：形态与 ⤢ 打开详情同款（ghost 图标钮 + 提示，不带文字——表头容不下一枚带字的
 * 按钮）。「正在停止」是它自己的局部状态；宿主按 run 状态给它 key，状态一变即重挂、自然复位。
 *
 * 提示带第二行「停止后可以随时恢复，已完成的步骤会保留。」：动词从「取消」改成「停止」之后，
 * 还要在按下去的那一刻就把「不是丢弃」说出来（一个停下的 run 是可恢复的）。正在停止时那句话
 * 撤走——决定已经做完了，没什么可再劝的。
 */
function CancelRunButton({ onCancel }: { onCancel: () => void }) {
  const { intl } = useZCodeIntl();
  const [cancelling, setCancelling] = useState(false);
  const label = intl.formatMessage({
    id: cancelling ? "chat.toolCall.workflow.run.cancelling" : "chat.toolCall.workflow.run.cancel",
  });
  return (
    <ControlHintTooltip
      title={label}
      side="top"
      {...(cancelling
        ? {}
        : {
            description: intl.formatMessage({ id: "chat.toolCall.workflow.run.stopHint" }),
          })}
    >
      <Button
        aria-label={label}
        data-testid="workflow-digest-cancel"
        disabled={cancelling}
        onClick={() => {
          setCancelling(true);
          onCancel();
        }}
        size="icon-md"
        type="button"
        variant="ghost"
      >
        <SquareIcon className="size-3.5 fill-current" />
      </Button>
    </ControlHintTooltip>
  );
}
