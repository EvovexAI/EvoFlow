import type { ServiceAuthorityMode } from "@zcode/shared";

export type ZCodeAgentPresentationSurface = "desktop";

interface ZCodeAgentPresentationHostFacts {
  runtimeSurface?: "desktop_local_host" | "remote_workspace_host";
  serviceAuthorityMode?: ServiceAuthorityMode;
  /** Main 已完成服务端单功能灰度裁决；未提供时保持历史 Host 装配语义。 */
  desktopContextPromptEnabled?: boolean;
}

export function resolveZCodeAgentPresentationSurface(
  facts: ZCodeAgentPresentationHostFacts,
): ZCodeAgentPresentationSurface | undefined {
  // Desktop 呈现能力必须从 Host 已有的可信装配事实推导，不能让每个调用方重复传递独立开关。
  // 普通 HTTP/manual app-server 没有这两个事实，继续保持 terminal，避免把 Desktop prompt 扩散出去。
  const isDesktopHost =
    facts.runtimeSurface === "desktop_local_host" ||
    facts.serviceAuthorityMode === "desktop-attached-remote";
  if (!isDesktopHost || facts.desktopContextPromptEnabled === false) {
    return undefined;
  }
  return "desktop";
}
