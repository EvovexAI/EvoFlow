import { Repeat2Icon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { TimelineStation } from "./timeline-model.js";

/** 站头元数据（从 `WorkflowTimeline.tsx` 拆出以守 400 行）：`⟳ n` 轮次（只在循环上的站）与 `a/b` 步数分数（只在观察到节点后）。 */
export function StationMeta({ station }: { station: TimelineStation }) {
  const { intl } = useZCodeIntl();
  const showRounds = station.onLoop && station.rounds > 0;
  if (!showRounds && station.fraction === undefined) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
      {showRounds ? (
        <span
          className="flex items-center gap-1"
          data-testid="workflow-timeline-rounds"
          title={intl.formatMessage(
            { id: "chat.toolCall.workflow.timeline.rounds" },
            { count: station.rounds },
          )}
        >
          <Repeat2Icon aria-hidden className="size-2.5" />
          {station.rounds}
        </span>
      ) : null}
      {showRounds && station.fraction !== undefined ? <span aria-hidden>·</span> : null}
      {station.fraction === undefined ? null : (
        <span className="text-ui-sm" data-testid="workflow-timeline-fraction">
          {station.fraction.settled}/{station.fraction.observed}
        </span>
      )}
    </span>
  );
}
