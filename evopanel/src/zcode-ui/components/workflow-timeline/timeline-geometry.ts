import { arcLaneCount } from "./timeline-bands.js";
import type { TimelineArc, TimelineBand, TimelineStation } from "./timeline-model.js";

/**
 * 横向时间线的几何常量。与设计画布逐字相同：
 * 站宽 168、站距 24，灯落在站左缘 + 17（药丸头像列）。单独成文件是因为边檐的
 * 纯几何要读它们，而它不该反过来依赖渲染组件。
 */
export const STATION_WIDTH = 168;
export const STATION_GAP = 24;
export const STATION_PITCH = STATION_WIDTH + STATION_GAP;
/** 灯心距站左缘的距离：外边距 12 + 半径 5。 */
export const MARK_X = 17;

/** 轨道行高。 */
export const RAIL_ROW = 24;
/** 相邻两条弧道的高差。 */
export const ARC_LANE = 14;
/**
 * 最低的弧道离轨道中线的高度。它必须装得下：圆角 8 + 落地的竖段（箭头 5.25 长，再留几像素的直线，
 * 箭头才像从上面落下来的）。之前是 16：圆角占掉 8 之后竖段只剩 −1px——最后一段反而向上走了一像素，
 * `marker-end` 跟着朝上，箭头就「不见了」。
 */
export const ARC_BASE = 26;
/** 同一枚灯上相邻两个弧端（起飞或落地）的间距。 */
export const TERMINAL_PITCH = 10;
export const PILL_HEIGHT = 32;
export const PILL_GAP = 6;

/**
 * 站台行：只有带的时间线才有，
 * 24px 一行，站头（名字 + 元数据）从轨道行搬到这里——主线就在它正上方，只有分支轨道的站需要
 * 一条引线。
 */
export const PLATFORM_ROW = 24;
/** 站台上名字的左缘：与灯的外边距同值，于是灯、名字、药丸头像连成一条竖脊。 */
export const CAPTION_X = 12;
/** 分叉点离首站左缘的距离；分支轨道每高一层再左移 8。 */
export const FORK_BACK = 16;
/** 汇合点离汇合站左缘的距离（负值 = 在它左边）。 */
export const MERGE_BACK = 10;
/** 没有前驱时那截尾巴的长度，与没有汇合站时那截残段的长度。 */
export const TAIL = 4;
export const STUB = 6;

export function timelineWidth(count: number, inset = 0): number {
  return count === 0 ? 0 : (count - 1) * STATION_PITCH + STATION_WIDTH + inset;
}

/** 第 i 站的左缘。 */
export function stationX(index: number, inset = 0): number {
  return index * STATION_PITCH + inset;
}

/** 第 i 站的灯心。 */
export function lampX(index: number, inset = 0): number {
  return stationX(index, inset) + MARK_X;
}

/** 一条带在主线上分叉的 x；带从站 0 起时没有左边的余地，落在 4（时间线整体右移 `inset`）。 */
export function bandForkX(band: Pick<TimelineBand, "from">, inset = 0): number {
  return band.from === 0 ? TAIL : stationX(band.from, inset) - FORK_BACK;
}

/** 一条带在主线上汇合的 x；没有汇合站时落在末站槽尾之后 6px——那里仍是 strand 相遇的地方。 */
export function bandMergeX(band: Pick<TimelineBand, "join" | "to">, inset = 0): number {
  return band.join === undefined
    ? stationX(band.to, inset) + STATION_WIDTH + STUB
    : stationX(band.join, inset) - MERGE_BACK;
}

/** 第 i 站所在的带；带外 undefined（`timeline-bands.ts` 的同名函数只认下标带，这里认模型的带）。 */
export function bandAt(bands: readonly TimelineBand[], index: number): TimelineBand | undefined {
  return bands.find((band) => band.from <= index && index <= band.to);
}

/**
 * 一条弧的两端挂在哪。带内同一条轨道的弧
 * 两端都是灯（`inTrack`）；其余的弧把带当一个节点：源在带里就从带的汇合点起飞（`fromBand`），目标在
 * 带里就落在带的分叉点上（`toBand`）。带的自环两端也在同一条带里，但它的 `air` 是最上面那层空，
 * 落点又总在轨道 0 上，所以不会被认成 `inTrack`。
 */
export interface ArcEnds {
  inTrack: boolean;
  fromBand: boolean;
  toBand: boolean;
}

export function arcEnds(
  arc: Pick<TimelineArc, "air" | "from" | "to">,
  bands: readonly TimelineBand[],
  stations: readonly Pick<TimelineStation, "track">[],
): ArcEnds {
  const source = bandAt(bands, arc.from);
  const target = bandAt(bands, arc.to);
  const trackOf = (index: number): number => stations[index]?.track ?? 0;
  const inTrack =
    source !== undefined &&
    source === target &&
    trackOf(arc.from) === arc.air &&
    trackOf(arc.to) === arc.air;
  return {
    fromBand: !inTrack && source !== undefined,
    inTrack,
    toBand: !inTrack && target !== undefined,
  };
}

/**
 * 弧端的槽位：弧在灯上的两端——源站的**起飞**、目标站的**落地**——
 * 都是这一站的弧端。一站的弧端各占一个槽，槽距 `TERMINAL_PITCH`，以灯心为中；只有一个弧端的站仍用
 * 灯心，于是没有冲突的时间线逐像素不动。
 *
 * 之前只有落地会错开，起飞一律在灯心：一站既有进来的弧又有出去的弧时，出去的竖段正好穿过进来的箭头，
 * 两条竖段叠成一条线、箭头卡在半腰（testfield 的「工作流压力测试」里支路甲、支路乙两站）。车道把两条
 * 共用一站的弧在 y 上分开，却管不到 x。
 *
 * 槽的次序，自左向右：先是远端在这一站**左边**的弧端，再是远端在**右边**的；每一侧里**车道最低的在
 * 最外面**。一条弧的竖段与横段是一个朝远端张开的 L：朝左的放左边、朝右的放右边，两侧的 L 背对背永不
 * 相遇；同一侧里拐得低的若站在里面，拐得高的那条的竖段就要穿过它的横段——这正是车道的闭区间论证转了
 * 九十度。带的分叉点与汇合点不占槽：分叉点上只有落地、汇合点上只有起飞，同一个点上的竖段像 strand
 * 一样共用一条线，下面永远不会压着箭头。
 *
 * 返回与 `arcs` 一一对应的两列偏移（相对灯心，px）；端点不是灯的那一侧恒为 0。
 */
export function arcTerminalOffsets(
  arcs: readonly Pick<TimelineArc, "air" | "from" | "lane" | "to">[],
  bands: readonly TimelineBand[],
  stations: readonly Pick<TimelineStation, "track">[],
): { takeoff: number[]; landing: number[] } {
  const takeoff = arcs.map(() => 0);
  const landing = arcs.map(() => 0);
  interface Terminal {
    arc: number;
    end: "takeoff" | "landing";
    /** 远端在左 −1、在右 1。 */
    side: -1 | 1;
    lane: number;
  }
  const byStation = new Map<number, Terminal[]>();
  const add = (station: number, terminal: Terminal): void => {
    const list = byStation.get(station) ?? [];
    list.push(terminal);
    byStation.set(station, list);
  };
  arcs.forEach((arc, j) => {
    const ends = arcEnds(arc, bands, stations);
    if (!ends.fromBand) {
      add(arc.from, { arc: j, end: "takeoff", lane: arc.lane, side: arc.to > arc.from ? 1 : -1 });
    }
    if (!ends.toBand) {
      add(arc.to, { arc: j, end: "landing", lane: arc.lane, side: arc.from > arc.to ? 1 : -1 });
    }
  });
  for (const list of byStation.values()) {
    // 同一站、同一层空里的弧两两相交（闭区间），车道必不相同；稳定排序让弧序兜底。
    list.sort(
      (left, right) =>
        left.side - right.side || (left.side < 0 ? left.lane - right.lane : right.lane - left.lane),
    );
    list.forEach((terminal, k) => {
      const offset = (k - (list.length - 1) / 2) * TERMINAL_PITCH;
      if (terminal.end === "takeoff") takeoff[terminal.arc] = offset;
      else landing[terminal.arc] = offset;
    });
  }
  return { landing, takeoff };
}

/** 时间线的行：每条轨道的中线、站台行、药丸列的顶，以及整体的右移。 */
export interface TimelineLayout {
  /** 每条轨道的中线 y，下标 = 轨道号；`rowY[0]` 是主线（最下面那一行）。 */
  rowY: number[];
  /** 站台行的中线；没有带时退化成主线行——那时站头还在轨道行上。 */
  capY: number;
  /** 药丸列的顶。 */
  pillsTop: number;
  /** 整根轨道右移的量：有带从站 0 起时 12（分叉要有落脚的地方），否则 0。 */
  inset: number;
  /** 画面上有带。 */
  banded: boolean;
}

/**
 * 行的排布：自上而下 `t = R−1 … 0`，每条轨道
 * 先留自己的**空气**（弧道），再一行 24px 的轨道；主线因此落在最下面、紧挨着站台行。空气按那层
 * 空里的弧道数算：没有弧时最上面一层留 6px 呼吸，其余为 0。没有带时 R = 1，整套式子逐像素退回
 * 从前的「弧道 + 轨道行」。
 */
export function timelineLayout(
  arcs: readonly TimelineArc[],
  bands: readonly TimelineBand[],
): TimelineLayout {
  const banded = bands.length > 0;
  const tracks = banded ? Math.max(2, ...bands.map((band) => band.tracks.length)) : 1;
  const rowY: number[] = [];
  let y = 0;
  for (let t = tracks - 1; t >= 0; t -= 1) {
    const lanes = arcLaneCount(arcs.filter((arc) => arc.air === t));
    // 最高一道的顶线落在 y = 8：rowY = air + RAIL_ROW/2 = 8 + ARC_BASE + ARC_LANE × (lanes − 1)。
    const air =
      lanes === 0
        ? t === tracks - 1
          ? 6
          : 0
        : 8 + ARC_BASE - RAIL_ROW / 2 + ARC_LANE * (lanes - 1);
    y += air;
    rowY[t] = y + RAIL_ROW / 2;
    y += RAIL_ROW;
  }
  const capY = banded ? y + PLATFORM_ROW / 2 : rowY[0]!;
  if (banded) y += PLATFORM_ROW;
  return {
    banded,
    capY,
    inset: banded && bands.some((band) => band.from === 0) ? CAPTION_X : 0,
    pillsTop: y + 8,
    rowY,
  };
}
