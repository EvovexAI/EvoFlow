/**
 * useTabPersistence —— 标签页持久化
 *
 * - mount 时从 settingService 恢复上次打开的标签页
 * - 订阅 tab store 变化，debounce 写回 settingService
 */
import { useEffect, useRef } from "react";
import { useState } from "react";
import type { AppSettings } from "@zcode/shared";
import type { ISettingService } from "@zcode/services";
import { readPersistedWorkspaceSessionEntries } from "@/lib/remoteWorkspaceHistory.js";
import { useTabStoreApi } from "../store/TabStoreProvider.js";
import { isWorkspaceTab, type TabStoreState } from "../store/tabStore.js";
import { logger } from "../logger.js";

const DEBOUNCE_MS = 300;

interface TabPersistenceRestoreLifecycle {
  settingService?: ISettingService;
  restoreSession: boolean;
  completed: boolean;
  fullyCompleted: boolean;
}

interface TabPersistenceRestoreResult {
  /** 恢复期间识别出的 app-owned 路径，不得回填为最近项目。 */
  excludedRecentProjectPaths?: readonly string[];
  /** active workspace 已恢复后，在首帧后的 idle period 补齐 inactive workspace。 */
  deferredRestore?: () => void;
}

function scheduleDeferredRestore(callback: () => void): () => void {
  if (typeof globalThis.requestIdleCallback === "function") {
    const idleCallbackId = globalThis.requestIdleCallback(() => callback(), {
      timeout: 1_000,
    });
    return () => globalThis.cancelIdleCallback(idleCallbackId);
  }

  const timer = globalThis.setTimeout(callback, 0);
  return () => globalThis.clearTimeout(timer);
}

function hasCompletedTabPersistenceInitialRestore({
  settingService,
  restoreSession,
  restoreLifecycle,
}: {
  settingService?: ISettingService;
  restoreSession: boolean;
  restoreLifecycle: TabPersistenceRestoreLifecycle;
}): boolean {
  const shouldRestoreSession = Boolean(settingService && restoreSession);
  return (
    !shouldRestoreSession ||
    (restoreLifecycle.settingService === settingService &&
      restoreLifecycle.restoreSession === restoreSession &&
      restoreLifecycle.completed)
  );
}

function getRecentProjectPathsFromSettings(
  settings: Pick<AppSettings, "lastWorkspaceSession">,
  excludedPaths: readonly string[] = [],
): string[] {
  const excludedPathSet = new Set(excludedPaths);
  return readPersistedWorkspaceSessionEntries(settings)
    .flatMap((entry) =>
      entry.kind === "local" &&
      entry.workspacePurpose !== "conversation" &&
      !excludedPathSet.has(entry.workspacePath)
        ? [entry.workspacePath]
        : [],
    )
    .slice(0, 10);
}

function buildRestoredRecentProjectPaths(
  settings: Pick<AppSettings, "lastWorkspaceSession" | "recentProjects">,
  excludedPaths: readonly string[] = [],
): string[] {
  const excludedPathSet = new Set(excludedPaths);
  const existingRecent = (settings.recentProjects ?? []).filter(
    (path) => !excludedPathSet.has(path),
  );
  const restoredProjects = getRecentProjectPathsFromSettings(settings, excludedPaths);
  return [...new Set([...existingRecent, ...restoredProjects])].slice(0, 10);
}

function buildDefaultPersistPatch(state: TabStoreState): Partial<AppSettings> {
  const workspaceTabs = state.tabs.filter(isWorkspaceTab).filter((tab) => !tab.remoteSessionId);
  const activeIndex = state.activeWorkspacePath
    ? workspaceTabs.findIndex((tab) => tab.workspacePath === state.activeWorkspacePath)
    : 0;

  return {
    lastWorkspaceSession: workspaceTabs.map((tab) => ({
      kind: "local" as const,
      workspacePath: tab.workspacePath,
      ...(tab.workspacePurpose ? { workspacePurpose: tab.workspacePurpose } : {}),
    })),
    lastActiveTabIndex: Math.max(activeIndex, 0),
  };
}

export function useTabPersistence({
  settingService,
  restoreSession = true,
  persistSession = restoreSession,
  restorePersistedSession,
  buildPersistPatch,
}: {
  settingService?: ISettingService;
  /** 是否恢复上次会话，首个窗口 true，新窗口 false */
  restoreSession?: boolean;
  /** 是否把当前窗口会话写回全局设置，首个窗口 true，新窗口 false */
  persistSession?: boolean;
  /** 自定义恢复流程；不传则回退到默认的本地 tab 恢复逻辑 */
  restorePersistedSession?: (
    settings: AppSettings,
  ) => Promise<TabPersistenceRestoreResult | void> | TabPersistenceRestoreResult | void;
  /** 自定义持久化补丁；不传则只写回本地 workspace 会话 */
  buildPersistPatch?: (state: TabStoreState) => Partial<AppSettings>;
}) {
  const store = useTabStoreApi();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldRestoreSession = Boolean(settingService && restoreSession);
  const initialRestoreFullyCompletedRef = useRef(!shouldRestoreSession);
  const [restoreLifecycle, setRestoreLifecycle] = useState<TabPersistenceRestoreLifecycle>(() => ({
    settingService,
    restoreSession,
    completed: !shouldRestoreSession,
    fullyCompleted: !shouldRestoreSession,
  }));
  // provider/OAuth gate 从 false 切到 true 的同一轮 render 里，
  // 恢复会话 effect 还没来得及把 isRestoring 设为 true。这里把完成态绑定到
  // 当前 settingService + restoreSession，避免 initialWorkspacePath 抢在 restoreTabs 前 addTab。
  const hasCompletedInitialRestore = hasCompletedTabPersistenceInitialRestore({
    settingService,
    restoreSession,
    restoreLifecycle,
  });
  const hasCompletedFullRestore =
    !shouldRestoreSession ||
    (restoreLifecycle.settingService === settingService &&
      restoreLifecycle.restoreSession === restoreSession &&
      restoreLifecycle.fullyCompleted);
  const isRestoring = shouldRestoreSession && !hasCompletedInitialRestore;

  // 恢复会话
  useEffect(() => {
    if (!settingService || !restoreSession) {
      initialRestoreFullyCompletedRef.current = true;
      setRestoreLifecycle({
        settingService,
        restoreSession,
        completed: true,
        fullyCompleted: true,
      });
      return;
    }

    let cancelled = false;
    let cancelDeferredRestore: (() => void) | null = null;
    initialRestoreFullyCompletedRef.current = false;
    // Root 首屏会先按 tab store 的默认空状态渲染打开工作区中间页，
    // 随后这里再异步恢复 lastWorkspaceSession，导致主界面启动时闪一下“打开项目”。
    // 这里显式暴露恢复中的状态，让外层在会话检查完成前持续显示 loading，
    // 避免把“默认空态”误展示给用户。
    setRestoreLifecycle({
      settingService,
      restoreSession,
      completed: false,
      fullyCompleted: false,
    });

    settingService
      .get()
      .then(async (settings) => {
        let restoreResult: TabPersistenceRestoreResult | void = undefined;
        if (restorePersistedSession) {
          restoreResult = await restorePersistedSession(settings);
        } else {
          const tabs = readPersistedWorkspaceSessionEntries(settings).flatMap((entry) =>
            entry.kind === "local"
              ? [
                  entry.workspacePurpose
                    ? {
                        workspacePath: entry.workspacePath,
                        workspacePurpose: entry.workspacePurpose,
                      }
                    : entry.workspacePath,
                ]
              : [],
          );
          const activeIndex = settings.lastActiveTabIndex ?? 0;
          if (tabs.length > 0) {
            logger.info("[useTabPersistence] 恢复标签页:", tabs);
            store.getState().restoreTabs(tabs, activeIndex);
          }
        }

        const excludedRecentProjectPaths = restoreResult?.excludedRecentProjectPaths ?? [];
        // recentProjects 只在用户通过打开工作区动作手动选择项目时更新，
        // 但大部分用户都是通过会话恢复打开 workspace 的，导致 recentProjects 一直为空。
        // 现在会话恢复同时覆盖本地 + remote，两者又共用 lastActiveTabIndex；
        // 这里统一从完整会话快照里抽出本地 workspace，再回填 recentProjects，
        // 避免 remote 恢复接入后又退回成“只有手动打开的本地项目才会出现在历史里”。
        // 旧版本丢失 workspacePurpose 后，会把 app-owned default cwd
        // 当作普通 project 写进 recentProjects。仅过滤本次恢复出来的 session 不够，
        // 还必须清理历史残留，否则项目选择器仍会再次把它渲染为 workspace。
        const merged = buildRestoredRecentProjectPaths(settings, excludedRecentProjectPaths);
        const persistedRecent = settings.recentProjects ?? [];
        if (
          merged.length !== persistedRecent.length ||
          merged.some((p, i) => p !== persistedRecent[i])
        ) {
          settingService.update({ recentProjects: merged }).catch((err) => {
            logger.error("[useTabPersistence] 同步 recentProjects 失败:", err);
          });
        }
        if (!cancelled) {
          const deferredRestore = restoreResult?.deferredRestore;
          setRestoreLifecycle({
            settingService,
            restoreSession,
            completed: true,
            fullyCompleted: !deferredRestore,
          });
          if (deferredRestore) {
            cancelDeferredRestore = scheduleDeferredRestore(() => {
              if (cancelled) {
                return;
              }
              // active-only 是启动瞬态，不能提前持久化；补齐合并产生的 store event
              // 才是首个允许写回的完整 session snapshot。
              initialRestoreFullyCompletedRef.current = true;
              try {
                deferredRestore();
              } catch (error) {
                logger.error("[useTabPersistence] 补齐 inactive workspace 失败:", error);
              } finally {
                if (!cancelled) {
                  setRestoreLifecycle({
                    settingService,
                    restoreSession,
                    completed: true,
                    fullyCompleted: true,
                  });
                }
              }
            });
          } else {
            initialRestoreFullyCompletedRef.current = true;
          }
        }
      })
      .catch((err) => {
        logger.error("[useTabPersistence] 恢复标签页失败:", err);
        if (!cancelled) {
          initialRestoreFullyCompletedRef.current = true;
          setRestoreLifecycle({
            settingService,
            restoreSession,
            completed: true,
            fullyCompleted: true,
          });
        }
      });

    return () => {
      cancelled = true;
      cancelDeferredRestore?.();
    };
  }, [restorePersistedSession, settingService, restoreSession, store]);

  // 持久化：订阅 store 变化，debounce 写入
  useEffect(() => {
    if (!settingService || !persistSession) return;

    const unsubscribe = store.subscribe((state) => {
      if (!initialRestoreFullyCompletedRef.current) {
        return;
      }
      if (timerRef.current) clearTimeout(timerRef.current);

      timerRef.current = setTimeout(() => {
        // 新开的次级窗口如果也把自己的标签页写回全局设置，
        // 会把主窗口真正想恢复的会话覆盖掉，导致下次启动恢复到错误窗口。
        // 这里把“是否持久化会话”独立成开关，只让首个本地窗口负责写回。
        settingService
          .update((buildPersistPatch ?? buildDefaultPersistPatch)(state))
          .catch((err) => {
            logger.error("[useTabPersistence] 持久化失败:", err);
          });
      }, DEBOUNCE_MS);
    });

    return () => {
      unsubscribe();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [buildPersistPatch, persistSession, store, settingService]);

  return { isRestoring, hasCompletedInitialRestore, hasCompletedFullRestore };
}
