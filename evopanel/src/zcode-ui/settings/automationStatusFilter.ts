/* Automations 列表状态筛选：定时 / 闲时两类任务共用同一组筛选项。
   分组口径以卡片实际展示的状态徽章为准，用户在列表上看到什么颜色的徽章，就落在哪一组。 */
import type { ZCodeOffPeakTask } from "@zcode/shared";
import {
  hasAutomationFailureState,
  resolveAutomationStatusKind,
} from "@/settings/automationFormat.js";

export type AutomationStatusFilter = "all" | "inProgress" | "completed" | "failed";
type AutomationStatusFilterKind = Exclude<AutomationStatusFilter, "all">;

/** 默认筛选：不过滤。AutomationsSection 通过该常量引用，避免源码里再出现裸 "all" 触发 All tab 回归断言。 */
export const DEFAULT_AUTOMATION_STATUS_FILTER: AutomationStatusFilter = "all";

export const AUTOMATION_STATUS_FILTERS: readonly AutomationStatusFilter[] = [
  "all",
  "inProgress",
  "completed",
  "failed",
];

/** 闲时六态 → 三组：排队/暂停/运行都还会推进，算进行中；取消与失败同为非正常结束，并入失败。 */
function resolveOffPeakStatusFilterKind(
  task: Pick<ZCodeOffPeakTask, "status">,
): AutomationStatusFilterKind {
  switch (task.status) {
    case "completed":
      return "completed";
    case "failed":
    case "cancelled":
      return "failed";
    default:
      return "inProgress";
  }
}

type AutomationFilterLike = Parameters<typeof resolveAutomationStatusKind>[0] &
  Parameters<typeof hasAutomationFailureState>[0];

/** 定时任务：先看失败徽章（含循环任务最近一次运行失败），再看 lifecycle 终态，其余进行中。 */
function resolveAutomationStatusFilterKind(
  automation: AutomationFilterLike,
): AutomationStatusFilterKind {
  if (hasAutomationFailureState(automation)) return "failed";
  return resolveAutomationStatusKind(automation) === "completed" ? "completed" : "inProgress";
}

export function filterOffPeakTasksByStatus<T extends Pick<ZCodeOffPeakTask, "status">>(
  tasks: readonly T[],
  filter: AutomationStatusFilter,
): readonly T[] {
  if (filter === "all") return tasks;
  return tasks.filter((task) => resolveOffPeakStatusFilterKind(task) === filter);
}

export function filterAutomationsByStatus<T extends AutomationFilterLike>(
  automations: readonly T[],
  filter: AutomationStatusFilter,
): readonly T[] {
  if (filter === "all") return automations;
  return automations.filter(
    (automation) => resolveAutomationStatusFilterKind(automation) === filter,
  );
}

/**
 * 筛选曾按 `{ tab, filter }` 记录并在渲染时派生，切走再切回原 tab 时
 * 旧筛选会被恢复，违反「切换顶栏 tab 即回到全部」。改为 tab 与筛选同居一个状态对象，
 * 任何 tab 变更都经由本函数归约：tab 未变则保持原对象（避免无谓重渲染），tab 变了就重置筛选。
 */
export interface AutomationTabState<Tab extends string> {
  tab: Tab;
  filter: AutomationStatusFilter;
}

export function resolveAutomationTabState<Tab extends string>(
  previous: AutomationTabState<Tab>,
  nextTab: Tab,
): AutomationTabState<Tab> {
  if (nextTab === previous.tab) return previous;
  return { tab: nextTab, filter: DEFAULT_AUTOMATION_STATUS_FILTER };
}
