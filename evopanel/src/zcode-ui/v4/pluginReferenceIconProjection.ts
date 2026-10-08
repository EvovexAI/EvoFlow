import { resolvePluginIconSource } from "@/lib/pluginIconSource.js";
import type { ZCodePluginReferenceCatalogEntry } from "@zcode/shared";
import type { ConversationStoreStatus } from "@/v4/conversationProjectionStore.js";

export function isSessionPluginCatalogReady(
  projectionStatus: ConversationStoreStatus,
  sessionId: string | null,
  snapshotSessionId: string | null | undefined,
): boolean {
  return Boolean(projectionStatus === "live" && sessionId && snapshotSessionId === sessionId);
}

export function hasPluginReferenceUserRows(
  rows: readonly { kind: string; text?: string }[],
): boolean {
  return rows.some((row) => row.kind === "userInput" && row.text?.includes("(plugin://"));
}

/**
 * 已发送 Plugin chip 的 display-only 投影。
 *
 * 历史消息只能从 canonical stable ID 重建展示；若误用 workspace
 * authority，会让已有 Session 在 Plugin 启停后显示不属于自身身份边界的数据。
 * 因此只有明确的 Session authority 才可建立 icon map，其余情况统一 fail closed。
 */
export function buildSessionPluginIconMap(
  authority: "session" | "workspace" | null,
  entries: readonly ZCodePluginReferenceCatalogEntry[],
): ReadonlyMap<string, string> {
  if (authority !== "session") {
    return new Map();
  }

  const iconById = new Map<string, string>();
  for (const entry of entries) {
    const icon = resolvePluginIconSource(entry.pluginId, entry.icon);
    if (icon) {
      iconById.set(entry.pluginId, icon);
    }
  }
  return iconById;
}
