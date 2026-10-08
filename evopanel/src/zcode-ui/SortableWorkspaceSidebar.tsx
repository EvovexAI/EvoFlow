import { memo, useCallback, useMemo, type CSSProperties } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { WorkspaceSidebarItem, type SortableBindings } from "./WorkspaceSidebarItem.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";
import type { ZCodeTaskMeta } from "@zcode/shared";

export type { SortableBindings };

// 垂直拖拽容器约束已上提到 lib（Idle-time 侧栏组内拖拽需要复用且不能背上本模块的依赖链）。
export { restrictVerticalDragWithinContainer } from "@/lib/restrictVerticalDragWithinContainer.js";

export const SortableWorkspaceSidebarItem = memo(function SortableWorkspaceSidebarItem({
  tab,
  isActiveWorkspace,
  isExpanded,
  activateTab,
  closeTab,
  toggleWorkspaceExpanded,
  onSelectTask,
  onStartDraftInWorkspace,
  taskItems,
  taskListLoading,
  taskListHasMore,
  taskListHasUnread = false,
  taskListLiveWorkflowCount = 0,
  workspaceKey,
  onShowMoreWorkspaceTasks,
  reconnectingRemoteWorkspaceKeys,
  remoteWorkspaceErrorByWorkspaceKey,
  reconnectingRemoteWorkspaceLogsByWorkspaceKey,
  onReconnectRemoteWorkspace,
  onOpenFileTree,
}: {
  tab: WorkspaceTabState;
  isActiveWorkspace: boolean;
  isExpanded: boolean;
  activateTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  toggleWorkspaceExpanded: (workspacePath: string) => void;
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
  ) => void;
  onStartDraftInWorkspace: (targetWorkspacePath: string, targetWorkspaceIdentity?: string) => void;
  taskItems: ZCodeTaskMeta[];
  taskListLoading: boolean;
  taskListHasMore: boolean;
  taskListHasUnread?: boolean;
  taskListLiveWorkflowCount?: number;
  workspaceKey: string;
  onShowMoreWorkspaceTasks: (workspaceKey: string) => void;
  reconnectingRemoteWorkspaceKeys: string[];
  remoteWorkspaceErrorByWorkspaceKey: Record<string, string>;
  reconnectingRemoteWorkspaceLogsByWorkspaceKey: Record<string, RemoteConnectionLogEntry[]>;
  onReconnectRemoteWorkspace: (workspaceKey: string) => Promise<void>;
  onOpenFileTree: (target: {
    workspacePath: string;
    workspaceName: string;
    workspaceIdentity?: string;
    workspaceRemoteSessionId?: string;
  }) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
  });
  // 流式 task 事件会让父级 sidebar 高频刷新；dnd-kit 即使位移值不变，
  // 也可能给出新的 transform 对象。这里按 primitive 值派生稳定 props，避免打穿行级 memo。
  const transformString = useMemo(() => {
    if (!transform) {
      return undefined;
    }

    return CSS.Transform.toString({
      ...transform,
      // dnd-kit 在不使用 DragOverlay 时，会按当前 over 节点的 rect
      // 给 active 节点附带 scaleX/scaleY。workspace 行是可变高度容器，
      // 一旦拖到展开/收起高度不同的项目上方，活动项就会被临时压扁或拉长，
      // 看起来像“拖拽内容高度变型”。这里把 sidebar 拖拽的缩放钳回 1，
      // 只保留位移，不允许真实节点跟随目标高度缩放。
      scaleX: 1,
      scaleY: 1,
    });
  }, [transform?.x, transform?.y]);

  const style = useMemo<CSSProperties>(
    () => ({
      transform: transformString,
      transition,
      zIndex: isDragging ? 10 : undefined,
      // 真实 workspace 节点在 drag start 后会临时收起，视觉内容由
      // DragOverlay 接管；继续显示真实节点会产生两个项目头并干扰落点判断。
      opacity: isDragging ? 0 : 1,
    }),
    [isDragging, transition, transformString],
  );
  const sortableBindings = useMemo<SortableBindings>(
    () => ({ attributes, listeners }),
    [attributes, listeners],
  );
  const handleShowMoreTasks = useCallback(() => {
    onShowMoreWorkspaceTasks(workspaceKey);
  }, [onShowMoreWorkspaceTasks, workspaceKey]);

  return (
    <WorkspaceSidebarItem
      tab={tab}
      isActiveWorkspace={isActiveWorkspace}
      isExpanded={isExpanded}
      activateTab={activateTab}
      closeTab={closeTab}
      toggleWorkspaceExpanded={toggleWorkspaceExpanded}
      onSelectTask={onSelectTask}
      onStartDraftInWorkspace={onStartDraftInWorkspace}
      taskItems={taskItems}
      taskListLoading={taskListLoading}
      taskListHasMore={taskListHasMore}
      taskListHasUnread={taskListHasUnread}
      taskListLiveWorkflowCount={taskListLiveWorkflowCount}
      onShowMoreTasks={handleShowMoreTasks}
      reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
      remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
      reconnectingRemoteWorkspaceLogsByWorkspaceKey={reconnectingRemoteWorkspaceLogsByWorkspaceKey}
      onReconnectRemoteWorkspace={onReconnectRemoteWorkspace}
      onOpenFileTree={onOpenFileTree}
      itemRef={setNodeRef}
      itemStyle={style}
      sortableBindings={sortableBindings}
      isDragging={isDragging}
    />
  );
});
SortableWorkspaceSidebarItem.displayName = "SortableWorkspaceSidebarItem";
