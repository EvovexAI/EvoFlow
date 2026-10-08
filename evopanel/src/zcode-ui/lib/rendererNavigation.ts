interface RendererNavigationEntry {
  readonly type?: string;
}

function readRendererNavigationEntries(): RendererNavigationEntry[] {
  try {
    if (typeof globalThis.performance?.getEntriesByType !== "function") {
      return [];
    }
    return globalThis.performance.getEntriesByType("navigation") as RendererNavigationEntry[];
  } catch {
    return [];
  }
}

/**
 * 区分 app 冷启动与同一 renderer 的刷新。
 * workspace/app 入口只应展示草稿，但输出中的 renderer reload 仍要恢复当前 pane 续流。
 */
export function isRendererReloadNavigation(
  entries: readonly RendererNavigationEntry[] = readRendererNavigationEntries(),
): boolean {
  return entries[0]?.type === "reload";
}
