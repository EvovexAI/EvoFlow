import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu.js";
import { TaskGroupColorDot } from "@/workspace-grouped-tasks/colors.js";
import type { TaskGroupMenuItem } from "@/workspace-grouped-tasks/types.js";

export function GroupedTaskContextMenuContent({
  task,
  currentGroupId,
  groups,
  intl,
  fileManagerLabel,
  taskSessionFile,
  taskNativeSessionLogFile,
  onMoveTaskToGroup,
  onMoveTaskToTop,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  onOpenTaskPathInFileManager,
  onCopyText,
  onOpenTaskFeedback,
  disabledReason,
}: {
  task: ZCodeTaskMeta;
  currentGroupId?: string;
  groups: TaskGroupMenuItem[];
  intl: {
    formatMessage: (desc: { id: string }) => string;
  };
  fileManagerLabel: string;
  taskSessionFile: { loading: boolean; path: string | null };
  taskNativeSessionLogFile: { loading: boolean; path: string | null };
  onMoveTaskToGroup: (task: ZCodeTaskMeta, groupId: string | null) => void;
  onMoveTaskToTop: (task: ZCodeTaskMeta) => void;
  onStartRenameTask: (task: ZCodeTaskMeta) => void;
  onArchiveTask: (task: ZCodeTaskMeta) => void;
  onMarkTaskAsUnread: (task: ZCodeTaskMeta) => void;
  onOpenTaskPathInFileManager: () => void;
  onCopyText: (label: string, text: string | null) => void;
  onOpenTaskFeedback: () => void;
  disabledReason?: string;
}) {
  return (
    <ContextMenuContent className="w-56">
      <ContextMenuSub>
        <ContextMenuSubTrigger disabled={Boolean(disabledReason)} title={disabledReason}>
          {intl.formatMessage({ id: "taskGroup.moveToGroup" })}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-52">
          <ContextMenuItem
            disabled={Boolean(disabledReason) || !currentGroupId}
            title={disabledReason}
            onSelect={() => {
              if (!disabledReason) {
                onMoveTaskToGroup(task, null);
              }
            }}
          >
            {intl.formatMessage({ id: "taskGroup.removeFromGroup" })}
          </ContextMenuItem>
          <ContextMenuSeparator />
          {groups.map((group) => (
            <ContextMenuItem
              key={group.id}
              disabled={Boolean(disabledReason) || group.id === currentGroupId}
              title={disabledReason}
              onSelect={() => {
                if (!disabledReason) {
                  onMoveTaskToGroup(task, group.id);
                }
              }}
            >
              <TaskGroupColorDot color={group.color} />
              <span className="truncate">{group.title}</span>
            </ContextMenuItem>
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuItem
        disabled={Boolean(disabledReason)}
        title={disabledReason}
        onSelect={() => {
          if (!disabledReason) {
            onMoveTaskToTop(task);
          }
        }}
      >
        {intl.formatMessage({ id: "taskGroup.moveToTop" })}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        disabled={Boolean(disabledReason)}
        title={disabledReason}
        onSelect={() => {
          if (!disabledReason) {
            onStartRenameTask(task);
          }
        }}
      >
        {intl.formatMessage({ id: "taskList.rename" })}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={Boolean(disabledReason)}
        title={disabledReason}
        onSelect={() => {
          if (!disabledReason) {
            onArchiveTask(task);
          }
        }}
      >
        {intl.formatMessage({ id: "taskList.archive" })}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={Boolean(disabledReason)}
        title={disabledReason}
        onSelect={() => {
          if (!disabledReason) {
            onMarkTaskAsUnread(task);
          }
        }}
      >
        {intl.formatMessage({ id: "taskList.markAsUnread" })}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        disabled={Boolean(disabledReason)}
        title={disabledReason}
        onSelect={() => {
          if (!disabledReason) {
            onOpenTaskPathInFileManager();
          }
        }}
      >
        {fileManagerLabel}
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() =>
          onCopyText(intl.formatMessage({ id: "appHeader.copyPath" }), task.workspacePath)
        }
      >
        {intl.formatMessage({ id: "appHeader.copyPath" })}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={taskSessionFile.loading || !taskSessionFile.path}
        onSelect={() =>
          onCopyText(intl.formatMessage({ id: "appHeader.copyTaskPath" }), taskSessionFile.path)
        }
      >
        {intl.formatMessage({ id: "appHeader.copyTaskPath" })}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={taskNativeSessionLogFile.loading || !taskNativeSessionLogFile.path}
        onSelect={() =>
          onCopyText(
            intl.formatMessage({ id: "appHeader.copyLogPath" }),
            taskNativeSessionLogFile.path,
          )
        }
      >
        {intl.formatMessage({ id: "appHeader.copyLogPath" })}
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() =>
          onCopyText(intl.formatMessage({ id: "appHeader.copySessionId" }), task.taskId)
        }
      >
        {intl.formatMessage({ id: "appHeader.copySessionId" })}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={onOpenTaskFeedback}>
        {intl.formatMessage({ id: "taskList.feedback" })}
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
