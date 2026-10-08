import { memo } from "react";
import { useDroppable } from "@dnd-kit/core";
import type { UniqueIdentifier } from "@dnd-kit/core";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { MessageCirclePlus } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { GroupedTaskRow } from "@/workspace-grouped-tasks/task-row.js";
import type { TaskGroupMenuItem } from "@/workspace-grouped-tasks/shared.js";

export function EmptyGroupDropZone({
  groupId,
  onCreateTask,
}: {
  groupId: string;
  onCreateTask: () => void;
}) {
  const { intl } = useZCodeIntl();
  const droppable = useDroppable({
    id: `group-empty-drop:${groupId}`,
    data: {
      type: "grouped-empty-drop-zone",
      groupId,
    },
  });
  return (
    <button
      ref={droppable.setNodeRef}
      type="button"
      data-grouped-empty-drop-zone-id={groupId}
      className={cn(
        "flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-2 py-2 text-center text-ui-base text-foreground-subtle transition-[background-color,border-color,color] duration-150 ease-out motion-reduce:transition-none",
        "hover:border-border-hover hover:bg-surface-hover hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused",
      )}
      onClick={(event) => {
        event.stopPropagation();
        onCreateTask();
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
    >
      <MessageCirclePlus aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0">{intl.formatMessage({ id: "taskGroup.emptyDropZoneAction" })}</span>
    </button>
  );
}

function GroupedTaskItemComponent({
  task,
  groupId,
  groups,
  remoteSessionId,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  activeTaskId,
  workspaceLabel,
  onSelectTask,
  onCloseTask,
  onOpenFileTree,
  onMoveTaskToGroup,
  onMoveTaskToTop,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  dragId,
  dragging,
  dragOverlay,
  tooltipsDisabled,
}: {
  task: ZCodeTaskMeta;
  groupId?: string;
  groups: TaskGroupMenuItem[];
  remoteSessionId?: string;
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  workspaceLabel: string;
  onSelectTask: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;
  onCloseTask: (task: ZCodeTaskMeta) => void;
  onOpenFileTree?: (task: ZCodeTaskMeta) => void;
  onMoveTaskToGroup: (task: ZCodeTaskMeta, groupId: string | null) => void;
  onMoveTaskToTop: (task: ZCodeTaskMeta) => void;
  onStartRenameTask: (task: ZCodeTaskMeta) => void;
  onArchiveTask: (task: ZCodeTaskMeta) => void;
  onMarkTaskAsUnread: (task: ZCodeTaskMeta) => void;
  dragId?: UniqueIdentifier;
  dragging?: boolean;
  dragOverlay?: boolean;
  tooltipsDisabled?: boolean;
}) {
  return (
    <div className={cn("rounded-lg border border-transparent py-px")}>
      <GroupedTaskRow
        task={task}
        currentGroupId={groupId}
        groups={groups}
        remoteSessionId={remoteSessionId}
        activeWorkspacePath={activeWorkspacePath}
        activeWorkspaceIdentity={activeWorkspaceIdentity}
        activeTaskId={activeTaskId}
        workspaceLabel={workspaceLabel}
        onSelectTask={onSelectTask}
        onCloseTask={onCloseTask}
        onOpenFileTree={onOpenFileTree}
        onMoveTaskToGroup={onMoveTaskToGroup}
        onMoveTaskToTop={onMoveTaskToTop}
        onStartRenameTask={onStartRenameTask}
        onArchiveTask={onArchiveTask}
        onMarkTaskAsUnread={onMarkTaskAsUnread}
        dragId={dragId}
        dragging={dragging}
        dragOverlay={dragOverlay}
        tooltipsDisabled={tooltipsDisabled}
      />
    </div>
  );
}

export const GroupedTaskItem = memo(GroupedTaskItemComponent);
