type MessageFormatter = (descriptor: { id: string }, values?: Record<string, string>) => string;

export function formatRelativeTime(iso: string, formatMessage: MessageFormatter) {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "";
  const diff = Date.now() - ts;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return formatMessage({ id: "feedback.time.justNow" });
  if (diff < hour) {
    return formatMessage(
      { id: "feedback.time.minutesAgo" },
      { count: String(Math.floor(diff / minute)) },
    );
  }
  if (diff < day) {
    return formatMessage(
      { id: "feedback.time.hoursAgo" },
      { count: String(Math.floor(diff / hour)) },
    );
  }
  if (diff < 7 * day) {
    return formatMessage(
      { id: "feedback.time.daysAgo" },
      { count: String(Math.floor(diff / day)) },
    );
  }
  return new Date(iso).toLocaleDateString();
}
