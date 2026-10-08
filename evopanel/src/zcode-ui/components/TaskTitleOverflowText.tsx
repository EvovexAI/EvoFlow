import {
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ElementType,
} from "react";
import { cn } from "@/components/lib/utils.js";

const overflowFadeClassName =
  "[mask-image:linear-gradient(to_right,black_calc(100%_-_1.5rem),transparent)] [-webkit-mask-image:linear-gradient(to_right,black_calc(100%_-_1.5rem),transparent)]";
const marqueeGapPx = 24;
const marqueePixelsPerSecond = 40;
const minimumMarqueeDurationSeconds = 6;
const marqueePauseSeconds = 2;
const marqueeHoverDelayMs = 1_000;
const marqueeMaskFadeInSeconds = 0.15;
const rightFadeMask =
  "linear-gradient(to right, black 0, black calc(100% - 1.5rem), transparent 100%)";
const bothEdgesFadeMask =
  "linear-gradient(to right, transparent 0, black 1.5rem, black calc(100% - 1.5rem), transparent 100%)";

function createMaskKeyframe(maskImage: string, offset: number): Keyframe {
  return { maskImage, offset, webkitMaskImage: maskImage };
}

type TaskTitleOverflowTextProps = ComponentPropsWithoutRef<"p"> & {
  as?: "p" | "span";
};

export function TaskTitleOverflowText({
  as = "p",
  children,
  className,
  // 原生 title 提示框会在 hover 走马灯时遮挡正在滚动的任务名称。
  // 在组件边界统一消费该属性，避免各个 task row 漏掉后再次引入 tooltip。
  title: _nativeTitle,
  ...props
}: TaskTitleOverflowTextProps) {
  const Component = as as ElementType;
  const textRef = useRef<HTMLElement | null>(null);
  const originalTextRef = useRef<HTMLSpanElement | null>(null);
  const marqueeTrackRef = useRef<HTMLSpanElement | null>(null);
  const [overflowState, setOverflowState] = useState({
    distance: 0,
    duration: minimumMarqueeDurationSeconds,
    isOverflowing: false,
  });
  const { distance, duration, isOverflowing } = overflowState;

  useEffect(() => {
    const textElement = textRef.current;
    const originalTextElement = originalTextRef.current;
    if (!textElement || !originalTextElement) return;

    const updateOverflow = () => {
      // 标题过去无条件挂载 mask，完整可见的短标题也带有渐隐样式。
      // 以单份标题的真实排版宽度为准，避免走马灯副本撑大 scrollWidth 后无法退出溢出状态。
      const contentWidth = originalTextElement.scrollWidth;
      const nextIsOverflowing = contentWidth > textElement.clientWidth;
      const nextDistance = nextIsOverflowing ? contentWidth + marqueeGapPx : 0;
      const nextDuration = nextIsOverflowing
        ? Math.max(minimumMarqueeDurationSeconds, nextDistance / marqueePixelsPerSecond)
        : minimumMarqueeDurationSeconds;
      setOverflowState((current) =>
        current.isOverflowing === nextIsOverflowing &&
        current.distance === nextDistance &&
        current.duration === nextDuration
          ? current
          : {
              distance: nextDistance,
              duration: nextDuration,
              isOverflowing: nextIsOverflowing,
            },
      );
    };

    updateOverflow();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateOverflow);
      return () => window.removeEventListener("resize", updateOverflow);
    }

    const resizeObserver = new ResizeObserver(updateOverflow);
    resizeObserver.observe(textElement);
    resizeObserver.observe(originalTextElement);
    return () => resizeObserver.disconnect();
  }, [children]);

  useEffect(() => {
    const textElement = textRef.current;
    const marqueeTrack = marqueeTrackRef.current;
    if (
      !isOverflowing ||
      !textElement ||
      !marqueeTrack ||
      typeof marqueeTrack.animate !== "function"
    ) {
      return;
    }

    const reducedMotionQuery =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    // 走马灯事件原本绑在文字节点上，鼠标位于 task item 的时间、
    // 状态或操作区域时不会滚动。统一绑到最近的普通或 grouped task 行边界。
    const hoverTarget =
      textElement.closest<HTMLElement>("[data-task-item-key], [data-grouped-task-key]") ??
      textElement;
    let animations: Animation[] = [];
    let startTimer: number | null = null;

    const stopMarquee = () => {
      if (startTimer !== null) {
        window.clearTimeout(startTimer);
        startTimer = null;
      }
      animations.forEach((animation) => animation.cancel());
      animations = [];
    };
    const startMarquee = () => {
      if (reducedMotionQuery?.matches) return;

      stopMarquee();
      const totalDuration = duration + marqueePauseSeconds;
      // 纯 CSS infinite 动画只能按百分比停顿，标题宽度变化时无法保证
      // 副本头部对齐后固定等待 2 秒。Web Animation 用动态 offset 分离移动与停留时长。
      const movementEndOffset = duration / totalDuration;
      const maskFadeInEndOffset = marqueeMaskFadeInSeconds / totalDuration;
      // 左侧 mask 在 24px 间距内继续淡出，会让已经离场的主体标题
      // 仍留下一段无内容的渐变。主体尾部到达左边缘时直接切换为仅右侧 mask。
      const originalTailArrivalTime = duration * ((distance - marqueeGapPx) / distance);
      const originalTailArrivalOffset = originalTailArrivalTime / totalDuration;
      const animationOptions: KeyframeAnimationOptions = {
        duration: totalDuration * 1_000,
        easing: "linear",
        iterations: Infinity,
      };
      const trackAnimation = marqueeTrack.animate(
        [
          { offset: 0, transform: "translate3d(0, 0, 0)" },
          {
            offset: movementEndOffset,
            transform: `translate3d(-${distance}px, 0, 0)`,
          },
          {
            offset: 1,
            transform: `translate3d(-${distance}px, 0, 0)`,
          },
        ],
        animationOptions,
      );
      // 滚动期间始终使用双侧 mask，会让副本对齐后的 2 秒停留画面
      // 仍然看不清标题开头。mask 与位移动画共用时长，在到达前淡出左侧并保持到下一轮。
      const maskAnimation = textElement.animate(
        [
          createMaskKeyframe(rightFadeMask, 0),
          createMaskKeyframe(bothEdgesFadeMask, maskFadeInEndOffset),
          createMaskKeyframe(bothEdgesFadeMask, originalTailArrivalOffset),
          createMaskKeyframe(rightFadeMask, originalTailArrivalOffset),
          createMaskKeyframe(rightFadeMask, 1),
        ],
        animationOptions,
      );
      animations = [trackAnimation, maskAnimation];
    };
    const scheduleMarquee = () => {
      if (reducedMotionQuery?.matches) return;
      stopMarquee();
      // 交互规则：短暂划过 task row 不应立即触发运动；停留满 1 秒才开始。
      startTimer = window.setTimeout(() => {
        startTimer = null;
        startMarquee();
      }, marqueeHoverDelayMs);
    };
    const handleMotionPreferenceChange = (event: MediaQueryListEvent) => {
      if (event.matches) stopMarquee();
    };

    hoverTarget.addEventListener("mouseenter", scheduleMarquee);
    hoverTarget.addEventListener("mouseleave", stopMarquee);
    reducedMotionQuery?.addEventListener("change", handleMotionPreferenceChange);

    return () => {
      hoverTarget.removeEventListener("mouseenter", scheduleMarquee);
      hoverTarget.removeEventListener("mouseleave", stopMarquee);
      reducedMotionQuery?.removeEventListener("change", handleMotionPreferenceChange);
      stopMarquee();
    };
  }, [distance, duration, isOverflowing]);

  return (
    <Component
      ref={textRef}
      className={cn(
        "min-w-0 flex-1 overflow-hidden whitespace-nowrap",
        isOverflowing && overflowFadeClassName,
        isOverflowing && "task-title-marquee",
        className,
      )}
      {...props}
    >
      <span
        ref={marqueeTrackRef}
        data-task-title-marquee-track="true"
        className="task-title-marquee-track inline-flex w-max min-w-max items-center gap-6"
      >
        <span ref={originalTextRef} data-task-title-copy="original" className="shrink-0">
          {children}
        </span>
        {isOverflowing ? (
          <span aria-hidden="true" data-task-title-copy="duplicate" className="shrink-0">
            {children}
          </span>
        ) : null}
      </span>
    </Component>
  );
}
