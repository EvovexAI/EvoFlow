import {
  BUILTIN_MODEL_PROVIDER_IDS,
  getModelProviderFamilySpec,
  resolveModelProviderFamilySpecByProviderId,
  type ProviderFamilyConnectionSelectionSettings,
  type ProviderFamilyDomain,
  type ZCodeAccountAccess,
  type ZCodeProviderAccountAccess,
} from "@zcode/shared";
import {
  resolveEnterpriseCodingPlanProductFamily,
  type EnterpriseCodingPlanProductDisplay,
} from "@/settings/model-provider-section/enterpriseCodingPlanProducts.js";
import type {
  SidebarUsageCodingPlanProviderId,
  SidebarUsageCodingPlanSourceId,
} from "@/lib/sidebarUsageCodingPlanProviderPreference.js";
import { formatTeamPlanDisplayName } from "@/lib/teamPlanDisplayName.js";

export interface CodingPlanUsageSource {
  id: SidebarUsageCodingPlanSourceId;
  providerId: SidebarUsageCodingPlanProviderId;
  label: string;
  accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
}

export function buildPersonalCodingPlanUsageSource({
  providerId,
  accountAccess,
  label,
}: {
  providerId: SidebarUsageCodingPlanProviderId;
  accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  label?: string | null;
}): CodingPlanUsageSource {
  const normalizedLabel = label?.trim();
  return {
    id: providerId,
    providerId,
    accountAccess,
    label:
      normalizedLabel ||
      (providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
        ? "Z.ai - Coding Plan"
        : "BigModel - Coding Plan"),
  };
}

type CurrentSidebarCodingPlanUsageSource =
  | {
      audience: "individual";
      providerId: SidebarUsageCodingPlanProviderId;
      sourceId: SidebarUsageCodingPlanSourceId;
      accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
      teamSource?: never;
    }
  | {
      audience: "team";
      // 原硬绑 bigmodelCodingPlan，zai team plan 的 currentUsageSource
      // 无法表达 zai providerId。松开为 SidebarUsageCodingPlanProviderId，
      // zai/bigmodel team 都按各自 selectedKey 解析出的 providerId 表达。
      providerId: SidebarUsageCodingPlanProviderId;
      sourceId: SidebarUsageCodingPlanSourceId;
      teamSource: CodingPlanUsageSource;
    };

export function buildCodingPlanUsageSources({
  accountAccesses,
  subscribedTeamProducts,
}: {
  accountAccesses: Partial<Record<ProviderFamilyDomain, ZCodeProviderAccountAccess>>;
  subscribedTeamProducts: EnterpriseCodingPlanProductDisplay[];
}): CodingPlanUsageSource[] {
  return buildTeamCodingPlanUsageSources(subscribedTeamProducts, accountAccesses);
}

function buildTeamCodingPlanUsageSources(
  subscribedTeamProducts: EnterpriseCodingPlanProductDisplay[],
  accountAccesses: Partial<Record<ProviderFamilyDomain, ZCodeProviderAccountAccess>>,
): CodingPlanUsageSource[] {
  const seen = new Set<string>();
  return subscribedTeamProducts.flatMap((product) => {
    const projectContexts =
      product.teamProjects && product.teamProjects.length > 0
        ? product.teamProjects
        : [
            {
              organizationId: product.organizationId ?? null,
              organizationName: product.organizationName ?? null,
              projectId: product.projectId ?? null,
              projectName: product.projectName ?? null,
            },
          ];

    return projectContexts.flatMap((projectContext, index) => {
      const organizationId = projectContext.organizationId?.trim() ?? "";
      const projectId = projectContext.projectId?.trim() ?? "";
      if (!organizationId || !projectId) {
        return [];
      }
      const label = formatTeamUsageSourceLabel({
        product,
        organizationId,
        organizationName: projectContext.organizationName ?? product.organizationName,
        projectId,
        projectName: projectContext.projectName ?? product.projectName,
      });
      if (!label) {
        // Team Plan usage source 只展示组织名；缺失时不能生成 "BigModel - " 空白来源。
        return [];
      }
      const projectKey = projectId || String(index);
      // 原 createBigModelTeamPlanConnectionKey + bigmodelCodingPlan providerId
      // 硬编码 bigmodel，zai team product 的 sourceId 用了 bigmodel 前缀、providerId 也错。
      // 按 product.family 用 family-aware key + 对应 codingPlan providerId。
      const productFamily = resolveEnterpriseCodingPlanProductFamily(product);
      const baseAccess = accountAccesses[productFamily];
      if (baseAccess?.mode !== "team-coding-plan") {
        return [];
      }
      const codingPlanProviderId =
        getModelProviderFamilySpec(productFamily).teamCodingPlanProviderId;
      const sourceId = ["team", productFamily, product.productId, organizationId, projectKey]
        .map(encodeURIComponent)
        .join(":") as SidebarUsageCodingPlanSourceId;
      if (seen.has(sourceId)) {
        return [];
      }
      seen.add(sourceId);
      return [
        {
          id: sourceId,
          providerId: codingPlanProviderId,
          accountAccess: {
            type: "zhipu-account",
            family: productFamily,
            planKind: "team-coding-plan",
            productId: product.productId,
            organizationId,
            projectId,
          },
          label,
        },
      ];
    });
  });
}

export function resolveSidebarCurrentCodingPlanUsageSource({
  selections,
  selectedProviderId,
  accountAccesses,
  teamSources,
}: {
  selections?: ProviderFamilyConnectionSelectionSettings | null;
  selectedProviderId: string | null;
  accountAccesses: Partial<Record<ProviderFamilyDomain, ZCodeProviderAccountAccess>>;
  teamSources: CodingPlanUsageSource[];
}): CurrentSidebarCodingPlanUsageSource | null {
  const family = selectedProviderId
    ? resolveModelProviderFamilySpecByProviderId(selectedProviderId)?.id
    : undefined;
  if (!family) return null;
  const selection = selections?.[family];
  if (selection?.kind === "team-coding-plan") {
    const teamSource = teamSources.find(
      (source) =>
        "planKind" in source.accountAccess &&
        source.accountAccess.planKind === "team-coding-plan" &&
        source.accountAccess.family === family &&
        source.accountAccess.productId === selection.productId &&
        source.accountAccess.organizationId === selection.organizationId &&
        source.accountAccess.projectId === selection.projectId,
    );
    return teamSource
      ? {
          audience: "team",
          providerId: teamSource.providerId,
          sourceId: teamSource.id,
          teamSource,
        }
      : null;
  }
  if (selection?.kind !== "individual-coding-plan") return null;
  const accountAccess = accountAccesses[family];
  if (!accountAccess || accountAccess.mode !== "individual-coding-plan") return null;
  const providerId = getModelProviderFamilySpec(family).individualCodingPlanProviderId;
  return { audience: "individual", providerId, sourceId: providerId, accountAccess };
}

function formatTeamUsageSourceLabel({
  product,
  organizationId,
  organizationName,
  projectId,
  projectName,
}: {
  product: EnterpriseCodingPlanProductDisplay;
  organizationId?: string | null;
  organizationName?: string | null;
  projectId?: string | null;
  projectName?: string | null;
}): string | null {
  const teamPlanName = formatTeamPlanDisplayName({
    ...product,
    organizationId,
    organizationName,
    projectId,
    projectName,
  });
  if (!teamPlanName) {
    return null;
  }
  // 原硬编码 "BigModel - " 前缀，zai team source 显示出来品牌也错位。
  // 按 product.family 取品牌前缀，与 codingPlanItem.providerName 对齐。
  const brandPrefix = `${getModelProviderFamilySpec(resolveEnterpriseCodingPlanProductFamily(product)).label} - `;
  return `${brandPrefix}${teamPlanName}`;
}
