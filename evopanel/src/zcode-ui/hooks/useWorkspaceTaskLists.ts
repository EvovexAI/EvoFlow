/* eslint-disable max-lines -- workspace 行任务列表需要把分片查询、缓存展示和跨端 membership 订阅保持在同一 hook 内，拆分会增加缓存一致性风险。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { ZCodeWorkspaceEvent } from "@zcode/shared";
import { logger } from "@/logger.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeSessionStore, selectWorkspaceZCodeState } from "@/store/zcodeSessionStore.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import {
  buildTaskEntityKey,
  buildTaskListCacheDescriptor,
  buildTaskListCacheKeyFromDescriptor,
  buildTaskWorkspaceKey,
} from "@/lib/taskQueryCache.js";
import {
  markTaskQueryCacheScopesStale,
  useTaskQueryCacheStore,
} from "@/store/taskQueryCacheStore.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import {
  isRemoteWorkspaceTarget,
  resolveWorkspaceRemoteSessionId,
  resolveWorkspaceServices,
} from "@/lib/workspaceServiceResolver.js";
import { useWorkspaceTaskOptimisticOverlayByWorkspaceKey } from "@/hooks/workspaceTaskListOptimisticOverlay.js";
import {
  buildWorkspaceTaskListDisplayGroups,
  type WorkspaceTaskListGroup,
} from "@/hooks/workspaceTaskListDisplayGroups.js";
import {
  buildWorkspaceRemoteSessionSignature,
  buildWorkspaceTaskListVersionSignature,
} from "@/hooks/workspaceTaskListRefreshSignatures.js";
import { shouldRefetchTaskListMembershipForWorkspaceEvent } from "@/lib/taskListRefreshPolicy.js";
import { syncTaskUnreadFromStatusWorkspaceEvent } from "@/lib/taskStatusUnreadSync.js";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { fetchTaskListMembershipSetsForEndpointsCached } from "@/lib/taskListMembershipSets.js";
import { buildTaskListResult } from "@/v4/buildTaskListResultFromSessions.js";
import {
  bumpTaskListMembershipVersionForWorkspaceEvent,
  useTaskListMembershipVersion,
} from "@/v4/taskListMembershipVersion.js";
import {
  buildWorkspaceSessionsIndexSourceKey,
  useWorkspaceSessionsIndexItems,
} from "@/v4/useWorkspaceSessionsIndexItems.js";
import { resolveWorkspaceTaskVisibleLimit } from "@/lib/workspaceTaskPagination.js";

interface WorkspaceTaskListQueryConfig {
  scope: {
    workspacePath: string;
    workspaceIdentity?: string;
  };
  workspaceKey: string;
  remoteSessionId?: string;
  isRemoteWorkspace: boolean;
  visibleLimit: number;
  descriptor: ReturnType<typeof buildTaskListCacheDescriptor>;
  queryKey: string;
}

interface WorkspaceTaskListEndpointShard {
  shardKey: string;
  services: IServiceAccessor;
  configs: WorkspaceTaskListQueryConfig[];
}

interface WorkspaceTaskListGroupResult {
  workspacePath: string;
  workspaceIdentity?: string;
  items: ZCodeTaskMeta[];
  total: number;
  hasMore: boolean;
  unreadTaskKeys: string[];
}

interface WorkspaceTaskListRefreshFlight {
  requestId: number;
  signature: string;
  activityRevision: string;
  membershipVersion: number;
}

function updateBlockingLoadingState(
  current: Record<string, boolean>,
  blockingWorkspaceKeys: string[],
): Record<string, boolean> {
  const uniqueKeys = [...new Set(blockingWorkspaceKeys)];
  const currentKeys = Object.keys(current);
  if (
    currentKeys.length === uniqueKeys.length &&
    uniqueKeys.every((workspaceKey) => current[workspaceKey] === true)
  ) {
    return current;
  }
  return Object.fromEntries(uniqueKeys.map((workspaceKey) => [workspaceKey, true]));
}

// workspace 分组结果以 tasks-index task rows 为持久行，sessions-index 只补 activity/detail。
// remote shard 使用自己的 endpoint task service，返回与旧协议同形的 group map。
async function buildWorkspaceGroupsFromSessions(params: {
  service: IServiceAccessor["zcodeTaskService"];
  scopes: Array<{ workspacePath: string; workspaceIdentity?: string }>;
  sessions: ZCodeTaskMeta[];
  sortBy: "created" | "updated";
  /** 差量更新：membership 只随 membershipVersion 变化，按版本缓存避免每次内容帧都重拉。 */
  membershipCacheKey: string;
}): Promise<Map<string, WorkspaceTaskListGroupResult>> {
  const {
    taskIndexItems,
    pinnedIds,
    archivedIds,
    deletedIds,
    unreadAtByTaskId,
    terminalStatusByTaskId,
    titleOverrideByTaskId,
    cronAutomationIdByTaskId,
  } = await fetchTaskListMembershipSetsForEndpointsCached({
    cacheKey: params.membershipCacheKey,
    endpoints: [{ service: params.service, scopes: params.scopes }],
  });
  const map = new Map<string, WorkspaceTaskListGroupResult>();
  for (const scope of params.scopes) {
    const scopeKey = buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity);
    const scopeSessions = params.sessions.filter(
      (task) => buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity) === scopeKey,
    );
    const scopeTaskIndexItems = taskIndexItems.filter(
      (task) => buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity) === scopeKey,
    );
    // "workspace" 视图规则 = !pinned && !archived，与 "timeline" 同（matchesTaskMembership）。
    const result = buildTaskListResult({
      taskIndexItems: scopeTaskIndexItems,
      sessions: scopeSessions,
      kind: "timeline",
      pinnedIds,
      archivedIds,
      deletedIds,
      unreadAtByTaskId,
      terminalStatusByTaskId,
      titleOverrideByTaskId,
      cronAutomationIdByTaskId,
      sortBy: params.sortBy,
    });
    map.set(scopeKey, {
      workspacePath: scope.workspacePath,
      ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      items: result.items,
      total: result.total,
      hasMore: false,
      // workspace task 会先分页再进入 query cache；若只检查可见 items，
      // 收起行会漏掉分页窗口之外的未读。这里在完整 regular-task 结果上先固化成员 key。
      unreadTaskKeys: result.items
        .filter((task) => typeof task.unreadAt === "number")
        .map((task) => buildTaskEntityKey(task)),
    });
  }
  return map;
}

/**
 * 依赖 sessions-index 聚合层的引用稳定化：条目引用不变 = 内容等价。
 * 前后两轮 items 里引用有出入的条目所属的 workspace 才算"有变化"。
 */
function diffChangedWorkspaceKeys(previous: ZCodeTaskMeta[], next: ZCodeTaskMeta[]): Set<string> {
  const changed = new Set<string>();
  const previousSet = new Set(previous);
  const nextSet = new Set(next);
  for (const item of next) {
    if (!previousSet.has(item)) {
      changed.add(buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity));
    }
  }
  for (const item of previous) {
    if (!nextSet.has(item)) {
      changed.add(buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity));
    }
  }
  return changed;
}

function buildWorkspaceEventSubscriptionSignature(
  shards: WorkspaceTaskListEndpointShard[],
): string {
  return shards
    .map((shard) => {
      const workspaceKeys = [...new Set(shard.configs.map((config) => config.workspaceKey))].sort(
        (left, right) => left.localeCompare(right),
      );
      return `${shard.shardKey}:${workspaceKeys.join("|")}`;
    })
    .join("||");
}

export function useWorkspaceTaskLists(params: {
  workspaceTabs: WorkspaceTabState[];
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  sortBy: "created" | "updated";
  visibleLimitByWorkspaceKey: Readonly<Record<string, number>>;
  defaultVisibleLimit: number;
}) {
  const baseServices = useBaseWorkspaceServices();
  const sessionsById = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const sessionIdByWorkspaceIdentity = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspaceIdentity,
  );
  const sessionIdByWorkspacePath = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspacePath,
  );
  const serviceResolverState = useMemo(
    () => ({
      sessionsById,
      sessionIdByWorkspaceIdentity,
      sessionIdByWorkspacePath,
    }),
    [sessionIdByWorkspaceIdentity, sessionIdByWorkspacePath, sessionsById],
  );
  const setQueryResults = useTaskQueryCacheStore((state) => state.setQueryResults);
  const resultsByQueryKey = useTaskQueryCacheStore((state) => state.resultsByQueryKey);
  const taskMetaByEntityKey = useTaskQueryCacheStore((state) => state.taskMetaByEntityKey);
  const taskUnreadOverlayByEntityKey = useTaskQueryCacheStore(
    (state) => state.taskUnreadOverlayByEntityKey,
  );
  const inFlightRequestRef = useRef<WorkspaceTaskListRefreshFlight | null>(null);
  const nextRequestIdRef = useRef(0);
  const rerunRequestedRef = useRef(false);
  const groupCacheRef = useRef<Map<string, WorkspaceTaskListGroup>>(new Map());
  const taskListVersionSignature = useZCodeSessionStore((state) =>
    buildWorkspaceTaskListVersionSignature(
      params.workspaceTabs.map((tab) => {
        const workspaceKey = buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity);
        const workspaceState = selectWorkspaceZCodeState(
          state,
          tab.workspacePath,
          tab.workspaceIdentity,
        );
        return [workspaceKey, workspaceState.taskListVersion] as const;
      }),
    ),
  );
  const optimisticTaskOverlayByWorkspaceKey = useWorkspaceTaskOptimisticOverlayByWorkspaceKey(
    params.workspaceTabs,
  );
  const taskListVersionByWorkspaceKey = useMemo(
    () => new Map<string, number>(JSON.parse(taskListVersionSignature) as Array<[string, number]>),
    [taskListVersionSignature],
  );
  const remoteSessionSignature = useMemo(
    () =>
      buildWorkspaceRemoteSessionSignature(
        params.workspaceTabs.map((tab) => {
          const workspaceKey = buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity);
          const resolvedRemoteSessionId = resolveWorkspaceRemoteSessionId(
            tab,
            serviceResolverState,
          );
          return {
            workspaceKey,
            remoteSessionId: resolvedRemoteSessionId,
            ready: resolvedRemoteSessionId ? Boolean(sessionsById[resolvedRemoteSessionId]) : true,
          };
        }),
      ),
    [params.workspaceTabs, serviceResolverState, sessionsById],
  );
  const activeWorkspaceKey = useMemo(
    () => buildTaskWorkspaceKey(params.activeWorkspacePath, params.activeWorkspaceIdentity),
    [params.activeWorkspaceIdentity, params.activeWorkspacePath],
  );
  const activeWorkspaceRef = useRef({
    workspacePath: params.activeWorkspacePath,
    ...(params.activeWorkspaceIdentity
      ? { workspaceIdentity: params.activeWorkspaceIdentity }
      : {}),
  });
  // 切换 workspace 时，旧 workspace 会保留自己的 activeTaskId；终态订阅又按
  // endpoint/workspace 集合长期复用。回调若只看旧 workspace 的 activeTaskId，或捕获首次 render
  // 的全局焦点，就会把已经退到后台的 task 误判成“仍在阅读”，从而漏掉未读标识。
  activeWorkspaceRef.current = {
    workspacePath: params.activeWorkspacePath,
    ...(params.activeWorkspaceIdentity
      ? { workspaceIdentity: params.activeWorkspaceIdentity }
      : {}),
  };
  const queryConfigs = useMemo(
    () =>
      params.workspaceTabs.map((tab) => {
        const scope = {
          workspacePath: tab.workspacePath,
          workspaceIdentity: tab.workspaceIdentity,
        };
        const resolvedRemoteSessionId = resolveWorkspaceRemoteSessionId(tab, serviceResolverState);
        const isRemoteWorkspace = isRemoteWorkspaceTarget(tab, resolvedRemoteSessionId);
        const workspaceKey = buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity);
        const visibleLimit = resolveWorkspaceTaskVisibleLimit(
          params.visibleLimitByWorkspaceKey,
          workspaceKey,
          params.defaultVisibleLimit,
        );
        const descriptor = buildTaskListCacheDescriptor({
          kind: "workspace",
          workspaceScopes: [scope],
          sortBy: params.sortBy,
          search: "",
          expanded: false,
          visibleLimit,
        });
        return {
          scope,
          workspaceKey,
          remoteSessionId: resolvedRemoteSessionId,
          isRemoteWorkspace,
          visibleLimit,
          descriptor,
          // 之前每个 workspace 分组的 queryKey 都拼上“所有 tabs 的版本签名”。
          // archive 一个本地 task 后，其它 workspace 的 queryKey 也会同时换新，旧缓存瞬间失效，
          // 连接远端时刷新更慢，就会看到所有本地 workspace 变成 No tasks yet。
          // 这里改成只使用当前 workspace 自己的版本，避免无关 workspace 被连带清空。
          queryKey:
            buildTaskListCacheKeyFromDescriptor(descriptor) +
            `::version=${taskListVersionByWorkspaceKey.get(workspaceKey) ?? 0}`,
        };
      }),
    [
      params.defaultVisibleLimit,
      params.sortBy,
      params.visibleLimitByWorkspaceKey,
      params.workspaceTabs,
      serviceResolverState,
      taskListVersionByWorkspaceKey,
    ],
  );
  const endpointShards = useMemo(() => {
    const shardMap = new Map<
      string,
      {
        services: IServiceAccessor;
        configs: WorkspaceTaskListQueryConfig[];
      }
    >();

    for (const config of queryConfigs) {
      const resolvedServices = resolveWorkspaceServices(
        {
          ...config.scope,
          remoteSessionId: config.remoteSessionId,
        },
        baseServices,
        serviceResolverState,
      );
      if (!resolvedServices) {
        continue;
      }

      const shardKey = resolvedServices.remoteSessionId ?? "__base__";

      const shard = shardMap.get(shardKey) ?? {
        services: resolvedServices.services,
        configs: [],
      };
      shard.configs.push(config);
      shardMap.set(shardKey, shard);
    }

    return [...shardMap.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map<WorkspaceTaskListEndpointShard>(([shardKey, shard]) => ({
        shardKey,
        services: shard.services,
        configs: shard.configs,
      }));
  }, [baseServices, queryConfigs, serviceResolverState]);
  const endpointShardsRef = useRef(endpointShards);
  endpointShardsRef.current = endpointShards;
  const workspaceEventSubscriptionSignature = useMemo(
    () => buildWorkspaceEventSubscriptionSignature(endpointShards),
    [endpointShards],
  );
  // 列表数据源 = sessions-index。remote shard（web/手机远控/SSH workspace）
  // 也走 sessions-index——scope 携带 endpoint 维度与该 endpoint 的 agentService proxy；
  // 尚未解析到远端 session 的 tab（断连占位）不在 endpointShards 内，等重连后自动补订阅。
  const sessionsIndexScopes = useMemo(
    () =>
      endpointShards.flatMap((shard) =>
        shard.configs.map((config) => ({
          workspacePath: config.scope.workspacePath,
          ...(config.scope.workspaceIdentity
            ? { workspaceIdentity: config.scope.workspaceIdentity }
            : {}),
          ...(shard.shardKey === "__base__" ? {} : { endpointKey: shard.shardKey }),
          agentService: shard.services.zcodeAgentService,
        })),
      ),
    [endpointShards],
  );
  const { items: sessionsIndexItems, sourceRevisionByScopeKey } =
    useWorkspaceSessionsIndexItems(sessionsIndexScopes);
  // pin/archive 归属版本：mutation（本端乐观或它端事件）后 bump，驱动权威 re-filter。
  const membershipVersion = useTaskListMembershipVersion();
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const pendingConfigs = useMemo(() => {
    const pending = queryConfigs.filter((config) => {
      const cachedResult = resultsByQueryKey[config.queryKey];
      return cachedResult == null || cachedResult.stale;
    });
    const activePending = pending.filter((config) => config.workspaceKey === activeWorkspaceKey);
    if (activePending.length > 0) {
      // 冷启动时若一次性查询所有历史 workspace，会和当前 workspace 的模型 readState 抢资源，
      // 导致输入框底部持续显示“管理模型/加载中”。这里先保证当前 workspace 的任务列表和模型状态完成，
      // 其他 workspace 等当前缓存落盘后再后台补齐。
      return activePending;
    }
    return pending;
  }, [activeWorkspaceKey, queryConfigs, resultsByQueryKey]);
  const sessionsIndexRevision = useMemo(
    () =>
      pendingConfigs
        .map((config) => {
          const sourceKey = buildWorkspaceSessionsIndexSourceKey({
            workspacePath: config.scope.workspacePath,
            ...(config.scope.workspaceIdentity
              ? { workspaceIdentity: config.scope.workspaceIdentity }
              : {}),
            ...(config.remoteSessionId ? { endpointKey: config.remoteSessionId } : {}),
          });
          return `${sourceKey}=${sourceRevisionByScopeKey[sourceKey] ?? "missing"}`;
        })
        .sort()
        .join("|"),
    [pendingConfigs, sourceRevisionByScopeKey],
  );
  const requestSignature = useMemo(
    () =>
      [
        params.sortBy,
        taskListVersionSignature,
        remoteSessionSignature,
        `activity=${sessionsIndexRevision}`,
        `membership=${membershipVersion}`,
        ...pendingConfigs.map(
          (config) =>
            `${config.workspaceKey}:${config.remoteSessionId ?? "base"}:limit=${config.visibleLimit}:${config.queryKey}:invalidation=${resultsByQueryKey[config.queryKey]?.invalidationVersion ?? 0}`,
        ),
      ].join("||"),
    [
      membershipVersion,
      pendingConfigs,
      params.sortBy,
      remoteSessionSignature,
      resultsByQueryKey,
      sessionsIndexRevision,
      taskListVersionSignature,
    ],
  );
  const latestRefreshInputRef = useRef({
    requestSignature,
    sessionsIndexRevision,
    membershipVersion,
  });
  latestRefreshInputRef.current = {
    requestSignature,
    sessionsIndexRevision,
    membershipVersion,
  };

  const refresh = useCallback(async () => {
    if (pendingConfigs.length === 0) {
      if (inFlightRequestRef.current === null) {
        setLoading((current) => updateBlockingLoadingState(current, []));
      }
      return;
    }

    const currentFlight = inFlightRequestRef.current;
    if (currentFlight) {
      if (currentFlight.signature !== requestSignature) {
        // 相同列表查询的 membership RPC 在途时，sessions-index 仍可能从
        // running 收敛到 completed/error。只按 query signature single-flight 时，
        // 第二次失效被吞掉；这里记录最新输入到达，当前 flight 收口后必须再跑一轮。
        rerunRequestedRef.current = true;
      }
      return;
    }

    const requestId = ++nextRequestIdRef.current;
    const flight: WorkspaceTaskListRefreshFlight = {
      requestId,
      signature: requestSignature,
      activityRevision: sessionsIndexRevision,
      membershipVersion,
    };
    inFlightRequestRef.current = flight;
    const sessionsForRequest = sessionsIndexItems;
    const expectedInvalidationVersionByQueryKey = new Map(
      pendingConfigs.map((config) => [
        config.queryKey,
        resultsByQueryKey[config.queryKey]?.invalidationVersion ?? 0,
      ]),
    );
    // sessions-index 的状态/标题变化会把已有 query 标为 stale 并后台重算。
    // stale 结果仍然能安全展示；如果这里也置 loading，点击/恢复历史任务就会让整条 workspace 行
    // 跟着切换 loading prop，再叠加硬失效时会直接闪成“正在获取任务”。只有完全没有缓存的
    // 首次 hydration 才是 blocking loading，已有缓存统一走 stale-while-revalidate。
    const blockingWorkspaceKeys = pendingConfigs
      .filter((config) => {
        if (resultsByQueryKey[config.queryKey] != null) {
          return false;
        }
        const previousGroup = groupCacheRef.current.get(config.workspaceKey);
        return !previousGroup || (previousGroup.items.length === 0 && previousGroup.total === 0);
      })
      .map((config) => config.workspaceKey);
    setLoading((current) => updateBlockingLoadingState(current, blockingWorkspaceKeys));

    try {
      const pendingConfigKeys = new Set(pendingConfigs.map((config) => config.queryKey));
      const entries = (
        await Promise.all(
          endpointShards.map(async (shard) => {
            const shardConfigs = shard.configs.filter((config) =>
              pendingConfigKeys.has(config.queryKey),
            );
            if (shardConfigs.length === 0) {
              return [];
            }

            // 本机和 remote shard 都以各自 endpoint 的 tasks-index 行为集合，
            // 再用同 endpoint/workspace 的 sessions-index activity/detail enrich。
            const groupByWorkspaceKey = await buildWorkspaceGroupsFromSessions({
              service: shard.services.zcodeTaskService,
              scopes: shardConfigs.map((config) => config.scope),
              sessions: sessionsForRequest,
              sortBy: params.sortBy,
              membershipCacheKey: `${membershipVersion}::workspace::${shard.shardKey}::${shardConfigs
                .map((config) => `${config.workspaceKey}@${taskListVersionSignature}`)
                .join("|")}`,
            });

            return shardConfigs.map((config) => {
              const group = groupByWorkspaceKey.get(config.workspaceKey) ?? {
                workspacePath: config.scope.workspacePath,
                workspaceIdentity: config.scope.workspaceIdentity,
                items: [],
                total: 0,
                hasMore: false,
                unreadTaskKeys: [],
              };
              const visibleItems = group.items.slice(0, config.visibleLimit);
              return {
                queryKey: config.queryKey,
                descriptor: config.descriptor,
                items: visibleItems,
                total: group.total,
                hasMore: group.total > visibleItems.length,
                unreadTaskKeys: group.unreadTaskKeys,
                expectedInvalidationVersion: expectedInvalidationVersionByQueryKey.get(
                  config.queryKey,
                ),
              };
            });
          }),
        )
      ).flat();

      // 之前每个 workspace queryKey 都单独 set 一次 cache，
      // effect 又依赖整个 resultsByQueryKey，导致“刚写入第一组结果就判定还有缺失，再触发下一轮 refresh”。
      // 这里改成一次批量写入，保证同一轮查询只产生一次 store 更新，切断连环刷新。
      // 远端 workspace 的任务索引在远端 sqlite，不能用 base services 查询本地 sqlite。
      // 这里按 remoteSessionId 分片请求；远端 session 尚未注册时不写空缓存，等 session 到位后自动重查。
      const latestInput = latestRefreshInputRef.current;
      const canCommit =
        inFlightRequestRef.current?.requestId === requestId &&
        latestInput.requestSignature === flight.signature &&
        latestInput.sessionsIndexRevision === flight.activityRevision &&
        latestInput.membershipVersion === flight.membershipVersion;
      if (entries.length > 0 && canCommit) {
        setQueryResults(entries);
      } else if (!canCommit) {
        // 旧 activity/membership 结果禁止写 entity cache 或清 stale；由 finally 触发最新轮。
        rerunRequestedRef.current = true;
      }
    } catch (error) {
      logger.error("[useWorkspaceTaskLists] 加载 workspace task 列表失败", error);
    } finally {
      if (inFlightRequestRef.current?.requestId === requestId) {
        inFlightRequestRef.current = null;
        setLoading((current) => updateBlockingLoadingState(current, []));
        const latestInput = latestRefreshInputRef.current;
        const shouldRerun =
          rerunRequestedRef.current ||
          latestInput.requestSignature !== flight.signature ||
          latestInput.sessionsIndexRevision !== flight.activityRevision ||
          latestInput.membershipVersion !== flight.membershipVersion;
        rerunRequestedRef.current = false;
        if (shouldRerun) {
          setRefreshTrigger((generation) => generation + 1);
        }
      }
    }
  }, [
    endpointShards,
    membershipVersion,
    pendingConfigs,
    params.sortBy,
    requestSignature,
    resultsByQueryKey,
    sessionsIndexItems,
    sessionsIndexRevision,
    setQueryResults,
  ]);
  useEffect(() => {
    if (pendingConfigs.length === 0) {
      return;
    }

    void refresh();
  }, [pendingConfigs.length, refresh, refreshTrigger, requestSignature]);

  // sessions-index 列表变化 / pin-archive 归属版本变化 → 标脏本地 scope 缓存，
  // 触发上面的 refresh 用新数据重算。sessions-index 是 conflated 低频列表事件，非高频 snapshot。
  // 防环：cache 标脏会引发 re-render，若父组件每次渲染重建 workspaceTabs 数组，
  // scope 数组身份会跟着换新；这里只认「items 引用 / 归属版本」的真实变化，避免 setState 死循环。
  const lastSessionsRefreshRef = useRef<{
    items: ZCodeTaskMeta[];
    membershipVersion: number;
  } | null>(null);
  useEffect(() => {
    if (sessionsIndexScopes.length === 0) {
      return;
    }
    const last = lastSessionsRefreshRef.current;
    if (last && last.items === sessionsIndexItems && last.membershipVersion === membershipVersion) {
      return;
    }
    const membershipChanged = !last || last.membershipVersion !== membershipVersion;
    const previousItems = last?.items ?? null;
    lastSessionsRefreshRef.current = {
      items: sessionsIndexItems,
      membershipVersion,
    };
    if (membershipChanged || previousItems === null) {
      markTaskQueryCacheScopesStale(sessionsIndexScopes);
      return;
    }
    // sessions-index 聚合层已做引用稳定化——条目引用不变即内容等价。
    // 之前任一帧到达都把所有 workspace 的行缓存整体打成 stale 重查，
    // 表现为"打开/收口一个任务，左侧所有 workspace 列表一起重新加载"。
    // 这里 diff 出真正有变化的 workspace，只标脏对应 scope。
    const changedWorkspaceKeys = diffChangedWorkspaceKeys(previousItems, sessionsIndexItems);
    if (changedWorkspaceKeys.size === 0) {
      return;
    }
    const changedScopes = sessionsIndexScopes.filter((scope) =>
      changedWorkspaceKeys.has(buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity)),
    );
    if (changedScopes.length > 0) {
      markTaskQueryCacheScopesStale(changedScopes);
    }
  }, [sessionsIndexItems, membershipVersion, sessionsIndexScopes]);

  useEffect(() => {
    const subscribedEndpointShards = endpointShardsRef.current;
    if (subscribedEndpointShards.length === 0) {
      return;
    }

    const disposables: Array<{ dispose(): void }> = [];
    for (const shard of subscribedEndpointShards) {
      const configByWorkspaceKey = new Map(
        shard.configs.map((config) => [config.workspaceKey, config]),
      );

      for (const config of configByWorkspaceKey.values()) {
        const disposable = shard.services.zcodeTaskService.onDynamicWorkspaceEvent({
          workspacePath: config.scope.workspacePath,
          ...(config.scope.workspaceIdentity
            ? { workspaceIdentity: config.scope.workspaceIdentity }
            : {}),
        })((event: ZCodeWorkspaceEvent) => {
          if (event.type !== "workspace_task_list_changed") {
            return;
          }
          const eventWorkspaceKey = buildTaskWorkspaceKey(
            event.workspacePath,
            event.workspaceIdentity,
          );
          if (eventWorkspaceKey !== config.workspaceKey) {
            return;
          }
          syncTaskUnreadFromStatusWorkspaceEvent({
            activeWorkspace: activeWorkspaceRef.current,
            event,
            service: shard.services.zcodeTaskService,
          });
          if (!shouldRefetchTaskListMembershipForWorkspaceEvent(event)) {
            return;
          }

          // Web 远控发起归档/置顶时，桌面 workspace 行没有本地乐观 mutation；
          // 这里只监听低频归属类事件并标脏对应 workspace 查询，避免消息流事件触发整表重拉。
          logger.info(
            `[useWorkspaceTaskLists] 收到无法增量处理的 workspace_task_list_changed，刷新 workspace 行 workspace=${config.scope.workspacePath} reason=${event.reason}`,
          );
          // pin/archive/unread 归属持久化在 tasks-index，sessions-index 不感知；
          // 归属类事件（本端 mutation 也会 emit；unread/rename 走 task_meta_changed）
          // bump 版本号让派生列表重新拉取归属 join 面。
          // 同一事件也会被 useGlobalTaskList 的共享订阅转发并 bump，
          // 按事件内容去重，一条事件只触发一轮全局归属重拉。
          bumpTaskListMembershipVersionForWorkspaceEvent(event);
          markTaskQueryCacheScopesStale([config.scope]);
        });
        disposables.push(disposable);
      }
    }

    return () => {
      for (const disposable of disposables) {
        disposable.dispose();
      }
    };
  }, [workspaceEventSubscriptionSignature]);

  const groups = useMemo(() => {
    const result = buildWorkspaceTaskListDisplayGroups({
      queryConfigs,
      resultsByQueryKey,
      taskMetaByEntityKey,
      taskUnreadOverlayByEntityKey,
      optimisticTaskOverlayByWorkspaceKey,
      previousGroupsByWorkspaceKey: groupCacheRef.current,
      sortBy: params.sortBy,
    });
    groupCacheRef.current = result.cache;
    return result.groups;
  }, [
    optimisticTaskOverlayByWorkspaceKey,
    params.sortBy,
    queryConfigs,
    resultsByQueryKey,
    taskMetaByEntityKey,
    taskUnreadOverlayByEntityKey,
  ]);

  return {
    groups,
    loadingByWorkspaceKey: loading,
    refresh,
  };
}
