/* eslint-disable max-lines -- pinned 列表现在同时承载本地查询、远端主动注入结果和任务操作分发，先集中保持交互一致。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { useLocalWorkspaceScopes } from "@/hooks/useLocalWorkspaceScopes.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";
import { resolveTaskFileTreeTargetFromTabs } from "@/lib/taskFileTreeTarget.js";
import { MemoTaskItem, TaskListItemContextMenuContent } from "@/TaskListItem.js";
import { TaskRenameDialog } from "@/TaskRenameDialog.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { applyTaskQueryCacheMutation } from "@/store/taskQueryCacheStore.js";
import { TaskListRemoteSyncHint } from "@/TaskListRemoteSyncHint.js";
import { useRemotePinnedTaskStore } from "@/store/remotePinnedTaskStore.js";
import { useRemoteTimelineTaskStore } from "@/store/remoteTimelineTaskStore.js";
import {
  getRemoteWorkspaceServicesForIdentity,
  useRemoteWorkspaceSessionStore,
} from "@/store/remoteWorkspaceSessionStore.js";

function buildPinnedItemKey(workspacePath: string, taskId: string, workspaceIdentity?: string) {
  return `${buildTaskWorkspaceKey(workspacePath, workspaceIdentity)}:${taskId}`;
}

interface PinnedTaskItemHandlers {
  onSelectTask: (taskId: string) => void;
  onArchiveTaskInline: (event: ReactMouseEvent, taskId: string) => void;
  onTogglePinTask: (taskId: string, pinned: boolean) => void;
  onStartRenameTask: (taskId: string, currentTitle: string) => void;
  onArchiveTask: (taskId: string) => void;
  onMarkTaskAsUnread: (taskId: string) => void;
  onOpenTaskContextMenu: (taskId: string) => void;
  onOpenFileTree: (task: ZCodeTaskMeta) => void;
}

function PinnedTasksSectionTitle({ title }: { title: string }) {
  return <h3 className="px-2.5 py-1 text-ui-base font-medium text-foreground-subtlest">{title}</h3>;
}

export function WorkspacePinnedTasksSection({
  workspaceTabs,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  activeTaskId,
  taskSortBy,
  onSelectTask,
  onOpenFileTree,
}: {
  workspaceTabs: WorkspaceTabState[];
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  taskSortBy: "created" | "updated";
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
    expectedUnreadAt?: number,
  ) => void;
  onOpenFileTree?: (target: {
    workspacePath: string;
    workspaceName: string;
    workspaceIdentity?: string;
    workspaceRemoteSessionId?: string;
  }) => void;
}) {
  const { intl } = useZCodeIntl();
  const baseServices = useBaseWorkspaceServices();
  const scopedWorkspaceTabs = useLocalWorkspaceScopes({
    workspaceTabs,
  });
  const remoteSessionIdByWorkspaceIdentity = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspaceIdentity,
  );
  const removeTaskState = useZCodeSessionStore((state) => state.removeTaskState);
  const upsertOptimisticTaskListItem = useZCodeSessionStore(
    (state) => state.upsertOptimisticTaskListItem,
  );
  const removeOptimisticTaskListItem = useZCodeSessionStore(
    (state) => state.removeOptimisticTaskListItem,
  );
  const setTaskUnreadIndicator = useZCodeSessionStore((state) => state.setTaskUnreadIndicator);
  const [pendingArchiveItemKey, setPendingArchiveItemKey] = useState<string | null>(null);
  const [renamingItemKey, setRenamingItemKey] = useState<string | null>(null);
  const [contextMenuItemKey, setContextMenuItemKey] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [showAllTasks, setShowAllTasks] = useState(false);
  const collapsedLimit = 20;
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const pendingArchiveItemKeyRef = useRef<string | null>(pendingArchiveItemKey);
  const taskSortByRef = useRef(taskSortBy);
  const intlRef = useRef(intl);
  const onSelectTaskRef = useRef(onSelectTask);
  const removeTaskStateRef = useRef(removeTaskState);
  const upsertOptimisticTaskListItemRef = useRef(upsertOptimisticTaskListItem);
  const removeOptimisticTaskListItemRef = useRef(removeOptimisticTaskListItem);
  const setTaskUnreadIndicatorRef = useRef(setTaskUnreadIndicator);
  const taskItemHandlersByKeyRef = useRef(new Map<string, PinnedTaskItemHandlers>());
  pendingArchiveItemKeyRef.current = pendingArchiveItemKey;
  taskSortByRef.current = taskSortBy;
  intlRef.current = intl;
  onSelectTaskRef.current = onSelectTask;
  removeTaskStateRef.current = removeTaskState;
  upsertOptimisticTaskListItemRef.current = upsertOptimisticTaskListItem;
  removeOptimisticTaskListItemRef.current = removeOptimisticTaskListItem;
  setTaskUnreadIndicatorRef.current = setTaskUnreadIndicator;
  const { items: localItems } = useGlobalTaskList({
    kind: "pinned",
    workspaceTabs: scopedWorkspaceTabs,
    sortBy: taskSortBy,
    searchQuery: "",
    expanded: true,
    collapsedLimit,
  });
  const remotePinnedItemsByWorkspaceKey = useRemotePinnedTaskStore(
    (state) => state.itemsByWorkspaceKey,
  );
  const remotePinnedLoadingByWorkspaceKey = useRemotePinnedTaskStore(
    (state) => state.loadingByWorkspaceKey,
  );
  const remoteItems = useMemo(() => {
    const remoteWorkspaceKeys = new Set(
      workspaceTabs
        .filter((tab) => tab.workspaceIdentity || tab.remoteTarget || tab.remoteSessionId)
        .map((tab) => buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity)),
    );
    return [...remoteWorkspaceKeys].flatMap(
      (workspaceKey) => remotePinnedItemsByWorkspaceKey[workspaceKey] ?? [],
    );
  }, [remotePinnedItemsByWorkspaceKey, workspaceTabs]);
  const sortedItems = useMemo(() => {
    return [...localItems, ...remoteItems].sort((left, right) =>
      compareZCodeTaskListItems(left, right, taskSortBy),
    );
  }, [localItems, remoteItems, taskSortBy]);
  const items = showAllTasks ? sortedItems : sortedItems.slice(0, collapsedLimit);
  const total = sortedItems.length;
  const syncingRemoteWorkspaces = workspaceTabs.some((tab) => {
    if (!tab.workspaceIdentity && !tab.remoteTarget && !tab.remoteSessionId) {
      return false;
    }
    return Boolean(
      remotePinnedLoadingByWorkspaceKey[
        buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity)
      ],
    );
  });
  const canToggleExpanded = total > collapsedLimit;
  const sectionTitle = intl.formatMessage({ id: "taskList.pinnedSection" });
  const activeWorkspaceKey = buildTaskWorkspaceKey(activeWorkspacePath, activeWorkspaceIdentity);
  const itemByKey = useMemo(() => {
    const nextItemByKey = new Map<string, ZCodeTaskMeta>();
    for (const item of items) {
      nextItemByKey.set(
        buildPinnedItemKey(item.workspacePath, item.taskId, item.workspaceIdentity),
        item,
      );
    }
    return nextItemByKey;
  }, [items]);
  const itemByKeyRef = useRef(itemByKey);
  itemByKeyRef.current = itemByKey;
  const workspaceTabsRef = useRef(workspaceTabs);
  workspaceTabsRef.current = workspaceTabs;
  const onOpenFileTreeRef = useRef(onOpenFileTree);
  onOpenFileTreeRef.current = onOpenFileTree;

  const resolveTaskServices = useCallback(
    (workspaceIdentity?: string) => {
      if (!workspaceIdentity) {
        return baseServices;
      }
      return getRemoteWorkspaceServicesForIdentity(workspaceIdentity);
    },
    [baseServices],
  );
  const resolveTaskServicesRef = useRef(resolveTaskServices);
  resolveTaskServicesRef.current = resolveTaskServices;

  const handleCancelArchiveConfirm = useCallback(() => {
    setPendingArchiveItemKey(null);
  }, []);

  const handleCancelRenameTask = useCallback(() => {
    setRenamingItemKey(null);
    setRenameDraft("");
  }, []);

  const findItemByKey = useCallback(
    (itemKey: string) => itemByKey.get(itemKey) ?? null,
    [itemByKey],
  );
  const getCurrentPinnedItemContext = useCallback((itemKey: string) => {
    const item = itemByKeyRef.current.get(itemKey);
    if (!item) {
      return null;
    }

    const services = resolveTaskServicesRef.current(item.workspaceIdentity);
    if (!services) {
      return null;
    }

    return { item, services };
  }, []);
  const archivePinnedItem = useCallback(
    (itemKey: string) => {
      const current = getCurrentPinnedItemContext(itemKey);
      if (!current) {
        return;
      }
      const { item, services } = current;
      void services.zcodeTaskService
        .archiveTask({
          taskId: item.taskId,
          workspacePath: item.workspacePath,
          ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
        })
        .then((meta) => {
          removeTaskStateRef.current(item.workspacePath, item.taskId, item.workspaceIdentity);
          if (item.workspaceIdentity) {
            useRemotePinnedTaskStore
              .getState()
              .removeTask(item.workspacePath, item.taskId, item.workspaceIdentity);
            useRemoteTimelineTaskStore
              .getState()
              .removeTask(item.workspacePath, item.taskId, item.workspaceIdentity);
          }
          applyTaskQueryCacheMutation({
            previousTask: item,
            nextTask: meta,
            previousState: { pinned: true, archived: false },
            nextState: { pinned: false, archived: true },
          });
        });
    },
    [getCurrentPinnedItemContext],
  );
  const selectPinnedItem = useCallback((itemKey: string) => {
    const item = itemByKeyRef.current.get(itemKey);
    if (!item) {
      return;
    }
    onSelectTaskRef.current(item.workspacePath, item.taskId, item.workspaceIdentity, item.unreadAt);
  }, []);
  const archivePinnedItemInline = useCallback(
    (event: ReactMouseEvent, itemKey: string) => {
      event.stopPropagation();
      if (pendingArchiveItemKeyRef.current !== itemKey) {
        setPendingArchiveItemKey(itemKey);
        return;
      }
      setPendingArchiveItemKey(null);
      archivePinnedItem(itemKey);
    },
    [archivePinnedItem],
  );
  const togglePinnedItemPin = useCallback(
    (itemKey: string, pinned: boolean) => {
      const current = getCurrentPinnedItemContext(itemKey);
      if (!current) {
        return;
      }
      const { item, services } = current;
      // unpin 以前等 RPC 返回后才把任务移出 pinned 区，重查期间会出现列表闪烁。
      // 这里先乐观移动，RPC 失败再把任务恢复为 pinned。
      if (item.workspaceIdentity) {
        useRemotePinnedTaskStore
          .getState()
          .removeTask(item.workspacePath, item.taskId, item.workspaceIdentity);
        if (!pinned) {
          useRemoteTimelineTaskStore.getState().upsertTask(item, taskSortByRef.current);
        }
      }
      applyTaskQueryCacheMutation({
        previousTask: item,
        nextTask: item,
        previousState: { pinned: true, archived: false },
        nextState: { pinned, archived: false },
      });
      void services.zcodeTaskService
        .setTaskPinned({
          taskId: item.taskId,
          workspacePath: item.workspacePath,
          ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
          pinned,
        })
        .then((meta) => {
          removeOptimisticTaskListItemRef.current(
            item.workspacePath,
            item.taskId,
            item.workspaceIdentity,
          );
          if (item.workspaceIdentity && pinned) {
            useRemotePinnedTaskStore.getState().upsertTask(meta);
            useRemoteTimelineTaskStore
              .getState()
              .removeTask(item.workspacePath, item.taskId, item.workspaceIdentity);
          }
          if (item.workspaceIdentity && !pinned) {
            useRemoteTimelineTaskStore.getState().upsertTask(meta, taskSortByRef.current);
          }
          applyTaskQueryCacheMutation({
            previousTask: item,
            nextTask: meta,
            previousState: { pinned, archived: false },
            nextState: { pinned, archived: false },
          });
        })
        .catch(() => {
          if (item.workspaceIdentity) {
            useRemotePinnedTaskStore.getState().upsertTask(item);
            useRemoteTimelineTaskStore
              .getState()
              .removeTask(item.workspacePath, item.taskId, item.workspaceIdentity);
          }
          applyTaskQueryCacheMutation({
            previousTask: item,
            nextTask: item,
            previousState: { pinned, archived: false },
            nextState: { pinned: true, archived: false },
          });
          toast(intlRef.current.formatMessage({ id: "taskList.pinFailed" }));
        });
    },
    [getCurrentPinnedItemContext],
  );
  const startPinnedItemRename = useCallback((itemKey: string, currentTitle: string) => {
    setPendingArchiveItemKey(null);
    setRenamingItemKey(itemKey);
    setRenameDraft(currentTitle);
  }, []);
  const markPinnedItemAsUnread = useCallback(
    (itemKey: string) => {
      const current = getCurrentPinnedItemContext(itemKey);
      if (!current) {
        return;
      }
      const { item, services } = current;
      void services.zcodeTaskService
        .setTaskUnread({
          taskId: item.taskId,
          workspacePath: item.workspacePath,
          ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
          unread: true,
        })
        .then((meta) => {
          setTaskUnreadIndicatorRef.current(
            item.workspacePath,
            item.taskId,
            true,
            item.workspaceIdentity,
          );
          upsertOptimisticTaskListItemRef.current(item.workspacePath, meta, item.workspaceIdentity);
          if (item.workspaceIdentity) {
            useRemotePinnedTaskStore.getState().upsertTask(meta);
          }
          applyTaskQueryCacheMutation({
            previousTask: item,
            nextTask: meta,
            previousState: { pinned: true, archived: false },
            nextState: { pinned: true, archived: false },
          });
        });
    },
    [getCurrentPinnedItemContext],
  );
  const openPinnedItemContextMenu = useCallback((itemKey: string) => {
    // pinned row handler 按 itemKey 缓存；打开菜单时从 ref 读取最新确认态，
    // 避免 pendingArchiveItemKey 变化时重建所有 TaskListItem callback。
    if (pendingArchiveItemKeyRef.current === itemKey) {
      setPendingArchiveItemKey(null);
    }
    setContextMenuItemKey(itemKey);
  }, []);
  const getPinnedTaskItemHandlers = useCallback(
    (itemKey: string) => {
      let handlers = taskItemHandlersByKeyRef.current.get(itemKey);
      if (!handlers) {
        // trace 显示 pinned row 的 action props 仍因 map 内联闭包变化。
        // 每个 itemKey 只创建一次 handler，实际执行时再通过 ref 读取最新 item/services/state。
        handlers = {
          onSelectTask: () => {
            selectPinnedItem(itemKey);
          },
          onArchiveTaskInline: (event) => {
            archivePinnedItemInline(event, itemKey);
          },
          onTogglePinTask: (_taskId, pinned) => {
            togglePinnedItemPin(itemKey, pinned);
          },
          onStartRenameTask: (_taskId, currentTitle) => {
            startPinnedItemRename(itemKey, currentTitle);
          },
          onArchiveTask: () => {
            archivePinnedItem(itemKey);
          },
          onMarkTaskAsUnread: () => {
            markPinnedItemAsUnread(itemKey);
          },
          onOpenTaskContextMenu: () => {
            openPinnedItemContextMenu(itemKey);
          },
          onOpenFileTree: (task) => {
            const target = resolveTaskFileTreeTargetFromTabs(task, workspaceTabsRef.current);
            if (target) {
              onOpenFileTreeRef.current?.(target);
            }
          },
        };
        taskItemHandlersByKeyRef.current.set(itemKey, handlers);
      }
      return handlers;
    },
    [
      archivePinnedItem,
      archivePinnedItemInline,
      markPinnedItemAsUnread,
      openPinnedItemContextMenu,
      selectPinnedItem,
      startPinnedItemRename,
      togglePinnedItemPin,
    ],
  );

  useEffect(() => {
    if (!renamingItemKey) {
      return;
    }

    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingItemKey]);

  useEffect(() => {
    if (!contextMenuItemKey) {
      return;
    }

    if (!findItemByKey(contextMenuItemKey)) {
      setContextMenuItemKey(null);
    }
  }, [contextMenuItemKey, findItemByKey]);

  useEffect(() => {
    for (const itemKey of taskItemHandlersByKeyRef.current.keys()) {
      if (!itemByKey.has(itemKey)) {
        taskItemHandlersByKeyRef.current.delete(itemKey);
      }
    }
  }, [itemByKey]);

  const contextMenuItem = contextMenuItemKey ? findItemByKey(contextMenuItemKey) : null;
  const contextMenuServices = contextMenuItem
    ? resolveTaskServices(contextMenuItem.workspaceIdentity)
    : null;

  if (items.length === 0) {
    // 切换/加入工作区时 pinned 查询会先进入 loading，但此时没有可展示的数据。
    // 不能仍渲染“已置顶 + 正在获取任务”，否则侧栏每次切换都出现一次无实际帮助的 loading。
    // 有缓存数据时继续走下面的正常渲染路径，保持 stale-while-revalidate 的展示体验。
    return null;
  }

  return (
    <div className="flex flex-col gap-1 px-2 empty:hidden">
      {renamingItemKey !== null ? (
        <TaskRenameDialog
          open
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
            if (!renamingItemKey) {
              return;
            }
            const item = findItemByKey(renamingItemKey);
            if (!item) {
              handleCancelRenameTask();
              return;
            }
            const services = resolveTaskServices(item.workspaceIdentity);
            if (!services) {
              handleCancelRenameTask();
              return;
            }
            void services.zcodeTaskService
              .renameTask({
                taskId: item.taskId,
                workspacePath: item.workspacePath,
                ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
                title: renameDraft.trim(),
              })
              .then((meta) => {
                upsertOptimisticTaskListItem(item.workspacePath, meta, item.workspaceIdentity);
                if (item.workspaceIdentity) {
                  useRemotePinnedTaskStore.getState().upsertTask(meta);
                }
                applyTaskQueryCacheMutation({
                  previousTask: item,
                  nextTask: meta,
                  previousState: { pinned: true, archived: false },
                  nextState: { pinned: true, archived: false },
                });
                handleCancelRenameTask();
              })
              .catch(() => {
                toast(intl.formatMessage({ id: "taskList.renameFailed" }));
              });
          }}
        />
      ) : null}
      <PinnedTasksSectionTitle title={sectionTitle} />
      <ContextMenu
        onOpenChange={(open) => {
          if (!open) {
            setContextMenuItemKey(null);
          }
        }}
      >
        <ContextMenuTrigger asChild>
          <ul className="space-y-0.5">
            {items.map((item) => {
              const itemKey = buildPinnedItemKey(
                item.workspacePath,
                item.taskId,
                item.workspaceIdentity,
              );
              const services = resolveTaskServices(item.workspaceIdentity);
              if (!services) {
                return null;
              }
              const handlers = getPinnedTaskItemHandlers(itemKey);
              return (
                <MemoTaskItem
                  key={itemKey}
                  workspacePath={item.workspacePath}
                  remoteSessionId={
                    item.workspaceIdentity
                      ? remoteSessionIdByWorkspaceIdentity[item.workspaceIdentity]
                      : undefined
                  }
                  task={item}
                  isPinned
                  isActive={
                    // 同路径远端 workspace 可能包含相同 taskId，选中态必须按 workspaceIdentity 隔离。
                    buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity) ===
                      activeWorkspaceKey && item.taskId === activeTaskId
                  }
                  onSelectTask={handlers.onSelectTask}
                  onArchiveTaskInline={handlers.onArchiveTaskInline}
                  onCancelArchiveConfirm={handleCancelArchiveConfirm}
                  isArchiveConfirming={pendingArchiveItemKey === itemKey}
                  onTogglePinTask={handlers.onTogglePinTask}
                  onStartRenameTask={handlers.onStartRenameTask}
                  onArchiveTask={handlers.onArchiveTask}
                  onMarkTaskAsUnread={handlers.onMarkTaskAsUnread}
                  onOpenTaskContextMenu={handlers.onOpenTaskContextMenu}
                  onOpenFileTree={onOpenFileTree ? handlers.onOpenFileTree : undefined}
                  intl={intl}
                />
              );
            })}
          </ul>
        </ContextMenuTrigger>
        {contextMenuItem && contextMenuServices ? (
          <TaskListItemContextMenuContent
            workspacePath={contextMenuItem.workspacePath}
            remoteSessionId={
              contextMenuItem.workspaceIdentity
                ? remoteSessionIdByWorkspaceIdentity[contextMenuItem.workspaceIdentity]
                : undefined
            }
            task={contextMenuItem}
            isPinned
            intl={intl}
            onTogglePinTask={(_taskId, pinned) => {
              if (contextMenuItem.workspaceIdentity) {
                useRemotePinnedTaskStore
                  .getState()
                  .removeTask(
                    contextMenuItem.workspacePath,
                    contextMenuItem.taskId,
                    contextMenuItem.workspaceIdentity,
                  );
                if (!pinned) {
                  useRemoteTimelineTaskStore.getState().upsertTask(contextMenuItem, taskSortBy);
                }
              }
              applyTaskQueryCacheMutation({
                previousTask: contextMenuItem,
                nextTask: contextMenuItem,
                previousState: { pinned: true, archived: false },
                nextState: { pinned, archived: false },
              });
              void contextMenuServices.zcodeTaskService
                .setTaskPinned({
                  taskId: contextMenuItem.taskId,
                  workspacePath: contextMenuItem.workspacePath,
                  ...(contextMenuItem.workspaceIdentity
                    ? { workspaceIdentity: contextMenuItem.workspaceIdentity }
                    : {}),
                  pinned,
                })
                .then((meta) => {
                  removeOptimisticTaskListItem(
                    contextMenuItem.workspacePath,
                    contextMenuItem.taskId,
                    contextMenuItem.workspaceIdentity,
                  );
                  if (contextMenuItem.workspaceIdentity && pinned) {
                    useRemotePinnedTaskStore.getState().upsertTask(meta);
                    useRemoteTimelineTaskStore
                      .getState()
                      .removeTask(
                        contextMenuItem.workspacePath,
                        contextMenuItem.taskId,
                        contextMenuItem.workspaceIdentity,
                      );
                  }
                  if (contextMenuItem.workspaceIdentity && !pinned) {
                    useRemoteTimelineTaskStore.getState().upsertTask(meta, taskSortBy);
                  }
                  applyTaskQueryCacheMutation({
                    previousTask: contextMenuItem,
                    nextTask: meta,
                    previousState: { pinned, archived: false },
                    nextState: { pinned, archived: false },
                  });
                })
                .catch(() => {
                  if (contextMenuItem.workspaceIdentity) {
                    useRemotePinnedTaskStore.getState().upsertTask(contextMenuItem);
                    useRemoteTimelineTaskStore
                      .getState()
                      .removeTask(
                        contextMenuItem.workspacePath,
                        contextMenuItem.taskId,
                        contextMenuItem.workspaceIdentity,
                      );
                  }
                  applyTaskQueryCacheMutation({
                    previousTask: contextMenuItem,
                    nextTask: contextMenuItem,
                    previousState: { pinned, archived: false },
                    nextState: { pinned: true, archived: false },
                  });
                  toast(intl.formatMessage({ id: "taskList.pinFailed" }));
                });
            }}
            onStartRenameTask={(_taskId, currentTitle) => {
              setPendingArchiveItemKey(null);
              setRenamingItemKey(contextMenuItemKey);
              setRenameDraft(currentTitle);
            }}
            onArchiveTask={() => {
              void contextMenuServices.zcodeTaskService
                .archiveTask({
                  taskId: contextMenuItem.taskId,
                  workspacePath: contextMenuItem.workspacePath,
                  ...(contextMenuItem.workspaceIdentity
                    ? { workspaceIdentity: contextMenuItem.workspaceIdentity }
                    : {}),
                })
                .then((meta) => {
                  removeTaskState(
                    contextMenuItem.workspacePath,
                    contextMenuItem.taskId,
                    contextMenuItem.workspaceIdentity,
                  );
                  if (contextMenuItem.workspaceIdentity) {
                    useRemotePinnedTaskStore
                      .getState()
                      .removeTask(
                        contextMenuItem.workspacePath,
                        contextMenuItem.taskId,
                        contextMenuItem.workspaceIdentity,
                      );
                    useRemoteTimelineTaskStore
                      .getState()
                      .removeTask(
                        contextMenuItem.workspacePath,
                        contextMenuItem.taskId,
                        contextMenuItem.workspaceIdentity,
                      );
                  }
                  applyTaskQueryCacheMutation({
                    previousTask: contextMenuItem,
                    nextTask: meta,
                    previousState: { pinned: true, archived: false },
                    nextState: { pinned: false, archived: true },
                  });
                });
            }}
            onMarkTaskAsUnread={() => {
              void contextMenuServices.zcodeTaskService
                .setTaskUnread({
                  taskId: contextMenuItem.taskId,
                  workspacePath: contextMenuItem.workspacePath,
                  ...(contextMenuItem.workspaceIdentity
                    ? { workspaceIdentity: contextMenuItem.workspaceIdentity }
                    : {}),
                  unread: true,
                })
                .then((meta) => {
                  setTaskUnreadIndicator(
                    contextMenuItem.workspacePath,
                    contextMenuItem.taskId,
                    true,
                    contextMenuItem.workspaceIdentity,
                  );
                  upsertOptimisticTaskListItem(
                    contextMenuItem.workspacePath,
                    meta,
                    contextMenuItem.workspaceIdentity,
                  );
                  if (contextMenuItem.workspaceIdentity) {
                    useRemotePinnedTaskStore.getState().upsertTask(meta);
                  }
                  applyTaskQueryCacheMutation({
                    previousTask: contextMenuItem,
                    nextTask: meta,
                    previousState: { pinned: true, archived: false },
                    nextState: { pinned: true, archived: false },
                  });
                });
            }}
          />
        ) : null}
      </ContextMenu>
      {syncingRemoteWorkspaces ? <TaskListRemoteSyncHint /> : null}
      {canToggleExpanded ? (
        <div className="cursor-pointer pl-8.5">
          <span
            className="text-ui-base text-foreground-subtlest hover:text-foreground-subtle"
            onClick={() => {
              setShowAllTasks((current) => !current);
            }}
          >
            {intl.formatMessage({
              id: showAllTasks ? "taskList.showLess" : "taskList.showMore",
            })}
          </span>
        </div>
      ) : null}
    </div>
  );
}
