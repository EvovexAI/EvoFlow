import type { ZCodeUsage } from "@zcode/shared";
import type { TaskUsageState } from "@/store/zcodeSessionStoreTypes.js";

interface TaskUsageKeyParams {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}

interface TaskContextUsageUpdateParams extends TaskUsageKeyParams {
  used: number;
  size: number;
}

interface BuildTaskContextUsageUpdateParams {
  currentUsage: TaskUsageState | null | undefined;
  incomingUsage: TaskUsageState;
  latestUserPrompt?: string | null;
}

const taskContextUsageUpdateKeys = new Set<string>();

function buildTaskUsageKey(params: TaskUsageKeyParams): string {
  const workspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
  return `${params.workspacePath}::${workspaceKey}::${params.taskId}`;
}

export function recordTaskContextUsageUpdate(params: TaskContextUsageUpdateParams) {
  if (!Number.isFinite(params.used) || params.used <= 0) {
    return;
  }
  if (!Number.isFinite(params.size) || params.size <= 0) {
    return;
  }
  taskContextUsageUpdateKeys.add(buildTaskUsageKey(params));
}

function isContextCompressionPrompt(prompt: string | null | undefined): boolean {
  const normalized = prompt?.trim() ?? "";
  return (
    normalized === "/compact" ||
    normalized.startsWith("/compact ") ||
    normalized === "/compress" ||
    normalized.startsWith("/compress ")
  );
}

export function buildTaskContextUsageFromUsageUpdate(
  params: BuildTaskContextUsageUpdateParams,
): TaskUsageState {
  const { currentUsage, incomingUsage, latestUserPrompt } = params;
  const usageWithRetainedBreakdown =
    !incomingUsage.breakdown &&
    currentUsage?.breakdown &&
    currentUsage.used === incomingUsage.used &&
    currentUsage.size === incomingUsage.size
      ? { ...incomingUsage, breakdown: currentUsage.breakdown }
      : incomingUsage;
  if (
    currentUsage &&
    Number.isFinite(currentUsage.used) &&
    currentUsage.used > 0 &&
    Number.isFinite(currentUsage.size) &&
    currentUsage.size > 0 &&
    (!Number.isFinite(incomingUsage.used) || incomingUsage.used <= 0) &&
    !isContextCompressionPrompt(latestUserPrompt)
  ) {
    // Bugfix: Agent 在普通工具调用期间会短暂发出 used=0 的 usage_update，
    // 这不是 context 真的被清空，而是上游 replay/子调用 usage 缺失造成的瞬时假值。
    // 非压缩轮次保留上一个正数，避免输入栏上下文占用闪一下后消失。
    return currentUsage;
  }

  return usageWithRetainedBreakdown;
}

export function buildPromptCompletionUsageFallback(
  params: TaskUsageKeyParams & {
    currentUsage: TaskUsageState | null | undefined;
    currentContextWindow?: number | null;
    usage?: ZCodeUsage;
  },
): TaskUsageState | null {
  const { currentUsage, currentContextWindow, usage } = params;
  const contextWindow = currentContextWindow ?? currentUsage?.size ?? null;
  if (!contextWindow || contextWindow <= 0) {
    return null;
  }
  if (!usage || !Number.isFinite(usage.totalTokens) || usage.totalTokens <= 0) {
    return null;
  }
  if (taskContextUsageUpdateKeys.has(buildTaskUsageKey(params))) {
    return null;
  }

  // Bugfix: task_complete.usage 是本轮 prompt 的 token 统计，不是上下文窗口快照。
  // 只有从未收到过正数 usage_update 的 provider 才把它当弱 fallback，避免覆盖 zcode-cli/GLM 的真实 context used。
  return {
    ...currentUsage,
    size: contextWindow,
    used: Math.min(contextWindow, Math.max(currentUsage?.used ?? 0, usage.totalTokens)),
  };
}
