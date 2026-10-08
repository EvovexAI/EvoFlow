import { useCodingPlanEntryGate } from "@/settings/CodingPlanEntryButton.js";
/* eslint-disable max-lines -- footer 套餐徽标、升级入口与 entitlement 探测共用同一份
   provider 选择与 family 过滤上下文，拆文件会让 zai/bigmodel 对称性难以追踪。 */
import { useEffect, useMemo } from "react";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  normalizeProviderFamilyDomain,
  resolveModelProviderFamilyIdByProviderId,
  TID_SIDEBAR_CODING_PLAN_USAGE_BUTTON,
} from "@zcode/shared";
import { BarChart3Icon, RocketIcon } from "lucide-react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu.js";
import {
  resolveCodingPlanUsageRemainingState,
  type CodingPlanUsageAvailableProvider,
} from "@/CodingPlanUsageRemainingPanel.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useUsageEntitlement } from "@/hooks/useUsageEntitlement.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useSettings } from "@/hooks/useSettingService.js";
import {
  resolveEntitledAccountProviderAccess,
  resolveEntitledAccountProviderAccessFingerprint,
} from "@/lib/accountProviderAccess.js";
import { buildUsageEntitlementCacheKey } from "@/lib/usageEntitlementCache.js";
import {
  isMaxCodingPlanSnapshot,
  resolveSidebarCodingPlanUpgradeFallbackProviderId,
} from "@/lib/sidebarCodingPlanUpgrade.js";
import {
  createCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanState,
  type CodingPlanFunnelContext,
} from "@/lib/codingPlanFunnelTelemetry.js";
import { type SidebarUsageCodingPlanProviderId } from "@/lib/sidebarUsageCodingPlanProviderPreference.js";
import { useEnterpriseCodingPlanProducts } from "@/settings/model-provider-section/useEnterpriseCodingPlanProducts.js";
import {
  buildCodingPlanUsageSources,
  resolveSidebarCurrentCodingPlanUsageSource,
} from "@/lib/codingPlanUsageSources.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { parseCustomProviderIdFromSupplierKey } from "@/lib/modelConfigSync.js";
import { setPendingSettingsUsageIntent } from "@/lib/settingsNavigation.js";
import {
  resolveSidebarFooterPlanBadgeLabel,
  resolveSidebarFooterProfilePlanBadge,
} from "@/WorkspaceSidebarFooterPlanBadgeHelpers.js";

export {
  resolveSidebarFooterPlanBadgeLabel,
  resolveSidebarFooterProfilePlanBadge,
} from "@/WorkspaceSidebarFooterPlanBadgeHelpers.js";

const TID_SIDEBAR_CODING_PLAN_UPGRADE_BUTTON = "sidebar-coding-plan-upgrade-button";

export function WorkspaceSidebarFooterUsageSummary({
  enabled,
  onUsageClick,
  onUpgradeClick,
  workspaceIdentity,
  workspacePath,
}: {
  enabled: boolean;
  onUsageClick?: () => void;
  onUpgradeClick?: (
    providerId: SidebarUsageCodingPlanProviderId,
    funnelContext: CodingPlanFunnelContext,
  ) => void;
  workspaceIdentity?: string;
  workspacePath?: string;
}) {
  const state = useWorkspaceSidebarFooterUsageSummaryState({
    enabled,
    workspaceIdentity,
    workspacePath,
  });
  return (
    <WorkspaceSidebarFooterUsageSummaryContent
      state={state}
      onUsageClick={onUsageClick}
      onUpgradeClick={onUpgradeClick}
    />
  );
}

export function useWorkspaceSidebarFooterUsageSummaryState({
  enabled,
  workspaceIdentity,
  workspacePath,
}: {
  enabled: boolean;
  workspaceIdentity?: string;
  workspacePath?: string;
}) {
  const { settings: sharedSettings } = useSettings();
  const providerFamilyDomain = normalizeProviderFamilyDomain(sharedSettings?.providerFamilyDomain);
  const providerSettingsRead = useProviderSettingsView();
  const providerSettingsView =
    providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
  // 首次读取失败也不能被解释成“已经加载且没有套餐”；只有 Ready 才能消费 Provider 事实。
  const providerSourcesLoading = providerSettingsRead.state.status !== "ready";
  const selectedSupplierKey = useZCodeSessionStore((state) =>
    workspacePath
      ? selectWorkspaceZCodeState(state, workspacePath, workspaceIdentity).selectedSupplierKey
      : "",
  );
  const availableCodingPlanProviders = useMemo(
    () =>
      [
        BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      ].flatMap((providerId): CodingPlanUsageAvailableProvider[] => {
        const access = resolveEntitledAccountProviderAccess(providerSettingsView, providerId);
        if (!access) return [];
        return [
          {
            providerId,
            accountAccess: access.access,
            label:
              access.label ||
              (providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
                ? "Z.ai - Coding Plan"
                : "BigModel - Coding Plan"),
          },
        ];
      }),
    [providerSettingsView],
  );
  const zaiProvider = availableCodingPlanProviders.find(
    (provider) => provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
  );
  const bigmodelProvider = availableCodingPlanProviders.find(
    (provider) => provider.providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
  );
  const zaiProviderFingerprint = resolveEntitledAccountProviderAccessFingerprint(
    providerSettingsView,
    BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
  );
  const bigmodelProviderFingerprint = resolveEntitledAccountProviderAccessFingerprint(
    providerSettingsView,
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
  );
  const zaiTeamProvider = resolveEntitledAccountProviderAccess(
    providerSettingsView,
    BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
  );
  const bigmodelTeamProvider = resolveEntitledAccountProviderAccess(
    providerSettingsView,
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
  );
  const selectedProviderIdFromSupplierKey =
    parseCustomProviderIdFromSupplierKey(selectedSupplierKey);
  const selectedProviderFamilyId = selectedProviderIdFromSupplierKey
    ? resolveModelProviderFamilyIdByProviderId(selectedProviderIdFromSupplierKey)
    : null;
  // providerFamilyDomain 是当前登录/运行 family 边界；BigModel Team selectedKey
  // 会在切换到 Z.ai 后保留，footer 若不按当前 domain 过滤会把头像旁徽标误显示成 Team。
  const scopedSelectedProviderId =
    selectedProviderFamilyId &&
    providerFamilyDomain &&
    selectedProviderFamilyId !== providerFamilyDomain
      ? null
      : selectedProviderIdFromSupplierKey;
  const bigmodelFamilyAllowed = providerFamilyDomain !== "zai";
  // 原只有 bigmodelFamilyAllowed 单变量，zai family 下 enterprise products 完全不拉。
  // zai team plan 对称化需要 zai family 也独立拉一份 enterprise pricing。
  const zaiFamilyAllowed = providerFamilyDomain !== "bigmodel";
  const bigmodelEnterpriseProducts = useEnterpriseCodingPlanProducts({
    // footer badge 和升级入口都需要识别 Team Plan。
    // Team 项目上下文只在企业 pricing/customerInfo 返回，账号级头像徽标也不能被当前连接方式卡住。
    enabled:
      enabled && !providerSourcesLoading && bigmodelFamilyAllowed && Boolean(bigmodelTeamProvider),
    authenticated: true,
    family: "bigmodel",
  });
  const zaiEnterpriseProducts = useEnterpriseCodingPlanProducts({
    enabled: enabled && !providerSourcesLoading && zaiFamilyAllowed && Boolean(zaiTeamProvider),
    authenticated: true,
    family: "zai",
  });
  const subscribedTeamProducts = useMemo(
    () => [
      ...(bigmodelEnterpriseProducts.snapshot?.productList.filter(
        (product) => product.subscribed === true,
      ) ?? []),
      ...(zaiEnterpriseProducts.snapshot?.productList.filter(
        (product) => product.subscribed === true,
      ) ?? []),
    ],
    [bigmodelEnterpriseProducts.snapshot?.productList, zaiEnterpriseProducts.snapshot?.productList],
  );
  const teamSources = useMemo(
    () =>
      buildCodingPlanUsageSources({
        accountAccesses: {
          ...(zaiTeamProvider?.access
            ? {
                zai: zaiTeamProvider.access,
              }
            : {}),
          ...(bigmodelTeamProvider?.access
            ? {
                bigmodel: bigmodelTeamProvider.access,
              }
            : {}),
        },
        subscribedTeamProducts,
      }),
    [bigmodelTeamProvider?.access, subscribedTeamProducts, zaiTeamProvider?.access],
  );
  const currentUsageSource = useMemo(
    () =>
      resolveSidebarCurrentCodingPlanUsageSource({
        selections: sharedSettings?.providerFamilyConnectionSelections,
        selectedProviderId: scopedSelectedProviderId,
        accountAccesses: {
          ...(resolveEntitledAccountProviderAccess(
            providerSettingsView,
            BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
          )?.access
            ? {
                zai: resolveEntitledAccountProviderAccess(
                  providerSettingsView,
                  BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
                )!.access,
              }
            : {}),
          ...(resolveEntitledAccountProviderAccess(
            providerSettingsView,
            BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          )?.access
            ? {
                bigmodel: resolveEntitledAccountProviderAccess(
                  providerSettingsView,
                  BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
                )!.access,
              }
            : {}),
        },
        teamSources,
      }),
    [
      scopedSelectedProviderId,
      bigmodelProvider?.accountAccess,
      sharedSettings?.providerFamilyConnectionSelections,
      teamSources,
      zaiProvider?.accountAccess,
    ],
  );
  const selectedProviderId = currentUsageSource?.sourceId;

  const zaiEntitlement = useUsageEntitlement({
    enabled:
      enabled &&
      !providerSourcesLoading &&
      providerFamilyDomain !== "bigmodel" &&
      Boolean(zaiProvider),
    includeSubscription: true,
    preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    accountAccess: resolveEntitledAccountProviderAccess(
      providerSettingsView,
      BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    )?.access,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: buildUsageEntitlementCacheKey({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      providerFingerprint: zaiProviderFingerprint,
    }),
    refreshOnMount: false,
  });
  const bigmodelEntitlement = useUsageEntitlement({
    enabled:
      enabled && !providerSourcesLoading && bigmodelFamilyAllowed && Boolean(bigmodelProvider),
    includeSubscription: true,
    preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    accountAccess: resolveEntitledAccountProviderAccess(
      providerSettingsView,
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    )?.access,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: buildUsageEntitlementCacheKey({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      providerFingerprint: bigmodelProviderFingerprint,
    }),
    refreshOnMount: false,
  });
  const teamEntitlement = useUsageEntitlement({
    // 原硬绑 bigmodelCodingPlan providerId 判断，zai team source 的 providerId
    // 是 zaiCodingPlan，永远进不到 team 分支，导致 zai team 额度不查询、badge 不显示。
    // 改为按 currentUsageSource.audience === "team" 路由，providerId 动态取。
    enabled: enabled && !providerSourcesLoading && currentUsageSource?.audience === "team",
    includeSubscription: true,
    preferredProviderId:
      currentUsageSource?.providerId ?? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    accountAccess: currentUsageSource?.teamSource?.accountAccess,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: currentUsageSource?.teamSource?.id,
    refreshOnMount: false,
  });
  // footer 是常驻入口，refreshOnMount: false 后冷启动没有其它
  // 入口预热 entitlement，个人计划徽标缺失。可见时触发一次 access 刷新，复用共享
  // 1 分钟 freshness window、失败退避和 in-flight 合并；hook disabled 时 refresh 是 no-op。
  useEffect(() => {
    for (const refresh of [
      zaiEntitlement.refresh,
      bigmodelEntitlement.refresh,
      teamEntitlement.refresh,
    ]) {
      void refresh({ silent: true, reason: "access" });
    }
  }, [zaiEntitlement.refresh, bigmodelEntitlement.refresh, teamEntitlement.refresh]);
  const profilePlanBadge = resolveSidebarFooterProfilePlanBadge({
    individualEntitlements: [
      ...(providerFamilyDomain !== "bigmodel"
        ? [
            {
              providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
              snapshot: zaiEntitlement.snapshot,
              loading: zaiEntitlement.loading,
            },
          ]
        : []),
      ...(bigmodelFamilyAllowed
        ? [
            {
              providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
              snapshot: bigmodelEntitlement.snapshot,
              loading: bigmodelEntitlement.loading,
            },
          ]
        : []),
    ],
    // 头像徽标使用账号的 Team entitlement；pricing 结果只负责额度来源和套餐详情。
    hasTeamPlanEntitlement:
      providerFamilyDomain === "zai"
        ? Boolean(zaiTeamProvider)
        : providerFamilyDomain === "bigmodel"
          ? Boolean(bigmodelTeamProvider)
          : Boolean(zaiTeamProvider || bigmodelTeamProvider),
  });
  const providerEntitlements = [
    ...(currentUsageSource?.providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan &&
    currentUsageSource.audience === "individual"
      ? [
          {
            sourceId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
            providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
            accountAccess: currentUsageSource.accountAccess,
            ...zaiEntitlement,
          },
        ]
      : []),
    ...(currentUsageSource?.providerId ===
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan &&
    currentUsageSource.audience === "individual"
      ? [
          {
            sourceId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
            providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
            accountAccess: currentUsageSource.accountAccess,
            ...bigmodelEntitlement,
          },
        ]
      : []),
    // 原 team 分支硬判 bigmodelCodingPlan providerId，zai team source 走不进来。
    // 改为统一按 audience === "team" 路由，覆盖 zai/bigmodel 两种 family 的 team source。
    ...(currentUsageSource?.audience === "team" && currentUsageSource.teamSource
      ? [
          {
            sourceId: currentUsageSource.teamSource.id,
            providerId: currentUsageSource.teamSource.providerId,
            accountAccess: currentUsageSource.teamSource.accountAccess,
            label: currentUsageSource.teamSource.label,
            ...teamEntitlement,
          },
        ]
      : []),
  ];
  const usageState = resolveCodingPlanUsageRemainingState({
    availableProviders: availableCodingPlanProviders,
    entitlements: providerEntitlements,
    modelProvidersLoading: providerSourcesLoading,
    selectedProviderId,
  });
  const visibleUsageState = usageState?.hasAnyActiveCodingPlan ? usageState : null;
  const selectedUpgradeProviderId: SidebarUsageCodingPlanProviderId | undefined =
    selectedProviderId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    selectedProviderId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
      ? selectedProviderId
      : undefined;
  const upgradeTargetProviderId =
    selectedUpgradeProviderId ??
    currentUsageSource?.providerId ??
    availableCodingPlanProviders[0]?.providerId ??
    resolveSidebarCodingPlanUpgradeFallbackProviderId(providerFamilyDomain);
  return {
    audience: currentUsageSource?.audience,
    availableCodingPlanProviders,
    providerSourcesLoading,
    providerEntitlements,
    profilePlanBadge,
    selectedProviderId,
    upgradeTargetProviderId,
    usageState: visibleUsageState,
  };
}

type WorkspaceSidebarFooterUsageSummaryState = ReturnType<
  typeof useWorkspaceSidebarFooterUsageSummaryState
>;

export function WorkspaceSidebarFooterUsageSummaryContent({
  state,
  onUsageClick,
  onUpgradeClick,
}: {
  state: WorkspaceSidebarFooterUsageSummaryState;
  onUsageClick?: () => void;
  onUpgradeClick?: (
    providerId: SidebarUsageCodingPlanProviderId,
    funnelContext: CodingPlanFunnelContext,
  ) => void;
}) {
  const { intl } = useZCodeIntl();
  const entryGate = useCodingPlanEntryGate();
  const { providerEntitlements, upgradeTargetProviderId } = state;
  const upgradeProviderSnapshot =
    providerEntitlements.find((item) => item.providerId === upgradeTargetProviderId)?.snapshot ??
    null;
  const upgradeActionLabelId = isMaxCodingPlanSnapshot(upgradeProviderSnapshot)
    ? "sidebar.usage.plan.renew"
    : "sidebar.usage.plan.upgrade";

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        data-testid={TID_SIDEBAR_CODING_PLAN_USAGE_BUTTON}
        onSelect={() => {
          setPendingSettingsUsageIntent();
          onUsageClick?.();
        }}
      >
        <BarChart3Icon className="size-4" />
        {intl.formatMessage({ id: "sidebar.usage.plan.openStats" })}
      </DropdownMenuItem>
      {/* 产品要求：升级入口始终显示；未解析出当前套餐时由当前 provider family 决定品牌。 */}
      <DropdownMenuItem
        data-testid={TID_SIDEBAR_CODING_PLAN_UPGRADE_BUTTON}
        disabled={entryGate.status === "loading"}
        aria-busy={entryGate.status === "loading"}
        onSelect={() => {
          if (entryGate.status !== "ready") {
            entryGate.retry?.();
            return;
          }
          onUpgradeClick?.(
            upgradeTargetProviderId,
            createCodingPlanFunnelContext({
              providerId: upgradeTargetProviderId,
              upgradeSource: "profile_menu",
              eventRegion: "app.profile",
              eventText: intl.formatMessage({ id: upgradeActionLabelId }),
              entryPlanState: resolveCodingPlanEntryPlanState({
                snapshot: upgradeProviderSnapshot,
              }),
            }),
          );
        }}
      >
        <RocketIcon className="size-4" />
        {entryGate.label ?? intl.formatMessage({ id: upgradeActionLabelId })}
      </DropdownMenuItem>
    </>
  );
}

export function WorkspaceSidebarFooterPlanBadge({
  state,
}: {
  state: WorkspaceSidebarFooterUsageSummaryState;
}) {
  const { intl } = useZCodeIntl();
  const label =
    state.profilePlanBadge?.audience === "team"
      ? intl.formatMessage({ id: "sidebar.usage.plan.audienceTeam" })
      : resolveSidebarFooterPlanBadgeLabel(state.profilePlanBadge?.snapshot ?? null);
  if (!label) {
    return null;
  }

  return (
    <span
      className="min-w-0 max-w-20 shrink truncate rounded-full border border-border bg-surface px-1 py-px text-ui-xs font-medium leading-normal text-foreground-subtle"
      title={label}
    >
      {label}
    </span>
  );
}
