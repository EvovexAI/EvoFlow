/* eslint-disable max-lines -- entitlement hook 集中处理缓存、共享 in-flight、轮询和 Team Plan 上下文，后续拆分需保持刷新策略一致。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  UsageEntitlementSnapshot,
  ZCodeAccountAccess,
  ZCodeProviderAccountAccess,
} from "@zcode/shared";
import type { IUsageStatsService } from "@zcode/services";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useStableAccountAccess } from "@/hooks/useStableAccountAccess.js";
import { logger } from "@/logger.js";
import {
  readCachedUsageEntitlementSnapshot,
  writeCachedUsageEntitlementSnapshot,
} from "@/lib/usageEntitlementCache.js";
import {
  hasSharedEntitlementFailure,
  buildEntitlementFreshnessKey,
  beginSharedEntitlementRequest,
  publishSharedEntitlementSnapshot,
  readSharedEntitlementSnapshot,
  recordSharedEntitlementAccess,
  recordSharedEntitlementFailure,
  shouldDeferSharedEntitlementRefresh,
  shouldDeferSharedEntitlementAccess,
  shouldUseSharedEntitlementSnapshot,
  subscribeSharedEntitlementSnapshot,
  USAGE_ENTITLEMENT_ACCESS_REFRESH_MS,
  type UsageEntitlementRefreshReason,
  type UsageEntitlementRequestOptions,
} from "@/lib/usageEntitlementRefreshPolicy.js";

interface UsageEntitlementState {
  snapshot: UsageEntitlementSnapshot | null;
  loading: boolean;
  error: string | null;
}

const INITIAL_STATE: UsageEntitlementState = {
  snapshot: null,
  loading: false,
  error: null,
};

const USAGE_ENTITLEMENT_REFRESH_TIMEOUT_MS = 20_000;

export interface UsageEntitlementRefreshOptions {
  silent?: boolean;
  force?: boolean;
  reason?: UsageEntitlementRefreshReason;
}

const entitlementInflightRequests = new WeakMap<
  IUsageStatsService,
  Map<string, Promise<UsageEntitlementSnapshot>>
>();

function getSharedEntitlementSnapshot(params: {
  usageStatsService: IUsageStatsService;
  options: UsageEntitlementRequestOptions;
  requestKey: string;
}): Promise<UsageEntitlementSnapshot> {
  let serviceRequests = entitlementInflightRequests.get(params.usageStatsService);
  if (!serviceRequests) {
    serviceRequests = new Map();
    entitlementInflightRequests.set(params.usageStatsService, serviceRequests);
  }

  const requestKey = params.requestKey;
  const inflight = serviceRequests.get(requestKey);
  if (inflight) {
    return inflight;
  }

  // 侧栏、工具栏、设置页和 Usage 页会在启动/打开设置时同时读取同一份
  // Coding Plan entitlement。生产日志里同一分钟出现 12 个相同 quota RPC，直接拖慢 renderer。
  // 这里按服务实例 + 请求参数合并 in-flight 请求，保留各组件自己的状态更新语义。
  const upstreamRequest = params.usageStatsService.getEntitlementSnapshot({
    ...(params.options.invalidateBalanceCache ? { invalidateBalanceCache: true } : {}),
    includeSubscription: params.options.includeSubscription,
    preferredProviderId: params.options.preferredProviderId,
    accountAccess: params.options.accountAccess,
    allowDisabledPreferredProvider: params.options.allowDisabledPreferredProvider,
    requirePreferredProvider: params.options.requirePreferredProvider,
    allowEnvApiKey: params.options.allowEnvApiKey,
  });
  const request = withUsageEntitlementTimeout(upstreamRequest).finally(() => {
    if (serviceRequests.get(requestKey) !== request) {
      return;
    }
    serviceRequests.delete(requestKey);
    if (serviceRequests.size === 0) {
      entitlementInflightRequests.delete(params.usageStatsService);
    }
  });
  serviceRequests.set(requestKey, request);
  return request;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return String(error);
}

function createUsageEntitlementTimeoutError(timeoutMs: number): Error {
  return new Error(`usage_entitlement_request_timeout:${timeoutMs}`);
}

function withUsageEntitlementTimeout<T>(
  request: Promise<T>,
  timeoutMs = USAGE_ENTITLEMENT_REFRESH_TIMEOUT_MS,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(createUsageEntitlementTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  return Promise.race([request, timeout]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

export interface UseUsageEntitlementOptions {
  enabled?: boolean;
  includeSubscription?: boolean;
  preferredProviderId?: string;
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  allowDisabledPreferredProvider?: boolean;
  requirePreferredProvider?: boolean;
  allowEnvApiKey?: boolean;
  cacheKey?: string;
  refreshOnMount?: boolean;
  mountRefreshReason?: "initial" | "access";
}

export function useUsageEntitlement(options: UseUsageEntitlementOptions = {}) {
  const services = useOptionalBaseWorkspaceServices();
  return useUsageEntitlementWithService(services?.usageStatsService, options);
}

export function useUsageEntitlementWithService(
  usageStatsService: IUsageStatsService | undefined,
  options: UseUsageEntitlementOptions = {},
) {
  const [state, setState] = useState<UsageEntitlementState>(INITIAL_STATE);
  const requestVersionRef = useRef(0);
  const activeFreshnessKeyRef = useRef<string | null>(null);
  const latestSnapshotRef = useRef<UsageEntitlementSnapshot | null>(null);
  // Web/SSR 场景可能只渲染侧栏或设置入口，没有挂载 ServiceProvider。
  // 这里降级为空快照，避免 Usage banner 因服务上下文缺失阻断整棵 UI。
  const enabled = (options.enabled ?? true) && Boolean(usageStatsService);
  const includeSubscription = options.includeSubscription ?? false;
  const preferredProviderId = options.preferredProviderId;
  // Provider Settings schema 每次解析会产生等值新对象，不能因引用变化重启权益请求。
  const accountAccess = useStableAccountAccess(options.accountAccess);
  const allowDisabledPreferredProvider = options.allowDisabledPreferredProvider === true;
  const requirePreferredProvider = options.requirePreferredProvider === true;
  const allowEnvApiKey = options.allowEnvApiKey;
  const cacheKey = options.cacheKey?.trim() ?? "";
  const refreshOnMount = options.refreshOnMount ?? false;
  const mountRefreshReason = options.mountRefreshReason ?? "initial";
  const requestOptions = useMemo(
    () =>
      ({
        includeSubscription,
        preferredProviderId,
        accountAccess,
        allowDisabledPreferredProvider,
        requirePreferredProvider,
        allowEnvApiKey,
      }) satisfies UsageEntitlementRequestOptions,
    [
      allowDisabledPreferredProvider,
      accountAccess,
      allowEnvApiKey,
      includeSubscription,
      preferredProviderId,
      requirePreferredProvider,
    ],
  );
  const freshnessKey = useMemo(
    () =>
      buildEntitlementFreshnessKey({
        cacheKey,
        options: requestOptions,
      }),
    [cacheKey, requestOptions],
  );

  const refresh = useCallback(
    async (refreshOptions: UsageEntitlementRefreshOptions = {}) => {
      if (!enabled || !usageStatsService) {
        return;
      }
      const reason = refreshOptions.reason ?? "manual";
      const sharedSnapshot =
        refreshOptions.force === true
          ? null
          : reason === "initial"
            ? shouldUseSharedEntitlementSnapshot({
                freshnessKey,
                intervalMs: Number.POSITIVE_INFINITY,
                now: Date.now(),
                usageStatsService,
              })
            : reason === "access"
              ? shouldUseSharedEntitlementSnapshot({
                  freshnessKey,
                  // Context hover、套餐卡和 Usage 页打开会在短时间内
                  // 读取同一份额度。访问刷新必须共享一分钟窗口，避免反复 hover 放大 quota RPC。
                  intervalMs: USAGE_ENTITLEMENT_ACCESS_REFRESH_MS,
                  now: Date.now(),
                  usageStatsService,
                })
              : null;
      if (sharedSnapshot) {
        setState({
          snapshot: sharedSnapshot,
          loading: false,
          error: null,
        });
        latestSnapshotRef.current = sharedSnapshot;
        return;
      }
      if (
        refreshOptions.force !== true &&
        reason === "access" &&
        shouldDeferSharedEntitlementAccess({
          freshnessKey,
          now: Date.now(),
          usageStatsService,
        })
      ) {
        setState((current) => ({ ...current, loading: false }));
        return;
      }
      if (
        refreshOptions.force !== true &&
        (reason === "initial" || reason === "access") &&
        shouldDeferSharedEntitlementRefresh({
          freshnessKey,
          now: Date.now(),
          usageStatsService,
        })
      ) {
        setState((current) => ({
          ...current,
          loading: false,
        }));
        return;
      }

      const sharedRequest = beginSharedEntitlementRequest({
        usageStatsService,
        freshnessKey,
        invalidate: reason === "purchase",
      });
      const requestVersion = requestVersionRef.current + 1;
      requestVersionRef.current = requestVersion;
      if (reason === "access") {
        recordSharedEntitlementAccess({
          freshnessKey,
          now: Date.now(),
          usageStatsService,
        });
      }
      logger.debug("[useUsageEntitlement] 开始读取权益信息", {
        reason,
        includeSubscription,
        preferredProviderId,
        accountAccess,
        cacheKey,
        freshnessKey,
      });
      setState((current) => ({
        snapshot: current.snapshot,
        // Plan Card 已有短 TTL 缓存时，进入 provider 只需要后台校正权益。
        // 继续把 loading 置 true 会让卡片从缓存态跳回 checking，用户每次进入都像重新加载。
        loading: refreshOptions.silent && current.snapshot ? false : true,
        error: null,
      }));

      try {
        const snapshot = await getSharedEntitlementSnapshot({
          usageStatsService,
          requestKey: sharedRequest.requestKey,
          options:
            reason === "purchase"
              ? { ...requestOptions, invalidateBalanceCache: true }
              : requestOptions,
        });
        if (requestVersionRef.current !== requestVersion || !sharedRequest.isCurrent()) {
          return;
        }
        publishSharedEntitlementSnapshot({
          usageStatsService,
          freshnessKey,
          snapshot,
        });
        logger.debug("[useUsageEntitlement] 权益信息已更新", {
          reason,
          providerId: snapshot.provider?.id ?? null,
          scope: snapshot.context?.scope ?? null,
          organizationId: snapshot.context?.organizationId ?? null,
          projectId: snapshot.context?.projectId ?? null,
          cacheKey,
          freshnessKey,
        });
        latestSnapshotRef.current = snapshot;
        setState({
          snapshot,
          loading: false,
          error: null,
        });
        writeCachedUsageEntitlementSnapshot({ cacheKey, snapshot });
      } catch (error) {
        if (requestVersionRef.current !== requestVersion || !sharedRequest.isCurrent()) {
          return;
        }
        recordSharedEntitlementFailure({
          usageStatsService,
          freshnessKey,
        });
        const message = getErrorMessage(error);
        logger.warn("[useUsageEntitlement] 读取权益信息失败", {
          includeSubscription,
          error: message,
        });
        if (
          !latestSnapshotRef.current?.subscription?.details.length &&
          !(refreshOptions.silent && latestSnapshotRef.current)
        ) {
          latestSnapshotRef.current = null;
        }
        setState((current) => {
          if (
            current.snapshot &&
            (refreshOptions.silent || current.snapshot.subscription?.details.length)
          ) {
            return {
              // 后台刷新或已确认订阅的手动刷新失败时，保留上次成功结果。
              // 否则网络抖动会把 Plan Card 从可用状态打回空态/错误态。
              snapshot: current.snapshot,
              loading: false,
              error: message,
            };
          }
          return {
            // 切换 BigModel/Z.AI 后如果新 provider 查询失败，继续保留旧 snapshot 会让 banner/浮窗显示上一家供应商。
            // 出错时清空快照，避免用过期品牌和额度误导用户。
            snapshot: null,
            loading: false,
            error: message,
          };
        });
      }
    },
    [cacheKey, enabled, freshnessKey, requestOptions, usageStatsService],
  );

  useEffect(() => {
    if (!enabled || !usageStatsService) {
      return;
    }
    return subscribeSharedEntitlementSnapshot({
      usageStatsService,
      freshnessKey,
      listener: (snapshot, error) => {
        latestSnapshotRef.current = snapshot;
        setState({
          snapshot,
          loading: false,
          error: error ?? null,
        });
      },
    });
  }, [enabled, freshnessKey, usageStatsService]);

  useEffect(() => {
    if (!enabled) {
      setState({
        // Coding Plan 缺少 API Key 或切换供应商时会临时禁用查询。
        // 保留上一轮 snapshot 会让 UI 继续显示旧账号的套餐状态，并诱发无 key 的入口被误判为可查。
        snapshot: null,
        loading: false,
        error: null,
      });
      activeFreshnessKeyRef.current = null;
      latestSnapshotRef.current = null;
      return;
    }

    const freshnessKeyChanged = activeFreshnessKeyRef.current !== freshnessKey;
    if (freshnessKeyChanged) {
      // Team Plan 切换团队项目后，旧团队 active snapshot 会让 initial refresh
      // 被 freshness 策略跳过，设置页继续显示上一个团队的用量。freshness key 变化时必须
      // 先废掉旧请求和旧快照，再用新团队的缓存/共享快照启动刷新。
      requestVersionRef.current += 1;
      activeFreshnessKeyRef.current = freshnessKey;
      latestSnapshotRef.current = null;
      setState(INITIAL_STATE);
    }

    const cachedSnapshot = readCachedUsageEntitlementSnapshot({ cacheKey });
    const sharedSnapshot = usageStatsService
      ? readSharedEntitlementSnapshot({ usageStatsService, freshnessKey })
      : null;
    const initialSnapshot = sharedSnapshot ?? cachedSnapshot;
    if (initialSnapshot) {
      // Coding Plan 状态打开设置页时不必等待 quota 接口返回才变绿。
      // 先用同 provider 指纹下的短 TTL 缓存回显，再由 refresh 后台校正真实权益。
      setState({
        snapshot: initialSnapshot,
        loading: false,
        error:
          usageStatsService && hasSharedEntitlementFailure({ usageStatsService, freshnessKey })
            ? "usage_entitlement_refresh_failed"
            : null,
      });
      latestSnapshotRef.current = initialSnapshot;
    }

    if (refreshOnMount) {
      void refresh({
        silent: Boolean(initialSnapshot),
        force: mountRefreshReason === "initial" && !initialSnapshot,
        reason: mountRefreshReason,
      });
    }
  }, [
    cacheKey,
    enabled,
    freshnessKey,
    refresh,
    refreshOnMount,
    mountRefreshReason,
    usageStatsService,
  ]);

  return {
    snapshot: state.snapshot,
    loading: state.loading,
    error: state.error,
    refresh,
  };
}
