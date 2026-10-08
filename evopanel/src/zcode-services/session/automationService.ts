import type {
  ZCodeAutomation,
  ZCodeAutomationCreateParams,
  ZCodeAutomationRun,
  ZCodeAutomationScheduleRule,
  ZCodeAutomationUpdateParams,
} from "@zcode/shared";
import { resolveWorkspaceKey } from "@zcode/shared";
import { AutomationRepo } from "#src/session/automationRepo.js";
import {
  assertValidAutomationIntervalCarrier,
  forceIntervalCarrierRecurring,
} from "#src/session/automationIntervalCarrier.js";
export { InvalidAutomationIntervalCarrierError } from "#src/session/automationIntervalCarrier.js";
import {
  buildIntervalScheduleRule,
  buildRelativeDelaySchedule,
  computeInitialAutomationNextRunAt,
  computeAutomationNextRunAt,
  inferMinuteIntervalScheduleRule,
  isValidCronExpr,
  scheduleRuleDefinition,
} from "#src/session/automationCron.js";

/** 写/单查操作的 workspace 归属；用于跨 workspace 隔离校验。 */
interface AutomationWorkspaceScope {
  workspacePath: string;
  workspaceIdentity?: string;
}

/** scope → workspaceKey；缺省返回 undefined（不加归属过滤，供 scheduler/host 跨 workspace 用）。 */
function resolveScopeKey(scope?: AutomationWorkspaceScope): string | undefined {
  if (!scope?.workspacePath) return undefined;
  return resolveWorkspaceKey({
    workspacePath: scope.workspacePath,
    workspaceIdentity: scope.workspaceIdentity,
  });
}

/** 无效 cron 表达式错误（供管理层向 UI 返回可展示信息）。 */
export class InvalidCronExprError extends Error {
  constructor(cronExpr: string) {
    super(`非法的 cron 表达式：${cronExpr}`);
    this.name = "InvalidCronExprError";
  }
}

/** 非法的有限次数更新错误；用于阻止矛盾状态写入并误结束仍在运行的任务。 */
class InvalidAutomationMaxRunsUpdateError extends Error {
  constructor(message = "清空 maxRuns 时必须在同一次更新中设置 recurring=true") {
    super(message);
    this.name = "InvalidAutomationMaxRunsUpdateError";
  }
}

/** 非法自定义调度规则；规则必须先通过领域校验才能写入内部任务库。 */
class InvalidAutomationScheduleRuleError extends Error {
  constructor(message: string) {
    super(`非法的定时任务调度规则：${message}`);
    this.name = "InvalidAutomationScheduleRuleError";
  }
}

/** 相对延迟只用于一次性任务，并由服务端真实时钟生成调度规则。 */
class InvalidAutomationRelativeDelayError extends Error {
  constructor(message: string) {
    super(`非法的相对时间定时任务：${message}`);
    this.name = "InvalidAutomationRelativeDelayError";
  }
}

const MAX_MONTHLY_AUTOMATION_SCHEDULE_INTERVAL = 1_200;
const AUTOMATION_SCHEDULE_RULE_UNITS = new Set([
  "minute",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
]);

function hasOnlyIntegersInRange(values: number[] | undefined, min: number, max: number): boolean {
  return Boolean(
    values?.length &&
    values.every((value) => Number.isInteger(value) && value >= min && value <= max),
  );
}

function assertValidAutomationScheduleRule(rule: ZCodeAutomationScheduleRule): void {
  if (!AUTOMATION_SCHEDULE_RULE_UNITS.has(rule.unit)) {
    throw new InvalidAutomationScheduleRuleError("unit 不受支持");
  }
  if (!Number.isInteger(rule.interval) || rule.interval < 1) {
    throw new InvalidAutomationScheduleRuleError("interval 必须是正整数");
  }
  if (rule.unit === "monthly" && rule.interval > MAX_MONTHLY_AUTOMATION_SCHEDULE_INTERVAL) {
    throw new InvalidAutomationScheduleRuleError(
      `monthly interval 不能超过 ${MAX_MONTHLY_AUTOMATION_SCHEDULE_INTERVAL}`,
    );
  }
  if (!Number.isInteger(rule.hour) || rule.hour < 0 || rule.hour > 23) {
    throw new InvalidAutomationScheduleRuleError("hour 必须是 0-23 的整数");
  }
  if (!Number.isInteger(rule.minute) || rule.minute < 0 || rule.minute > 59) {
    throw new InvalidAutomationScheduleRuleError("minute 必须是 0-59 的整数");
  }
  if (
    rule.monthlyMode !== undefined &&
    rule.monthlyMode !== "date" &&
    rule.monthlyMode !== "weekday"
  ) {
    throw new InvalidAutomationScheduleRuleError("monthlyMode 不受支持");
  }
  if (rule.weekdays && !hasOnlyIntegersInRange(rule.weekdays, 0, 6)) {
    throw new InvalidAutomationScheduleRuleError("weekdays 必须是 0-6 的非空整数数组");
  }
  if (rule.unit === "weekly" && !hasOnlyIntegersInRange(rule.weekdays, 0, 6)) {
    throw new InvalidAutomationScheduleRuleError("weekly 规则必须包含有效的 weekdays");
  }
  if (rule.unit === "monthly") {
    if (rule.monthlyMode === "weekday" && !hasOnlyIntegersInRange(rule.weekdays, 0, 6)) {
      throw new InvalidAutomationScheduleRuleError("monthly weekday 规则必须包含有效的 weekdays");
    }
    if (rule.monthlyMode !== "weekday" && !hasOnlyIntegersInRange(rule.monthDays, 1, 31)) {
      throw new InvalidAutomationScheduleRuleError("monthly date 规则必须包含有效的 monthDays");
    }
  }
  if (rule.months && !hasOnlyIntegersInRange(rule.months, 1, 12)) {
    throw new InvalidAutomationScheduleRuleError("months 必须是 1-12 的非空整数数组");
  }
  if (rule.monthDays && !hasOnlyIntegersInRange(rule.monthDays, 1, 31)) {
    throw new InvalidAutomationScheduleRuleError("monthDays 必须是 1-31 的非空整数数组");
  }
}

/**
 * automation 管理服务：包 AutomationRepo，负责 cron 语义（校验 / 下次时间计算）+ 生命周期重算。
 * 仓库只做存储；这里承载「create 时算 next_run_at」「改 cron_expr 重算」「改 recurring/max_runs 重算生命周期」
 * 「restart 重算」等 cron 相关业务，供 UI 管理面 / RPC 调用。
 */
export class AutomationService {
  constructor(private readonly repo: AutomationRepo = new AutomationRepo()) {}

  async create(params: ZCodeAutomationCreateParams): Promise<ZCodeAutomation> {
    const createdAt = Date.now();
    const relativeDelayMinutes = params.relativeDelayMinutes;
    if (
      relativeDelayMinutes !== undefined &&
      (!Number.isInteger(relativeDelayMinutes) ||
        relativeDelayMinutes < 1 ||
        relativeDelayMinutes > 525_600)
    ) {
      throw new InvalidAutomationRelativeDelayError("delayMinutes 必须是 1-525600 的整数");
    }
    if (relativeDelayMinutes !== undefined && params.recurring) {
      throw new InvalidAutomationRelativeDelayError("相对延迟任务必须设置 recurring=false");
    }
    if (relativeDelayMinutes !== undefined && params.maxRuns !== undefined) {
      throw new InvalidAutomationRelativeDelayError("相对延迟任务固定只运行一次，不能设置 maxRuns");
    }
    if (relativeDelayMinutes !== undefined && params.scheduleRule) {
      throw new InvalidAutomationRelativeDelayError("不能同时提交 delayMinutes 和 scheduleRule");
    }
    const intervalUnit = params.intervalUnit;
    const interval = params.interval;
    assertValidAutomationIntervalCarrier({
      intervalUnit,
      interval,
      scheduleRule: params.scheduleRule,
      relativeDelayMinutes,
      recurring: params.recurring,
      maxRuns: params.maxRuns,
    });
    // carrier 只用于本次归一化，不能透传到 repository 形成未定义的持久化字段。
    const {
      relativeDelayMinutes: _relativeDelayMinutes,
      intervalUnit: _intervalUnit,
      interval: _interval,
      ...persistedParams
    } = params;
    // 模型只知道日期时会自行猜测当前时刻，把“3 分钟后”算成两小时后或过去时间。
    // 相对时间必须由领域层基于真实 Date.now() 建立锚点，不能信任模型换算的绝对 cron。
    const relativeNormalizedParams =
      relativeDelayMinutes === undefined
        ? persistedParams
        : {
            ...persistedParams,
            ...buildRelativeDelaySchedule(relativeDelayMinutes, createdAt),
            recurring: false,
          };
    // 会话侧自定义重复 carrier 归一化：把 intervalUnit+interval + 兼容 cron 组装成权威 scheduleRule，
    // 真实间隔由 scheduleRule 承载，cronExpr 仅作展示。锚点用服务端真实创建时刻（同 relativeDelay）。
    const normalizedParams =
      intervalUnit !== undefined && interval !== undefined
        ? {
            ...relativeNormalizedParams,
            // carrier 必须无限循环，避免旧客户端 / 内部调用写出首次派发即完成的矛盾状态。
            recurring: true,
            maxRuns: undefined,
            scheduleRule: buildIntervalScheduleRule(
              intervalUnit,
              interval,
              relativeNormalizedParams.cronExpr,
              createdAt,
            ),
          }
        : relativeNormalizedParams;
    if (!isValidCronExpr(normalizedParams.cronExpr)) {
      throw new InvalidCronExprError(normalizedParams.cronExpr);
    }
    // computeScheduleRuleNextRunAt 曾静默修正 interval=0，并在超大间隔下返回 null，
    // 使非法规则仍被持久化为 active。写库前必须在领域层拒绝，不能依赖 UI 选择器兜底。
    if (normalizedParams.scheduleRule) {
      assertValidAutomationScheduleRule(normalizedParams.scheduleRule);
    }
    // 标准 `*/N` cron 会对齐墙钟刻度，11:46 创建“每 10 分钟”会在 11:50
    // 提前触发。产品语义是从创建时刻计时，因此缺少显式规则时在领域层补上分钟锚点。
    const scheduleRule = normalizedParams.scheduleRule
      ? { ...normalizedParams.scheduleRule, anchorAt: createdAt }
      : inferMinuteIntervalScheduleRule(normalizedParams.cronExpr, createdAt);
    const createParams = scheduleRule ? { ...normalizedParams, scheduleRule } : normalizedParams;
    // 五段 cron 不含年份；一次性固定月日任务若在创建过程中刚错过目标分钟，
    // 普通 nextRun 会滚到下一年。首次计算只补偿小于一分钟的跨分钟误差，陈旧目标在写库前拒绝。
    const nextRunAt = computeInitialAutomationNextRunAt(createParams, createdAt);
    const endedBeforeFirstRun =
      createParams.endAt !== undefined && (nextRunAt ?? Infinity) > createParams.endAt;
    return this.repo.create(createParams, {
      nextRunAt: endedBeforeFirstRun ? null : nextRunAt,
      ...(endedBeforeFirstRun ? { lifecycleStatus: "completed" as const } : {}),
    });
  }

  async list(scope?: {
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeAutomation[]> {
    return this.repo.list(scope);
  }

  async hasTaskBinding(scope: {
    workspacePath: string;
    workspaceIdentity?: string;
    targetTaskId: string;
  }): Promise<boolean> {
    return this.repo.hasTaskBinding(scope);
  }

  async get(
    automationId: string,
    scope?: AutomationWorkspaceScope,
  ): Promise<ZCodeAutomation | null> {
    return this.repo.get(automationId, resolveScopeKey(scope));
  }

  async update(
    automationId: string,
    params: ZCodeAutomationUpdateParams,
    scope?: AutomationWorkspaceScope,
  ): Promise<ZCodeAutomation | null> {
    const workspaceKey = resolveScopeKey(scope);
    const existing = await this.repo.get(automationId, workspaceKey);
    if (!existing) return null;

    if (params.scheduleRule) assertValidAutomationScheduleRule(params.scheduleRule);

    // 会话侧自定义重复 carrier 校验：intervalUnit+interval 必须配对且限定为 1–200，并与直传 scheduleRule 互斥。
    const { intervalUnit, interval, scheduleRule: directScheduleRule, ...restParams } = params;
    // `undefined` 表示不修改，`null` 表示显式清除已有规则；两者不能在解构后混为一谈。
    // 用 `??` 合并会把 `scheduleRule: null` 当作未传，导致用户无法恢复普通 cron 调度。
    const hasDirectScheduleRule = directScheduleRule !== undefined;
    assertValidAutomationIntervalCarrier({
      intervalUnit,
      interval,
      scheduleRule: hasDirectScheduleRule ? directScheduleRule : undefined,
      recurring: restParams.recurring,
      maxRuns: restParams.maxRuns,
    });
    const hasIntervalCarrier = intervalUnit !== undefined && interval !== undefined;

    // 把 maxRuns=null 转成 undefined 后又按一次性任务上限 1 计算，
    // 会将已运行过的有限次任务静默改成 completed。清空上限必须与切换无限循环原子提交。
    if (!hasIntervalCarrier && restParams.maxRuns === null && restParams.recurring !== true) {
      throw new InvalidAutomationMaxRunsUpdateError();
    }

    const nextRecurring = hasIntervalCarrier ? true : (restParams.recurring ?? existing.recurring);
    if (nextRecurring && typeof restParams.maxRuns === "number") {
      throw new InvalidAutomationMaxRunsUpdateError("无限循环任务不能设置有限次数 maxRuns");
    }

    // 有限任务只提交 recurring=true 时，旧 maxRuns 会被 repo.update 原样保留，
    // 形成“无限循环 + 有限上限”的矛盾隐藏状态。领域层统一补 null，兼容旧客户端并原子清除旧上限；
    // 同时顺手修复历史上已经存在的同类脏数据。
    const normalizedParams: ZCodeAutomationUpdateParams = hasIntervalCarrier
      ? forceIntervalCarrierRecurring(restParams)
      : nextRecurring &&
          restParams.maxRuns === undefined &&
          (restParams.recurring === true || existing.maxRuns !== undefined)
        ? { ...restParams, maxRuns: null }
        : restParams;

    const options: {
      nextRunAt?: number | null;
      lifecycleStatus?: ZCodeAutomation["lifecycleStatus"];
      resetRetry?: boolean;
    } = {};

    // 改 cron_expr：校验 + 以 now 重算 next_run_at + 清 retry 态。
    const cronChanged =
      normalizedParams.cronExpr !== undefined && normalizedParams.cronExpr !== existing.cronExpr;
    if (normalizedParams.cronExpr !== undefined && !isValidCronExpr(normalizedParams.cronExpr)) {
      throw new InvalidCronExprError(normalizedParams.cronExpr);
    }
    const updatedAt = Date.now();
    const effectiveCron = normalizedParams.cronExpr ?? existing.cronExpr;
    // 会话侧长间隔 carrier 归一化：把 intervalUnit+interval + 兼容 cron 组装成权威 scheduleRule。
    // carrier 场景必须重新锚定（anchorAt=updatedAt），后续 explicitScheduleRule 的「规则未变保留旧锚点」
    // 判断对 carrier 无意义——carrier 提交即代表用户要重设间隔，统一走本次保存重新计时。
    const carrierScheduleRule = hasIntervalCarrier
      ? buildIntervalScheduleRule(intervalUnit, interval, effectiveCron, updatedAt)
      : undefined;
    const effectiveDirectScheduleRule = hasDirectScheduleRule
      ? directScheduleRule
      : carrierScheduleRule;
    const normalizedWithSchedule: ZCodeAutomationUpdateParams =
      effectiveDirectScheduleRule !== undefined
        ? { ...normalizedParams, scheduleRule: effectiveDirectScheduleRule }
        : normalizedParams;
    if (effectiveDirectScheduleRule) {
      assertValidAutomationScheduleRule(effectiveDirectScheduleRule);
    }
    const explicitScheduleRule = effectiveDirectScheduleRule
      ? {
          ...effectiveDirectScheduleRule,
          // 规则内容没变只是保存其它字段时保留原锚点；真正修改频率才从本次保存重新计时。
          anchorAt:
            existing.scheduleRule &&
            scheduleRuleDefinition(existing.scheduleRule) ===
              scheduleRuleDefinition(effectiveDirectScheduleRule)
              ? existing.scheduleRule.anchorAt
              : updatedAt,
        }
      : effectiveDirectScheduleRule;
    // cron 改变但调用方没有显式 scheduleRule 时，旧规则不能继续覆盖新 cron；分钟间隔以本次
    // 修改时间重新锚定，其它 cron 则清空旧规则并恢复日历 cron 语义。
    const inferredScheduleRule =
      cronChanged && effectiveDirectScheduleRule === undefined
        ? inferMinuteIntervalScheduleRule(effectiveCron, updatedAt)
        : undefined;
    const effectiveScheduleRule =
      effectiveDirectScheduleRule === undefined
        ? cronChanged
          ? inferredScheduleRule
          : existing.scheduleRule
        : (explicitScheduleRule ?? undefined);
    const updateParams =
      cronChanged && effectiveDirectScheduleRule === undefined
        ? { ...normalizedWithSchedule, scheduleRule: inferredScheduleRule ?? null }
        : effectiveDirectScheduleRule === undefined
          ? normalizedWithSchedule
          : { ...normalizedWithSchedule, scheduleRule: explicitScheduleRule ?? null };
    if (
      cronChanged ||
      normalizedParams.endAt !== undefined ||
      effectiveDirectScheduleRule !== undefined
    ) {
      options.nextRunAt = computeAutomationNextRunAt(
        {
          cronExpr: effectiveCron,
          scheduleRule: effectiveScheduleRule,
        },
        updatedAt,
      );
      options.resetRetry = true;
    }

    const effectiveEndAt =
      normalizedParams.endAt === undefined ? existing.endAt : (normalizedParams.endAt ?? undefined);
    if (
      effectiveEndAt !== undefined &&
      (options.nextRunAt ?? existing.nextRunAt ?? Infinity) > effectiveEndAt
    ) {
      options.nextRunAt = null;
      options.lifecycleStatus = "completed";
    } else if (
      normalizedParams.endAt !== undefined &&
      (existing.lifecycleStatus === "completed" || existing.lifecycleStatus === "failed")
    ) {
      options.lifecycleStatus = "active";
    }

    // 改 recurring / max_runs：重算生命周期。
    if (normalizedParams.recurring !== undefined || normalizedParams.maxRuns !== undefined) {
      const nextMaxRuns =
        normalizedParams.maxRuns === undefined
          ? existing.maxRuns
          : (normalizedParams.maxRuns ?? undefined);
      // runCount 是 Card 的累计展示数，包含 manual run；若用它重算有限计划，
      // 用户只要手动执行过就可能在编辑 maxRuns 时把任务提前改成 completed。
      const scheduledRunCount = await this.repo.getScheduledRunCount(automationId, workspaceKey);
      if (scheduledRunCount === null) return null;
      // 与 markDispatched 口径一致：有限次任务未显式设 max_runs 时按一次性任务(上限 1)处理。
      const reachedMax = !nextRecurring && scheduledRunCount >= (nextMaxRuns ?? 1);
      if (reachedMax) {
        options.lifecycleStatus = "completed";
      } else if (
        existing.lifecycleStatus === "completed" ||
        existing.lifecycleStatus === "failed"
      ) {
        // 原为终态，编辑后又变得可跑 → 复活为 active 并重算 next_run_at。
        options.lifecycleStatus = "active";
        if (options.nextRunAt === undefined) {
          options.nextRunAt = computeAutomationNextRunAt(
            {
              cronExpr: effectiveCron,
              scheduleRule: effectiveScheduleRule,
            },
            updatedAt,
          );
        }
      }
    }

    return this.repo.update(automationId, updateParams, options, workspaceKey);
  }

  async delete(automationId: string, scope?: AutomationWorkspaceScope): Promise<boolean> {
    return this.repo.delete(automationId, resolveScopeKey(scope));
  }

  /** 暂停 / 恢复。 */
  async setEnabled(
    automationId: string,
    enabled: boolean,
    scope?: AutomationWorkspaceScope,
  ): Promise<void> {
    return this.repo.setEnabled(automationId, enabled, resolveScopeKey(scope));
  }

  /** 失败任务手动重跑：回 active、清计数，按 cron 重算下次时间。 */
  async restart(automationId: string, scope?: AutomationWorkspaceScope): Promise<void> {
    const workspaceKey = resolveScopeKey(scope);
    const existing = await this.repo.get(automationId, workspaceKey);
    if (!existing) return;
    // completed 是有限次计划自然耗尽后的终态，不能被旧 UI/RPC restart 复活；
    // 只有 failed 代表可恢复异常，允许用户手动重排下一次运行。
    if (existing.lifecycleStatus !== "failed") return;
    const nextRunAt = computeAutomationNextRunAt(existing);
    return this.repo.restart(automationId, { nextRunAt }, workspaceKey);
  }

  /** 立即运行：创建供当前 host 直接派发的 manual run，不修改原 cron 计划。 */
  async runNow(
    automationId: string,
    scope?: AutomationWorkspaceScope,
  ): Promise<{ automation: ZCodeAutomation; run: ZCodeAutomationRun } | null> {
    const workspaceKey = resolveScopeKey(scope);
    const existing = await this.repo.get(automationId, workspaceKey);
    if (!existing) return null;
    return this.repo.runNow(automationId, { now: Date.now() }, workspaceKey);
  }

  async listRuns(
    automationId: string,
    scope?: AutomationWorkspaceScope,
  ): Promise<ZCodeAutomationRun[]> {
    return this.repo.listRuns(automationId, resolveScopeKey(scope));
  }
  async deleteRun(runId: string, scope?: AutomationWorkspaceScope): Promise<void> {
    return this.repo.deleteRun(runId, resolveScopeKey(scope));
  }
}
