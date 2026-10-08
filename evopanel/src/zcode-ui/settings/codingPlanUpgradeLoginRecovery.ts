import type { OAuthProviderId } from "@zcode/shared";
import type { PurchaseAudience } from "@/settings/model-provider-section/codingPlanEnterpriseTiers.js";

export interface CodingPlanUpgradeDialogTarget {
  providerId: string;
  initialAudience?: PurchaseAudience;
  initialTeamPlanKey?: string;
  funnelContext?: import("@/lib/codingPlanFunnelTelemetry.js").CodingPlanFunnelContext;
}

interface PendingCodingPlanUpgradeAfterLogin {
  loginAttemptId: number;
  target: CodingPlanUpgradeDialogTarget;
}

export function beginCodingPlanUpgradeLogin(params: {
  target: CodingPlanUpgradeDialogTarget;
  oauthProviderId: OAuthProviderId;
  audience: PurchaseAudience;
  requestLoginEntry: (providerId?: OAuthProviderId) => number;
  onClose: () => void;
}): PendingCodingPlanUpgradeAfterLogin {
  const loginAttemptId = params.requestLoginEntry(params.oauthProviderId);
  const pending = {
    loginAttemptId,
    target: {
      ...params.target,
      initialAudience: params.audience,
    },
  };
  params.onClose();
  return pending;
}

export function resolvePendingCodingPlanUpgradeAfterLogin(params: {
  pending: PendingCodingPlanUpgradeAfterLogin | null;
  loginAttempt: {
    id: number;
    status: "requested" | "waiting" | "succeeded" | "cancelled" | "failed";
  } | null;
}):
  | { action: "wait" }
  | { action: "discard" }
  | { action: "reopen"; target: CodingPlanUpgradeDialogTarget } {
  if (!params.pending || !params.loginAttempt) {
    return { action: "wait" };
  }
  if (params.loginAttempt.id !== params.pending.loginAttemptId) {
    return { action: "discard" };
  }
  if (params.loginAttempt.status === "requested" || params.loginAttempt.status === "waiting") {
    return { action: "wait" };
  }
  if (params.loginAttempt.status === "succeeded") {
    return { action: "reopen", target: params.pending.target };
  }
  return { action: "discard" };
}
