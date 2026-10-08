// ============================================================
// 详情页的「配置」
// ============================================================
// 从 WorkflowRunSidePane.tsx 拆出（max-lines 门）：弹层宿主、开关与锚点、以及 Apply 被接受之后
// 「面板跟着工作流走」——新 run 一进投影，就把这个 tab 原地换成新 run 的 tab（同一个位置、同一个名字，
// 不展开已收起的侧栏）。等的是投影里出现新 run 这一事实，不是一个超时。

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SessionConfigState, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import {
  useWorkflowRunSettingsPopoverState,
  type WorkflowRunSettingsAccepted,
  type WorkflowRunSettingsHost,
} from "@/components/workflow-timeline/WorkflowRunSettingsPopover.js";
import {
  isWorkflowRunConfigurable,
  workflowSessionModelOf,
} from "@/components/workflow-timeline/workflowRunSettings.js";
import type {
  OpenScopedWorkflowRunSideTabRequest,
  WorkflowRunSidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import type { useV4Conversation } from "@/v4/V4ConversationContext.js";

/** run tab 的 workspace 作用域：打开别的 tab（actor、脚本、产物、后继）时原样带上。 */
export function workflowRunTabScope(
  tab: Pick<WorkflowRunSidePaneTab, "workspacePath" | "workspaceIdentity" | "remoteSessionId">,
): Pick<
  OpenScopedWorkflowRunSideTabRequest,
  "workspacePath" | "workspaceIdentity" | "remoteSessionId"
> {
  return {
    workspacePath: tab.workspacePath,
    ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
    ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
  };
}

export function useWorkflowRunPaneSettings({
  enabled,
  onOpenWorkflowRun,
  run,
  runs,
  sendCommand,
  sessionConfig,
  tab,
}: {
  /** 灰度门（与 Resume 同一道）。 */
  enabled: boolean;
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  run: WorkflowRunState | undefined;
  runs: readonly WorkflowRunState[] | undefined;
  sendCommand: ReturnType<typeof useV4Conversation>["sendCommand"];
  sessionConfig: SessionConfigState | undefined;
  tab: WorkflowRunSidePaneTab;
}) {
  const configurable = enabled && isWorkflowRunConfigurable(run);
  const popover = useWorkflowRunSettingsPopoverState();
  // run 在弹层开着时变得不能配置（完成、被替代）：弹层随之卸载，开关也要跟着关——否则 run 再回到可配置
  // 状态时弹层会自己冒出来。setOpen(false) 在已关时是无操作，不会形成更新环。
  const { setOpen } = popover;
  useEffect(() => {
    if (!configurable) setOpen(false);
  }, [configurable, setOpen]);
  const sessionModel = useMemo(() => workflowSessionModelOf(sessionConfig), [sessionConfig]);
  const host = useMemo<WorkflowRunSettingsHost>(
    () => ({
      ...workflowRunTabScope(tab),
      ...(sessionModel === undefined ? {} : { sessionModel }),
      // 与 Stop / Resume 同类：不携 baseRevision，workId ≡ runId。
      apply: (change) =>
        sendCommand(
          createCommandEnvelope({
            type: "amendWorkflowRunSettings",
            payload: { workId: tab.runId, ...change },
            sessionId: tab.parentSessionId,
          }),
        ),
    }),
    [
      sendCommand,
      sessionModel,
      tab.parentSessionId,
      tab.remoteSessionId,
      tab.runId,
      tab.workspaceIdentity,
      tab.workspacePath,
    ],
  );

  // 跟随：被接受的那一刻新 run 未必已在投影里（run-started 随后才到），所以先记下，等它出现再换 tab。
  const [follow, setFollow] = useState<WorkflowRunSettingsAccepted | undefined>(undefined);
  // 就地生效的修订（只改并发上限、run 仍在运行）没有后继，
  // 结果里的 runId 就是这个 tab 自己——没有可跟随的东西，记下它只会请求把 tab 换成它自己。
  const onAccepted = useCallback(
    (accepted: WorkflowRunSettingsAccepted) => {
      if (accepted.runId !== tab.runId) setFollow(accepted);
    },
    [tab.runId],
  );
  const successorArrived =
    follow !== undefined && (runs ?? []).some((candidate) => candidate.runId === follow.runId);
  useEffect(() => {
    if (follow === undefined || !successorArrived) return;
    setFollow(undefined);
    onOpenWorkflowRun?.({
      ...workflowRunTabScope(tab),
      parentSessionId: tab.parentSessionId,
      toolCallId: follow.toolCallId,
      runId: follow.runId,
      ...(tab.workflowName ? { workflowName: tab.workflowName } : {}),
      replaceRunId: tab.runId,
    });
  }, [
    follow,
    onOpenWorkflowRun,
    successorArrived,
    tab.parentSessionId,
    tab.remoteSessionId,
    tab.runId,
    tab.workflowName,
    tab.workspaceIdentity,
    tab.workspacePath,
  ]);

  return {
    configurable,
    host,
    onAccepted,
    popover,
  };
}
