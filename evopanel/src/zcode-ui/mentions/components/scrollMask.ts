import type { CSSProperties } from "react";

const SCROLL_MASK_EDGE_SIZE_PX = 24;
const SCROLL_MASK_THRESHOLD_PX = 1;

export interface ScrollMetrics {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}

export interface ScrollMaskState {
  showBottom: boolean;
  showTop: boolean;
}

export const EMPTY_SCROLL_MASK_STATE: ScrollMaskState = {
  showBottom: false,
  showTop: false,
};

export function resolveVerticalScrollMaskState({
  clientHeight,
  scrollHeight,
  scrollTop,
}: ScrollMetrics): ScrollMaskState {
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  if (maxScrollTop <= SCROLL_MASK_THRESHOLD_PX) {
    return EMPTY_SCROLL_MASK_STATE;
  }

  return {
    showTop: scrollTop > SCROLL_MASK_THRESHOLD_PX,
    showBottom: scrollTop < maxScrollTop - SCROLL_MASK_THRESHOLD_PX,
  };
}

export function getVerticalScrollMaskStyle({
  showBottom,
  showTop,
}: ScrollMaskState): CSSProperties | undefined {
  if (!showTop && !showBottom) {
    return undefined;
  }

  const topStop = showTop
    ? `transparent 0px, black ${SCROLL_MASK_EDGE_SIZE_PX}px`
    : `black 0px, black ${SCROLL_MASK_EDGE_SIZE_PX}px`;
  const bottomStop = showBottom
    ? `black calc(100% - ${SCROLL_MASK_EDGE_SIZE_PX}px), transparent 100%`
    : `black calc(100% - ${SCROLL_MASK_EDGE_SIZE_PX}px), black 100%`;
  const maskImage = `linear-gradient(to bottom, ${topStop}, ${bottomStop})`;

  return {
    WebkitMaskImage: maskImage,
    maskImage,
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
    WebkitMaskSize: "100% 100%",
    maskSize: "100% 100%",
  };
}
