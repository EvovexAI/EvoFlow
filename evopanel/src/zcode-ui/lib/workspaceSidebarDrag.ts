import type { WorkspaceTabState } from "@/store/tabStore.js";
import type { SortingStrategy } from "@dnd-kit/sortable";

// 项目行展开时可能高达数百像素，但拖拽视觉只保留 h-8 项目头。
// 兄弟让位必须固定按完全收起后的 32px 计算，不能沿用 dnd-kit 缓存的展开高度。
const WORKSPACE_DRAG_COLLAPSED_ROW_HEIGHT = 32;

function resolveWorkspaceDragSiblingDisplacement(params: {
  activeIndex: number;
  index: number;
  itemGap: number;
  overIndex: number;
}): number {
  const displacement = WORKSPACE_DRAG_COLLAPSED_ROW_HEIGHT + Math.max(0, params.itemGap);
  if (params.index < params.activeIndex && params.index >= params.overIndex) {
    return displacement;
  }
  if (params.index > params.activeIndex && params.index <= params.overIndex) {
    return -displacement;
  }
  return 0;
}

function getWorkspaceDragItemGap(
  rects: Parameters<SortingStrategy>[0]["rects"],
  index: number,
  activeIndex: number,
): number {
  const currentRect = rects[index];
  if (!currentRect) {
    return 0;
  }
  if (activeIndex < index) {
    const previousRect = rects[index - 1];
    return previousRect ? currentRect.top - previousRect.bottom : 0;
  }
  const nextRect = rects[index + 1];
  return nextRect ? nextRect.top - currentRect.bottom : 0;
}

export const workspaceVerticalListSortingStrategy: SortingStrategy = ({
  activeIndex,
  activeNodeRect,
  index,
  overIndex,
  rects,
}) => {
  const activeRect = rects[activeIndex] ?? activeNodeRect;
  if (!activeRect) {
    return null;
  }

  if (index === activeIndex) {
    const overRect = rects[overIndex];
    return overRect
      ? {
          x: 0,
          y:
            activeIndex < overIndex
              ? overRect.bottom - activeRect.bottom
              : overRect.top - activeRect.top,
          scaleX: 1,
          scaleY: 1,
        }
      : null;
  }

  return {
    x: 0,
    y: resolveWorkspaceDragSiblingDisplacement({
      activeIndex,
      index,
      itemGap: getWorkspaceDragItemGap(rects, index, activeIndex),
      overIndex,
    }),
    scaleX: 1,
    scaleY: 1,
  };
};

export function resolveWorkspaceDragExpanded(params: {
  activeDragId: string | null;
  expanded: boolean;
  tabId: string;
}): boolean {
  return params.expanded && params.activeDragId !== params.tabId;
}

export function resolveWorkspaceDragGlobalIndices(params: {
  activeId: string;
  overId: string;
  projectTabs: readonly WorkspaceTabState[];
  workspaceTabs: readonly WorkspaceTabState[];
}): { fromIndex: number; toIndex: number } | null {
  const projectFromIndex = params.projectTabs.findIndex((tab) => tab.id === params.activeId);
  const projectToIndex = params.projectTabs.findIndex((tab) => tab.id === params.overId);
  if (projectFromIndex === -1 || projectToIndex === -1) {
    return null;
  }

  const fromIndex = params.workspaceTabs.findIndex((tab) => tab.id === params.activeId);
  const targetTab = params.projectTabs[projectToIndex];
  const toIndex = targetTab ? params.workspaceTabs.findIndex((tab) => tab.id === targetTab.id) : -1;
  return fromIndex === -1 || toIndex === -1 ? null : { fromIndex, toIndex };
}
