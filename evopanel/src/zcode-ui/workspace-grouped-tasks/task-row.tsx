/* eslint-disable max-lines -- grouped row 同时承载 drag overlay 与常规交互，状态徽标需共用同一渲染语义。 */
import { memo, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { UniqueIdentifier } from "@dnd-kit/core";
import { isCronTask, isOffPeakTask, type ZCodeTaskMeta } from "@zcode/shared";
import { ArrowUpToLine, Clock, Cloud, Folder, ListTree, LoaderIcon, Moon, X } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Badge } from "@/components/ui/badge.js";
import { toast } from "@/components/ui/toast.js";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  deriveTaskLeadingIndicator,
  formatTaskRelativeTime,
} from "@/lib/taskListItemPresentation.js";
import { getTaskChangeSummary } from "@/lib/taskChangeSummary.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { buildTaskFeedbackDescription } from "@/lib/taskFeedbackDraft.js";
import { useTaskListItemContextActions } from "@/useTaskListItemContextActions.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { getTaskListAttention, getTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { GroupedTaskContextMenuContent } from "@/workspace-grouped-tasks/task-context-menu-content.js";
import { TaskRowActionButton } from "@/workspace-grouped-tasks/task-row-action-button.js";
import { TaskInteractionBadge } from "@/TaskInteractionBadge.js";
import { formatGroupedTaskHoverChangeParts } from "@/workspace-grouped-tasks/task-row-tooltip.js";
import {
  TASK_GROUP_ROW_CLASS,
  TASK_GROUP_ROW_LINE_CLASS,
  type TaskGroupMenuItem,
} from "@/workspace-grouped-tasks/types.js";
import { TaskWorkflowRunLines } from "@/components/workflow-run-line/TaskWorkflowRunLines.js";
import { useTaskInteractionAutoResolutionSnooze } from "@/hooks/useTaskInteractionAutoResolutionSnooze.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceReadOnly } from "@/store/tabStore.js";
import { TaskTitleOverflowText } from "@/components/TaskTitleOverflowText.js";

function GroupedTaskRowComponent({
  task,
  currentGroupId,
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
  currentGroupId?: string;
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
  const { intl } = useZCodeIntl();
  const workspaceActionsDisabled = useOptionalTabStore((state) =>
    isWorkspaceReadOnly(state, task.workspacePath, task.workspaceIdentity),
  );
  const workspaceActionsDisabledReason = workspaceActionsDisabled
    ? intl.formatMessage({ id: "workspaceSidebar.unavailableLocalDirectory" })
    : undefined;
  const snoozeInteractionAutoResolution = useTaskInteractionAutoResolutionSnooze({
    workspacePath: task.workspacePath,
    ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
    sessionId: task.taskId,
  });
  const workspaceKey = buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity);
  const taskActivity = getTaskListRowActivity(task);
  const taskAttention = getTaskListAttention(task);
  // 交互胶囊是当前最高优先级的右侧状态；无论来自 sessions-index 摘要还是
  // activity attention，都不应再并排显示相对时间并挤压任务标题。
  const hasPendingInteraction = Boolean(task.pendingInteraction) || taskAttention !== null;
  // 远端 session 未就绪时打开文件树必然会被 resolver 拒绝，因此不要暴露
  // 无效 action；本地 task 不需要 remoteSessionId，仍保持入口可用。
  const canOpenFileTree =
    Boolean(onOpenFileTree) && (!task.workspaceIdentity?.trim() || Boolean(remoteSessionId));
  const taskAttentionLabel = taskAttention
    ? intl.formatMessage({
        id: taskAttention.kind === "userInput" ? "taskList.userInputTag" : "taskList.permissionTag",
      })
    : null;
  const taskAttentionDisplay =
    taskAttention && taskAttentionLabel && taskAttention.count > 1
      ? intl.formatMessage(
          { id: "taskList.attentionCount" },
          { label: taskAttentionLabel, count: String(taskAttention.count) },
        )
      : taskAttentionLabel;
  const leadingIndicator = deriveTaskLeadingIndicator(task, taskActivity);
  const taskTitle =
    task.title ||
    intl.formatMessage({
      id: task.forkedFromTaskId ? "taskList.forkedUntitled" : "taskList.untitled",
    });
  const taskChangeParts = formatGroupedTaskHoverChangeParts(getTaskChangeSummary(task));
  const taskTimeLabel = formatTaskRelativeTime(task.updatedAt, intl);
  const isTaskCron = isCronTask(task);
  // 月亮身份改为持久 meta 标记判断；off-peak store 反查在任务被删除后会丢失
  // 会话溯源，且让每一行多背一个全局 store 订阅。
  const isTaskOffPeak = isOffPeakTask(task);
  const isActive =
    buildTaskWorkspaceKey(activeWorkspacePath, activeWorkspaceIdentity) === workspaceKey &&
    activeTaskId === task.taskId;
  const isMobileActive = false;
  const statusDotClassName =
    leadingIndicator === "error"
      ? "bg-destructive"
      : leadingIndicator === "unread"
        ? // grouped task 未读点需要和普通 task list 共用 sky 色，避免 brand 色在不同主题下表达漂移。
          "bg-sky-500 dark:bg-sky-400"
        : null;
  const canShowHoverActions = !dragOverlay;
  // 工作流运行行：分组行同样长在标题下；
  // drag overlay 只是纯展示，不挂确认副作用与点击入口。
  const workflowRunLinesNode =
    taskActivity?.workflowActivity && !dragOverlay ? (
      <TaskWorkflowRunLines
        activity={taskActivity.workflowActivity}
        isActive={isActive}
        intl={intl}
        session={{
          workspacePath: task.workspacePath,
          ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
          sessionId: task.taskId,
        }}
      />
    ) : null;

  const taskRow = (
    <div
      role={dragOverlay ? undefined : "button"}
      tabIndex={dragOverlay ? undefined : 0}
      data-mobile-active-task={!dragOverlay && isMobileActive ? "true" : undefined}
      className={cn(
        "group/task-row",
        TASK_GROUP_ROW_CLASS,
        dragOverlay
          ? "pointer-events-none cursor-grabbing border border-border bg-background shadow-lg opacity-100"
          : "cursor-pointer",
        isActive ? "bg-selected" : canShowHoverActions && "hover:bg-surface-hover",
        dragging && "opacity-0",
      )}
    >
      <span className={TASK_GROUP_ROW_LINE_CLASS}>
        <TaskTitleOverflowText
          as="span"
          className="text-foreground"
          title={dragOverlay ? undefined : taskTitle}
        >
          {/* grouped task 标题超出时不要显示省略号，右侧渐隐能保留标题连续性，避免和右侧状态元信息挤在一起。*/}
          {taskTitle}
        </TaskTitleOverflowText>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-ui-sm text-foreground-subtle">
          {task.pendingInteraction ? (
            <TaskInteractionBadge
              interaction={task.pendingInteraction}
              formatMessage={(id) => intl.formatMessage({ id })}
              onSnoozeCountdown={dragOverlay ? undefined : snoozeInteractionAutoResolution}
            />
          ) : taskAttentionDisplay ? (
            <Badge
              className={cn(
                "h-5 border-transparent bg-success/14 px-2 text-ui-base font-medium text-success dark:bg-success/18",
                canShowHoverActions && "group-hover/task-row:hidden",
              )}
            >
              {taskAttentionDisplay}
            </Badge>
          ) : null}
          <span
            className={cn(
              "flex shrink-0 items-center gap-1",
              canShowHoverActions && "group-hover/task-row:hidden",
            )}
          >
            {leadingIndicator === "loading" ? (
              <LoaderIcon className="size-3.5 animate-spin text-foreground-subtle" />
            ) : statusDotClassName ? (
              <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
                <span className={cn("size-1.5 rounded-full", statusDotClassName)} />
              </span>
            ) : null}
            {!hasPendingInteraction && isTaskCron ? (
              // drag overlay 也复用 grouped row 元信息；clock 放时间前面，不能跟未读点互斥。
              <Clock
                data-cron-task-icon="true"
                aria-label={intl.formatMessage({ id: "taskList.cronTaskLabel" })}
                className="size-3.5 shrink-0"
              />
            ) : !hasPendingInteraction && isTaskOffPeak ? (
              <Moon
                data-off-peak-task-icon="true"
                aria-label={intl.formatMessage({ id: "taskList.offPeakTaskLabel" })}
                className="size-3.5 shrink-0"
              />
            ) : null}
            {!hasPendingInteraction ? <span className="mr-1">{taskTimeLabel}</span> : null}
          </span>
        </span>
      </span>
    </div>
  );

  // DragOverlay 高频渲染时只返回纯展示节点，避免隐藏 action tooltip 的 Radix ref 循环和 task 路径 RPC。
  if (dragOverlay) return taskRow;

  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [taskRowHovered, setTaskRowHovered] = useState(false);
  const [taskRowFocusWithin, setTaskRowFocusWithin] = useState(false);
  const [isHoverNone] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: none)").matches,
  );
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const {
    taskSessionFile,
    taskNativeSessionLogFile,
    fileManagerLabel,
    handleCopyText,
    handleOpenTaskPathInFileManager,
  } = useTaskListItemContextActions({
    workspacePath: task.workspacePath,
    remoteSessionId,
    workspaceIdentity: task.workspaceIdentity,
    taskId: task.taskId,
    provider: task.provider,
    intl,
    loadTaskPaths: contextMenuOpen,
  });
  const handleSelect = () => {
    onSelectTask(task.workspacePath, task.taskId, task.workspaceIdentity);
  };
  const handleCloseTask = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (workspaceActionsDisabled) {
      return;
    }
    onCloseTask(task);
  };
  const handleOpenFileTree = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (workspaceActionsDisabled) {
      return;
    }
    onOpenFileTree?.(task);
  };
  const handleMoveTaskToTop = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (workspaceActionsDisabled) {
      return;
    }
    onMoveTaskToTop(task);
  };
  const handleOpenTaskFeedback = async () => {
    openFeedbackSubmit({
      title: intl
        .formatMessage(
          { id: "feedback.submit.template.section.taskFeedbackTitle" },
          { title: taskTitle },
        )
        .slice(0, 80),
      type: "bug",
      module: "Agent任务执行失败",
      severity: "P2-中",
      includeLogs: false,
      description: buildTaskFeedbackDescription({
        taskTitle,
        taskId: task.taskId,
        workspacePath: task.workspacePath,
        taskSessionPath: taskSessionFile.path,
        taskLogPath: taskNativeSessionLogFile.path,
        formatMessage: (id: string, values?: Record<string, string>) =>
          intl.formatMessage({ id }, values),
      }),
      screenshots: [],
    });
    toast(intl.formatMessage({ id: "taskList.feedbackOpened" }));
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    handleSelect();
  };
  const dragDisabled = workspaceActionsDisabled || !dragId || contextMenuOpen || dragOverlay;
  const draggable = useDraggable({
    id: dragId ?? `disabled:${workspaceKey}:${task.taskId}`,
    disabled: dragDisabled,
    data: { type: "grouped-task", taskKey: dragId },
  });
  const droppable = useDroppable({
    id: dragId ?? `disabled-drop:${workspaceKey}:${task.taskId}`,
    disabled: workspaceActionsDisabled || !dragId || dragOverlay,
    data: { type: "grouped-task", taskKey: dragId },
  });

  const setTaskRowRef = (element: HTMLDivElement | null) => {
    draggable.setNodeRef(element);
    droppable.setNodeRef(element);
  };
  const groupedTaskDomKey = typeof dragId === "string" ? encodeURIComponent(dragId) : undefined;
  // CSS hidden → flex 会让 action trigger 在 pointer 到达时才获得布局尺寸，
  // Tooltip Portal 可能先以未定位坐标绘制。改为交互状态决定 action 是否挂载，
  // 同时保留键盘、触摸设备和手机远控 active task 的入口。
  const shouldMountHoverActions =
    !task.pendingInteraction &&
    (taskRowHovered || taskRowFocusWithin || isHoverNone || isMobileActive);
  // 触屏端 isHoverNone 只负责常驻 action；时间、状态点和 cron/off-peak 元信息
  // 仍应保留，仅在真实 hover / focus 交互时让位，避免手机端永久丢失任务状态。
  const shouldSuppressTaskMetadata = taskRowHovered || taskRowFocusWithin;

  const interactiveTaskRow = (
    <div
      ref={setTaskRowRef}
      {...draggable.attributes}
      {...draggable.listeners}
      role="button"
      tabIndex={0}
      onClick={handleSelect}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setTaskRowHovered(true)}
      onMouseLeave={() => setTaskRowHovered(false)}
      onFocusCapture={() => setTaskRowFocusWithin(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setTaskRowFocusWithin(false);
        }
      }}
      data-grouped-task-key={groupedTaskDomKey}
      data-mobile-active-task={isMobileActive ? "true" : undefined}
      className={cn(
        "group/task-row",
        TASK_GROUP_ROW_CLASS,
        "cursor-pointer",
        isActive ? "bg-selected" : "hover:bg-surface-hover",
        dragging && "opacity-0",
      )}
    >
      <span className={TASK_GROUP_ROW_LINE_CLASS}>
        <TaskTitleOverflowText as="span" className="text-foreground" title={taskTitle}>
          {/* grouped task 标题超出时不要显示省略号，右侧渐隐能保留标题连续性，避免和右侧状态元信息挤在一起。*/}
          {taskTitle}
        </TaskTitleOverflowText>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-ui-sm text-foreground-subtle">
          {task.pendingInteraction ? (
            <TaskInteractionBadge
              interaction={task.pendingInteraction}
              formatMessage={(id) => intl.formatMessage({ id })}
              onSnoozeCountdown={snoozeInteractionAutoResolution}
            />
          ) : taskAttentionDisplay && !shouldSuppressTaskMetadata ? (
            <Badge className="h-5 border-transparent bg-success/14 px-2 text-ui-base font-medium text-success dark:bg-success/18">
              {taskAttentionDisplay}
            </Badge>
          ) : null}
          {!shouldSuppressTaskMetadata ? (
            <span className="flex shrink-0 items-center gap-1">
              {leadingIndicator === "loading" ? (
                <LoaderIcon className="size-3.5 animate-spin text-foreground-subtle" />
              ) : statusDotClassName ? (
                <span
                  aria-hidden="true"
                  className="flex size-4 shrink-0 items-center justify-center"
                >
                  <span className={cn("size-1.5 rounded-full", statusDotClassName)} />
                </span>
              ) : null}
              {!hasPendingInteraction && isTaskCron ? (
                // 可交互 grouped row 之前漏渲染 clock，导致 Projects 分组里的定时任务没有 icon。
                // 这里和普通 task list 一样放在时间前面，同时不再被未读/运行状态顶掉。
                <Clock
                  data-cron-task-icon="true"
                  aria-label={intl.formatMessage({ id: "taskList.cronTaskLabel" })}
                  className="size-3.5 shrink-0"
                />
              ) : !hasPendingInteraction && isTaskOffPeak ? (
                <Moon
                  data-off-peak-task-icon="true"
                  aria-label={intl.formatMessage({ id: "taskList.offPeakTaskLabel" })}
                  className="size-3.5 shrink-0"
                />
              ) : null}
              {!hasPendingInteraction ? <span className="mr-1">{taskTimeLabel}</span> : null}
            </span>
          ) : null}
          {shouldMountHoverActions ? (
            <span className="flex shrink-0 items-center gap-0.5">
              {canOpenFileTree ? (
                <TaskRowActionButton
                  label={intl.formatMessage({ id: "git.action.showTree" })}
                  onClick={handleOpenFileTree}
                  showTooltip
                  disabledReason={workspaceActionsDisabledReason}
                >
                  <ListTree className="size-3.5" />
                </TaskRowActionButton>
              ) : null}
              <TaskRowActionButton
                label={intl.formatMessage({ id: "taskGroup.moveToTop" })}
                onClick={handleMoveTaskToTop}
                showTooltip
                disabledReason={workspaceActionsDisabledReason}
              >
                <ArrowUpToLine className="size-3.5" />
              </TaskRowActionButton>
              <TaskRowActionButton
                label={intl.formatMessage({ id: "common.close" })}
                onClick={handleCloseTask}
                showTooltip
                disabledReason={workspaceActionsDisabledReason}
              >
                <X className="size-3.5" />
              </TaskRowActionButton>
            </span>
          ) : null}
        </span>
      </span>
      {workflowRunLinesNode}
    </div>
  );

  // grouped row 不能用原生 button 承载整行；行内还有菜单、关闭、文件树等 button，外层继续用 role=button，避免嵌套 button 破坏键盘和右键菜单语义。
  return (
    <ContextMenu onOpenChange={setContextMenuOpen}>
      {tooltipsDisabled ? (
        // overlay 拖拽时指针下方的真实 row 仍可能被 Radix 识别为 hover，跳过 TooltipTrigger 避免底层 row 或 action 弹出悬浮提示。
        <ContextMenuTrigger asChild>{interactiveTaskRow}</ContextMenuTrigger>
      ) : (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <ContextMenuTrigger asChild>{interactiveTaskRow}</ContextMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="right" align="center" sideOffset={6}>
              {remoteSessionId ? (
                <Cloud aria-hidden="true" className="size-3.5 shrink-0" />
              ) : (
                <Folder aria-hidden="true" className="size-3.5 shrink-0" />
              )}
              <span className="min-w-0 max-w-48 truncate">{workspaceLabel}</span>
              {taskChangeParts.length > 0 ? (
                <>
                  <span className="text-tooltip-foreground/60">·</span>
                  <span className="inline-flex shrink-0 items-center gap-1">
                    {taskChangeParts.map((part) => (
                      <span
                        key={part}
                        className={part.startsWith("+") ? "text-diff-added" : "text-diff-removed"}
                      >
                        {part}
                      </span>
                    ))}
                  </span>
                </>
              ) : null}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {contextMenuOpen ? (
        // 右键菜单内容带 Radix Presence/Portal，拖拽重排时常驻挂载会触发嵌套更新循环；仅在菜单打开时挂载内容，配合路径懒加载避免拖拽过程刷 task path RPC。
        <GroupedTaskContextMenuContent
          task={task}
          currentGroupId={currentGroupId}
          groups={groups}
          intl={intl}
          fileManagerLabel={fileManagerLabel}
          taskSessionFile={taskSessionFile}
          taskNativeSessionLogFile={taskNativeSessionLogFile}
          onMoveTaskToGroup={onMoveTaskToGroup}
          onMoveTaskToTop={onMoveTaskToTop}
          onStartRenameTask={onStartRenameTask}
          onArchiveTask={onArchiveTask}
          onMarkTaskAsUnread={onMarkTaskAsUnread}
          onOpenTaskPathInFileManager={() => void handleOpenTaskPathInFileManager()}
          onCopyText={(label, text) => void handleCopyText(label, text)}
          onOpenTaskFeedback={() => void handleOpenTaskFeedback()}
          disabledReason={workspaceActionsDisabledReason}
        />
      ) : null}
    </ContextMenu>
  );
}
export const GroupedTaskRow = memo(GroupedTaskRowComponent);
