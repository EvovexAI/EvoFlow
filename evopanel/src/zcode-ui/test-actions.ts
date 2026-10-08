import type { TaskChatMessage as ChatMessage } from "@/lib/taskChatMessageTypes.js";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import type { IZCodeAgentService } from "@zcode/services";
import type { TaskListE2EActions } from "@/lib/taskListE2EActions.js";
import { useEffect } from "react";

// [evoflow-vendor] 删除本地 `declare global { interface ImportMeta { env } }`：
// EvoFlow 程序已有 src/vite-env.d.ts（vite/client）声明 import.meta.env，重复声明且形状不同会冲突。

/**
 * E2E 测试可通过 window.__testActions 调用的操作集合。
 * 仅在非 production 环境下注册，避免泄露到生产。
 */
export interface TestActions extends TaskListE2EActions {
  /** 获取当前主题 */
  getTheme: () => string;
  /** 设置主题 */
  setTheme: (theme: "light" | "dark" | "zai-light" | "zai-dark" | "system") => void;
  /** 获取当前语言，仅供跨语言展示 E2E */
  getLocale: () => "zh-CN" | "en-US";
  /** 设置当前语言，仅供跨语言展示 E2E */
  setLocale: (locale: "zh-CN" | "en-US") => void;
  /** 注入聊天展示用的 mock 消息 */
  setChatMessages: (messages: ChatMessage[]) => void;
  /** 获取当前 mock 消息数量 */
  getChatMessageCount: () => number;
  /** E2E 通过真实 zcodeAgentService 拉取插件 overview */
  getPluginsOverview: IZCodeAgentService["getPluginsOverview"];
  /** E2E 通过真实 zcodeAgentService 添加 marketplace */
  addPluginMarketplace: IZCodeAgentService["addPluginMarketplace"];
  /** E2E 通过真实 zcodeAgentService 刷新 marketplace */
  updatePluginMarketplace: IZCodeAgentService["updatePluginMarketplace"];
  /** E2E 通过真实 zcodeAgentService 安装 marketplace plugin */
  installPlugin: IZCodeAgentService["installPlugin"];
  /** E2E 通过真实 zcodeAgentService 触发插件 discover */
  listPlugins: IZCodeAgentService["listPlugins"];
  /** E2E 通过真实 zcodeAgentService 查询 Workspace/Session Plugin catalog */
  getPluginReferenceCatalog: IZCodeAgentService["getPluginReferenceCatalog"];
}

declare global {
  interface Window {
    __testActions?: TestActions;
  }
}

/**
 * 将 test actions 注册到 window.__testActions。
 * 仅在 import.meta.env.PROD 为 true 时跳过注册（Vite 环境）。
 */
export function useTestActions(actions: TestActions) {
  useEffect(() => {
    // E2E 的 production renderer 也需要服务入口；只能由专用 bridge 开关打开，避免普通生产包泄露。
    if (import.meta.env.PROD && !shouldExposeE2EStoreBridge()) return;
    window.__testActions = actions;
    return () => {
      actions.releaseTaskMembershipRefreshHold();
      delete window.__testActions;
    };
  }, [actions]);
}
