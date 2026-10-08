import type {
  EnterpriseCodingPlanPricingProduct,
  ProviderFamilyConnectionSelection,
  ProviderFamilyDomain,
  UsageEntitlementSnapshot,
} from "@zcode/shared";
import { getModelProviderFamilySpec } from "@zcode/shared";
import { hasActiveUsageEntitlementSnapshot } from "@/lib/codingPlanProvider.js";

export type ModelProviderFamilyConnectionSelection = ProviderFamilyConnectionSelection;

/** 把当前 Family 连接意图映射为对应的 Built-in Account Provider 身份。 */
export function resolveModelProviderFamilyConnectionProviderId(params: {
  providerFamilyDomain: ProviderFamilyDomain;
  selection: ProviderFamilyConnectionSelection;
}): string {
  const familySpec = getModelProviderFamilySpec(params.providerFamilyDomain);
  switch (params.selection.kind) {
    case "start-plan":
      return familySpec.startPlanProviderId;
    case "individual-coding-plan":
      return familySpec.individualCodingPlanProviderId;
    case "team-coding-plan":
      return familySpec.teamCodingPlanProviderId;
  }
}

export function resolveFirstSubscribedTeamPlanConnectionWithContext(params: {
  teamProducts: readonly EnterpriseCodingPlanPricingProduct[];
}): Extract<ProviderFamilyConnectionSelection, { kind: "team-coding-plan" }> | null {
  for (const product of params.teamProducts) {
    if (product.subscribed !== true) continue;
    const projectContexts =
      product.teamProjects && product.teamProjects.length > 0
        ? product.teamProjects
        : [
            {
              organizationId: product.organizationId ?? "",
              projectId: product.projectId ?? "",
              apiKeyStatus: product.apiKeyStatus,
            },
          ];
    for (const projectContext of projectContexts) {
      if (projectContext.apiKeyStatus === "unavailable") continue;
      const organizationId = projectContext.organizationId?.trim() ?? "";
      const projectId = projectContext.projectId?.trim() ?? "";
      if (!organizationId || !projectId) continue;
      return {
        kind: "team-coding-plan",
        productId: product.productId,
        organizationId,
        projectId,
      };
    }
  }
  return null;
}

export function resolveAutomaticModelProviderFamilyConnectionSelection(params: {
  providerFamilyDomain: ProviderFamilyDomain;
  codingPlanEntitlement: UsageEntitlementSnapshot | null;
  startPlanEntitlement: UsageEntitlementSnapshot | null;
  teamProducts?: readonly EnterpriseCodingPlanPricingProduct[];
  /** 首次登录可落到购买入口；修复已有连接时只能选确认可用的套餐。 */
  allowPurchaseEntry?: boolean;
  /** 当前 Account View 的统一判定优先于旧余额快照，尤其区分待生效与可用。 */
  codingPlanAvailable?: boolean;
  startPlanAvailable?: boolean;
}): ModelProviderFamilyConnectionSelection | null {
  const familySpec = getModelProviderFamilySpec(params.providerFamilyDomain);

  if (
    params.codingPlanAvailable ??
    hasActiveUsageEntitlementSnapshot(
      params.codingPlanEntitlement,
      familySpec.individualCodingPlanProviderId,
    )
  ) {
    return {
      kind: "individual-coding-plan",
    };
  }

  // 原守卫 familySpec.id === "bigmodel" 使 zai 即使有订阅团队也无法识别。
  // 去掉守卫后，两类 Provider Family 统一读取结构化团队选择。
  const teamSelection = resolveFirstSubscribedTeamPlanConnectionWithContext({
    teamProducts: params.teamProducts ?? [],
  });
  if (teamSelection) return teamSelection;

  if (params.allowPurchaseEntry === false) return null;
  // OAuth 登录后的输入框连接方式必须始终保持 OAuth 语义。
  // 即使当前账号没有 Start、个人 Coding 或团队 Coding，也应落到个人 Coding 入口，
  // 由后续购买/不可用态承接，而不是自动切到 API Key。
  return {
    kind: "individual-coding-plan",
  };
}
