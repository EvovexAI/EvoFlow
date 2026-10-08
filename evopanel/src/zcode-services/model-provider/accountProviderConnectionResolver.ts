import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  AccountProviderUnavailableReason,
  AccountProviderConnectionResolver,
  AccountProviderConnectionResult,
  ProviderConfigSnapshot,
  ProviderSource,
} from "@zcode/provider";
import { AccountProviderService, createAccountProviderConfigResolver } from "@zcode/provider";
import {
  type ApiClient,
  type ProviderFamilyConnectionSelectionSettings,
  type ProviderFamilyDomain,
  type ZCodeAccountAccess,
  type ZCodeProviderAccountAccess,
} from "@zcode/shared";
import type {
  CodingPlanAvailabilityProvider,
  CodingPlanAvailabilityResult,
  CodingPlanUnavailableReason,
} from "#src/model-provider/codingPlanProviderAvailability.js";
import {
  validateBigModelAccountProviderAvailability,
  validateZaiAccountProviderAvailability,
} from "#src/model-provider/codingPlanProviderAvailability.js";

export interface AccountProviderConnectionSettings {
  readonly providerFamilyDomain: ProviderFamilyDomain | null;
  readonly selections: ProviderFamilyConnectionSelectionSettings;
  /** Host 旧连接导入尚不能确定身份；仅运行时事实，不写入配置或协议。 */
  readonly unresolvedFamilies?: readonly ProviderFamilyDomain[];
}

export interface AccountProviderFamilyAvailabilityInput {
  readonly family: ProviderFamilyDomain;
  readonly providers: readonly CodingPlanAvailabilityProvider[];
  readonly selections: ProviderFamilyConnectionSelectionSettings;
}

export type AccountProviderFamilyAvailabilityResolver = (
  input: AccountProviderFamilyAvailabilityInput,
) => Promise<Partial<Record<string, CodingPlanAvailabilityResult>>>;

export interface AccountProviderConnectionResolverOptions {
  readonly readSettings: () => Promise<AccountProviderConnectionSettings>;
  readonly loadCodingPlanApiKey: (
    providerId: string,
    family: ProviderFamilyDomain,
    accountIdentity: string,
    forceRefresh: boolean,
  ) => Promise<string | null>;
  readonly loadAccountIdentity: (family: ProviderFamilyDomain) => Promise<string | null>;
  readonly resolveFamilyAvailability: AccountProviderFamilyAvailabilityResolver;
}

export interface CodingPlanFamilyAvailabilityResolverOptions {
  readonly apiClient: ApiClient;
  readonly credentialService?: {
    load(key: string): Promise<string | null>;
  };
}

export interface AccountProviderConfigSourceOptions extends AccountProviderConnectionResolverOptions {
  readonly configSource: ProviderSource<ProviderConfigSnapshot>;
}

/**
 * 把现有账号域、连接模式和套餐权益统一投影为领域层 Connection Result。
 *
 * 该适配器不保存凭据。Personal Coding Plan Key 的物理来源由注入端决定；
 * Start/Team 的动态凭据继续由现有 availability 依赖按请求读取。
 */
export function createAccountProviderConnectionResolver(
  options: AccountProviderConnectionResolverOptions,
): AccountProviderConnectionResolver {
  let previousScopes = new Map<string, string>();
  return async ({ configuredProviders, reasons = [] }) => {
    const settings = structuredClone(await options.readSettings());
    const forceCredentialRefresh = reasons.some(isCredentialRefreshReason);
    const accountIdentityByFamily = new Map<ProviderFamilyDomain, Promise<string | null>>();
    const loadAccountIdentity = (family: ProviderFamilyDomain) => {
      const existing = accountIdentityByFamily.get(family);
      if (existing) return existing;
      const pending = options.loadAccountIdentity(family).then((identity) => {
        const normalized = identity?.trim() ?? "";
        return normalized || null;
      });
      accountIdentityByFamily.set(family, pending);
      return pending;
    };
    const availabilityByProviderId = new Map<string, CodingPlanAvailabilityResult>();

    for (const family of ["zai", "bigmodel"] as const) {
      const configured = configuredProviders
        .entries()
        .flatMap(([providerId, config]) =>
          config.access?.type === "zhipu-account" &&
          config.access.accountType === family &&
          config.access.mode &&
          config.access.mode !== "off-peak"
            ? [{ providerId, config, planKind: config.access.mode }]
            : [],
        );
      if (configured.length === 0) continue;

      // 旧团队身份补全只限制付费访问，Start 只依赖当前登录账号。
      const queryable = configured.filter(({ providerId, planKind }) => {
        if (settings.unresolvedFamilies?.includes(family) && planKind !== "start-plan") {
          availabilityByProviderId.set(providerId, { kind: "unknown" });
          return false;
        }
        return true;
      });
      if (queryable.length === 0) continue;

      const accountIdentity = await loadAccountIdentity(family);
      if (!accountIdentity) {
        for (const { providerId } of queryable) {
          availabilityByProviderId.set(providerId, {
            kind: "unavailable",
            reason: "coding_plan_not_connected",
          });
        }
        continue;
      }

      const availabilityProviders = await Promise.all(
        queryable.map(async ({ providerId, planKind }) => ({
          providerId,
          family,
          planKind,
          apiKey:
            planKind !== "team-coding-plan"
              ? await options
                  .loadCodingPlanApiKey(providerId, family, accountIdentity, forceCredentialRefresh)
                  .catch(() => null)
              : null,
        })),
      );
      const resolved = await options.resolveFamilyAvailability({
        family,
        providers: availabilityProviders,
        selections: settings.selections,
      });
      for (const { providerId } of queryable) {
        availabilityByProviderId.set(providerId, resolved[providerId] ?? { kind: "unknown" });
      }
    }

    const connections: AccountProviderConnectionResult[] = [];
    const scopes = new Map<string, string>();
    for (const [providerId, config] of configuredProviders.entries()) {
      const access = config.access;
      if (access?.type !== "zhipu-account") continue;
      if (!access.accountType || !access.mode) {
        connections.push({ providerId, status: "unavailable" });
        continue;
      }
      const selection = settings.selections[access.accountType];
      // last-known-good 只对同账号、同 Team 身份成立。切账号后的网络失败不能复活旧权益。
      const scope = JSON.stringify([
        await loadAccountIdentity(access.accountType),
        access.mode === "team-coding-plan" && selection?.kind === "team-coding-plan"
          ? [selection.organizationId, selection.projectId, selection.productId]
          : null,
      ]);
      scopes.set(providerId, scope);
      const resetPrevious =
        previousScopes.has(providerId) && previousScopes.get(providerId) !== scope;
      if (access.mode === "off-peak") {
        const selectedPlanKind = selection?.kind;
        const matchingPlanAvailable =
          settings.providerFamilyDomain === access.accountType &&
          (selectedPlanKind === "individual-coding-plan" ||
            selectedPlanKind === "team-coding-plan") &&
          configuredProviders
            .entries()
            .some(
              ([candidateId, candidate]) =>
                candidate.access?.type === "zhipu-account" &&
                candidate.access.accountType === access.accountType &&
                candidate.access.mode === selectedPlanKind &&
                availabilityByProviderId.get(candidateId)?.kind === "available",
            );
        connections.push({
          providerId,
          status: matchingPlanAvailable ? "available" : "unavailable",
        });
        continue;
      }
      const availability = availabilityByProviderId.get(providerId) ?? {
        kind: "unknown" as const,
      };
      connections.push({
        providerId,
        status: availability.kind,
        // 原因必须随连接结果一起发布。UI 拿不到原因时只能把"已登录但无套餐"
        // 也显示成"未连接"。
        ...(availability.kind === "unavailable"
          ? {
              unavailableReason: resolveAccountUnavailableReason(availability.reason),
            }
          : {}),
        // Start 跟随登录身份，付费套餐跟随连接选择；两者可同时 current，不改写权益或配置。
        current:
          settings.providerFamilyDomain === access.accountType &&
          (access.mode === "start-plan"
            ? Boolean(await loadAccountIdentity(access.accountType))
            : selection?.kind === access.mode),
        // 两个 Team 共用 Provider ID，观察器必须按同一快照中的完整身份比较，
        // 不能把手动换套餐/账号误当成原套餐失效。它只进入 Account State，不进入 Config。
        connectionKey: createHash("sha256")
          .update(
            JSON.stringify([
              await loadAccountIdentity(access.accountType),
              access.accountType,
              access.mode === "start-plan" ? { kind: "start-plan" } : (selection ?? null),
            ]),
          )
          .digest("hex"),
        ...("models" in availability ? { models: availability.models } : {}),
        ...("effectiveAt" in availability ? { effectiveAt: availability.effectiveAt } : {}),
        ...(resetPrevious ? { resetPrevious: true } : {}),
      });
    }
    // 权益查询可能跨越切账号/套餐，旧设置与新身份会被拼成可发布结果。
    // 发布前核对本轮作用域；失败时也不能推进 previousScopes，否则下一轮会把
    // 未发布的账号误认作 last-known-good。重试继续由现有刷新事件驱动。
    const identitiesUnchanged = await Promise.all(
      [...accountIdentityByFamily].map(
        async ([family, captured]) =>
          (await captured) === ((await options.loadAccountIdentity(family))?.trim() || null),
      ),
    );
    if (
      identitiesUnchanged.some((unchanged) => !unchanged) ||
      !isDeepStrictEqual(settings, await options.readSettings())
    ) {
      throw new Error("账号查询期间连接或身份发生变化，丢弃过期结果");
    }
    previousScopes = scopes;
    return Object.freeze(connections);
  };
}

function isCredentialRefreshReason(reason: string): boolean {
  // ProviderSettingsFacade 会给登录刷新原因添加 settings: 前缀；漏匹配会在
  // 同账号重新登录后继续复用失效 Key。按原因末段精确匹配，普通刷新仍复用缓存。
  return (
    reason.includes("oauth-callback") || reason.split(":").at(-1) === "oauth-login-entitlement"
  );
}

/**
 * 把 Coding Plan 可用性原因投影为账号域原因。
 * Account State 是跨 family 的通用事实，不直接沿用 Coding Plan 内部枚举；
 * UI 只依赖这里的稳定语义，不认识套餐查询实现。
 */
function resolveAccountUnavailableReason(
  reason: CodingPlanUnavailableReason,
): AccountProviderUnavailableReason {
  switch (reason) {
    case "coding_plan_not_authenticated":
      return "not-authenticated";
    case "coding_plan_not_connected":
      return "not-connected";
    case "coding_plan_auth_failed":
      return "credential-failed";
    case "coding_plan_not_entitled":
      return "not-entitled";
  }
}

/** 组装 Config、账号连接解析与第三层 Account Provider Config Source。 */
export function createAccountProviderConfigSource(
  options: AccountProviderConfigSourceOptions,
): AccountProviderService {
  return new AccountProviderService({
    configSource: options.configSource,
    resolve: createAccountProviderConfigResolver(createAccountProviderConnectionResolver(options)),
  });
}

/** 用当前稳定的 Plan 查询实现生产 Family Availability Port。 */
export function createCodingPlanFamilyAvailabilityResolver(
  options: CodingPlanFamilyAvailabilityResolverOptions,
): AccountProviderFamilyAvailabilityResolver {
  return ({ family, providers, selections }) => {
    const context = {
      apiClient: options.apiClient,
      credentialService: options.credentialService,
      providerFamilyConnectionSelections: selections,
    };
    return family === "zai"
      ? validateZaiAccountProviderAvailability(providers, context)
      : validateBigModelAccountProviderAvailability(providers, context);
  };
}

/**
 * 把 Active Model 的静态 Access 约束投影到当前账号连接。
 *
 * Team scope 和账号版本不能冻结进 Model：账号切换后旧 Model 会错误失效。
 * 每次请求重新读取当前选择；只有 family 与 mode 兼容时才返回动态访问事实。
 */
export async function resolveCurrentAccountAccess(input: {
  readonly access: ZCodeProviderAccountAccess;
  readonly readSettings: () => Promise<AccountProviderConnectionSettings>;
  readonly loadAccountIdentity: (family: ProviderFamilyDomain) => Promise<string | null>;
}): Promise<ZCodeAccountAccess | null> {
  const settings = await input.readSettings();
  const { accountType, mode } = input.access;
  if (settings.providerFamilyDomain !== accountType) return null;
  if (mode === "start-plan") {
    if (!(await input.loadAccountIdentity(accountType))?.trim()) return null;
    return { type: "zhipu-account", family: accountType, planKind: "start-plan" };
  }
  const selection = settings.selections[accountType];
  if (!selection) return null;
  if (mode === "off-peak") {
    if (selection.kind !== "individual-coding-plan" && selection.kind !== "team-coding-plan") {
      return null;
    }
  } else if (selection.kind !== mode) {
    return null;
  }
  if (!(await input.loadAccountIdentity(accountType))?.trim()) return null;
  if (selection.kind === "team-coding-plan") {
    return {
      type: "zhipu-account",
      family: accountType,
      planKind: selection.kind,
      productId: selection.productId,
      organizationId: selection.organizationId,
      projectId: selection.projectId,
    };
  }
  return {
    type: "zhipu-account",
    family: accountType,
    planKind: selection.kind,
  };
}
