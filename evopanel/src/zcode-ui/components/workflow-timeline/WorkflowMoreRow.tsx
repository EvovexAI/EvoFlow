import type { CSSProperties } from "react";
import { ArrowUpRightIcon, ChevronDownIcon, CircleXIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { laneDisplayName } from "@/components/workflow-graph/lane-name.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { RosterCounts, RosterMore } from "./roster-model.js";
import type { TimelinePill } from "./timeline-model.js";
import { LaneGlyph } from "./WorkflowAgentPill.js";
import { RosterTally } from "./WorkflowRosterParts.js";

/**
 * 「还有 n 个」那一行：卡上名册站
 * 钉住五枚药丸之后的第六枚——同高、同底色、同内距、同圆角、同一套悬停语法。内容是三张脸一叠（其余里
 * 最要紧的三个，表情自带状态）、`还有 n 个`、藏着失败时一枚红色 `✕ n`、尾槽里常驻的 ↗。
 *
 * 它是一扇门不是状态：点一下开运行侧栏、落到这一站、把清单展开（`onOpen` 由卡接到 `onSelectStation`）。
 * 没有状态标记可让位，所以 ↗ 不等悬停就在（空尾槽读作「这里没东西」）。没有回调时是静态的 span。
 *
 * 侧板上同一具身体是**门**（`door` 在场）：尾槽里换成下箭头，原地开合。
 * 关着时带其余人的计数行（藏着失败时红的就在计数行里，不再另挂 `✕ n`）；开着时计数行搬进名单的
 * 组头，这一行只剩人数、底色抬一级、名字转前景。
 */
export function WorkflowMoreRow({
  door,
  enterDelayMs,
  more,
  onOpen,
}: {
  more: RosterMore;
  /** 入场延迟（跟在钉住的药丸之后落地）；缺席即立刻。 */
  enterDelayMs?: number;
  /** 在场即整行是按钮（回调的存在即门控）。 */
  onOpen?: () => void;
  /** 门的形态（侧板）：开合状态与其余人的计数。缺席即卡上那一行（↗ 常驻）。 */
  door?: { open: boolean; tally: RosterCounts };
}) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  const nameOf = (pill: TimelinePill) => pill.runtimeName ?? laneDisplayName(pill.lane, format);
  const label = format(
    { id: "chat.toolCall.workflow.timeline.roster.more" },
    { count: more.count },
  );
  const title = format(
    {
      id:
        door === undefined
          ? "chat.toolCall.workflow.timeline.roster.moreTitle"
          : door.open
            ? "chat.toolCall.workflow.timeline.roster.door.fold"
            : "chat.toolCall.workflow.timeline.roster.door.list",
    },
    { count: more.count },
  );
  // 与药丸同一条入场纪律：有延迟时 backwards 填充。
  const style =
    enterDelayMs === undefined || enterDelayMs <= 0
      ? undefined
      : ({ animationDelay: `${enterDelayMs}ms`, animationFillMode: "backwards" } as CSSProperties);
  const Root = onOpen === undefined ? "span" : "button";
  return (
    <Root
      aria-label={title}
      aria-expanded={door?.open}
      className={cn(
        "wf-pill wf-agent-pill wf-more-row wf-arrive flex h-8 min-w-0 items-center gap-2 rounded-full pl-2 pr-2.5 text-ui-sm",
        door?.open === true ? "bg-surface-hover" : "bg-surface",
        onOpen !== undefined &&
          "wf-pill-open cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
      )}
      data-door={door === undefined ? undefined : door.open ? "open" : "closed"}
      data-more-count={more.count}
      data-testid="workflow-roster-more-row"
      onClick={onOpen}
      style={style}
      title={title}
      {...(onOpen === undefined ? {} : { type: "button" as const })}
    >
      <span className="wf-more-deck flex shrink-0 items-center" data-testid="workflow-more-deck">
        {more.deck.map((pill) => (
          <LaneGlyph
            className="wf-more-face size-4 shrink-0 text-foreground-subtle"
            key={pill.key}
            avatarIndex={pill.avatarIndex}
            laneClass={pill.laneClass}
            name={nameOf(pill)}
            status={pill.status}
          />
        ))}
      </span>
      <span
        className={cn(
          "wf-pill-name min-w-0 flex-1 truncate",
          door?.open === true ? "text-foreground" : "text-foreground-subtle",
        )}
      >
        {label}
      </span>
      {door === undefined ? null : door.open ? null : (
        <RosterTally className="mr-0.5 shrink-0" counts={door.tally} />
      )}
      {door !== undefined || more.failed === 0 ? null : (
        <span
          className="flex shrink-0 items-center gap-[3px] font-mono text-ui-xs tabular-nums text-destructive"
          data-testid="workflow-more-failed"
          title={format(
            { id: "chat.toolCall.workflow.timeline.roster.failed" },
            { count: more.failed },
          )}
        >
          <CircleXIcon aria-hidden className="size-2.5" />
          <span className="font-medium">{more.failed}</span>
        </span>
      )}
      <span
        className="wf-pill-tail grid size-3.5 shrink-0 place-items-center"
        data-testid="workflow-pill-tail"
      >
        {door === undefined ? (
          <span
            aria-hidden
            className="wf-pill-go wf-pill-go-rest flex size-3.5 items-center justify-center text-foreground-subtlest"
            data-testid="workflow-more-open"
          >
            <ArrowUpRightIcon className="size-3.5" />
          </span>
        ) : (
          <span
            aria-hidden
            className={cn(
              "wf-pill-go wf-pill-go-rest flex size-3.5 items-center justify-center text-foreground-subtlest transition-transform",
              door.open && "rotate-180",
            )}
            data-testid="workflow-more-chevron"
          >
            <ChevronDownIcon className="size-3.5" />
          </span>
        )}
      </span>
    </Root>
  );
}
