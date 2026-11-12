/**
 * EvoFlow 对话内工作流进度卡 —— 走 ZCode ``WorkflowRunDigest``（协议对齐）。
 *
 * 数据优先用工具卡 context 上的 ``workflowRun`` 投影（snapshot.workflowRuns join）；
 * 否则本地 ``GET /tasks`` 投影成同一套 ``WorkflowRunState`` + 因果图。
 * 点击 ⤢ / 打开 → 右栏 collab-workflow；Agent 药丸 → collabSubtaskTranscript。
 */
import { useMemo } from "react";
import { WorkflowRunDigest } from "@/components/workflow-timeline/WorkflowRunDigest.js";
import type { TimelinePill } from "@/components/workflow-timeline/timeline-model.js";
import { useCollabSubtasksFromApi } from "../../../react/hooks/useCollabSubtasksFromApi.js";
import { openCollabWorkflowInRightStage } from "../../../lib/right-stage/open-collab-workflow-stage.js";
import { openCollabSubtaskInRightStage } from "../../../lib/right-stage/open-collab-subtask-stage.js";
import { getCurrentRightStageSessionKey } from "../../../lib/right-stage/right-stage-scope.js";
import {
  buildCausalityGraphFromWorkflowRun,
  projectCollabToWorkflowRun,
} from "@/lib/collabToWorkflowProjection.js";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";
import type { PlatformWorkflowProgressRef } from "./platformWorkflowProgress.js";

const POLL_MS = 2500;

function resolveStageSessionKey(sessionKey?: string | null): string | undefined {
  const fromProp = String(sessionKey || "").trim();
  if (fromProp) return fromProp;
  return getCurrentRightStageSessionKey() || undefined;
}

export function PlatformWorkflowProgressCard({
  progressRef,
  sessionKey,
  toolCallId,
  workflowRun,
}: {
  progressRef: PlatformWorkflowProgressRef;
  sessionKey?: string | null;
  toolCallId: string;
  /** 宿主从 snapshot.workflowRuns join 进来的摘要（协议权威）。 */
  workflowRun?: WorkflowRunCardSummary;
}) {
  const { mainTaskId, name, leadThreadId, runId } = progressRef;

  const joined = workflowRun?.run;
  // childWorks  stub 常带空 nodes；有 join 但画不出站台时仍要拉 /tasks，否则 hasRail=false、
  // 点卡身无法展开下方时间线，只剩右上角 ⤢。
  const joinedHasStations =
    joined !== undefined &&
    ((joined.nodes?.length ?? 0) > 0 ||
      (joined.phaseNames?.length ?? 0) > 0 ||
      (joined.phases?.length ?? 0) > 0);
  const needLocalFetch = !joinedHasStations;

  const { subtasks, mainTask } = useCollabSubtasksFromApi({
    taskId: mainTaskId,
    threadId: leadThreadId || null,
    sessionKey: sessionKey || null,
    enabled: Boolean(mainTaskId) && needLocalFetch,
    pollMs: POLL_MS,
  });

  const localProjection = useMemo(() => {
    if (joinedHasStations) return null;
    return projectCollabToWorkflowRun({
      mainTask: mainTask || {
        taskId: mainTaskId,
        name,
        status: workflowRun?.status ?? "running",
      },
      subtasks,
      toolCallId,
      runId: mainTaskId,
      name,
    });
  }, [
    joinedHasStations,
    mainTask,
    mainTaskId,
    name,
    subtasks,
    toolCallId,
    workflowRun?.status,
  ]);

  const summary: WorkflowRunCardSummary | undefined =
    (joinedHasStations ? workflowRun : undefined) ??
    localProjection?.summary ??
    workflowRun;
  const graph = useMemo(() => {
    if (joinedHasStations && joined) return buildCausalityGraphFromWorkflowRun(joined);
    return localProjection?.graph ?? (joined ? buildCausalityGraphFromWorkflowRun(joined) : undefined);
  }, [joined, joinedHasStations, localProjection]);

  const displayName = String(localProjection?.name || name || "工作流").trim() || "工作流";
  // 右栏 / GET /tasks 只认主任务 id；协议 runId 也对齐为 mainTaskId。
  const effectiveRunId = String(mainTaskId || summary?.runId || runId || "").trim();
  const stageSessionKey = resolveStageSessionKey(sessionKey);

  const openRun = () => {
    if (!effectiveRunId) return;
    openCollabWorkflowInRightStage(
      {
        mainTaskId: effectiveRunId,
        title: displayName,
        ...(leadThreadId ? { leadThreadId } : {}),
      },
      { sessionKey: stageSessionKey, forceExpand: true },
    );
  };

  const openPill = (pill: TimelinePill) => {
    if (!effectiveRunId) return;
    // stepIds 在投影里就是 subtaskId（见 collabToWorkflowProjection.siteIdFor）
    const subtaskId = String(pill.stepIds?.[0] || "").trim();
    if (!subtaskId) return;
    const title =
      String(pill.runtimeName || pill.lane?.name || subtaskId).trim() || subtaskId;
    // 与右侧画布节点同一载荷：subtaskThreadId ≡ actor.sessionId ≡ collab subtask_thread_id
    const subtaskThreadId = String(pill.instance?.sessionId || "").trim();
    openCollabSubtaskInRightStage(
      {
        subtaskId,
        mainTaskId: effectiveRunId,
        title,
        ...(leadThreadId ? { leadThreadId } : {}),
        ...(subtaskThreadId ? { subtaskThreadId } : {}),
        ...(pill.status ? { status: String(pill.status) } : {}),
      },
      { sessionKey: stageSessionKey },
    );
  };

  if (!summary && !localProjection) {
    return (
      <div
        className="rounded-xl border border-border/70 bg-card/70 px-3.5 py-2.5 text-ui-sm text-foreground-subtlest"
        data-testid="platform-workflow-progress-card-loading"
      >
        正在拉取工作流进度…
      </div>
    );
  }

  return (
    <WorkflowRunDigest
      graph={graph}
      name={displayName}
      onOpenPill={openPill}
      onOpenRun={() => openRun()}
      runId={effectiveRunId}
      summary={summary}
      testIdKey={`platform-${toolCallId}`}
    />
  );
}
