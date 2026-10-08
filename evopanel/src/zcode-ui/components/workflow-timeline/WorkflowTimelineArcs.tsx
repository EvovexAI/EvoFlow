import type { ReactNode } from "react";
import type { TimelineArc, TimelineBand, TimelineInk, TimelineStation } from "./timeline-model.js";
import {
  ARC_BASE,
  ARC_LANE,
  arcEnds,
  arcTerminalOffsets,
  bandAt,
  bandForkX,
  bandMergeX,
  lampX,
  type TimelineLayout,
} from "./timeline-geometry.js";
import { MarchLight } from "./WorkflowMarchLight.js";

/**
 * 弧层：时间线唯一的一层 SVG，只画
 * 非相邻的边。从源站的灯升到自己的弧道、横到目标站、落回目标的灯上，箭头朝下。一站的弧端——
 * 落地与起飞一视同仁——各占一个槽、槽距 10px（`arcTerminalOffsets`：远端在左的在左、在右的在右，
 * 每一侧车道最低的在最外面），于是出去的竖段不会穿过进来的箭头。首次出现时从源画到目标
 * （`pathLength=1` 让 dashoffset 与几何无关）；之后只换墨色；正在走的边叠一层不动的光
 * （`MarchLight`：朝着灯那一头渐亮），动作留给灯自己。
 *
 * 有带时带是**一个节点**：源在带里就从带的汇合点起飞，目标在带里
 * 就落在带的分叉点上（落点提前到 4px，那里没有灯可停）。弧的高度来自它自己的**空**（`arc.air`）：带内同轨道
 * 的弧住在那条轨道的空里，跨轨道与带级的弧一律住在最上面那层空里。轨道段也搬进这一层（`children`）。
 *
 * 带级的弧的竖段一路走到**端点自己的行**：源是站就从它的灯那一行起飞，源是带就从主线上的汇合点
 * 起飞；落点同理，是主线上的分叉点或目标的灯那一行。Loops 板的规则三说竖段「穿过分支行、走那些
 * 行空着的列」——停在最上面那条轨道行边上就什么也没穿过，主线上的灯与自己的弧之间反而空出一整行，
 * 读起来是断开的。设计画布的生成器停在 `rowY[R−1]` 是省事，不是设计。
 */
const INK_STROKE: Record<TimelineInk, string> = {
  faint: "var(--color-workflow-trace)",
  march: "var(--color-workflow-trace-strong)",
  strong: "var(--color-workflow-trace-strong)",
};

export function WorkflowTimelineArcs({
  arcs,
  bands,
  children,
  height,
  layout,
  markerId,
  stations,
  width,
}: {
  arcs: readonly TimelineArc[];
  bands: readonly TimelineBand[];
  /** 全部的站（不是草稿切过的那一段）：弧的下标指向它，要读每一站的轨道。 */
  stations: readonly TimelineStation[];
  layout: TimelineLayout;
  width: number;
  height: number;
  markerId: string;
  children?: ReactNode;
}) {
  const terminals = arcTerminalOffsets(arcs, bands, stations);
  const { inset, rowY } = layout;
  const rowOf = (track: number): number => rowY[track] ?? rowY[0]!;
  const trackOf = (index: number): number => stations[index]?.track ?? 0;
  return (
    <svg
      aria-hidden
      className="absolute left-0 top-0 overflow-visible"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
    >
      <defs>
        {(["faint", "strong"] as const).map((ink) => (
          <marker
            id={`${markerId}-${ink}`}
            key={ink}
            markerHeight="6"
            markerWidth="6"
            orient="auto-start-reverse"
            refX="7"
            refY="4"
            viewBox="0 0 8 8"
          >
            <path d="M0,0.5 L7,4 L0,7.5 Z" fill={INK_STROKE[ink]} />
          </marker>
        ))}
      </defs>
      {children}
      {arcs.map((arc, j) => {
        // 带内同一条轨道的弧整条住在那条轨道的空里，两端仍是灯；其余的弧把带当一个节点（`arcEnds`）。
        const { fromBand, toBand } = arcEnds(arc, bands, stations);
        const source = bandAt(bands, arc.from);
        const target = bandAt(bands, arc.to);
        const ly = rowOf(arc.air) - ARC_BASE - ARC_LANE * arc.lane;
        // 灯上的两端各就各的槽；分叉点与汇合点是一个点，不是一排灯，不占槽（偏移恒为 0）。
        const xa =
          fromBand && source !== undefined
            ? bandMergeX(source, inset)
            : lampX(arc.from, inset) + terminals.takeoff[j]!;
        const xb =
          toBand && target !== undefined
            ? bandForkX(target, inset)
            : lampX(arc.to, inset) + terminals.landing[j]!;
        const sign = xb < xa ? -1 : 1;
        // 起飞与落地都贴着**端点自己的行**：带是主线上的汇合点 / 分叉点，站是它的灯那一行。
        const ya = fromBand ? rowY[0]! - 3 : rowOf(trackOf(arc.from)) - 7;
        const yb = toBand ? rowY[0]! - 4 : rowOf(trackOf(arc.to)) - 9;
        const tail = `V${yb}`;
        const path = `M${xa},${ya} V${ly + 8} Q${xa},${ly} ${xa + 8 * sign},${ly} H${xb - 8 * sign} Q${xb},${ly} ${xb},${ly + 8} ${tail}`;
        const ink = arc.ink === "march" ? "strong" : arc.ink;
        return (
          <g
            data-arc-from={arc.from}
            data-arc-ink={arc.ink}
            data-arc-to={arc.to}
            data-testid="workflow-timeline-arc"
            key={`${arc.from}-${arc.to}-${arc.air}`}
          >
            <path
              className="wf-ink wf-draw"
              d={path}
              fill="none"
              markerEnd={`url(#${markerId}-${ink})`}
              pathLength={1}
              stroke={INK_STROKE[ink]}
              strokeWidth={1}
            />
            {arc.ink === "march" ? (
              // 行进边的光短 6px 收住，停在箭头根部。
              <MarchLight
                d={`${path.slice(0, -tail.length)}V${yb - 6}`}
                from={{ x: xa, y: ya }}
                id={`${markerId}-lit-${j}`}
                to={{ x: xb, y: yb - 6 }}
              />
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
