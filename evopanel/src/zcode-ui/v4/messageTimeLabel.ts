import type { IntlInstance } from "@/i18n/IntlProvider.js";

type DateTimeFormatterKind = "time" | "monthDayTime" | "yearMonthDayTime";

const MESSAGE_TIME_LABEL_CACHE_LIMIT = 4_000;
const messageTimeLabelCache = new Map<string, string>();
const dateTimeFormatterCache = new Map<string, Intl.DateTimeFormat>();

function isSameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function getDayCacheKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function getDateTimeFormatter(locale: string, kind: DateTimeFormatterKind): Intl.DateTimeFormat {
  const cacheKey = `${locale}:${kind}`;
  const cached = dateTimeFormatterCache.get(cacheKey);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat(
    locale,
    kind === "time"
      ? { hour: "2-digit", minute: "2-digit" }
      : kind === "monthDayTime"
        ? { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }
        : {
            year: "numeric",
            month: "numeric",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          },
  );
  dateTimeFormatterCache.set(cacheKey, formatter);
  return formatter;
}

function cacheMessageTimeLabel(cacheKey: string, label: string): string {
  if (messageTimeLabelCache.size >= MESSAGE_TIME_LABEL_CACHE_LIMIT) {
    messageTimeLabelCache.clear();
  }
  messageTimeLabelCache.set(cacheKey, label);
  return label;
}

export function formatMessageTimeLabel(
  timestamp: number,
  locale: string,
  intl: IntlInstance,
  nowTimestamp = Date.now(),
): string | null {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;

  const messageDate = new Date(timestamp);
  const now = new Date(nowTimestamp);
  if (Number.isNaN(messageDate.getTime()) || Number.isNaN(now.getTime())) return null;

  const cacheKey = `${locale}:${timestamp}:${getDayCacheKey(now)}`;
  const cached = messageTimeLabelCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const timeText = getDateTimeFormatter(locale, "time").format(messageDate);
  if (isSameDay(messageDate, now)) {
    return cacheMessageTimeLabel(cacheKey, timeText);
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(messageDate, yesterday)) {
    return cacheMessageTimeLabel(
      cacheKey,
      intl.formatMessage({ id: "chat.message.time.yesterday" }, { time: timeText }),
    );
  }

  if (messageDate.getFullYear() === now.getFullYear()) {
    return cacheMessageTimeLabel(
      cacheKey,
      getDateTimeFormatter(locale, "monthDayTime").format(messageDate),
    );
  }

  return cacheMessageTimeLabel(
    cacheKey,
    getDateTimeFormatter(locale, "yearMonthDayTime").format(messageDate),
  );
}
