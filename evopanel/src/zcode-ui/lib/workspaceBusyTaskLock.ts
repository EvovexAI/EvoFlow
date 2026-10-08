import type { ZCodeProvider, ZCodeTaskRuntimeStatus } from "@zcode/shared";

function isBusyTaskRuntimeStatus(status: ZCodeTaskRuntimeStatus): boolean {
  return status === "creating" || status === "restoring" || status === "streaming";
}

function buildTaskProviderByTaskId(
  optimisticTaskMetaByTaskId: Record<string, { provider?: ZCodeProvider }>,
  taskListCache?: Array<{ taskId: string; provider?: ZCodeProvider }> | null,
): Record<string, ZCodeProvider | undefined> {
  const providerByTaskId: Record<string, ZCodeProvider | undefined> = {};

  for (const task of taskListCache ?? []) {
    if (!task.provider) {
      continue;
    }
    providerByTaskId[task.taskId] = task.provider;
  }

  for (const [taskId, meta] of Object.entries(optimisticTaskMetaByTaskId)) {
    if (!meta.provider) {
      continue;
    }
    providerByTaskId[taskId] = meta.provider;
  }

  return providerByTaskId;
}

export function hasBusyTaskInWorkspaceProvider(
  selectedProvider: ZCodeProvider,
  taskRuntimeByTaskId: Record<string, { status: ZCodeTaskRuntimeStatus; provider?: ZCodeProvider }>,
  optimisticTaskMetaByTaskId: Record<string, { provider?: ZCodeProvider }>,
  taskListCache?: Array<{ taskId: string; provider?: ZCodeProvider }> | null,
  activeTaskId?: string | null,
): boolean {
  const providerByTaskId = buildTaskProviderByTaskId(optimisticTaskMetaByTaskId, taskListCache);
  const normalizedActiveTaskId = activeTaskId?.trim() ?? "";

  for (const [taskId, runtimeState] of Object.entries(taskRuntimeByTaskId)) {
    if (!isBusyTaskRuntimeStatus(runtimeState.status)) {
      continue;
    }

    // runtime map 也包含非 optimistic task，provider 缺失不能直接归入固定 provider，
    // 否则可能把无关任务误判为忙碌，长期禁用 reload/sync 菜单。
    // busy lock 保护 workspace 内的 provider 进程，优先采用更接近当前运行态的 runtime
    // provider，再回退到 taskList/cache；仍无法判断时，仅对当前 activeTask 兜底锁定。
    const taskProvider = runtimeState.provider ?? providerByTaskId[taskId];
    if (!taskProvider) {
      // 首条消息发送 / runtime 切换阶段，任务 provider 可能尚未同步进 taskList。
      // 直接判定“不忙”会让 loading 期间可跨 supplier 切换模型。
      // 对当前 activeTask 的 busy 态做兜底锁定，防止加载中误切供应商。
      if (normalizedActiveTaskId.length > 0 && normalizedActiveTaskId === taskId) {
        return true;
      }
      continue;
    }

    if (taskProvider === selectedProvider) {
      return true;
    }
  }

  return false;
}
