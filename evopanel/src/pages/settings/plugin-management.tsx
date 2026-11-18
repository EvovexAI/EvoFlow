/**
 * EvoFlow 设置中心 — 插件市场 Tab（ZCode PluginsSection 原版挂载）
 *
 * 原样引用 ZCode 的 <PluginsSection>（插件列表 + 插件商店；MCP/技能
 * tab 暂藏，待迁移完成再开放）与 <PluginStorePage>（插件市场整页），通过
 * createRoot 桥接到 EvoFlow vanilla JS hub.js。
 *
 * 数据链路：
 *   pluginManagementService = EvoflowPluginManagementClient → Gateway
 *   /api/plugins/*（Python 端口自 ZCode CLI 插件适配器，存储布局与
 *   ZCode 逐字节兼容：known_marketplaces.json / installed_plugins.json /
 *   marketplaces/<id>/marketplace.json / cache/<marketplace>/<name>/<version>）
 *
 * 挂载约定（与 hub.js ensurePanelMounted 对齐）：
 *   export function mountPluginManagementInto(container)
 *   export function cleanup()
 */

import { Component, createElement, useEffect, useState, type ErrorInfo, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import { PluginsSection } from "@/settings/PluginsSection.js";
import { PluginStorePage } from "@/settings/PluginStorePage.js";
import "@/styles-bridge.css";
import type { IServiceAccessor } from "@zcode/services";
import { EvoflowPluginManagementClient } from "../../zcode-services/plugins/pluginManagement.client.js";
import {
  createEvoflowSettingsSyncService,
  evoflowStubPlatform,
} from "./evoflow-bridge-services.js";

// 桥接页没有真实 workspace，给插件服务解析一个稳定的合成标识。
const BRIDGE_WORKSPACE_PATH = "evoflow://plugins";

// ---------------------------------------------------------------------------
// 单例 client —— 共享 HTTP 状态
// ---------------------------------------------------------------------------

const pluginClient = new EvoflowPluginManagementClient();

function createEvoflowServiceAccessor(): IServiceAccessor {
  return {
    pluginManagementService: pluginClient,
    settingsSyncService: createEvoflowSettingsSyncService(),
    // PluginStorePage / PluginsSection 会从 accessor 取这些服务；
    // 当前组件树未实际调用其方法，提供空实现防止 undefined 解引用。
    clientConfigService: {
      getSnapshot: async () => ({ pluginStoreOrder: null }),
    },
    // 商店安装后会刷新技能目录；MCP/技能管理页暂未迁入本壳，给空实现即可。
    skillsService: {
      list: async () => ({ skills: [], capability: null, diagnostics: [] }),
      setEnabled: async () => ({}),
      deleteSkill: async () => ({}),
    },
    zcodeSessionService: {},
  } as unknown as IServiceAccessor;
}

// 【self-evolution-bot · 2026-11-17 · 第35轮】accessor 必须是模块级单例。
// 原实现写在组件体内，每次渲染都新建一个对象，而它又出现在 useEffect 的依赖数组里
// —— 每次渲染都判定「依赖变了」再跑一次 initialize。当前 initialize 有 in-flight
// 复用在兜着，所以还没打爆接口；但这是靠下游兜底掩盖的写法，一旦复用逻辑改动就会
// 变成每渲染一次打一轮接口。放模块级即根治。
const evoflowServices = createEvoflowServiceAccessor();

// ---------------------------------------------------------------------------
// Internal React app
// ---------------------------------------------------------------------------

function EvoflowPluginApp(): ReactElement {
  // 进入「插件市场」默认落商店浏览页；「管理已安装」再切回 PluginsSection。
  const [storeOpen, setStoreOpen] = useState(true);

  useEffect(() => {
    void usePluginManagementStore.getState().initialize({
      workspacePath: BRIDGE_WORKSPACE_PATH,
      workspaceIdentity: undefined,
      configScope: "user",
      pluginService: pluginClient as never,
    });
  }, []);

  const content = storeOpen
    ? createElement(PluginStorePage, {
        workspacePath: BRIDGE_WORKSPACE_PATH,
        onManageInstalled: () => setStoreOpen(false),
      })
    : createElement(PluginsSection, {
        isDesktop: false,
        initialTab: "plugins",
        initialScopeKey: "user",
        mode: "plugin",
        workspacePath: BRIDGE_WORKSPACE_PATH,
        onOpenPluginStore: () => setStoreOpen(true),
        showMarketplaceBreadcrumb: false,
      });

  const withServices = createElement(
    ServiceProvider,
    { services: evoflowServices, children: content },
  );

  return createElement(PlatformProvider, {
    platform: evoflowStubPlatform,
    children: createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(TooltipProvider, null, withServices),
    }),
  });
}

// ---------------------------------------------------------------------------
// ErrorBoundary —— 渲染期异常不许变成「静默空白」
// ---------------------------------------------------------------------------
// 【self-evolution-bot · 2026-11-17 · 第35轮】用户报「插件打开是空白，看不到内容」。
// 根因不是接口挂、不是 CSS 塌高、不是空数据：是**渲染期异常无处落地**。
//   hub.js 用 `try { await mountPluginManagementInto(pane) } catch (e) { 显示加载失败 }`，
//   但 React 的渲染发生在 createRoot 之后，抛错**不会回到那个 await 的 catch**。
//   没有 ErrorBoundary 时 React 会卸载整棵树 → pane 只剩一个空 div：
//   用户看到纯空白，前端日志里连一条插件记录都没有（实测 textContent.length === 0）。
// 所以这一层必须自己兜住，把错误变成看得见的文案。

interface PluginBridgeBoundaryState {
  error: Error | null;
}

class PluginBridgeErrorBoundary extends Component<
  { children: ReactElement },
  PluginBridgeBoundaryState
> {
  state: PluginBridgeBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): PluginBridgeBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 落到统一日志，便于下次这类报案能直接定位，而不是再查一整轮。
    console.error("[plugins] 插件面板渲染失败", error, info?.componentStack);
  }

  render(): ReactElement {
    if (this.state.error) {
      // 注意：fallback 自身必须是「绝不会抛错」的最简结构。
      // 初版这里用了 `style: "margin:12px..."` 字符串 —— React 的 style 只接受对象，
      // 传字符串会在渲染期抛 "style prop expects a mapping"，boundary 自己崩掉，
      // 结果仍然是纯空白（我实测过 textContent.length === 0）。
      // 所以样式一律走 CSS class（见 pages.css 的 .plugin-bridge-error）。
      return createElement(
        "div",
        { className: "plugin-bridge-error", "data-testid": "plugin-bridge-error" },
        createElement("p", { className: "plugin-bridge-error-title" }, "插件面板加载失败"),
        createElement(
          "p",
          { className: "plugin-bridge-error-detail" },
          String(this.state.error?.message || this.state.error),
        ),
        createElement(
          "button",
          {
            type: "button",
            className: "plugin-bridge-error-retry",
            onClick: () => this.setState({ error: null }),
          },
          "重试",
        ),
      );
    }
    return this.props.children;
  }
}

// ---------------------------------------------------------------------------
// Mount / cleanup
// ---------------------------------------------------------------------------

const _roots = new Map<HTMLElement, Root>();

export function mountPluginManagementInto(container: HTMLElement): void {
  cleanup();
  container.innerHTML = "";

  const host = document.createElement("div");
  host.className = "zcode-bridge-root";
  host.style.cssText = "width:100%;min-height:400px;color-scheme:light;";
  container.appendChild(host);

  const root = createRoot(host);
  _roots.set(container, root);

  root.render(
    createElement(
      TabStoreProvider,
      null,
      createElement(
        PluginBridgeErrorBoundary,
        null,
        createElement(EvoflowPluginApp),
      ),
    ),
  );
}

export function cleanup(): void {
  for (const [container, root] of _roots) {
    try {
      root.unmount();
    } catch {
      /* ignore */
    }
    if (container.isConnected) container.innerHTML = "";
  }
  _roots.clear();
}
