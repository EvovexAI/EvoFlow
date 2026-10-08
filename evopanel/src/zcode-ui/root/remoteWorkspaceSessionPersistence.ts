import type { AppSettings, RemoteWorkspaceSessionEntry } from "@zcode/shared";
import { resolveStartupLocalWorkspaceSessionIndex } from "@zcode/shared";
import {
  buildPersistedWorkspaceSessionEntries,
  buildRemoteWorkspaceSessionEntryMap,
  buildWorkspaceSessionKey,
  readPersistedWorkspaceSessionEntries,
  resolveRemoteWorkspaceSessionIdentity,
} from "@/lib/remoteWorkspaceHistory.js";
import { logger } from "@/logger.js";
import {
  isWorkspaceTab,
  type RestorableWorkspaceTab,
  type TabStore,
  type TabStoreState,
} from "@/store/tabStore.js";

function getRestorableWorkspaceKey(tab: string | RestorableWorkspaceTab): string {
  if (typeof tab === "string") {
    return tab;
  }
  return tab.workspaceIdentity?.trim() || tab.workspacePath;
}

export function buildRemoteWorkspacePersistPatch(
  state: TabStoreState,
  remoteSessions: readonly RemoteWorkspaceSessionEntry[],
): Partial<AppSettings> {
  const remoteSessionMap = buildRemoteWorkspaceSessionEntryMap(remoteSessions);
  const serializedWorkspaceSessions = buildPersistedWorkspaceSessionEntries(
    state.tabs,
    remoteSessionMap,
  );
  const serializedRemoteWorkspaceKeys = new Set(
    serializedWorkspaceSessions.flatMap((entry) =>
      entry.kind === "remote" ? [buildWorkspaceSessionKey(entry)] : [],
    ),
  );
  const pendingRemoteSessions = remoteSessions.filter(
    (entry) => !serializedRemoteWorkspaceKeys.has(buildWorkspaceSessionKey(entry)),
  );
  const workspaceTabs = state.tabs.filter((tab) => tab.kind === "workspace");
  const activeIndex = state.activeWorkspacePath
    ? workspaceTabs.findIndex((tab) => tab.workspacePath === state.activeWorkspacePath)
    : 0;

  return {
    // SSH 入口被隐藏时会跳过远程 tab 恢复，tabs 里只剩本地项。
    // 如果这里只按当前 tabs 序列化，下一次写 setting.json 会把远程会话快照整体抹掉。
    // 这里把“当前已序列化项 + 未出现在 tabs 的远程快照”合并，确保入口恢复后仍可重连。
    lastWorkspaceSession: [...serializedWorkspaceSessions, ...pendingRemoteSessions],
    lastActiveTabIndex: Math.max(activeIndex, 0),
  };
}

export function restorePersistedRemoteWorkspaceSessions({
  settings,
  tabStoreApi,
  allowRemoteWorkspaceRestore = true,
  unavailableWorkspacePath,
  conversationWorkspacePath,
  restoreMode = "all",
}: {
  settings: AppSettings;
  tabStoreApi: TabStore;
  allowRemoteWorkspaceRestore?: boolean;
  unavailableWorkspacePath?: string;
  conversationWorkspacePath?: string;
  restoreMode?: "all" | "active-first";
}): { deferredRestore?: () => void } | undefined {
  const persistedSessions = readPersistedWorkspaceSessionEntries(settings);

  if (persistedSessions.length === 0 && !conversationWorkspacePath) {
    return;
  }

  const restoredTabs: Array<string | RestorableWorkspaceTab> = [];
  const seenLocalWorkspacePaths = new Set<string>();
  const seenRemoteWorkspaceKeys = new Set<string>();
  const activeSessionIndex = resolveStartupLocalWorkspaceSessionIndex(
    persistedSessions,
    settings.lastActiveTabIndex,
  );
  let restoredActiveIndex = 0;
  let canonicalConversationRestoredIndex: number | null = null;
  let shouldActivateCanonicalConversation = false;

  for (const [index, persistedEntry] of persistedSessions.entries()) {
    if (persistedEntry.kind === "local") {
      const isStaleConversationWorkspace = Boolean(
        conversationWorkspacePath &&
        persistedEntry.workspacePurpose === "conversation" &&
        persistedEntry.workspacePath !== conversationWorkspacePath,
      );
      if (isStaleConversationWorkspace) {
        // 测试数据根目录或旧 data root 可能把多个 conversation backing path
        // 持久化下来；它们是同一个逻辑“无项目会话”，恢复时必须以 service 给出的
        // canonical path 为准，否则侧栏和定时任务选择器都会出现多个 default。
        logger.warn("[Root] 跳过非 canonical conversation workspace 恢复", {
          workspacePath: persistedEntry.workspacePath,
          conversationWorkspacePath,
        });
        if (index === activeSessionIndex) {
          shouldActivateCanonicalConversation = true;
          if (canonicalConversationRestoredIndex !== null) {
            restoredActiveIndex = canonicalConversationRestoredIndex;
          }
        }
        continue;
      }

      if (seenLocalWorkspacePaths.has(persistedEntry.workspacePath)) {
        logger.warn("[Root] 跳过重复的本地 workspace 恢复", {
          workspacePath: persistedEntry.workspacePath,
        });
        continue;
      }

      const isConversationWorkspace = persistedEntry.workspacePath === conversationWorkspacePath;
      const workspacePurpose = isConversationWorkspace
        ? "conversation"
        : persistedEntry.workspacePurpose;
      const availability =
        !isConversationWorkspace && persistedEntry.workspacePath === unavailableWorkspacePath
          ? "unavailable-local-directory"
          : undefined;
      restoredTabs.push(
        workspacePurpose || availability
          ? {
              workspacePath: persistedEntry.workspacePath,
              workspacePurpose,
              availability,
            }
          : persistedEntry.workspacePath,
      );
      seenLocalWorkspacePaths.add(persistedEntry.workspacePath);
      const restoredIndex = restoredTabs.length - 1;
      if (isConversationWorkspace) {
        canonicalConversationRestoredIndex = restoredIndex;
      }
      if (
        index === activeSessionIndex ||
        (isConversationWorkspace && shouldActivateCanonicalConversation)
      ) {
        restoredActiveIndex = restoredIndex;
      }
      continue;
    }

    const workspaceIdentity = resolveRemoteWorkspaceSessionIdentity(persistedEntry);
    const workspaceKey = workspaceIdentity?.trim() || persistedEntry.workspacePath;
    if (seenRemoteWorkspaceKeys.has(workspaceKey)) {
      logger.warn("[Root] 跳过身份冲突的远程 workspace 恢复", {
        workspacePath: persistedEntry.workspacePath,
        workspaceIdentity,
      });
      continue;
    }

    if (!allowRemoteWorkspaceRestore) {
      // 远程连接入口被策略隐藏时，启动恢复不能悄悄拉起远程 workspace tab。
      // 否则用户看不到入口却仍保留“断连态远程项”，会造成展示与能力不一致。
      continue;
    }

    // 启动只恢复“断开态远程 tab”，不做自动重连。
    // 这样 setting.json 中的 lastConnectionStatus 才能真实反映上次结果，
    // 用户关闭的远端 tab 也不会在下次启动被后台拉回。
    restoredTabs.push({
      workspacePath: persistedEntry.workspacePath,
      remoteTarget: persistedEntry.target,
      workspaceIdentity,
    });
    seenRemoteWorkspaceKeys.add(workspaceKey);
  }

  if (conversationWorkspacePath && !seenLocalWorkspacePaths.has(conversationWorkspacePath)) {
    // conversation backing workspace 是 app-owned cwd，旧设置里缺少它时，
    // 侧栏就不会订阅该 scope；若 purpose 丢失又会被当成项目。恢复阶段以 service
    // 解析出的 canonical path 为权威，非激活补建并强制标记 conversation。
    restoredTabs.push({
      workspacePath: conversationWorkspacePath,
      workspacePurpose: "conversation",
    });
    canonicalConversationRestoredIndex = restoredTabs.length - 1;
    if (shouldActivateCanonicalConversation) {
      restoredActiveIndex = canonicalConversationRestoredIndex;
    }
  }

  if (restoredTabs.length > 0) {
    if (restoreMode === "active-first" && restoredTabs.length > 1) {
      const activeTab = restoredTabs[restoredActiveIndex];
      if (activeTab) {
        const activeWorkspaceKey = getRestorableWorkspaceKey(activeTab);
        logger.info("[Root] 优先恢复 active workspace", {
          deferredCount: restoredTabs.length - 1,
        });
        tabStoreApi.getState().restoreTabs([activeTab], 0);
        return {
          deferredRestore: () => {
            const startupActiveStillOpen = tabStoreApi
              .getState()
              .tabs.filter(isWorkspaceTab)
              .some(
                (tab) =>
                  (tab.workspaceIdentity?.trim() || tab.workspacePath) === activeWorkspaceKey,
              );
            // active-first 保存的是旧 settings 快照；idle callback 前用户若关闭 active tab，
            // 直接 complete 会把它从旧快照复活。关闭属于本窗口新意图，补齐时必须排除该 identity。
            const tabsToComplete = startupActiveStillOpen
              ? restoredTabs
              : restoredTabs.filter(
                  (restoredTab) => getRestorableWorkspaceKey(restoredTab) !== activeWorkspaceKey,
                );
            logger.info("[Root] 首帧后补齐 inactive workspace", {
              count: tabsToComplete.length - (startupActiveStillOpen ? 1 : 0),
            });
            tabStoreApi.getState().completeTabRestore(tabsToComplete);
          },
        };
      }
    }
    logger.info("[Root] 恢复组合 workspace 会话", {
      count: restoredTabs.length,
      activeIndex: restoredActiveIndex,
    });
    tabStoreApi.getState().restoreTabs(restoredTabs, restoredActiveIndex);
  }
  return undefined;
}
