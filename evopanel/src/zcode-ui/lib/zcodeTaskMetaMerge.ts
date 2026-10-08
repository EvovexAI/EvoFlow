import type { ZCodeTaskMeta } from "@zcode/shared";

function hasOwnTaskMetaField<T extends keyof ZCodeTaskMeta>(task: ZCodeTaskMeta, key: T) {
  return Object.prototype.hasOwnProperty.call(task, key);
}

function isPlaceholderTaskTitle(title: string): boolean {
  const normalizedTitle = title.trim().toLocaleLowerCase();
  return normalizedTitle.length === 0 || normalizedTitle === "new session";
}

function resolveMergedTaskTitle(preferredTask: ZCodeTaskMeta, fallbackTask: ZCodeTaskMeta): string {
  if (fallbackTask.titleOverridden && !preferredTask.titleOverridden) {
    return fallbackTask.title;
  }
  // session/send 是立即 ACK，首发 ACK 后的 readSession 可能早于后台 first_input title 投影。
  // 此时 snapshot 会带回 agent 默认占位 "New session"；如果它的 updatedAt 更新，旧合并逻辑会把
  // 用户 query 乐观标题短暂盖掉。这里仅把空标题/默认占位视为不可覆盖真实标题，generated title 仍照常覆盖。
  if (isPlaceholderTaskTitle(preferredTask.title) && !isPlaceholderTaskTitle(fallbackTask.title)) {
    return fallbackTask.title;
  }
  return preferredTask.title;
}

export function mergeTaskWithOptimisticMeta(
  task: ZCodeTaskMeta,
  optimisticTask: ZCodeTaskMeta,
): ZCodeTaskMeta {
  const shouldKeepOptimisticTask =
    optimisticTask.updatedAt > task.updatedAt ||
    (optimisticTask.updatedAt === task.updatedAt &&
      optimisticTask.title.length > task.title.length);
  const preferredTask = shouldKeepOptimisticTask ? optimisticTask : task;
  const fallbackTask = shouldKeepOptimisticTask ? task : optimisticTask;

  const unreadAt = hasOwnTaskMetaField(optimisticTask, "unreadAt")
    ? optimisticTask.unreadAt
    : (preferredTask.unreadAt ?? fallbackTask.unreadAt);

  return {
    ...preferredTask,
    changeSummary: preferredTask.changeSummary ?? fallbackTask.changeSummary,
    model: preferredTask.model ?? fallbackTask.model,
    provider: preferredTask.provider ?? fallbackTask.provider,
    title: resolveMergedTaskTitle(preferredTask, fallbackTask),
    titleOverridden:
      preferredTask.titleOverridden === true || fallbackTask.titleOverridden === true
        ? true
        : (preferredTask.titleOverridden ?? fallbackTask.titleOverridden),
    // 远控首页“运行中”依赖 task.meta.status 作为未订阅 runtime 时的兜底。
    // 之前乐观元数据 updatedAt 更新后，如果自身没带 status，会把持久化 status 覆盖成 undefined，
    // 最终列表误显示 idle。这里补 status 回退，避免 running/completed/error 被乐观层吞掉。
    status: preferredTask.status ?? fallbackTask.status,
    unreadAt,
  };
}

export function mergeTaskMetaCandidates(
  ...candidates: Array<ZCodeTaskMeta | null | undefined>
): ZCodeTaskMeta | undefined {
  let merged: ZCodeTaskMeta | undefined;
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    merged = merged ? mergeTaskWithOptimisticMeta(candidate, merged) : candidate;
  }
  return merged;
}
