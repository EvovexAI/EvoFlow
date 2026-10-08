import type { IntlInstance } from "@/i18n/IntlProvider.js";

type UsageErrorSurface = "chatPlan" | "entitlement" | "stats";

const CREDENTIAL_ERROR_PATTERNS = [
  /token\s+(expired|incorrect)/i,
  /expired.*token/i,
  /incorrect.*token/i,
  /invalid.*(?:api\s*)?key/i,
  /(?:api\s*)?key.*invalid/i,
  /unauthorized/i,
  /forbidden/i,
  /\b40[13]\b/,
  /认证|鉴权|授权|密钥|无效|过期/i,
];

// 团队套餐业务错误（如"仅企业主账号可查询企业汇总数据"、
// "您当前暂无有效的团队套餐授权记录，无法创建API Key"）是远端明确的业务拒绝原因，
// 必须原文展示。其中"授权记录"含"授权"字样，若先走 credential 判断会被
// 误判成凭据问题（走翻译文案 + 检查 API Key 按钮），因此业务错误优先匹配。
const TEAM_PLAN_BUSINESS_ERROR_PATTERNS = [
  /企业主账号/,
  /团队套餐/,
  /无法创建API\s*Key/i,
  /授权记录/,
];

export function isUsageTeamPlanBusinessError(error: string | null | undefined): boolean {
  if (!error) {
    return false;
  }

  return TEAM_PLAN_BUSINESS_ERROR_PATTERNS.some((pattern) => pattern.test(error));
}

export function isUsageCredentialError(error: string | null | undefined): boolean {
  if (!error) {
    return false;
  }

  return CREDENTIAL_ERROR_PATTERNS.some((pattern) => pattern.test(error));
}

export function formatUsageErrorMessage(
  intl: IntlInstance,
  surface: UsageErrorSurface,
  error: string | null | undefined,
): string {
  // 团队套餐业务错误是远端明确的业务拒绝原因，generic 文案会掩盖真实失败原因
  // （如"仅企业主账号可查询企业汇总数据"），用户无法判断是权限问题还是网络问题。
  // 必须先于 credential 判断："您当前暂无有效的团队套餐授权记录…"含"授权"字样，
  // 若后判断会被误认为凭据错误而走翻译文案。
  if (isUsageTeamPlanBusinessError(error) && error?.trim()) {
    return error.trim();
  }

  // 供应商接口会返回英文鉴权错误，直接展示会让用户不知道下一步怎么排查。
  // 这里统一把可恢复的 key/OAuth 问题翻译成用户可执行的检查项，原始错误仍由调用方写入日志。
  if (isUsageCredentialError(error)) {
    return intl.formatMessage({ id: `usage.error.${surface}.credential` });
  }

  return intl.formatMessage({ id: `usage.error.${surface}.generic` });
}
