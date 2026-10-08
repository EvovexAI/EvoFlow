import { Clock } from "lucide-react";
import { useEffect, useState } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getTaskListRowActivity } from "@/v4/taskListRowActivity.js";

export function WorkspaceLastActivity({ task }: { task: ZCodeTaskMeta | null }) {
  const { intl } = useZCodeIntl();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const timestamp = task
    ? (getTaskListRowActivity(task)?.lastActivityAt ?? task.updatedAt)
    : undefined;
  if (!timestamp || !Number.isFinite(timestamp)) return null;
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  const time =
    minutes < 1
      ? intl.formatMessage({ id: "sidePane.time.justNow" })
      : intl.formatMessage(
          {
            id:
              minutes < 60
                ? "sidePane.time.minutesAgo"
                : minutes < 1440
                  ? "sidePane.time.hoursAgo"
                  : "sidePane.time.daysAgo",
          },
          { count: minutes < 60 ? minutes : Math.floor(minutes / (minutes < 1440 ? 60 : 1440)) },
        );
  return (
    <span data-workspace-last-activity="" className="flex min-w-0 items-center gap-2 font-normal">
      <Clock className="size-4 shrink-0" />
      <span>{intl.formatMessage({ id: "workspace.context.lastActivity" }, { time })}</span>
    </span>
  );
}
