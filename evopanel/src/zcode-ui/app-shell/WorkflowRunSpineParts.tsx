// ============================================================
// 侧栏脊线的零件
// ============================================================
// 从 WorkflowRunPhaseList.tsx 拆出（max-lines 400）：清单文件承载展开状态、问题归属与药丸接线，
// 本文件承载四个纯展示件——轨道段、灯、折叠节头上的头像串、轮次。

import { useId, type CSSProperties } from "react";
import { Repeat2Icon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { STATUS_DOT } from "@/components/workflow-graph/run-status-presentation.js";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import type {
  TimelineInk,
  TimelinePill,
  TimelineStation,
} from "@/components/workflow-timeline/timeline-model.js";
import { LaneGlyph, agentColor } from "@/components/workflow-timeline/WorkflowAgentPill.js";
import { MarchLight } from "@/components/workflow-timeline/WorkflowMarchLight.js";
import type { SpineSection } from "@/app-shell/workflowRunSpine.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 折叠节头上最多几枚头像；其余进 `+n`。 */
const CLUSTER_MAX = 3;

/** 轨道 t 的竖轨中心；主线在 21，每条分支再右 12px（`workflowRunSpine.ts`）。 */
const TRACK_X = 21;
const TRACK_GAP = 12;

/**
 * 轨道段的一半。相邻两站之间的一段轨道拆成两截画：上一站从灯底到节底，下一站从节顶到灯顶——
 * 两截同一墨色，接在节的边界上。这样轨道随节的展开 / 折叠自己长短，不用量。
 *
 * 带里还有第三种：`full` 整节穿过（主轨经过分支站、分支轨经过别人的站）；`from` / `to` 给分叉
 * 与合流曲线让出那 13px。轨道 t > 0 的 x 用内联样式给——它是算出来的，Tailwind 生不出这个类。
 *
 * 行进段（`march`）是一条 1.5px 的**亮着的**轨道，不动：它说的是控制流已经走过的那条边，动作留给
 * 正在运行的灯。亮度沿着控制流的方向涨——`data-rail-position` 就是给样式表选渐变用的，两截都得带着
 * 它：`below`（上一节的下半截）从透明淡入到七成警示色，`above`（运行那一节的上半截）从七成涨到满，
 * 一直亮进灯里，`full` 是平的七成。
 */
function SpineRail({
  from,
  ink,
  position,
  to,
  track = 0,
}: {
  ink: TimelineInk;
  position: "above" | "below" | "full";
  track?: number;
  from?: number;
  to?: number;
}) {
  const style: CSSProperties = {};
  if (track > 0)
    style.left = (ink === "march" ? TRACK_X - 0.75 : TRACK_X - 0.5) + TRACK_GAP * track;
  if (from !== undefined) style.top = from;
  if (to !== undefined) style.bottom = to;
  return (
    <span
      aria-hidden
      className={cn(
        "wf-ink absolute rounded-full",
        ink === "march" ? "left-[20.25px] w-[1.5px]" : "left-[20.5px] w-px",
        position === "above" ? "top-0 h-3" : position === "below" ? "bottom-0 top-6" : "inset-y-0",
        ink !== "march" && "bg-foreground-subtlest",
        ink === "march" && "wf-spine-march",
      )}
      data-rail-ink={ink}
      data-rail-position={position}
      data-rail-track={track}
      data-testid="workflow-run-spine-rail"
      style={Object.keys(style).length === 0 ? undefined : style}
    />
  );
}

/**
 * 分叉 / 合流曲线：分支轨道在带首节的顶上 13px 里离开主轨，在汇合站的节顶（或带末节的节底）
 * 用镜像的曲线回来。淡墨与浓墨在这里同一画法（与竖轨一致），行进时沿同一条路径叠一条亮着的光
 * （`MarchLight`）：从控制流来的那一头淡入，到灯那一头最亮，不动。渐变的两端就是画 `path` 的那两个
 * 点（分叉从主轨顶到分支底，合流反过来），不去解析路径串；`id` 用 `useId()`，一张 SVG 里唯一。
 */
function SpineCurve({
  at,
  ink,
  kind,
  track,
}: {
  kind: "fork" | "merge";
  track: number;
  ink: TimelineInk;
  at: "top" | "bottom";
}) {
  const lightId = useId();
  const x = TRACK_X - 0.5 + TRACK_GAP * track;
  const main = TRACK_X - 0.5;
  const path =
    kind === "fork"
      ? `M${main},0 V1 C${main},8 ${x},5 ${x},13`
      : `M${x},0 C${x},8 ${main},5 ${main},13`;
  const from = kind === "fork" ? { x: main, y: 0 } : { x, y: 0 };
  const to = kind === "fork" ? { x, y: 13 } : { x: main, y: 13 };
  const width = x + 8;
  return (
    <svg
      aria-hidden
      className={cn("absolute left-0", at === "top" ? "top-0" : "bottom-0")}
      data-curve-ink={ink}
      data-curve-track={track}
      data-testid={`workflow-run-spine-${kind}`}
      height={13}
      viewBox={`0 0 ${width} 13`}
      width={width}
    >
      <path
        d={path}
        fill="none"
        stroke="var(--color-foreground-subtlest)"
        strokeLinecap="round"
        strokeWidth={1}
      />
      {ink === "march" ? <MarchLight d={path} from={from} id={lightId} to={to} /> : null}
    </svg>
  );
}

/** 一节里全部的竖轨与曲线（`workflowRunSpine.ts` 算好的），一口气画出来。 */
export function SpinePieces({ section }: { section: SpineSection }) {
  return (
    <>
      {section.rails.map((rail) => (
        <SpineRail key={`${rail.track}:${rail.position}`} {...rail} />
      ))}
      {section.curves.map((curve) => (
        <SpineCurve key={`${curve.kind}:${curve.track}`} {...curve} />
      ))}
    </>
  );
}

/**
 * 轨道上的灯：空心 = 未到，绿 = 已过，红带环 = 失败，琥珀带搏动 = 正在运行。运行中的灯与卡上的灯
 * 同一条命（`wf-lamp-running`）：常亮的光晕加一下心跳；`motion-reduce` 时只剩光晕。
 */
export function SpineLamp({ status, track = 0 }: { status: StepRunStatus; track?: number }) {
  return (
    <span
      aria-hidden
      className={cn(
        "wf-lamp absolute left-4 top-[13px] size-2.5 rounded-full",
        STATUS_DOT[status],
        status === "pending" && "bg-background",
        status === "running" && "wf-lamp-running motion-reduce:animate-none",
      )}
      data-lamp={status}
      data-testid="workflow-run-phase-lamp"
      style={track === 0 ? undefined : { left: 16 + TRACK_GAP * track }}
    />
  );
}

/** 折叠节头上的头像串：谁在这一站，一眼可见；子代理是按编号定色的瓦片脸，工作区是终端字形。 */
export function AvatarCluster({
  pills,
  nameOf,
}: {
  pills: readonly TimelinePill[];
  nameOf: (pill: TimelinePill) => string;
}) {
  if (pills.length === 0) return null;
  const shown = pills.slice(0, CLUSTER_MAX);
  const more = pills.length - shown.length;
  return (
    <span className="flex items-center gap-1" data-testid="workflow-run-phase-cluster">
      {shown.map((pill) => {
        const tinted = pill.laneClass === "agent";
        const color = tinted ? agentColor(pill.avatarIndex, nameOf(pill)) : undefined;
        return (
          <span
            className={cn(
              "contents",
              tinted ? "text-[var(--wf-avatar)]" : "text-foreground-subtle",
            )}
            key={pill.key}
            style={color === undefined ? undefined : { ["--wf-avatar" as string]: color }}
            title={nameOf(pill)}
          >
            <LaneGlyph
              className="size-4 shrink-0"
              avatarIndex={pill.avatarIndex}
              laneClass={pill.laneClass}
              name={nameOf(pill)}
              status={pill.status}
            />
          </span>
        );
      })}
      {more > 0 ? (
        <span className="ml-1 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
          +{more}
        </span>
      ) : null}
    </span>
  );
}

/** 轮次：`⟳ n`，只在回边两端且至少跑过一轮时在场（与卡上同一条规则）。 */
export function Rounds({ station }: { station: TimelineStation }) {
  const { intl } = useZCodeIntl();
  if (!station.onLoop || station.rounds === 0) return null;
  return (
    <span
      className="flex items-center gap-[3px]"
      data-testid="workflow-run-phase-rounds"
      title={intl.formatMessage(
        { id: "chat.toolCall.workflow.timeline.rounds" },
        { count: station.rounds },
      )}
    >
      <Repeat2Icon aria-hidden className="size-[11px]" />
      <span>{station.rounds}</span>
    </span>
  );
}
