import { memo, useEffect, useMemo } from "react";
import { HourglassIcon } from "lucide-react";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { WorkflowActorSessionSidePaneTab } from "@/lib/workspaceSidePane.js";
import { workflowActorStartState } from "@/app-shell/workflowRunPanel.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { useV4Conversation, V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";

interface WorkflowActorSessionSidePaneProps {
  tab: WorkflowActorSessionSidePaneTab;
  focused: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
}

/**
 * 未启动占位。从卡上一枚还没启动的药丸点开的 tab 落地就是它。
 *
 * 措辞只说「还没开始」并交代它会自己出现——这是实话（门读实时投影），也避免用户去点
 * 一个并不存在的重试。状态不靠颜色单独表达：图标 + 标题 + 正文都在说同一件事。
 */
function WorkflowActorNotStarted() {
  const { intl } = useZCodeIntl();
  return (
    <div
      className="flex h-full flex-col items-center justify-center px-6 text-center"
      data-testid="workflow-actor-not-started"
    >
      <HourglassIcon className="size-8 text-foreground-subtlest" />
      <p className="mt-3 text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "chat.toolCall.workflow.run.actor.notStarted.title" })}
      </p>
      <p className="mt-1 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "chat.toolCall.workflow.run.actor.notStarted.body" })}
      </p>
    </div>
  );
}

/**
 * 门 + 嵌套只读 SessionPane。
 *
 * 门的输入是**父会话**的 `workflowRuns` 投影（照 `WorkflowRunSidePane`：运行态是父会话的
 * 权威投影，不是这个面板的本地缓存）。租约是引用计数的，父会话通常已经被主面板订阅着，
 * 所以这一份读取不额外建连。
 *
 * `notStarted` 时**整棵 SessionPane 不挂载**——不是渲染一个隐藏的它。订阅发生在
 * SessionPane 内部的 `layer.acquire(actorSessionId)` 上，只有不挂载才真的没有失败订阅，
 * 也就没有那个停在 error 只等手动 retry 的投影 store。
 */
const WorkflowActorSessionContent = memo(function WorkflowActorSessionContent({
  tab,
  focused,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
}: WorkflowActorSessionSidePaneProps) {
  const { layer } = useV4Conversation();

  // 父会话租约走**渲染期同步建连**（`useMemo`，同 `ReadyV4PaneConversationProvider`），
  // 不是 `WorkflowRunSidePane` 的 `useEffect` + `setLease`。区别是要紧的：effect 版的**首帧**
  // 没有投影，门只能判 unknown，SessionPane 于是挂上一帧、对着还不存在的会话订阅一次并失败。
  // 而失败的 store 会带着 status:"error" 在 SessionDataLayer 的 keep-warm 里活满 30 秒，
  // 门后来放行时的 acquire 直接复用它（refCount++，不再 connect）——那正是本要修掉的死面板。
  // 详情页可以承受晚一帧（它只是先画个空态），这道门不行。
  const lease = useMemo(() => layer.acquire(tab.parentSessionId), [layer, tab.parentSessionId]);
  useEffect(() => () => lease.release(), [lease]);

  const snapshot = useConversationProjection(lease).snapshot;
  const gate = useMemo(
    () =>
      workflowActorStartState(snapshot?.workflowRuns?.runs, {
        runId: tab.runId,
        siteId: tab.siteId,
        ordinal: tab.ordinal,
        ...(tab.actorSessionId === undefined ? {} : { actorSessionId: tab.actorSessionId }),
      }),
    [snapshot?.workflowRuns, tab.actorSessionId, tab.ordinal, tab.runId, tab.siteId],
  );

  // `unknown` 与 `started` 都照旧订阅：前者是 run 被淘汰 / 冷恢复后的常态，直接订阅是
  // transcript 唯一的路，真失败时既有的 error + 手动 retry 面板原样保留。没有会话 id 的
  // 槽位（未启动的药丸开的 tab）只能占位——门读实时投影，actor 带着会话出现即自愈。
  if (gate.state === "notStarted" || gate.sessionId === undefined) {
    return <WorkflowActorNotStarted />;
  }

  return (
    <SessionPane
      paneId={tab.id}
      sessionId={gate.sessionId}
      readOnly
      allowWorkspaceFileRewind
      focused={focused}
      telemetryVisible={focused}
      workspacePath={tab.workspacePath}
      workspaceIdentity={tab.workspaceIdentity}
      remoteSessionId={tab.remoteSessionId}
      onOpenBrowserUrl={onOpenBrowserUrl}
      onOpenCodeViewer={onOpenCodeViewer}
      onOpenFileLink={onOpenFileLink}
    />
  );
});

/**
 * 一个 dwf actor 实例的 transcript。
 *
 * 组合方式照 `SubagentSessionSidePane`：pane scope + 嵌套**只读** `SessionPane`。除了未启动
 * 门之外这里没有任何自己的取数逻辑，而这正是把 actor 会话落成真实持久会话换来的东西——
 * 实时流、冷恢复、run 结束之后的回看，全部由既有 SessionPane 链路负责。
 *
 * 与 subagent 面板的两处**刻意**不同：
 *
 * - 不传 `onOpenSubagentSession`：actor 的工具面里 subagent 是关掉的（引擎 spec 的
 *   「Actor tool surface」），没有嵌套下钻可点，也就不该摆一个入口。
 * - 不传 `rootSessionId`：actor 会话不在任何 subagent 树里。编一个根会让这个只读面板去
 *   订阅一条与它无关的会话。
 */
export const WorkflowActorSessionSidePane = memo(function WorkflowActorSessionSidePane({
  tab,
  focused,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
}: WorkflowActorSessionSidePaneProps) {
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
      <WorkflowActorSessionContent
        tab={tab}
        focused={focused}
        onOpenBrowserUrl={onOpenBrowserUrl}
        onOpenCodeViewer={onOpenCodeViewer}
        onOpenFileLink={onOpenFileLink}
      />
    </V4PaneConversationProvider>
  );
});
