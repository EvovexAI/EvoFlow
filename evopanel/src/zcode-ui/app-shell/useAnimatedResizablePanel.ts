import { useEffect, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

const PANEL_FLEX_GROW_TRANSITION_CLASSES = ["transition-[flex-grow]", "duration-200", "ease-out"];
const PANEL_FLEX_GROW_TRANSITION_FALLBACK_MS = 240;

function enablePanelFlexGrowTransition(panelElement: HTMLElement): () => void {
  panelElement.classList.add(...PANEL_FLEX_GROW_TRANSITION_CLASSES);

  let finished = false;
  let fallbackTimer = 0;

  const finish = () => {
    if (finished) {
      return;
    }
    finished = true;
    panelElement.removeEventListener("transitionend", handleTransitionEnd);
    if (fallbackTimer) {
      window.clearTimeout(fallbackTimer);
    }
    panelElement.classList.remove(...PANEL_FLEX_GROW_TRANSITION_CLASSES);
  };

  const handleTransitionEnd = (event: TransitionEvent) => {
    if (event.target === panelElement && event.propertyName === "flex-grow") {
      finish();
    }
  };

  panelElement.addEventListener("transitionend", handleTransitionEnd);
  fallbackTimer = window.setTimeout(finish, PANEL_FLEX_GROW_TRANSITION_FALLBACK_MS);

  return finish;
}

export function useAnimatedResizablePanel({
  open,
  alwaysMounted = false,
  expandedSize,
  rememberExpandedSize = false,
  resizeOnInitialVisibleMount = true,
}: {
  open: boolean;
  alwaysMounted?: boolean;
  expandedSize?: string;
  rememberExpandedSize?: boolean;
  resizeOnInitialVisibleMount?: boolean;
}) {
  const panelRef = useRef<PanelImperativeHandle | null>(null);
  const panelElementRef = useRef<HTMLDivElement | null>(null);
  const expandedSizeRef = useRef(expandedSize);
  const hasHandledVisibilityRef = useRef(false);
  const [isVisible, setIsVisible] = useState(open);

  useEffect(() => {
    expandedSizeRef.current = expandedSize;
  }, [expandedSize]);

  useEffect(() => {
    if (alwaysMounted) {
      setIsVisible(open);
      return;
    }

    if (open) {
      // 条件渲染的 Panel 如果一挂载就直接处于展开态，首帧会直接跳到目标尺寸。
      // 这里先让常驻 Panel 保持折叠态，再在下一帧切到展开态，打开和关闭就能复用同一套过渡。
      const rafId = window.requestAnimationFrame(() => {
        setIsVisible(true);
      });
      return () => {
        window.cancelAnimationFrame(rafId);
      };
    }

    setIsVisible(false);
  }, [alwaysMounted, open]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    const panelElement = panelElementRef.current;

    if (!hasHandledVisibilityRef.current) {
      hasHandledVisibilityRef.current = true;
      if (isVisible && !resizeOnInitialVisibleMount) {
        // sidebar 的 PanelGroup 已通过 layoutId 持久化宽度。
        // 首次可见挂载时如果这里再 resize 到默认值，会覆盖用户上次拖拽保存的宽度。
        return;
      }
    }

    // 之前把 flex-grow transition 常驻在 data-panel 上，窗口原生缩放时
    // react-resizable-panels 的 ResizeObserver 会看到一串动画中间尺寸，进而触发大量
    // layout store 更新和 React commit。这里只在显式展开/收起面板时短暂启用尺寸过渡，
    // 避免普通窗口 resize 被动画链路放大。
    const cleanupTransition = panelElement
      ? enablePanelFlexGrowTransition(panelElement)
      : undefined;

    // Panel 首次挂载时，react-resizable-panels 会在内部 effect 里注册约束。
    // 如果我们同一拍就立刻调用 collapse/expand，偶发会早于约束注册完成，触发
    // “Panel constraints not found” 崩溃。这里延后一帧，确保面板先完成注册再执行动画命令。
    const rafId = window.requestAnimationFrame(() => {
      if (isVisible) {
        const nextExpandedSize = expandedSizeRef.current;
        if (nextExpandedSize) {
          panel.resize(nextExpandedSize);
          return;
        }
        panel.expand();
        return;
      }
      if (rememberExpandedSize) {
        const currentSize = panel.getSize().asPercentage;
        if (Number.isFinite(currentSize) && currentSize > 0) {
          expandedSizeRef.current = `${currentSize}%`;
        }
      }
      panel.collapse();
    });

    return () => {
      window.cancelAnimationFrame(rafId);
      cleanupTransition?.();
    };
  }, [isVisible, rememberExpandedSize, resizeOnInitialVisibleMount]);

  return {
    panelRef,
    panelElementRef,
    isVisible,
  };
}
