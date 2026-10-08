import { useMemo, useRef } from "react";
import type { ZCodeProvider, ZCodeTaskMeta } from "@zcode/shared";
import { useActiveTaskSnapshotMeta } from "@/hooks/useActiveTaskSnapshotMeta.js";
import { useTaskNativeSessionLogFile } from "@/hooks/useTaskNativeSessionLogFile.js";
import { useTaskSessionFilePath } from "@/hooks/useTaskSessionFilePath.js";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";
import { mergeTaskMetaCandidates } from "@/lib/zcodeTaskMetaMerge.js";
import { resolveWorkspaceHeaderProvider } from "@/lib/workspaceHeaderProvider.js";
import {
  getTaskMeta,
  selectWorkspaceZCodeState,
  useZCodeSessionStore,
} from "@/store/zcodeSessionStore.js";
import { useTaskQueryCacheStore } from "@/store/taskQueryCacheStore.js";

interface UseWorkspaceActiveTaskStateParams {
  workspaceAbsPath: string;
  activeTaskId: string | null;
  workspaceRemoteSessionId?: string | null;
  workspaceIdentity?: string;
  selectedProvider: ZCodeProvider;
  intl: {
    formatMessage(descriptor: { id: string }): string;
  };
}

function areTaskMetaJsonFieldsEqual(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function areResolvedTaskMetasEqual(left: ZCodeTaskMeta | null, right: ZCodeTaskMeta | null) {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.taskId === right.taskId &&
    left.traceId === right.traceId &&
    left.title === right.title &&
    left.titleOverridden === right.titleOverridden &&
    left.workspacePath === right.workspacePath &&
    left.workspaceIdentity === right.workspaceIdentity &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.mode === right.mode &&
    left.model === right.model &&
    left.thoughtLevel === right.thoughtLevel &&
    left.runtimeEpoch === right.runtimeEpoch &&
    left.provider === right.provider &&
    left.migrationSource === right.migrationSource &&
    left.forkedFromTaskId === right.forkedFromTaskId &&
    left.unreadAt === right.unreadAt &&
    left.status === right.status &&
    areTaskMetaJsonFieldsEqual(left.lastError, right.lastError) &&
    areTaskMetaJsonFieldsEqual(left.changeSummary, right.changeSummary) &&
    areTaskMetaJsonFieldsEqual(left.target, right.target)
  );
}

function useStableResolvedActiveTaskMeta(taskMeta: ZCodeTaskMeta | null) {
  const stableTaskMetaRef = useRef<ZCodeTaskMeta | null>(null);
  const stableTaskMeta = stableTaskMetaRef.current;
  // stream chunk 只更新消息流时，active task meta 经列表/乐观层重新合成后可能字段相同但引用变了。
  // Header/Shell 依赖 memo props；这里复用等价 meta 的旧引用，避免连续流式更新拖动标题栏重渲。
  if (!areResolvedTaskMetasEqual(stableTaskMeta, taskMeta)) {
    stableTaskMetaRef.current = taskMeta;
  }
  return stableTaskMetaRef.current;
}

export function useWorkspaceActiveTaskState({
  workspaceAbsPath,
  activeTaskId,
  workspaceRemoteSessionId,
  workspaceIdentity,
  selectedProvider,
  intl,
}: UseWorkspaceActiveTaskStateParams) {
  const workspaceState = useZCodeSessionStore((state) =>
    selectWorkspaceZCodeState(state, workspaceAbsPath, workspaceIdentity),
  );
  const activeTaskQueryMeta = useTaskQueryCacheStore((state) => {
    if (!activeTaskId) {
      return null;
    }
    return (
      state.taskMetaByEntityKey[
        buildTaskEntityKey({
          taskId: activeTaskId,
          workspacePath: workspaceAbsPath,
          workspaceIdentity,
        })
      ] ?? null
    );
  });
  const activeTaskMeta = useMemo(() => {
    if (!activeTaskId) {
      return null;
    }

    // App 以前依赖 zcodeTaskMetaMerge 同时拉普通列表和 pinned 列表，只是为了给当前激活 task
    // 找一份 meta。这样任何列表刷新都会把整棵 App 一起带着重渲。
    // 这里改成直接从 workspace store 读 taskListCache + optimistic meta 的合并结果；
    // 普通任务可以同步命中，pinned / archived 再由 snapshot meta 兜底，不再要求 App 常驻订阅旧列表 hook。
    // 重启恢复后 raw snapshot meta 可能先进入 workspace store，而 sqlite/list
    // query cache 里保留着 titleOverridden 的手动标题。Header 必须按同一套 title authority
    // 合并两边，否则当前 task 会看起来被还原成生成标题或首条 query。
    return (
      mergeTaskMetaCandidates(getTaskMeta(workspaceState, activeTaskId), activeTaskQueryMeta) ??
      null
    );
  }, [activeTaskId, activeTaskQueryMeta, workspaceState]);

  const activeTaskSnapshotMeta = useActiveTaskSnapshotMeta(
    workspaceAbsPath,
    activeTaskId,
    workspaceRemoteSessionId,
    workspaceIdentity,
    activeTaskMeta,
  );
  const resolvedActiveTaskMeta = useStableResolvedActiveTaskMeta(
    activeTaskMeta ?? activeTaskSnapshotMeta,
  );
  // store 收尾：taskMessagesByTaskId 已无写入方（旧 ChatView/广播消息回放均退役），
  // 由消息流派生的实时改动摘要恒为空；摘要展示回落到 task meta.changeSummary（持久化侧）。
  const activeTaskChangeSummary = null;
  const activeTraceId = resolvedActiveTaskMeta?.traceId ?? null;
  const activeSessionId = resolvedActiveTaskMeta?.taskId ?? null;
  const activeTaskProvider = resolvedActiveTaskMeta?.provider ?? null;
  const workspaceHeaderProvider = resolveWorkspaceHeaderProvider(
    activeTaskProvider,
    selectedProvider,
  );
  const activeTaskBaseTitle = resolvedActiveTaskMeta?.title?.trim()
    ? resolvedActiveTaskMeta.title
    : intl.formatMessage({
        id: resolvedActiveTaskMeta?.forkedFromTaskId
          ? "taskList.forkedUntitled"
          : "taskList.newThread",
      });
  const activeTaskTitle = activeTaskBaseTitle;
  const taskNativeSessionLogFile = useTaskNativeSessionLogFile(
    workspaceAbsPath,
    activeTaskId,
    activeTaskProvider,
    workspaceIdentity,
  );
  const taskSessionFile = useTaskSessionFilePath(workspaceAbsPath, activeTaskId, workspaceIdentity);

  return {
    activeTaskMeta,
    resolvedActiveTaskMeta,
    activeTraceId,
    activeSessionId,
    activeTaskProvider,
    workspaceHeaderProvider,
    activeTaskChangeSummary,
    activeTaskTitle,
    taskNativeSessionLogFile,
    taskSessionFile,
  };
}
