import { type UsageEntitlementSnapshot } from "@zcode/shared";
import { type ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";

export function pickCodingPlanEntitlementProvider(
  codingPlanProvider: ProviderSettingsFormProvider | null | undefined,
): ProviderSettingsFormProvider | null {
  // Coding Plan 与普通 API Key 是两个独立入口。
  // 权益和模型入口只跟随 Coding Plan provider 自身的 key，避免普通供应商 key 误点亮订阅态。
  return codingPlanProvider ?? null;
}

export function hasActiveUsageEntitlementSnapshot(
  snapshot: UsageEntitlementSnapshot | null,
  providerId?: string,
): boolean {
  return resolveUsageEntitlementOutcome(snapshot, providerId) === "active";
}

type UsageEntitlementOutcome = "active" | "inactive" | "unknown";

/** 只把权威 no_plan 解释为失效；网络、鉴权和不完整快照都保持未知。 */
export function resolveUsageEntitlementOutcome(
  snapshot: UsageEntitlementSnapshot | null,
  providerId?: string,
): UsageEntitlementOutcome {
  if (!snapshot) return "unknown";
  if (providerId && snapshot.provider?.id && snapshot.provider.id !== providerId) {
    return "unknown";
  }
  if (snapshot.unavailableReason === "no_plan") return "inactive";
  // 额度或剩余额度不代表订阅；个人/团队都由服务返回的订阅摘要证明权益。
  return snapshot.subscription?.details.length ? "active" : "unknown";
}
