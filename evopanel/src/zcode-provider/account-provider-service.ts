import { ProviderConfigMap } from "./config/index.js";
import type { AccountProviderStates } from "./account-provider-state.js";
import {
  createFailClosedAccountProviderConfigSnapshot,
  createAccountProviderConfigSnapshot,
  type AccountProviderConfigSnapshot,
  type ProviderConfigSnapshot,
  type ProviderSource,
} from "./sources.js";

export interface AccountProviderResolveInput {
  readonly configRevision: string;
  readonly configuredProviders: ProviderConfigMap;
  readonly previousProviders: ProviderConfigMap;
  readonly previousStates?: AccountProviderStates;
  readonly reasons?: readonly string[];
}

export type AccountProviderResolver = (
  input: AccountProviderResolveInput,
) => Promise<{ readonly providers: ProviderConfigMap; readonly states: AccountProviderStates }>;

export interface AccountProviderServiceDependencies {
  readonly configSource: ProviderSource<ProviderConfigSnapshot>;
  readonly resolve: AccountProviderResolver;
}

export interface AccountProviderServiceRefreshErrorEvent {
  readonly error: unknown;
  readonly reasons: readonly string[];
}

interface RefreshWaiter {
  readonly generation: number;
  readonly resolve: (snapshot: AccountProviderConfigSnapshot) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * 维护当前账号状态投影出的第三层 Provider Config Overlay。
 *
 * 该服务只编排 Config Source、刷新与 last-known-good 发布；登录、权益和团队连接
 * 的具体查询由外围 Resolver 注入，因此本包不依赖文件、网络或 OAuth 实现。
 */
export class AccountProviderService implements ProviderSource<AccountProviderConfigSnapshot> {
  readonly #configSource: ProviderSource<ProviderConfigSnapshot>;
  readonly #resolve: AccountProviderResolver;
  readonly #changeListeners = new Set<(reason: string) => void>();
  readonly #errorListeners = new Set<(event: AccountProviderServiceRefreshErrorEvent) => void>();
  readonly #pendingReasons = new Set<string>();
  #configDispose: (() => void) | null = null;
  #snapshot: AccountProviderConfigSnapshot | null = null;
  #refreshInFlight: Promise<AccountProviderConfigSnapshot> | null = null;
  #requestedGeneration = 0;
  readonly #refreshWaiters: RefreshWaiter[] = [];
  #started = false;
  #disposed = false;

  constructor(dependencies: AccountProviderServiceDependencies) {
    this.#configSource = dependencies.configSource;
    this.#resolve = dependencies.resolve;
  }

  async read(): Promise<AccountProviderConfigSnapshot> {
    this.#assertNotDisposed();
    this.#ensureStarted();
    if (this.#snapshot) return this.#snapshot;
    // 并发首次读取不是新的账号事实，不能排出第二轮并覆盖首次 fail-closed 启动结果。
    if (this.#refreshInFlight) return this.#refreshInFlight;
    return this.#requestRefresh("start");
  }

  refresh(reason = "explicit"): Promise<AccountProviderConfigSnapshot> {
    this.#assertNotDisposed();
    this.#ensureStarted();
    return this.#requestRefresh(reason);
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  onDidRefreshError(
    listener: (event: AccountProviderServiceRefreshErrorEvent) => void,
  ): () => void {
    this.#errorListeners.add(listener);
    return () => this.#errorListeners.delete(listener);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#configDispose?.();
    this.#configDispose = null;
    const error = new Error("AccountProviderService 已 dispose");
    for (const waiter of this.#refreshWaiters.splice(0)) waiter.reject(error);
    this.#changeListeners.clear();
    this.#errorListeners.clear();
  }

  #ensureStarted(): void {
    if (this.#started) return;
    this.#started = true;
    this.#configDispose = this.#configSource.onDidChange((reason) => {
      void this.#requestRefresh(`config:${reason || "changed"}`).catch(() => {
        // Source 驱动的后台失败通过 onDidRefreshError 报告；保留上一份成功快照。
      });
    });
  }

  #requestRefresh(reason: string): Promise<AccountProviderConfigSnapshot> {
    // 进行中的一轮开始于本次请求之前，它读取的设置与账号身份可能已被请求方
    // 随后的写入改变（例如 Provisioning 先写 Setting 再换凭据）。直接复用该轮会把它的
    // 过期失败当成本次请求的结果。refresh 的契约是返回覆盖本次请求之后状态的一轮。
    const generation = this.#requestedGeneration + 1;
    this.#requestedGeneration = generation;
    this.#pendingReasons.add(reason);
    const result = new Promise<AccountProviderConfigSnapshot>((resolve, reject) => {
      this.#refreshWaiters.push({ generation, resolve, reject });
    });
    if (!this.#refreshInFlight) this.#startRefresh();
    return result;
  }

  #startRefresh(): Promise<AccountProviderConfigSnapshot> {
    const refresh = this.#runRefreshLoop();
    this.#refreshInFlight = refresh;
    void refresh.then(
      () => this.#finishRefresh(refresh),
      () => this.#finishRefresh(refresh),
    );
    return refresh;
  }

  #finishRefresh(refresh: Promise<AccountProviderConfigSnapshot>): void {
    if (this.#refreshInFlight !== refresh) return;
    this.#refreshInFlight = null;
    if (this.#disposed || this.#pendingReasons.size === 0) return;

    // 当前轮失败会提前退出 refresh loop；失败期间加入的事件仍在 pending 中，
    // 必须在 in-flight 释放后启动下一轮，否则账号状态会停留在旧快照直到再次收到外部事件。
    void this.#startRefresh().catch(() => {
      // 后续轮没有直接调用方；错误已经通过 onDidRefreshError 发布并保留 last-known-good。
    });
  }

  async #runRefreshLoop(): Promise<AccountProviderConfigSnapshot> {
    let latest = this.#snapshot;
    while (this.#pendingReasons.size > 0) {
      // 本轮开始前提出的所有请求都由本轮结果回应；本轮开始后到达的请求留给下一轮。
      const generation = this.#requestedGeneration;
      const reasons = [...this.#pendingReasons];
      this.#pendingReasons.clear();
      let config: ProviderConfigSnapshot | undefined;
      try {
        config = await this.#configSource.read();
        const configuredProviders = config.zcodeBuiltinProviders;
        const { providers, states } = await this.#resolve({
          configRevision: config.zcodeBuiltinRevision,
          configuredProviders,
          previousProviders: latest?.providers ?? ProviderConfigMap.empty(),
          previousStates: latest?.states,
          reasons: Object.freeze(reasons),
        });
        // Account Snapshot 已经表达 Overlay 的来源，目标与字段边界由注入的
        // Resolver 和 Account Schema 负责。再按 Built-in access.type 做门禁，会错误拒绝
        // 账号层为闲时 Provider 发布的 entitled-only Overlay，导致整个 Registry 无法启动。
        this.#assertNotDisposed();
        // 查询可跨越 Built-in/凭据更新；过期轮只能丢弃，不能短暂发布后再修正。
        const currentConfig = await this.#configSource.read();
        this.#assertNotDisposed();
        if (
          this.#pendingReasons.size > 0 ||
          currentConfig.zcodeBuiltinRevision !== config.zcodeBuiltinRevision
        ) {
          this.#pendingReasons.add("superseded-resolution");
          continue;
        }
        const basedOnZCodeBuiltinRevision = config.zcodeBuiltinRevision;
        const next = createAccountProviderConfigSnapshot(
          basedOnZCodeBuiltinRevision,
          providers,
          states,
        );
        const revision = next.revision;
        if (latest?.revision === revision) {
          this.#resolveRefreshWaiters(generation, latest);
          continue;
        }
        const hadSnapshot = latest !== null;
        latest = next;
        this.#snapshot = latest;
        this.#resolveRefreshWaiters(generation, latest);
        if (hadSnapshot) {
          const changeReason = reasons.join(",");
          for (const listener of this.#changeListeners) listener(changeReason);
        }
      } catch (error) {
        const event = Object.freeze({ error, reasons: Object.freeze(reasons) });
        for (const listener of this.#errorListeners) listener(event);
        if (!latest && config) {
          // 首次账号网络/凭据解析失败被当成整个 Registry 的 ready barrier，
          // 连不依赖账号的 API/Personal Provider 也无法启动。账号未知只应显式 fail-closed。
          latest = createFailClosedAccountProviderConfigSnapshot(config);
          this.#snapshot = latest;
          this.#resolveRefreshWaiters(generation, latest);
          continue;
        }
        // 只回绝本轮开始前的请求；之后到达的请求仍在 pending 中，由 #finishRefresh 启动下一轮回应。
        this.#rejectRefreshWaiters(generation, error);
        throw error;
      }
    }
    if (!latest) throw new Error("Account Provider Service 尚未产生快照");
    return latest;
  }

  #resolveRefreshWaiters(generation: number, snapshot: AccountProviderConfigSnapshot): void {
    const remaining: RefreshWaiter[] = [];
    for (const waiter of this.#refreshWaiters) {
      if (waiter.generation <= generation) waiter.resolve(snapshot);
      else remaining.push(waiter);
    }
    this.#refreshWaiters.splice(0, this.#refreshWaiters.length, ...remaining);
  }

  #rejectRefreshWaiters(generation: number, error: unknown): void {
    const remaining: RefreshWaiter[] = [];
    for (const waiter of this.#refreshWaiters) {
      if (waiter.generation <= generation) waiter.reject(error);
      else remaining.push(waiter);
    }
    this.#refreshWaiters.splice(0, this.#refreshWaiters.length, ...remaining);
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("AccountProviderService 已 dispose");
  }
}
