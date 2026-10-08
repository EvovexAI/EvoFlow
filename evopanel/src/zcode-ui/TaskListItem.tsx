/* eslint-disable max-lines -- task item 同时承载默认列表和 timeline 两行布局的共享交互，先保持动作链路集中避免归档/置顶回归。 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Clock,
  CloudUpload,
  ListTree,
  LoaderIcon,
  Moon,
  Pin,
  Smartphone,
} from "lucide-react";
import { isCronTask, isOffPeakTask, type ZCodeTaskMeta } from "@zcode/shared";
import { TID_TASK_ARCHIVE, TID_TASK_ITEM, testId } from "@zcode/shared";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { getPathLeaf } from "@/lib/path.js";
import { formatTaskTitleWithChanges, getTaskChangeSummary } from "@/lib/taskChangeSummary.js";
import {
  deriveTaskLeadingIndicator,
  formatTaskRelativeTime,
} from "@/lib/taskListItemPresentation.js";
import { getTaskListAttention, getTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { TaskListItemContextMenu } from "@/TaskListItemContextMenu.js";
import { TaskInteractionBadge } from "@/TaskInteractionBadge.js";
import { useTaskListItemContextActions } from "@/useTaskListItemContextActions.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { useModelTrajectoryStore } from "@/store/modelTrajectoryStore.js";
import { buildTaskFeedbackDescription } from "@/lib/taskFeedbackDraft.js";
import { toast } from "@/components/ui/toast.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { useV4SplitPaneEntry } from "@/v4/splitPaneEntryContext.js";
import { buildWorkbenchSessionKey, useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";
import { useTaskInteractionAutoResolutionSnooze } from "@/hooks/useTaskInteractionAutoResolutionSnooze.js";
import {
  WORKBENCH_SESSION_DRAG_MIME,
  clearActiveWorkbenchSessionDragPayload,
  serializeWorkbenchSessionDragPayload,
  setActiveWorkbenchSessionDragPayload,
} from "@/v4/workbenchDragDrop.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceReadOnly } from "@/store/tabStore.js";
import { TaskTitleOverflowText } from "@/components/TaskTitleOverflowText.js";
import { createTaskWorkbenchDragPreview } from "@/lib/taskWorkbenchDragPreview.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { TaskRowActionButton } from "@/workspace-grouped-tasks/task-row-action-button.js";
import { TaskWorkflowRunLines } from "@/components/workflow-run-line/TaskWorkflowRunLines.js";

type TaskListItemIntl = {
  formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
};

interface TaskListItemProps {
  workspacePath: string;
  remoteSessionId?: string;
  task: ZCodeTaskMeta;
  isPinned: boolean;
  isActive: boolean;
  isMobileActive?: boolean;
  onSelectTask: (taskId: string) => void;
  onArchiveTaskInline: (e: React.MouseEvent, taskId: string) => void;
  onCancelArchiveConfirm: () => void;
  isArchiveConfirming: boolean;
  onTogglePinTask: (taskId: string, pinned: boolean) => void;
  onStartRenameTask: (taskId: string, currentTitle: string) => void;
  onArchiveTask: (taskId: string) => void;
  onMarkTaskAsUnread: (taskId: string) => void;
  onOpenTaskContextMenu?: (taskId: string) => void;
  onOpenFileTree?: (task: ZCodeTaskMeta) => void;
  variant?: "default" | "timeline";
  showPinAction?: boolean;
  intl: TaskListItemIntl;
  actionsDisabled?: boolean;
  actionsDisabledReason?: string;
}

function areJsonFieldsEqual(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function getTaskAutomationIdentity(task: ZCodeTaskMeta): string | undefined {
  return task.cronAutomationId ?? (task as ZCodeTaskMeta & { automationId?: string }).automationId;
}

function areTaskListItemTaskFieldsEqual(left: ZCodeTaskMeta, right: ZCodeTaskMeta) {
  if (left === right) {
    return true;
  }

  return (
    left.taskId === right.taskId &&
    left.workspacePath === right.workspacePath &&
    left.workspaceIdentity === right.workspaceIdentity &&
    left.provider === right.provider &&
    left.title === right.title &&
    left.forkedFromTaskId === right.forkedFromTaskId &&
    left.updatedAt === right.updatedAt &&
    left.unreadAt === right.unreadAt &&
    getTaskAutomationIdentity(left) === getTaskAutomationIdentity(right) &&
    left.status === right.status &&
    areJsonFieldsEqual(left.pendingInteraction, right.pendingInteraction) &&
    areJsonFieldsEqual(getTaskListRowActivity(left), getTaskListRowActivity(right)) &&
    areJsonFieldsEqual(left.changeSummary, right.changeSummary)
  );
}

function areTaskListItemPropsEqual(left: TaskListItemProps, right: TaskListItemProps) {
  return (
    left.workspacePath === right.workspacePath &&
    left.remoteSessionId === right.remoteSessionId &&
    areTaskListItemTaskFieldsEqual(left.task, right.task) &&
    left.isPinned === right.isPinned &&
    left.isActive === right.isActive &&
    left.isMobileActive === right.isMobileActive &&
    left.isArchiveConfirming === right.isArchiveConfirming &&
    left.variant === right.variant &&
    left.showPinAction === right.showPinAction &&
    left.intl === right.intl &&
    left.actionsDisabled === right.actionsDisabled &&
    left.actionsDisabledReason === right.actionsDisabledReason &&
    left.onSelectTask === right.onSelectTask &&
    left.onArchiveTaskInline === right.onArchiveTaskInline &&
    left.onCancelArchiveConfirm === right.onCancelArchiveConfirm &&
    left.onTogglePinTask === right.onTogglePinTask &&
    left.onStartRenameTask === right.onStartRenameTask &&
    left.onArchiveTask === right.onArchiveTask &&
    left.onMarkTaskAsUnread === right.onMarkTaskAsUnread &&
    left.onOpenTaskContextMenu === right.onOpenTaskContextMenu &&
    left.onOpenFileTree === right.onOpenFileTree
  );
}

export const MemoTaskItem = memo(function TaskListItem({
  workspacePath,
  remoteSessionId,
  task,
  isPinned,
  isActive,
  isMobileActive = false,
  onSelectTask,
  onArchiveTaskInline,
  onCancelArchiveConfirm,
  isArchiveConfirming,
  onTogglePinTask,
  onOpenTaskContextMenu,
  onOpenFileTree,
  variant = "default",
  showPinAction = true,
  intl,
  actionsDisabled = false,
  actionsDisabledReason,
}: TaskListItemProps) {
  const [hoverActionsVisible, setHoverActionsVisible] = useState(false);
  const [focusActionsVisible, setFocusActionsVisible] = useState(false);
  const [isHoverNone] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: none)").matches,
  );
  const itemRef = useRef<HTMLLIElement | null>(null);
  const workspaceActionsDisabled = useOptionalTabStore(
    (state) =>
      actionsDisabled || isWorkspaceReadOnly(state, task.workspacePath, task.workspaceIdentity),
  );
  const workspaceActionsDisabledReason = workspaceActionsDisabled
    ? (actionsDisabledReason ??
      intl.formatMessage({ id: "workspaceSidebar.unavailableLocalDirectory" }))
    : undefined;
  const snoozeInteractionAutoResolution = useTaskInteractionAutoResolutionSnooze({
    workspacePath,
    ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
    sessionId: task.taskId,
  });

  useEffect(() => {
    if (!isArchiveConfirming) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancelArchiveConfirm();
      }
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && itemRef.current?.contains(target)) {
        return;
      }
      onCancelArchiveConfirm();
    }

    // 全局时间线和置顶列表的确认 key 含 workspacePath，Windows
    // 反斜杠拼进 CSS selector 后会被当作转义，确认按钮因此被误判为条目外点击。
    // 确认项直接使用自身 ref 判断事件边界，避免业务 key 与 CSS 语法耦合。
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [isArchiveConfirming, onCancelArchiveConfirm]);

  const splitPaneEntryEnabled = useV4SplitPaneEntry().enabled;
  const taskWorkspaceScope = useMemo(
    () => ({
      workspacePath,
      ...(task.workspaceIdentity?.trim() ? { workspaceIdentity: task.workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
    }),
    [remoteSessionId, task.workspaceIdentity, workspacePath],
  );
  const taskWorkbenchSessionKey = useMemo(
    () => buildWorkbenchSessionKey(taskWorkspaceScope, task.taskId),
    [task.taskId, taskWorkspaceScope],
  );
  const isSessionInWorkbenchGroup = useWorkbenchGroupStore((state) =>
    Boolean(state.sessionIndex[taskWorkbenchSessionKey]),
  );
  const canDragToWorkbench =
    !workspaceActionsDisabled && splitPaneEntryEnabled && !isSessionInWorkbenchGroup;

  // V4 runtime/interaction 已由 sessions-index 投影，旧 Zustand map 不再接收
  // 后台会话 delta。row 直接消费随列表条目到达的 activity sidecar，避免 spinner/attention 假静止。
  const taskActivity = getTaskListRowActivity(task);
  const taskAttention = getTaskListAttention(task);
  const hasPendingInteraction = Boolean(task.pendingInteraction) || taskAttention !== null;
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
  const taskTitle =
    task.title ||
    intl.formatMessage({
      id: task.forkedFromTaskId ? "taskList.forkedUntitled" : "taskList.untitled",
    });
  const handleSelect = useCallback(() => {
    runUserAction({
      input: { featureId: "task.lifecycle", action: "open", trigger: "button" },
      operation: () => onSelectTask(task.taskId),
      completed: { resultSource: "optimistic_projection" },
      failureStage: "task_open",
    });
  }, [onSelectTask, task.taskId]);
  const handleDragStart = useCallback(
    (event: React.DragEvent<HTMLLIElement>) => {
      if (!canDragToWorkbench) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.effectAllowed = "copy";
      const payload = {
        kind: "zcode/session" as const,
        workspacePath,
        ...(task.workspaceIdentity?.trim() ? { workspaceIdentity: task.workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
        sessionId: task.taskId,
      };
      setActiveWorkbenchSessionDragPayload(payload);
      event.dataTransfer.setData(
        WORKBENCH_SESSION_DRAG_MIME,
        serializeWorkbenchSessionDragPayload(payload),
      );
      event.dataTransfer.setData("text/plain", taskTitle);
      // 浏览器默认 drag preview 背景透明、边界不清晰；保留原行内容，
      // 只补齐 Grouped drag overlay 使用的背景、边框和阴影。
      const cleanupDragPreview = createTaskWorkbenchDragPreview({
        clientX: event.clientX,
        clientY: event.clientY,
        dataTransfer: event.dataTransfer,
        source: event.currentTarget,
      });
      const ownerWindow = event.currentTarget.ownerDocument.defaultView;
      if (ownerWindow) {
        ownerWindow.requestAnimationFrame(cleanupDragPreview);
      } else {
        cleanupDragPreview();
      }
    },
    [
      canDragToWorkbench,
      remoteSessionId,
      task.taskId,
      task.workspaceIdentity,
      taskTitle,
      workspacePath,
    ],
  );
  const handleDragEnd = useCallback(() => {
    clearActiveWorkbenchSessionDragPayload();
  }, []);
  const handleContextMenu = useCallback(() => {
    onOpenTaskContextMenu?.(task.taskId);
  }, [onOpenTaskContextMenu, task.taskId]);
  const handleOpenFileTree = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (workspaceActionsDisabled) {
        return;
      }
      runUserAction({
        input: { featureId: "workbench.file", action: "open_tree", trigger: "button" },
        operation: () => onOpenFileTree?.(task),
        completed: { resultSource: "local_commit" },
        failureStage: "file_tree_open",
      });
    },
    [onOpenFileTree, task, workspaceActionsDisabled],
  );

  const handleArchive = useCallback(
    (event: React.MouseEvent) => {
      if (workspaceActionsDisabled) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      runUserAction({
        input: { featureId: "task.lifecycle", action: "archive", trigger: "button" },
        operation: () => onArchiveTaskInline(event, task.taskId),
        completed: { resultSource: "optimistic_projection" },
        failureStage: "task_archive",
      });
    },
    [onArchiveTaskInline, task.taskId, workspaceActionsDisabled],
  );
  const handleTogglePin = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (workspaceActionsDisabled) {
        return;
      }
      onTogglePinTask(task.taskId, !isPinned);
    },
    [isPinned, onTogglePinTask, task.taskId, workspaceActionsDisabled],
  );
  const handleMouseEnter = useCallback(() => {
    setHoverActionsVisible(true);
  }, []);
  const handleMouseLeave = useCallback(() => {
    setHoverActionsVisible(false);
    // 归档二次确认依赖用户第二次点击确认；鼠标离开 row 时清理 hover 展示即可。
    // 如果同步取消确认，用户移动鼠标稍微离开任务行后确认按钮会消失，导致二次确认无法稳定完成。
  }, []);

  const leadingIndicator = useMemo(
    () => deriveTaskLeadingIndicator(task, taskActivity),
    [task, taskActivity],
  );
  const isTaskCron = isCronTask(task);
  // 月亮身份改为持久 meta 标记判断；off-peak store 反查在任务被删除后会丢失
  // 会话溯源，且让每一行多背一个全局 store 订阅。
  const isTaskOffPeak = isOffPeakTask(task);
  const showTimelineIdleIndicator =
    variant === "timeline" && leadingIndicator === "none" && !isPinned;
  // 手机远控标记和置顶状态共用左侧 leading 槽。
  // 已置顶任务如果继续常显 Pin，会和绝对定位的手机图标重叠；手机激活态默认让手机图标优先，hover 时再显示 Pin 操作。
  const showPinnedState = isPinned && leadingIndicator === "none" && !isMobileActive;
  const shouldMountWorkspaceTaskActions = hoverActionsVisible || focusActionsVisible || isHoverNone;
  // hover:none 只代表触屏端需要常驻 action，不代表应永久隐藏时间、状态和变更摘要。
  // 元信息仅在真实 hover / focus 交互时让位，保持旧触屏布局的“元信息 + action”语义。
  const shouldSuppressWorkspaceTaskMetadata = hoverActionsVisible || focusActionsVisible;
  const taskTimeLabel = formatTaskRelativeTime(task.updatedAt, intl);
  const taskChangeSummary = getTaskChangeSummary(task);
  const isRemoteTask = Boolean(task.workspaceIdentity?.trim());
  const archiveLabel = intl.formatMessage({
    id: isArchiveConfirming ? "common.confirm" : "taskList.archive",
  });
  const taskTitleWithChanges = formatTaskTitleWithChanges(taskTitle, taskChangeSummary, intl);
  const workspaceLabel = getPathLeaf(task.workspacePath);
  const taskItemKey = `${buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity)}:${task.taskId}`;
  // 工作流运行行：标题下的第二条通道，
  // 与前置 16px 槽（error > unread > spinner）互不占位。只在会话带 run 摘要时挂组件。
  const hasWorkflowRunLines = taskActivity?.workflowActivity !== undefined;
  const workflowRunLinesNode = hasWorkflowRunLines ? (
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
  const changeSummaryNode =
    !hasPendingInteraction && taskChangeSummary ? (
      <span className="shrink-0 text-ui-base">
        {taskChangeSummary.added > 0 ? (
          <span className="text-diff-added">+{taskChangeSummary.added}</span>
        ) : null}
        {taskChangeSummary.removed > 0 ? (
          <span className="ml-1 text-diff-removed">-{taskChangeSummary.removed}</span>
        ) : null}
      </span>
    ) : null;
  const shouldRenderArchiveAction =
    !workspaceActionsDisabled &&
    !hasPendingInteraction &&
    (shouldMountWorkspaceTaskActions || isArchiveConfirming);
  const archiveActionVisibilityClassName = isArchiveConfirming ? "flex" : "flex";
  const archiveActionNode = shouldRenderArchiveAction ? (
    /* 交互调整：任务进入“等待归档确认”后，右侧 hover 区不再显示归档按钮。
       否则一个 item 同时出现“待确认状态”和“可归档操作”，视觉重心会互相打架。 */
    <div className={cn("items-center gap-0.5", archiveActionVisibilityClassName)}>
      {isArchiveConfirming ? (
        <ControlHintTooltip title={archiveLabel} side="top" align="center">
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={handleArchive}
            data-testid={testId(TID_TASK_ARCHIVE, task.taskId)}
            // 归档确认态是显式等待用户决策的状态，必须持续显示 destructive 按钮。
            className={cn("shrink-0 border-destructive/20 px-2", archiveActionVisibilityClassName)}
            aria-label={archiveLabel}
          >
            <span>{intl.formatMessage({ id: "common.confirm" })}</span>
          </Button>
        </ControlHintTooltip>
      ) : (
        // Project / Pinned 的普通归档按钮曾覆盖 hover:bg-background/90，
        // 与同一行文件树 action 不一致；普通态统一复用共享 bg-hover action。
        <TaskRowActionButton
          label={archiveLabel}
          onClick={handleArchive}
          showTooltip
          testId={testId(TID_TASK_ARCHIVE, task.taskId)}
        >
          {isRemoteTask ? (
            // 本地和远端 task 混排时，统一 archive 图标无法提示操作会落在哪个 sqlite。
            // 远端任务使用 cloud 语义图标，避免用户误把远端归档当成本地归档。
            <CloudUpload className="h-3.5 w-3.5" />
          ) : (
            <Archive className="h-3.5 w-3.5" />
          )}
        </TaskRowActionButton>
      )}
    </div>
  ) : null;
  // 远端 task 的 session 未就绪时 resolver 会拒绝打开；渲染层同步隐藏入口，
  // 避免展示一个点击后无反馈的按钮。本地 task 不依赖已打开 tab，仍可直接按路径打开。
  const canOpenFileTree =
    Boolean(onOpenFileTree) && (!task.workspaceIdentity?.trim() || Boolean(remoteSessionId));
  const fileTreeActionNode =
    canOpenFileTree &&
    !workspaceActionsDisabled &&
    !hasPendingInteraction &&
    (shouldMountWorkspaceTaskActions || isMobileActive) ? (
      <span className="inline-flex shrink-0">
        {/* Pinned 文件树按钮曾手写 hover 背景和 tooltip，导致与 Grouped task
            的同一操作视觉不一致。直接复用共享 action，统一 bg-hover、尺寸和 pointer 行为。 */}
        <TaskRowActionButton
          label={intl.formatMessage({ id: "git.action.showTree" })}
          onClick={handleOpenFileTree}
          showTooltip
        >
          <ListTree className="size-3.5" />
        </TaskRowActionButton>
      </span>
    ) : null;
  const taskActionGroupNode =
    fileTreeActionNode || archiveActionNode ? (
      <span data-task-row-actions="true" className="flex shrink-0 items-center gap-0.5">
        {fileTreeActionNode}
        {archiveActionNode}
      </span>
    ) : null;
  const pinActionButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      disabled={workspaceActionsDisabled}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={handleTogglePin}
      className="inline-flex size-4 min-w-0 rounded-sm p-0 text-foreground-subtle !bg-transparent hover:text-foreground"
      aria-label={intl.formatMessage({
        id: isPinned ? "taskList.unpin" : "taskList.pin",
      })}
    >
      <Pin className="size-4" />
    </Button>
  );
  // hover:none 只让右侧 task actions 常驻；如果也用它接管 leading 槽，
  // 触屏端的错误、未读和 loading 状态会被 Pin 永久替换。
  const shouldRenderPinAction =
    showPinAction && (showPinnedState || shouldSuppressWorkspaceTaskMetadata);
  return (
    <li
      ref={itemRef}
      data-testid={testId(TID_TASK_ITEM, task.taskId)}
      data-task-item-key={taskItemKey}
      data-mobile-active-task={isMobileActive ? "true" : undefined}
      data-archive-confirming-task-id={isArchiveConfirming ? task.taskId : undefined}
      onClick={handleSelect}
      onContextMenu={handleContextMenu}
      draggable={canDragToWorkbench}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocusCapture={() => setFocusActionsVisible(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocusActionsVisible(false);
        }
      }}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handleSelect();
        }
      }}
      className={cn(
        "group/task-item flex cursor-pointer gap-2 rounded-lg pl-2.5 pr-1 py-1 transition-[background-color,border-color,box-shadow]",
        // 默认行 32px 时前置槽整行居中；长出工作流运行行后行体是两行的纵向列，槽改为对齐首行。
        variant === "timeline"
          ? "items-start py-1.5"
          : hasWorkflowRunLines
            ? "items-start"
            : "items-center",
        isActive ? "bg-selected" : "hover:bg-surface-hover",
      )}
    >
      {/* 之前任务列表依赖 divide-y 画分隔线，深色侧栏里每个 item 上下都会出现明显黑线，
              视觉上像被两条边框夹住。这里改成“列表留白 + item 自己带圆角态”，
              让 hover/active 的层级由卡片背景承担，不再依赖分隔线。 */}

      <div
        className={cn(
          "relative flex size-4 shrink-0 items-center justify-center",
          // 行体是纵向列（标题行 + 运行行）时前置槽对齐首行而不是整行：默认 24px 首行居中 = 上留 4px。
          variant === "timeline" ? "mt-0.5" : hasWorkflowRunLines ? "mt-1" : undefined,
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "flex size-4 items-center justify-center transition-opacity",
            shouldRenderPinAction && "hidden",
            isMobileActive && "invisible",
          )}
        >
          {leadingIndicator === "error" ? (
            <span data-error-indicator="true" className="h-1.5 w-1.5 rounded-full bg-destructive" />
          ) : leadingIndicator === "unread" ? (
            <span
              data-unread-indicator="true"
              className="h-1.5 w-1.5 rounded-full bg-sky-500 dark:bg-sky-400"
            />
          ) : leadingIndicator === "loading" ? (
            <LoaderIcon className="size-4 animate-spin text-foreground-subtle" />
          ) : showTimelineIdleIndicator ? (
            <span data-idle-indicator="true" className="h-1.5 w-1.5 rounded-full bg-border" />
          ) : null}
        </span>
        {shouldRenderPinAction ? (
          <ControlHintTooltip
            title={
              workspaceActionsDisabledReason ??
              intl.formatMessage({
                id: isPinned ? "taskList.unpin" : "taskList.pin",
              })
            }
            side="top"
            align="center"
          >
            {pinActionButton}
          </ControlHintTooltip>
        ) : null}
      </div>

      {variant === "timeline" ? (
        <div className="relative flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            {isMobileActive && !shouldSuppressWorkspaceTaskMetadata ? (
              <ControlHintTooltip
                title={intl.formatMessage({ id: "taskList.mobileActive" })}
                side="right"
                align="center"
                triggerClassName="absolute -left-6 top-2 z-10 -translate-y-1/2"
              >
                <span
                  data-mobile-active-task="true"
                  className="inline-flex size-4 items-center justify-center rounded-sm text-success"
                  aria-label={intl.formatMessage({
                    id: "taskList.mobileActive",
                  })}
                >
                  <Smartphone className="size-3.5" />
                </span>
              </ControlHintTooltip>
            ) : null}
            <TaskTitleOverflowText
              className="text-ui-base text-foreground"
              title={taskTitleWithChanges}
            >
              {/* workspace/timeline task 标题之前使用 truncate，会在长标题末尾显示省略号；
                      grouped task 已改为右侧渐隐。这里统一 task 列表标题溢出策略，避免同一侧栏里出现两种截断语义。 */}
              {taskTitle}
            </TaskTitleOverflowText>
            {task.pendingInteraction ? (
              <TaskInteractionBadge
                interaction={task.pendingInteraction}
                formatMessage={(id) => intl.formatMessage({ id })}
                onSnoozeCountdown={snoozeInteractionAutoResolution}
              />
            ) : taskAttentionDisplay ? (
              <Badge className="h-5 shrink-0 border-transparent bg-success/14 px-2 text-ui-base font-medium text-success dark:bg-success/18">
                {taskAttentionDisplay}
              </Badge>
            ) : null}
          </div>
          <div className="flex min-w-0 items-center justify-between gap-2 text-ui-base text-foreground-subtle h-6">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate">{workspaceLabel}</span>
            </div>
            <div className="ml-auto flex shrink-0 items-center justify-end gap-1.5">
              {!hasPendingInteraction ? (
                <span
                  data-task-row-metadata="true"
                  className={cn(
                    "flex items-center gap-1.5",
                    isArchiveConfirming || shouldSuppressWorkspaceTaskMetadata
                      ? "hidden"
                      : undefined,
                  )}
                >
                  {changeSummaryNode}
                  {changeSummaryNode ? (
                    <span aria-hidden="true" className="shrink-0 text-foreground-subtlest">
                      ·
                    </span>
                  ) : null}
                  {isTaskCron ? (
                    // 定时任务 icon 不能占用左侧状态槽；未读、运行中、置顶 hover 都会接管那里。
                    // 放在时间前面，和 grouped task row 的元信息位置一致，状态变化时也不会丢。
                    <Clock
                      data-cron-task-icon="true"
                      aria-label={intl.formatMessage({
                        id: "taskList.cronTaskLabel",
                      })}
                      className="size-3.5 shrink-0"
                    />
                  ) : isTaskOffPeak ? (
                    <Moon
                      data-off-peak-task-icon="true"
                      aria-label={intl.formatMessage({ id: "taskList.offPeakTaskLabel" })}
                      className="size-3.5 shrink-0"
                    />
                  ) : null}
                  <span className="mr-1">{taskTimeLabel}</span>
                </span>
              ) : null}
              {taskActionGroupNode}
            </div>
          </div>
          {workflowRunLinesNode}
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            <div className="relative min-w-0 flex h-6 flex-1 flex-wrap items-center gap-1.5">
              {isMobileActive && !shouldSuppressWorkspaceTaskMetadata ? (
                <ControlHintTooltip
                  title={intl.formatMessage({ id: "taskList.mobileActive" })}
                  side="right"
                  align="center"
                  triggerClassName="absolute -left-6 top-1/2 z-10 -translate-y-1/2"
                >
                  <span
                    data-mobile-active-task="true"
                    className="inline-flex size-4 items-center justify-center rounded-sm text-success"
                    aria-label={intl.formatMessage({
                      id: "taskList.mobileActive",
                    })}
                  >
                    {/* mobileViewState 已经能告诉桌面端手机正在看的 task，
                        但列表未消费这个状态，用户会误以为只有桌面端在操作。上一版把图标作为标题前的 flex 子项，
                        会把当前行标题往右挤，造成上下 task 标题不对齐；这里改成绝对定位到原有 leading 槽，
                        标题文本仍从既有位置开始；同时 hover 时隐藏手机标记，把置顶按钮还给用户。 */}
                    <Smartphone className="size-3.5" />
                  </span>
                </ControlHintTooltip>
              ) : null}
              <TaskTitleOverflowText
                className="text-ui-base text-foreground"
                title={taskTitleWithChanges}
              >
                {/* 默认 workspace task item 和 timeline item 共享标题溢出规则；
                        使用 mask 渐隐而不是省略号，和 grouped task row 保持一致。 */}
                {taskTitle}
              </TaskTitleOverflowText>
              {changeSummaryNode ? (
                <span
                  className={cn(
                    isArchiveConfirming || shouldSuppressWorkspaceTaskMetadata
                      ? "hidden"
                      : undefined,
                  )}
                >
                  {changeSummaryNode}
                </span>
              ) : null}
              {task.pendingInteraction ? (
                <TaskInteractionBadge
                  interaction={task.pendingInteraction}
                  formatMessage={(id) => intl.formatMessage({ id })}
                  onSnoozeCountdown={snoozeInteractionAutoResolution}
                />
              ) : taskAttentionDisplay ? (
                <Badge className="h-5 shrink-0 border-transparent bg-success/14 px-2 text-ui-sm font-medium text-success dark:bg-success/18">
                  {taskAttentionDisplay}
                </Badge>
              ) : null}
            </div>

            {!hasPendingInteraction ? (
              // 交互胶囊已经占用右侧状态位；继续显示相对时间会和“等待确认”并排挤压标题。
              <span
                data-task-row-metadata="true"
                className={cn(
                  "mr-0.5 flex shrink-0 items-center gap-1 text-ui-sm text-foreground-subtle",
                  isArchiveConfirming || shouldSuppressWorkspaceTaskMetadata ? "hidden" : undefined,
                )}
              >
                {isTaskCron ? (
                  // 定时任务 icon 归属时间元信息，而不是左侧状态位；否则 unread/loading 会把 icon 顶掉。
                  <Clock
                    data-cron-task-icon="true"
                    aria-label={intl.formatMessage({
                      id: "taskList.cronTaskLabel",
                    })}
                    className="size-3.5 shrink-0"
                  />
                ) : isTaskOffPeak ? (
                  <Moon
                    data-off-peak-task-icon="true"
                    aria-label={intl.formatMessage({ id: "taskList.offPeakTaskLabel" })}
                    className="size-3.5 shrink-0"
                  />
                ) : null}
                {taskTimeLabel}
              </span>
            ) : null}

            {taskActionGroupNode}
          </div>
          {workflowRunLinesNode}
        </div>
      )}
    </li>
  );
}, areTaskListItemPropsEqual);

MemoTaskItem.displayName = "MemoTaskItem";

export function TaskListItemContextMenuContent({
  workspacePath,
  remoteSessionId,
  task,
  isPinned,
  intl,
  onTogglePinTask,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  disableTaskActions = false,
  disabledReason,
}: {
  workspacePath: string;
  remoteSessionId?: string;
  task: ZCodeTaskMeta;
  isPinned: boolean;
  intl: TaskListItemIntl;
  onTogglePinTask: (taskId: string, pinned: boolean) => void;
  onStartRenameTask: (taskId: string, currentTitle: string) => void;
  onArchiveTask: (taskId: string) => void;
  onMarkTaskAsUnread: (taskId: string) => void;
  disableTaskActions?: boolean;
  disabledReason?: string;
}) {
  const workspaceActionsDisabled = useOptionalTabStore(
    (state) =>
      disableTaskActions || isWorkspaceReadOnly(state, task.workspacePath, task.workspaceIdentity),
  );
  const workspaceActionsDisabledReason = workspaceActionsDisabled
    ? (disabledReason ?? intl.formatMessage({ id: "workspaceSidebar.unavailableLocalDirectory" }))
    : undefined;
  // 收尾：「在分屏打开」仅桌面 shell（context 由 WorkspaceShellLayout 提供；
  // 手机远控/无 Provider 环境默认 false → 菜单项整体不渲染）。
  const splitPaneEntry = useV4SplitPaneEntry();
  const splitPaneEntryEnabled = splitPaneEntry.enabled;
  const splitPaneTarget = useMemo(
    () => ({
      workspacePath,
      ...(task.workspaceIdentity?.trim() ? { workspaceIdentity: task.workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
      sessionId: task.taskId,
    }),
    [remoteSessionId, task.taskId, task.workspaceIdentity, workspacePath],
  );
  // 当前 focused session、已有 group 与 pane 上限统一由 shell owner 裁决；row 不再直接写 layout store。
  const canOpenInSplitPane = splitPaneEntry.canOpenSession(splitPaneTarget);
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const {
    taskSessionFile,
    taskNativeSessionLogFile,
    fileManagerLabel,
    handleCopyText,
    handleOpenTaskPathInFileManager,
  } = useTaskListItemContextActions({
    workspacePath,
    remoteSessionId,
    workspaceIdentity: task.workspaceIdentity,
    taskId: task.taskId,
    provider: task.provider,
    intl,
    // row 级菜单已收敛为列表级单例，只有菜单真正打开时才挂载此组件。
    // 因此路径探测和 provider 配置探测可以直接随打开态运行，避免每个 idle row 订阅和计算。
    loadTaskPaths: true,
  });
  const taskTitle =
    task.title ||
    intl.formatMessage({
      id: task.forkedFromTaskId ? "taskList.forkedUntitled" : "taskList.untitled",
    });

  const handleOpenTaskFeedback = useCallback(async () => {
    // 任务右键菜单之前只能复制日志/路径，反馈时缺少任务上下文。
    // 这里复用反馈中心 draft，只预填脱敏后的任务线索，附件由用户主动选择。
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
        workspacePath,
        taskSessionPath: taskSessionFile.path,
        taskLogPath: taskNativeSessionLogFile.path,
        formatMessage: (id: string, values?: Record<string, string>) =>
          intl.formatMessage({ id }, values),
      }),
      screenshots: [],
    });
    toast(intl.formatMessage({ id: "taskList.feedbackOpened" }));
  }, [
    intl,
    openFeedbackSubmit,
    task.taskId,
    taskNativeSessionLogFile.path,
    taskSessionFile.path,
    taskTitle,
    workspacePath,
  ]);

  return (
    <TaskListItemContextMenu
      intl={intl}
      isPinned={isPinned}
      fileManagerLabel={fileManagerLabel}
      taskSessionFile={taskSessionFile}
      activeSessionId={task.taskId}
      taskNativeSessionLogFile={taskNativeSessionLogFile}
      disableTaskActions={workspaceActionsDisabled}
      disabledReason={workspaceActionsDisabledReason}
      onTogglePinTask={() => {
        onTogglePinTask(task.taskId, !isPinned);
      }}
      onStartRenameTask={() => {
        onStartRenameTask(task.taskId, task.title);
      }}
      onArchiveTask={() => {
        onArchiveTask(task.taskId);
      }}
      onMarkTaskAsUnread={() => {
        onMarkTaskAsUnread(task.taskId);
      }}
      onOpenInSplitPane={
        splitPaneEntryEnabled
          ? () => {
              // 旧入口直接写 paneLayout，绕过 active group 与 shell navigation，
              // draft split 后下一次普通点击会把 session 灌进 primary。统一交给 shell controller。
              splitPaneEntry.openSession(splitPaneTarget);
            }
          : undefined
      }
      openInSplitPaneDisabled={workspaceActionsDisabled || !canOpenInSplitPane}
      onOpenTaskFeedback={() => {
        void handleOpenTaskFeedback();
      }}
      onOpenTaskPathInFileManager={() => {
        void handleOpenTaskPathInFileManager();
      }}
      onCopyWorkspacePath={() => {
        void handleCopyText(intl.formatMessage({ id: "appHeader.copyPath" }), workspacePath);
      }}
      onCopyTaskPath={() => {
        void handleCopyText(
          intl.formatMessage({ id: "appHeader.copyTaskPath" }),
          taskSessionFile.path,
        );
      }}
      onCopyTaskLogPath={() => {
        void handleCopyText(
          intl.formatMessage({ id: "appHeader.copyLogPath" }),
          taskNativeSessionLogFile.path,
        );
      }}
      onCopySessionId={() => {
        void handleCopyText(intl.formatMessage({ id: "appHeader.copySessionId" }), task.taskId);
      }}
      onViewModelTrajectory={() => {
        // 通过单例 store 把“打开轨迹”请求交给所属 workspace 的侧边栏控制器（useAppPanels）。
        useModelTrajectoryStore.getState().requestOpen({
          taskId: task.taskId,
          workspaceKey: task.workspaceIdentity?.trim() || workspacePath,
          title: taskTitle,
        });
      }}
    />
  );
}
