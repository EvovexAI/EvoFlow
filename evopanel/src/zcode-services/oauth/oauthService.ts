/* eslint-disable max-lines -- OAuthService 集中维护 OAuth 会话生命周期和 provider 切换边界，当前 review 修复只收窄后台迁移写入条件。 */
import { randomBytes } from "node:crypto";
import {
  ApiError,
  formatLogPrefix,
  type ApiClient,
  BIGMODEL_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  type OAuthCallbackResult,
  type OAuthCachedSessionRestoreResult,
  type OAuthProviderId,
  type OAuthProviderMeta,
  type OAuthStartResponse,
  type OAuthTokenSet,
  type OAuthUserProfile,
  type UserInfo,
  resolveJwtExpiration,
} from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { readApiJson } from "../providers/api/apiJson.js";
import type { IOAuthService } from "./oauth.js";
import { isCurrentOAuthCredentialRequest } from "#src/oauth/oauthUnauthorizedRequest.js";
import { hasOAuthAuthorizationCode, parseOAuthLoginAttribution } from "./callbackAttribution.js";
import {
  refreshLegacyBigModelCachedProfile,
  withProviderProfileSchema,
} from "./oauthProfileSchema.js";
import { createOAuthProviderAdapters, type OAuthProviderAdapter } from "./providers/index.js";
import { OAuthCredentialRepo } from "./repo/oauthCredentialRepo.js";
import { createOAuthRuntimeConfig } from "./runtimeConfig.js";
import {
  buildDesktopOAuthRedirectUriFromEnv,
  buildZCodeApiUrlFromEnv,
} from "./providers/configUtils.js";

/** OAuth 超时时间（5 分钟） */
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const COMPLETED_POLLING_STATE_GRACE_MS = 30 * 1000;
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("oauthService", process.pid), ...args);
const serviceLog = createServiceLogger("oauthService");

interface PendingState {
  state: string;
  provider: OAuthProviderId;
  timeout: NodeJS.Timeout;
  phase: "awaiting-attribution-or-code" | "awaiting-code-after-attribution";
  completionPromise?: Promise<OAuthCallbackResult | null>;
  polling?: {
    expiresAt: number;
    flowId: string;
    nextPollAt: number;
    pollIntervalMs: number;
    pollToken: string;
    pollUrl: string;
  };
}

interface OAuthFlowEnvelope {
  code?: unknown;
  msg?: unknown;
  data?: unknown;
}

interface OAuthServiceDependencies {
  adapters?: OAuthProviderAdapter[];
  apiClient?: ApiClient;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  onProviderLogout?: (provider: OAuthProviderId, accountIdentity?: string | null) => Promise<void>;
}

function readTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toUserInfo(profile: OAuthUserProfile): UserInfo {
  return {
    id: profile.id,
    username: profile.username,
    displayName: profile.displayName,
    ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
  };
}

function isSameOAuthProfile(left: OAuthUserProfile, right: OAuthUserProfile): boolean {
  return (
    left.id === right.id &&
    left.username === right.username &&
    left.displayName === right.displayName &&
    left.avatarUrl === right.avatarUrl &&
    JSON.stringify(left.rawProfile ?? null) === JSON.stringify(right.rawProfile ?? null)
  );
}

function resolveInactiveOAuthProvider(provider: OAuthProviderId): OAuthProviderId | null {
  if (provider === ZAI_PROVIDER_ID) {
    return BIGMODEL_PROVIDER_ID;
  }
  if (provider === BIGMODEL_PROVIDER_ID) {
    return ZAI_PROVIDER_ID;
  }
  return null;
}

/**
 * OAuth 认证服务实现
 *
 * 在 host process 中运行，管理 OAuth 流程的完整生命周期。
 */
export class OAuthService implements IOAuthService {
  private readonly credentialService: ICredentialService;
  private readonly repo: OAuthCredentialRepo;
  private readonly adapters = new Map<OAuthProviderId, OAuthProviderAdapter>();
  private readonly now: () => number;
  private readonly onProviderLogout?: (
    provider: OAuthProviderId,
    accountIdentity?: string | null,
  ) => Promise<void>;
  private readonly apiClient?: ApiClient;
  private readonly env: NodeJS.ProcessEnv;
  private pendingState: PendingState | null = null;
  private oauthFlowStartGeneration = 0;
  private oauthFlowStartProvider: OAuthProviderId | null = null;
  private oauthSessionGeneration = 0;
  private sessionMutationQueue: Promise<unknown> = Promise.resolve();
  private recentlyCompletedPollingState: {
    generation: number;
    expiresAt: number;
    provider: OAuthProviderId;
    state: string;
  } | null = null;

  constructor(credentialService: ICredentialService, dependencies: OAuthServiceDependencies = {}) {
    this.credentialService = credentialService;
    this.now = dependencies.now ?? Date.now;
    this.onProviderLogout = dependencies.onProviderLogout;
    this.apiClient = dependencies.apiClient;
    this.env = dependencies.env ?? process.env;

    const adapters =
      dependencies.adapters ??
      createOAuthProviderAdapters(createOAuthRuntimeConfig(dependencies.env), {
        apiClient: dependencies.apiClient,
      });

    for (const adapter of adapters) {
      this.adapters.set(adapter.providerId, adapter);
    }
    this.repo = new OAuthCredentialRepo(credentialService, {
      providerIds: adapters.map((adapter) => adapter.providerId),
      onCorruptOAuthSessionCleared: async (providers) => {
        // 本地 OAuth 凭据解密失败后等价于强制 logout。
        // repo 只能清 OAuth 命名空间，派生的 Start/Coding Plan provider key 必须回到 service 层清理。
        await this.notifyProvidersLogout(providers);
      },
    });
  }

  async getProviders(): Promise<OAuthProviderMeta[]> {
    return [...this.adapters.values()]
      .map((adapter) => adapter.meta)
      .filter((meta) => meta.enabled)
      .sort((a, b) => a.order - b.order);
  }

  async getActiveProvider(): Promise<OAuthProviderId | null> {
    return this.repo.getActiveProvider();
  }

  async restoreCachedSession(): Promise<UserInfo | null> {
    const result = await this.restoreCachedSessionState();
    return result.status === "authenticated" ? result.userInfo : null;
  }

  async restoreCachedSessionState(): Promise<OAuthCachedSessionRestoreResult> {
    const restoreGeneration = this.oauthSessionGeneration;
    const activeProvider = await this.repo.getActiveProvider();
    if (!activeProvider) {
      log("restoreCachedSession skipped: no active provider");
      return { status: "signed-out" };
    }

    const adapter = this.adapters.get(activeProvider);
    if (!adapter || !adapter.meta.enabled) {
      log(
        "restoreCachedSession aborted: provider unavailable, clearing active provider:",
        activeProvider,
      );
      await this.repo.setActiveProvider(null);
      return { status: "signed-out" };
    }

    const profile = await this.repo.loadActiveUserProfile();
    if (!profile) {
      // zai / bigmodel 这类 OAuth token 生命周期很短，启动时如果强依赖远端 userinfo 校验，
      // 用户明明刚登录过，也会因为 access_token 过期被误判成未登录。
      // 这里改为优先读取登录成功时持久化的 user_info，只要用户没有手动退出，就按缓存恢复展示态。
      log("restoreCachedSession skipped: missing cached user profile:", activeProvider);
      return { status: "signed-out" };
    }

    // 启动缓存恢复只需要检查共享 zcode JWT；若通过 loadActiveTokenSet 连带读取
    // provider access token，会把原本后台执行的 BigModel profile 迁移重新阻塞到首屏恢复链路。
    const zcodeJwtToken = (await this.credentialService.load(ZCODE_JWT_TOKEN_KEY))?.trim() ?? "";
    if (zcodeJwtToken && resolveJwtExpiration(zcodeJwtToken, this.now()).kind === "expired") {
      serviceLog.info("cached session invalidated because zcode JWT expired", {
        provider: activeProvider,
      });
      const invalidated = await this.invalidateExpiredCachedSession(
        restoreGeneration,
        activeProvider,
        profile,
        zcodeJwtToken,
      );
      if (!invalidated) {
        return this.restoreCachedSessionState();
      }
      return { status: "reauthentication-required", reason: "jwt-expired" };
    }

    if (activeProvider === BIGMODEL_PROVIDER_ID) {
      const migrationGeneration = this.oauthSessionGeneration;
      void refreshLegacyBigModelCachedProfile({
        adapter,
        cachedProfile: profile,
        loadTokenSet: () =>
          this.loadBigModelCachedProfileMigrationTokenSet(migrationGeneration, profile),
        now: this.now,
        runWithAdapterError: (run) => this.runWithAdapterError(adapter, run),
        saveProfile: (nextProfile) =>
          this.saveBigModelCachedProfileMigration(migrationGeneration, profile, nextProfile),
      })
        .then((migratedProfile) => {
          if (migratedProfile !== profile) {
            log(
              "restoreCachedSession migrated cached profile:",
              activeProvider,
              migratedProfile.id,
            );
          }
        })
        .catch((error: unknown) => {
          log(
            "restoreCachedSession background profile migration failed:",
            activeProvider,
            error instanceof Error ? error.message : String(error),
          );
        });
    }

    if (activeProvider === ZAI_PROVIDER_ID) {
      if (!zcodeJwtToken) {
        // sidebar 登录入口之前只看缓存 user_info，会把“缺少 zcodejwttoken”的状态误判成已登录。
        // 这里补充 zcodejwttoken 门槛，确保没有后端 JWT 时统一按未登录处理。
        log("restoreCachedSession skipped: missing zcodejwttoken:", activeProvider);
        return { status: "signed-out" };
      }
    }

    log("restoreCachedSession restored:", activeProvider, profile.id);
    return { status: "authenticated", userInfo: toUserInfo(profile) };
  }

  private async invalidateExpiredCachedSession(
    expectedGeneration: number,
    expectedProvider: OAuthProviderId,
    expectedProfile: OAuthUserProfile,
    expectedJwt: string,
  ): Promise<boolean> {
    const invalidated = await this.runSessionMutation(async () => {
      const currentProvider = await this.repo.getActiveProvider();
      const currentProfile = await this.repo.loadUserProfile(expectedProvider);
      const currentJwt = (await this.credentialService.load(ZCODE_JWT_TOKEN_KEY))?.trim() ?? "";
      if (
        this.oauthSessionGeneration !== expectedGeneration ||
        currentProvider !== expectedProvider ||
        !currentProfile ||
        !isSameOAuthProfile(currentProfile, expectedProfile) ||
        currentJwt !== expectedJwt
      ) {
        // 启动恢复读取过期凭据后，新登录或 provider 切换可能已经完成；
        // 旧恢复任务只能清理仍与其快照完全一致的会话，不能误删刚写入的新认证状态。
        serviceLog.info("skipped stale expired JWT session invalidation", {
          provider: expectedProvider,
        });
        return false;
      }
      this.oauthSessionGeneration += 1;
      await this.repo.clearActiveSession();
      return true;
    });
    if (!invalidated) {
      return false;
    }
    await this.cancelPending(expectedProvider);
    try {
      await this.notifyProviderLogout(expectedProvider, expectedProfile.id);
    } catch (error) {
      // JWT 已过期时主认证事实必须先失效；派生 provider 清理失败不能把 UI 留在伪登录态。
      serviceLog.warn("expired JWT derived provider cleanup failed", {
        provider: expectedProvider,
        error,
      });
    }
    return true;
  }

  private async loadBigModelCachedProfileMigrationTokenSet(
    expectedGeneration: number,
    expectedCachedProfile: OAuthUserProfile,
  ): Promise<OAuthTokenSet | null> {
    return this.runSessionMutation(async () => {
      if (this.oauthSessionGeneration !== expectedGeneration) {
        log("restoreCachedSession skipped stale BigModel token migration");
        return null;
      }

      const activeProvider = await this.repo.getActiveProvider();
      const currentProfile = await this.repo.loadUserProfile(BIGMODEL_PROVIDER_ID);
      if (
        activeProvider !== BIGMODEL_PROVIDER_ID ||
        !currentProfile ||
        !isSameOAuthProfile(currentProfile, expectedCachedProfile)
      ) {
        // 迁移请求目标固定是 BigModel，token 也必须固定读取 BigModel 命名空间；
        // 发请求前先复核持久化快照，避免切换到 ZAI 后把其他 provider token 发给 BigModel。
        log("restoreCachedSession skipped stale BigModel token migration:", activeProvider);
        return null;
      }

      return this.repo.loadTokenSet(BIGMODEL_PROVIDER_ID);
    });
  }

  private async saveBigModelCachedProfileMigration(
    expectedGeneration: number,
    expectedCachedProfile: OAuthUserProfile,
    nextProfile: OAuthUserProfile,
  ): Promise<void> {
    await this.runSessionMutation(async () => {
      if (this.oauthSessionGeneration !== expectedGeneration) {
        log("restoreCachedSession skipped stale BigModel profile migration");
        return;
      }

      const activeProvider = await this.repo.getActiveProvider();
      if (activeProvider !== BIGMODEL_PROVIDER_ID) {
        log("restoreCachedSession skipped stale BigModel profile migration:", activeProvider);
        return;
      }

      const currentProfile = await this.repo.loadUserProfile(BIGMODEL_PROVIDER_ID);
      if (!currentProfile || !isSameOAuthProfile(currentProfile, expectedCachedProfile)) {
        // BigModel 旧缓存迁移在后台完成，期间用户可能 logout、切到 ZAI，
        // 或重新登录 BigModel。只有当前缓存仍是启动时那份旧缓存时，旧迁移结果才允许落盘。
        log("restoreCachedSession skipped outdated BigModel profile migration");
        return;
      }

      await this.repo.saveUserProfile(BIGMODEL_PROVIDER_ID, nextProfile);
    });
  }

  private runSessionMutation<T>(run: () => Promise<T>): Promise<T> {
    // 后台 profile 迁移、logout、provider 切换都会改 OAuth 凭据；
    // 必须串行化，避免旧迁移在退出或切换清理之后重新写回 user_info。
    const next = this.sessionMutationQueue.catch(() => undefined).then(run);
    this.sessionMutationQueue = next.catch(() => undefined);
    return next;
  }

  private async persistOAuthSession(
    provider: OAuthProviderId,
    tokenSet: OAuthTokenSet,
    profile: OAuthUserProfile,
    isStillCurrent?: () => boolean,
  ): Promise<void> {
    const inactiveProvider = resolveInactiveOAuthProvider(provider);
    const previousTokenSet = await this.repo.loadTokenSet(provider);
    const previousProfile = await this.repo.loadUserProfile(provider);
    const previousInactiveTokenSet = inactiveProvider
      ? await this.repo.loadTokenSet(inactiveProvider)
      : null;
    const previousInactiveProfile = inactiveProvider
      ? await this.repo.loadUserProfile(inactiveProvider)
      : null;
    const previousActiveProvider = await this.repo.getActiveProvider();
    const rollback = async () => {
      if (previousTokenSet) await this.repo.saveTokenSet(provider, previousTokenSet);
      else await this.repo.clearProvider(provider);
      if (previousProfile) await this.repo.saveUserProfile(provider, previousProfile);
      else await this.repo.clearUserProfile(provider);
      if (inactiveProvider) {
        if (previousInactiveTokenSet)
          await this.repo.saveTokenSet(inactiveProvider, previousInactiveTokenSet);
        else await this.repo.clearProvider(inactiveProvider);
        if (previousInactiveProfile)
          await this.repo.saveUserProfile(inactiveProvider, previousInactiveProfile);
        else await this.repo.clearUserProfile(inactiveProvider);
      }
      if (previousActiveProvider) await this.repo.setActiveProvider(previousActiveProvider);
      else await this.repo.setActiveProvider(null);
    };
    const assertCurrent = async () => {
      if (isStillCurrent && !isStillCurrent()) {
        await rollback();
        throw new Error("OAuth flow 已取消");
      }
    };
    this.oauthSessionGeneration += 1;
    if (inactiveProvider) {
      await assertCurrent();
      // ZAI 与 BigModel 是互斥身份域。切换 provider 时必须先清旧 provider，
      // 再保存当前 token；反序会让 clearProvider 误删共享的 zcodejwttoken。
      await this.repo.clearProvider(inactiveProvider);
    }
    await assertCurrent();
    await this.repo.saveTokenSet(provider, tokenSet);
    await assertCurrent();
    await this.repo.saveUserProfile(provider, withProviderProfileSchema(provider, profile));
    await assertCurrent();
    await this.repo.setActiveProvider(provider);
    if (isStillCurrent && !isStillCurrent()) {
      // active provider 写入无法被底层 credential IO 取消；失效 flow 不能仅按
      // provider 清理，否则同 provider 的新 flow 可能被旧 flow 误删。
      await rollback();
      throw new Error("OAuth flow 已取消");
    }
  }

  private async runPendingSessionCompletion(
    pending: PendingState,
    complete: () => Promise<{ tokenSet: OAuthTokenSet; profile: OAuthUserProfile }>,
    preserveAttribution?: () => Promise<void>,
  ): Promise<OAuthCallbackResult | null> {
    const completion = this.runSessionMutation(async () => {
      // polling 与 deep link 可能同时完成，也可能在等待期间开始新登录。
      // 只有仍指向同一 pending 对象的路径能落盘，防止迟到结果覆盖更新的登录选择。
      if (this.pendingState !== pending) {
        if (
          !this.pendingState &&
          this.recentlyCompletedPollingState?.state === pending.state &&
          this.recentlyCompletedPollingState.generation === this.oauthFlowStartGeneration
        ) {
          // 回调入队时已通过有效性检查，不能因队列等待超过去重窗口而丢失归因。
          await preserveAttribution?.();
          return { kind: "duplicate" as const, provider: pending.provider };
        }
        return null;
      }
      await preserveAttribution?.();
      if (this.pendingState !== pending) return null;
      const { tokenSet, profile } = await complete();
      // exchangeToken 期间用户可能取消或切换到新 flow；旧请求返回后必须再次校验，
      // 否则已取消的登录仍会把旧凭据写回本地。
      if (this.pendingState !== pending) {
        return null;
      }
      await this.persistOAuthSession(
        pending.provider,
        tokenSet,
        profile,
        () => this.pendingState === pending,
      );
      if (this.pendingState === pending) {
        this.clearPendingState();
      }
      this.recentlyCompletedPollingState = {
        generation: this.oauthFlowStartGeneration,
        expiresAt: this.now() + COMPLETED_POLLING_STATE_GRACE_MS,
        provider: pending.provider,
        state: pending.state,
      };
      return {
        kind: "session" as const,
        provider: pending.provider,
        userInfo: toUserInfo(profile),
      };
    });
    // 共享首个兑换 Promise 会让失败传播给另一条已拿到凭据的路径。
    // 复用会话串行队列，每个候选独立执行；失败只在已排队候选均失败后向 UI 报告。
    pending.completionPromise = completion;
    try {
      return await completion;
    } catch (error) {
      const fallback = pending.completionPromise;
      if (fallback && fallback !== completion) {
        try {
          await fallback;
        } catch {
          // 两条路径均失败时保留各自的错误，不能让备用路径覆盖首条失败原因。
          throw error;
        }
        if (
          !this.pendingState &&
          this.recentlyCompletedPollingState?.state === pending.state &&
          this.recentlyCompletedPollingState.generation === this.oauthFlowStartGeneration
        ) {
          return { kind: "duplicate", provider: pending.provider };
        }
        if (this.pendingState !== pending) return null;
      }
      throw error;
    } finally {
      if (pending.completionPromise === completion) pending.completionPromise = undefined;
    }
  }

  async restoreSession(): Promise<UserInfo | null> {
    const activeProvider = await this.repo.getActiveProvider();
    if (!activeProvider) {
      log("restoreSession skipped: no active provider");
      return null;
    }

    log("restoreSession started:", activeProvider);

    const adapter = this.adapters.get(activeProvider);
    if (!adapter || !adapter.meta.enabled) {
      log(
        "restoreSession aborted: provider unavailable, clearing active provider:",
        activeProvider,
      );
      await this.repo.setActiveProvider(null);
      return null;
    }

    let tokenSet = await this.repo.loadActiveTokenSet();
    if (!tokenSet && adapter.loadLegacyTokenSet) {
      log("restoreSession fallback: trying provider legacy token set:", activeProvider);
      tokenSet = await adapter.loadLegacyTokenSet((key) => this.credentialService.load(key));

      // 多 provider 改造后，旧版 BigModel 仍可能只保留 legacy token key。
      // 这里在 provider 兼容读取成功后回填命名空间 key，避免每次启动都重复走 legacy 分支。
      if (tokenSet) {
        log("restoreSession fallback hit: migrating legacy token set:", activeProvider);
        await this.repo.saveActiveTokenSet(tokenSet);
        await this.repo.saveTokenSet(activeProvider, tokenSet);
      }
    }

    if (!tokenSet || !adapter.fetchUserInfo) {
      log(
        "restoreSession failed: missing token or user-info capability, logging out:",
        activeProvider,
      );
      await this.logout();
      return null;
    }

    try {
      log("restoreSession validating token with provider userinfo endpoint:", activeProvider);
      const profile = await this.runWithAdapterError(adapter, () =>
        adapter.fetchUserInfo!(tokenSet, {
          providerId: activeProvider,
          state: "",
          redirectUri: adapter.redirectUri,
          now: this.now,
        }),
      );

      await this.repo.saveActiveUserProfile(withProviderProfileSchema(activeProvider, profile));
      await this.repo.setActiveProvider(activeProvider);
      log("restoreSession validated:", activeProvider, profile.id);
      return toUserInfo(profile);
    } catch (error) {
      const normalized = adapter.normalizeError(error);

      // 启动恢复只看本地凭据会把“过期 token”误判成已登录。
      // 当远端明确返回未授权（401/403）时，立即按退出流程清理本地登录态。
      if (this.isUnauthorizedError(normalized)) {
        log("restoreSession unauthorized, logging out:", activeProvider, normalized.message);
        await this.logout();
        return null;
      }

      log("restoreSession validation error:", activeProvider, normalized.message);

      throw normalized;
    }
  }

  async startOAuth(provider: OAuthProviderId): Promise<OAuthStartResponse> {
    return this.startOAuthInternal(provider);
  }

  async startOAuthWithPolling(provider: OAuthProviderId): Promise<OAuthStartResponse> {
    if (provider !== ZAI_PROVIDER_ID && provider !== BIGMODEL_PROVIDER_ID) {
      return this.startOAuthInternal(provider);
    }

    const adapter = this.getEnabledAdapter(provider);
    if (!this.apiClient) {
      throw new Error("ApiClient 注入缺失：OAuth polling 必须通过 Providers 传入 apiClient");
    }
    // 两个 init 并发时，先发但后返回的旧响应会覆盖较新的 pending flow。
    // generation 让最后一次用户操作拥有 flow，旧响应只结束自己的调用方。
    const startGeneration = ++this.oauthFlowStartGeneration;
    this.oauthFlowStartProvider = provider;
    this.clearPendingState();
    const pollToken = randomBytes(32).toString("hex");
    const initUrl = buildZCodeApiUrlFromEnv(this.env, "/api/v1/oauth/cli/init");
    const envelope = await readApiJson<OAuthFlowEnvelope>(this.apiClient, initUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pollToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ provider }),
    });
    if (this.oauthFlowStartGeneration !== startGeneration) {
      throw new Error("OAuth flow 已被新的登录请求替换");
    }
    this.oauthFlowStartProvider = null;
    const data = envelope.data;
    if (
      envelope.code !== 0 ||
      !isUnknownRecord(data) ||
      !readTrimmedString(data.flow_id) ||
      !readTrimmedString(data.authorize_url) ||
      !Number.isFinite(data.expires_at) ||
      !Number.isFinite(data.poll_interval_sec)
    ) {
      throw new Error(readTrimmedString(envelope.msg) || "OAuth flow 初始化响应无效");
    }

    const flowId = readTrimmedString(data.flow_id)!;
    const authorizeUrlString = readTrimmedString(data.authorize_url)!;
    const expiresAt = (data.expires_at as number) * 1_000;
    const pollIntervalMs = (data.poll_interval_sec as number) * 1_000;
    let authorizeUrl: URL;
    try {
      authorizeUrl = new URL(authorizeUrlString);
    } catch {
      throw new Error("OAuth flow 初始化响应无效");
    }
    if (provider === BIGMODEL_PROVIDER_ID) {
      // BigModel CLI callback 的失败页会截断原有 Desktop deep link 回调体验。
      // flow 仍由 Host 轮询，但浏览器回调恢复到官网中转页，再透传到 zcode://oauth/callback。
      authorizeUrl.searchParams.set("redirect", buildDesktopOAuthRedirectUriFromEnv(this.env));
    } else if (provider === ZAI_PROVIDER_ID) {
      // Z.AI 后端 init 仍可能返回 provider-specific callback，导致回跳行为与 BigModel 不一致。
      // Desktop 统一改写为官网中转页，再由官网透传到 zcode://oauth/callback。
      authorizeUrl.searchParams.set("redirect_uri", buildDesktopOAuthRedirectUriFromEnv(this.env));
    }
    const state = authorizeUrl.searchParams.get("state")?.trim();
    const remainingLifetimeMs = expiresAt - this.now();
    if (
      authorizeUrl.protocol !== "https:" ||
      !state ||
      !Number.isFinite(expiresAt) ||
      !Number.isFinite(pollIntervalMs) ||
      remainingLifetimeMs <= 0 ||
      pollIntervalMs < 1_000 ||
      pollIntervalMs >= remainingLifetimeMs
    ) {
      throw new Error("OAuth flow 初始化响应无效");
    }

    const timeoutMs = Math.min(OAUTH_TIMEOUT_MS, remainingLifetimeMs);
    const timeout = setTimeout(() => {
      const pending = this.pendingState;
      // polling flow 超时必须立即收口，不能等待下一次 UI 轮询；同时校验 flowId，避免旧定时器清掉新 flow。
      if (pending?.state === state && pending.polling?.flowId === flowId) {
        this.clearPendingState();
      }
    }, timeoutMs);
    this.pendingState = {
      state,
      provider: adapter.providerId,
      timeout,
      phase: "awaiting-attribution-or-code",
      polling: {
        expiresAt,
        flowId,
        nextPollAt: this.now(),
        pollIntervalMs,
        pollToken,
        pollUrl: buildZCodeApiUrlFromEnv(
          this.env,
          `/api/v1/oauth/cli/poll/${encodeURIComponent(flowId)}`,
        ),
      },
    };

    serviceLog.info("OAuth polling flow started", {
      expiresInMs: timeoutMs,
      pollIntervalMs,
      provider,
    });
    return { provider, authorizeUrl: authorizeUrl.toString(), state };
  }

  async pollPendingOAuth(): Promise<OAuthCallbackResult | null> {
    const apiClient = this.apiClient;
    if (!apiClient) {
      return null;
    }
    const pending = this.pendingState;
    const polling = pending?.polling;
    if (!pending || !polling) {
      return null;
    }
    if (this.now() >= polling.expiresAt) {
      this.clearPendingState();
      throw new Error("OAuth flow 已过期");
    }
    if (this.now() < polling.nextPollAt) {
      return null;
    }
    polling.nextPollAt = this.now() + polling.pollIntervalMs;

    let envelope: OAuthFlowEnvelope;
    try {
      envelope = await readApiJson<OAuthFlowEnvelope>(apiClient, polling.pollUrl, {
        headers: { Authorization: `Bearer ${polling.pollToken}` },
      });
    } catch (error) {
      if (this.pendingState !== pending) return null;
      if (
        error instanceof ApiError &&
        error.status &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408 &&
        error.status !== 429
      ) {
        try {
          return await this.runPendingSessionCompletion(pending, async () => {
            throw error;
          });
        } catch (terminalError) {
          if (this.pendingState === pending) this.clearPendingState();
          throw terminalError;
        }
      }
      // 轮询是 deep link 丢失时的可靠路径，单次断网或 5xx 不能立即取消 flow。
      // 保留服务端下发的查询间隔，下一轮继续尝试；高频状态只记 debug，避免生产日志膨胀。
      serviceLog.debug("OAuth polling request will retry", {
        error: error instanceof Error ? error.message : String(error),
        provider: pending.provider,
      });
      return null;
    }
    if (this.pendingState !== pending) {
      return null;
    }
    if (
      envelope.code === 0 &&
      isUnknownRecord(envelope.data) &&
      readTrimmedString(envelope.data.status) === "pending"
    ) {
      return null;
    }
    try {
      const result = await this.runPendingSessionCompletion(pending, async () => {
        const pollData = envelope.data;
        if (envelope.code !== 0 || !isUnknownRecord(pollData)) {
          throw new Error(readTrimmedString(envelope.msg) || "OAuth flow 查询响应无效");
        }
        const status = readTrimmedString(pollData.status);
        if (status === "failed") {
          throw new Error("OAuth flow 授权失败");
        }
        if (status !== "ready") {
          throw new Error("OAuth flow 查询响应无效");
        }

        const ready = pollData;
        const user = isUnknownRecord(ready.user) ? ready.user : null;
        const zai = isUnknownRecord(ready.zai) ? ready.zai : null;
        const bigmodel = isUnknownRecord(ready.bigmodel) ? ready.bigmodel : null;
        const providerAccessToken =
          pending.provider === ZAI_PROVIDER_ID
            ? readTrimmedString(zai?.access_token)
            : readTrimmedString(bigmodel?.access_token) || readTrimmedString(bigmodel?.accessToken);
        const zcodeJwtToken = readTrimmedString(ready.token);
        const userId = readTrimmedString(user?.user_id);
        if (!zcodeJwtToken || !providerAccessToken || !userId) {
          throw new Error("OAuth flow 查询响应无效");
        }
        const username = readTrimmedString(user?.name) || readTrimmedString(user?.email) || userId;
        const avatarUrl = readTrimmedString(user?.avatar);
        const profile: OAuthUserProfile = {
          id: userId,
          username,
          displayName: username,
          ...(avatarUrl ? { avatarUrl } : {}),
          rawProfile: user,
        };
        const adapter = this.getAdapter(pending.provider);
        const refreshToken =
          pending.provider === BIGMODEL_PROVIDER_ID
            ? readTrimmedString(bigmodel?.refresh_token) ||
              readTrimmedString(bigmodel?.refreshToken)
            : undefined;
        const tokenSet = adapter.normalizePolledTokenSet
          ? await adapter.normalizePolledTokenSet({
              accessToken: providerAccessToken,
              zcodeJwtToken,
              ...(refreshToken ? { refreshToken } : {}),
            })
          : {
              accessToken: providerAccessToken,
              zcodeJwtToken,
              ...(refreshToken ? { refreshToken } : {}),
            };
        return { tokenSet, profile };
      });
      if (result?.kind === "session") {
        serviceLog.info("OAuth polling flow completed", { provider: pending.provider });
      }
      return result;
    } catch (error) {
      if (this.pendingState === pending) this.clearPendingState();
      throw error;
    }
  }

  private async startOAuthInternal(provider: OAuthProviderId): Promise<OAuthStartResponse> {
    const adapter = this.getEnabledAdapter(provider);

    // 同窗口快速连续点击不同 provider 时，旧 state 如果不先取消，
    // 两条并发流程会共享同一回调通道，导致后回调抢占前回调并触发 state 错配。
    await this.runSessionMutation(async () => {
      this.oauthFlowStartGeneration += 1;
      this.oauthFlowStartProvider = null;
      this.clearPendingState();
    });

    const state = randomBytes(32).toString("hex");
    const timeout = setTimeout(() => {
      if (this.pendingState?.state === state) {
        this.pendingState = null;
      }
    }, OAUTH_TIMEOUT_MS);

    this.pendingState = {
      state,
      provider: adapter.providerId,
      timeout,
      phase: "awaiting-attribution-or-code",
    };

    const authorizeUrl = adapter.buildAuthorizeUrl({
      providerId: adapter.providerId,
      state,
      redirectUri: adapter.redirectUri,
      now: this.now,
    });

    return {
      provider: adapter.providerId,
      authorizeUrl,
      state,
    };
  }

  async handleCallback(url: string): Promise<OAuthCallbackResult | null> {
    const pending = this.pendingState;
    if (!pending) {
      const callbackState = new URL(url).searchParams.get("state")?.trim();
      const completed = this.recentlyCompletedPollingState;
      if (
        callbackState &&
        completed?.state === callbackState &&
        completed.generation === this.oauthFlowStartGeneration &&
        this.now() < completed.expiresAt
      ) {
        const attribution = parseOAuthLoginAttribution(new URL(url).searchParams);
        await this.runSessionMutation(async () => {
          // 修复原因：轮询先成功时仍需保存浏览器归因，不能把登录去重当作丢弃整条回调。
          if (
            !this.pendingState &&
            this.recentlyCompletedPollingState === completed &&
            completed.generation === this.oauthFlowStartGeneration &&
            attribution
          ) {
            await this.repo.saveLoginAttribution(attribution);
          }
        });
        return { kind: "duplicate", provider: completed.provider };
      }
      throw new Error("OAuth state 不匹配或已过期");
    }

    const parsedUrl = new URL(url);
    const state = parsedUrl.searchParams.get("state");
    if (!state || state !== pending.state) {
      throw new Error("OAuth state 不匹配或已过期");
    }
    if (pending.polling && this.now() >= pending.polling.expiresAt) {
      this.clearPendingState();
      throw new Error("OAuth flow 已过期");
    }

    const attribution = parseOAuthLoginAttribution(parsedUrl.searchParams);
    if (attribution && !hasOAuthAuthorizationCode(parsedUrl.searchParams)) {
      if (pending.phase === "awaiting-code-after-attribution") {
        throw new Error("OAuth 归因回调已处理");
      }

      // 修复原因：纯归因回调是最终授权码前的中转步骤，不能清掉仍需继续登录的 state；
      // 但若不显式推进 phase，同一 state 可重复写入归因并隐式复用 pending 生命周期。
      pending.phase = "awaiting-code-after-attribution";
      try {
        await this.repo.saveLoginAttribution(attribution);
      } catch (error) {
        if (this.pendingState === pending) {
          pending.phase = "awaiting-attribution-or-code";
        }
        throw error;
      }
      return {
        kind: "attribution",
        provider: pending.provider,
        attribution,
      };
    }

    const adapter = this.getAdapter(pending.provider);
    const fallbackProfile: OAuthUserProfile = {
      id: "unknown",
      username: "user",
      displayName: "User",
    };

    return this.runPendingSessionCompletion(
      pending,
      async () => {
        const callback = adapter.parseCallbackParams(url);
        const context = {
          providerId: adapter.providerId,
          state: callback.state,
          redirectUri: adapter.redirectUri,
          now: this.now,
        };
        const tokenSet = await this.runWithAdapterError(adapter, () =>
          adapter.exchangeToken(callback, context),
        );
        let profile = fallbackProfile;
        if (adapter.fetchUserInfo) {
          try {
            profile = await this.runWithAdapterError(adapter, () =>
              adapter.fetchUserInfo!(tokenSet, context),
            );
          } catch {
            // 获取用户信息失败不阻塞登录
          }
        }
        return { tokenSet, profile };
      },
      attribution ? () => this.repo.saveLoginAttribution(attribution) : undefined,
    );
  }

  async refreshToken(provider?: OAuthProviderId): Promise<void> {
    const generation = this.oauthSessionGeneration;
    const targetProvider = await this.resolveProvider(provider);
    if (!targetProvider) {
      throw new Error("当前没有可用的登录 provider");
    }

    const adapter = this.getEnabledAdapter(targetProvider);
    if (!adapter.refreshToken) {
      throw new Error(
        `${adapter.meta.displayName} OAuth 暂未提供 refresh token 交换接口，请重新登录`,
      );
    }

    const activeProvider = await this.repo.getActiveProvider();
    if (targetProvider !== activeProvider) {
      throw new Error("只能刷新当前 App 登录 provider，请重新登录");
    }

    const tokenSet = await this.repo.loadActiveTokenSet();
    if (!tokenSet?.refreshToken) {
      throw new Error("当前账号缺少 refresh_token，请重新登录");
    }

    const refreshed = await this.runWithAdapterError(adapter, () =>
      adapter.refreshToken!(tokenSet, {
        providerId: targetProvider,
        state: "",
        redirectUri: adapter.redirectUri,
        now: this.now,
      }),
    );

    await this.runSessionMutation(async () => {
      // 刷新写回若绕过会话队列，会插入 401 的核对/清理窗口，或在退出后复活凭据。
      if (
        this.oauthSessionGeneration !== generation ||
        (await this.repo.getActiveProvider()) !== targetProvider ||
        (await this.credentialService.load(`oauth:${targetProvider}:access_token`)) !==
          tokenSet.accessToken
      )
        return;
      await this.repo.saveActiveTokenSet(refreshed);
    });
  }

  /** Host 本地 401 提交入口，不扩展 IOAuthService 的跨端契约。 */
  logoutIfCurrentCredentialRequest(input: string | URL, headers: Headers): Promise<boolean> {
    return this.logoutActiveSession(() =>
      isCurrentOAuthCredentialRequest({
        input,
        headers,
        credentialService: this.credentialService,
        env: this.env,
      }),
    );
  }

  private async logoutActiveSession(isCurrent?: () => Promise<boolean>): Promise<boolean> {
    const result = await this.runSessionMutation(async () => {
      // 异步分类的 true 不是清理授权；凭据复核与清理必须和登录写入共用队列。
      if (isCurrent && !(await isCurrent())) return null;
      const activeProvider = await this.repo.getActiveProvider();
      // 合并边界：清理前保留原账号身份，不能退回仅按平台清理或在退出后再猜身份。
      const accountIdentity = activeProvider
        ? ((await this.repo.loadUserProfile(activeProvider))?.id ?? null)
        : null;
      this.oauthSessionGeneration += 1;
      await this.repo.clearActiveSession();
      return { activeProvider, accountIdentity };
    });
    if (!result) return false;
    if (result.activeProvider) {
      await this.cancelPending(result.activeProvider);
      try {
        await this.notifyProviderLogout(result.activeProvider, result.accountIdentity);
      } catch (error) {
        if (!isCurrent) throw error;
        // 凭据已经清理，派生配置失败不能吞掉原有过期提示；手动退出仍保留原错误语义。
        serviceLog.warn("Unauthorized session provider cleanup failed", { error });
      }
    }
    return true;
  }

  async logout(provider?: OAuthProviderId): Promise<void> {
    if (!provider) {
      await this.logoutActiveSession();
      return;
    }

    const loggedOutIdentity = await this.runSessionMutation(async () => {
      const activeProvider = await this.repo.getActiveProvider();
      if (provider !== activeProvider) {
        return undefined;
      }
      const accountIdentity = (await this.repo.loadUserProfile(provider))?.id ?? null;
      this.oauthSessionGeneration += 1;
      // ZAI/BigModel provider 的 Unlink 已收敛为 App logout。
      // 只有当前 active provider 才代表登录事实，避免旧 unlink 路径误删非当前 provider token。
      await this.repo.clearActiveSession();
      return accountIdentity;
    });
    if (loggedOutIdentity !== undefined) {
      await this.notifyProviderLogout(provider, loggedOutIdentity);
    }
    await this.cancelPending(provider);
  }

  async logoutAll(): Promise<void> {
    const providers = [...this.adapters.keys()];
    const accountIdentities = await this.runSessionMutation(async () => {
      const identities = new Map<OAuthProviderId, string | null>();
      for (const provider of providers) {
        identities.set(provider, (await this.repo.loadUserProfile(provider))?.id ?? null);
      }
      this.oauthSessionGeneration += 1;
      await this.repo.clearAll(providers);
      return identities;
    });
    await this.cancelPending();
    await this.notifyProvidersLogout(providers, accountIdentities);
  }

  async cancelPending(provider?: OAuthProviderId): Promise<void> {
    if (!this.pendingState) {
      if (provider && this.oauthFlowStartProvider && this.oauthFlowStartProvider !== provider)
        return;
      this.oauthFlowStartGeneration += 1;
      this.oauthFlowStartProvider = null;
      return;
    }
    if (provider && this.pendingState.provider !== provider) return;
    this.oauthFlowStartGeneration += 1;
    this.oauthFlowStartProvider = null;
    this.clearPendingState();
  }

  private clearPendingState(): void {
    if (!this.pendingState) {
      return;
    }

    clearTimeout(this.pendingState.timeout);
    this.pendingState = null;
  }

  private async notifyProviderLogout(
    provider: OAuthProviderId,
    accountIdentity?: string | null,
  ): Promise<void> {
    if (!this.onProviderLogout) {
      return;
    }

    await this.onProviderLogout(provider, accountIdentity);
  }

  private async notifyProvidersLogout(
    providers: readonly OAuthProviderId[],
    accountIdentities: ReadonlyMap<OAuthProviderId, string | null> = new Map(),
  ): Promise<void> {
    await Promise.all(
      providers.map((provider) =>
        this.notifyProviderLogout(provider, accountIdentities.get(provider)),
      ),
    );
  }

  private getAdapter(provider: OAuthProviderId): OAuthProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(`不支持的 OAuth provider: ${provider}`);
    }

    return adapter;
  }

  private getEnabledAdapter(provider: OAuthProviderId): OAuthProviderAdapter {
    const adapter = this.getAdapter(provider);
    if (!adapter.meta.enabled) {
      throw new Error(`OAuth provider 未启用: ${provider}`);
    }

    return adapter;
  }

  private async resolveProvider(provider?: OAuthProviderId): Promise<OAuthProviderId | null> {
    if (provider) {
      return provider;
    }

    return this.repo.getActiveProvider();
  }

  private async runWithAdapterError<T>(
    adapter: OAuthProviderAdapter,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw adapter.normalizeError(error);
    }
  }

  private isUnauthorizedError(error: Error): boolean {
    const lowerMessage = error.message.toLowerCase();
    return (
      /\b401\b|\b403\b/.test(lowerMessage) ||
      lowerMessage.includes("unauthorized") ||
      lowerMessage.includes("forbidden")
    );
  }
}

/**
 * 工厂函数：创建 OAuthService 实例
 */
export function createOAuthService(
  credentialService: ICredentialService,
  dependencies: Omit<OAuthServiceDependencies, "adapters"> = {},
): OAuthService {
  return new OAuthService(credentialService, {
    ...dependencies,
    adapters: createOAuthProviderAdapters(createOAuthRuntimeConfig(dependencies.env), {
      apiClient: dependencies.apiClient,
    }),
  });
}
