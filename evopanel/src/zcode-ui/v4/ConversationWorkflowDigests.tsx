import type { TimelinePill } from "@/components/workflow-timeline/timeline-model.js";
import { WorkflowRunDigest } from "@/components/workflow-timeline/WorkflowRunDigest.js";
import type { WorkflowRunSettingsHost } from "@/components/workflow-timeline/WorkflowRunSettingsPopover.js";
import { WorkflowSettingsChangeRow } from "@/components/workflow-timeline/WorkflowSettingsChangeRow.js";
import { isWorkflowRunConfigurable } from "@/components/workflow-timeline/workflowRunSettings.js";
import { useWorkflowSubagentModelProviderName } from "@/hooks/useWorkflowSubagentModelProviderName.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import type { WorkflowTurnDigest } from "@/v4/workflowTurnDigests.js";
import { resolveWorkflowRunOpenToolCallId } from "@/v4/workflowRunCardJoin.js";

/**
 * 轮尾摘要的落位：把解析出的摘要接上
 * 宿主回调。回调的存在即门控（不变式 7）：打开详情要 `onOpenWorkflowRun` + sessionId；Resume 要
 * `onResumeWorkflowRun` + 联接摘要说可恢复；药丸要 `onOpenWorkflowActor` + 活投影。与
 * `ToolCallRowView` 给工具卡接线的路径一字不差——同一个 run 从两处打开的是同一个 tab。
 */
export function ConversationWorkflowDigests({
  context,
  digests,
  turnKey,
}: {
  digests: readonly WorkflowTurnDigest[];
  context: ConversationRowRenderContext;
  turnKey: string;
}) {
  const { intl } = useZCodeIntl();
  // 子代理模型名里的 provider 名从会话的模型清单来（卡本身不碰 store，宿主把查找函数递进去）。
  const subagentModelProviderName = useWorkflowSubagentModelProviderName(
    context.workspacePath,
    context.workspaceIdentity,
  );
  if (digests.length === 0) return null;
  const fallbackName = intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" });
  return (
    <div className="flex flex-col gap-3" data-testid={`workflow-run-digests-${turnKey}`}>
      {digests.map((digest) => {
        const { runId, summary } = digest;
        const name = digest.name ?? fallbackName;
        const sessionId = context.sessionId;
        // 就地生效的设置轮：那一行就是
        // 全部呈现。提前返回，下面整套卡的接线（打开、Resume、Stop、药丸、「配置」）一条都不建——
        // 那些都是卡上的控件，而这一轮没有卡。
        if (digest.rowOnly && digest.settings !== undefined) {
          return (
            <WorkflowSettingsChangeRow
              amend={digest.settings.amend}
              key={digest.key}
              {...(digest.settings.at === undefined ? {} : { at: digest.settings.at })}
              {...(subagentModelProviderName === undefined
                ? {}
                : { providerName: subagentModelProviderName })}
            />
          );
        }
        // 「还有 n 个」那一行带落点（追记「五枚药丸与一扇门」）；⤢ 与问题芯片不带。
        const onOpenRun =
          context.onOpenWorkflowRun && sessionId
            ? (landing?: { phaseId: string }) =>
                context.onOpenWorkflowRun?.({
                  parentSessionId: sessionId,
                  toolCallId: resolveWorkflowRunOpenToolCallId(digest.toolCallId, summary),
                  runId,
                  workflowName: name,
                  ...(landing === undefined ? {} : { phaseId: landing.phaseId }),
                })
            : undefined;
        const onResume =
          context.onResumeWorkflowRun && summary?.resumable
            ? () => context.onResumeWorkflowRun?.(runId, name)
            : undefined;
        // 取消只有一条路径：详情页也走的 cancelBackgroundWork {workId ≡ runId}。
        const onCancel =
          context.onCancelBackgroundWork && summary?.status === "running"
            ? () => context.onCancelBackgroundWork?.(runId)
            : undefined;
        const onOpenPill =
          context.onOpenWorkflowActor && sessionId && summary?.run
            ? (pill: TimelinePill) => {
                // 槽位身份：会话 id 有则随行，没有就开占位 tab。
                const slot = pill.slot;
                if (slot === undefined) return;
                const actorSessionId = pill.instance?.sessionId;
                const actorName = pill.runtimeName ?? pill.lane.name;
                context.onOpenWorkflowActor?.({
                  parentSessionId: sessionId,
                  ordinal: slot.ordinal,
                  runId,
                  siteId: slot.siteId,
                  ...(actorSessionId === undefined ? {} : { actorSessionId }),
                  ...(actorName === undefined ? {} : { actorName }),
                });
              }
            : undefined;
        // 脚本药丸：与工具卡同一条路，开同一个 tab。
        const onOpenWorkspace =
          context.onOpenWorkflowWorkspace && sessionId && summary?.run
            ? (pill: TimelinePill) => {
                const phaseId = pill.workspace?.phaseId;
                if (phaseId === undefined) return;
                context.onOpenWorkflowWorkspace?.({
                  parentSessionId: sessionId,
                  toolCallId: resolveWorkflowRunOpenToolCallId(digest.toolCallId, summary),
                  runId,
                  workflowName: name,
                  phaseId,
                });
              }
            : undefined;
        const onOpenArtifact =
          context.onOpenWorkflowArtifact && sessionId
            ? (artifactId: string) => {
                // 活投影的产物摘要带最新版的 `contentType`，宿主据它把 html 产物直接开成浏览器
                // tab；`sourcePath` 那份摘要刻意不带（高频状态键），缺席时宿主自己查 journal。
                const artifact = summary?.run?.artifacts?.find(
                  (candidate) => candidate.id === artifactId,
                );
                context.onOpenWorkflowArtifact?.({
                  parentSessionId: sessionId,
                  runId,
                  artifactId,
                  ...(artifact?.title === undefined ? {} : { title: artifact.title }),
                  ...(artifact?.contentType === undefined
                    ? {}
                    : { contentType: artifact.contentType }),
                });
              }
            : undefined;
        const pendingQuestions = context.workflowRunPendingQuestionsByRunId?.get(runId)?.size ?? 0;
        // 「配置」：宿主回调在场（只读 /
        // 灰度两道门已在宿主裁过）且这条 run 能配置时才有。弹层的模型清单按本会话的作用域读。
        const amendSettings = context.onAmendWorkflowRunSettings;
        const settingsHost: WorkflowRunSettingsHost | undefined =
          amendSettings !== undefined && isWorkflowRunConfigurable(summary?.run)
            ? {
                workspacePath: context.workspacePath,
                ...(context.workspaceIdentity
                  ? { workspaceIdentity: context.workspaceIdentity }
                  : {}),
                ...(context.workspaceRemoteSessionId
                  ? { remoteSessionId: context.workspaceRemoteSessionId }
                  : {}),
                ...(context.workflowSessionModel === undefined
                  ? {}
                  : { sessionModel: context.workflowSessionModel }),
                apply: (change) => amendSettings(runId, change),
              }
            : undefined;
        const card = (
          <WorkflowRunDigest
            graph={digest.graph}
            key={digest.key}
            name={name}
            pendingQuestions={pendingQuestions}
            runId={runId}
            summary={summary}
            testIdKey={`${turnKey}-${digest.toolCallId}`}
            {...(subagentModelProviderName === undefined ? {} : { subagentModelProviderName })}
            {...(onOpenRun === undefined ? {} : { onOpenRun })}
            {...(onResume === undefined ? {} : { onResume })}
            {...(onCancel === undefined ? {} : { onCancel })}
            {...(onOpenPill === undefined ? {} : { onOpenPill })}
            {...(onOpenWorkspace === undefined ? {} : { onOpenWorkspace })}
            {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
            {...(settingsHost === undefined ? {} : { settingsHost })}
          />
        );
        // 设置轮：卡上方一行说改了什么。
        if (digest.settings === undefined) return card;
        return (
          <div className="flex flex-col gap-1.5" key={digest.key}>
            <WorkflowSettingsChangeRow
              amend={digest.settings.amend}
              {...(digest.settings.at === undefined ? {} : { at: digest.settings.at })}
              {...(subagentModelProviderName === undefined
                ? {}
                : { providerName: subagentModelProviderName })}
            />
            {card}
          </div>
        );
      })}
    </div>
  );
}
