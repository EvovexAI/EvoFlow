import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type {
  WorkflowRunArtifactSummary,
  WorkflowRunPendingQuestion,
} from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import { buildWorkflowTimeline } from "@/components/workflow-timeline/timeline-model.js";
import { workflowSubagentModelCardLabel } from "@/components/workflow-timeline/subagent-model-label.js";
import { workflowSummaryParts } from "@/components/workflow-timeline/timeline-summary.js";
import { WorkflowRunArtifactsSection } from "@/app-shell/WorkflowRunArtifactsSection.js";
import { WorkflowRunPhaseList } from "@/app-shell/WorkflowRunPhaseList.js";
import { WorkflowRunProvenance } from "@/app-shell/WorkflowRunProvenance.js";
import {
  WorkflowRunResultSections,
  WorkflowRunStatusHeader,
} from "@/app-shell/WorkflowRunSidePaneSections.js";
import {
  useWorkflowRunPaneSettings,
  workflowRunTabScope,
} from "@/app-shell/useWorkflowRunPaneSettings.js";
import { WorkflowRunSettingsPopover } from "@/components/workflow-timeline/WorkflowRunSettingsPopover.js";
import { resolveWorkflowLaunchProvenance } from "@/app-shell/workflowRunLaunchProvenance.js";
import {
  describeWorkflowRunActionRejection,
  workflowRunActionRejectionMessageId,
  type WorkflowRunAction,
  type WorkflowRunActionRejection,
} from "@/app-shell/workflowRunActionRejection.js";
import { useWorkflowSubagentModelProviderName } from "@/hooks/useWorkflowSubagentModelProviderName.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  WorkflowRunSidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import {
  isWorkflowRunCancellable,
  isWorkflowRunResumable,
  workflowRunResultView,
  type WorkflowActorInstance,
} from "@/app-shell/workflowRunPanel.js";
import { useDynamicWorkflowAvailability } from "@/hooks/useDynamicWorkflowAvailability.js";
import { useWorkflowRunArtifacts } from "@/hooks/useWorkflowRunArtifacts.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import {
  buildWorkflowGraphByToolCallId,
  resolveWorkflowRunGraph,
} from "@/v4/workflowRunCardJoin.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { useV4Conversation, V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";

/**
 * 稳定引用的空列表：pendingQuestions 键会**来回**进出（问题一被作答就整键消失），
 * 空引用要稳定，否则 memo 化的子组件每次渲染都白重渲染一遍。
 */
const EMPTY_QUESTIONS: readonly WorkflowRunPendingQuestion[] = [];
/** 同理。`artifacts` 键在零产物时缺席，而它是产物 hook 重查 journal 的依赖之一。 */
const EMPTY_ARTIFACTS: readonly WorkflowRunArtifactSummary[] = [];

const WorkflowRunContent = memo(function WorkflowRunContent({
  tab,
  onOpenWorkflowActorSession,
  onOpenWorkflowArtifact,
  onOpenWorkflowRun,
  onOpenWorkflowWorkspace,
}: {
  tab: WorkflowRunSidePaneTab;
  onOpenWorkflowActorSession?: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  onOpenWorkflowArtifact?: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  /** 「已被 run X 替代」→ 后继 run 的详情 tab。 */
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  /** 脊线上的脚本行 → 脚本 transcript tab，落到那一站。 */
  onOpenWorkflowWorkspace?: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
}) {
  const { intl } = useZCodeIntl();
  const { layer, sendCommand } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);

  // 详情页重新订阅**父会话**的投影（照 PlanDetailSidePane）：运行态是父会话的权威投影，
  // 不是这个面板的本地查询缓存。
  useEffect(() => {
    const nextLease = layer.acquire(tab.parentSessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, tab.parentSessionId]);
  const state = useConversationProjection(lease);
  const snapshot = state.snapshot;
  // 打开请求里的 workspace 作用域（actor / 脚本 / 产物 / 后继 tab 都带同一份）。
  const { remoteSessionId, workspaceIdentity, workspacePath } = tab;
  const tabScope = useMemo(
    () => workflowRunTabScope({ remoteSessionId, workspaceIdentity, workspacePath }),
    [remoteSessionId, workspaceIdentity, workspacePath],
  );

  const run = useMemo(
    () => snapshot?.workflowRuns?.runs.find((candidate) => candidate.runId === tab.runId),
    [snapshot?.workflowRuns, tab.runId],
  );
  // 后继（`run.supersededBy`）要在投影里、且带自己的发起行 id 才开得了：打开请求的 toolCallId 是
  // 详情页找图的钥匙，填错会让后继的详情页落「历史里没有这张图」。
  const successor = useMemo(() => {
    const supersededBy = run?.supersededBy;
    if (supersededBy === undefined) return undefined;
    const candidate = snapshot?.workflowRuns?.runs.find((item) => item.runId === supersededBy);
    return candidate?.toolCallId === undefined ? undefined : candidate;
  }, [run?.supersededBy, snapshot?.workflowRuns]);
  const handleOpenSuccessor = useCallback(() => {
    if (successor?.toolCallId === undefined) return;
    onOpenWorkflowRun?.({
      ...tabScope,
      parentSessionId: tab.parentSessionId,
      toolCallId: successor.toolCallId,
      runId: successor.runId,
      ...(tab.workflowName ? { workflowName: tab.workflowName } : {}),
    });
  }, [onOpenWorkflowRun, successor, tab.parentSessionId, tab.workflowName, tabScope]);

  // 静态图按**发起 toolCallId** 取：与轮尾 run 卡、
  // 脚本 transcript 同一张表——CreateWorkflow 工具行或直接启动轮的元数据，谁挂着图都一样。行窗口是
  // 有界的，老对话里翻不到发起行是正常情况，不是错误——此时没有图可给。
  // 「配置」修订出来的 run 在设置轮落地之前借前驱的图（规则与理由见 resolveWorkflowRunGraph）。
  const graph = useMemo<WorkflowCausalityGraphData | undefined>(
    () =>
      resolveWorkflowRunGraph(
        buildWorkflowGraphByToolCallId(snapshot?.rows.window),
        tab.toolCallId,
        snapshot?.workflowRuns?.runs,
      ),
    [snapshot?.rows.window, snapshot?.workflowRuns, tab.toolCallId],
  );

  // 直接启动的来龙去脉：作用域、说明、实参与
  // 「由你从工作流中枢启动」。只对中枢启动的 run 在场；工具路径发起的 run 没有这一节。
  const provenance = useMemo(
    () => resolveWorkflowLaunchProvenance(snapshot?.rows.window, tab.toolCallId),
    [snapshot?.rows.window, tab.toolCallId],
  );

  // 一个模型，三处消费：清单与摘要行都从它出发。
  const model = useMemo(
    () => (graph === undefined ? undefined : buildWorkflowTimeline(graph, run)),
    [graph, run],
  );
  // 子代理模型：状态头第一行不再摆芯片，
  // 模型名成了摘要行的第一段——这一行本来就是「这条 run 的几个数」。强度与规范串进 tooltip。
  const subagentModelProviderName = useWorkflowSubagentModelProviderName(
    tab.workspacePath,
    tab.workspaceIdentity,
  );
  const subagentModel = useMemo(
    () =>
      workflowSubagentModelCardLabel(run?.subagentModel, {
        formatMessage: intl.formatMessage.bind(intl),
        ...(subagentModelProviderName === undefined
          ? {}
          : { providerName: subagentModelProviderName }),
      }),
    [intl, run?.subagentModel, subagentModelProviderName],
  );
  const summaryParts = useMemo(
    () =>
      model === undefined || run === undefined
        ? undefined
        : workflowSummaryParts(
            intl.formatMessage.bind(intl),
            model,
            run,
            subagentModel === undefined ? {} : { subagentModelName: subagentModel.name },
          ),
    [intl, model, run, subagentModel],
  );

  const cancellable = isWorkflowRunCancellable(run);
  // 最近一次被拒的 Cancel / Resume。run 状态
  // 一变（真取消了 / 真恢复了 / 冷回放补上了结算）提示就不再适用，随状态变化清掉——是「变化」而不是
  // 「与当时不同」：状态绕一圈回到原值时，旧提示也不该再冒出来。
  const [rejection, setRejection] = useState<WorkflowRunActionRejection | undefined>(undefined);
  const runStatus = run?.status;
  useEffect(() => {
    setRejection(undefined);
  }, [runStatus]);
  const recordAck = useCallback(
    (action: WorkflowRunAction, ack: Parameters<typeof describeWorkflowRunActionRejection>[1]) => {
      const next = describeWorkflowRunActionRejection(action, ack);
      setRejection(next);
      if (next !== undefined) {
        logger.warn(`[workflow-run] ${action} 被拒绝`, {
          reasonCode: ack.reasonCode,
          runId: tab.runId,
          status: ack.status,
        });
      }
    },
    [tab.runId],
  );
  const rejectionView = useMemo(() => {
    if (rejection === undefined) return undefined;
    return {
      text: intl.formatMessage(
        { id: workflowRunActionRejectionMessageId(rejection) },
        { code: rejection.code },
      ),
      ...(rejection.message === undefined ? {} : { detail: rejection.message }),
    };
  }, [intl, rejection]);

  const handleCancel = useCallback(() => {
    // 取消只有一条路径：既有的 v4 cancelBackgroundWork {workId ≡ runId}。
    void sendCommand(
      createCommandEnvelope({
        type: "cancelBackgroundWork",
        payload: { workId: tab.runId },
        sessionId: tab.parentSessionId,
      }),
    ).then((ack) => recordAck("cancel", ack));
  }, [recordAck, sendCommand, tab.parentSessionId, tab.runId]);

  // Resume 可用性只读投影的 `resumable` 状态位：
  // 重启后投影由 CLI 冷回放补齐，这里不再另查 journal 摘要。
  //
  // 再叠一道灰度门：已有的 run 照常渲染
  // ——状态头、时间线、产物一件不少——唯独 Resume 收起来，因为按下去会真的起一台引擎。
  // 快照未就绪时 enabled 为 false，按未命中处理：宁可按钮晚半拍出现，也不给一个随时会消失的按钮。
  const { enabled: dynamicWorkflowEnabled } = useDynamicWorkflowAvailability();
  const resumable = isWorkflowRunResumable(run) && dynamicWorkflowEnabled;
  // 「配置」：与 Resume 同一道灰度门；
  // 被接受后面板跟着工作流走到新 run（useWorkflowRunPaneSettings）。
  const settings = useWorkflowRunPaneSettings({
    enabled: dynamicWorkflowEnabled,
    run,
    runs: snapshot?.workflowRuns?.runs,
    sendCommand,
    sessionConfig: snapshot?.sessionId === tab.parentSessionId ? snapshot?.config : undefined,
    tab,
    ...(onOpenWorkflowRun === undefined ? {} : { onOpenWorkflowRun }),
  });
  const handleResume = useCallback(() => {
    // resume 是新 v4 命令（不携 baseRevision，与 cancel 同类）；workId ≡ runId。
    // `name` 喂恢复后完成通知的主题——重启后原工具 input 不可得，tab 上的展示名是仅存来源。
    void sendCommand(
      createCommandEnvelope({
        type: "resumeWorkflowRun",
        payload: {
          workId: tab.runId,
          ...(tab.workflowName?.trim() ? { name: tab.workflowName.trim() } : {}),
        },
        sessionId: tab.parentSessionId,
      }),
    ).then((ack) => {
      recordAck("resume", ack);
      // 接受后活投影会以 run-started 翻回 running，reducer 随之剥掉 resumable，按钮自然收起。
    });
  }, [recordAck, sendCommand, tab.parentSessionId, tab.runId, tab.workflowName]);

  const handleOpenActor = useCallback(
    (instance: WorkflowActorInstance) => {
      onOpenWorkflowActorSession?.({
        ...tabScope,
        parentSessionId: tab.parentSessionId,
        runId: tab.runId,
        ...(instance.sessionId ? { actorSessionId: instance.sessionId } : {}),
        siteId: instance.siteId,
        ordinal: instance.ordinal,
        ...(instance.name ? { actorName: instance.name } : {}),
      });
    },
    [onOpenWorkflowActorSession, tab.parentSessionId, tab.runId, tabScope],
  );

  // 脚本 transcript：与 actor 同构，行只交出阶段 id，scope 与 run 身份在这里补。
  const handleOpenWorkspace = useCallback(
    (phaseId: string) => {
      onOpenWorkflowWorkspace?.({
        ...tabScope,
        parentSessionId: tab.parentSessionId,
        toolCallId: tab.toolCallId,
        runId: tab.runId,
        ...(tab.workflowName ? { workflowName: tab.workflowName } : {}),
        phaseId,
      });
    },
    [
      onOpenWorkflowWorkspace,
      tab.parentSessionId,
      tab.runId,
      tab.toolCallId,
      tab.workflowName,
      tabScope,
    ],
  );

  // 落点：每次打开都重落——`openedAt` 随打开刷新，所以同一站再点一次
  // 键也变、清单再落一次。
  const landing = useMemo(
    () =>
      tab.focusPhaseId === undefined
        ? undefined
        : { key: `${tab.focusPhaseId}@${tab.openedAt ?? 0}`, phaseId: tab.focusPhaseId },
    [tab.focusPhaseId, tab.openedAt],
  );

  // 产物。活投影只带最新版的元数据，spec 与版本历史在
  // journal 里，所以 hook 两边都读——`run` 不在投影里（冷恢复 / 被 8-run 上限淘汰）时
  // `live` 缺席，整份清单走 journal。
  const { artifacts } = useWorkflowRunArtifacts({
    sessionId: tab.parentSessionId,
    runId: tab.runId,
    ...(run === undefined ? {} : { live: run.artifacts ?? EMPTY_ARTIFACTS }),
  });
  const handleOpenArtifact = useCallback(
    (artifactId: string) => {
      // 卡片只发意图（哪个产物），会话与 workspace 身份由这里补齐——与 actor transcript
      // 同一条论证：卡片不感知 scope。**不带版本号**：打开即最新版。
      //
      // 这份清单是活投影 + journal 的合并视图，所以 `contentType` 与 `sourcePath` 两个键都在：
      // 前者让宿主把 html 产物直接开成浏览器 tab，后者省掉宿主再查一次 journal
      const artifact = artifacts.find((candidate) => candidate.id === artifactId);
      onOpenWorkflowArtifact?.({
        ...tabScope,
        parentSessionId: tab.parentSessionId,
        runId: tab.runId,
        artifactId,
        ...(artifact?.title === undefined ? {} : { title: artifact.title }),
        ...(artifact?.contentType === undefined ? {} : { contentType: artifact.contentType }),
        ...(artifact?.sourcePath === undefined ? {} : { sourcePath: artifact.sourcePath }),
      });
    },
    [artifacts, onOpenWorkflowArtifact, tab.parentSessionId, tab.runId, tabScope],
  );

  const result = workflowRunResultView(run);
  const pendingQuestions = run?.pendingQuestions ?? EMPTY_QUESTIONS;
  const runTitle = tab.workflowName?.trim() || intl.formatMessage({ id: "sidePane.workflowRun" });

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-workflow-run-id={tab.runId}
      data-workflow-run-status={run?.status ?? "absent"}
    >
      <WorkflowRunStatusHeader
        cancellable={cancellable}
        configureOpen={settings.popover.open}
        onCancel={handleCancel}
        {...(settings.configurable ? { onConfigureFrom: settings.popover.toggleFrom } : {})}
        {...(onOpenWorkflowRun === undefined || successor === undefined
          ? {}
          : { onOpenSuccessor: handleOpenSuccessor })}
        onResume={handleResume}
        {...(rejectionView === undefined ? {} : { rejection: rejectionView })}
        resumable={resumable}
        run={run}
        {...(subagentModel === undefined ? {} : { subagentModel })}
        summaryParts={summaryParts}
        title={runTitle}
        usage={run?.usage}
      />

      {run === undefined || !settings.configurable ? null : (
        <WorkflowRunSettingsPopover
          anchorRef={settings.popover.anchorRef}
          host={settings.host}
          onAccepted={settings.onAccepted}
          onOpenChange={settings.popover.setOpen}
          open={settings.popover.open}
          run={run}
        />
      )}

      {provenance === undefined ? null : (
        <WorkflowRunProvenance
          meta={provenance.meta}
          {...(subagentModelProviderName === undefined
            ? {}
            : { providerName: subagentModelProviderName })}
          {...(provenance.startedAt === undefined ? {} : { startedAt: provenance.startedAt })}
        />
      )}

      <WorkflowRunResultSections result={result} />

      {/*
       * 阶段清单：时间线读作一份纵向清单，
       *           升级问题挂在提问者那一行下面。图不可得（老对话翻不到发起行）时念一句「图不可用」。
       */}
      {graph !== undefined && model !== undefined ? (
        <WorkflowRunPhaseList
          graph={graph}
          model={model}
          pendingQuestions={pendingQuestions}
          run={run}
          {...(onOpenWorkflowActorSession === undefined ? {} : { onOpenActor: handleOpenActor })}
          {...(onOpenWorkflowWorkspace === undefined
            ? {}
            : { onOpenWorkspace: handleOpenWorkspace })}
          {...(landing === undefined ? {} : { landing })}
        />
      ) : (
        <p
          className="flex-1 px-4 py-3 text-ui-xs text-foreground-subtle"
          data-testid="workflow-run-graph-unavailable"
        >
          {intl.formatMessage({ id: "chat.toolCall.workflow.run.graph.unavailable" })}
        </p>
      )}

      {/*
       * Artifacts 区：脚本用 `artifact.*` 交付给**用户**的产出。面板的最后一节、默认展开——它是
       *           这次运行的交付物，也是用户打开这块面板最常见的目的。零件时整区缺席；失败与取消的
       *           run 一样渲染（一个死在第 12 步的 run 仍然可能已经交付了一份 pdf）。`report` 条目、
       *           事件日志与脚本原文三节已撤走：技术细节，读者是模型与 CLI。
       */}
      {artifacts.length === 0 ? null : (
        <WorkflowRunArtifactsSection
          artifacts={artifacts}
          runId={tab.runId}
          sessionId={tab.parentSessionId}
          {...(onOpenWorkflowArtifact === undefined ? {} : { onOpenArtifact: handleOpenArtifact })}
        />
      )}
    </div>
  );
});

/**
 * workflow run 的详情页。
 *
 * 详情页承担用量、控制与交付物；图本身回到了聊天区的工具卡上，这里画的是同一个时间线模型的
 * 纵向清单。它**不复刻**卡片的有界 display——图之外的一切都读 `workflowRuns` 的权威投影，
 * 产物清单则直接读 journal。
 *
 * 面板只呈现**用户**要看的东西。`report` 条目、事件日志与脚本原文
 * 三节已经撤走——它们是技术细节，读者是模型与 CLI，不是坐在这块面板前的人。
 * journal 的读面一个没动（事件查询、report 行仍在），撤掉的只是它们在这里的显示。
 */
export const WorkflowRunSidePane = memo(function WorkflowRunSidePane({
  tab,
  onOpenWorkflowActorSession,
  onOpenWorkflowArtifact,
  onOpenWorkflowRun,
  onOpenWorkflowWorkspace,
}: {
  tab: WorkflowRunSidePaneTab;
  /** 子代理行 → actor transcript tab。缺省即行不可点。 */
  onOpenWorkflowActorSession?: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  /** 产物卡片 → 全尺寸查看 tab。缺省即卡片不可点。 */
  onOpenWorkflowArtifact?: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  /** 「已被 run X 替代」→ 后继 run 的详情 tab。缺省即那一行是静态文字。 */
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  /** 脚本行 → 脚本 transcript tab，落到那一站。缺省即行不可点。 */
  onOpenWorkflowWorkspace?: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
}) {
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );

  return (
    <V4PaneConversationProvider scope={scope}>
      <WorkflowRunContent
        tab={tab}
        {...(onOpenWorkflowActorSession === undefined ? {} : { onOpenWorkflowActorSession })}
        {...(onOpenWorkflowWorkspace === undefined ? {} : { onOpenWorkflowWorkspace })}
        {...(onOpenWorkflowArtifact === undefined ? {} : { onOpenWorkflowArtifact })}
        {...(onOpenWorkflowRun === undefined ? {} : { onOpenWorkflowRun })}
      />
    </V4PaneConversationProvider>
  );
});
