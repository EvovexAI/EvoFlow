import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import type { IProviderSettingsService, ProviderSettingsView } from "@zcode/services";
import { logger } from "@/logger.js";
import {
  getProviderSettingsSnapshot,
  reloadProviderSettingsSnapshot,
  subscribeProviderSettingsSnapshot,
  type ProviderSettingsState,
} from "@/lib/providerSettingsSnapshot.js";

interface ProviderSettingsRead {
  state: ProviderSettingsState;
  reload(): void;
}

interface ProviderSettingsServiceRead extends ProviderSettingsRead {
  /** 提交 mutation 返回的权威 View；不依赖异步 onDidChange 事件才能收敛 UI。 */
  commit(view: ProviderSettingsView): void;
}

export function useProviderSettingsView(): ProviderSettingsRead {
  const state = useSyncExternalStore(
    subscribeProviderSettingsSnapshot,
    getProviderSettingsSnapshot,
    getProviderSettingsSnapshot,
  );
  return {
    state,
    reload: useCallback(() => {
      void reloadProviderSettingsSnapshot().catch((error) => {
        logger.warn("[ProviderSettings] 重试加载根 Environment 失败", { error });
      });
    }, []),
  };
}

interface OwnedProviderSettingsState {
  service: IProviderSettingsService;
  state: ProviderSettingsState;
}

/** Settings 编辑器按当前 ServiceProvider 读取目标 Environment，并显式暴露失败与重试。 */
export function useProviderSettingsServiceView(
  service: IProviderSettingsService,
): ProviderSettingsServiceRead {
  const [reloadVersion, reload] = useReducer((value: number) => value + 1, 0);
  const [owned, setOwned] = useState<OwnedProviderSettingsState>({
    service,
    state: { status: "loading" },
  });
  const ownedRef = useRef(owned);
  ownedRef.current = owned;
  const serviceRef = useRef(service);
  serviceRef.current = service;
  const generationRef = useRef(0);
  const latestRevisionRef = useRef(-1);
  const visibleState = owned.service === service ? owned.state : ({ status: "loading" } as const);

  const commitView = useCallback(
    (view: ProviderSettingsView): boolean => {
      // 远端 workspace attachment 换代时，旧 mutation 可能晚于新 Service 返回。
      // 只允许当前 Service 的最新 revision 提交，避免旧 Environment 回写新页面。
      if (serviceRef.current !== service || ownedRef.current.service !== service) {
        return false;
      }
      const current = ownedRef.current.state;
      const currentRevision = current.status === "ready" ? current.view.revision : -1;
      const latestRevision = Math.max(currentRevision, latestRevisionRef.current);
      if (view.revision < latestRevision) {
        return false;
      }
      // 同一 revision 的事件与 mutation response 表示同一份 Registry 事实，避免重复渲染。
      if (view.revision === latestRevision && current.status === "ready") {
        return false;
      }
      latestRevisionRef.current = view.revision;
      setOwned({ service, state: { status: "ready", view } });
      return true;
    },
    [service],
  );

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    const previous = ownedRef.current;
    const retainedReady =
      previous.service === service && previous.state.status === "ready" ? previous.state : null;
    setOwned({ service, state: retainedReady ?? { status: "loading" } });
    latestRevisionRef.current = retainedReady?.view.revision ?? -1;
    let hasReadyView = retainedReady !== null;
    const commit = (view: ProviderSettingsView): void => {
      if (generation !== generationRef.current) return;
      if (commitView(view)) {
        hasReadyView = true;
      }
    };
    const subscription = service.onDidChange(commit);
    void service.getView().then(commit, (cause) => {
      if (generation !== generationRef.current) return;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      logger.warn("[ProviderSettings] 加载目标 Environment 失败", { error });
      if (!hasReadyView) setOwned({ service, state: { status: "error", error } });
    });
    return () => {
      generationRef.current += 1;
      subscription.dispose();
    };
  }, [commitView, reloadVersion, service]);

  return {
    state: visibleState,
    reload: useCallback(() => reload(), []),
    commit: useCallback(
      (view: ProviderSettingsView) => {
        commitView(view);
      },
      [commitView],
    ),
  };
}
