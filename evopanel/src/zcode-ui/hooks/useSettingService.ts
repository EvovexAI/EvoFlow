/**
 * useSettingService —— 设置服务 hooks
 */
import { useState, useEffect, useCallback } from "react";
import { APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL, type AppSettings } from "@zcode/shared";
import type { ISettingService } from "@zcode/services";
import { useServices } from "./useServices.js";
import { usePlatform } from "./usePlatform.js";

type SettingsSnapshot = {
  settings: AppSettings | null;
  loading: boolean;
  error: unknown | null;
};

interface SettingsStore {
  snapshot: SettingsSnapshot;
  inflightRefresh: Promise<void> | null;
  listeners: Set<(snapshot: SettingsSnapshot) => void>;
}

// SettingsPage 外层与模型配置页内层可能分别绑定 Local/Remote Service；
// 共享一份 snapshot/inflight 会让一次 Environment 的刷新结果覆盖另一份事实源。
// 按 Service 实例隔离 store，保持同一 Environment 内的组件共享，同时阻断跨 Environment 串写。
const stores = new WeakMap<object, SettingsStore>();
const unavailableSettingsStore: SettingsStore = {
  snapshot: {
    settings: null,
    loading: true,
    error: null,
  },
  inflightRefresh: null,
  listeners: new Set(),
};

function getSettingsStore(settingService: ISettingService | undefined): SettingsStore {
  if (
    !settingService ||
    (typeof settingService !== "object" && typeof settingService !== "function")
  ) {
    return unavailableSettingsStore;
  }
  const existing = stores.get(settingService);
  if (existing) {
    return existing;
  }
  const created: SettingsStore = {
    snapshot: {
      settings: null,
      loading: true,
      error: null,
    },
    inflightRefresh: null,
    listeners: new Set(),
  };
  stores.set(settingService, created);
  return created;
}

function emitSettingsSnapshot(store: SettingsStore) {
  for (const listener of store.listeners) {
    listener(store.snapshot);
  }
}

async function refreshSettingsStore(settingService: ISettingService | undefined) {
  const store = getSettingsStore(settingService);
  if (!settingService) {
    return;
  }
  if (store.inflightRefresh) {
    return store.inflightRefresh;
  }

  store.snapshot = {
    ...store.snapshot,
    loading: true,
    error: null,
  };
  emitSettingsSnapshot(store);

  store.inflightRefresh = (async () => {
    try {
      const result = await settingService.get();
      store.snapshot = {
        settings: result,
        loading: false,
        error: null,
      };
      emitSettingsSnapshot(store);
    } catch (error) {
      store.snapshot = {
        // 设置读取失败时保留旧快照，避免一次刷新错误把已可用的设置页降级为空状态。
        settings: store.snapshot.settings,
        loading: false,
        error,
      };
      emitSettingsSnapshot(store);
    }
  })().finally(() => {
    store.inflightRefresh = null;
  });

  return store.inflightRefresh;
}

/** 获取和更新应用设置 */
export function useSettings() {
  const { botsService, broadcastService, settingService, zcodeAgentService } = useServices();
  const platform = usePlatform();
  const settingsStore = getSettingsStore(settingService);
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>(settingsStore.snapshot);

  const refresh = useCallback(async () => {
    await refreshSettingsStore(settingService);
  }, [settingService]);

  useEffect(() => {
    const listener = (nextSnapshot: SettingsSnapshot) => {
      setSnapshot(nextSnapshot);
    };

    settingsStore.listeners.add(listener);
    setSnapshot(settingsStore.snapshot);
    void refresh();

    return () => {
      settingsStore.listeners.delete(listener);
    };
  }, [refresh, settingsStore]);

  useEffect(() => {
    return (
      platform.onSettingsChanged?.(() => {
        void refresh();
      }) ?? (() => {})
    );
  }, [platform, refresh]);

  const update = useCallback(
    async (patch: Partial<AppSettings>) => {
      await settingService.update(patch);
      platform.syncAppSettings?.(patch);
      await refresh();
      if (
        typeof patch.askUserQuestionAutoResolutionEnabled === "boolean" ||
        typeof patch.modelIoFullRetentionEnabled === "boolean"
      ) {
        const preferences = {
          askUserQuestionAutoResolutionEnabled:
            patch.askUserQuestionAutoResolutionEnabled ??
            settingsStore.snapshot.settings?.askUserQuestionAutoResolutionEnabled !== false,
          modelIoFullRetentionEnabled:
            patch.modelIoFullRetentionEnabled ??
            settingsStore.snapshot.settings?.modelIoFullRetentionEnabled === true,
        };
        const syncResults = await Promise.allSettled([
          zcodeAgentService.syncAppRuntimePreferences(preferences),
          botsService.syncAppRuntimePreferences(preferences),
        ]);
        const syncError = syncResults.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        )?.reason;
        await broadcastService.send({
          channel: APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL,
          payload: preferences,
        });
        if (syncError) {
          throw syncError;
        }
      }
    },
    [
      botsService,
      broadcastService,
      settingService,
      settingsStore,
      zcodeAgentService,
      platform,
      refresh,
    ],
  );

  return {
    settings: snapshot.settings,
    loading: snapshot.loading,
    error: snapshot.error,
    update,
    refresh,
  };
}

/** 最近项目列表的便捷 hook */
export function useRecentProjects() {
  const { settings, loading, update } = useSettings();
  return {
    recentProjects: settings?.recentProjects ?? [],
    loading,
    addProject: async (path: string) => {
      const current = settings?.recentProjects ?? [];
      const updated = [path, ...current.filter((p) => p !== path)].slice(0, 10);
      await update({ recentProjects: updated });
    },
  };
}
