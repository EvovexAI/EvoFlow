import type { IServiceAccessor, ProviderSettingsView } from "@zcode/services";
import type { ProviderFamilyConnectionSelection } from "@zcode/shared";
import type { AccountConnectionLoss } from "@/root/accountConnectionRefreshObserver.js";
import {
  resolveFirstSubscribedTeamPlanConnectionWithContext,
  resolveModelProviderFamilyConnectionProviderId,
} from "@/lib/modelProviderFamilyConnectionSelection.js";
import { hasActiveUsageEntitlementSnapshot } from "@/lib/codingPlanProvider.js";
import { getEnterprisePricingProducts } from "@/root/oauthTeamPricing.js";
import { logger } from "@/logger.js";

/** 只计算建议，不替用户保存；闭包固定按钮展示的那个目标，点击时重新校验。 */
export async function prepareAccountConnectionSwitch(
  services: IServiceAccessor,
  event: AccountConnectionLoss,
) {
  const settings = await services.settingService.get();
  const family = settings.providerFamilyDomain;
  const original = family && settings.providerFamilyConnectionSelections?.[family];
  if (!family || !original || original.kind === "start-plan" || !event.isCurrent()) return null;
  if (
    resolveModelProviderFamilyConnectionProviderId({
      providerFamilyDomain: family,
      selection: original,
    }) !== event.providerId
  )
    return null;
  const expected = {
    providerFamilyDomain: family,
    providerFamilyConnectionSelections: settings.providerFamilyConnectionSelections,
  };
  const isOriginal = (view: ProviderSettingsView) => {
    const state = view.providers.find((p) => p.providerId === event.providerId)?.accountState;
    return (
      event.isCurrent() &&
      state?.current === true &&
      state.connectionKey === event.connectionKey &&
      state.availability === "unavailable"
    );
  };
  const view = await services.providerSettingsService.getView();
  if (!isOriginal(view)) return null;
  const isAvailable = async (
    selection: ProviderFamilyConnectionSelection,
    snapshot: ProviderSettingsView,
  ) => {
    const providerId = resolveModelProviderFamilyConnectionProviderId({
      providerFamilyDomain: family,
      selection,
    });
    if (selection.kind !== "team-coding-plan")
      return (
        snapshot.providers.find((p) => p.providerId === providerId)?.accountState?.availability ===
        "available"
      );
    // 未选中的 Team 没有可复用的 current 事实。按按钮的具体组织/项目查询，
    // 不能把团队名单存在或另一个 Team 的权益当成目标可用。
    const { kind: planKind, ...identity } = selection;
    const entitlement = await services.usageStatsService.getEntitlementSnapshot({
      preferredProviderId: providerId,
      includeSubscription: true,
      accountAccess: { type: "zhipu-account", family, planKind, ...identity },
      allowDisabledPreferredProvider: true,
      requirePreferredProvider: true,
      allowEnvApiKey: false,
    });
    return hasActiveUsageEntitlementSnapshot(entitlement, providerId);
  };
  let selection: ProviderFamilyConnectionSelection | undefined;
  let label: string | undefined;
  if (await isAvailable({ kind: "individual-coding-plan" }, view))
    selection = { kind: "individual-coding-plan" };
  if (!selection) {
    const pricing = await getEnterprisePricingProducts(services, family);
    if (pricing.status === "success") {
      for (const product of pricing.productList) {
        const contexts = product.teamProjects?.length ? product.teamProjects : [product];
        for (const context of contexts) {
          const candidate = resolveFirstSubscribedTeamPlanConnectionWithContext({
            teamProducts: [{ ...product, teamProjects: [], ...context }],
          });
          if (!candidate || JSON.stringify(candidate) === JSON.stringify(original)) continue;
          if (await isAvailable(candidate, view)) {
            selection = candidate;
            label =
              context.organizationName?.trim() ||
              context.projectName?.trim() ||
              candidate.organizationId;
            break;
          }
        }
        if (selection) break;
      }
    }
  }
  if (!selection || !event.isCurrent()) return null;
  const target = selection;
  let running = false;
  let applied = false;
  return {
    selection: target,
    label,
    async apply(): Promise<"switched" | "stale"> {
      if (running || applied || !event.isCurrent()) return "stale";
      running = true;
      try {
        const latest = await services.providerSettingsService.refresh(
          "account-connection-switch-confirm",
        );
        if (!isOriginal(latest) || !(await isAvailable(target, latest)) || !event.isCurrent())
          return "stale";
        await services.settingService.update(
          {
            providerFamilyConnectionSelections: {
              ...settings.providerFamilyConnectionSelections,
              [family]: target,
            },
          },
          expected,
        );
        applied = true;
        try {
          await services.providerSettingsService.refresh("account-connection-switched");
        } catch (error) {
          // 写入已完成，刷新失败不能把结果伪装成未保存；后续正常刷新继续收敛。
          logger.lifecycle.warn("[AccountConnection] 连接已保存，刷新暂未完成", { error });
        }
        return "switched";
      } finally {
        running = false;
      }
    },
  };
}
