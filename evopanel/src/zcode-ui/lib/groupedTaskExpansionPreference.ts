import type { BrowserStorageLike } from "@/lib/browserEnvironment.js";
import { getSafeLocalStorage } from "@/lib/browserEnvironment.js";

const GROUPED_TASK_COLLAPSED_GROUPS_STORAGE_KEY = "zcode-grouped-task-collapsed-groups";

type GroupedTaskCollapsedGroupState = Record<string, true>;

function normalizeCollapsedGroupState(value: unknown): GroupedTaskCollapsedGroupState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, true] =>
        typeof entry[0] === "string" && entry[0].length > 0 && entry[1] === true,
    ),
  );
}

function collapsedGroupIdsToState(
  collapsedGroupIds: ReadonlySet<string>,
): GroupedTaskCollapsedGroupState {
  return Object.fromEntries([...collapsedGroupIds].map((groupId) => [groupId, true]));
}

export function readGroupedTaskCollapsedGroupIds(
  storage: BrowserStorageLike | null = getSafeLocalStorage(),
): Set<string> {
  let rawValue: string | null = null;
  try {
    rawValue = storage?.getItem(GROUPED_TASK_COLLAPSED_GROUPS_STORAGE_KEY) ?? null;
  } catch {
    rawValue = null;
  }
  if (!rawValue) {
    return new Set();
  }

  try {
    return new Set(Object.keys(normalizeCollapsedGroupState(JSON.parse(rawValue))));
  } catch {
    return new Set();
  }
}

export function persistGroupedTaskCollapsedGroupIds(
  collapsedGroupIds: ReadonlySet<string>,
  storage: BrowserStorageLike | null = getSafeLocalStorage(),
) {
  try {
    storage?.setItem(
      GROUPED_TASK_COLLAPSED_GROUPS_STORAGE_KEY,
      JSON.stringify(collapsedGroupIdsToState(collapsedGroupIds)),
    );
  } catch {
    // 受限浏览器或 SSR 测试里 storage 可能不可写，折叠状态写入失败不能阻断侧栏交互。
  }
}
