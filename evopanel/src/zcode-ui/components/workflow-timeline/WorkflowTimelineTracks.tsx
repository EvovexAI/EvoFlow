import { useId } from "react";
import { cn } from "@/components/lib/utils.js";
import type {
  TimelineBand,
  TimelineInk,
  TimelineStation,
  WorkflowTimelineModel,
} from "./timeline-model.js";
import {
  bandAt,
  bandForkX,
  bandMergeX,
  lampX,
  STUB,
  TAIL,
  type TimelineLayout,
} from "./timeline-geometry.js";
import { MarchLight } from "./WorkflowMarchLight.js";
import { stationLampClass } from "./WorkflowTimelineLedge.js";

/**
 * 轨道层。
 *
 * 没有带的时间线里轨道段还是站头行里的一截 border（逐像素不动）。**有带**时整条轨道搬进弧那一层
 * SVG：主线走最下面一行、分支轨道叠在它上面，带前分叉、带后汇合，两段 8px 的四分之一圆把分支
 * 抬上去再放下来（分支向上）。灯仍是 DOM（状态类要
 * 用），绝对定位落在自己那条轨道的行上；站头搬到站台行，分支轨道的站用一条点状引线接回自己的名字。
 */
const INK_STROKE: Record<TimelineInk, string> = {
  faint: "var(--color-workflow-trace)",
  march: "var(--color-workflow-trace-strong)",
  strong: "var(--color-workflow-trace-strong)",
};

/** 画布上的一个点。 */
export interface TimelinePoint {
  x: number;
  y: number;
}

/** 画面上的一段轨道：一条路径、一种墨，外加它接的两站（测试与调试的抓手）。 */
export interface TimelineRailPiece {
  key: string;
  d: string;
  /**
   * 路径的首尾两点，与 `d` 出自同一组数——行进边的光要按这两点铺渐变（`MarchLight`），
   * 而不是回头去解析 `d`。
   */
  start: TimelinePoint;
  end: TimelinePoint;
  ink: TimelineInk;
  /** `fork` / `merge` 是带两端的曲线；`tail` / `stub` 是没有前驱 / 汇合站时主线的那一小截。 */
  kind?: "fork" | "merge" | "tail" | "stub";
  from?: number;
  to?: number;
}

/** 路径与它的首尾两点：`timelineRailPieces` 里每种段都先算出这三样，再配上墨与两站。 */
type RailShape = Pick<TimelineRailPiece, "d" | "end" | "start">;

/**
 * 轨道段 → 路径（纯函数）。一条轨道上的普通段是那一行上的一条直线（灯 + 8 → 灯 − 8）；主线的
 * 那几条穿过分叉点与汇合点，于是主线自然是一条直线。两端都在**不同的带**里的普通段只可能是
 * 相邻两带之间的那一段，画在主线上、从前一带的汇合点到后一带的分叉点。双线段不画在卡上。
 */
export function timelineRailPieces(
  model: Pick<WorkflowTimelineModel, "bands" | "rails" | "stations">,
  layout: TimelineLayout,
): TimelineRailPiece[] {
  const { bands, rails, stations } = model;
  const { inset, rowY } = layout;
  const y0 = rowY[0]!;
  const rowOf = (track: number): number => rowY[track] ?? y0;
  const lx = (i: number): number => lampX(i, inset);
  const forkX = (band: TimelineBand): number => bandForkX(band, inset);
  const mergeX = (band: TimelineBand): number => bandMergeX(band, inset);
  const trackOfStation = (i: number): number => stations[i]?.track ?? 0;

  /** 一行上的一条直线段。 */
  const straight = (x1: number, x2: number, y: number): RailShape => ({
    d: `M${x1},${y} H${x2}`,
    end: { x: x2, y },
    start: { x: x1, y },
  });
  // 分支轨道 t 在 forkX − 8(t−1) 处离开主线，两段四分之一圆升到自己的行，再横到第一枚灯前 8px。
  const forkPath = (band: TimelineBand, track: number, head: number): RailShape => {
    const xf = forkX(band) - 8 * (track - 1);
    const yt = rowOf(track);
    return {
      d: `M${xf},${y0} Q${xf + 8},${y0} ${xf + 8},${y0 - 8} V${yt + 8} Q${xf + 8},${yt} ${xf + 16},${yt} H${lx(head) - 8}`,
      end: { x: lx(head) - 8, y: yt },
      start: { x: xf, y: y0 },
    };
  };
  // 汇合是分叉的镜像：从末站的灯后 8px 横到 xm − 8，落回主线。带里轨道越高，落点越靠左。
  const mergePath = (band: TimelineBand, track: number, tail: number): RailShape => {
    const xm = mergeX(band) - 8 * (band.tracks.length - 1 - track);
    const yt = rowOf(track);
    return {
      d: `M${lx(tail) + 8},${yt} H${xm - 8} Q${xm},${yt} ${xm},${yt + 8} V${y0 - 8} Q${xm},${y0} ${xm + 8},${y0}`,
      end: { x: xm + 8, y: y0 },
      start: { x: lx(tail) + 8, y: yt },
    };
  };

  const pieces: TimelineRailPiece[] = [];
  // 没有前驱 / 没有汇合站的带自己长出两端：主线的一小截尾巴 / 残段，和分支轨道的曲线——模型里
  // 没有对应的轨道段（分叉与汇合都要有那一站才成段），墨色取轨道自己的 entry / exit。
  for (const band of bands) {
    const main = band.tracks[0]!;
    if (band.pred === undefined) {
      const head = main.stations[0]!;
      pieces.push({
        ...straight(forkX(band) - TAIL, lx(head) - 8, y0),
        ink: main.entry,
        key: `tail:${band.from}`,
        kind: "tail",
        to: head,
      });
      band.tracks.forEach((track, t) => {
        if (t === 0) return;
        const first = track.stations[0]!;
        pieces.push({
          ...forkPath(band, t, first),
          ink: track.entry,
          key: `fork:${band.from}:${t}`,
          kind: "fork",
          to: first,
        });
      });
    }
    if (band.join === undefined) {
      const last = main.stations[main.stations.length - 1]!;
      pieces.push({
        ...straight(lx(last) + 8, mergeX(band) + STUB, y0),
        ink: main.exit,
        key: `stub:${band.to}`,
        kind: "stub",
        from: last,
      });
      band.tracks.forEach((track, t) => {
        if (t === 0) return;
        const end = track.stations[track.stations.length - 1]!;
        pieces.push({
          ...mergePath(band, t, end),
          ink: track.exit,
          key: `merge:${band.to}:${t}`,
          kind: "merge",
          from: end,
        });
      });
    }
  }

  for (const rail of rails) {
    // 双线段只说「这两站并行」，卡上不画——分叉与汇合已经把并行说清楚了。
    if (rail.kind === "twin") continue;
    const ends = { from: rail.from, ink: rail.ink, key: `${rail.from}>${rail.to}`, to: rail.to };
    if (rail.kind === "fork") {
      const band = bandAt(bands, rail.to);
      if (band === undefined) continue;
      pieces.push({ ...ends, ...forkPath(band, trackOfStation(rail.to), rail.to), kind: "fork" });
      continue;
    }
    if (rail.kind === "merge") {
      const band = bandAt(bands, rail.from);
      if (band === undefined) continue;
      pieces.push({
        ...ends,
        ...mergePath(band, trackOfStation(rail.from), rail.from),
        kind: "merge",
      });
      continue;
    }
    const source = bandAt(bands, rail.from);
    const target = bandAt(bands, rail.to);
    if (source !== undefined && target !== undefined && source !== target) {
      pieces.push({ ...ends, ...straight(mergeX(source), forkX(target), y0) });
      continue;
    }
    const yt = rowOf(trackOfStation(rail.from));
    pieces.push({ ...ends, ...straight(lx(rail.from) + 8, lx(rail.to) - 8, yt) });
  }
  return pieces;
}

/**
 * 轨道与引线，画在弧那一层 SVG 里（只有带时才挂上）。行进的段照弧的老规矩叠一层，只是那一层
 * 如今是**不动的**光（`MarchLight`）：从段的起点淡入、在灯那一头最亮。
 */
export function WorkflowTimelineTracks({
  folded,
  layout,
  model,
}: {
  model: Pick<WorkflowTimelineModel, "bands" | "rails" | "stations">;
  layout: TimelineLayout;
  /** 折到檐上的站：它的引线跟着灯一起淡出。 */
  folded: ReadonlySet<number>;
}) {
  const pieces = timelineRailPieces(model, layout);
  // 轨道层挂在弧那一层 SVG 里，渐变 id 要在整张 SVG 里唯一：实例前缀 + 段的 key（去掉 `:` `>` 这些）。
  const gradientBase = useId();
  return (
    <g>
      {pieces.map((piece) => (
        <g
          data-rail-from={piece.from}
          data-rail-ink={piece.ink}
          data-rail-kind={piece.kind}
          data-rail-to={piece.to}
          data-testid="workflow-timeline-rail"
          key={piece.key}
        >
          <path
            className="wf-ink"
            d={piece.d}
            fill="none"
            stroke={INK_STROKE[piece.ink]}
            strokeWidth={1}
          />
          {piece.ink === "march" ? (
            <MarchLight
              d={piece.d}
              from={piece.start}
              id={`${gradientBase}lit-${piece.key.replace(/[^\w-]/g, "-")}`}
              to={piece.end}
            />
          ) : null}
        </g>
      ))}
      {model.stations.map((station, i) =>
        station.track === 0 ? null : (
          <path
            className={cn("wf-foldable", folded.has(i) && "wf-folded")}
            d={`M${lampX(i, layout.inset)},${(layout.rowY[station.track] ?? layout.rowY[0]!) + 7} V${layout.capY - 10}`}
            data-leader-station={i}
            data-testid="workflow-timeline-leader"
            fill="none"
            key={station.id}
            stroke="var(--color-workflow-trace)"
            strokeDasharray="1 2"
            strokeLinecap="round"
            strokeWidth={1}
          />
        ),
      )}
    </g>
  );
}

/**
 * 灯（有带时）：还是 DOM 的 span——状态类、光晕与搏动都在 CSS 里——只是绝对定位到自己那条轨道
 * 的行上，而不再跟着站头排。
 */
export function WorkflowTimelineLamps({
  draft,
  folded,
  layout,
  stations,
}: {
  stations: readonly TimelineStation[];
  layout: TimelineLayout;
  folded: ReadonlySet<number>;
  draft: boolean;
}) {
  return (
    <>
      {stations.map((station, i) => (
        <span
          aria-hidden
          className={cn(
            stationLampClass(station.status),
            "absolute",
            "wf-foldable",
            folded.has(i) && "wf-folded",
            draft && "wf-land",
          )}
          data-lamp={station.status ?? "pending"}
          data-lamp-track={station.track}
          key={station.id}
          style={{
            left: lampX(i, layout.inset) - 5,
            top: (layout.rowY[station.track] ?? layout.rowY[0]!) - 5,
          }}
        />
      ))}
    </>
  );
}
