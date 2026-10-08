/**
 * zcode-plan / Coding Plan 业务错误码与前端处理约定。
 *
 * | 场景           | code | HTTP | 前端处理 |
 * |----------------|------|------|----------|
 * | JWT 缺失/失效  | 1006 | 200  | 跳登录或重新授权 |
 * | 配额不足       | 1005 | 200  | 禁用入口，刷新配额 |
 * | 模型不可用     | 3006 | 400  | 切换到 Built-in Provider 中的其他模型 |
 * | 参数错误       | 3001 | 400  | 检查请求体 |
 * | 安全校验拒绝   | 3007 | 403  | 客户端无法完成安全校验，提示联系支持 |
 * | 模型并发上限   | 3010 | 429  | Start Plan 下走升级横幅 |
 * | 请求过频       | 3002/429 | 429 | 限流提示，稍后重试 |
 * | 闲时票据不可用 | 3102 | 400  | 单段运行时间到顶，提示新建闲时任务续跑 |
 * | 上游 HTTP 异常 | 2007 | 500  | 可重试；刷新配额，勿本地扣额度 |
 */
import { isOffPeakTicketExpiredError } from "@zcode/shared";

const PROVIDER_BUSINESS_ERROR_CODES = [
  "1006",
  "1005",
  "3006",
  "3001",
  "3007",
  "3008",
  "3009",
  "3010",
  "3002",
  "3102",
  "2007",
  "429",
] as const;

type ProviderBusinessErrorCode = (typeof PROVIDER_BUSINESS_ERROR_CODES)[number];

export type ProviderBusinessErrorUiAction =
  | "login"
  | "refresh-quota"
  | "switch-model"
  | "retry-later"
  | "upgrade";

const PROVIDER_BUSINESS_ERROR_MESSAGE_IDS: Record<ProviderBusinessErrorCode, string> = {
  "1006": "zcode.error.providerBusiness.1006",
  "1005": "zcode.error.providerBusiness.1005",
  "3006": "zcode.error.providerBusiness.3006",
  "3002": "zcode.error.providerBusiness.3002",
  "3001": "zcode.error.providerBusiness.3001",
  "3007": "zcode.error.providerBusiness.3007",
  "3008": "zcode.error.providerBusiness.3008",
  "3009": "zcode.error.providerBusiness.3009",
  "3010": "zcode.error.providerBusiness.3010",
  "3102": "zcode.error.providerBusiness.3102",
  "2007": "zcode.error.providerBusiness.2007",
  "429": "zcode.error.providerBusiness.429",
};

const PROVIDER_BUSINESS_ERROR_UI_ACTIONS: Record<
  ProviderBusinessErrorCode,
  ProviderBusinessErrorUiAction | null
> = {
  "1006": "login",
  "1005": "refresh-quota",
  "3006": "switch-model",
  "3001": null,
  // 3007 安全校验拒绝：客户端无法完成安全校验，没有可执行的恢复动作。
  "3007": null,
  // 3008/3009/3010 并发上限：Start Plan 下走升级横幅，非 Start Plan 走 upgrade 动作
  "3008": "upgrade",
  "3009": "upgrade",
  "3010": "upgrade",
  "3002": "retry-later",
  // 3102 闲时票据不可用：只能新建闲时任务续跑，横幅里的重试/切模型都救不回来。
  "3102": null,
  "2007": "retry-later",
  "429": "retry-later",
};

export function isProviderBusinessErrorCode(
  code: string | undefined,
): code is ProviderBusinessErrorCode {
  if (!code) {
    return false;
  }
  return (PROVIDER_BUSINESS_ERROR_CODES as readonly string[]).includes(code);
}

export function getProviderBusinessErrorMessageId(code: string | undefined): string | undefined {
  if (!isProviderBusinessErrorCode(code)) {
    return undefined;
  }
  return PROVIDER_BUSINESS_ERROR_MESSAGE_IDS[code];
}

export function getProviderBusinessErrorUiAction(
  code: string | undefined,
): ProviderBusinessErrorUiAction | null {
  if (!isProviderBusinessErrorCode(code)) {
    return null;
  }
  return PROVIDER_BUSINESS_ERROR_UI_ACTIONS[code];
}

const START_PLAN_QUOTA_EXHAUSTED_WRAPPER_CODES = new Set([
  "PROVIDER_BUSINESS_ERROR",
  "SEND_FAILED",
  "unknown_error",
]);

export function resolveStartPlanQuotaExhaustedBusinessCode(
  code: string | undefined,
  message: string | undefined,
): "1005" | undefined {
  if (code === "1005") {
    return "1005";
  }

  const normalizedCode = code?.trim();
  const normalizedMessage = message?.trim().toLowerCase();
  if (!normalizedMessage) {
    return undefined;
  }

  // 旧版运行中/历史任务只保留外层错误码，真实 providerCode=1005 被压成
  // PROVIDER_BUSINESS_ERROR / SEND_FAILED / unknown_error + "exceed limit/exceed quota limit"。
  // ChatView 会在 Start Plan provider 边界内调用这里，避免误伤其他 provider 的同名错误。
  if (
    (normalizedMessage.includes("exceed limit") ||
      normalizedMessage.includes("exceed quota limit") ||
      normalizedMessage.includes("quota exceeded")) &&
    (!normalizedCode || START_PLAN_QUOTA_EXHAUSTED_WRAPPER_CODES.has(normalizedCode))
  ) {
    return "1005";
  }

  return undefined;
}

const CONCURRENT_LIMIT_WRAPPER_CODES = new Set([
  "PROVIDER_BUSINESS_ERROR",
  "SEND_FAILED",
  "unknown_error",
  "MODEL_RATE_LIMITED",
]);

const CONCURRENT_LIMIT_MESSAGE_PATTERNS = ["concurrent", "concurrency", "并发"];

const MODEL_SCOPED_CONCURRENT_LIMIT_MESSAGE_PATTERNS = ["model", "模型"];

export const START_PLAN_BUSY_AUTO_RETRY_EXHAUSTED_MESSAGE =
  "Start Plan is busy and automatic model stream recovery reached the maximum retry count.";

export type StartPlanConcurrentLimitBannerReason = "initial-busy" | "retry-exhausted-busy";

export const GLM_QUOTA_BANNER_BUSINESS_CODES = [
  "1308",
  "1309",
  "1310",
  "1311",
  "1313",
  "1314",
  "1315",
  "1316",
  "1317",
  "1318",
  "1319",
  "1320",
  "1321",
] as const;

export type GlmQuotaBannerBusinessCode = (typeof GLM_QUOTA_BANNER_BUSINESS_CODES)[number];

const GLM_QUOTA_BANNER_BUSINESS_CODE_SET = new Set<string>(GLM_QUOTA_BANNER_BUSINESS_CODES);

/**
 * 判断是否为并发上限业务错误（3008/3009/3010）。
 * Start Plan 下命中时走并发限制升级横幅，而非普通错误横幅。
 */
export function resolveStartPlanConcurrentLimitBusinessCode(
  code: string | undefined,
  message: string | undefined,
): "3008" | "3009" | "3010" | undefined {
  if (code === "3008") {
    return "3008";
  }
  if (code === "3009") {
    return "3009";
  }
  if (code === "3010") {
    return "3010";
  }

  const normalizedCode = code?.trim();
  const normalizedMessage = message?.trim().toLowerCase();
  if (!normalizedMessage) {
    return undefined;
  }

  // 兜底：旧链路可能把 3008/3009/3010 压成包装码 + 并发相关文案。
  // 部分历史 task 只持久化 unknown_error + "model concurrency limit exceeded"；
  // 这类错误是模型级并发，不能退化成阻断型 3008，否则恢复后仍会锁住 composer。
  if (
    CONCURRENT_LIMIT_MESSAGE_PATTERNS.some((pattern) => normalizedMessage.includes(pattern)) &&
    (!normalizedCode || CONCURRENT_LIMIT_WRAPPER_CODES.has(normalizedCode))
  ) {
    return MODEL_SCOPED_CONCURRENT_LIMIT_MESSAGE_PATTERNS.some((pattern) =>
      normalizedMessage.includes(pattern),
    )
      ? "3009"
      : "3008";
  }

  return undefined;
}

export function resolveGlmQuotaBannerBusinessCode(
  code: string | undefined,
): GlmQuotaBannerBusinessCode | undefined {
  const normalizedCode = code?.trim();
  if (normalizedCode && GLM_QUOTA_BANNER_BUSINESS_CODE_SET.has(normalizedCode)) {
    // GLM API 1308/1309/1310/1311/1313-1321 都是额度、
    // 套餐或账号使用边界，不应被普通错误横幅盖住升级入口。
    return normalizedCode as GlmQuotaBannerBusinessCode;
  }
  return undefined;
}

export function resolveStartPlanConcurrentLimitBannerReason(
  message: string | undefined,
): StartPlanConcurrentLimitBannerReason {
  return message?.trim() === START_PLAN_BUSY_AUTO_RETRY_EXHAUSTED_MESSAGE
    ? "retry-exhausted-busy"
    : "initial-busy";
}

/** 与 core `model-errors.ts` 中 anomaly guard 文案保持一致。 */
export const SUSPICIOUS_EMPTY_MODEL_RESULT_MESSAGE =
  "Model returned no text, no tool calls, and no usage before completing the turn.";

/**
 * 闲时票据不可用（上游 3102：票据失效或过期）。
 * 适配层会把该业务码包成 `off-peak-ticket-expired: <上游原文>` 落到 turn 错误里，
 * 外层 code 被压成 PROVIDER_BUSINESS_ERROR 等包装码时靠稳定标记兜底，
 * 否则横幅会把 "off peak ticket is invaliad or expired" 原文直接怼给用户。
 */
export function resolveOffPeakTicketExpiredBusinessCode(
  code: string | undefined,
  message: string | undefined,
): "3102" | undefined {
  if (code?.trim() === "3102") {
    return "3102";
  }
  return isOffPeakTicketExpiredError(message) ? "3102" : undefined;
}

export function isSuspiciousEmptyModelResultMessage(message: string | undefined): boolean {
  if (!message) {
    return false;
  }

  return (
    message.includes(SUSPICIOUS_EMPTY_MODEL_RESULT_MESSAGE) ||
    message.includes("Model returned no text")
  );
}
