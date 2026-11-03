/**
 * EvoFlow 资源管理器独立窗口入口。
 * UI = vendored ZCode ResourceManagerApp；数据 = Tauri get_resource_usage_snapshot。
 */
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ResourceUsageSnapshot } from "@zcode/shared";
import { ResourceManagerApp } from "@zcode/ui/resource-manager/ResourceManagerApp.js";
import { ZCodeIntlProvider } from "@zcode/ui/i18n/IntlProvider.js";
import "@/styles.css";

type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function getInvoke(): TauriInvoke | null {
  const w = window as Window & {
    __TAURI__?: { core?: { invoke?: TauriInvoke } };
    __TAURI_INTERNALS__?: { invoke?: TauriInvoke };
  };
  return w.__TAURI__?.core?.invoke || w.__TAURI_INTERNALS__?.invoke || null;
}

async function getSnapshot(): Promise<ResourceUsageSnapshot> {
  const invoke = getInvoke();
  if (!invoke) {
    throw new Error("Resource manager bridge is unavailable");
  }
  return (await invoke("get_resource_usage_snapshot")) as ResourceUsageSnapshot;
}

function setSamplingActive(active: boolean): void {
  const invoke = getInvoke();
  if (!invoke) return;
  void invoke("set_resource_usage_sampling_active", { active });
}

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("resource-manager #root missing");
}

// 跟随系统/壳层深浅色：主窗口若写了 data-theme，新窗默认浅色；可按 prefers-color-scheme 对齐。
if (
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-color-scheme: dark)").matches
) {
  document.documentElement.classList.add("dark");
  document.documentElement.dataset.theme = "dark";
  document.body.style.background = "#12141a";
}

createRoot(rootEl).render(
  createElement(
    ZCodeIntlProvider,
    { initialLocale: "zh-CN" },
    createElement(ResourceManagerApp, {
      getSnapshot,
      setSamplingActive,
    }),
  ),
);
