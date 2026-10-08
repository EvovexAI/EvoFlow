import type { CSSProperties } from "react";
import { lampX, stationX, STATION_WIDTH } from "./timeline-geometry.js";

/**
 * 边檐的纯几何：一根轨道两端压缩。
 *
 * 时间线自由滚动；灯滚到视口边缘之外的站**折叠**到那一侧的边檐上——同一枚 10px 灯、16px 一枚、
 * 之间是同一种墨的小轨道段，落在视口边缘干净的底上。轨道行在檐旁渐隐 40px；药丸只在视口边界渐隐。
 * 折叠是不动点：边檐越宽（灯越多），压在它下面的站就越多，所以反复算到集合不再变化。
 *
 * 全部以视口坐标计（x = 站的灯心 − scrollLeft）。无 React、无 DOM。
 */
export const LEDGE_LAMP = 10;
export const LEDGE_PITCH = 16;
export const LEDGE_PAD = 8;
export const LEDGE_FADE = 40;
export const LEDGE_MAX_LAMPS = 3;
/** `+n` 计数占的宽。 */
const LEDGE_MORE = 26;
/** 边檐到内容侧的短轨道段短于它就不画（画出来是一个点）。 */
const STUB_MIN = 6;
/** 滚动条拇指的最短长度。 */
const THUMB_MIN = 24;

export interface TimelineFold {
  /** 折叠到左檐的站（升序）。 */
  left: number[];
  /** 折叠到右檐的站（升序）。 */
  right: number[];
}

export const NO_FOLD: TimelineFold = { left: [], right: [] };

/** 一侧边檐占的宽（含两侧内边距；0 枚灯 = 没有边檐）。 */
export function ledgeWidth(count: number): number {
  if (count <= 0) return 0;
  const lamps = Math.min(count, LEDGE_MAX_LAMPS) * LEDGE_PITCH - (LEDGE_PITCH - LEDGE_LAMP);
  return LEDGE_PAD + lamps + (count > LEDGE_MAX_LAMPS ? LEDGE_MORE : 0) + LEDGE_PAD;
}

/**
 * 折叠集：灯在「边檐 + 渐隐」之下的站；迭代到不动点。视口没量到（宽 0）时什么都不折。
 * `keep` 是镜头正飞向的站：视口在 `scrollTo` 之前量过，平滑滚动在飞的
 * 那几百毫秒里它按陈旧的 scrollLeft 算在视野外——可它正要进来，檐上闪一枚灯是误报，所以两侧都不收它。
 * `inset` 是有带时整根轨道的右移：灯跟着走，折叠的判据也跟着走。
 */
export function foldStations(
  count: number,
  scrollLeft: number,
  clientWidth: number,
  keep?: number,
  inset = 0,
): TimelineFold {
  if (count === 0 || clientWidth <= 0) return NO_FOLD;
  const xs = Array.from({ length: count }, (_, i) => lampX(i, inset) - scrollLeft);
  let left: number[] = [];
  let right: number[] = [];
  for (let pass = 0; pass < 8; pass += 1) {
    const lw = left.length === 0 ? 0 : ledgeWidth(left.length) + LEDGE_FADE;
    const rw = right.length === 0 ? 0 : ledgeWidth(right.length) + LEDGE_FADE;
    const nextLeft = xs.flatMap((x, i) => (x < lw && i !== keep ? [i] : []));
    const nextRight = xs.flatMap((x, i) =>
      x > clientWidth - rw && i !== keep && !nextLeft.includes(i) ? [i] : [],
    );
    if (nextLeft.length === left.length && nextRight.length === right.length) break;
    left = nextLeft;
    right = nextRight;
  }
  return left.length === 0 && right.length === 0 ? NO_FOLD : { left, right };
}

/** 边檐上露出的灯（最多三枚，靠内容的一端优先）与计数。 */
export function ledgeLamps(
  indexes: readonly number[],
  side: "left" | "right",
): { shown: number[]; more: number } {
  const more = Math.max(0, indexes.length - LEDGE_MAX_LAMPS);
  const shown =
    more === 0
      ? [...indexes]
      : side === "left"
        ? indexes.slice(more)
        : indexes.slice(0, LEDGE_MAX_LAMPS);
  return { shown, more };
}

/**
 * 边檐到第一个开着的站之间的短轨道段的宽：左檐从檐的内缘到那站的灯前 6px；右檐从最后一个开着的
 * 站的**槽尾**（不是灯——否则会横穿它的站头文字）到檐的内缘。短于 6 不画。
 */
export function ledgeStubWidth(
  fold: TimelineFold,
  side: "left" | "right",
  scrollLeft: number,
  clientWidth: number,
  inset = 0,
): number {
  const indexes = side === "left" ? fold.left : fold.right;
  if (indexes.length === 0) return 0;
  const inner = ledgeWidth(indexes.length) - LEDGE_PAD;
  let width: number;
  if (side === "left") {
    const open = indexes[indexes.length - 1]! + 1;
    width = lampX(open, inset) - scrollLeft - STUB_MIN - inner;
  } else {
    const open = indexes[0]! - 1;
    width = clientWidth - inner - (stationX(open, inset) + STATION_WIDTH - scrollLeft);
  }
  return width < STUB_MIN ? 0 : Math.round(width);
}

/** 视口两侧各自是否还有内容在外面（左：滚过了；右：没滚到底）。 */
export interface EdgeOverflow {
  left: boolean;
  right: boolean;
}

/**
 * 滚动层的遮罩，分**两条横带**（用户修订：药丸只在真正的边界处渐隐，与自己那站的灯同进退）：
 *   - 轨道带（弧的空气 + 轨道行，高 `railBand`）：有檐的一侧檐下全透、再 40px 渐到不透——檐要落在
 *     干净的底上；没檐但溢出的一侧从视口边缘起 40px 渐隐（站头文字不硬切）。
 *   - 药丸带（其余高度）：只在视口边缘 40px 渐隐，而且只在那一侧真有内容在外面时。药丸不随灯折叠
 *     （两侧对称），檐下照亮，一直亮到边界。
 * 两层 mask 各占一条带（no-repeat，按位置 / 尺寸切开），默认 add 合成 = 并集。两侧都不溢出时没有遮罩。
 */
export function timelineMaskStyle(
  fold: TimelineFold,
  railBand: number,
  edges: EdgeOverflow,
): CSSProperties | undefined {
  if (!edges.left && !edges.right) return undefined;
  const edgeLeft = edges.left ? `transparent 0px, #000 ${LEDGE_FADE}px` : "#000 0px";
  const edgeRight = edges.right
    ? `#000 calc(100% - ${LEDGE_FADE}px), transparent 100%`
    : "#000 100%";
  const railLeft =
    fold.left.length > 0
      ? `transparent ${ledgeWidth(fold.left.length) + LEDGE_PAD}px, #000 ${ledgeWidth(fold.left.length) + LEDGE_PAD + LEDGE_FADE}px`
      : edgeLeft;
  const railRight =
    fold.right.length > 0
      ? `#000 calc(100% - ${ledgeWidth(fold.right.length) + LEDGE_PAD + LEDGE_FADE}px), transparent calc(100% - ${ledgeWidth(fold.right.length) + LEDGE_PAD}px)`
      : edgeRight;
  const image = `linear-gradient(90deg, ${railLeft}, ${railRight}), linear-gradient(90deg, ${edgeLeft}, ${edgeRight})`;
  const size = `100% ${railBand}px, 100% calc(100% - ${railBand}px)`;
  const position = `0 0, 0 ${railBand}px`;
  return {
    WebkitMaskImage: image,
    WebkitMaskPosition: position,
    WebkitMaskRepeat: "no-repeat, no-repeat",
    WebkitMaskSize: size,
    maskImage: image,
    maskPosition: position,
    maskRepeat: "no-repeat, no-repeat",
    maskSize: size,
  };
}

/** 滚动条拇指：长 = 视口² / 内容（不短于 24），位置按滚动比例；不溢出时没有。 */
export function scrollbarThumb(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
): { left: number; width: number } | undefined {
  if (clientWidth <= 0 || scrollWidth <= clientWidth) return undefined;
  const width = Math.max(THUMB_MIN, (clientWidth * clientWidth) / scrollWidth);
  const range = scrollWidth - clientWidth;
  const left = ((clientWidth - width) * Math.min(Math.max(scrollLeft, 0), range)) / range;
  return { left: Math.round(left), width: Math.round(width) };
}

/**
 * 镜头的一班飞行：`scrollTo(target)` 已发出、还没落地。飞行中 `index` 不折。
 * `from` 是上一次采到的 scrollLeft——平滑滚动只会单调靠近目标，所以「比上一次更远」就是用户接手了。
 */
export interface CameraFlight {
  index: number;
  /** 已按 `scrollWidth − clientWidth` 夹紧的落点。 */
  target: number;
  from: number;
}

/**
 * 一次 scroll 采样之后飞行还在不在：落地（±1px）或偏离（用户接手）即结束，否则记下这次位置继续飞。
 * 只由滚动位置决定，不用计时器——被用户中断的平滑滚动永远到不了目标，计时器兜底会让目标站错过折叠。
 */
export function flightAfterScroll(
  flight: CameraFlight | undefined,
  scrollLeft: number,
): CameraFlight | undefined {
  if (flight === undefined) return undefined;
  const distance = Math.abs(scrollLeft - flight.target);
  if (distance <= 1) return undefined;
  if (distance > Math.abs(flight.from - flight.target) + 1) return undefined;
  return scrollLeft === flight.from ? flight : { ...flight, from: scrollLeft };
}

/** 镜头：把一站滚到视口正中的 scrollLeft（左端不越 0）。边檐上的灯点了就走这条。 */
export function stationCameraLeft(index: number, clientWidth: number, inset = 0): number {
  return Math.max(0, stationX(index, inset) - (clientWidth - STATION_WIDTH) / 2);
}

/**
 * 轨道段的查表键：**一对站**，不是起点。带里一站可以同时长出好几条段——
 * 主线的一条、分叉的一条、双线段的一条——按起点查会拿到先排到的那一条。
 */
export function railKey(from: number, to: number): string {
  return `${from}>${to}`;
}
