import { WorkspaceContextPath } from "@/WorkspaceHeaderSections/WorkspaceContextPath.js";
import { WorkspaceLastActivity } from "@/WorkspaceHeaderSections/WorkspaceLastActivity.js";
/* eslint-disable max-lines -- Header 标题区当前同时承载 task 菜单、路径上下文和 workspace 级状态提示，先保持单文件收口，避免菜单链路迁移时再引入回归。 */
import {
  TID_WORKSPACE_MORE_BUTTON,
  TID_WORKSPACE_PATH,
  TID_WORKSPACE_TITLE,
  type RemoteTarget,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import { useMemo, useRef, useState } from "react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Cloud, Ellipsis, Folder, GitBranch, LoaderIcon } from "lucide-react";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { useBaseWorkspaceServices, useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useTaskListItemContextActions } from "@/useTaskListItemContextActions.js";
import { TaskActionMenuContent } from "@/TaskActionMenuContent.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatRemoteWorkspaceDisplayLabel,
  formatRemoteWorkspaceHeaderHostLabel,
} from "@/lib/remoteWorkspaceHistory.js";
import { resolveWorkspaceHeaderProvider } from "@/lib/workspaceHeaderProvider.js";
import { toast } from "@/components/ui/toast.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { useModelTrajectoryStore } from "@/store/modelTrajectoryStore.js";
import { buildTaskFeedbackDescription } from "@/lib/taskFeedbackDraft.js";
import { resolveGitBranchTriggerLabel } from "@/git-branch-switcher/display.js";
import type {
  WorkspaceHeaderState,
  WorkspaceHeaderTitleSectionProps,
} from "@/WorkspaceHeaderSections/shared.js";
import { applyTaskQueryCacheMutation } from "@/store/taskQueryCacheStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useRemotePinnedTaskStore } from "@/store/remotePinnedTaskStore.js";
import { useRemoteTimelineTaskStore } from "@/store/remoteTimelineTaskStore.js";
import { TaskRenameDialog } from "@/TaskRenameDialog.js";
import {
  RemoteSyncDialogs,
  RemoteSyncMenuItems,
  shouldShowRemoteSyncActions,
} from "@/settings/RemoteSyncActions.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { refreshSharedSkillStoreForWorkspace } from "@/lib/skillStoreRefresh.js";
import { refreshWorkspacePluginCapabilitiesAfterRemoteSync } from "@/lib/remotePluginSyncRefresh.js";
import { useMcpStore } from "@/store/mcpStore.js";

export type { WorkspaceHeaderState, WorkspaceHeaderTitleSectionProps };
export {
  WorkspaceHeaderActionSection,
  type WorkspaceHeaderActionSectionProps,
} from "@/WorkspaceHeaderSections/WorkspaceHeaderActionSection.js";

function shouldShowRemoteSkillSyncAction(params: {
  remoteSessionId?: string | null;
  remoteTarget?: RemoteTarget | null;
  clientMode?: "desktop-continuous" | "web-remote-replayable";
  hasLocalSourceService?: boolean;
}): boolean {
  return shouldShowRemoteSyncActions(params);
}

export function WorkspaceHeaderTitleSection({
  variant,
  readOnlyReason,
  workspaceAbsPath,
  remoteSessionId,
  workspaceIdentity,
  remoteTarget,
  localWorkspacePath,
  projectName,
  activeTaskTitle,
  activeTaskChangeSummary: _activeTaskChangeSummary,
  activeTaskId,
  activeTraceId: _activeTraceId,
  activeSessionId,
  activeTaskProvider,
  resolvedActiveTaskMeta,
  gitSummary,
  gitDirtyFileCount: _gitDirtyFileCount,
  sessionLogPath: _sessionLogPath,
  nativeSessionLogProvider: _nativeSessionLogProvider,
  nativeSessionLogPath: _nativeSessionLogPath,
  nativeSessionLogExists: _nativeSessionLogExists,
  nativeSessionLogLoading: _nativeSessionLogLoading,
  reloadSessionPending,
  workspaceHeaderState,
  onRefreshGit: _onRefreshGit,
  isMacDesktop: _isMacDesktop,
  isMacFullscreen: _isMacFullscreen,
  isWindowsDesktop: _isWindowsDesktop,
  selectedEditor: _selectedEditor,
  simplifyForNarrowRemote = false,
  compact = false,
}: WorkspaceHeaderTitleSectionProps) {
  const { intl } = useZCodeIntl();
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const confirmDialog = useConfirmDialog();
  const services = useWorkspaceServices(workspaceAbsPath, remoteSessionId, workspaceIdentity);
  const baseServices = useBaseWorkspaceServices();
  const removeTaskState = useZCodeSessionStore((state) => state.removeTaskState);
  const upsertOptimisticTaskListItem = useZCodeSessionStore(
    (state) => state.upsertOptimisticTaskListItem,
  );
  const removeOptimisticTaskListItem = useZCodeSessionStore(
    (state) => state.removeOptimisticTaskListItem,
  );
  const setTaskUnreadIndicator = useZCodeSessionStore((state) => state.setTaskUnreadIndicator);
  const [taskMenuOpen, setTaskMenuOpen] = useState(false);
  const [workspaceContextOpen, setWorkspaceContextOpen] = useState(false);
  const [renamingTaskId, setRenamingTaskId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [remoteSkillSyncOpen, setRemoteSkillSyncOpen] = useState(false);
  const [remoteMcpSyncOpen, setRemoteMcpSyncOpen] = useState(false);
  const [remotePluginSyncOpen, setRemotePluginSyncOpen] = useState(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const headerWorkspaceTabs = useMemo(
    () => [
      {
        id: `header-${workspaceIdentity?.trim() || workspaceAbsPath}`,
        kind: "workspace" as const,
        workspacePath: workspaceAbsPath,
        label: projectName,
        remoteSessionId,
        workspaceIdentity,
      },
    ],
    [projectName, remoteSessionId, workspaceAbsPath, workspaceIdentity],
  );
  const headerPinnedTaskList = useGlobalTaskList({
    kind: "pinned",
    // Header 常驻渲染，以前为了菜单里的 pin/unpin 文案会在启动时额外拉一份
    // pinned task 列表。只有打开更多菜单时才需要这个成员状态，延迟查询可以减少首屏
    // listTaskList 数量，并通过 useGlobalTaskList 的共享订阅复用 workspace 事件源。
    workspaceTabs: taskMenuOpen && activeTaskId ? headerWorkspaceTabs : [],
    sortBy: "updated",
    searchQuery: "",
    expanded: true,
    collapsedLimit: 20,
  });
  const pinnedTasks = headerPinnedTaskList.items;
  const activeTaskMeta = resolvedActiveTaskMeta ?? null;
  const isPinned = Boolean(
    activeTaskId && pinnedTasks.some((task) => task.taskId === activeTaskId),
  );
  const resolvedTaskActionTaskId = activeTaskMeta?.taskId ?? activeTaskId;
  // 新建任务在第一次写入数据库前没有稳定 taskId。
  // 之前 Header 更多菜单虽然点击后会被回调里的空 id guard 拦住，但 UI 仍显示为可点，
  // 用户会感知成“菜单无响应”；这里只禁用依赖已落库 task 的动作，保留 workspace 级入口。
  const disableTaskTargetActions = !resolvedTaskActionTaskId;
  const taskMenuMembershipLoading =
    taskMenuOpen && Boolean(resolvedTaskActionTaskId) && headerPinnedTaskList.loading;
  const workspaceHeaderProvider = resolveWorkspaceHeaderProvider(
    activeTaskProvider,
    workspaceHeaderState.selectedProvider,
  );
  const menuTaskProvider = activeTaskProvider ?? workspaceHeaderProvider;
  const {
    taskSessionFile,
    taskNativeSessionLogFile,
    fileManagerLabel,
    handleCopyText,
    handleOpenTaskPathInFileManager,
  } = useTaskListItemContextActions({
    workspacePath: workspaceAbsPath,
    remoteSessionId,
    workspaceIdentity,
    taskId: activeTaskId ?? "",
    // 任务日志查询与 Header 当前展示态使用同一个 provider。
    provider: menuTaskProvider,
    intl,
  });
  const remoteWorkspaceHostLabel = remoteTarget
    ? formatRemoteWorkspaceHeaderHostLabel(remoteTarget)
    : null;
  const workspaceDisplayLabel = formatRemoteWorkspaceDisplayLabel(projectName, remoteTarget);
  const showRemoteWorkspaceHostLabel = Boolean(
    remoteWorkspaceHostLabel && workspaceDisplayLabel === projectName,
  );
  const workspaceContextLabel = showRemoteWorkspaceHostLabel
    ? `${workspaceDisplayLabel} @ ${remoteWorkspaceHostLabel}`
    : workspaceDisplayLabel;
  const workspaceBranchLabel = gitSummary.isRepository
    ? resolveGitBranchTriggerLabel({
        headRefType: gitSummary.headRefType,
        currentBranchName: gitSummary.branchName,
        detachedLabel: intl.formatMessage({ id: "git.head.detached" }),
        fallbackLabel: intl.formatMessage({ id: "git.branchSwitcher.label" }),
      })
    : null;
  const isRemoteWorkspace = Boolean(
    remoteWorkspaceHostLabel || workspaceIdentity?.trim() || remoteSessionId,
  );
  const showRemoteSkillSyncAction = shouldShowRemoteSkillSyncAction({
    remoteSessionId,
    remoteTarget,
    clientMode: "desktop-continuous" as const,
    hasLocalSourceService: Boolean(
      baseServices.skillSyncService &&
      baseServices.mcpSyncService &&
      baseServices.pluginSyncService,
    ),
  });
  const workspaceActionLoading = reloadSessionPending;
  const workspaceActionLoadingTitle = intl.formatMessage({
    id: "appHeader.workspaceSessionActionLoading",
  });
  // 新任务草稿还没有稳定 task 作用域，header 再展示 workspace/分支会和空态主文案重复抢焦点。
  // 草稿态继续隐藏上下文入口；已有 task 将工作区与分支收进名称前的图标提示。
  const isDraftNewTask = variant ? variant === "draft" : activeTaskId === null;

  const handleOpenTaskFeedback = async () => {
    const taskTitle =
      activeTaskTitle ||
      intl.formatMessage({
        id: activeTaskMeta?.forkedFromTaskId ? "taskList.forkedUntitled" : "taskList.untitled",
      });
    // Header 更多菜单缺少当前任务的反馈入口，用户只能复制日志再手动新建反馈。
    // 这里打开反馈表单时预填任务标题、路径和日志线索，截图和诊断日志由用户主动选择。
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
        taskId: resolvedTaskActionTaskId ?? undefined,
        workspacePath: workspaceAbsPath,
        taskSessionPath: taskSessionFile.path,
        taskLogPath: taskNativeSessionLogFile.path,
        formatMessage: (id: string, values?: Record<string, string>) =>
          intl.formatMessage({ id }, values),
      }),
      screenshots: [],
    });
    toast(intl.formatMessage({ id: "taskList.feedbackOpened" }));
  };

  const handleStartRenameTask = () => {
    if (!resolvedTaskActionTaskId) {
      return;
    }
    setRenamingTaskId(resolvedTaskActionTaskId);
    setRenameDraft(activeTaskMeta?.title ?? activeTaskTitle ?? "");
  };

  const handleCancelRenameTask = () => {
    setRenamingTaskId(null);
    setRenameDraft("");
  };

  const buildHeaderTaskSnapshot = (
    fallbackTask: ZCodeTaskMeta,
    overrides?: Partial<ZCodeTaskMeta>,
  ): ZCodeTaskMeta => {
    if (activeTaskMeta) {
      return {
        ...activeTaskMeta,
        ...overrides,
      };
    }

    return {
      ...fallbackTask,
      title: activeTaskTitle ?? fallbackTask.title,
      ...overrides,
    };
  };

  const handleSubmitRenameTask = async () => {
    if (!renamingTaskId) {
      return;
    }

    const normalizedTitle = renameDraft.trim();
    const currentTitle = activeTaskMeta?.title ?? activeTaskTitle ?? "";
    if (normalizedTitle === currentTitle.trim()) {
      handleCancelRenameTask();
      return;
    }

    try {
      const renamedTask = await services.zcodeTaskService.renameTask({
        taskId: renamingTaskId,
        workspacePath: workspaceAbsPath,
        title: normalizedTitle,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      });
      upsertOptimisticTaskListItem(workspaceAbsPath, renamedTask, workspaceIdentity);
      if (workspaceIdentity) {
        if (isPinned) {
          useRemotePinnedTaskStore.getState().upsertTask(renamedTask);
        } else {
          useRemoteTimelineTaskStore.getState().upsertTask(renamedTask);
        }
      }
      applyTaskQueryCacheMutation({
        previousTask: buildHeaderTaskSnapshot(renamedTask, {
          title: currentTitle,
        }),
        nextTask: renamedTask,
        previousState: { pinned: isPinned, archived: false },
        nextState: { pinned: isPinned, archived: false },
      });
      handleCancelRenameTask();
    } catch {
      toast(intl.formatMessage({ id: "taskList.renameFailed" }));
    }
  };

  const handleArchiveTask = async () => {
    if (!resolvedTaskActionTaskId) {
      return;
    }

    // Header 更多菜单之前点击“归档任务”会直接执行，
    // 和 Sidebar 的二次确认心智不一致，用户容易在查看菜单时误触归档。
    // 这里统一先走现成 ConfirmDialog，再复用原有归档链路。
    const confirmed = await confirmDialog({
      title: intl.formatMessage({ id: "confirmDialog.taskArchiveTitle" }),
      description: intl.formatMessage(
        { id: "confirmDialog.taskArchiveDescription" },
        {
          taskTitle:
            activeTaskMeta?.title?.trim() ||
            activeTaskTitle?.trim() ||
            intl.formatMessage({ id: "taskList.untitled" }),
        },
      ),
      confirmLabel: intl.formatMessage({ id: "taskList.archive" }),
    });
    if (!confirmed) {
      return;
    }

    handleCancelRenameTask();
    void services.zcodeTaskService
      .archiveTask({
        taskId: resolvedTaskActionTaskId,
        workspacePath: workspaceAbsPath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      })
      .then((meta) => {
        // Header 更多菜单不能只依赖 zcodeTaskMetaMerge：归档后只有旧列表状态被更新。
        // 这里改成和 Sidebar 一样同步清理运行态与 sqlite cache，避免 Header 操作后列表不刷新。
        removeTaskState(workspaceAbsPath, resolvedTaskActionTaskId, workspaceIdentity);
        if (workspaceIdentity) {
          useRemotePinnedTaskStore
            .getState()
            .removeTask(workspaceAbsPath, resolvedTaskActionTaskId, workspaceIdentity);
          useRemoteTimelineTaskStore
            .getState()
            .removeTask(workspaceAbsPath, resolvedTaskActionTaskId, workspaceIdentity);
        }
        applyTaskQueryCacheMutation({
          previousTask: buildHeaderTaskSnapshot(meta),
          nextTask: meta,
          previousState: { pinned: isPinned, archived: false },
          nextState: { pinned: false, archived: true },
        });
      });
  };

  return (
    <div
      className={cn(
        // 标题区必须按内容占宽，不能 flex-1 铺满整条 header。
        // 父级 header 是 drag 区域；如果 no-drag 的标题区铺满剩余空间，mac/Windows 标题栏空白处会无法拖动窗口。
        "flex min-w-0 items-center gap-2 overflow-hidden [app-region:no-drag]",
        simplifyForNarrowRemote && "max-md:gap-1",
      )}
    >
      <TaskRenameDialog
        open={!isDraftNewTask && renamingTaskId !== null}
        value={renameDraft}
        inputRef={renameInputRef}
        intl={intl}
        onOpenChange={(open) => {
          if (!open) {
            handleCancelRenameTask();
          }
        }}
        onChange={setRenameDraft}
        onCancel={handleCancelRenameTask}
        onConfirm={() => {
          void handleSubmitRenameTask();
        }}
      />
      {!isDraftNewTask ? (
        <ControlHintTooltip
          open={workspaceContextOpen}
          onOpenChange={setWorkspaceContextOpen}
          side="bottom"
          align="start"
          className="w-72 items-start border-popover-border bg-popover p-3 text-popover-foreground shadow-md [&>span:first-child]:min-w-0 [&>span:first-child]:flex-1 [&>span:first-child]:text-ui-base [&>span:first-child]:text-popover-foreground"
          title={
            <span
              data-workspace-header-context-info=""
              className="flex w-full min-w-0 flex-col gap-3 text-left"
            >
              <span className="flex min-w-0 items-start gap-2">
                {isRemoteWorkspace ? (
                  <Cloud className="size-4 shrink-0" />
                ) : (
                  <Folder className="size-4 shrink-0" />
                )}
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                    {workspaceContextLabel}
                  </span>
                  {workspaceContextOpen ? (
                    <WorkspaceContextPath
                      workspacePath={workspaceAbsPath}
                      workspaceIdentity={workspaceIdentity}
                      remoteSessionId={remoteSessionId}
                    />
                  ) : null}
                </span>
              </span>
              {workspaceContextOpen ? (
                <WorkspaceLastActivity
                  task={activeTaskMeta?.taskId === activeTaskId ? activeTaskMeta : null}
                />
              ) : null}
              {workspaceBranchLabel ? (
                <span className="flex min-w-0 items-center gap-2 border-t border-border/50 pt-3 font-normal">
                  <GitBranch className="size-4 shrink-0" />
                  <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                    {workspaceBranchLabel}
                  </span>
                </span>
              ) : null}
            </span>
          }
        >
          <Button
            type="button"
            variant="ghost"
            size={compact ? "icon-sm" : "icon-md"}
            data-testid={TID_WORKSPACE_PATH}
            aria-label={[workspaceContextLabel, workspaceBranchLabel].filter(Boolean).join(" · ")}
            onClick={() => setWorkspaceContextOpen(true)}
          >
            {isRemoteWorkspace ? (
              <Cloud className="size-4 text-foreground-subtle" />
            ) : (
              <Folder className="size-4 text-foreground-subtle" />
            )}
          </Button>
        </ControlHintTooltip>
      ) : null}
      <h1
        data-testid={TID_WORKSPACE_TITLE}
        className={cn(
          "flex min-w-12 max-w-100 shrink items-center gap-2 truncate font-semibold text-foreground @max-[560px]/workspace-header:max-w-[30vw] @max-[420px]/workspace-header:max-w-[22vw]",
          simplifyForNarrowRemote && "max-md:max-w-[42vw]",
          compact ? "text-[0.92rem]" : "text-ui-base",
        )}
        title={activeTaskTitle}
      >
        <span className="min-w-0 truncate">{activeTaskTitle}</span>
        {/* {activeTaskChangeSummary ? (
          <>
            {activeTaskChangeSummary.added > 0 ? (
              <span className="text-diff-added">
                +{activeTaskChangeSummary.added}
              </span>
            ) : null}
            {activeTaskChangeSummary.removed > 0 ? (
              <span className="text-diff-removed">
                -{activeTaskChangeSummary.removed}
              </span>
            ) : null}
          </>
        ) : null} */}
      </h1>
      <div className="flex min-w-0 shrink-0 items-center gap-1">
        {!isDraftNewTask ? (
          <DropdownMenu open={taskMenuOpen} onOpenChange={setTaskMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size={compact ? "icon-sm" : "icon-md"}
                data-testid={TID_WORKSPACE_MORE_BUTTON}
                aria-label={intl.formatMessage({ id: "common.more" })}
              >
                <Ellipsis className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              {showRemoteSkillSyncAction && remoteTarget ? (
                <>
                  <RemoteSyncMenuItems
                    canSyncSkills
                    canSyncMcp
                    canSyncPlugins
                    onOpenSkillSync={() => setRemoteSkillSyncOpen(true)}
                    onOpenMcpSync={() => setRemoteMcpSyncOpen(true)}
                    onOpenPluginSync={() => setRemotePluginSyncOpen(true)}
                  />
                  <DropdownMenuSeparator />
                </>
              ) : null}
              <TaskActionMenuContent
                intl={intl}
                isPinned={isPinned}
                fileManagerLabel={fileManagerLabel}
                taskSessionFile={taskSessionFile}
                activeSessionId={activeSessionId}
                taskNativeSessionLogFile={taskNativeSessionLogFile}
                disableTaskTargetActions={disableTaskTargetActions || taskMenuMembershipLoading}
                disableTaskActions={Boolean(readOnlyReason)}
                disabledReason={readOnlyReason}
                disablePinTaskAction={taskMenuMembershipLoading}
                hideMobileUnsupportedActions={simplifyForNarrowRemote}
                Item={DropdownMenuItem}
                Separator={DropdownMenuSeparator}
                onTogglePinTask={() => {
                  if (!resolvedTaskActionTaskId) {
                    return;
                  }
                  const optimisticTask = activeTaskMeta ?? null;
                  if (optimisticTask) {
                    // Header 里切换 pin 以前只等 RPC 成功后更新列表缓存，
                    // pinned 区会在请求期间被旧查询结果覆盖。先乐观切换，失败再回滚。
                    if (workspaceIdentity && !isPinned) {
                      useRemotePinnedTaskStore.getState().upsertTask(optimisticTask);
                      useRemoteTimelineTaskStore
                        .getState()
                        .removeTask(workspaceAbsPath, resolvedTaskActionTaskId, workspaceIdentity);
                    }
                    if (workspaceIdentity && isPinned) {
                      useRemotePinnedTaskStore
                        .getState()
                        .removeTask(workspaceAbsPath, resolvedTaskActionTaskId, workspaceIdentity);
                      useRemoteTimelineTaskStore.getState().upsertTask(optimisticTask);
                    }
                    applyTaskQueryCacheMutation({
                      previousTask: optimisticTask,
                      nextTask: optimisticTask,
                      previousState: { pinned: isPinned, archived: false },
                      nextState: { pinned: !isPinned, archived: false },
                    });
                  }
                  void services.zcodeTaskService
                    .setTaskPinned({
                      taskId: resolvedTaskActionTaskId,
                      workspacePath: workspaceAbsPath,
                      pinned: !isPinned,
                      ...(workspaceIdentity ? { workspaceIdentity } : {}),
                    })
                    .then((meta) => {
                      removeOptimisticTaskListItem(
                        workspaceAbsPath,
                        resolvedTaskActionTaskId,
                        workspaceIdentity,
                      );
                      if (workspaceIdentity && !isPinned) {
                        useRemotePinnedTaskStore.getState().upsertTask(meta);
                        useRemoteTimelineTaskStore
                          .getState()
                          .removeTask(
                            workspaceAbsPath,
                            resolvedTaskActionTaskId,
                            workspaceIdentity,
                          );
                      }
                      if (workspaceIdentity && isPinned) {
                        useRemotePinnedTaskStore
                          .getState()
                          .removeTask(
                            workspaceAbsPath,
                            resolvedTaskActionTaskId,
                            workspaceIdentity,
                          );
                        useRemoteTimelineTaskStore.getState().upsertTask(meta);
                      }
                      applyTaskQueryCacheMutation({
                        previousTask: buildHeaderTaskSnapshot(meta),
                        nextTask: meta,
                        previousState: { pinned: !isPinned, archived: false },
                        nextState: { pinned: !isPinned, archived: false },
                      });
                    })
                    .catch(() => {
                      if (optimisticTask) {
                        if (workspaceIdentity && !isPinned) {
                          useRemotePinnedTaskStore
                            .getState()
                            .removeTask(
                              workspaceAbsPath,
                              resolvedTaskActionTaskId,
                              workspaceIdentity,
                            );
                          useRemoteTimelineTaskStore.getState().upsertTask(optimisticTask);
                        }
                        if (workspaceIdentity && isPinned) {
                          useRemotePinnedTaskStore.getState().upsertTask(optimisticTask);
                          useRemoteTimelineTaskStore
                            .getState()
                            .removeTask(
                              workspaceAbsPath,
                              resolvedTaskActionTaskId,
                              workspaceIdentity,
                            );
                        }
                        applyTaskQueryCacheMutation({
                          previousTask: optimisticTask,
                          nextTask: optimisticTask,
                          previousState: { pinned: !isPinned, archived: false },
                          nextState: { pinned: isPinned, archived: false },
                        });
                      }
                      toast(intl.formatMessage({ id: "taskList.pinFailed" }));
                    });
                }}
                onStartRenameTask={handleStartRenameTask}
                onArchiveTask={() => {
                  void handleArchiveTask();
                }}
                onMarkTaskAsUnread={() => {
                  if (!resolvedTaskActionTaskId) {
                    return;
                  }
                  void services.zcodeTaskService
                    .setTaskUnread({
                      taskId: resolvedTaskActionTaskId,
                      workspacePath: workspaceAbsPath,
                      unread: true,
                      ...(workspaceIdentity ? { workspaceIdentity } : {}),
                    })
                    .then((meta) => {
                      setTaskUnreadIndicator(
                        workspaceAbsPath,
                        resolvedTaskActionTaskId,
                        true,
                        workspaceIdentity,
                      );
                      upsertOptimisticTaskListItem(workspaceAbsPath, meta, workspaceIdentity);
                      if (workspaceIdentity) {
                        if (isPinned) {
                          useRemotePinnedTaskStore.getState().upsertTask(meta);
                        } else {
                          useRemoteTimelineTaskStore.getState().upsertTask(meta);
                        }
                      }
                      applyTaskQueryCacheMutation({
                        previousTask: buildHeaderTaskSnapshot(meta),
                        nextTask: meta,
                        previousState: { pinned: isPinned, archived: false },
                        nextState: { pinned: isPinned, archived: false },
                      });
                    });
                }}
                onOpenTaskFeedback={() => {
                  void handleOpenTaskFeedback();
                }}
                onOpenTaskPathInFileManager={() => {
                  void handleOpenTaskPathInFileManager();
                }}
                onCopyWorkspacePath={() => {
                  void handleCopyText(
                    intl.formatMessage({ id: "appHeader.copyPath" }),
                    workspaceAbsPath,
                  );
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
                  void handleCopyText(
                    intl.formatMessage({ id: "appHeader.copySessionId" }),
                    activeSessionId,
                  );
                }}
                onViewModelTrajectory={
                  resolvedTaskActionTaskId
                    ? () => {
                        useModelTrajectoryStore.getState().requestOpen({
                          taskId: resolvedTaskActionTaskId,
                          workspaceKey: workspaceIdentity?.trim() || workspaceAbsPath,
                          title: activeTaskMeta?.title ?? null,
                        });
                      }
                    : undefined
                }
              />
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <RemoteSyncDialogs
          canSyncSkills={showRemoteSkillSyncAction}
          canSyncMcp={showRemoteSkillSyncAction}
          canSyncPlugins={showRemoteSkillSyncAction}
          skillOpen={remoteSkillSyncOpen}
          mcpOpen={remoteMcpSyncOpen}
          pluginOpen={remotePluginSyncOpen}
          onSkillOpenChange={setRemoteSkillSyncOpen}
          onMcpOpenChange={setRemoteMcpSyncOpen}
          onPluginOpenChange={setRemotePluginSyncOpen}
          localSkillSyncService={baseServices.skillSyncService}
          remoteSkillSyncService={services.skillSyncService}
          localMcpSyncService={baseServices.mcpSyncService}
          remoteMcpSyncService={services.mcpSyncService}
          localPluginSyncService={baseServices.pluginSyncService}
          remotePluginSyncService={services.pluginSyncService}
          localZCodeAgentService={baseServices.zcodeAgentService}
          remoteZCodeAgentService={services.zcodeAgentService}
          remoteTarget={remoteTarget}
          skillWorkspacePath={workspaceAbsPath}
          mcpWorkspacePath={workspaceAbsPath}
          pluginWorkspacePath={workspaceAbsPath}
          pluginLocalWorkspacePath={localWorkspacePath}
          mcpLocalWorkspacePath={localWorkspacePath}
          workspaceIdentity={workspaceIdentity}
          onSkillsSynced={async () => {
            await invalidateDeferredDraftSessionForSkillChange({
              zcodeSessionService: services.zcodeSessionService,
              workspacePath: workspaceAbsPath,
              workspaceIdentity,
              reason: "header-remote-skill-sync",
            });
            await refreshSharedSkillStoreForWorkspace({
              workspacePath: workspaceAbsPath,
              workspaceIdentity,
              skillsService: services.skillsService,
            });
          }}
          onMcpSynced={async () => {
            await useMcpStore
              .getState()
              .ensureLoadedForWorkspace(
                workspaceAbsPath,
                services.mcpSyncService,
                workspaceIdentity,
              );
          }}
          onPluginsSynced={async () => {
            await refreshWorkspacePluginCapabilitiesAfterRemoteSync({
              commandsService: services.commandsService,
              mcpSyncService: services.mcpSyncService,
              reason: "header-remote-plugin-sync",
              skillsService: services.skillsService,
              workspaceIdentity,
              workspacePath: workspaceAbsPath,
              zcodeAgentService: services.zcodeAgentService,
              zcodeSessionService: services.zcodeSessionService,
            });
          }}
        />
        {!isDraftNewTask && workspaceActionLoading ? (
          <ControlHintTooltip
            title={workspaceActionLoadingTitle}
            side="bottom"
            align="start"
            className="max-w-84 items-start px-2 py-1.5"
          >
            <span
              role="img"
              aria-label={workspaceActionLoadingTitle}
              className={cn(
                "inline-flex items-center justify-center rounded-full text-foreground-subtle",
                compact ? "size-6" : "size-7",
              )}
            >
              <LoaderIcon className={cn("animate-spin", compact ? "size-3.5" : "size-4")} />
            </span>
          </ControlHintTooltip>
        ) : null}
      </div>
    </div>
  );
}
