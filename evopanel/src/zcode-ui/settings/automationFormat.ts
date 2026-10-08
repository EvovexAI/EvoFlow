// 定时任务展示层格式化：cron 表达式 → 人类可读的调度摘要 / 相对时间 / cron builder 组装。
// 说明：croner 只在 services 侧用于算下次触发时间；UI 这里仅做「已知常见模式」的可读化，
// 覆盖不到的表达式回退成原始 cron 文本，保证不误导。

export interface IntlLike {
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string;
}

export type AutomationStatusKind = "active" | "paused" | "completed" | "failed";

interface AutomationStatusLike {
  lifecycleStatus: AutomationStatusKind;
  enabled: boolean;
}

interface AutomationFailureLike {
  lifecycleStatus: AutomationStatusKind;
  dispatchStatus?: "idle" | "claimed" | "dispatched" | "failed_to_dispatch";
  dispatchAttempts?: number;
  retryAt?: number;
  lastError?: string;
}

/** 最近一次真实运行/派发失败时展示失败态；循环任务本身仍保持 active 并继续调度。 */
export function hasAutomationFailureState(automation: AutomationFailureLike): boolean {
  return (
    automation.lifecycleStatus === "failed" ||
    automation.dispatchStatus === "failed_to_dispatch" ||
    Boolean(automation.lastError?.trim())
  );
}

/** 定时任务生命周期展示状态：终态优先，其次 paused/enabled，最后 active。 */
export function resolveAutomationStatusKind(
  automation: AutomationStatusLike,
): AutomationStatusKind {
  if (automation.lifecycleStatus === "failed") return "failed";
  if (automation.lifecycleStatus === "completed") return "completed";
  if (automation.lifecycleStatus === "paused" || !automation.enabled) return "paused";
  return "active";
}

/** cron builder 支持的频率类型（覆盖 Feishu 自定义重复里最常用的几种）。 */
export type CronFrequency = "hourly" | "daily" | "weekdays" | "weekly" | "monthly" | "custom";
export type CustomRepeatUnit = "minute" | "hourly" | "daily" | "weekly" | "monthly" | "yearly";
export type CustomMonthlyMode = "date" | "weekday";

export interface CronBuilderState {
  frequency: CronFrequency;
  /** daily/weekly/monthly 用：0-23 */
  hour: number;
  /** daily/weekly/monthly 用：0-59 */
  minute: number;
  /** weekly 用：0(周日)-6(周六) 的集合 */
  weekdays: number[];
  /** monthly 用：1-31 */
  dayOfMonth: number;
  /** custom 用：原始 5 段 cron */
  rawExpr: string;
  customInterval: number;
  customUnit: CustomRepeatUnit;
  customWeekdays: number[];
  customMonthDays: number[];
  /** yearly 用：1-12 人类月份（日期复用 customMonthDays[0]）。 */
  customMonth: number;
  customMonthlyMode: CustomMonthlyMode;
}

export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

const pad2 = (value: number): string => String(value).padStart(2, "0");
const AUTOMATION_CARD_RELATIVE_NEXT_RUN_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

export function isSessionCreatedAutomation(
  automation: { targetTaskId?: string } | null | undefined,
): boolean {
  return Boolean(automation?.targetTaskId?.trim());
}

/** 组装 cron builder 状态 → 5 段 cron 表达式（分 时 日 月 周）。 */
export function buildCronExpr(state: CronBuilderState): string {
  const { frequency, hour, minute, weekdays, dayOfMonth, rawExpr } = state;
  switch (frequency) {
    case "hourly":
      // 每小时的第 <minute> 分钟。
      return `${minute} * * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly": {
      const days = weekdays.length > 0 ? [...weekdays].sort((a, b) => a - b).join(",") : "*";
      return `${minute} ${hour} * * ${days}`;
    }
    case "monthly":
      return `${minute} ${hour} ${dayOfMonth} * *`;
    case "custom": {
      const interval = Math.max(1, Math.floor(state.customInterval));
      if (state.customUnit === "minute") {
        // croner 的分钟步长最大为 59，把“每 61 分钟”写成 `*/61` 会在保存校验时失败。
        // 真实间隔由 scheduleRule 承载；超出 cron 表达能力时仅保留合法的每分钟候选。
        return interval <= 59 ? `*/${interval} * * * *` : "* * * * *";
      }
      if (state.customUnit === "hourly") {
        // croner 的小时步长最大为 24，把“每 31 小时”写成 `*/31` 会在保存校验时失败。
        // 真实间隔由 scheduleRule 承载；超出 cron 表达能力时仅保留合法的每小时候选。
        return interval <= 24 ? `${minute} */${interval} * * *` : `${minute} * * * *`;
      }
      if (state.customUnit === "daily") {
        // croner 的日期步长最大为 31，把“每 32 天”写成 `*/32` 会在保存校验时失败。
        // 真实间隔由 scheduleRule 承载；超出 cron 表达能力时仅保留合法的每日候选。
        return interval <= 31 ? `${minute} ${hour} */${interval} * *` : `${minute} ${hour} * * *`;
      }
      if (state.customUnit === "weekly") {
        const days = state.customWeekdays.length > 0 ? state.customWeekdays.join(",") : "1";
        return `${minute} ${hour} * * ${days}`;
      }
      if (state.customUnit === "monthly") {
        // 把 interval 直接写进月份字段会让“每 29 个月”生成 `*/29`，但 cron
        // 月份只允许 1-12。真实间隔由 scheduleRule 承载，兼容 cron 只保留合法的每月候选。
        if (state.customMonthlyMode === "weekday") {
          return `${minute} ${hour} * * ${state.customWeekdays[0] ?? 1}#1`;
        }
        const days = state.customMonthDays.length > 0 ? state.customMonthDays.join(",") : "1";
        return `${minute} ${hour} ${days} * *`;
      }
      // yearly：用用户选择的月份/日期组装 `M H DOM MON *`（不再固定为当前月份）。
      const yearMonth = Math.min(12, Math.max(1, Math.floor(state.customMonth)));
      const yearDay = state.customMonthDays[0] ?? new Date().getDate();
      return `${minute} ${hour} ${yearDay} ${yearMonth} *`;
    }
    default:
      return rawExpr.trim();
  }
}

/** 尽力把已有 cron 反解析回 builder 状态；不认识的落到 custom。 */
export function parseCronToBuilder(expr: string): CronBuilderState {
  const fallback: CronBuilderState = {
    frequency: "custom",
    hour: 9,
    minute: 0,
    weekdays: [1],
    dayOfMonth: 1,
    rawExpr: expr,
    customInterval: 1,
    customUnit: "daily",
    customWeekdays: [1],
    customMonthDays: [1],
    customMonth: new Date().getMonth() + 1,
    customMonthlyMode: "date",
  };
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return fallback;
  const min = parts[0]!;
  const hr = parts[1]!;
  const dom = parts[2]!;
  const mon = parts[3]!;
  const dow = parts[4]!;
  const minNum = Number(min);
  const hrNum = Number(hr);
  const isNum = (v: string) => /^\d+$/.test(v);

  const minuteInterval = /^\*\/([1-9]\d*)$/.exec(min);
  if (minuteInterval && hr === "*" && dom === "*" && mon === "*" && dow === "*") {
    return {
      ...fallback,
      frequency: "custom",
      customInterval: Number(minuteInterval[1]),
      customUnit: "minute",
    };
  }

  const hourlyInterval = /^\*\/(\d+)$/.exec(hr);
  if (isNum(min) && hourlyInterval && dom === "*" && mon === "*" && dow === "*") {
    return {
      ...fallback,
      frequency: "custom",
      minute: minNum,
      customInterval: Math.max(1, Number(hourlyInterval[1])),
      customUnit: "hourly",
    };
  }
  const dailyInterval = /^\*\/(\d+)$/.exec(dom);
  if (isNum(min) && isNum(hr) && dailyInterval && mon === "*" && dow === "*") {
    return {
      ...fallback,
      frequency: "custom",
      hour: hrNum,
      minute: minNum,
      customInterval: Math.max(1, Number(dailyInterval[1])),
      customUnit: "daily",
    };
  }

  // 每小时：`M * * * *`
  if (isNum(min) && hr === "*" && dom === "*" && mon === "*" && dow === "*") {
    return { ...fallback, frequency: "hourly", minute: minNum };
  }
  // 每天：`M H * * *`
  if (isNum(min) && isNum(hr) && dom === "*" && mon === "*" && dow === "*") {
    return { ...fallback, frequency: "daily", hour: hrNum, minute: minNum };
  }
  // 工作日：`M H * * 1-5`
  if (isNum(min) && isNum(hr) && dom === "*" && mon === "*" && dow === "1-5") {
    return { ...fallback, frequency: "weekdays", hour: hrNum, minute: minNum };
  }
  // 每周：`M H * * D(,D...)`
  if (isNum(min) && isNum(hr) && dom === "*" && mon === "*" && dow !== "*") {
    const days = dow
      .split(",")
      .map((d) => Number(d))
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    if (days.length > 0) {
      return { ...fallback, frequency: "weekly", hour: hrNum, minute: minNum, weekdays: days };
    }
  }
  // 每年：`M H DOM MON *`（月份为 1-12 数字，与每月的 `MON === "*"` 区分）
  if (isNum(min) && isNum(hr) && isNum(dom) && isNum(mon) && dow === "*") {
    const monthNum = Number(mon);
    if (monthNum >= 1 && monthNum <= 12) {
      return {
        ...fallback,
        frequency: "custom",
        hour: hrNum,
        minute: minNum,
        customUnit: "yearly",
        customMonth: monthNum,
        customMonthDays: [Number(dom)],
      };
    }
  }
  // 每月：`M H DOM * *`
  if (isNum(min) && isNum(hr) && isNum(dom) && mon === "*" && dow === "*") {
    return {
      ...fallback,
      frequency: "monthly",
      hour: hrNum,
      minute: minNum,
      dayOfMonth: Number(dom),
    };
  }
  return fallback;
}

function weekdayLabel(day: number, intl: IntlLike): string {
  return intl.formatMessage({ id: `automations.weekday.${day}` });
}

/** builder → 可读调度摘要；编辑态直接使用，避免自定义规则经过 cron 反解析后丢失 UI 语义。 */
export function describeCronBuilder(state: CronBuilderState, intl: IntlLike): string {
  const time = `${pad2(state.hour)}:${pad2(state.minute)}`;
  switch (state.frequency) {
    case "hourly":
      return intl.formatMessage(
        { id: "automations.schedule.hourly" },
        { minute: pad2(state.minute) },
      );
    case "daily":
      return intl.formatMessage({ id: "automations.schedule.daily" }, { time });
    case "weekdays":
      return intl.formatMessage({ id: "automations.schedule.weekdays" }, { time });
    case "weekly": {
      const days = [...state.weekdays]
        .sort((a, b) => WEEKDAY_ORDER.indexOf(a as never) - WEEKDAY_ORDER.indexOf(b as never))
        .map((d) => weekdayLabel(d, intl))
        .join("、");
      return intl.formatMessage({ id: "automations.schedule.weekly" }, { days, time });
    }
    case "monthly":
      return intl.formatMessage(
        { id: "automations.schedule.monthly" },
        { day: String(state.dayOfMonth), time },
      );
    case "custom": {
      if (state.customUnit === "minute") {
        return intl.formatMessage(
          { id: "automations.schedule.customMinutes" },
          { interval: String(state.customInterval) },
        );
      }
      if (state.customUnit === "hourly") {
        // 小时周期没有固定 hour，复用通用时间模板会把 builder
        // 为其它频率保留的默认 hour=9 误展示成 09:00。
        return intl.formatMessage(
          { id: "automations.schedule.customHourly" },
          {
            interval: String(state.customInterval),
            time: pad2(state.minute),
          },
        );
      }
      if (state.customUnit === "weekly") {
        const days = state.customWeekdays
          .map((day) => weekdayLabel(day, intl))
          .join(intl.formatMessage({ id: "automations.weekday.separator" }));
        return intl.formatMessage(
          { id: "automations.schedule.customWeekly" },
          { interval: String(state.customInterval), days, time },
        );
      }
      if (state.customUnit === "monthly") {
        if (state.customMonthlyMode === "weekday") {
          return intl.formatMessage(
            { id: "automations.schedule.customMonthlyWeekday" },
            {
              interval: String(state.customInterval),
              day: weekdayLabel(state.customWeekdays[0] ?? 1, intl),
              time,
            },
          );
        }
        return intl.formatMessage(
          { id: "automations.schedule.customMonthlyDates" },
          {
            interval: String(state.customInterval),
            days: state.customMonthDays.join(", "),
            time,
          },
        );
      }
      if (state.customUnit === "yearly") {
        return intl.formatMessage(
          { id: "automations.schedule.customYearly" },
          {
            interval: String(state.customInterval),
            month: String(state.customMonth),
            day: String(state.customMonthDays[0] ?? 1),
            time,
          },
        );
      }
      // 走到这里只剩 daily（hourly/weekly/monthly/yearly 已在上面各自处理）。
      const unitId = "automations.customRepeat.unit.day";
      return intl.formatMessage(
        { id: "automations.schedule.custom" },
        {
          interval: String(state.customInterval),
          unit: intl.formatMessage({ id: unitId }),
          time,
        },
      );
    }
    default:
      return state.rawExpr;
  }
}

/** cron → 可读调度摘要（如 “每天 09:00”“每周一、三 18:30”）；无法识别回退原始表达式。 */
export function describeCron(expr: string, intl: IntlLike): string {
  const normalizedExpr = expr.trim().replace(/\s+/g, " ");
  const minuteInterval = /^\*\/([1-9]\d*) \* \* \* \*$/.exec(normalizedExpr);
  if (minuteInterval) {
    return intl.formatMessage(
      { id: "automations.schedule.customMinutes" },
      { interval: minuteInterval[1]! },
    );
  }

  // 五段 cron 不携带年份，`M H DOM MON *` 无法区分单次固定日期与年度重复。
  // 卡片不能猜测产品语义，也不能把底层表达式直接暴露给用户，因此统一标记为自定义。
  if (/^\d+ \d+ \d+ \d+ \*$/.test(normalizedExpr)) {
    return intl.formatMessage({ id: "automations.frequency.custom" });
  }
  // `M H DOM */N *` 目前无法在普通调度编辑器中稳定还原，卡片同样只标记为自定义。
  if (/^\d+ \d+ \d+ \*\/\d+ \*$/.test(normalizedExpr)) {
    return intl.formatMessage({ id: "automations.frequency.custom" });
  }

  const builder = parseCronToBuilder(normalizedExpr);
  // 未识别 cron 会落到带 09:00 默认值的 custom 状态，不能把默认值误当成真实调度展示。
  if (builder.frequency === "custom" && buildCronExpr(builder) !== normalizedExpr) {
    return intl.formatMessage({ id: "automations.frequency.custom" });
  }
  return describeCronBuilder(builder, intl);
}

/** UI 调度 builder 是否能无损回显 cron；固定月日和未知表达式必须走“自定义”替换流程。 */
export function canVisualizeCronInAutomationEditor(expr: string): boolean {
  const normalizedExpr = expr.trim().replace(/\s+/g, " ");
  if (/^\d+ \d+ \d+ \d+ \*$/.test(normalizedExpr)) return false;
  if (/^\d+ \d+ \d+ \*\/\d+ \*$/.test(normalizedExpr)) return false;
  const builder = parseCronToBuilder(normalizedExpr);
  return buildCronExpr(builder) === normalizedExpr;
}

/** 本地时区偏移 → GMT 文案；支持 GMT+8 与 GMT+5:30 这类半小时时区。 */
export function formatGmtOffset(offsetMinutes = -new Date().getTimezoneOffset()): string {
  if (offsetMinutes === 0) return "GMT";
  const sign = offsetMinutes > 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  return `GMT${sign}${hours}${minutes > 0 ? `:${pad2(minutes)}` : ""}`;
}

/** 毫秒时间戳 → 本地日期时间（YYYY-MM-DD HH:MM）。 */
export function formatDateTime(ts: number | undefined): string {
  if (!ts) return "-";
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 相对时间（如 “in 2h”“3d ago”），用于“下次运行 / 上次运行”。 */
export function formatRelativeToNow(ts: number | undefined, now: number, intl: IntlLike): string {
  if (!ts) return "-";
  const diff = ts - now;
  const abs = Math.abs(diff);
  const future = diff >= 0;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  let value: number;
  let unitId: string;
  if (abs < minute) {
    return intl.formatMessage({
      id: future ? "automations.time.soon" : "automations.time.justNow",
    });
  }
  if (abs < hour) {
    value = Math.round(abs / minute);
    unitId = "automations.time.minutes";
  } else if (abs < day) {
    value = Math.round(abs / hour);
    unitId = "automations.time.hours";
  } else {
    value = Math.round(abs / day);
    unitId = "automations.time.days";
  }
  const amount = intl.formatMessage({ id: unitId }, { value: String(value) });
  return intl.formatMessage(
    { id: future ? "automations.time.in" : "automations.time.ago" },
    { amount },
  );
}

/** 定时任务卡片下次运行时间：过期不展示；一个月内相对时间，更远的未来绝对时间。 */
export function formatAutomationCardNextRun(
  ts: number | undefined,
  now: number,
  intl: IntlLike,
): string | null {
  if (!ts || ts <= now) return null;
  return ts - now <= AUTOMATION_CARD_RELATIVE_NEXT_RUN_THRESHOLD_MS
    ? formatRelativeToNow(ts, now, intl)
    : formatDateTime(ts);
}

/** 运行时长（毫秒）→ 可读文本（如 “1m 20s”“3s”）。 */
export function formatDuration(startTs: number | undefined, endTs: number | undefined): string {
  if (!startTs || !endTs || endTs < startTs) return "-";
  const totalSec = Math.round((endTs - startTs) / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min <= 0) return `${sec}s`;
  return `${min}m ${sec}s`;
}
