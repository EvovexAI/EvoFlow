import type { UsageEntitlementSnapshot, UsageQuotaLimit } from "@zcode/shared";

type CodingPlanQuotaResetFormat = "date" | "dateTime" | "adaptive";

/**
 * Token / Credit 类配额的等价 type 集合。
 *
 * zai 业务后端 Team Plan 的 quota/limit 用 `CREDIT_LIMIT` 作为 type，
 * bigmodel 业务后端用 `TOKENS_LIMIT`。两者 unit/number 语义完全一致
 *（unit=3,number=5 → 5 小时窗口；unit=6 → 每周），仅 type 枚举命名不同。
 * 这里把两个 type 视为等价，让 zai/bigmodel team plan 在同一套 UI 消费方下都能命中。
 * 若 zai 后端后续对齐到 TOKENS_LIMIT，此集合仍兼容。
 */
const TOKEN_LIMIT_TYPES = new Set(["TOKENS_LIMIT", "CREDIT_LIMIT"]);

/**
 * Tool 类配额的 type。
 * 目前 bigmodel/zai 后端都用 TIME_LIMIT 表示每月工具调用配额，暂无需等价集合。
 */
const TOOL_LIMIT_TYPES = new Set(["TIME_LIMIT"]);

export function isSameLimitCategory(
  limitType: string,
  queryType: UsageQuotaLimit["type"],
): boolean {
  if (limitType === queryType) {
    return true;
  }
  // zai team plan 返回 CREDIT_LIMIT，消费方按 TOKENS_LIMIT 查询时也要命中。
  if (TOKEN_LIMIT_TYPES.has(queryType)) {
    return TOKEN_LIMIT_TYPES.has(limitType);
  }
  if (TOOL_LIMIT_TYPES.has(queryType)) {
    return TOOL_LIMIT_TYPES.has(limitType);
  }
  return false;
}

export function findCodingPlanQuotaLimit(
  limits: UsageQuotaLimit[] | undefined,
  type: UsageQuotaLimit["type"],
  unit: number,
  number?: number,
): UsageQuotaLimit | null {
  return (
    limits?.find(
      (limit) =>
        isSameLimitCategory(limit.type, type) &&
        limit.unit === unit &&
        (number == null || limit.number === number),
    ) ?? null
  );
}

/**
 * 官方 Server MCP 额度（服务端下发的总额度）。
 *
 * 服务端把它放在 entitlement 快照的独立字段而不是 quota.limits[]，因此不能用
 * findCodingPlanQuotaLimit 查询；这里收口成唯一取数入口，避免各展示位各写一遍 `?.` 链路。
 */
export function resolveMcpQuotaLimit(
  snapshot: UsageEntitlementSnapshot | null | undefined,
): UsageQuotaLimit | null {
  return snapshot?.mcpQuota?.aggregate ?? null;
}

export function getQuotaRemainingPercentage(limit: UsageQuotaLimit | null): number | null {
  if (typeof limit?.percentage !== "number" || !Number.isFinite(limit.percentage)) {
    return null;
  }

  // quota 接口的 percentage 表示已使用占比，而 Usage Remaining 与
  // 使用统计的额度卡都表达“还剩多少”。这里统一反转，避免两处显示口径不一致。
  return Math.max(0, Math.min(100, 100 - limit.percentage));
}

/**
 * 额度剩余 100%（未产生任何消耗）时重置没有收益，UI 隐藏「重置」按钮与机会徽标。
 * 纯展示层门控：不影响服务端发放、status 轮询与机会状态本身；
 * processing / completed 展示不走此判断，手动重置的完成反馈仍完整播放。
 */
export function isCodingPlanQuotaLimitFull(limit: UsageQuotaLimit | null | undefined): boolean {
  return getQuotaRemainingPercentage(limit ?? null) === 100;
}

export function formatQuotaRemainingPercentage(
  locale: string,
  limit: UsageQuotaLimit | null,
): string {
  const remainingPercentage = getQuotaRemainingPercentage(limit);
  if (remainingPercentage == null) {
    return "--";
  }

  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: remainingPercentage >= 10 ? 0 : 1,
  }).format(remainingPercentage)}%`;
}

/**
 * Start Plan 额度桶刷新时间的唯一格式化入口（设置页余额卡与聊天输入气泡共用）。
 *
 * 两端曾各自维护一份逐字相同的 formatStartPlanBalanceRenewTime，
 * 格式调整漏改任一处就会重新出现两端展示不一致。桶刷新时间格式与 Coding Plan
 * 对齐：当日仅 HH:mm，非当日仅日期。
 */
export function formatStartPlanBucketResetTime(
  locale: string,
  value: number | null | undefined,
): string | undefined {
  return formatQuotaResetTime({ locale, value, format: "adaptive" });
}

export function formatQuotaResetTime(params: {
  locale: string;
  value: number | null | undefined;
  format: CodingPlanQuotaResetFormat;
  compactToday?: boolean;
}): string | undefined {
  if (!params.value) {
    return undefined;
  }

  const resetAt = new Date(params.value);
  if (Number.isNaN(resetAt.getTime())) {
    return undefined;
  }

  const now = new Date();
  const isToday =
    resetAt.getFullYear() === now.getFullYear() &&
    resetAt.getMonth() === now.getMonth() &&
    resetAt.getDate() === now.getDate();

  if (params.format === "date") {
    return new Intl.DateTimeFormat(params.locale, {
      month: "short",
      day: "numeric",
    }).format(resetAt);
  }

  // adaptive：当日只展示 HH:mm（时刻才可行动），非当日只展示日期
  //（与 Coding Plan 五小时窗口 / 周·月重置的展示语义一致）。
  if (params.format === "adaptive") {
    if (isToday) {
      return new Intl.DateTimeFormat(params.locale, {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(resetAt);
    }
    return new Intl.DateTimeFormat(params.locale, {
      month: "short",
      day: "numeric",
    }).format(resetAt);
  }

  return new Intl.DateTimeFormat(params.locale, {
    ...(params.compactToday && isToday
      ? {}
      : {
          month: "short",
          day: "numeric",
        }),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(resetAt);
}
