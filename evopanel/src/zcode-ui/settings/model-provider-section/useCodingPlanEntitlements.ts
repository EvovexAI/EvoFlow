import { buildStartPlanEntitlementOptions } from "@/lib/startPlanEntitlementOptions.js";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ProviderSettingsView } from "@zcode/services";
import {
  getModelProviderFamilySpec,
  type ModelProviderFamilySpec,
  type ProviderFamilyConnectionSelection,
  type ProviderFamilyConnectionSelectionSettings,
  type ZCodeAccountAccess,
  type ZCodeProviderAccountAccess,
} from "@zcode/shared";
import {
  useUsageEntitlement,
  type UsageEntitlementRefreshOptions,
} from "@/hooks/useUsageEntitlement.js";
import type { CodingPlanEntitlementState } from "@/settings/model-provider-section/constants.js";
import { buildUsageEntitlementCacheKey } from "@/lib/usageEntitlementCache.js";
import { resolveAccountProviderInspectionAccess } from "@/lib/accountProviderAccess.js";

function resolveCodingPlanProviderFingerprintAutoRefresh({
  loading,
  providerFingerprint,
  skippedProviderFingerprint,
  suppressAutoRefresh,
}: {
  loading: boolean;
  providerFingerprint: string;
  skippedProviderFingerprint: string;
  suppressAutoRefresh: boolean;
}): {
  shouldRefresh: boolean;
  skippedProviderFingerprint: string;
} {
  if (loading || !providerFingerprint) {
    return { shouldRefresh: false, skippedProviderFingerprint };
  }
  if (suppressAutoRefresh) {
    return {
      shouldRefresh: false,
      skippedProviderFingerprint: providerFingerprint,
    };
  }
  if (skippedProviderFingerprint === providerFingerprint) {
    return {
      shouldRefresh: false,
      skippedProviderFingerprint: "",
    };
  }
  return { shouldRefresh: true, skippedProviderFingerprint: "" };
}

function useProviderFamilyEntitlements(params: {
  familySpec: ModelProviderFamilySpec;
  selection: ProviderFamilyConnectionSelection | undefined;
  providerSettingsView: ProviderSettingsView | null;
}) {
  const codingPlanProviderId =
    params.selection?.kind === "team-coding-plan"
      ? params.familySpec.teamCodingPlanProviderId
      : params.familySpec.individualCodingPlanProviderId;
  const startPlanProviderId = params.familySpec.startPlanProviderId;
  const accountAccess = resolveAccountProviderInspectionAccess(
    params.providerSettingsView,
    codingPlanProviderId,
  );
  const startOptions = buildStartPlanEntitlementOptions(
    params.providerSettingsView,
    startPlanProviderId,
  );
  const registryFingerprint = accountAccess
    ? JSON.stringify([params.providerSettingsView?.revision, accountAccess])
    : "";
  const startProviderFingerprint = startOptions.enabled ? (startOptions.cacheKey ?? "") : "";
  const entitlementAccess = resolveEntitlementAccountAccess(
    accountAccess?.access,
    params.selection,
  );
  // Team 查询身份还包含 product/org/project。只使用 Registry 静态 Access
  // 会让切换团队后复用上一项目的权益缓存，因此 cache identity 必须包含执行期账号上下文。
  const codingFingerprint = registryFingerprint
    ? JSON.stringify([registryFingerprint, entitlementAccess])
    : "";
  const codingEnabled = Boolean(codingFingerprint);
  const startEnabled = Boolean(startProviderFingerprint);
  const coding = useUsageEntitlement({
    enabled: codingEnabled,
    refreshOnMount: false,
    includeSubscription: true,
    preferredProviderId: codingPlanProviderId,
    accountAccess: entitlementAccess,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: buildUsageEntitlementCacheKey({
      providerId: codingPlanProviderId,
      providerFingerprint: codingFingerprint,
    }),
  });
  const start = useUsageEntitlement(startOptions);

  return useMemo(
    () => ({
      coding,
      codingEnabled,
      codingFingerprint,
      codingPlanProviderId,
      start,
      startEnabled,
      startPlanProviderId,
      startProviderFingerprint,
    }),
    // Family 编排重构后这里每次渲染都返回新对象，导致上层等价权益事实
    // 失去引用稳定性，并把套餐状态更新放大成 Provider 设置页的 access refresh 循环。
    [
      coding.error,
      coding.loading,
      coding.refresh,
      coding.snapshot,
      codingEnabled,
      codingFingerprint,
      codingPlanProviderId,
      start.error,
      start.loading,
      start.refresh,
      start.snapshot,
      startEnabled,
      startPlanProviderId,
      startProviderFingerprint,
    ],
  );
}

function resolveEntitlementAccountAccess(
  access: ZCodeProviderAccountAccess | undefined,
  selection: ProviderFamilyConnectionSelection | undefined,
): ZCodeProviderAccountAccess | ZCodeAccountAccess | undefined {
  if (access?.mode !== "team-coding-plan" || selection?.kind !== "team-coding-plan") {
    // 展示查询针对这个套餐自身，不让执行期的 current 解析器改成当前另一套餐。
    return access && (access.mode === "start-plan" || access.mode === "individual-coding-plan")
      ? { type: "zhipu-account", family: access.accountType, planKind: access.mode }
      : access;
  }
  return {
    type: "zhipu-account",
    family: access.accountType,
    planKind: "team-coding-plan",
    productId: selection.productId,
    organizationId: selection.organizationId,
    projectId: selection.projectId,
  };
}

export function useCodingPlanAccessRefresh({
  refresh,
  selectedPlanKey,
}: {
  refresh: (options?: UsageEntitlementRefreshOptions) => Promise<void>;
  selectedPlanKey: string | null;
}): void {
  useEffect(() => {
    if (!selectedPlanKey) {
      return;
    }
    // 原 effect 依赖整个 selectedNavItem，额度和 loading 的投影变化也会
    // 被误判为用户重新打开套餐。这里只响应稳定的套餐选择身份。
    void refresh({ silent: true, reason: "access" });
  }, [refresh, selectedPlanKey]);
}

export function useCodingPlanEntitlements({
  providerSettingsView,
  connectionSelections = {},
  suppressProviderFingerprintAutoRefresh = false,
}: {
  providerSettingsView: ProviderSettingsView | null;
  connectionSelections?: ProviderFamilyConnectionSelectionSettings;
  suppressProviderFingerprintAutoRefresh?: boolean;
}): {
  entitlements: Partial<Record<string, CodingPlanEntitlementState>>;
  /** 当前具备 Account Access、能够独立查询权益的 Start Plan Provider。 */
  enabledStartPlanProviderIds: string[];
  refresh: (options?: UsageEntitlementRefreshOptions) => Promise<void>;
} {
  const skippedProviderFingerprintAutoRefreshRef = useRef("");
  const loading = providerSettingsView === null;
  // React Hook 必须保持固定调用顺序，因此显式调用两个 Family，而不是动态遍历 Spec。
  const zaiFamily = useProviderFamilyEntitlements({
    familySpec: getModelProviderFamilySpec("zai"),
    selection: connectionSelections.zai,
    providerSettingsView,
  });
  const bigmodelFamily = useProviderFamilyEntitlements({
    familySpec: getModelProviderFamilySpec("bigmodel"),
    selection: connectionSelections.bigmodel,
    providerSettingsView,
  });

  const refresh = useCallback(
    (options: UsageEntitlementRefreshOptions = {}) => {
      // Start/Coding 使用独立 provider id 与 cache key；两边都可用时并行刷新。
      const refreshJobs: Array<Promise<void>> = [];
      if (zaiFamily.codingEnabled) {
        refreshJobs.push(zaiFamily.coding.refresh(options));
      }
      if (zaiFamily.startEnabled) {
        refreshJobs.push(zaiFamily.start.refresh(options));
      }
      if (bigmodelFamily.codingEnabled) {
        refreshJobs.push(bigmodelFamily.coding.refresh(options));
      }
      if (bigmodelFamily.startEnabled) {
        refreshJobs.push(bigmodelFamily.start.refresh(options));
      }
      return Promise.all(refreshJobs).then(() => undefined);
    },
    [
      bigmodelFamily.coding.refresh,
      bigmodelFamily.codingEnabled,
      bigmodelFamily.start.refresh,
      bigmodelFamily.startEnabled,
      zaiFamily.coding.refresh,
      zaiFamily.codingEnabled,
      zaiFamily.start.refresh,
      zaiFamily.startEnabled,
    ],
  );

  const providerFingerprint = useMemo(
    () =>
      [
        zaiFamily.codingFingerprint,
        zaiFamily.startEnabled ? zaiFamily.startProviderFingerprint : "",
        bigmodelFamily.codingFingerprint,
        bigmodelFamily.startEnabled ? bigmodelFamily.startProviderFingerprint : "",
      ]
        .filter(Boolean)
        .join("|"),
    [
      bigmodelFamily.codingFingerprint,
      bigmodelFamily.startEnabled,
      bigmodelFamily.startProviderFingerprint,
      zaiFamily.codingFingerprint,
      zaiFamily.startEnabled,
      zaiFamily.startProviderFingerprint,
    ],
  );

  useEffect(() => {
    const decision = resolveCodingPlanProviderFingerprintAutoRefresh({
      loading,
      providerFingerprint,
      skippedProviderFingerprint: skippedProviderFingerprintAutoRefreshRef.current,
      suppressAutoRefresh: suppressProviderFingerprintAutoRefresh,
    });
    skippedProviderFingerprintAutoRefreshRef.current = decision.skippedProviderFingerprint;
    if (!decision.shouldRefresh) {
      return;
    }

    // provider 配置异步加载或保存后，首次 entitlement 快照可能还是旧的。
    // 连接方式同步会单独刷新 Account Access，不能把同一次变化再扩散成套餐/余额刷新。
    refresh({ force: true, silent: true, reason: "auth" });
  }, [providerFingerprint, loading, refresh, suppressProviderFingerprintAutoRefresh]);

  return useMemo(
    () => ({
      entitlements: {
        [zaiFamily.codingPlanProviderId]: {
          snapshot: zaiFamily.coding.snapshot,
          loading: zaiFamily.coding.loading,
          error: zaiFamily.coding.error,
        },
        [zaiFamily.startPlanProviderId]: {
          snapshot: zaiFamily.startEnabled ? zaiFamily.start.snapshot : null,
          loading: zaiFamily.startEnabled ? zaiFamily.start.loading : false,
          error: zaiFamily.startEnabled ? zaiFamily.start.error : null,
        },
        [bigmodelFamily.codingPlanProviderId]: {
          snapshot: bigmodelFamily.coding.snapshot,
          loading: bigmodelFamily.coding.loading,
          error: bigmodelFamily.coding.error,
        },
        [bigmodelFamily.startPlanProviderId]: {
          snapshot: bigmodelFamily.startEnabled ? bigmodelFamily.start.snapshot : null,
          loading: bigmodelFamily.startEnabled ? bigmodelFamily.start.loading : false,
          error: bigmodelFamily.startEnabled ? bigmodelFamily.start.error : null,
        },
      },
      enabledStartPlanProviderIds: [
        ...(zaiFamily.startEnabled ? [zaiFamily.startPlanProviderId] : []),
        ...(bigmodelFamily.startEnabled ? [bigmodelFamily.startPlanProviderId] : []),
      ],
      refresh,
    }),
    [bigmodelFamily, refresh, zaiFamily],
  );
}
