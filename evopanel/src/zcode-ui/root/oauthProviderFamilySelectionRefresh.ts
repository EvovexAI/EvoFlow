import type { IServiceAccessor } from "@zcode/services";
import type { AccountProviderState } from "@zcode/provider";
import type {
  OAuthProviderId,
  UsageEntitlementSnapshot,
  ZCodeAccountAccess,
  ZCodeProviderAccountAccess,
} from "@zcode/shared";
import {
  getModelProviderFamilySpec,
  resolveProviderFamilyDomainFromOAuthProvider,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import { resolveAccountProviderInspectionAccess } from "@/lib/accountProviderAccess.js";
import {
  type ModelProviderFamilyConnectionSelection,
  resolveAutomaticModelProviderFamilyConnectionSelection,
} from "@/lib/modelProviderFamilyConnectionSelection.js";

import { getEnterprisePricingProductsOrEmpty } from "@/root/oauthTeamPricing.js";

function resolveModelProviderFamilySpecFromOAuth(
  provider: OAuthProviderId | string,
): ReturnType<typeof getModelProviderFamilySpec> | null {
  const family = resolveProviderFamilyDomainFromOAuthProvider(provider);
  return family ? getModelProviderFamilySpec(family) : null;
}

async function getUsageEntitlementSnapshotOrNull(params: {
  services: IServiceAccessor;
  providerId: string;
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess;
}): Promise<UsageEntitlementSnapshot | null> {
  try {
    return await params.services.usageStatsService.getEntitlementSnapshot({
      includeSubscription: true,
      preferredProviderId: params.providerId,
      accountAccess: params.accountAccess,
      allowDisabledPreferredProvider: true,
      requirePreferredProvider: true,
      allowEnvApiKey: false,
    });
  } catch (error) {
    logger.warn("[Root] 刷新登录后权益快照失败", {
      providerId: params.providerId,
      error,
    });
    return null;
  }
}

async function refreshAccountProviderAccesses(params: {
  services: IServiceAccessor;
  providerIds: readonly string[];
  reason: string;
}): Promise<{
  accesses: ReadonlyMap<string, ZCodeProviderAccountAccess | ZCodeAccountAccess>;
  states: ReadonlyMap<string, AccountProviderState>;
  refreshed: boolean;
  error?: unknown;
}> {
  const providerSettingsService = params.services.providerSettingsService;

  try {
    const view = await providerSettingsService.refresh(params.reason);
    const accesses = new Map(
      params.providerIds.flatMap((providerId) => {
        const resolved = resolveAccountProviderInspectionAccess(view, providerId);
        if (!resolved) return [];
        const access = resolved.access;
        // 登录/启动检查属于套餐只读查询。静态 mode 会经执行期 current 解析，
        // 把未选中或 pending 的 Start 当作当前 Coding 查询；此处必须明确查询套餐自身。
        const query: ZCodeProviderAccountAccess | ZCodeAccountAccess =
          access.mode === "start-plan" || access.mode === "individual-coding-plan"
            ? { type: "zhipu-account", family: access.accountType, planKind: access.mode }
            : access;
        return [[providerId, query] as const];
      }),
    );
    return {
      refreshed: true,
      accesses,
      states: new Map(
        view.providers.flatMap((provider) =>
          provider.accountState ? [[provider.providerId, provider.accountState] as const] : [],
        ),
      ),
    };
  } catch (error) {
    logger.warn("[Root] 刷新 Account Provider 访问身份失败", {
      providerIds: params.providerIds,
      error,
    });
    return { refreshed: false, accesses: new Map(), states: new Map(), error };
  }
}

export async function refreshLatestModelProviderFamilySelectionAfterLogin(params: {
  provider: OAuthProviderId;
  services: IServiceAccessor;
}): Promise<ModelProviderFamilyConnectionSelection | null> {
  const domain = resolveProviderFamilyDomainFromOAuthProvider(params.provider);
  if (!domain) {
    return null;
  }

  const familySpec = resolveModelProviderFamilySpecFromOAuth(params.provider);
  if (!familySpec) return null;
  // 登录查询也有网络等待，条件写入必须基于查询前的意图，而非回包后的选择。
  const currentSettings = await params.services.settingService.get();
  const expectedAccountSettings = {
    providerFamilyDomain: currentSettings.providerFamilyDomain,
    providerFamilyConnectionSelections: currentSettings.providerFamilyConnectionSelections,
  };
  const codingPlanProviderId = familySpec.individualCodingPlanProviderId;
  const startPlanProviderId = familySpec.startPlanProviderId;
  const codingPlanProviderIds = [
    familySpec.individualCodingPlanProviderId,
    familySpec.startPlanProviderId,
    familySpec.teamCodingPlanProviderId,
  ];
  const { accesses, states, refreshed } = await refreshAccountProviderAccesses({
    services: params.services,
    providerIds: codingPlanProviderIds,
    reason: "oauth-login-entitlement",
  });
  if (!refreshed) return null;
  // 登录后的刷新也可能仍在等待旧 Team 补组织；未知不是可按排序重选的首次连接。
  if (
    !currentSettings.providerFamilyConnectionSelections?.[domain] &&
    codingPlanProviderIds.every((id) => states.get(id)?.availability === "unknown")
  )
    return null;

  const [codingPlanEntitlement, startPlanEntitlement, teamProducts] = await Promise.all([
    getUsageEntitlementSnapshotOrNull({
      services: params.services,
      providerId: codingPlanProviderId,
      accountAccess: accesses.get(codingPlanProviderId),
    }),
    getUsageEntitlementSnapshotOrNull({
      services: params.services,
      providerId: startPlanProviderId,
      accountAccess: accesses.get(startPlanProviderId),
    }),
    getEnterprisePricingProductsOrEmpty(params.services, domain),
  ]);
  // 旧 Start 连接只保留读取，不以权益失效为由删除或自动替换成付费连接。
  const savedSelection = currentSettings.providerFamilyConnectionSelections?.[domain];
  if (savedSelection?.kind === "start-plan") return savedSelection;
  const selection = resolveAutomaticModelProviderFamilyConnectionSelection({
    providerFamilyDomain: domain,
    codingPlanEntitlement,
    startPlanEntitlement,
    teamProducts,
    codingPlanAvailable: states.has(codingPlanProviderId)
      ? states.get(codingPlanProviderId)!.availability === "available"
      : undefined,
    startPlanAvailable: states.has(startPlanProviderId)
      ? states.get(startPlanProviderId)!.availability === "available"
      : undefined,
  });
  if (!selection) {
    return null;
  }

  await params.services.settingService.update(
    {
      providerFamilyConnectionSelections: {
        ...currentSettings.providerFamilyConnectionSelections,
        [domain]: selection,
      },
    },
    expectedAccountSettings,
  );
  return selection;
}

export async function refreshRestoredOAuthProviderFamilyAfterStartup(params: {
  activeProvider: OAuthProviderId | null;
  services: IServiceAccessor;
  refreshAppSettings?: () => Promise<void>;
}): Promise<ModelProviderFamilyConnectionSelection | null> {
  if (!params.activeProvider) return null;
  const domain = resolveProviderFamilyDomainFromOAuthProvider(params.activeProvider);
  if (!domain) return null;
  const settings = await params.services.settingService.get();
  if (settings.providerFamilyDomain && settings.providerFamilyDomain !== domain) return null;
  const saved = settings.providerFamilyConnectionSelections?.[domain];
  if (saved) {
    // 原因：启动时的不可用不是本次运行中发生的失效，不能替用户更换已保存连接。
    // 刷新账号事实仍照常执行；只有后续真实失效提示的点击动作允许选择替代套餐。
    try {
      await params.services.providerSettingsService.refresh("oauth-restore-entitlement");
    } catch (error) {
      logger.warn("[Root] 启动账号刷新失败，保留原连接", { error });
    }
    return saved;
  }
  try {
    // 仅真正没有选择才沿用首次初始化；该入口保留旧连接待迁移的 unknown 保护及条件写入。
    const selection = await refreshLatestModelProviderFamilySelectionAfterLogin({
      provider: params.activeProvider,
      services: params.services,
    });
    if (selection) await params.refreshAppSettings?.();
    return selection;
  } catch (error) {
    logger.warn("[Root] 启动初始化连接失败", { error });
    return null;
  }
}
