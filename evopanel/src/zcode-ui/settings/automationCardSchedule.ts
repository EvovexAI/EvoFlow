import type { ZCodeAutomationScheduleRule } from "@zcode/shared";
import {
  describeCron,
  describeCronBuilder,
  type CronBuilderState,
  type IntlLike,
} from "@/settings/automationFormat.js";

function scheduleRuleToBuilder(rule: ZCodeAutomationScheduleRule): CronBuilderState {
  return {
    frequency: "custom",
    hour: rule.hour,
    minute: rule.minute,
    weekdays: rule.weekdays ?? [1],
    dayOfMonth: rule.monthDays?.[0] ?? 1,
    rawExpr: "",
    customInterval: rule.interval,
    customUnit: rule.unit,
    customWeekdays: rule.weekdays ?? [1],
    customMonthDays: rule.monthDays ?? [1],
    customMonth: rule.months?.[0] ?? new Date(rule.anchorAt).getMonth() + 1,
    customMonthlyMode: rule.monthlyMode ?? "date",
  };
}

/** 卡片优先展示权威 scheduleRule；旧数据缺少规则时才从兼容 cron 生成摘要。 */
export function describeAutomationCardSchedule(
  automation: {
    cronExpr: string;
    scheduleRule?: ZCodeAutomationScheduleRule;
    recurring?: boolean;
    maxRuns?: number;
  },
  intl: IntlLike,
): string {
  // 相对时间一次性任务（如“4 分钟后提醒”）被存成 minute scheduleRule 作兼容展示，
  // describeCronBuilder 会把它误显为“每 4 分钟”重复任务。一次性任务跑一次即结束、没有频率，
  // 与固定日历 cron 一次性任务保持一致，统一显示为“自定义”，真实时机由“下次运行”文案承载。
  if (automation.recurring === false && (automation.maxRuns ?? 1) <= 1) {
    return intl.formatMessage({ id: "automations.frequency.custom" });
  }
  // 长月度间隔的兼容 cron 固定为每月候选；只解析 cron 会把“每 30 个月”误显为“每月”。
  if (automation.scheduleRule) {
    return describeCronBuilder(scheduleRuleToBuilder(automation.scheduleRule), intl);
  }
  return describeCron(automation.cronExpr, intl);
}
