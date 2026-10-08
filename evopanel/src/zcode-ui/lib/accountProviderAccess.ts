import type { ProviderSettingsView } from "@zcode/services";
import { type ZCodeProviderAccountAccess, zcodeProviderAccountAccessSchema } from "@zcode/shared";

interface EntitledAccountProviderAccess {
  readonly providerId: string;
  readonly access: ZCodeProviderAccountAccess;
  readonly label?: string;
}

export function resolveEntitledAccountProviderAccess(
  view: ProviderSettingsView | null | undefined,
  providerId: string,
): EntitledAccountProviderAccess | null {
  const provider = view?.providers.find((entry) => entry.providerId === providerId);
  if (provider?.effectiveConfig.access?.type !== "zhipu-account") {
    return null;
  }

  // Registry Access 是静态 accountType/mode 约束，动态 planKind 与 Team scope
  // 只能由账号服务在请求期解析。旧 Schema 会把所有真实 Registry Provider 误判为空。
  const parsed = zcodeProviderAccountAccessSchema.safeParse(provider.effectiveConfig.access);
  if (!parsed.success || parsed.data.entitled !== true) return null;
  const label = provider.providerName?.trim();
  return {
    providerId,
    access: parsed.data,
    ...(label ? { label } : {}),
  };
}

export function resolveEntitledAccountProviderAccessFingerprint(
  view: ProviderSettingsView | null | undefined,
  providerId: string,
): string {
  const access = resolveEntitledAccountProviderAccess(view, providerId);
  return access ? JSON.stringify([view?.revision, access.providerId, access.access]) : "";
}

/**
 * 套餐只读查询不等于执行模型。pending/未选中的账号仍需展示权益，不能要求 current。
 * 本函数只给余额/订阅查询使用，不得用于模型请求或 ModelSelection completion。
 */
export function resolveAccountProviderInspectionAccess(
  view: ProviderSettingsView | null | undefined,
  providerId: string,
): EntitledAccountProviderAccess | null {
  const provider = view?.providers.find((entry) => entry.providerId === providerId);
  if (!provider) return null;
  // 明确无 Start 权益仍需只读查询过期原因；执行权限仍由 entitled 门禁控制。
  if (
    provider.accountState?.availability === "unavailable" &&
    !(
      provider.effectiveConfig.access?.type === "zhipu-account" &&
      provider.effectiveConfig.access.mode === "start-plan" &&
      provider.accountState.unavailableReason === "not-entitled"
    )
  )
    return null;
  const parsed = zcodeProviderAccountAccessSchema.safeParse(provider.effectiveConfig.access);
  if (!parsed.success || parsed.data.mode === "off-peak") return null;
  if (!provider.accountState && parsed.data.entitled !== true) return null;
  return { providerId, access: parsed.data };
}
