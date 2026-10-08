import type {
  TimelineInk,
  WorkflowTimelineModel,
} from "@/components/workflow-timeline/timeline-model.js";

/**
 * 脊线的排布：把时间线模型翻译成**每一节**
 * 要画的竖轨与曲线。纯函数、只有下标与像素偏移，没有 React、没有 DOM——渲染件照着画就行。
 *
 * 轨道 t 的竖轨在 `x = 21 + 12t`；带里的分支轨道从带首节的顶上 13px 用分叉曲线离开主轨，一路
 * 竖下来，到汇合站的节顶（没有汇合站就到带末节的节底）再用镜像的曲线回到主轨。分支站的节里主轨
 * 照常穿过，墨是横跨它的那条主线段的墨——控制流确实从那里流过，只是这一节的灯不在主线上。
 *
 * 轨道段一律**成对**查（`from → to`），不按 `from` 索引：带里一站可以同时是双线段的左端与主线段
 * 的左端，`from` 不再唯一。
 */

/** 分叉 / 合流曲线占的高度。 */
const SPINE_CURVE_PX = 13;

/** 一段竖轨。`from` / `to` 是对默认起止的覆盖（px，分别距节顶 / 节底），给曲线让位时才有。 */
export interface SpineRailPiece {
  track: number;
  ink: TimelineInk;
  /** `above` = 节顶到灯，`below` = 灯到节底，`full` = 整节穿过。 */
  position: "above" | "below" | "full";
  from?: number;
  to?: number;
}

/** 分支轨道离开 / 回到主轨的那 13px。 */
export interface SpineCurvePiece {
  kind: "fork" | "merge";
  track: number;
  ink: TimelineInk;
  /** 贴节顶还是贴节底（没有汇合站时合流画在带末节的底上）。 */
  at: "top" | "bottom";
}

export interface SpineSection {
  rails: SpineRailPiece[];
  curves: SpineCurvePiece[];
}

export function spineSections(model: WorkflowTimelineModel): SpineSection[] {
  const sections: SpineSection[] = model.stations.map(() => ({ curves: [], rails: [] }));
  const trackAt = (i: number): number => model.stations[i]?.track ?? 0;
  const plain = model.rails.filter((rail) => rail.kind === undefined);
  /** 横跨第 i 节、两端都在轨道 t 上的那条平轨（主轨穿过分支站、分支轨穿过别人的站都读它）。 */
  const spanning = (i: number, track: number): TimelineInk | undefined =>
    plain.find(
      (rail) =>
        rail.from < i && i < rail.to && trackAt(rail.from) === track && trackAt(rail.to) === track,
    )?.ink;
  const pairInk = (from: number, to: number): TimelineInk =>
    plain.find((rail) => rail.from === from && rail.to === to)?.ink ?? "faint";

  model.stations.forEach((station, i) => {
    const section = sections[i]!;
    const band =
      station.track === 0 ? undefined : model.bands.find((b) => b.from <= i && i <= b.to);
    const track = band?.tracks[station.track];
    if (track === undefined) {
      // 主线上的站：与从前一样，上一站画下半截、下一站画上半截；相邻无边就留空。
      const above = model.rails.find(
        (rail) => rail.to === i && rail.kind !== "twin" && rail.kind !== "merge",
      );
      const below = model.rails.find(
        (rail) => rail.from === i && rail.kind !== "twin" && rail.kind !== "fork",
      );
      if (above !== undefined) section.rails.push({ ink: above.ink, position: "above", track: 0 });
      if (below !== undefined) section.rails.push({ ink: below.ink, position: "below", track: 0 });
      return;
    }
    // 分支站：上下两截读它自己那条轨道，首尾两端读轨道的进出墨（也就是分叉 / 合流段的墨）。
    const at = track.stations.indexOf(i);
    const previous = track.stations[at - 1];
    const next = track.stations[at + 1];
    section.rails.push({
      ink: previous === undefined ? track.entry : pairInk(previous, i),
      position: "above",
      track: station.track,
    });
    section.rails.push({
      ink: next === undefined ? track.exit : pairInk(i, next),
      position: "below",
      track: station.track,
    });
    const main = spanning(i, 0);
    if (main !== undefined) section.rails.push({ ink: main, position: "full", track: 0 });
  });

  for (const band of model.bands) {
    band.tracks.forEach((track, t) => {
      if (t === 0) return;
      const end = band.join ?? band.to;
      const first = track.stations[0]!;
      const last = track.stations[track.stations.length - 1]!;
      // 没有汇合站时合流画在带末节的底上，那一节的竖轨要短 13px。
      const tail = band.join === undefined ? SPINE_CURVE_PX : undefined;
      sections[band.from]?.curves.push({ at: "top", ink: track.entry, kind: "fork", track: t });
      sections[end]?.curves.push({
        at: tail === undefined ? "top" : "bottom",
        ink: track.exit,
        kind: "merge",
        track: t,
      });
      for (let i = band.from; i <= end; i += 1) {
        const section = sections[i];
        if (section === undefined) continue;
        if (track.stations.includes(i)) {
          if (tail !== undefined && i === end) {
            for (const rail of section.rails) {
              if (rail.track === t && rail.position === "below") rail.to = tail;
            }
          }
          continue;
        }
        // 有汇合站时，汇合那一节的顶上是曲线，没有竖着穿过去的一截。
        if (i === end && tail === undefined) continue;
        const ink =
          i < first ? track.entry : i > last ? track.exit : (spanning(i, t) ?? track.exit);
        section.rails.push({
          ink,
          position: "full",
          track: t,
          ...(i === band.from ? { from: SPINE_CURVE_PX } : {}),
          ...(tail !== undefined && i === end ? { to: tail } : {}),
        });
      }
    });
  }
  return sections;
}
