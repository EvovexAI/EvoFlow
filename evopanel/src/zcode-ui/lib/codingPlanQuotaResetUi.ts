import type {
  CodingPlanResetStatusSnapshot,
  CodingPlanResetType,
  UsageQuotaLimit,
} from "@zcode/shared";
// 完成后“额度已重置”提示的停留时长，随后自动收起提示（额度条保持 100%）。
export const CODING_PLAN_QUOTA_RESET_DONE_DISPLAY_MS = 2_600;
// 自动/运营重置在 Composer 触发器上先合成一小段“正在重置”的时长，随后切换为“已重置”。
// 后端没有 processing 信号，这里仅在客户端还原一次“处理中→已重置”的观感。
export const CODING_PLAN_QUOTA_RESET_AUTOMATIC_PROCESSING_MS = 1_000;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

// 完成后乐观改写“下一次重置时间”的周期：五小时额度按 5 小时，周额度按 7 天。
function resolveCodingPlanQuotaResetDurationMs(resetType: CodingPlanResetType): number {
  return resetType === "WEEK" ? WEEK_MS : FIVE_HOURS_MS;
}

// available：服务端下发了可用的五小时重置机会。
// processing：用户已发起手动核销，正在等待 use + status 对账。
// completed：status 已返回服务端 used_at；自动/运营重置不会经过 processing。
export type CodingPlanQuotaResetUiStatus = "available" | "processing" | "completed";

export interface CodingPlanQuotaResetUiEntry {
  status: CodingPlanQuotaResetUiStatus;
  /** 剩余重置机会次数；processing/completed 归零。 */
  opportunityCount: number;
  /** 最早的重置机会到期时刻；仅 available 有效。 */
  opportunityExpiresAt: number | null;
  /** 本地手动核销开始时刻；自动/运营重置为 null。 */
  startedAt: number | null;
  /** 服务端 latest_{five_hour,week}_reset_history.used_at。 */
  completedAt: number | null;
  /** 客户端首次观察到当前 completedAt 的时间，仅用于短提示和动效。 */
  observedAt: number | null;
  /** entitlement 刷新成功前允许临时把额度覆盖为 100%。 */
  quotaOverridePending: boolean;
  nextResetAt: number | null;
  /** 同一次失败重试必须复用的幂等键；成功对账后清空。 */
  idempotencyKey: string | null;
  error: string | null;
}

export interface CodingPlanQuotaResetCelebrationState {
  sourceKey: string | null;
  /** 已从触发器为该 used_at 撒过花；同一次完成在重复渲染/轮询时不得重播。 */
  celebratedCompletedAt: number | null;
}

/** 同一 source 下五小时与周额度各自独立的重置状态。 */
export interface CodingPlanQuotaResetUiEntries {
  fiveHour: CodingPlanQuotaResetUiEntry | null;
  week: CodingPlanQuotaResetUiEntry | null;
}

/** 五小时/周共用同一份重置状态机，只在读取机会/历史字段时按类型区分。 */
export const CODING_PLAN_QUOTA_RESET_TYPES = [
  "FIVE_HOUR",
  "WEEK",
] as const satisfies readonly CodingPlanResetType[];

export function advanceCodingPlanQuotaResetCelebration(
  previous: CodingPlanQuotaResetCelebrationState | null,
  input: {
    sourceKey: string | null;
    completedAt: number | null;
    /** 自动/运营完成（startedAt 为空）的短提示窗口；手动重置由按钮自身撒花，触发器不参与。 */
    automaticCompletion: boolean;
  },
): {
  state: CodingPlanQuotaResetCelebrationState;
  shouldCelebrate: boolean;
} {
  // 手动核销同样会经过 processing，“见过 processing”不能再作为触发器撒花依据，
  // 否则手动重置会叠加按钮和触发器两处动画。触发器只认自动完成的新 used_at，
  // source 切换时清空轨迹，避免 Team/个人套餐之间重复撒花或漏掉自动重置动效。
  const sourceChanged = previous?.sourceKey !== input.sourceKey;
  const celebratedCompletedAt = sourceChanged ? null : (previous?.celebratedCompletedAt ?? null);
  const shouldCelebrate = Boolean(
    input.sourceKey &&
    input.automaticCompletion &&
    input.completedAt !== null &&
    input.completedAt !== celebratedCompletedAt,
  );

  return {
    state: {
      sourceKey: input.sourceKey,
      celebratedCompletedAt: shouldCelebrate ? input.completedAt : celebratedCompletedAt,
    },
    shouldCelebrate,
  };
}

function createAvailableEntry(
  opportunityCount: number,
  opportunityExpiresAt: number,
  idempotencyKey: string | null,
): CodingPlanQuotaResetUiEntry {
  return {
    status: "available",
    opportunityCount,
    opportunityExpiresAt,
    startedAt: null,
    completedAt: null,
    observedAt: null,
    quotaOverridePending: false,
    nextResetAt: null,
    idempotencyKey,
    error: null,
  };
}

function createCompletedEntry(
  previous: CodingPlanQuotaResetUiEntry | null,
  completedAt: number,
  observedAt: number,
  manualStartedAt: number | null,
  nextResetMs: number,
): CodingPlanQuotaResetUiEntry {
  const isSameCompletion = previous?.status === "completed" && previous.completedAt === completedAt;
  return {
    status: "completed",
    opportunityCount: 0,
    opportunityExpiresAt: null,
    // 手动点击和完成历史可能由不同入口观察。只依赖当前 source 的 processing
    // 会让 Composer 把设置页发起的手动重置误判成自动重置，重复显示 Tooltip 和烟花。
    // 同一完成历史重复对账时也必须保留原分类，不能在下一次轮询时退化为自动完成。
    startedAt: isSameCompletion
      ? previous.startedAt
      : previous?.status === "processing"
        ? previous.startedAt
        : manualStartedAt,
    completedAt,
    // 自动/运营重置可能在 used_at 之后最多 60 秒才被轮询发现。
    // 短提示必须从首次观察时刻起算；同一 used_at 的重复轮询则不能续期。
    observedAt: isSameCompletion ? (previous.observedAt ?? observedAt) : observedAt,
    quotaOverridePending: isSameCompletion ? previous.quotaOverridePending : true,
    nextResetAt: completedAt + nextResetMs,
    idempotencyKey: null,
    error: null,
  };
}

/**
 * 把服务端 status 应用到窗口内共享 UI 状态。
 *
 * 旧历史且 has_unread_history=false 不能在首次挂载时进入 completed，
 * 否则客户端会把几小时前的历史重置错误覆盖成当前 100% 剩余额度。
 *
 * resetType 决定读取五小时还是周额度的机会/历史。has_unread_history 是两种重置
 * 类型共享的单一游标，因此只有 used_at 最新的那一类“拥有”这个未读标记：否则一次
 * 周重置就会把过期的五小时历史误判为刚完成，反之亦然。
 */
export function applyCodingPlanQuotaResetStatus(
  previous: CodingPlanQuotaResetUiEntry | null,
  status: CodingPlanResetStatusSnapshot,
  now: number,
  manualStartedAt: number | null = null,
  resetType: CodingPlanResetType = "FIVE_HOUR",
): CodingPlanQuotaResetUiEntry | null {
  const availableResets =
    resetType === "WEEK" ? status.availableWeekResets : status.availableFiveHourResets;
  const latestUsedAt =
    (resetType === "WEEK"
      ? status.latestWeekResetHistory?.usedAt
      : status.latestFiveHourResetHistory?.usedAt) ?? null;
  const otherUsedAt =
    (resetType === "WEEK"
      ? status.latestFiveHourResetHistory?.usedAt
      : status.latestWeekResetHistory?.usedAt) ?? null;
  // 共享 has_unread_history 只归属 used_at 最新的一类；相等时按当前类型归属，
  // 保证有新历史时至少有一类能进入完成态，且不会两类同时抢占。
  const ownsUnread =
    status.hasUnreadHistory &&
    latestUsedAt !== null &&
    (otherUsedAt === null || latestUsedAt >= otherUsedAt);
  const validOpportunities = availableResets
    .filter((item) => Number.isFinite(item.expireAt) && item.expireAt > now)
    .sort((left, right) => left.expireAt - right.expireAt);
  // 同一 used_at 的粘滞完成态与共享手动轨迹归因只在“没有新机会”时生效。
  // 后端可能在同一重置周期内（used_at 未变）再次发放机会；若完成态继续优先，新机会
  // 会被 UI 永久吞掉，用户重新登录（清空窗口内存态）才能看到入口。有效机会到来即视为
  // 进入新一轮周期，回到 AVAILABLE。ownsUnread（刚发现的未读完成）不受影响：完成提示
  // 与额度校正先播，history/read 后的下一轮再让位；processing 对账也不受影响：机会
  // 余额 >0 时手动 /use 确认循环仍必须看到 completed。
  const hasValidOpportunity = validOpportunities.length > 0;
  const shouldComplete = Boolean(
    latestUsedAt !== null &&
    (ownsUnread ||
      previous?.status === "processing" ||
      ((manualStartedAt !== null ||
        (previous?.status === "completed" && previous.completedAt === latestUsedAt)) &&
        !hasValidOpportunity)),
  );
  if (shouldComplete && latestUsedAt !== null) {
    return createCompletedEntry(
      previous,
      latestUsedAt,
      now,
      manualStartedAt,
      resolveCodingPlanQuotaResetDurationMs(resetType),
    );
  }

  // 手动 use 期间 status 轮询可能仍读到消费前快照。此时保持 processing，
  // 只有服务端 used_at 才能确认成功，不能被旧 opportunity 回退成可再次点击。
  if (previous?.status === "processing") {
    return previous;
  }

  const earliest = validOpportunities[0];
  if (earliest) {
    return createAvailableEntry(
      validOpportunities.length,
      earliest.expireAt,
      previous?.status === "available" ? previous.idempotencyKey : null,
    );
  }

  return null;
}

export function startCodingPlanQuotaResetManualUse(
  entry: CodingPlanQuotaResetUiEntry | null,
  idempotencyKey: string,
  now: number,
): CodingPlanQuotaResetUiEntry | null {
  if (!entry || entry.status !== "available") {
    return entry;
  }

  return {
    ...entry,
    status: "processing",
    // processing 时保留点击前的机会快照，失败后才能无损恢复并复用幂等键。
    opportunityCount: entry.opportunityCount,
    opportunityExpiresAt: entry.opportunityExpiresAt,
    startedAt: now,
    completedAt: null,
    observedAt: null,
    quotaOverridePending: false,
    nextResetAt: null,
    idempotencyKey: entry.idempotencyKey ?? idempotencyKey,
    error: null,
  };
}

export function failCodingPlanQuotaResetManualUse(
  entry: CodingPlanQuotaResetUiEntry | null,
  error: string,
): CodingPlanQuotaResetUiEntry | null {
  if (!entry || entry.status !== "processing") {
    return entry;
  }

  return {
    ...entry,
    status: "available",
    // 失败恢复必须保留点击前的机会数量和过期时间，否则入口会消失，
    // 用户也无法用原幂等键重试同一次核销。
    opportunityCount: entry.opportunityCount,
    opportunityExpiresAt: entry.opportunityExpiresAt,
    startedAt: null,
    completedAt: null,
    observedAt: null,
    quotaOverridePending: false,
    nextResetAt: null,
    error,
  };
}

/**
 * 合并五小时与周额度的机会徽标展示：一个礼物徽标、次数累加，
 * 倒计时取可见机会中最早到期的一档；某档到期/隐藏后自动回落到剩余档。
 * 仅影响徽标展示，重置按钮仍按类型各自独立。
 */
export function mergeCodingPlanQuotaResetOpportunityBadges(
  items: ReadonlyArray<{
    count: number;
    expiresAt: number | null;
    visible: boolean;
  }>,
): { count: number; expiresAt: number | null; visible: boolean } {
  const visibleItems = items.filter((item) => item.visible && item.count > 0);
  return {
    count: visibleItems.reduce((sum, item) => sum + item.count, 0),
    expiresAt:
      visibleItems
        .map((item) => item.expiresAt)
        .filter((value): value is number => value !== null)
        .sort((left, right) => left - right)[0] ?? null,
    visible: visibleItems.length > 0,
  };
}

export function completeCodingPlanQuotaResetEntitlementRefresh(
  entry: CodingPlanQuotaResetUiEntry | null,
  completedAt: number,
): CodingPlanQuotaResetUiEntry | null {
  if (
    entry?.status !== "completed" ||
    entry.completedAt !== completedAt ||
    !entry.quotaOverridePending
  ) {
    return entry;
  }
  return { ...entry, quotaOverridePending: false };
}

export function resolveCodingPlanQuotaResetLimit(
  limit: UsageQuotaLimit | null | undefined,
  entry: CodingPlanQuotaResetUiEntry | null,
): UsageQuotaLimit | null {
  if (!limit) {
    return null;
  }
  if (entry?.status !== "completed") {
    return limit;
  }
  if (!entry.quotaOverridePending) {
    // 重置后额度池没有活跃窗口（新窗口从下一条 prompt 才开始），刷新回来的真实
    // 额度可能缺失 nextResetTime。entitlement 刷新几乎与完成同 tick，乐观改写只存活几百
    // 毫秒，「重置时间」会闪现即消失。完成态期间继续用 completedAt + 周期 兜底展示；
    // 服务端一旦给出真实窗口（用户已发新消息）则立即让位。percentage 不再覆盖，以刷新为准。
    return limit.nextResetTime == null && entry.nextResetAt !== null
      ? { ...limit, nextResetTime: entry.nextResetAt }
      : limit;
  }

  return {
    ...limit,
    // quota 接口的 percentage 表示已使用占比；UI 完成态覆盖为 0% 已使用，即 100% 剩余。
    percentage: 0,
    nextResetTime: entry.nextResetAt ?? limit.nextResetTime,
  };
}

// available 由礼物徽标 +「重置」按钮承载，因此不打开工具栏 Tooltip。
// 手动重置已经由按钮自身展示 loading，并在成功后播放烟花；如果这里再展示
// processing/completed Tooltip，会形成重复反馈。只有自动/运营完成（startedAt 为空）保留短提示。
export function resolveCodingPlanQuotaResetStatusVisible(
  entry: CodingPlanQuotaResetUiEntry | null,
  now: number,
  doneDisplayMs: number = CODING_PLAN_QUOTA_RESET_DONE_DISPLAY_MS,
): boolean {
  if (entry?.status !== "completed" || entry.startedAt !== null || entry.observedAt === null) {
    return false;
  }
  return now - entry.observedAt < doneDisplayMs;
}

// Composer 触发器上自动/运营重置提示的合成阶段：
// - processing：首次观察后约 1 秒展示“正在重置”，还原服务端处理中的观感（后端无 processing 信号）。
// - completed：随后切换为“已重置”，并一直保留，直到用户 hover 触发器查看额度面板后由组件收起。
// dismissed=true（已 hover 收起）或非自动完成（手动 startedAt 不为空 / 未完成 / 未观察）时返回 null。
export type CodingPlanQuotaResetAutomaticPhase = "processing" | "completed";

export function resolveCodingPlanQuotaResetAutomaticPhase(
  entry: CodingPlanQuotaResetUiEntry | null,
  now: number,
  dismissed: boolean,
  processingMs: number = CODING_PLAN_QUOTA_RESET_AUTOMATIC_PROCESSING_MS,
): CodingPlanQuotaResetAutomaticPhase | null {
  if (dismissed) {
    return null;
  }
  if (entry?.status !== "completed" || entry.startedAt !== null || entry.observedAt === null) {
    return null;
  }
  return now - entry.observedAt < processingMs ? "processing" : "completed";
}

/**
 * 清除已失效的补播撒花 arm：armed 的 used_at 不再是当前生效的自动完成
 * （被跨窗口抑制置空 observedAt，或被更新的 used_at 取代）时必须清 arm，
 * 否则其他窗口 hover 面板时仍会从「已重置」位置撒花，违背“多窗口只播一次”。
 */
export function pruneCodingPlanQuotaResetConfettiArms(
  arms: Record<CodingPlanResetType, number | null>,
  automaticCompletedAtByType: Record<CodingPlanResetType, number | null>,
): Record<CodingPlanResetType, number | null> {
  let changed = false;
  const next = { ...arms };
  for (const resetType of CODING_PLAN_QUOTA_RESET_TYPES) {
    const armed = next[resetType];
    if (armed !== null && automaticCompletedAtByType[resetType] !== armed) {
      next[resetType] = null;
      changed = true;
    }
  }
  return changed ? next : arms;
}
