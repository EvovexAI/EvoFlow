import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { logger } from "@/logger.js";

export type SidebarUsageCodingPlanProviderId =
  | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan;
export type SidebarUsageCodingPlanSourceId = SidebarUsageCodingPlanProviderId | `team:${string}`;

const SIDEBAR_USAGE_CODING_PLAN_PROVIDER_STORAGE_KEY = "zcode:sidebar-usage-coding-plan-provider";

const SIDEBAR_USAGE_CODING_PLAN_PROVIDER_IDS: SidebarUsageCodingPlanProviderId[] = [
  BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
  BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
  BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
  BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
];

function isSidebarUsageCodingPlanProviderId(
  providerId: string | null | undefined,
): providerId is SidebarUsageCodingPlanProviderId {
  return SIDEBAR_USAGE_CODING_PLAN_PROVIDER_IDS.includes(
    providerId as SidebarUsageCodingPlanProviderId,
  );
}

function isSidebarUsageCodingPlanSourceId(
  sourceId: string | null | undefined,
): sourceId is SidebarUsageCodingPlanSourceId {
  return isSidebarUsageCodingPlanProviderId(sourceId) || sourceId?.startsWith("team:") === true;
}

function getLocalStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch (error) {
    // WebView 隐私模式或移动端远控容器可能禁用 localStorage。
    // 这里只影响 footer 的 provider 选择记忆，失败时降级为本次默认选择即可。
    logger.warn("[sidebarUsageCodingPlanProviderPreference] localStorage 不可用", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function readSidebarUsageCodingPlanSourcePreference():
  | SidebarUsageCodingPlanSourceId
  | undefined {
  const storage = getLocalStorage();
  if (!storage) {
    return undefined;
  }
  try {
    const value = storage.getItem(SIDEBAR_USAGE_CODING_PLAN_PROVIDER_STORAGE_KEY);
    return isSidebarUsageCodingPlanSourceId(value) ? value : undefined;
  } catch (error) {
    logger.warn("[sidebarUsageCodingPlanProviderPreference] 读取偏好失败", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export function writeSidebarUsageCodingPlanProviderPreference(
  providerId: SidebarUsageCodingPlanSourceId,
): void {
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }
  try {
    storage.setItem(SIDEBAR_USAGE_CODING_PLAN_PROVIDER_STORAGE_KEY, providerId);
  } catch (error) {
    logger.warn("[sidebarUsageCodingPlanProviderPreference] 写入偏好失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
