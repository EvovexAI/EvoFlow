const OPEN_PLUGIN_STORE_EVENT = "zcode:open-plugin-store";

export interface PluginStoreOpenTarget {
  pluginId?: string;
  intent?: "add-marketplace";
  returnScopeKey?: string;
}

let pendingTarget: PluginStoreOpenTarget | null = null;

/** 统一承载 Store 入口的目标插件与 Settings 返回位置。Marketplace 只允许返回 User 视图。 */
export function requestPluginStoreOpen(value?: string | PluginStoreOpenTarget): void {
  const normalized = typeof value === "string" ? value.trim() : undefined;
  pendingTarget =
    typeof value === "object"
      ? { ...value, ...(value.returnScopeKey ? { returnScopeKey: "user" } : {}) }
      : normalized
        ? normalized.includes("@")
          ? { pluginId: normalized }
          : { returnScopeKey: "user" }
        : {};
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<PluginStoreOpenTarget>(OPEN_PLUGIN_STORE_EVENT, {
      detail: pendingTarget,
    }),
  );
}

export function consumePluginStoreOpenTarget(): PluginStoreOpenTarget | null {
  const target = pendingTarget;
  pendingTarget = null;
  return target;
}

export function addPluginStoreOpenListener(
  listener: (target: PluginStoreOpenTarget) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handleOpen = (event: Event) => {
    listener((event as CustomEvent<PluginStoreOpenTarget>).detail ?? {});
  };
  window.addEventListener(OPEN_PLUGIN_STORE_EVENT, handleOpen);
  return () => window.removeEventListener(OPEN_PLUGIN_STORE_EVENT, handleOpen);
}
