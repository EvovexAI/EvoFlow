import { isCodingPlanModelProviderId } from "@zcode/shared";
import { type CodingPlanProviderId } from "@/settings/model-provider-section/constants.js";

type CodingPlanPurchaseAuthStatus =
  | "unknown"
  | "loading"
  | "authenticated"
  | "unauthenticated"
  | "error";

export function isCodingPlanPurchaseAuthPending(status: CodingPlanPurchaseAuthStatus): boolean {
  return status === "unknown" || status === "loading";
}

export function normalizeCodingPlanProviderId(
  providerId: string | null | undefined,
): CodingPlanProviderId | null {
  const normalized = providerId?.trim();
  return normalized && isCodingPlanModelProviderId(normalized)
    ? (normalized as CodingPlanProviderId)
    : null;
}

export function isCodingPlanProviderId(
  providerId: CodingPlanProviderId | null,
): providerId is CodingPlanProviderId {
  return Boolean(providerId);
}
