import { useEffect, useLayoutEffect, useState } from "react";

/**
 * 滚动视口的三个数（scrollLeft / clientWidth / scrollWidth）与「正在滚」标记。
 * 滚动事件按帧合并；尺寸变化走 ResizeObserver（容器与内容层都看，草稿的笔每揭示一站内容就变宽）。
 * jsdom 里量不到（宽 0），消费者据此什么都不折——静态测试结果逐像素保持不变。
 *
 * 以**元素**而不是 ref 对象为依赖：草稿首帧没有站、滚动层晚一帧才挂上，
 * 以 ref 对象为依赖的 effect 在首帧遇到 null 就提前返回、之后再也不跑——监听从来没接上，视口只剩宽度变化时
 * 那一次陈旧的测量，最新一站被永久折到右檐。元素由消费者用 callback ref 放进状态交过来：出现就接线、离开就拆。
 *
 * 量到的数没变就不换对象，ResizeObserver 与
 * 滚动回调每次都造新对象曾让时间线白渲染一轮；空草稿空转期间这些多余的更新一起给 React 的嵌套更新
 * 计数记账。
 */
export interface TimelineViewport {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
  /** 最近 800ms 内滚过（滚动条据此露出）。 */
  scrolling: boolean;
}

const SCROLLING_MS = 800;
const EMPTY: TimelineViewport = { clientWidth: 0, scrollLeft: 0, scrollWidth: 0, scrolling: false };

function measure(element: HTMLElement): Omit<TimelineViewport, "scrolling"> {
  return {
    clientWidth: element.clientWidth,
    scrollLeft: element.scrollLeft,
    scrollWidth: element.scrollWidth,
  };
}

/** 把一次测量并进上一份视口；三个数与 scrolling 都没变就返回上一份，React 据此跳过这轮渲染。 */
function merge(
  previous: TimelineViewport,
  measured: Omit<TimelineViewport, "scrolling">,
  scrolling = previous.scrolling,
): TimelineViewport {
  return previous.clientWidth === measured.clientWidth &&
    previous.scrollLeft === measured.scrollLeft &&
    previous.scrollWidth === measured.scrollWidth &&
    previous.scrolling === scrolling
    ? previous
    : { ...measured, scrolling };
}

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function useTimelineViewport(
  /** 滚动层元素；还没挂上（草稿首帧）或已卸下时为 null。 */
  element: HTMLElement | null,
  /** 内容变化的抓手（站数、宽度）：变了就重新量一次。 */
  contentKey: number,
): TimelineViewport {
  const [viewport, setViewport] = useState<TimelineViewport>(EMPTY);

  useIsomorphicLayoutEffect(() => {
    if (element === null) return;
    setViewport((previous) => merge(previous, measure(element)));
  }, [element, contentKey]);

  useEffect(() => {
    if (element === null) return;
    let frame: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        setViewport((previous) => merge(previous, measure(element), true));
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = undefined;
          setViewport((previous) =>
            previous.scrolling ? { ...previous, scrolling: false } : previous,
          );
        }, SCROLLING_MS);
      });
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        setViewport((previous) => merge(previous, measure(element)));
      });
      observer.observe(element);
      const content = element.firstElementChild;
      if (content !== null) observer.observe(content);
    }
    return () => {
      element.removeEventListener("scroll", onScroll);
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
      observer?.disconnect();
    };
  }, [element]);

  return viewport;
}
