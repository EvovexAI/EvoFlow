import { useEffect, useState } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { zcodeSessionSnapshotToTaskMeta } from "@/lib/zcodeSessionProjection.js";

function resolveImmediateActiveTaskSnapshotMeta(
  previousSnapshotMeta: ZCodeTaskMeta | null,
  taskId: string | null,
  taskMetaFromLists?: ZCodeTaskMeta | null,
) {
  if (!taskId || taskMetaFromLists) {
    return null;
  }

  // pin / archive task 切换时，如果目标任务一开始不在列表数据源里，
  // 新 snapshot 还没返回前不能继续沿用上一条任务的 snapshot meta。
  // 否则 Header 会先显示旧标题，再被异步结果改正，体感上就像“名称慢半拍”。
  // 这里只允许复用“同一个 taskId”的旧 snapshot，跨任务切换时立刻清空。
  return previousSnapshotMeta?.taskId === taskId ? previousSnapshotMeta : null;
}

/**
 * 为当前激活 task 提供一层 snapshot meta 兜底。
 *
 * archived task 不在普通 taskListCache / pinnedTasks 数据源里，
 * 直接打开时 App 只靠列表元数据会拿不到标题、provider、traceId 等字段。
 * 这里在列表里找不到当前任务时，额外读取一次 snapshot.meta 作为展示兜底，
 * 只服务当前激活任务，不把 archived task 混回普通列表。
 */
export function useActiveTaskSnapshotMeta(
  workspacePath: string,
  taskId: string | null,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string,
  taskMetaFromLists?: ZCodeTaskMeta | null,
) {
  const zcodeSessionService = useZCodeSessionService(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  const [snapshotMeta, setSnapshotMeta] = useState<ZCodeTaskMeta | null>(null);

  useEffect(() => {
    let cancelled = false;

    setSnapshotMeta((currentSnapshotMeta) =>
      resolveImmediateActiveTaskSnapshotMeta(currentSnapshotMeta, taskId, taskMetaFromLists),
    );

    if (!taskId) {
      return () => {
        cancelled = true;
      };
    }

    if (taskMetaFromLists) {
      return () => {
        cancelled = true;
      };
    }

    void zcodeSessionService
      // active header 只需要 session meta/标题兜底，走 ZCode Protocol 的轻量读取，
      // 避免继续经 legacy snapshot 把大任务消息整包拉回 UI。
      .readSession({
        workspacePath,
        workspaceIdentity,
        sessionId: taskId,
        messageLimit: 1,
      })
      .then((snapshot) => {
        if (cancelled) {
          return;
        }
        setSnapshotMeta(zcodeSessionSnapshotToTaskMeta(snapshot));
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setSnapshotMeta(null);
      });

    return () => {
      cancelled = true;
    };
  }, [zcodeSessionService, taskId, taskMetaFromLists, workspaceIdentity, workspacePath]);

  return snapshotMeta;
}
