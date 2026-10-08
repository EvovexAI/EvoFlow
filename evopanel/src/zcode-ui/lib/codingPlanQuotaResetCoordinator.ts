import type { IUsageStatsService } from "@zcode/services";
import type { CodingPlanResetOpportunityResult, CodingPlanResetScopeRequest } from "@zcode/shared";
import { logger } from "@/logger.js";

const STATUS_POLL_INTERVAL_MS = 5 * 60_000;
const OPPORTUNITY_MIN_RETRY_MS = 5 * 60_000;
const OPPORTUNITY_DEFAULT_COOLDOWN_MS = 10 * 60_000;
const OPPORTUNITY_TRANSIENT_ERROR_RETRY_MS = 5 * 60_000;
const OPPORTUNITY_STABLE_ERROR_COOLDOWN_MS = 10 * 60_000;

type RefreshCallback = () => unknown | Promise<unknown>;

interface OpportunitySchedule {
  nextCheckAt: number;
  retryIdempotencyKey: string | null;
  inflight: Promise<CodingPlanResetOpportunityResult> | null;
}

interface CoordinatorParams {
  service: IUsageStatsService;
  authSessionSeq: number;
  scope: CodingPlanResetScopeRequest;
}

interface PollingSubscriptionParams extends CoordinatorParams {
  refresh: RefreshCallback;
}

const coordinatorsByService = new WeakMap<
  IUsageStatsService,
  Map<string, CodingPlanQuotaResetPollingCoordinator>
>();
const opportunitySchedulesByService = new WeakMap<
  IUsageStatsService,
  Map<string, OpportunitySchedule>
>();

function buildScopeKey(scope: CodingPlanResetScopeRequest): string {
  return JSON.stringify([scope.preferredProviderId, scope.accountAccess]);
}

function buildCoordinatorKey(authSessionSeq: number, scope: CodingPlanResetScopeRequest): string {
  return `${authSessionSeq}::${buildScopeKey(scope)}`;
}

function getServiceMap<T>(
  owner: WeakMap<IUsageStatsService, Map<string, T>>,
  service: IUsageStatsService,
): Map<string, T> {
  const existing = owner.get(service);
  if (existing) {
    return existing;
  }
  const created = new Map<string, T>();
  owner.set(service, created);
  return created;
}

function createIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues(bytes);
  if (bytes.some((value) => value !== 0)) {
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isOpportunityThrottleError(error: unknown): boolean {
  const message = toErrorMessage(error);
  return (
    message.includes("coding_plan_reset_opportunity_throttled") ||
    message.includes("coding_plan_reset_api_error:429")
  );
}

function isOpportunityTransientError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  if (message.includes("coding_plan_reset_api_error:2007")) {
    return true;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  return [
    "failed to fetch",
    "fetch failed",
    "network error",
    "network request failed",
    "timeout",
    "timed out",
    "econnreset",
    "econnrefused",
    "enotfound",
    "etimedout",
    "eai_again",
  ].some((fragment) => message.includes(fragment));
}

function resolveOpportunityNextCheckAt(
  result: CodingPlanResetOpportunityResult,
  now: number,
): number {
  if (result.granted) {
    return now + OPPORTUNITY_DEFAULT_COOLDOWN_MS;
  }
  if (Number.isFinite(result.nextTryAt) && (result.nextTryAt ?? 0) > 0) {
    return Math.max(result.nextTryAt ?? 0, now + OPPORTUNITY_MIN_RETRY_MS);
  }
  return now + OPPORTUNITY_DEFAULT_COOLDOWN_MS;
}

class CodingPlanQuotaResetPollingCoordinator {
  private readonly subscribers = new Map<number, RefreshCallback>();
  private nextSubscriberId = 1;
  private interval: number | null = null;
  private running: Promise<void> | null = null;
  private listening = false;

  constructor(private readonly key: string) {
    logger.debug("[coding-plan-reset] coordinator created", {
      coordinatorKey: key,
    });
  }

  subscribe(refresh: RefreshCallback): () => void {
    const subscriberId = this.nextSubscriberId;
    this.nextSubscriberId += 1;
    this.subscribers.set(subscriberId, refresh);
    logger.debug("[coding-plan-reset] coordinator subscribed", {
      coordinatorKey: this.key,
      subscriberCount: this.subscribers.size,
    });
    const pollingWasRunning = this.running !== null;
    if (this.subscribers.size === 1) {
      this.start();
      // HoverCard 可能在上一个入口的异步刷新尚未结束时卸载后重挂载。此时 run()
      // 会复用旧 Promise，但旧回调列表没有新入口；单独投影一次才能避免它空白等待下一轮轮询。
      if (pollingWasRunning && document.visibilityState !== "hidden") {
        void this.refreshSubscriber(refresh);
      }
    } else if (document.visibilityState !== "hidden") {
      // 后挂载入口需要立即把共享快照投影到自己的 sourceKey。底层请求会命中同 scope
      // 的 in-flight/cache/opportunity 冷却，因此不会因为 HoverCard 打开而放大网络请求。
      void this.refreshSubscriber(refresh);
    }

    return () => {
      if (!this.subscribers.delete(subscriberId)) {
        return;
      }
      logger.debug("[coding-plan-reset] coordinator unsubscribed", {
        coordinatorKey: this.key,
        subscriberCount: this.subscribers.size,
      });
      if (this.subscribers.size === 0) {
        this.stop();
      }
    };
  }

  private async refreshSubscriber(refresh: RefreshCallback): Promise<void> {
    try {
      await refresh();
    } catch (error) {
      logger.warn("[coding-plan-reset] status refresh failed", {
        coordinatorKey: this.key,
        error: toErrorMessage(error),
      });
    }
  }

  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
      this.clearInterval();
      return;
    }
    this.startVisiblePolling();
  };

  private start(): void {
    if (!this.listening) {
      document.addEventListener("visibilitychange", this.handleVisibilityChange);
      this.listening = true;
    }
    if (document.visibilityState !== "hidden") {
      this.startVisiblePolling();
    }
  }

  private stop(): void {
    this.clearInterval();
    if (this.listening) {
      document.removeEventListener("visibilitychange", this.handleVisibilityChange);
      this.listening = false;
    }
    // HoverCard 关闭会短暂没有订阅者。只停止计时器、不删除 Coordinator，
    // 才能在重新打开后继续复用 opportunity 的 next_try_at，避免再次立即请求。
    logger.debug("[coding-plan-reset] coordinator stopped", {
      coordinatorKey: this.key,
    });
  }

  private startVisiblePolling(): void {
    this.clearInterval();
    void this.run();
    this.interval = window.setInterval(() => void this.run(), STATUS_POLL_INTERVAL_MS);
  }

  private clearInterval(): void {
    if (this.interval === null) {
      return;
    }
    window.clearInterval(this.interval);
    this.interval = null;
  }

  private run(): Promise<void> {
    if (this.running) {
      return this.running;
    }
    const refreshCallbacks = [...this.subscribers.values()];
    if (refreshCallbacks.length === 0 || document.visibilityState === "hidden") {
      return Promise.resolve();
    }

    logger.debug("[coding-plan-reset] coordinator refresh", {
      coordinatorKey: this.key,
      subscriberCount: refreshCallbacks.length,
    });
    // 一个 Coordinator tick 同时通知所有 source 做状态投影；底层 status/opportunity 仍通过
    // shared in-flight 与调度器只发一组网络请求，避免不同 sourceKey 的入口拿不到共享结果。
    const request = Promise.allSettled(
      refreshCallbacks.map((refresh) => Promise.resolve().then(refresh)),
    )
      .then((results) => {
        for (const result of results) {
          if (result.status === "rejected") {
            logger.warn("[coding-plan-reset] status refresh failed", {
              coordinatorKey: this.key,
              error: toErrorMessage(result.reason),
            });
          }
        }
      })
      .finally(() => {
        if (this.running === request) {
          this.running = null;
        }
      });
    this.running = request;
    return request;
  }
}

export function subscribeCodingPlanQuotaResetPolling(
  params: PollingSubscriptionParams,
): () => void {
  const coordinatorKey = buildCoordinatorKey(params.authSessionSeq, params.scope);
  const coordinators = getServiceMap(coordinatorsByService, params.service);
  let coordinator = coordinators.get(coordinatorKey);
  if (!coordinator) {
    coordinator = new CodingPlanQuotaResetPollingCoordinator(coordinatorKey);
    coordinators.set(coordinatorKey, coordinator);
  }
  return coordinator.subscribe(params.refresh);
}

export function requestCodingPlanResetOpportunityWhenDue(
  params: CoordinatorParams,
): Promise<CodingPlanResetOpportunityResult | null> {
  const coordinatorKey = buildCoordinatorKey(params.authSessionSeq, params.scope);
  const schedules = getServiceMap(opportunitySchedulesByService, params.service);
  let schedule = schedules.get(coordinatorKey);
  if (!schedule) {
    schedule = {
      nextCheckAt: 0,
      retryIdempotencyKey: null,
      inflight: null,
    };
    schedules.set(coordinatorKey, schedule);
  }

  const now = Date.now();
  if (schedule.inflight) {
    return schedule.inflight;
  }
  if (now < schedule.nextCheckAt) {
    logger.debug("[coding-plan-reset] opportunity skipped by coordinator", {
      coordinatorKey,
      nextCheckAt: schedule.nextCheckAt,
    });
    return Promise.resolve(null);
  }

  const idempotencyKey = schedule.retryIdempotencyKey ?? createIdempotencyKey();
  logger.debug("[coding-plan-reset] opportunity request", {
    coordinatorKey,
    retrying: schedule.retryIdempotencyKey !== null,
  });
  const request = params.service
    .requestCodingPlanResetOpportunity({
      ...params.scope,
      idempotencyKey,
    })
    .then((result) => {
      schedule.nextCheckAt = resolveOpportunityNextCheckAt(result, Date.now());
      schedule.retryIdempotencyKey = null;
      return result;
    })
    .catch((error: unknown) => {
      const transient = !isOpportunityThrottleError(error) && isOpportunityTransientError(error);
      schedule.nextCheckAt =
        Date.now() +
        (transient ? OPPORTUNITY_TRANSIENT_ERROR_RETRY_MS : OPPORTUNITY_STABLE_ERROR_COOLDOWN_MS);
      // 鉴权、业务拒绝和协议错误不能当成瞬时依赖错误，否则每个轮询周期都会空转一次并刷 warn。
      // 只有 2007、网络中断和超时复用原幂等 key 在五分钟后重试；429 与稳定错误冷却后开启新判断。
      schedule.retryIdempotencyKey = transient ? idempotencyKey : null;
      throw error;
    })
    .finally(() => {
      if (schedule.inflight === request) {
        schedule.inflight = null;
      }
    });
  schedule.inflight = request;
  return request;
}
