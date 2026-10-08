import type {
  ZCodeAutomationIntervalUnit,
  ZCodeAutomationScheduleRule,
  ZCodeAutomationUpdateParams,
} from "@zcode/shared";

/** 会话侧自定义重复 carrier 的受控上限；不要收紧管理页历史 scheduleRule 的领域上限。 */
const MAX_SESSION_AUTOMATION_INTERVAL = 200;

/** 会话侧自定义重复 carrier 配对、范围或互斥校验失败。 */
export class InvalidAutomationIntervalCarrierError extends Error {
  constructor(message: string) {
    super(`非法的自定义重复入参：${message}`);
    this.name = "InvalidAutomationIntervalCarrierError";
  }
}

/**
 * 校验会话 Cron 工具与 UI 共用的 interval carrier。
 *
 * intervalUnit + interval 是受控输入，服务层必须再次校验，避免旧客户端或内部调用绕过
 * contract/protocol 后写入超出 UI 语义的间隔。`scheduleRule: null` 是 update 的显式清除
 * 语义，也不能与 carrier 混用，否则无法确定是新建规则还是清除规则。
 */
export function assertValidAutomationIntervalCarrier(input: {
  intervalUnit?: ZCodeAutomationIntervalUnit;
  interval?: number;
  scheduleRule?: ZCodeAutomationScheduleRule | null;
  relativeDelayMinutes?: number;
  recurring?: boolean;
  maxRuns?: number | null;
}): void {
  const { intervalUnit, interval, scheduleRule, relativeDelayMinutes, recurring, maxRuns } = input;
  if ((intervalUnit === undefined) !== (interval === undefined)) {
    throw new InvalidAutomationIntervalCarrierError(
      "intervalUnit 与 interval 必须同时提交或同时省略",
    );
  }
  if (
    interval !== undefined &&
    (!Number.isInteger(interval) || interval < 1 || interval > MAX_SESSION_AUTOMATION_INTERVAL)
  ) {
    throw new InvalidAutomationIntervalCarrierError("interval 必须是 1-200 的整数");
  }
  if (intervalUnit !== undefined && relativeDelayMinutes !== undefined) {
    throw new InvalidAutomationIntervalCarrierError(
      "intervalUnit 是周期 carrier，不能与一次性 relativeDelayMinutes 同时提交",
    );
  }
  if (intervalUnit !== undefined && scheduleRule !== undefined) {
    throw new InvalidAutomationIntervalCarrierError(
      "intervalUnit carrier 不能与直传 scheduleRule 同时提交",
    );
  }
  // carrier 的真实语义是无限循环；若放行 recurring=false 或 maxRuns，repository 会
  // 在首次派发后按一次性 / 有限任务结束，留下 scheduleRule 与生命周期模式相互矛盾的数据。
  if (intervalUnit !== undefined && recurring === false) {
    throw new InvalidAutomationIntervalCarrierError("intervalUnit carrier 必须使用 recurring=true");
  }
  if (intervalUnit !== undefined && typeof maxRuns === "number") {
    throw new InvalidAutomationIntervalCarrierError(
      "intervalUnit carrier 不能与有限 maxRuns 同时提交",
    );
  }
}

/** carrier 更新必须原子切换无限循环，避免 scheduleRule 与生命周期模式脱节。 */
export function forceIntervalCarrierRecurring(
  params: ZCodeAutomationUpdateParams,
): ZCodeAutomationUpdateParams {
  return { ...params, recurring: true, maxRuns: null };
}
