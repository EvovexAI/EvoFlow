"use client";

import { ChevronDownIcon, CircleMinusIcon, CirclePlusIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  fitDiagramToViewport,
  panDiagram,
  zoomDiagramAtPoint,
  type DiagramPoint,
  type DiagramViewportBounds,
  type DiagramViewportTransform,
} from "@/lib/diagramViewport.js";
import { logger } from "@/logger.js";

type DiagramPreviewDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  svg: string;
  title: string;
};

type PinchGestureState = {
  center: DiagramPoint;
  distance: number;
  transform: DiagramViewportTransform;
};

const defaultTransform: DiagramViewportTransform = {
  scale: 1,
  translateX: 0,
  translateY: 0,
};

const zoomScaleOptions = [0.5, 1, 2] as const;

const svgGraphicSelector = [
  "circle",
  "ellipse",
  "foreignObject",
  "g",
  "image",
  "line",
  "path",
  "polygon",
  "polyline",
  "rect",
  "text",
  "use",
].join(",");
const nonVisibleSvgAncestorSelector = [
  "clipPath",
  "defs",
  "linearGradient",
  "marker",
  "mask",
  "metadata",
  "pattern",
  "radialGradient",
  "script",
  "style",
  "symbol",
  "title",
].join(",");

function getPointerCenter(points: PointerEvent[]): DiagramPoint {
  const [first, second] = points;
  if (!first || !second) {
    return { x: first?.clientX ?? 0, y: first?.clientY ?? 0 };
  }

  return {
    x: (first.clientX + second.clientX) / 2,
    y: (first.clientY + second.clientY) / 2,
  };
}

function getPointerDistance(points: PointerEvent[]): number {
  const [first, second] = points;
  if (!first || !second) {
    return 0;
  }

  return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
}

function isTransparentPaint(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    normalized === "none" ||
    normalized === "transparent" ||
    normalized === "rgba(0, 0, 0, 0)"
  );
}

function readRootSvgBounds(svgElement: SVGSVGElement): DiagramViewportBounds {
  const viewBox = svgElement.viewBox.baseVal;
  if (viewBox.width > 0 && viewBox.height > 0) {
    return {
      height: viewBox.height,
      width: viewBox.width,
      x: viewBox.x,
      y: viewBox.y,
    };
  }

  const width = svgElement.width.baseVal.value;
  const height = svgElement.height.baseVal.value;
  if (width > 0 && height > 0) {
    return { height, width };
  }

  return {
    height: svgElement.clientHeight,
    width: svgElement.clientWidth,
  };
}

function applyPreviewSvgLayout(
  contentElement: HTMLDivElement,
  svgElement: SVGSVGElement,
): DiagramViewportBounds {
  const rootBounds = readRootSvgBounds(svgElement);
  if (rootBounds.width > 0 && rootBounds.height > 0) {
    // Mermaid 输出的 SVG 常见为 width="100%" + max-width=viewBox 宽度。
    // transform 实际作用在父级 content 上；如果只改 SVG，父级仍可能保持 300px 级别的收缩宽度。
    // 因此父级和 SVG 都要对齐到 viewBox 尺寸，保证 fit 计算和 CSS transform 使用同一个坐标系。
    contentElement.style.width = `${rootBounds.width}px`;
    contentElement.style.height = `${rootBounds.height}px`;
    svgElement.style.width = "100%";
    svgElement.style.height = "100%";
    svgElement.style.maxWidth = "none";
  }

  return rootBounds;
}

function readRect(element: Element | null): null | {
  height: number;
  width: number;
  x: number;
  y: number;
} {
  if (!element) {
    return null;
  }

  const rect = element.getBoundingClientRect();
  return {
    height: rect.height,
    width: rect.width,
    x: rect.x,
    y: rect.y,
  };
}

function readSvgBBox(svgElement: SVGSVGElement): null | {
  height: number;
  width: number;
  x: number;
  y: number;
} {
  try {
    const box = svgElement.getBBox();
    return {
      height: box.height,
      width: box.width,
      x: box.x,
      y: box.y,
    };
  } catch {
    return null;
  }
}

function mergeBounds(
  current: DiagramViewportBounds | null,
  box: Pick<DOMRect, "height" | "width" | "x" | "y">,
): DiagramViewportBounds {
  if (!current) {
    return {
      height: box.height,
      width: box.width,
      x: box.x,
      y: box.y,
    };
  }

  const minX = Math.min(current.x ?? 0, box.x);
  const minY = Math.min(current.y ?? 0, box.y);
  const maxX = Math.max((current.x ?? 0) + current.width, box.x + box.width);
  const maxY = Math.max((current.y ?? 0) + current.height, box.y + box.height);

  return {
    height: maxY - minY,
    width: maxX - minX,
    x: minX,
    y: minY,
  };
}

function isCanvasBackgroundElement(
  element: SVGGraphicsElement,
  box: DOMRect,
  rootBounds: DiagramViewportBounds,
): boolean {
  if (element.tagName.toLowerCase() !== "rect" || rootBounds.width <= 0 || rootBounds.height <= 0) {
    return false;
  }

  const style = getComputedStyle(element);
  const className =
    typeof element.className === "object" && "baseVal" in element.className
      ? element.className.baseVal
      : String(element.className ?? "");
  const coversRoot =
    Math.abs(box.x - (rootBounds.x ?? 0)) <= 1 &&
    Math.abs(box.y - (rootBounds.y ?? 0)) <= 1 &&
    box.width >= rootBounds.width * 0.95 &&
    box.height >= rootBounds.height * 0.95;

  return coversRoot && (isTransparentPaint(style.stroke) || className.includes("background"));
}

function resolveSvgBounds(svgElement: SVGSVGElement | null): DiagramViewportBounds {
  if (!svgElement) {
    return { height: 0, width: 0 };
  }

  const rootBounds = readRootSvgBounds(svgElement);
  let visibleBounds: DiagramViewportBounds | null = null;

  for (const element of svgElement.querySelectorAll(svgGraphicSelector)) {
    if (!(element instanceof SVGGraphicsElement)) {
      continue;
    }
    if (element.closest(nonVisibleSvgAncestorSelector)) {
      continue;
    }

    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      continue;
    }

    try {
      const box = element.getBBox();
      if (
        box.width <= 0 ||
        box.height <= 0 ||
        isCanvasBackgroundElement(element, box, rootBounds)
      ) {
        continue;
      }
      visibleBounds = mergeBounds(visibleBounds, box);
    } catch {
      // 某些 SVG 元素未完成布局时不能读取 bbox；继续用其余可见图形求 union。
    }
  }

  if (visibleBounds && visibleBounds.width > 0 && visibleBounds.height > 0) {
    return visibleBounds;
  }

  try {
    const box = svgElement.getBBox();
    if (box.width > 0 && box.height > 0) {
      return {
        height: box.height,
        width: box.width,
        x: box.x,
        y: box.y,
      };
    }
  } catch {
    // 根 bbox 不可用时回退到 viewBox / 声明尺寸。
  }

  return rootBounds;
}

function getViewportPoint(
  container: HTMLDivElement,
  clientX: number,
  clientY: number,
): DiagramPoint {
  const rect = container.getBoundingClientRect();
  return {
    x: clientX - rect.left,
    y: clientY - rect.top,
  };
}

export function DiagramPreviewDialog({
  open,
  onOpenChange,
  svg,
  title,
}: DiagramPreviewDialogProps) {
  const { intl } = useZCodeIntl();
  const dialogContentRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const activePointersRef = useRef(new Map<number, PointerEvent>());
  const dragOriginRef = useRef<{
    point: DiagramPoint;
    transform: DiagramViewportTransform;
  } | null>(null);
  const pinchGestureRef = useRef<PinchGestureState | null>(null);
  const [transform, setTransform] = useState<DiagramViewportTransform>(defaultTransform);

  const fitToViewport = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    const svgElement = content?.querySelector("svg");
    if (!viewport || !content || !(svgElement instanceof SVGSVGElement)) {
      setTransform(defaultTransform);
      return;
    }

    const rootBounds = applyPreviewSvgLayout(content, svgElement);
    const diagramBounds = resolveSvgBounds(svgElement);
    const viewportRect = viewport.getBoundingClientRect();
    const nextTransform = fitDiagramToViewport({
      diagramHeight: diagramBounds.height,
      diagramWidth: diagramBounds.width,
      diagramX: (diagramBounds.x ?? 0) - (rootBounds.x ?? 0),
      diagramY: (diagramBounds.y ?? 0) - (rootBounds.y ?? 0),
      viewportHeight: viewportRect.height,
      viewportWidth: viewportRect.width,
    });

    const viewBox = svgElement.viewBox.baseVal;
    const computedStyle = getComputedStyle(svgElement);
    logger.info("[DiagramPreviewDialog] preview layout measured", {
      content: {
        rect: readRect(content),
        transform: content.style.transform,
      },
      dialog: {
        rect: readRect(dialogContentRef.current),
      },
      fit: {
        bounds: diagramBounds,
        rootBounds,
        transform: nextTransform,
      },
      svg: {
        attributes: {
          height: svgElement.getAttribute("height"),
          style: svgElement.getAttribute("style"),
          viewBox: svgElement.getAttribute("viewBox"),
          width: svgElement.getAttribute("width"),
        },
        bbox: readSvgBBox(svgElement),
        client: {
          height: svgElement.clientHeight,
          width: svgElement.clientWidth,
        },
        computedStyle: {
          height: computedStyle.height,
          maxHeight: computedStyle.maxHeight,
          maxWidth: computedStyle.maxWidth,
          width: computedStyle.width,
        },
        rect: readRect(svgElement),
        rootBounds: readRootSvgBounds(svgElement),
        viewBox: {
          height: viewBox.height,
          width: viewBox.width,
          x: viewBox.x,
          y: viewBox.y,
        },
      },
      transform: nextTransform,
      viewport: {
        rect: readRect(viewport),
      },
    });
    setTransform(nextTransform);
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const rect = viewport.getBoundingClientRect();
    const center = { x: rect.width / 2, y: rect.height / 2 };
    setTransform((current) => zoomDiagramAtPoint(current, center, current.scale * factor));
  }, []);

  const zoomToScale = useCallback((scale: number) => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const rect = viewport.getBoundingClientRect();
    const center = { x: rect.width / 2, y: rect.height / 2 };
    setTransform((current) => zoomDiagramAtPoint(current, center, scale));
  }, []);

  const reset = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    const svgElement = content?.querySelector("svg");
    if (!viewport || !content || !(svgElement instanceof SVGSVGElement)) {
      setTransform(defaultTransform);
      return;
    }

    const rootBounds = applyPreviewSvgLayout(content, svgElement);
    const diagramBounds = resolveSvgBounds(svgElement);
    const viewportRect = viewport.getBoundingClientRect();
    setTransform({
      scale: 1,
      translateX:
        (viewportRect.width - diagramBounds.width) / 2 -
        ((diagramBounds.x ?? 0) - (rootBounds.x ?? 0)),
      translateY:
        (viewportRect.height - diagramBounds.height) / 2 -
        ((diagramBounds.y ?? 0) - (rootBounds.y ?? 0)),
    });
  }, []);

  useEffect(() => {
    if (!open) {
      activePointersRef.current.clear();
      dragOriginRef.current = null;
      pinchGestureRef.current = null;
      return;
    }

    const frame = window.requestAnimationFrame(fitToViewport);
    return () => window.cancelAnimationFrame(frame);
  }, [fitToViewport, open, svg]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleResize = () => fitToViewport();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [fitToViewport, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }

      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomBy(1.18);
        return;
      }

      if (event.key === "-") {
        event.preventDefault();
        zoomBy(0.85);
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, zoomBy]);

  const handleWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    if (event.ctrlKey) {
      const point = getViewportPoint(viewport, event.clientX, event.clientY);
      const factor = Math.exp(-event.deltaY * 0.01);
      setTransform((current) => zoomDiagramAtPoint(current, point, current.scale * factor));
      return;
    }

    setTransform((current) => panDiagram(current, { x: -event.deltaX, y: -event.deltaY }));
  }, []);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const viewport = viewportRef.current;
      if (!viewport) {
        return;
      }

      event.currentTarget.setPointerCapture(event.pointerId);
      activePointersRef.current.set(event.pointerId, event.nativeEvent);
      const activePointers = Array.from(activePointersRef.current.values());

      if (activePointers.length >= 2) {
        pinchGestureRef.current = {
          center: getPointerCenter(activePointers),
          distance: getPointerDistance(activePointers),
          transform,
        };
        dragOriginRef.current = null;
        return;
      }

      const point = getViewportPoint(viewport, event.clientX, event.clientY);
      dragOriginRef.current = { point, transform };
    },
    [transform],
  );

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (!viewport || !activePointersRef.current.has(event.pointerId)) {
      return;
    }

    activePointersRef.current.set(event.pointerId, event.nativeEvent);
    const activePointers = Array.from(activePointersRef.current.values());

    if (activePointers.length >= 2 && pinchGestureRef.current) {
      const nextCenter = getPointerCenter(activePointers);
      const nextDistance = getPointerDistance(activePointers);
      const gesture = pinchGestureRef.current;
      const viewportCenter = getViewportPoint(viewport, nextCenter.x, nextCenter.y);
      const panDelta = {
        x: nextCenter.x - gesture.center.x,
        y: nextCenter.y - gesture.center.y,
      };
      const nextScale =
        gesture.transform.scale * (gesture.distance > 0 ? nextDistance / gesture.distance : 1);
      const zoomed = zoomDiagramAtPoint(gesture.transform, viewportCenter, nextScale);
      setTransform(panDiagram(zoomed, panDelta));
      return;
    }

    if (dragOriginRef.current) {
      const point = getViewportPoint(viewport, event.clientX, event.clientY);
      setTransform(
        panDiagram(dragOriginRef.current.transform, {
          x: point.x - dragOriginRef.current.point.x,
          y: point.y - dragOriginRef.current.point.y,
        }),
      );
    }
  }, []);

  const handlePointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    activePointersRef.current.delete(event.pointerId);
    dragOriginRef.current = null;
    pinchGestureRef.current = null;
  }, []);

  const transformStyle = useMemo(
    () => ({
      transform: `translate(${transform.translateX}px, ${transform.translateY}px) scale(${transform.scale})`,
    }),
    [transform],
  );

  const zoomPercent = Math.round(transform.scale * 100);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[100dvh] max-h-[100dvh] w-screen max-w-none grid-rows-none flex-col gap-0 rounded-2xl border-0 p-0 sm:h-[86vh] sm:max-h-[86vh] sm:w-[90vw] sm:border sm:border-popover-border"
        ref={dialogContentRef}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">
          {intl.formatMessage({ id: "codeBlock.mermaid.previewDescription" })}
        </DialogDescription>
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-border border-b px-3">
          <div className="min-w-0 truncate text-ui-base font-medium text-foreground">{title}</div>
          <div className="flex shrink-0 items-center gap-1">
            <PreviewButton
              label={intl.formatMessage({ id: "codeBlock.mermaid.zoomOut" })}
              onClick={() => zoomBy(0.85)}
            >
              <CircleMinusIcon className="size-3.5" />
            </PreviewButton>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label={intl.formatMessage({ id: "codeBlock.mermaid.zoomLevel" })}
                  className="min-w-14 gap-1 px-1.5 font-mono text-foreground-subtle"
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <span>{zoomPercent}%</span>
                  <ChevronDownIcon className="size-3 text-foreground-subtlest" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center" className="min-w-36">
                {zoomScaleOptions.map((scale) => {
                  const percent = Math.round(scale * 100);
                  return (
                    <DropdownMenuItem key={percent} onSelect={() => zoomToScale(scale)}>
                      {intl.formatMessage(
                        { id: "codeBlock.mermaid.zoomToPercent" },
                        { percent: String(percent) },
                      )}
                    </DropdownMenuItem>
                  );
                })}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={fitToViewport}>
                  {intl.formatMessage({ id: "codeBlock.mermaid.zoomToFit" })}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={reset}>
                  {intl.formatMessage({ id: "codeBlock.mermaid.resetZoom" })}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <PreviewButton
              label={intl.formatMessage({ id: "codeBlock.mermaid.zoomIn" })}
              onClick={() => zoomBy(1.18)}
            >
              <CirclePlusIcon className="size-3.5" />
            </PreviewButton>
            <PreviewButton
              label={intl.formatMessage({ id: "codeBlock.mermaid.close" })}
              onClick={() => onOpenChange(false)}
            >
              <XIcon className="size-3.5" />
            </PreviewButton>
          </div>
        </div>
        <div
          ref={viewportRef}
          className={cn(
            "relative min-h-0 flex-1 touch-none overflow-hidden bg-popover",
            "cursor-grab active:cursor-grabbing",
          )}
          onPointerCancel={handlePointerEnd}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onWheel={handleWheel}
        >
          <div
            ref={contentRef}
            aria-label={title}
            className="absolute top-0 left-0 origin-top-left select-none [&_svg]:block [&_svg]:h-auto [&_svg]:max-w-none"
            dangerouslySetInnerHTML={{ __html: svg }}
            role="img"
            style={transformStyle}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PreviewButton({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <ControlHintTooltip title={label} side="bottom">
      <Button aria-label={label} onClick={onClick} size="icon-md" type="button" variant="ghost">
        {children}
      </Button>
    </ControlHintTooltip>
  );
}
