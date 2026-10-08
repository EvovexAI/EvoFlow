import { randomUUID } from "node:crypto";
import {
  browserCommandResultSchema,
  type BrowserBackendDescriptor,
  type BrowserClientMode,
  type BrowserCommand,
  type ZCodeBrowserAmbientContext,
} from "@zcode/shared";

export interface BrowserAmbientContextExecutor {
  list(input: {
    requestId: string;
    sessionId: string;
    turnId?: string;
    workspaceKey: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    clientMode: BrowserClientMode;
    sessionContext: "live" | "cached";
  }): Promise<BrowserBackendDescriptor[]>;
  execute(input: {
    requestId: string;
    browserId?: string;
    browserGeneration?: number;
    sessionId: string;
    turnId?: string;
    workspaceKey: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    clientMode: BrowserClientMode;
    sessionContext: "live" | "cached";
    command: BrowserCommand;
  }): Promise<{ ok: boolean; [key: string]: unknown }>;
}

interface BrowserAmbientContextTarget {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  clientMode?: BrowserClientMode;
}

function sanitizeAmbientUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const url = new URL(rawUrl);
    if (!["about:", "http:", "https:"].includes(url.protocol)) return undefined;
    url.username = "";
    url.password = "";
    const value = url.toString();
    return value.length <= 4096 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 只读收集 provider ambient state。失败时返回 undefined，不能让浏览器 UI 状态阻断真实 prompt。
 */
export async function collectBrowserAmbientContext(
  executor: BrowserAmbientContextExecutor | undefined,
  target: BrowserAmbientContextTarget,
): Promise<ZCodeBrowserAmbientContext | undefined> {
  if (!executor) return undefined;
  const workspaceKey = target.workspaceIdentity?.trim() || target.workspacePath;
  const clientMode = target.clientMode ?? "desktop-continuous";
  const common = {
    sessionId: target.sessionId,
    workspaceKey,
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
    ...(target.remoteSessionId ? { remoteSessionId: target.remoteSessionId } : {}),
    clientMode,
    sessionContext: "live" as const,
  };

  try {
    const descriptors = await executor.list({
      requestId: randomUUID(),
      ...common,
    });
    const browser = descriptors.find((candidate) => candidate.type === "iab");
    if (!browser) return undefined;

    const [controlledOutcome, userOutcome] = await Promise.allSettled([
      executor.execute({
        requestId: randomUUID(),
        browserId: browser.id,
        browserGeneration: browser.generation,
        ...common,
        command: { method: "list" },
      }),
      executor.execute({
        requestId: randomUUID(),
        browserId: browser.id,
        browserGeneration: browser.generation,
        ...common,
        command: { method: "listUserTabs" },
      }),
    ]);
    const controlled =
      controlledOutcome.status === "fulfilled"
        ? browserCommandResultSchema.safeParse(controlledOutcome.value)
        : undefined;
    const users =
      userOutcome.status === "fulfilled"
        ? browserCommandResultSchema.safeParse(userOutcome.value)
        : undefined;
    const controlledTabs =
      controlled?.success && controlled.data.ok ? (controlled.data.tabs ?? []) : [];
    const userTabs = users?.success && users.data.ok ? (users.data.userTabs ?? []) : [];
    const tabIds = new Set([
      ...controlledTabs.map((tab) => tab.tabId),
      ...userTabs.map((tab) => tab.id),
    ]);
    if (tabIds.size === 0) return undefined;

    // 显式 finalize 后页面属于 user tabs；漏 finalize 的 handoff 仍属于 controlled tabs。
    // 两类都必须进入 ambient state，否则下一轮会把空 tabs.list() 误判为浏览器断线。
    const currentControlled = controlledTabs.find((tab) => tab.active);
    const currentUrl = sanitizeAmbientUrl(
      currentControlled?.url ?? userTabs[0]?.url ?? controlledTabs.at(-1)?.url,
    );
    return {
      tabCount: tabIds.size,
      ...(currentUrl ? { currentUrl } : {}),
    };
  } catch {
    return undefined;
  }
}
