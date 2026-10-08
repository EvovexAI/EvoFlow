import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ZCodeGroupedTaskViewNode } from "@zcode/services";
import { taskKey } from "@/workspace-grouped-tasks/ids.js";
import {
  isPotentialVerticalScrollContainer,
  scrollGroupedTaskVirtualizerToOffset,
} from "@/workspace-grouped-tasks/virtualized-scroll.js";

const GROUPED_TOP_LEVEL_TASK_ROW_ESTIMATE_PX = 32;
const GROUPED_TOP_LEVEL_GROUP_HEADER_ESTIMATE_PX = 40;
const GROUPED_TOP_LEVEL_VIRTUALIZATION_THRESHOLD = 80;
const GROUPED_TOP_LEVEL_VIRTUALIZATION_OVERSCAN = 12;

function shouldVirtualizeGroupedTopLevelNodes(nodeCount: number): boolean {
  return nodeCount > GROUPED_TOP_LEVEL_VIRTUALIZATION_THRESHOLD;
}

function getTopLevelNodeKey(node: ZCodeGroupedTaskViewNode | undefined, index: number): string {
  if (!node) {
    return `missing:${index}`;
  }
  return node.type === "group" ? `group:${node.group.id}` : `task:${taskKey(node.task)}`;
}

function estimateTopLevelNodeSize(
  node: ZCodeGroupedTaskViewNode | undefined,
  isGroupCollapsed: (groupId: string) => boolean,
): number {
  if (!node || node.type === "task") {
    return GROUPED_TOP_LEVEL_TASK_ROW_ESTIMATE_PX;
  }
  if (isGroupCollapsed(node.group.id)) {
    return GROUPED_TOP_LEVEL_GROUP_HEADER_ESTIMATE_PX;
  }
  return (
    GROUPED_TOP_LEVEL_GROUP_HEADER_ESTIMATE_PX +
    Math.min(node.tasks.length, 24) * GROUPED_TOP_LEVEL_TASK_ROW_ESTIMATE_PX
  );
}

function findNearestScrollableAncestor(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    if (isPotentialVerticalScrollContainer(style.overflowY)) {
      // 折叠/展开时顶层行高度会先变、滚动高度后变；只认“当前已可滚”
      // 会让虚拟器在过渡帧丢失 scrollElement，展开后出现 header 有状态但内容空白。
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function resolveScrollMargin(listElement: HTMLElement, scrollElement: HTMLElement): number {
  return (
    listElement.getBoundingClientRect().top -
    scrollElement.getBoundingClientRect().top +
    scrollElement.scrollTop
  );
}

function VirtualizedGroupedTopLevelList({
  nodes,
  isGroupCollapsed,
  renderNode,
}: {
  nodes: ZCodeGroupedTaskViewNode[];
  isGroupCollapsed: (groupId: string) => boolean;
  renderNode: (node: ZCodeGroupedTaskViewNode, index: number) => ReactNode;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const shouldVirtualize = shouldVirtualizeGroupedTopLevelNodes(nodes.length);
  const getItemKey = useCallback(
    (index: number) => getTopLevelNodeKey(nodes[index], index),
    [nodes],
  );
  const estimateSize = useCallback(
    (index: number) => estimateTopLevelNodeSize(nodes[index], isGroupCollapsed),
    [isGroupCollapsed, nodes],
  );

  const updateScrollMargin = useCallback(() => {
    const listElement = listRef.current;
    if (!listElement) {
      return;
    }
    const nextScrollElement = findNearestScrollableAncestor(listElement);
    setScrollElement(nextScrollElement);
    if (!nextScrollElement) {
      setScrollMargin(0);
      return;
    }
    setScrollMargin(resolveScrollMargin(listElement, nextScrollElement));
  }, []);
  const resolveInitialScrollOffset = useCallback(() => {
    const listElement = listRef.current;
    const currentScrollElement =
      scrollElement ?? (listElement ? findNearestScrollableAncestor(listElement) : null);
    return currentScrollElement?.scrollTop ?? 0;
  }, [scrollElement]);

  useLayoutEffect(() => {
    if (!shouldVirtualize) {
      setScrollElement(null);
      setScrollMargin(0);
      return undefined;
    }
    updateScrollMargin();
    const listElement = listRef.current;
    const resizeObserver =
      typeof ResizeObserver === "undefined" || !listElement
        ? null
        : new ResizeObserver(updateScrollMargin);
    if (listElement) {
      resizeObserver?.observe(listElement);
    }
    const animationFrame = window.requestAnimationFrame(updateScrollMargin);
    window.addEventListener("resize", updateScrollMargin);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", updateScrollMargin);
      resizeObserver?.disconnect();
    };
  }, [nodes.length, shouldVirtualize, updateScrollMargin]);

  const rowVirtualizer = useVirtualizer({
    count: shouldVirtualize ? nodes.length : 0,
    getScrollElement: () => scrollElement,
    estimateSize,
    getItemKey,
    overscan: GROUPED_TOP_LEVEL_VIRTUALIZATION_OVERSCAN,
    scrollMargin,
    scrollToFn: scrollGroupedTaskVirtualizerToOffset,
    // 虚拟器可能在共享滚动容器已经滚动后重新绑定 scrollElement。
    // react-virtual 默认 initialOffset 是 0，初次绑定时会主动 scrollTo(0)，
    // 造成左侧任务列表滚动中偶发回顶；这里从 DOM 现场反查真实 scrollTop，
    // 避免首个 layout effect 里 scrollElement state 尚未写回时提前缓存 0。
    initialOffset: resolveInitialScrollOffset,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();

  const renderedVirtualNodes = useMemo(
    () =>
      virtualRows.map((virtualRow) => {
        const node = nodes[virtualRow.index];
        if (!node) {
          return null;
        }
        return (
          <div
            key={virtualRow.key}
            ref={rowVirtualizer.measureElement}
            className="absolute left-0 top-0 w-full"
            data-index={virtualRow.index}
            style={{
              transform: `translateY(${virtualRow.start - scrollMargin}px)`,
            }}
          >
            {renderNode(node, virtualRow.index)}
          </div>
        );
      }),
    [nodes, renderNode, rowVirtualizer.measureElement, scrollMargin, virtualRows],
  );

  if (!shouldVirtualize) {
    return <>{nodes.map((node, index) => renderNode(node, index))}</>;
  }

  return (
    <div
      ref={listRef}
      className="relative w-full"
      style={{
        height: `${rowVirtualizer.getTotalSize()}px`,
        overflowAnchor: "none",
      }}
    >
      {/* 非 group 顶层 task 也可能有 2000+ 条；以前只虚拟化 group 内任务，
          顶层 view.nodes 仍一次性挂载全部行。这里保留 dnd-kit 的真实 index，
          但只渲染滚动窗口附近节点，降低初次渲染和滚动 CPU。 */}
      {/* 虚拟行会在滚动中频繁挂载/卸载，Chrome 的 scroll anchoring 偶尔会
          把这些绝对定位节点选为锚点并反向修正 scrollTop，表现成列表突然回顶。
          这里禁用虚拟列表子树的锚点选择，滚动位置只由用户滚轮和虚拟器控制。 */}
      {renderedVirtualNodes}
    </div>
  );
}

export {
  GROUPED_TOP_LEVEL_VIRTUALIZATION_THRESHOLD,
  VirtualizedGroupedTopLevelList,
  shouldVirtualizeGroupedTopLevelNodes,
};
