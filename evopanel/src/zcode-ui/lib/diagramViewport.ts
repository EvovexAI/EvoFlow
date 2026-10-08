export type DiagramPoint = {
  x: number;
  y: number;
};

export type DiagramViewportTransform = {
  scale: number;
  translateX: number;
  translateY: number;
};

export type DiagramViewportBounds = {
  height: number;
  width: number;
  x?: number;
  y?: number;
};

const MIN_DIAGRAM_SCALE = 0.25;
const MAX_DIAGRAM_SCALE = 4;

function clampDiagramScale(scale: number): number {
  if (!Number.isFinite(scale)) {
    return 1;
  }

  return Math.min(MAX_DIAGRAM_SCALE, Math.max(MIN_DIAGRAM_SCALE, scale));
}

export function zoomDiagramAtPoint(
  transform: DiagramViewportTransform,
  viewportPoint: DiagramPoint,
  nextScale: number,
): DiagramViewportTransform {
  const safeCurrentScale = clampDiagramScale(transform.scale);
  const safeNextScale = clampDiagramScale(nextScale);
  const diagramX = (viewportPoint.x - transform.translateX) / safeCurrentScale;
  const diagramY = (viewportPoint.y - transform.translateY) / safeCurrentScale;

  return {
    scale: safeNextScale,
    translateX: viewportPoint.x - diagramX * safeNextScale,
    translateY: viewportPoint.y - diagramY * safeNextScale,
  };
}

export function panDiagram(
  transform: DiagramViewportTransform,
  delta: DiagramPoint,
): DiagramViewportTransform {
  return {
    ...transform,
    translateX: transform.translateX + delta.x,
    translateY: transform.translateY + delta.y,
  };
}

export function fitDiagramToViewport({
  diagramX = 0,
  diagramY = 0,
  diagramHeight,
  diagramWidth,
  padding = 32,
  viewportHeight,
  viewportWidth,
}: {
  diagramHeight: number;
  diagramWidth: number;
  diagramX?: number;
  diagramY?: number;
  padding?: number;
  viewportHeight: number;
  viewportWidth: number;
}): DiagramViewportTransform {
  if (diagramWidth <= 0 || diagramHeight <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
    return { scale: 1, translateX: 0, translateY: 0 };
  }

  const availableWidth = Math.max(1, viewportWidth - padding * 2);
  const availableHeight = Math.max(1, viewportHeight - padding * 2);
  const scale = clampDiagramScale(
    Math.min(availableWidth / diagramWidth, availableHeight / diagramHeight),
  );

  return {
    scale,
    translateX: (viewportWidth - diagramWidth * scale) / 2 - diagramX * scale,
    translateY: (viewportHeight - diagramHeight * scale) / 2 - diagramY * scale,
  };
}
