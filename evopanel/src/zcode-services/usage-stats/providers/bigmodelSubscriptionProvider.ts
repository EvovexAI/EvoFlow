import type { ApiClient, ProviderFamilyDomain } from "@zcode/shared";
import {
  fetchPersonalCodingPlanEntitlement,
  fetchTeamCodingPlanEntitlement,
  type CodingPlanEntitlement,
} from "#src/bigmodel/codingPlanEntitlement.js";
import { pickCurrentSubscriptionFromList } from "./bigmodelUsageQuotaMapper.js";

type SubscriptionSummary = NonNullable<ReturnType<typeof pickCurrentSubscriptionFromList>>;
export async function fetchBigModelSubscriptionSummary(params: {
  apiClient: ApiClient;
  authorization: string;
  quotaUrl: string;
  teamContext?: {
    organizationId: string;
    projectId: string;
    family: ProviderFamilyDomain;
  } | null;
  businessToken?: string | null;
  timeoutMs: number;
}): Promise<CodingPlanEntitlement<SubscriptionSummary>> {
  try {
    const url = new URL(params.quotaUrl);
    url.pathname = "/api/biz/subscription/list";
    url.search = "";
    if (params.teamContext) {
      const token = params.businessToken?.trim();
      if (!token) return { kind: "unknown" };
      const result = await fetchTeamCodingPlanEntitlement({
        apiClient: params.apiClient,
        host: url.origin,
        timeoutMs: params.timeoutMs,
        authorization: params.teamContext.family === "zai" ? `Bearer ${token}` : token,
        teamContext: params.teamContext,
      });
      if (result.kind !== "available") return result;
      const detail = result.subscription;
      return {
        kind: "available",
        subscription: {
          productId: detail.productId ?? "",
          productName: detail.productName ?? "",
          billingCycle: detail.subscribePeriod?.toLowerCase() ?? null,
          expireTime: detail.subscribeEndTime ?? null,
          renewTime: null,
        },
      };
    }
    const result = await fetchPersonalCodingPlanEntitlement({
      ...params,
      url: url.toString(),
    });
    if (result.kind !== "available") return result;
    const subscription = pickCurrentSubscriptionFromList([result.subscription]);
    return subscription ? { kind: "available", subscription } : { kind: "unknown" };
  } catch {
    return { kind: "unknown" };
  }
}
