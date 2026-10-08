// 自动化页顶级标签的记忆：记在 sessionStorage，
// 照 settingsNavigation.ts 的 last-section 先例——从详情页 / 对话切回来时仍在「工作流」。
// 中枢升级成跨项目视图后，页不再依赖活动项目：用单一 app 级 key，不再按 workspaceKey 分桶；
// 不进 Zustand、不跨窗口广播。
import type { AutomationsPageTab } from "@/settings/saved-workflows/AutomationsPageTitleSwitch.js";

const STORAGE_KEY = "zcode-automations-page-tab";

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function readAutomationsPageTab(): AutomationsPageTab {
  try {
    const value = storage()?.getItem(STORAGE_KEY);
    return value === "workflow" ? "workflow" : "automation";
  } catch {
    return "automation";
  }
}

export function writeAutomationsPageTab(tab: AutomationsPageTab): void {
  try {
    storage()?.setItem(STORAGE_KEY, tab);
  } catch {
    // sessionStorage 不可用（隐私模式 / 配额）就不记；下次打开回到默认标签，不影响功能。
  }
}
