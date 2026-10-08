import type {
  PresentationElementBounds,
  PresentationElementNodeType,
  PresentationPageElement,
} from "@/presentation/types.js";

interface PresentationElementCellInput {
  gridSpan: number;
  rowSpan: number;
  hMerge: boolean;
  vMerge: boolean;
  text?: string;
}

interface PresentationElementRowInput {
  height: number;
  cells: readonly PresentationElementCellInput[];
}

interface PresentationElementNodeInput {
  id: string;
  name: string;
  nodeType: "shape" | "picture" | "table" | "group" | "chart" | "unknown";
  position: { x: number; y: number };
  size: { w: number; h: number };
  text?: string;
  columns?: readonly number[];
  rows?: readonly PresentationElementRowInput[];
}

interface PresentationGroupTextEntryInput {
  nodeId: string;
  nodePath: string;
  text: string;
  bounds: { x: number; y: number; w: number; h: number };
}

function toBounds(node: PresentationElementNodeInput): PresentationElementBounds {
  return {
    x: node.position.x,
    y: node.position.y,
    width: node.size.w,
    height: node.size.h,
  };
}

function sum(values: readonly number[]) {
  return values.reduce((total, value) => total + Math.max(0, value), 0);
}

function buildTableCellElements(
  node: PresentationElementNodeInput,
  base: Omit<PresentationPageElement, "bounds" | "nodeType">,
): PresentationPageElement[] {
  if (!node.columns || !node.rows || node.columns.length === 0 || node.rows.length === 0) {
    return [];
  }
  const columnTotal = sum(node.columns);
  const rowTotal = sum(node.rows.map((row) => row.height));
  if (columnTotal <= 0 || rowTotal <= 0) {
    return [];
  }

  const columnOffsets = node.columns.map((_, index) => sum(node.columns?.slice(0, index) ?? []));
  const rowOffsets = node.rows.map((_, index) =>
    sum(node.rows?.slice(0, index).map((row) => row.height) ?? []),
  );

  return node.rows.flatMap((row, rowIndex) => {
    let columnIndex = 0;
    return row.cells.flatMap((cell, cellIndex) => {
      const gridSpan = Math.max(1, cell.gridSpan || 1);
      if (cell.hMerge || cell.vMerge) {
        // 原因：pptx-renderer 对纵向 merge continuation 仍推进 gridSpan，横向
        // continuation 则不推进；直接使用物理 cellIndex 会把后续 overlay 左移。
        if (cell.vMerge && !cell.hMerge) {
          columnIndex += gridSpan;
        }
        return [];
      }
      const startColumnIndex = columnIndex;
      columnIndex += gridSpan;
      const rowSpan = Math.max(1, cell.rowSpan || 1);
      const cellWidth = sum(
        node.columns?.slice(startColumnIndex, startColumnIndex + gridSpan) ?? [],
      );
      const cellHeight = sum(
        node.rows?.slice(rowIndex, rowIndex + rowSpan).map((item) => item.height) ?? [],
      );
      return [
        {
          ...base,
          nodeType: "table-cell" as const,
          rowIndex,
          cellIndex,
          text: cell.text,
          bounds: {
            x:
              node.position.x +
              ((columnOffsets[startColumnIndex] ?? 0) / columnTotal) * node.size.w,
            y: node.position.y + ((rowOffsets[rowIndex] ?? 0) / rowTotal) * node.size.h,
            width: (cellWidth / columnTotal) * node.size.w,
            height: (cellHeight / rowTotal) * node.size.h,
          },
        },
      ];
    });
  });
}

export function buildPresentationPageElements(options: {
  slideIndex: number;
  slidePart: string;
  nodes: readonly PresentationElementNodeInput[];
  groupTextEntries: readonly PresentationGroupTextEntryInput[];
}): PresentationPageElement[] {
  const directElements = options.nodes.flatMap((node, zIndex) => {
    if (node.nodeType === "group" || node.nodeType === "unknown") {
      return [];
    }
    const nodeType = node.nodeType as Exclude<PresentationElementNodeType, "table-cell">;
    const base = {
      slideIndex: options.slideIndex,
      slidePart: options.slidePart,
      nodeId: node.id,
      nodeName: node.name,
      nodeType,
      bounds: toBounds(node),
      zIndex,
      ...(node.text ? { text: node.text } : {}),
    } satisfies PresentationPageElement;
    return node.nodeType === "table" ? [base, ...buildTableCellElements(node, base)] : [base];
  });

  const directIds = new Set(
    options.nodes.filter((node) => node.nodeType !== "group").map((node) => node.id),
  );
  const groupTextElements = options.groupTextEntries.flatMap((entry) => {
    if (directIds.has(entry.nodeId)) {
      return [];
    }
    const pathSegments = entry.nodePath.split("/");
    const nodesSegmentIndex = pathSegments.indexOf("nodes");
    // buildTextIndex 的真实路径是 slides/{slide}/nodes/{groupId}/children/...；
    // 兼容旧测试/调用方的首段 groupId，避免所有组内文本都错误落到 zIndex 0。
    const groupId =
      (nodesSegmentIndex >= 0 ? pathSegments[nodesSegmentIndex + 1] : undefined) ?? pathSegments[0];
    const zIndex = Math.max(
      0,
      options.nodes.findIndex((node) => node.nodeType === "group" && node.id === groupId),
    );
    return [
      {
        slideIndex: options.slideIndex,
        slidePart: options.slidePart,
        nodeId: entry.nodeId,
        nodePath: entry.nodePath,
        nodeName: "",
        nodeType: "shape" as const,
        text: entry.text,
        bounds: {
          x: entry.bounds.x,
          y: entry.bounds.y,
          width: entry.bounds.w,
          height: entry.bounds.h,
        },
        zIndex,
      },
    ];
  });

  return [...directElements, ...groupTextElements];
}

function containsPoint(bounds: PresentationElementBounds, point: { x: number; y: number }) {
  return (
    point.x >= bounds.x &&
    point.y >= bounds.y &&
    point.x <= bounds.x + bounds.width &&
    point.y <= bounds.y + bounds.height
  );
}

export function hitTestPresentationElement(
  elements: readonly PresentationPageElement[],
  point: { x: number; y: number },
): PresentationPageElement | null {
  const matches = elements.filter((element) => containsPoint(element.bounds, point));
  return (
    matches.sort((left, right) => {
      const cellPriority =
        Number(right.nodeType === "table-cell") - Number(left.nodeType === "table-cell");
      return cellPriority || right.zIndex - left.zIndex;
    })[0] ?? null
  );
}
