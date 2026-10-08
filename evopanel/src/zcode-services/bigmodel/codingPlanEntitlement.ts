import type { ApiClient } from "@zcode/shared";
import { z } from "zod";
import { readApiJson } from "#src/providers/api/apiJson.js";
import type { BigModelTeamPlanBizContext } from "#src/bigmodel/teamPlanApiKey.js";

const envelopeSchema = z.object({
  code: z.number().optional(),
  success: z.boolean().optional(),
  data: z.unknown().optional(),
});
const personalSchema = z.object({
  productId: z.string().optional(),
  productName: z.string().optional(),
  status: z.string(),
  inCurrentPeriod: z.boolean(),
  autoRenew: z.union([z.number(), z.boolean()]).optional(),
  nextRenewTime: z.string().optional(),
  valid: z.string().optional(),
  billingCycle: z.string().optional(),
});
const teamSchema = z.object({
  hasSubscription: z.boolean(),
  status: z.string().nullish(),
  memberGrantStatus: z.string().nullish(),
  productId: z.string().nullish(),
  productName: z.string().nullish(),
  subscribeEndTime: z.string().nullish(),
  subscribePeriod: z.string().nullish(),
});
type PersonalCodingPlanSubscription = z.infer<typeof personalSchema>;
type TeamCodingPlanSubscription = z.infer<typeof teamSchema>;
export type CodingPlanEntitlement<T> =
  | { kind: "available"; subscription: T }
  | { kind: "unavailable"; reason?: "expired" | "unassigned" }
  | { kind: "unknown" };

function isCodingPlanProduct(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { productId, productName } = value as Record<string, unknown>;
  return [productId, productName].some(
    (field) => typeof field === "string" && field.toLowerCase().includes("coding"),
  );
}

export function isActivePersonalCodingPlan(subscription: {
  productId?: string;
  productName?: string;
  status?: string;
  inCurrentPeriod?: boolean;
}): boolean {
  return (
    isCodingPlanProduct(subscription) &&
    subscription.status === "VALID" &&
    subscription.inCurrentPeriod === true
  );
}

function readSuccessfulData(payload: unknown): unknown {
  const parsed = envelopeSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  const envelope = parsed.data;
  // 沿用 availability 的可选 code 契约；省略成功码不能被解释为业务失败。
  if (
    envelope.success === false ||
    (envelope.code !== undefined && ![0, 200].includes(envelope.code))
  )
    return undefined;
  return envelope.data;
}

export async function fetchPersonalCodingPlanEntitlement(params: {
  apiClient: ApiClient;
  authorization: string;
  url: string;
  timeoutMs: number;
}): Promise<CodingPlanEntitlement<PersonalCodingPlanSubscription>> {
  if (!params.authorization.trim()) return { kind: "unknown" };
  const payload = await readApiJson<unknown>(params.apiClient, params.url, {
    method: "GET",
    timeoutMs: params.timeoutMs,
    headers: { Authorization: params.authorization },
  });
  const list = z.array(z.unknown()).safeParse(readSuccessfulData(payload));
  if (!list.success) return { kind: "unknown" };
  let malformedCodingEntry = false;
  // 订阅列表包含异构商品：只严格验证采用的 Coding 条目，无关条目不能遮蔽有效权益。
  for (const item of list.data) {
    const parsed = personalSchema.safeParse(item);
    if (parsed.success && isActivePersonalCodingPlan(parsed.data)) {
      return { kind: "available", subscription: parsed.data };
    }
    if (!parsed.success && isCodingPlanProduct(item)) malformedCodingEntry = true;
  }
  // 没有有效条目时，疑似 Coding 的损坏数据不能被解释为明确未开通。
  return { kind: malformedCodingEntry ? "unknown" : "unavailable" };
}

export async function fetchTeamCodingPlanEntitlement(params: {
  apiClient: ApiClient;
  authorization: string;
  host: string;
  teamContext: BigModelTeamPlanBizContext;
  timeoutMs: number;
}): Promise<CodingPlanEntitlement<TeamCodingPlanSubscription>> {
  if (!params.authorization.trim()) return { kind: "unknown" };
  const payload = await readApiJson<unknown>(
    params.apiClient,
    `${params.host.replace(/\/$/, "")}/api/biz/team/subscribe/product/querySubscribeDetail`,
    {
      method: "GET",
      timeoutMs: params.timeoutMs,
      headers: {
        Authorization: params.authorization,
        "bigmodel-organization": params.teamContext.organizationId,
        "bigmodel-project": params.teamContext.projectId,
      },
    },
  );
  const parsed = teamSchema.safeParse(readSuccessfulData(payload));
  if (!parsed.success) return { kind: "unknown" };
  const subscription = parsed.data;
  if (!subscription.hasSubscription) return { kind: "unavailable" };
  // 实际接口过期套餐仍返回 hasSubscription=true；存在订阅记录不等于当前有效。
  if (subscription.status === "EXPIRED") return { kind: "unavailable", reason: "expired" };
  if (subscription.status === "EFFECTIVE" && subscription.memberGrantStatus === "UNASSIGNED")
    return { kind: "unavailable", reason: "unassigned" };
  // 未验证的新枚举保持未知，不能擅自解释成无权益。
  if (subscription.status !== "EFFECTIVE" || subscription.memberGrantStatus !== "VALID") {
    return { kind: "unknown" };
  }
  return { kind: "available", subscription };
}
