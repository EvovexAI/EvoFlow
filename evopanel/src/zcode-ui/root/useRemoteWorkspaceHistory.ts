/* eslint-disable max-lines -- 远端 workspace 历史目前需要在一个 hook 内同时收口恢复、重连、持久化和清理流程，先保留同文件协作边界，避免为过 lint 临时拆分后引入状态回归。*/
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  AppSettings,
  BotRemoteWorkspaceReconnectedEvent,
  IPlatformService,
  RemoteSessionClosedEvent,
  RemoteWorkspaceSessionEntry,
} from "@zcode/shared";
import { buildSshRemoteHostKey, createUuid, stripRemoteTargetSecrets } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import {
  bindRemoteWorkspaceIdentity,
  bindRemoteWorkspacePath,
  getRemoteWorkspaceSession,
  type RemoteWorkspaceSession,
  unregisterRemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { refreshRemotePinnedTasksForSession } from "@/store/remotePinnedTaskStore.js";
import { refreshRemoteTimelineTasksForSession } from "@/store/remoteTimelineTaskStore.js";
import { toast } from "@/components/ui/toast.js";
import {
  buildRemoteWorkspaceIdentity,
  buildRemoteWorkspaceSessionMutation,
  buildWorkspaceSessionKey,
  createRemoteTargetFromSnapshot,
  getRemoteWorkspaceSessionEntries,
  removeRemoteWorkspaceSessionEntries,
} from "@/lib/remoteWorkspaceHistory.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";
import { isWorkspaceTab, type TabStoreState, type WindowTabState } from "@/store/tabStore.js";
import {
  buildRemoteWorkspacePersistPatch,
  restorePersistedRemoteWorkspaceSessions,
} from "@/root/remoteWorkspaceSessionPersistence.js";
import { useReconnectingRemoteWorkspaceLogs } from "@/root/useReconnectingRemoteWorkspaceLogs.js";
import {
  reconnectRemoteWorkspaceHistoryEntry,
  type BindRemoteWorkspaceSessionContextFn,
  type ReconnectRemoteWorkspaceOptions,
  type SshReconnectCredentials,
} from "@/root/reconnectRemoteWorkspaceHistoryEntry.js";
import { useRemoteConnectionEntryVisibility } from "@/hooks/useRemoteConnectionEntryVisibility.js";
import { markRemoteWorkspaceRunningTasksFailed } from "@/lib/remoteWorkspaceSessionRuntime.js";

export { reconnectRemoteWorkspaceHistoryEntry };

async function bindRemoteWorkspaceContextAndGetSession(params: {
  platform: Pick<IPlatformService, "bindRemoteWorkspaceSessionContext">;
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}): Promise<RemoteWorkspaceSession> {
  if (!getRemoteWorkspaceSession(params.sessionId)) {
    throw new Error(`远程 workspace session 不存在: ${params.sessionId}`);
  }
  await params.platform.bindRemoteWorkspaceSessionContext?.({
    remoteSessionId: params.sessionId,
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
  });
  // bind 会让同一 remoteSessionId 的 attachment/services 从 A 换代到 B。
  // bind 前捕获的对象仍指向 A，因此必须在 ready ACK 后按 sessionId 重新读取当前 services。
  const currentSession = getRemoteWorkspaceSession(params.sessionId);
  if (!currentSession) {
    throw new Error(`远程 workspace session 不存在: ${params.sessionId}`);
  }
  return currentSession;
}

function resolveBotRemoteWorkspaceReconnectedIdentity(params: {
  event: Pick<BotRemoteWorkspaceReconnectedEvent, "workspaceIdentity">;
  resolvedWorkspacePath: string;
  target: BotRemoteWorkspaceReconnectedEvent["target"];
}): string {
  const eventWorkspaceIdentity = params.event.workspaceIdentity.trim();
  if (eventWorkspaceIdentity) {
    // Bugfix: Bot task/stream 广播继续使用 bot context 捕获的 workspaceIdentity。
    // 这里如果用 canonical path 重新计算 identity，UI tab 会订阅到另一个 key，导致远端结果被过滤掉。
    return eventWorkspaceIdentity;
  }
  return buildRemoteWorkspaceIdentity(params.resolvedWorkspacePath, params.target);
}

function shouldPersistRemoteWorkspaceFailure(params: {
  pendingReconnectRequestIds: ReadonlyMap<string, string>;
  sessionEntry: RemoteWorkspaceSessionEntry;
  workspaceKey: string;
}): boolean {
  if (params.sessionEntry.target.kind !== "wsl") {
    return true;
  }

  // WSL 偶发断连时，旧 session 的关闭事件可能会晚于手动重连流程。
  // 只要当前 workspace 已经有 pending reconnect，就先别把 failed 写死到 setting，
  // 让最终结果由这次重连成功/失败决定。
  return !params.pendingReconnectRequestIds.has(params.workspaceKey);
}
interface RemoteWorkspaceTabStoreReader {
  getState(): {
    tabs: WindowTabState[];
  };
}

interface OpenRemoteWorkspaceFromHistoryParams {
  workspaceKey: string;
  tabStoreApi: RemoteWorkspaceTabStoreReader;
  getRemoteSessions: () => RemoteWorkspaceSessionEntry[];
  inflightReconnectWorkspaceKeys: Set<string>;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  setReconnectingRemoteWorkspaceKeys: Dispatch<SetStateAction<string[]>>;
  loadCredential: IServiceAccessor["credentialService"]["load"];
  connectRemoteWorkspaceTarget: (
    target: Parameters<IPlatformService["connectRemote"]>[0],
    requestId?: string,
  ) => Promise<string>;
  resolveRemoteWorkspaceCanonicalPath: (
    sessionId: string,
    workspacePath: string,
  ) => Promise<string>;
  disposeRemoteWorkspaceSession: (sessionId: string) => Promise<void>;
  bindRemoteWorkspaceSessionContext: BindRemoteWorkspaceSessionContextFn;
  addTab: (
    workspacePath: string,
    options?: {
      remoteSessionId?: string;
      remoteTarget?: Parameters<IPlatformService["connectRemote"]>[0];
      workspaceIdentity?: string;
      localWorkspacePath?: string;
    },
  ) => void;
  commitRemoteWorkspaceSessionMutation: (
    mutation: ReturnType<typeof buildRemoteWorkspaceSessionMutation>,
  ) => Promise<RemoteWorkspaceSessionEntry>;
  resetLogsForWorkspaceKey: (workspaceKey: string) => void;
  onWorkspaceActivated?: (target: { workspacePath: string; workspaceIdentity: string }) => void;
  createReconnectRequestId?: () => string;
  pendingReconnectRequestIds?: Map<string, string>;
  reconnectImpl?: typeof reconnectRemoteWorkspaceHistoryEntry;
}

interface ReconnectRemoteWorkspaceByKeyParams {
  workspaceKey: string;
  canUseRemoteWorkspace: boolean;
  getRemoteSessions: () => RemoteWorkspaceSessionEntry[];
  runReconnectRemoteWorkspace: (
    sessionEntry: RemoteWorkspaceSessionEntry,
    options?: ReconnectRemoteWorkspaceOptions,
  ) => Promise<void>;
  options?: ReconnectRemoteWorkspaceOptions;
}

async function reconnectRemoteWorkspaceByKey({
  workspaceKey,
  canUseRemoteWorkspace,
  getRemoteSessions,
  runReconnectRemoteWorkspace,
  options,
}: ReconnectRemoteWorkspaceByKeyParams): Promise<boolean> {
  if (!canUseRemoteWorkspace) {
    throw new Error("Remote workspace is disabled in this mode");
  }

  const sessionEntry = getRemoteSessions().find(
    (entry) => buildWorkspaceSessionKey(entry) === workspaceKey,
  );
  if (!sessionEntry) {
    throw new Error(`远程 workspace 不在当前窗口中，无法重连: ${workspaceKey}`);
  }

  await runReconnectRemoteWorkspace(sessionEntry, options);
  return true;
}

function collectSshReconnectGroup(params: {
  selected: RemoteWorkspaceSessionEntry;
  sessions: RemoteWorkspaceSessionEntry[];
  tabs: WindowTabState[];
}): RemoteWorkspaceSessionEntry[] {
  if (params.selected.target.kind !== "ssh") {
    return [params.selected];
  }
  const remoteHostKey = buildSshRemoteHostKey(params.selected.target);
  const disconnectedWorkspaceKeys = new Set(
    params.tabs.flatMap((tab) => {
      if (!isWorkspaceTab(tab) || tab.remoteSessionId) {
        return [];
      }
      return [buildWorkspaceSessionKey(tab)];
    }),
  );
  const reconnectGroup = params.sessions.filter(
    (entry) =>
      entry.target.kind === "ssh" &&
      buildSshRemoteHostKey(entry.target) === remoteHostKey &&
      disconnectedWorkspaceKeys.has(buildWorkspaceSessionKey(entry)),
  );
  const selectedWorkspaceKey = buildWorkspaceSessionKey(params.selected);
  if (!reconnectGroup.some((entry) => buildWorkspaceSessionKey(entry) === selectedWorkspaceKey)) {
    return [params.selected];
  }

  // 历史记录顺序不代表本次重连发起者。initiator 必须固定在首位，
  // 否则并发加载凭据时 sibling 可能先创建共享 Host，导致整组误用旧凭据。
  return [
    params.selected,
    ...reconnectGroup.filter((entry) => buildWorkspaceSessionKey(entry) !== selectedWorkspaceKey),
  ];
}

async function reconnectRemoteWorkspaceGroup(params: {
  selected: RemoteWorkspaceSessionEntry;
  reconnectGroup: RemoteWorkspaceSessionEntry[];
  reconnectEntry: (
    entry: RemoteWorkspaceSessionEntry,
    options?: ReconnectRemoteWorkspaceOptions,
  ) => Promise<boolean>;
  options?: ReconnectRemoteWorkspaceOptions;
}): Promise<void> {
  const selectedWorkspaceKey = buildWorkspaceSessionKey(params.selected);
  const siblings = params.reconnectGroup.filter(
    (entry) => buildWorkspaceSessionKey(entry) !== selectedWorkspaceKey,
  );

  if (params.selected.target.kind !== "ssh") {
    try {
      await params.reconnectEntry(params.selected, {
        ...params.options,
        throwOnFailure: true,
      });
    } catch (error) {
      if (params.options?.throwOnFailure) {
        throw error;
      }
    }
    return;
  }

  type InitiatorHostGate =
    | { status: "ready"; credentials: SshReconnectCredentials }
    | { status: "skipped" }
    | { status: "failed"; error: unknown };
  let hostReadyCredentials: SshReconnectCredentials | undefined;
  let resolveHostReady!: (result: InitiatorHostGate) => void;
  const hostReadyPromise = new Promise<InitiatorHostGate>((resolve) => {
    resolveHostReady = resolve;
  });

  // 组内并发连接会让最先完成 credential load 的 sibling 抢建共享 Host。
  // initiator 先负责把 Host 建到 ready；后续 provider/task 初始化不再阻塞 sibling attachment。
  const initiatorPromise = params.reconnectEntry(params.selected, {
    ...params.options,
    throwOnFailure: true,
    onSshHostReady: (credentials) => {
      if (hostReadyCredentials) {
        return;
      }
      hostReadyCredentials = credentials;
      resolveHostReady({ status: "ready", credentials });
    },
  });
  const initiatorFinishedBeforeReady = initiatorPromise.then<InitiatorHostGate, InitiatorHostGate>(
    (didReconnect) => {
      if (hostReadyCredentials) {
        return { status: "ready", credentials: hostReadyCredentials };
      }
      return didReconnect
        ? {
            status: "failed",
            error: new Error("SSH initiator completed without reporting Host ready"),
          }
        : { status: "skipped" };
    },
    (error: unknown) =>
      hostReadyCredentials
        ? { status: "ready", credentials: hostReadyCredentials }
        : { status: "failed", error },
  );
  const hostGate = await Promise.race([hostReadyPromise, initiatorFinishedBeforeReady]);
  if (hostGate.status !== "ready") {
    if (hostGate.status === "failed" && params.options?.throwOnFailure) {
      throw hostGate.error;
    }
    return;
  }

  // sibling 只复用 initiator credential 命中 ready Host，不再读取各自历史 credential；
  // path/provider/task 初始化与 initiator 并行并保持独立失败语义。
  const siblingPromise = Promise.allSettled(
    siblings.map((entry) =>
      params.reconnectEntry(entry, {
        ...params.options,
        activateWorkspaceAfterReconnect: false,
        sshCredentialsOverride: hostGate.credentials,
      }),
    ),
  );
  const [initiatorResult] = await Promise.all([
    initiatorPromise.then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    ),
    siblingPromise,
  ]);
  if (initiatorResult.status === "rejected" && params.options?.throwOnFailure) {
    throw initiatorResult.error;
  }
}

function shouldKeepRemoteWorkspaceInTabs(params: {
  tabStoreApi: RemoteWorkspaceTabStoreReader;
  workspacePath: string;
  workspaceIdentity?: string;
}): boolean {
  const reconnectWorkspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
  return params.tabStoreApi
    .getState()
    .tabs.some(
      (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
        isWorkspaceTab(tab) &&
        ((tab.workspaceIdentity?.trim() || tab.workspacePath) === reconnectWorkspaceKey ||
          tab.workspacePath === params.workspacePath),
    );
}

async function cancelPendingRemoteReconnectsForWorkspaceKeys(params: {
  workspaceKeys: string[];
  pendingRequestIds: Map<string, string>;
  cancelPendingRemoteConnection?: (requestId?: string) => Promise<void>;
  logger: Pick<typeof logger, "warn">;
}): Promise<void> {
  const requestIds = params.workspaceKeys.flatMap((workspaceKey) => {
    const requestId = params.pendingRequestIds.get(workspaceKey);
    if (!requestId) {
      return [];
    }

    params.pendingRequestIds.delete(workspaceKey);
    return [requestId];
  });

  if (!params.cancelPendingRemoteConnection || requestIds.length === 0) {
    return;
  }

  await Promise.all(
    requestIds.map(async (requestId) => {
      try {
        await params.cancelPendingRemoteConnection?.(requestId);
      } catch (error) {
        params.logger.warn("[Root] 取消远程 workspace 重连失败", {
          requestId,
          error,
        });
      }
    }),
  );
}

async function openRemoteWorkspaceFromHistoryEntry({
  workspaceKey,
  tabStoreApi,
  getRemoteSessions,
  inflightReconnectWorkspaceKeys,
  activateTabByPath,
  setReconnectingRemoteWorkspaceKeys,
  loadCredential,
  connectRemoteWorkspaceTarget,
  resolveRemoteWorkspaceCanonicalPath,
  disposeRemoteWorkspaceSession,
  bindRemoteWorkspaceSessionContext,
  addTab,
  commitRemoteWorkspaceSessionMutation,
  resetLogsForWorkspaceKey,
  createReconnectRequestId,
  pendingReconnectRequestIds,
  reconnectImpl = reconnectRemoteWorkspaceHistoryEntry,
  onWorkspaceActivated,
}: OpenRemoteWorkspaceFromHistoryParams): Promise<void> {
  const sessionEntry = getRemoteSessions().find(
    (entry) => buildWorkspaceSessionKey(entry) === workspaceKey,
  );
  if (!sessionEntry) {
    return;
  }

  if (inflightReconnectWorkspaceKeys.has(workspaceKey)) {
    return;
  }

  const existingWorkspaceTab = tabStoreApi
    .getState()
    .tabs.find(
      (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
        isWorkspaceTab(tab) && buildWorkspaceSessionKey(tab) === workspaceKey,
    );
  if (existingWorkspaceTab?.remoteSessionId) {
    activateTabByPath(existingWorkspaceTab.workspacePath, {
      workspaceIdentity: existingWorkspaceTab.workspaceIdentity,
    });
    return;
  }

  // 选择页远程历史与侧栏重连都属于“恢复已有 remote workspace”语义。
  // 如果这里缺少“仍需保留该 workspace”的二次校验，用户在重连中移除后仍会被成功回调重新加回 tab。
  // 这里复用同一套 shouldKeep 判定，保证两条入口的竞态行为一致。
  resetLogsForWorkspaceKey(workspaceKey);
  inflightReconnectWorkspaceKeys.add(workspaceKey);
  const requestId = createReconnectRequestId?.();
  if (requestId) {
    pendingReconnectRequestIds?.set(workspaceKey, requestId);
  }
  try {
    await reconnectImpl({
      sessionEntry,
      activateTabByPath,
      setReconnectingRemoteWorkspaceKeys,
      loadCredential,
      connectRemoteWorkspaceTarget,
      resolveRemoteWorkspaceCanonicalPath,
      disposeRemoteWorkspaceSession,
      bindRemoteWorkspaceSessionContext,
      bindRemoteWorkspacePath,
      bindRemoteWorkspaceIdentity,
      upsertWorkspaceTab: addTab,
      commitRemoteWorkspaceSessionMutation,
      getRemoteSessions,
      logger,
      toast,
      shouldKeepReconnectedWorkspace: ({ workspacePath, workspaceIdentity }) =>
        shouldKeepRemoteWorkspaceInTabs({
          tabStoreApi,
          workspacePath,
          workspaceIdentity,
        }),
      onWorkspaceActivated: (target) => {
        logger.debug("[Root] 远程历史 workspace ready，提交 tab 与 draft 激活", target);
        onWorkspaceActivated?.(target);
      },
      options: {
        // 历史入口过去只回填 connected tab，却没有提交 tab activation 和 draft owner，
        // 所以连接成功后右侧仍停留在旧 workspace。共享 helper 只会在 services ready 后执行此提交，
        // 不会提前暴露缺少 remoteSessionId 的 remote-waiting tab。
        activateWorkspaceAfterReconnect: true,
        showErrorToast: true,
        requestId,
      },
    });
  } finally {
    inflightReconnectWorkspaceKeys.delete(workspaceKey);
    if (requestId && pendingReconnectRequestIds?.get(workspaceKey) === requestId) {
      pendingReconnectRequestIds.delete(workspaceKey);
    }
  }
}

async function selectRemoteWorkspaceProjectFromDialog({
  canUseRemoteWorkspace,
  sessionId,
  path,
  localWorkspacePath,
  loadingMessage,
  getRemoteWorkspaceSession,
  connectionTarget,
  getWorkspaceTabs,
  resolveRemoteWorkspaceCanonicalPath,
  activateTabByPath,
  handleCancelRemoteProject,
  bindRemoteWorkspaceSessionContext,
  commitRemoteWorkspaceSessionMutation,
  getRemoteSessions,
  bindRemoteWorkspacePath,
  bindRemoteWorkspaceIdentity,
  addTab,
  onWorkspaceActivated,
  refreshPinnedTasks,
  refreshTimelineTasks,
}: {
  canUseRemoteWorkspace: boolean;
  sessionId: string;
  path: string;
  localWorkspacePath?: string;
  loadingMessage: string;
  getRemoteWorkspaceSession: (sessionId: string) => RemoteWorkspaceSession | null;
  connectionTarget?: Parameters<IPlatformService["connectRemote"]>[0];
  getWorkspaceTabs: () => WindowTabState[];
  resolveRemoteWorkspaceCanonicalPath: (
    sessionId: string,
    workspacePath: string,
  ) => Promise<string>;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  handleCancelRemoteProject: (sessionId: string) => Promise<void>;
  bindRemoteWorkspaceSessionContext: BindRemoteWorkspaceSessionContextFn;
  commitRemoteWorkspaceSessionMutation: (
    mutation: ReturnType<typeof buildRemoteWorkspaceSessionMutation>,
  ) => Promise<RemoteWorkspaceSessionEntry>;
  getRemoteSessions: () => RemoteWorkspaceSessionEntry[];
  bindRemoteWorkspacePath: (workspacePath: string, sessionId: string) => void;
  bindRemoteWorkspaceIdentity: (workspaceIdentity: string, sessionId: string) => void;
  addTab: (
    workspacePath: string,
    options?: {
      remoteSessionId?: string;
      remoteTarget?: Parameters<IPlatformService["connectRemote"]>[0];
      workspaceIdentity?: string;
      localWorkspacePath?: string;
    },
  ) => void;
  onWorkspaceActivated?: (target: { workspacePath: string; workspaceIdentity: string }) => void;
  refreshPinnedTasks: (params: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }) => Promise<void>;
  refreshTimelineTasks: (params: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }) => Promise<void>;
}): Promise<void> {
  if (!canUseRemoteWorkspace) {
    throw new Error("Remote workspace is disabled in this mode");
  }

  const remoteSession = getRemoteWorkspaceSession(sessionId);
  if (!remoteSession) {
    throw new Error(loadingMessage);
  }
  const remoteTarget = connectionTarget ?? remoteSession.target;
  if (!remoteTarget) {
    // 手机 web relay 复用 remote session store 只做服务路由，没有本地可重连 target。
    // 远程历史的选目录/持久化流程必须有 target，缺失时直接阻断，避免把无 target 的桥接 session 写进历史。
    throw new Error(`远程 workspace session 缺少连接目标: ${sessionId}`);
  }

  const canonicalPath = await resolveRemoteWorkspaceCanonicalPath(sessionId, path);
  const workspaceIdentity = buildRemoteWorkspaceIdentity(canonicalPath, remoteTarget);
  const existingWorkspaceTab = getWorkspaceTabs().find(
    (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
      isWorkspaceTab(tab) &&
      tab.workspacePath === canonicalPath &&
      (tab.workspaceIdentity?.trim() || tab.workspacePath) === workspaceIdentity,
  );

  if (
    existingWorkspaceTab?.remoteSessionId &&
    activateTabByPath(canonicalPath, { workspaceIdentity })
  ) {
    onWorkspaceActivated?.({ workspacePath: canonicalPath, workspaceIdentity });
    await handleCancelRemoteProject(sessionId);
    return;
  }

  // 断连 tab 以前会在 provider/session 绑定完成前先被 activateTabByPath 激活，
  // V4PaneConversationProvider 此时只能得到 remote-waiting，因 rpcReady=false 返回 null，
  // 右侧便会先空白，等后续 addTab 写回 remoteSessionId 后才出现新建对话。
  // 断连 tab 与首次连接统一等到服务绑定完成后再由 addTab 原子激活，避免暴露半连接 workspace。

  // 新建连接不带 context，main/host 的 logical session
  // descriptor 停留在连接根目录 "/"，identity 也是 Host 用解析后 target 自建的；而 tab、远程历史与
  // 手机可见 workspace 列表用的都是这里算出的 canonicalPath/workspaceIdentity。
  // 手机桥接（attachRemoteWorkspaceSessionHost）要求二者三元全等，所以选目录后必须先把 canonical
  // context 绑定回 main，再提交 connected 状态与 tab。df2db1df7a 把 provider 同步移到 main/host 时
  // 顺带删掉了这次 bind，导致新建连接后选的目录在手机端必然被 REMOTE_WORKSPACE_IDENTITY_MISMATCH 拒绝。
  // bind 失败时 fail-closed：回收 session 并把错误抛回连接弹窗，不留下 descriptor 与 tab 不一致的 session。
  try {
    await bindRemoteWorkspaceSessionContext({
      sessionId,
      workspacePath: canonicalPath,
      workspaceIdentity,
    });
  } catch (error) {
    await handleCancelRemoteProject(sessionId);
    throw error;
  }

  await commitRemoteWorkspaceSessionMutation(
    buildRemoteWorkspaceSessionMutation({
      remoteSessions: getRemoteSessions(),
      workspacePath: canonicalPath,
      localWorkspacePath,
      workspaceIdentity,
      target: remoteTarget,
      lastConnectionStatus: "connected",
      touchOpenedAt: true,
    }),
  );

  bindRemoteWorkspacePath(canonicalPath, sessionId);
  bindRemoteWorkspaceIdentity(workspaceIdentity, sessionId);
  addTab(canonicalPath, {
    remoteSessionId: sessionId,
    remoteTarget: stripRemoteTargetSecrets(remoteTarget),
    workspaceIdentity,
    localWorkspacePath,
  });
  // startDraft 之前在调用方等待 pinned/timeline 刷新结束后才执行，
  // tab 已切到远端但草稿 owner 仍是旧状态，形成可见的空白中间帧。
  // 激活回调必须紧跟 addTab，在任何列表刷新 await 之前提交同一 workspaceKey 的草稿态。
  onWorkspaceActivated?.({ workspacePath: canonicalPath, workspaceIdentity });
  await Promise.all([
    refreshPinnedTasks({
      sessionId,
      workspacePath: canonicalPath,
      workspaceIdentity,
    }),
    refreshTimelineTasks({
      sessionId,
      workspacePath: canonicalPath,
      workspaceIdentity,
    }),
  ]);
}

export function useRemoteWorkspaceHistory({
  intl,
  services,
  platform,
  supportsSettings,
  allowRemoteWorkspace = true,
  ensureConversationWorkspaceOnRestore = false,
  deferInactiveWorkspaceRestore = false,
  unavailableWorkspacePath,
  tabStoreApi,
  activateTabByPath,
  addTab,
  onWorkspaceActivated,
}: {
  intl: ReturnType<typeof import("@/i18n/IntlProvider.js").useZCodeIntl>["intl"];
  services: IServiceAccessor;
  platform: IPlatformService;
  supportsSettings: boolean;
  allowRemoteWorkspace?: boolean;
  ensureConversationWorkspaceOnRestore?: boolean;
  /** 仅 Desktop 主窗口：输入可用后再把 inactive workspace 加入 sidebar/task 数据源。 */
  deferInactiveWorkspaceRestore?: boolean;
  unavailableWorkspacePath?: string;
  tabStoreApi: ReturnType<typeof import("@/store/TabStoreProvider.js").useTabStoreApi>;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  addTab: (
    workspacePath: string,
    options?: {
      remoteSessionId?: string;
      remoteTarget?: Parameters<IPlatformService["connectRemote"]>[0];
      workspaceIdentity?: string;
      localWorkspacePath?: string;
    },
  ) => void;
  onWorkspaceActivated?: (target: { workspacePath: string; workspaceIdentity: string }) => void;
}) {
  const showRemoteConnectionEntry = useRemoteConnectionEntryVisibility();
  const canUseRemoteWorkspace = allowRemoteWorkspace && showRemoteConnectionEntry;
  const allowRemoteWorkspaceRestore = canUseRemoteWorkspace;
  const [remoteWorkspaceSessions, setRemoteWorkspaceSessions] = useState<
    RemoteWorkspaceSessionEntry[]
  >([]);
  const remoteWorkspaceSessionsRef = useRef<RemoteWorkspaceSessionEntry[]>([]);
  const [reconnectingRemoteWorkspaceKeys, setReconnectingRemoteWorkspaceKeys] = useState<string[]>(
    [],
  );
  const inflightReconnectWorkspaceKeysRef = useRef<Set<string>>(new Set());
  const pendingReconnectRequestIdsRef = useRef<Map<string, string>>(new Map());
  const pendingConnectionTargetsBySessionIdRef = useRef<
    Map<string, Parameters<IPlatformService["connectRemote"]>[0]>
  >(new Map());
  // 上一个版本这里有一个启动重连尝试用的 useRef。
  // 移除自动重连逻辑后，Vite Fast Refresh 会复用旧 fiber 的 hook slot，
  // 导致下一层 useReconnectingRemoteWorkspaceLogs 里的 useState 落到旧 useRef slot 上并触发 React "Should have a queue"。
  // 保留一个空 ref 只用于稳定热更新中的 hook 顺序，不恢复任何启动重连行为。
  const remoteStartupReconnectRefreshCompatibilityRef = useRef<null>(null);
  void remoteStartupReconnectRefreshCompatibilityRef;
  const {
    logsByWorkspaceKey: reconnectingRemoteWorkspaceLogsByWorkspaceKey,
    resetLogsForWorkspaceKey,
  } = useReconnectingRemoteWorkspaceLogs({
    platform,
    reconnectingWorkspaceKeys: reconnectingRemoteWorkspaceKeys,
    resolveWorkspaceTargetByKey: (workspaceKey) =>
      remoteWorkspaceSessionsRef.current.find(
        (entry) => buildWorkspaceSessionKey(entry) === workspaceKey,
      )?.target ?? null,
    resolveWorkspaceRequestIdByKey: (workspaceKey) =>
      pendingReconnectRequestIdsRef.current.get(workspaceKey) ?? null,
  });

  const syncPersistedWorkspaceSession = useCallback(
    async (nextRemoteSessions: readonly RemoteWorkspaceSessionEntry[]) => {
      setRemoteWorkspaceSessions([...nextRemoteSessions]);
      remoteWorkspaceSessionsRef.current = [...nextRemoteSessions];

      if (!supportsSettings) {
        return;
      }

      await services.settingService.update(
        buildRemoteWorkspacePersistPatch(tabStoreApi.getState(), nextRemoteSessions),
      );
    },
    [services.settingService, supportsSettings, tabStoreApi],
  );

  const commitRemoteWorkspaceSessionMutation = useCallback(
    async (mutation: ReturnType<typeof buildRemoteWorkspaceSessionMutation>) => {
      for (const credentialKey of mutation.credentialKeysToDelete) {
        try {
          await services.credentialService.delete(credentialKey);
        } catch (error) {
          logger.warn("[Root] 删除远程 workspace 凭据失败", {
            credentialKey,
            error,
          });
        }
      }

      for (const credential of mutation.credentialsToSave) {
        await services.credentialService.save(credential.key, credential.value);
      }

      await syncPersistedWorkspaceSession(mutation.nextRemoteSessions);
      return mutation.entry;
    },
    [services.credentialService, syncPersistedWorkspaceSession],
  );

  const waitForRemoteWorkspaceSessionReady = useCallback(async (sessionId: string) => {
    if (getRemoteWorkspaceSession(sessionId)) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const startedAt = Date.now();
      const pollTimer = window.setInterval(() => {
        if (getRemoteWorkspaceSession(sessionId)) {
          window.clearInterval(pollTimer);
          resolve();
          return;
        }

        if (Date.now() - startedAt >= 3000) {
          window.clearInterval(pollTimer);
          reject(new Error(`等待远程 workspace session 就绪超时: ${sessionId}`));
        }
      }, 50);
    });
  }, []);

  const connectRemoteWorkspaceTarget = useCallback(
    async (
      target: Parameters<IPlatformService["connectRemote"]>[0],
      requestId?: string,
      context?: Parameters<IPlatformService["connectRemote"]>[2],
    ) => {
      const result = await platform.connectRemote(target, requestId, context);
      if (!result.success) {
        throw new Error(getErrorMessage(result.error || "Connection failed"));
      }

      if (!result.sessionId) {
        throw new Error("Remote session was not created");
      }

      // 远程连接成功只代表 main/host 已经建好 session，
      // renderer 侧的 MessagePort 仍然可能在下一拍才注册进 zustand store。
      // 如果此时立刻 addTab，会短暂走到本地 services，导致首屏读目录/预热 ZCode Agent 命中错误服务。
      // 这里等 session 真正挂进 store 再继续。
      await waitForRemoteWorkspaceSessionReady(result.sessionId);
      if (!context) {
        // 共享 Host 只向 renderer store 回传脱敏 target；完整凭据只在选目录流程完成前临时保留。
        pendingConnectionTargetsBySessionIdRef.current.set(result.sessionId, target);
      }
      return result.sessionId;
    },
    [platform, waitForRemoteWorkspaceSessionReady],
  );

  const resolveRemoteWorkspaceCanonicalPath = useCallback(
    async (sessionId: string, workspacePath: string): Promise<string> => {
      const remoteSession = getRemoteWorkspaceSession(sessionId);
      if (!remoteSession) {
        return workspacePath;
      }

      try {
        // 同一目录可能通过符号链接别名输入（例如 /dev 与 /home/dev），
        // 之前直接持久化用户输入会把同一 workspace 识别成两个身份。
        // 这里在远端 host 上做一次 realpath 归一化，再参与 identity 计算与持久化。
        return await remoteSession.services.fileService.resolvePath({
          path: workspacePath,
        });
      } catch {
        return workspacePath;
      }
    },
    [],
  );

  const buildPersistedTabPatch = useCallback(
    (state: TabStoreState) =>
      buildRemoteWorkspacePersistPatch(state, remoteWorkspaceSessionsRef.current),
    [],
  );

  const handleCancelRemoteProject = useCallback(
    async (sessionId: string) => {
      try {
        await platform.disposeRemoteSession(sessionId);
      } finally {
        pendingConnectionTargetsBySessionIdRef.current.delete(sessionId);
        // 远程目录选择如果在确认前就取消，session 释放失败也不能把前端状态卡在“仍有一个待选远程 session”。
        // 这里始终清掉本地映射，避免下次再次打开弹窗时复用到一条已经失效的 session 记录。
        unregisterRemoteWorkspaceSession(sessionId);
      }
    },
    [platform],
  );

  const bindRemoteWorkspaceSessionContext = useCallback<BindRemoteWorkspaceSessionContextFn>(
    async ({ sessionId, workspacePath, workspaceIdentity }) => {
      // bind 会换代同一 remoteSessionId 的 renderer attachment；
      // 复用 bindRemoteWorkspaceContextAndGetSession 等 ready ACK 后再返回，之后按 sessionId 读取的才是新代 services。
      await bindRemoteWorkspaceContextAndGetSession({
        platform,
        sessionId,
        workspacePath,
        workspaceIdentity,
      });
    },
    [platform],
  );

  const runReconnectRemoteWorkspaceEntry = useCallback(
    async (
      sessionEntry: RemoteWorkspaceSessionEntry,
      options?: ReconnectRemoteWorkspaceOptions,
    ): Promise<boolean> => {
      const workspaceKey = buildWorkspaceSessionKey(sessionEntry);
      if (inflightReconnectWorkspaceKeysRef.current.has(workspaceKey)) {
        return false;
      }
      const workspaceTab = tabStoreApi
        .getState()
        .tabs.find(
          (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
            isWorkspaceTab(tab) && buildWorkspaceSessionKey(tab) === workspaceKey,
        );
      if (!workspaceTab || workspaceTab.remoteSessionId) {
        return false;
      }

      resetLogsForWorkspaceKey(workspaceKey);
      inflightReconnectWorkspaceKeysRef.current.add(workspaceKey);
      const requestId = createUuid();
      pendingReconnectRequestIdsRef.current.set(workspaceKey, requestId);
      try {
        // 重连期间只静默回填 ready 的 remoteSessionId；激活统一由 reconnect helper
        // 在回填之后执行，避免 active tab 暴露 remote-waiting 中间态。
        const upsertWorkspaceTab = tabStoreApi.getState().ensureWorkspaceTab;
        logger.debug("[Root] 远程 workspace 重连中，保留当前 conversation", {
          workspaceKey,
        });
        await reconnectRemoteWorkspaceHistoryEntry({
          sessionEntry,
          activateTabByPath,
          setReconnectingRemoteWorkspaceKeys,
          loadCredential: services.credentialService.load,
          connectRemoteWorkspaceTarget,
          resolveRemoteWorkspaceCanonicalPath,
          disposeRemoteWorkspaceSession: handleCancelRemoteProject,
          bindRemoteWorkspaceSessionContext,
          bindRemoteWorkspacePath,
          bindRemoteWorkspaceIdentity,
          upsertWorkspaceTab,
          commitRemoteWorkspaceSessionMutation,
          getRemoteSessions: () => remoteWorkspaceSessionsRef.current,
          logger,
          toast,
          shouldKeepReconnectedWorkspace: ({ workspacePath, workspaceIdentity }) =>
            shouldKeepRemoteWorkspaceInTabs({
              tabStoreApi,
              workspacePath,
              workspaceIdentity,
            }),
          onWorkspaceActivated: (target) => {
            logger.debug("[Root] 远程 workspace ready，提交 tab 与 draft 激活", target);
            onWorkspaceActivated?.(target);
          },
          options: {
            ...options,
            requestId,
          },
        });
        return true;
      } finally {
        inflightReconnectWorkspaceKeysRef.current.delete(workspaceKey);
        if (pendingReconnectRequestIdsRef.current.get(workspaceKey) === requestId) {
          pendingReconnectRequestIdsRef.current.delete(workspaceKey);
        }
      }
    },
    [
      activateTabByPath,
      bindRemoteWorkspaceSessionContext,
      commitRemoteWorkspaceSessionMutation,
      connectRemoteWorkspaceTarget,
      handleCancelRemoteProject,
      onWorkspaceActivated,
      resolveRemoteWorkspaceCanonicalPath,
      resetLogsForWorkspaceKey,
      services.credentialService,
      tabStoreApi,
    ],
  );

  const runReconnectRemoteWorkspace = useCallback(
    async (
      sessionEntry: RemoteWorkspaceSessionEntry,
      options?: ReconnectRemoteWorkspaceOptions,
    ) => {
      const reconnectGroup = collectSshReconnectGroup({
        selected: sessionEntry,
        sessions: remoteWorkspaceSessionsRef.current,
        tabs: tabStoreApi.getState().tabs,
      });
      await reconnectRemoteWorkspaceGroup({
        selected: sessionEntry,
        reconnectGroup,
        reconnectEntry: runReconnectRemoteWorkspaceEntry,
        options,
      });
    },
    [runReconnectRemoteWorkspaceEntry, tabStoreApi],
  );

  useEffect(() => {
    // 这里原来是启动自动重连 effect。
    // 删除 effect 本身会让 Fast Refresh 中已挂载的 RootInner 后续 hook 全部前移，
    // 旧 effect slot 被 useCallback 复用后容易触发 React hook 队列错位。
    // 这个空 effect 只保留 hook slot；启动恢复仍只产生断开态 tab，不会发起远程连接。
    const preserveRemoteStartupReconnectEffectSlot = true;
    void preserveRemoteStartupReconnectEffectSlot;
  }, []);

  const restorePersistedSession = useCallback(
    async (settings: AppSettings) => {
      const persistedRemoteSessions = getRemoteWorkspaceSessionEntries(settings);
      setRemoteWorkspaceSessions(persistedRemoteSessions);
      remoteWorkspaceSessionsRef.current = persistedRemoteSessions;
      let conversationWorkspacePath: string | undefined;
      if (ensureConversationWorkspaceOnRestore) {
        try {
          conversationWorkspacePath = (await services.fileService.ensureConversationWorkspace())
            .path;
        } catch (error) {
          // 路径创建失败不能连带吞掉真实项目恢复；后续显式新建对话仍会走原有可重试错误入口。
          logger.warn("[Root] 恢复阶段解析 conversation workspace 失败", { error });
        }
      }
      // 启动恢复远程 workspace 时只还原任务列表里的断开态 tab。
      // 之前这里之后还有后台 effect 会自动发起 SSH/WSL/Docker 重连，用户只是打开应用查看任务列表也会触发远端连接和 runtime 上传。
      // 现在把重连入口收口到用户点击“重连”或从远程历史主动打开，避免启动阶段产生隐藏副作用。
      // Web 普通模式还会把 allowRemoteWorkspaceRestore 置为 false：保留 setting 里的远程快照，但不恢复 tab/不展示入口。
      const workspaceRestore = restorePersistedRemoteWorkspaceSessions({
        settings,
        tabStoreApi,
        allowRemoteWorkspaceRestore,
        unavailableWorkspacePath,
        conversationWorkspacePath,
        restoreMode: deferInactiveWorkspaceRestore ? "active-first" : "all",
      });
      return {
        ...(conversationWorkspacePath
          ? { excludedRecentProjectPaths: [conversationWorkspacePath] }
          : {}),
        ...(workspaceRestore?.deferredRestore
          ? { deferredRestore: workspaceRestore.deferredRestore }
          : {}),
      };
    },
    [
      allowRemoteWorkspaceRestore,
      deferInactiveWorkspaceRestore,
      ensureConversationWorkspaceOnRestore,
      services.fileService,
      tabStoreApi,
      unavailableWorkspacePath,
    ],
  );

  const handleSelectRemoteProject = useCallback(
    async (sessionId: string, path: string, localWorkspacePath?: string) => {
      try {
        await selectRemoteWorkspaceProjectFromDialog({
          canUseRemoteWorkspace,
          sessionId,
          path,
          localWorkspacePath,
          loadingMessage: intl.formatMessage({ id: "common.loading" }),
          getRemoteWorkspaceSession,
          connectionTarget: pendingConnectionTargetsBySessionIdRef.current.get(sessionId),
          getWorkspaceTabs: () => tabStoreApi.getState().tabs,
          resolveRemoteWorkspaceCanonicalPath,
          activateTabByPath,
          handleCancelRemoteProject,
          bindRemoteWorkspaceSessionContext,
          commitRemoteWorkspaceSessionMutation,
          getRemoteSessions: () => remoteWorkspaceSessionsRef.current,
          bindRemoteWorkspacePath,
          bindRemoteWorkspaceIdentity,
          addTab,
          onWorkspaceActivated,
          refreshPinnedTasks: refreshRemotePinnedTasksForSession,
          refreshTimelineTasks: refreshRemoteTimelineTasksForSession,
        });
      } finally {
        pendingConnectionTargetsBySessionIdRef.current.delete(sessionId);
      }
    },
    [
      activateTabByPath,
      addTab,
      bindRemoteWorkspaceSessionContext,
      tabStoreApi,
      commitRemoteWorkspaceSessionMutation,
      handleCancelRemoteProject,
      intl,
      onWorkspaceActivated,
      resolveRemoteWorkspaceCanonicalPath,
      canUseRemoteWorkspace,
    ],
  );

  const handleConnectRemote = useCallback(
    async (
      options: Parameters<IPlatformService["connectRemote"]>[0],
      requestId?: string,
      context?: Parameters<IPlatformService["connectRemote"]>[2],
    ) => {
      if (!canUseRemoteWorkspace) {
        throw new Error("Remote workspace is disabled in this mode");
      }

      return connectRemoteWorkspaceTarget(options, requestId, context);
    },
    [canUseRemoteWorkspace, connectRemoteWorkspaceTarget],
  );

  const handleReconnectRemoteWorkspace = useCallback(
    async (workspaceKey: string, options?: ReconnectRemoteWorkspaceOptions) => {
      await reconnectRemoteWorkspaceByKey({
        workspaceKey,
        canUseRemoteWorkspace,
        getRemoteSessions: () => remoteWorkspaceSessionsRef.current,
        runReconnectRemoteWorkspace,
        options: {
          activateWorkspaceAfterReconnect: true,
          showErrorToast: true,
          throwOnFailure: false,
          ...options,
        },
      });
    },
    [canUseRemoteWorkspace, runReconnectRemoteWorkspace],
  );

  const handleOpenRemoteWorkspaceFromHistory = useCallback(
    async (workspaceKey: string) => {
      if (!canUseRemoteWorkspace) {
        return;
      }

      // 远程历史入口与侧栏重连都可能命中“重连中被用户移除”的竞态。
      // 这里抽成统一入口，确保两条路径共享相同的并发保护、保留校验与错误处理语义。
      await openRemoteWorkspaceFromHistoryEntry({
        workspaceKey,
        tabStoreApi,
        getRemoteSessions: () => remoteWorkspaceSessionsRef.current,
        inflightReconnectWorkspaceKeys: inflightReconnectWorkspaceKeysRef.current,
        activateTabByPath,
        setReconnectingRemoteWorkspaceKeys,
        loadCredential: services.credentialService.load,
        connectRemoteWorkspaceTarget,
        resolveRemoteWorkspaceCanonicalPath,
        disposeRemoteWorkspaceSession: handleCancelRemoteProject,
        bindRemoteWorkspaceSessionContext,
        addTab,
        commitRemoteWorkspaceSessionMutation,
        createReconnectRequestId: createUuid,
        pendingReconnectRequestIds: pendingReconnectRequestIdsRef.current,
        resetLogsForWorkspaceKey,
        onWorkspaceActivated,
      });
    },
    [
      activateTabByPath,
      addTab,
      bindRemoteWorkspaceSessionContext,
      commitRemoteWorkspaceSessionMutation,
      connectRemoteWorkspaceTarget,
      handleCancelRemoteProject,
      resolveRemoteWorkspaceCanonicalPath,
      resetLogsForWorkspaceKey,
      onWorkspaceActivated,
      services.credentialService,
      tabStoreApi,
      canUseRemoteWorkspace,
    ],
  );

  const handleRemoteWorkspaceSessionClosed = useCallback(
    async (event: RemoteSessionClosedEvent) => {
      const sessionId = event.sessionId.trim();
      if (!sessionId) {
        return;
      }

      const matchedTabs = tabStoreApi
        .getState()
        .tabs.filter(
          (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
            isWorkspaceTab(tab) && tab.remoteSessionId === sessionId,
        );
      if (matchedTabs.length === 0) {
        unregisterRemoteWorkspaceSession(sessionId);
        return;
      }

      // 远端 host 退出后，tab 上的 remoteSessionId 之前不会被清空。
      // UI 因此持续显示“已连接”，并继续把请求路由到失效 session。
      // 这里在收到 main 进程的 session-close 事件时立即降级为断连态，后续只走用户手动重连。
      tabStoreApi.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          isWorkspaceTab(tab) && tab.remoteSessionId === sessionId
            ? { ...tab, remoteSessionId: undefined }
            : tab,
        ),
      }));
      unregisterRemoteWorkspaceSession(sessionId);

      const matchedWorkspaceKeys = [
        ...new Set(matchedTabs.map((tab) => buildWorkspaceSessionKey(tab))),
      ];
      const reason = [
        "远程连接已断开",
        event.exitCode != null ? `exitCode=${event.exitCode}` : null,
        event.signal ? `signal=${event.signal}` : null,
      ]
        .filter(Boolean)
        .join(" ");
      const zcodeSessionStore = useZCodeSessionStore.getState();
      const failedTaskCount = markRemoteWorkspaceRunningTasksFailed({
        tabs: matchedTabs,
        getWorkspaceState: zcodeSessionStore.getWorkspaceState,
        setTaskRuntimeState: zcodeSessionStore.setTaskRuntimeState,
        reason,
      });

      logger.warn("[Root] 远程 workspace session 已关闭", {
        sessionId,
        reason: event.reason,
        exitCode: event.exitCode,
        signal: event.signal,
        matchedWorkspaceKeys,
        failedTaskCount,
      });

      for (const workspaceKey of matchedWorkspaceKeys) {
        const sessionEntry = remoteWorkspaceSessionsRef.current.find(
          (entry) => buildWorkspaceSessionKey(entry) === workspaceKey,
        );
        if (!sessionEntry) {
          continue;
        }

        const pendingReconnectRequestId = pendingReconnectRequestIdsRef.current.get(workspaceKey);
        if (
          !shouldPersistRemoteWorkspaceFailure({
            pendingReconnectRequestIds: pendingReconnectRequestIdsRef.current,
            sessionEntry,
            workspaceKey,
          })
        ) {
          logger.info("[Root] WSL workspace session 关闭时跳过失败落盘，等待重连结果", {
            pendingReconnectRequestId,
            sessionId,
            workspaceIdentity: sessionEntry.workspaceIdentity ?? null,
            workspacePath: sessionEntry.workspacePath,
            workspaceKey,
          });
          continue;
        }

        await commitRemoteWorkspaceSessionMutation(
          buildRemoteWorkspaceSessionMutation({
            remoteSessions: remoteWorkspaceSessionsRef.current,
            workspacePath: sessionEntry.workspacePath,
            workspaceIdentity: sessionEntry.workspaceIdentity,
            target: createRemoteTargetFromSnapshot(sessionEntry.target, {
              password: null,
              privateKeyPassphrase: null,
            }),
            lastConnectionStatus: "failed",
            lastConnectionError: reason,
            touchOpenedAt: false,
          }),
        );
      }
    },
    [commitRemoteWorkspaceSessionMutation, tabStoreApi],
  );

  const handleBotRemoteWorkspaceReconnected = useCallback(
    async (event: BotRemoteWorkspaceReconnectedEvent) => {
      if (!canUseRemoteWorkspace) {
        return;
      }

      const sessionId = event.sessionId.trim();
      if (!sessionId) {
        return;
      }

      try {
        await waitForRemoteWorkspaceSessionReady(sessionId);
        const remoteSession = getRemoteWorkspaceSession(sessionId);
        if (!remoteSession) {
          throw new Error(`远程 workspace session 不存在: ${sessionId}`);
        }
        if (!remoteSession.target) {
          // Bugfix: Bot 重连事件来自 main/host，必须带可持久化的 target。
          // Web relay 的桥接 session 没有 target，不能进入远程历史重连分支。
          throw new Error(`远程 workspace session 缺少连接目标: ${sessionId}`);
        }

        const resolvedWorkspacePath = await resolveRemoteWorkspaceCanonicalPath(
          sessionId,
          event.workspacePath,
        );
        const resolvedWorkspaceIdentity = resolveBotRemoteWorkspaceReconnectedIdentity({
          event,
          resolvedWorkspacePath,
          target: remoteSession.target,
        });

        bindRemoteWorkspacePath(resolvedWorkspacePath, sessionId);
        bindRemoteWorkspaceIdentity(resolvedWorkspaceIdentity, sessionId);
        // Bugfix: Bot 触发的远端重连发生在 main/host，不会经过侧栏手动重连的 React 流程。
        // 这里收到 main 的成功事件后，把已创建的 session 绑定回 tab 和远端历史，UI 才会从“未连接”变为“已连接”。
        tabStoreApi.getState().ensureWorkspaceTab(resolvedWorkspacePath, {
          remoteSessionId: sessionId,
          remoteTarget: remoteSession.target,
          workspaceIdentity: resolvedWorkspaceIdentity,
        });
        await commitRemoteWorkspaceSessionMutation(
          buildRemoteWorkspaceSessionMutation({
            remoteSessions: remoteWorkspaceSessionsRef.current,
            workspacePath: resolvedWorkspacePath,
            workspaceIdentity: resolvedWorkspaceIdentity,
            target: remoteSession.target,
            lastConnectionStatus: "connected",
            touchOpenedAt: true,
          }),
        );
        await Promise.all([
          refreshRemotePinnedTasksForSession({
            sessionId,
            workspacePath: resolvedWorkspacePath,
            workspaceIdentity: resolvedWorkspaceIdentity,
          }),
          refreshRemoteTimelineTasksForSession({
            sessionId,
            workspacePath: resolvedWorkspacePath,
            workspaceIdentity: resolvedWorkspaceIdentity,
          }),
        ]);
      } catch (error) {
        logger.warn("[Root] Bot 远端 workspace 重连成功后同步 UI 状态失败", {
          sessionId,
          workspacePath: event.workspacePath,
          workspaceIdentity: event.workspaceIdentity,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [
      canUseRemoteWorkspace,
      commitRemoteWorkspaceSessionMutation,
      resolveRemoteWorkspaceCanonicalPath,
      tabStoreApi,
      waitForRemoteWorkspaceSessionReady,
    ],
  );

  useEffect(() => {
    return platform.onRemoteSessionClosed((event) => {
      void handleRemoteWorkspaceSessionClosed(event);
    });
  }, [handleRemoteWorkspaceSessionClosed, platform]);

  useEffect(() => {
    return platform.onBotRemoteWorkspaceReconnected((event) => {
      void handleBotRemoteWorkspaceReconnected(event);
    });
  }, [handleBotRemoteWorkspaceReconnected, platform]);

  const handleRemoteWorkspaceTabsClosed = useCallback(
    (workspaceKeys: string[]) => {
      if (workspaceKeys.length === 0) {
        return;
      }

      const workspaceKeySet = new Set(workspaceKeys);

      void (async () => {
        // 关闭断连态 remote tab 时，tab 上还没有 remoteSessionId，但 main 进程可能已经在上传 remote runtime。
        // 这里用重连 requestId 精准取消 pending host，避免 UI 已移除而后台 upload 继续跑。
        await cancelPendingRemoteReconnectsForWorkspaceKeys({
          workspaceKeys,
          pendingRequestIds: pendingReconnectRequestIdsRef.current,
          cancelPendingRemoteConnection: platform.cancelPendingRemoteConnection
            ? (requestId) =>
                platform.cancelPendingRemoteConnection?.(requestId) ?? Promise.resolve()
            : undefined,
          logger,
        });
        setReconnectingRemoteWorkspaceKeys((currentKeys) =>
          currentKeys.filter((key) => !workspaceKeySet.has(key)),
        );

        const removal = removeRemoteWorkspaceSessionEntries(
          remoteWorkspaceSessionsRef.current,
          workspaceKeys,
        );
        if (
          removal.nextRemoteSessions.length === remoteWorkspaceSessionsRef.current.length &&
          removal.credentialKeysToDelete.length === 0
        ) {
          return;
        }

        // 用户在侧栏“移除”远程 workspace 后，只删 tab 不够：
        // remoteWorkspaceSessionsRef 仍被持久化补丁合并回 setting.json，
        // 所以下次启动又会恢复同一个断连项。这里把显式移除视为删除远程历史，
        // 同时清理该历史独占的 SSH 凭据，避免留下不可达的 credential key。
        await syncPersistedWorkspaceSession(removal.nextRemoteSessions);
        for (const credentialKey of removal.credentialKeysToDelete) {
          try {
            await services.credentialService.delete(credentialKey);
          } catch (error) {
            logger.warn("[Root] 删除已移除远程 workspace 凭据失败", {
              credentialKey,
              error,
            });
          }
        }
      })();
    },
    [platform, services.credentialService, syncPersistedWorkspaceSession],
  );

  const remoteWorkspaceErrorByWorkspaceKey = useMemo(
    () =>
      Object.fromEntries(
        remoteWorkspaceSessions.flatMap((entry) =>
          entry.lastConnectionError?.trim()
            ? [[buildWorkspaceSessionKey(entry), entry.lastConnectionError] as const]
            : [],
        ),
      ),
    [remoteWorkspaceSessions],
  );

  return {
    remoteWorkspaceSessions,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceErrorByWorkspaceKey,
    reconnectingRemoteWorkspaceLogsByWorkspaceKey,
    buildPersistedTabPatch,
    restorePersistedSession,
    handleCancelRemoteProject,
    handleSelectRemoteProject,
    handleConnectRemote,
    handleReconnectRemoteWorkspace,
    handleOpenRemoteWorkspaceFromHistory,
    handleRemoteWorkspaceTabsClosed,
  };
}
