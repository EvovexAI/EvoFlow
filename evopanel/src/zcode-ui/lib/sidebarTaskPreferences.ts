import type { BrowserStorageLike } from "@/lib/browserEnvironment.js";
import { getSafeLocalStorage } from "@/lib/browserEnvironment.js";

export type SidebarTaskOrganizeBy = "grouped" | "project" | "chronological";
export type SidebarTaskSortBy = "created" | "updated";

interface SidebarTaskPreferences {
  organizeBy: SidebarTaskOrganizeBy;
  sortBy: SidebarTaskSortBy;
}

const SIDEBAR_TASK_PREFERENCES_STORAGE_KEY = "zcode-sidebar-task-preferences";

const DEFAULT_SIDEBAR_TASK_PREFERENCES: SidebarTaskPreferences = {
  organizeBy: "project",
  sortBy: "updated",
};

function isSidebarTaskOrganizeBy(value: unknown): value is SidebarTaskOrganizeBy {
  return value === "grouped" || value === "project" || value === "chronological";
}

function isSidebarTaskSortBy(value: unknown): value is SidebarTaskSortBy {
  return value === "created" || value === "updated";
}

export function readSidebarTaskPreferences(
  storage: BrowserStorageLike | null = getSafeLocalStorage(),
): SidebarTaskPreferences {
  let rawValue: string | null = null;
  try {
    rawValue = storage?.getItem(SIDEBAR_TASK_PREFERENCES_STORAGE_KEY) ?? null;
  } catch {
    rawValue = null;
  }
  if (!rawValue) {
    return DEFAULT_SIDEBAR_TASK_PREFERENCES;
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<SidebarTaskPreferences>;
    return {
      organizeBy: isSidebarTaskOrganizeBy(parsed.organizeBy)
        ? parsed.organizeBy
        : DEFAULT_SIDEBAR_TASK_PREFERENCES.organizeBy,
      sortBy: isSidebarTaskSortBy(parsed.sortBy)
        ? parsed.sortBy
        : DEFAULT_SIDEBAR_TASK_PREFERENCES.sortBy,
    };
  } catch {
    return DEFAULT_SIDEBAR_TASK_PREFERENCES;
  }
}

export function persistSidebarTaskPreferences(
  preferences: SidebarTaskPreferences,
  storage: BrowserStorageLike | null = getSafeLocalStorage(),
) {
  // timeline/排序设置之前只存在 WorkspaceSidebar 的 React state 里。
  // 刷新或重启后会回到默认 project/updated，用户以为 timeline 设置没有生效。
  // 这里统一写入本地偏好，桌面端和 Web 端都能恢复同一个侧栏展示方式。
  try {
    storage?.setItem(
      SIDEBAR_TASK_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        organizeBy: preferences.organizeBy,
        sortBy: preferences.sortBy,
      }),
    );
  } catch {
    // 受限浏览器或 SSR 测试里 storage 可能不可写，偏好写入失败不能阻断侧栏交互。
  }
}
