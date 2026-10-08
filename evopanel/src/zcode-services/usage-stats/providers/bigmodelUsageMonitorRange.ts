import type {
  CodingPlanUsageGranularity,
  CodingPlanUsageRequest,
  UsageStatsRequest,
} from "@zcode/shared";

const MONITOR_MAX_RANGE_DAYS = 30;
const MONITOR_DEFAULT_RANGE_DAYS = 30;
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export function resolveUsageTimeRange(request: UsageStatsRequest): {
  startTime: string;
  endTime: string;
} {
  const days = (() => {
    switch (request.range) {
      case "7d":
        return 7;
      case "30d":
        return 30;
      default:
        return MONITOR_DEFAULT_RANGE_DAYS;
    }
  })();

  const now = new Date();
  const end = new Date(now);
  end.setHours(23, 59, 59, 0);
  const start = new Date(end);
  start.setDate(end.getDate() - (Math.min(days, MONITOR_MAX_RANGE_DAYS) - 1));
  start.setHours(0, 0, 0, 0);

  return {
    startTime: formatMonitorDateTime(start),
    endTime: formatMonitorDateTime(end),
  };
}

export function resolveCodingPlanUsageTimeRange(request: CodingPlanUsageRequest): {
  startTime: string;
  endTime: string;
  granularity: CodingPlanUsageGranularity;
  xTime: string[];
  startDateKey: string;
  endDateKey: string;
} {
  const endDateKey = formatDateInTimeZone(new Date(), request.timeZone);

  switch (request.range) {
    case "today": {
      return {
        startTime: `${endDateKey} 00:00:00`,
        endTime: `${endDateKey} 23:59:59`,
        granularity: "hour",
        xTime: buildHourlyAxis(),
        startDateKey: endDateKey,
        endDateKey,
      };
    }
    case "7d": {
      const startDateKey = addDaysToDateKey(endDateKey, -6);
      return {
        startTime: `${startDateKey} 00:00:00`,
        endTime: `${endDateKey} 23:59:59`,
        granularity: "day",
        xTime: buildDailyAxis(startDateKey, 7),
        startDateKey,
        endDateKey,
      };
    }
    case "30d": {
      const startDateKey = addDaysToDateKey(endDateKey, -29);
      return {
        startTime: `${startDateKey} 00:00:00`,
        endTime: `${endDateKey} 23:59:59`,
        granularity: "day",
        xTime: buildDailyAxis(startDateKey, 30),
        startDateKey,
        endDateKey,
      };
    }
    case "custom": {
      const startDateKey = normalizeCustomDateKey(request.customStartDate, "start");
      const customEndDateKey = normalizeCustomDateKey(request.customEndDate, "end");
      const days = diffDateKeyDays(startDateKey, customEndDateKey) + 1;
      if (days <= 0) {
        throw new Error("coding_plan_usage_custom_range_invalid_order");
      }
      if (days > MONITOR_MAX_RANGE_DAYS) {
        throw new Error("coding_plan_usage_custom_range_too_long");
      }
      return {
        startTime: `${startDateKey} 00:00:00`,
        endTime: `${customEndDateKey} 23:59:59`,
        granularity: "day",
        xTime: buildDailyAxis(startDateKey, days),
        startDateKey,
        endDateKey: customEndDateKey,
      };
    }
  }
}

function formatMonitorDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function buildHourlyAxis(): string[] {
  return Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00:00`);
}

function buildDailyAxis(startDateKey: string, days: number): string[] {
  return Array.from({ length: days }, (_, index) => {
    return addDaysToDateKey(startDateKey, index);
  });
}

function formatDateInTimeZone(date: Date, timeZone: string | undefined): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function addDaysToDateKey(dateKey: string, days: number): string {
  const [year = "1970", month = "01", day = "01"] = dateKey.split("-");
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) + days));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function normalizeCustomDateKey(value: string | null | undefined, label: "start" | "end"): string {
  const trimmed = value?.trim() ?? "";
  if (!DATE_KEY_PATTERN.test(trimmed)) {
    throw new Error(`coding_plan_usage_custom_${label}_date_invalid`);
  }
  return trimmed;
}

function diffDateKeyDays(startDateKey: string, endDateKey: string): number {
  const start = dateKeyToUtcMs(startDateKey);
  const end = dateKeyToUtcMs(endDateKey);
  return Math.floor((end - start) / 86_400_000);
}

function dateKeyToUtcMs(dateKey: string): number {
  const [year = "1970", month = "01", day = "01"] = dateKey.split("-");
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
}
