/**
 * ChatEmptyState — 对话为空时的空态展示组件
 *
 * 从 ChatView.tsx 拆出的 workspace 路径工具函数和空态下拉菜单组件。
 */
/* eslint-disable max-lines -- 空态工作区菜单集中维护本地、远程与会话 workspace 的筛选和切换交互，局部样式扩展需保持同一套语义。 */
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { InputGroup, InputGroupAddon } from "@/components/ui/input-group.js";
import {
  ChevronDownIcon,
  Cloud,
  Folder,
  FolderPlus,
  House,
  MessageCircle,
  SearchIcon,
  X,
} from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useRemoteConnectionEntryVisibility } from "@/hooks/useRemoteConnectionEntryVisibility.js";
import { cn } from "@/components/lib/utils.js";
import { getPathLeaf } from "@/lib/path.js";
import {
  formatRemoteWorkspaceTargetSubtitle,
  hasRemoteWorkspaceIdentity,
} from "@/lib/remoteWorkspaceHistory.js";
import { logger } from "@/logger.js";
import { SSHDialog } from "@/SSHDialog.js";
import {
  TID_COMPOSER_PROJECT_DETACH,
  TID_COMPOSER_REMOTE_CONNECTION,
  TID_COMPOSER_WORK_OUTSIDE_PROJECT,
  TID_COMPOSER_WORKSPACE_TRIGGER,
  resolveWorkspaceKey,
  type RemoteTarget,
  type RemoteWorkspaceSessionEntry,
  type WorkspacePurpose,
} from "@zcode/shared";
import { runUserAction, runUserActionAsync } from "@/lib/userActionTelemetry.js";
export {
  getScratchWorkspaceLocationHint,
  getScratchWorkspaceNameErrorKind,
} from "@/ChatEmptyScratchWorkspaceDialog.js";

// ---------------------------------------------------------------------------
// Workspace 路径工具函数
// ---------------------------------------------------------------------------

function inferWorkspaceHomePath(path: string) {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const homeMatch = normalizedPath.match(
    /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\/Users\/[^/]+)(?:\/|$)/,
  );
  return homeMatch?.[1] ?? null;
}

function getWorkspaceMenuTitle(path: string, homeLabel: string) {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\/Users\/[^/]+)$/.test(normalizedPath)) {
    return homeLabel;
  }

  return getPathLeaf(path);
}

function getWorkspaceListTitle(path: string, homeLabel: string) {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\/Users\/[^/]+)$/.test(normalizedPath)) {
    return getPathLeaf(path);
  }

  return getWorkspaceMenuTitle(path, homeLabel);
}

function getWorkspaceTriggerTitle(path: string, homeLabel: string) {
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\/Users\/[^/]+)$/.test(normalizedPath)) {
    return getPathLeaf(path);
  }

  return getWorkspaceMenuTitle(path, homeLabel);
}

export interface ChatEmptyWorkspaceMenuTab {
  workspacePath: string;
  label: string;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
}

function isWorkspaceMenuTabSelected(
  workspaceTab: ChatEmptyWorkspaceMenuTab,
  current: { workspacePath: string; workspaceIdentity?: string },
): boolean {
  return resolveWorkspaceKey(workspaceTab) === resolveWorkspaceKey(current);
}

function getRemoteWorkspaceSearchText(workspaceTab: ChatEmptyWorkspaceMenuTab) {
  if (!workspaceTab.remoteTarget) {
    return workspaceTab.workspaceIdentity ?? "";
  }

  return [
    formatRemoteWorkspaceTargetSubtitle(workspaceTab.remoteTarget),
    workspaceTab.workspaceIdentity,
  ]
    .filter(Boolean)
    .join(" ");
}

function filterVisibleWorkspaceMenuTabs({
  workspaceTabs,
  homeWorkspaceLabel,
  searchQuery,
}: {
  workspaceTabs: ReadonlyArray<ChatEmptyWorkspaceMenuTab>;
  homeWorkspaceLabel: string;
  searchQuery: string;
}) {
  const normalizedQuery = searchQuery.trim().toLowerCase();

  return workspaceTabs
    .filter((workspaceTab) => {
      const isDisconnectedRemoteWorkspace = Boolean(
        hasRemoteWorkspaceIdentity(workspaceTab) && !workspaceTab.remoteSessionId,
      );

      // 空态菜单的 workspace 列表是给“立即切换可用上下文”用的。
      // 断连 remote workspace 继续出现在这里时，用户点进去只会得到一条当前不可用的上下文，
      // 和左侧 sidebar 的“保留断连项以便重连”职责不同。这里把断连 remote 从菜单列表里排除，
      // 仅保留可直接进入的 workspace；底部的固定入口保持不变。
      return !isDisconnectedRemoteWorkspace;
    })
    .filter((workspaceTab) => {
      if (!normalizedQuery) {
        return true;
      }

      const workspaceTitle = getWorkspaceListTitle(workspaceTab.workspacePath, homeWorkspaceLabel);
      const searchableText = [
        workspaceTitle,
        workspaceTab.label,
        workspaceTab.workspacePath,
        getRemoteWorkspaceSearchText(workspaceTab),
      ]
        .join(" ")
        .toLowerCase();
      return searchableText.includes(normalizedQuery);
    })
    .slice(0, 5);
}

// ---------------------------------------------------------------------------
// 空态组件
// ---------------------------------------------------------------------------

export function ChatEmptyWorkspacePreviewMenu({
  workspacePath,
  workspaceIdentity,
  isWindowsDesktop = false,
  workspaceTabs,
  allowConversationWorkspaceSelection = true,
  allowConversationWorkspaceDetach = allowConversationWorkspaceSelection,
  onSelectWorkspace,
  onSelectConversationWorkspace,
  onOpenFolder,
  allowOpenWorkspace = true,
  allowRemoteWorkspace = true,
  remoteWorkspaceSessions = [],
  onConnectRemote,
  onSelectRemoteProject,
  onCancelRemoteProject,
  containerClassName,
  triggerClassName,
  triggerIndicator,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  isWindowsDesktop?: boolean;
  workspaceTabs: ReadonlyArray<ChatEmptyWorkspaceMenuTab>;
  allowConversationWorkspaceSelection?: boolean;
  /** 是否显示项目 chip 的快捷脱离按钮；默认跟随非项目工作区选择能力。 */
  allowConversationWorkspaceDetach?: boolean;
  onSelectWorkspace: (workspaceTab: ChatEmptyWorkspaceMenuTab) => void;
  onSelectConversationWorkspace: () => void | Promise<void>;
  onOpenFolder: () => void;
  allowOpenWorkspace?: boolean;
  allowRemoteWorkspace?: boolean;
  remoteWorkspaceSessions?: RemoteWorkspaceSessionEntry[];
  onConnectRemote: (options: RemoteTarget, requestId?: string) => Promise<string>;
  onSelectRemoteProject: (
    sessionId: string,
    path: string,
    localWorkspacePath?: string,
  ) => Promise<void>;
  onCancelRemoteProject: (sessionId: string) => Promise<void>;
  /** 调用方局部调整 workspace chip 外层视觉，不改变普通会话默认样式。 */
  containerClassName?: string;
  /** 调用方局部调整 workspace trigger 视觉，不改变普通会话默认样式。 */
  triggerClassName?: string;
  /** 调用方局部替换尾部 indicator；普通会话继续使用默认 Lucide chevron。 */
  triggerIndicator?: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const [sshDialogOpen, setSshDialogOpen] = useState(false);
  const [workspaceSearchQuery, setWorkspaceSearchQuery] = useState("");
  const showRemoteConnectionEntry = useRemoteConnectionEntryVisibility();
  // Web 普通模式没有完整远程 workspace 会话链路，不能只依赖全局 feature visibility。
  // 这里叠加壳层能力开关，确保本地 Web 模式的空态菜单不会露出必然失败的远程连接入口。
  const canUseRemoteWorkspace = allowRemoteWorkspace && showRemoteConnectionEntry;
  const currentWorkspaceTab =
    workspaceTabs.find((workspaceTab) =>
      isWorkspaceMenuTabSelected(workspaceTab, {
        workspacePath,
        workspaceIdentity,
      }),
    ) ?? null;
  const isConversationWorkspace = currentWorkspaceTab?.workspacePurpose === "conversation";
  const canDetachProject =
    allowConversationWorkspaceSelection &&
    allowConversationWorkspaceDetach &&
    !isConversationWorkspace;
  const localWorkspacePathForRemoteConnection =
    isConversationWorkspace ||
    currentWorkspaceTab?.remoteSessionId ||
    currentWorkspaceTab?.remoteTarget ||
    currentWorkspaceTab?.workspaceIdentity
      ? undefined
      : workspacePath;
  const homeWorkspacePath = inferWorkspaceHomePath(workspacePath);
  const homeWorkspaceLabel = intl.formatMessage({ id: "chat.empty.home" });
  const isCurrentRemoteWorkspace = hasRemoteWorkspaceIdentity(currentWorkspaceTab ?? {});
  const visibleWorkspaceTabs = useMemo(
    () =>
      filterVisibleWorkspaceMenuTabs({
        workspaceTabs: workspaceTabs.filter(
          (workspaceTab) => workspaceTab.workspacePurpose !== "conversation",
        ),
        homeWorkspaceLabel,
        searchQuery: workspaceSearchQuery,
      }),
    [homeWorkspaceLabel, workspaceSearchQuery, workspaceTabs],
  );
  const currentWorkspaceTitle = isConversationWorkspace
    ? intl.formatMessage({ id: "chat.empty.selectProject" })
    : getWorkspaceTriggerTitle(workspacePath, homeWorkspaceLabel);
  const CurrentWorkspaceIcon = isCurrentRemoteWorkspace
    ? Cloud
    : homeWorkspacePath === workspacePath
      ? House
      : Folder;

  return (
    <DropdownMenu>
      <div
        className={cn(
          "group/workspace-chip relative flex min-w-0 items-center rounded-full hover:bg-surface-hover focus-within:bg-surface-hover",
          containerClassName,
        )}
      >
        {canDetachProject ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="pointer-events-none absolute left-1.5 z-10 rounded-full text-foreground-subtle opacity-0 transition-opacity group-hover/workspace-chip:pointer-events-auto group-hover/workspace-chip:opacity-100 group-focus-within/workspace-chip:pointer-events-auto group-focus-within/workspace-chip:opacity-100"
            aria-label={intl.formatMessage({ id: "chat.empty.detachProject" })}
            data-testid={TID_COMPOSER_PROJECT_DETACH}
            onClick={(event) => {
              event.stopPropagation();
              void runUserActionAsync({
                input: {
                  featureId: "workspace.project_binding",
                  action: "detach",
                  trigger: "button",
                },
                operation: () => Promise.resolve(onSelectConversationWorkspace()),
                completed: { resultSource: "optimistic_projection" },
                failureStage: "project_detach",
              });
            }}
          >
            <X className="size-3.5" />
          </Button>
        ) : null}
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="default"
            className={cn(
              "min-w-0 rounded-full bg-transparent text-ui-base/relaxed hover:bg-transparent",
              "max-w-[15rem] pl-3 pr-2",
              triggerClassName,
            )}
            aria-label={intl.formatMessage({ id: "chat.empty.workspaceMenu" })}
            data-testid={TID_COMPOSER_WORKSPACE_TRIGGER}
          >
            <CurrentWorkspaceIcon
              className={cn(
                "size-4 text-foreground-subtle transition-opacity",
                // 关闭按钮和项目图标占用同一位置。只有允许脱离项目时才隐藏底层图标，
                // 否则 X 会直接叠在图标上；定时任务禁用该能力时则让项目图标保持可见。
                canDetachProject &&
                  "group-hover/workspace-chip:opacity-0 group-focus-within/workspace-chip:opacity-0",
              )}
            />
            <span className="block max-w-full truncate">{currentWorkspaceTitle}</span>
            {triggerIndicator ?? <ChevronDownIcon className="size-3.5 text-foreground-subtle" />}
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent align="start" side="top" className="w-72 p-0">
        <div
          data-slot="command-input-wrapper"
          className="p-1 border-b border-border"
          onKeyDown={(event) => event.stopPropagation()}
        >
          <InputGroup className="h-8 border-0 !bg-transparent hover:border-input-border-hover ">
            <input
              data-slot="command-input"
              value={workspaceSearchQuery}
              placeholder={intl.formatMessage({
                id: "chat.empty.workspaceSearchPlaceholder",
              })}
              onChange={(event) => setWorkspaceSearchQuery(event.target.value)}
              className="w-full text-ui-base/relaxed text-foreground outline-hidden placeholder:text-foreground-subtlest disabled:cursor-not-allowed disabled:opacity-50"
            />
            <InputGroupAddon>
              <SearchIcon className="size-4 shrink-0 text-foreground-subtlest" />
            </InputGroupAddon>
          </InputGroup>
        </div>
        <div className="p-1">
          {visibleWorkspaceTabs.map((workspaceTab, index) => {
            const workspaceTitle = getWorkspaceListTitle(
              workspaceTab.workspacePath,
              homeWorkspaceLabel,
            );
            const isRemoteWorkspace = hasRemoteWorkspaceIdentity(workspaceTab);
            const WorkspaceIcon = isRemoteWorkspace
              ? Cloud
              : inferWorkspaceHomePath(workspaceTab.workspacePath) === workspaceTab.workspacePath
                ? House
                : Folder;

            return (
              <DropdownMenuCheckboxItem
                key={`${workspaceTab.workspaceIdentity ?? workspaceTab.remoteSessionId ?? "local"}:${workspaceTab.workspacePath}:${index}`}
                checked={isWorkspaceMenuTabSelected(workspaceTab, {
                  workspacePath,
                  workspaceIdentity,
                })}
                onSelect={() => {
                  runUserAction({
                    input: {
                      featureId: isConversationWorkspace
                        ? "workspace.project_binding"
                        : "workspace.local.lifecycle",
                      action: isConversationWorkspace ? "attach" : "switch",
                      trigger: "menu",
                      workspaceKind: isRemoteWorkspace ? "remote" : "local",
                    },
                    operation: () => onSelectWorkspace(workspaceTab),
                    completed: { resultSource: "local_commit" },
                    failureStage: "workspace_switch",
                  });
                }}
              >
                <WorkspaceIcon className="size-4 text-foreground-subtle" />
                <span className="min-w-0 flex-1 truncate">{workspaceTitle}</span>
              </DropdownMenuCheckboxItem>
            );
          })}
          {visibleWorkspaceTabs.length === 0 ? (
            <div className="px-2 py-2 text-ui-base text-foreground-subtlest">
              {intl.formatMessage({ id: "chat.empty.workspaceSearchEmpty" })}
            </div>
          ) : null}

          <DropdownMenuSeparator />
          {allowOpenWorkspace ? (
            <DropdownMenuItem onSelect={onOpenFolder}>
              <FolderPlus className="size-4 text-foreground-subtle" />
              <span>{intl.formatMessage({ id: "workspace.openFolder" })}</span>
            </DropdownMenuItem>
          ) : null}
          {canUseRemoteWorkspace ? (
            <DropdownMenuItem
              data-testid={TID_COMPOSER_REMOTE_CONNECTION}
              onSelect={() => {
                // 打开远程弹窗时必须让 DropdownMenu 执行默认关闭流程。
                // 阻止默认 select 会让父菜单与 modal 同时保持打开，浮层层级调整后父菜单会覆盖弹窗。
                logger.info(
                  `[ChatEmptyWorkspacePreviewMenu] open remote dialog from workspace menu workspace=${workspacePath}`,
                );
                runUserAction({
                  input: {
                    featureId: "workspace.remote.lifecycle",
                    action: "open_dialog",
                    trigger: "menu",
                    workspaceKind: "remote",
                  },
                  operation: () => setSshDialogOpen(true),
                  completed: { resultSource: "local_commit" },
                  failureStage: "dialog_open",
                });
              }}
            >
              <Cloud className="size-4 text-foreground-subtle" />
              <span>{intl.formatMessage({ id: "remote.trigger" })}</span>
            </DropdownMenuItem>
          ) : null}
          {allowConversationWorkspaceSelection ? (
            <DropdownMenuCheckboxItem
              data-testid={TID_COMPOSER_WORK_OUTSIDE_PROJECT}
              checked={isConversationWorkspace}
              onSelect={() =>
                void runUserActionAsync({
                  input: {
                    featureId: "workspace.project_binding",
                    action: "work_outside_project",
                    trigger: "menu",
                  },
                  operation: () => Promise.resolve(onSelectConversationWorkspace()),
                  completed: { resultSource: "optimistic_projection" },
                  failureStage: "project_detach",
                })
              }
            >
              <MessageCircle className="size-4 text-foreground-subtle" />
              <span>{intl.formatMessage({ id: "chat.empty.workOutsideProject" })}</span>
            </DropdownMenuCheckboxItem>
          ) : null}
        </div>
      </DropdownMenuContent>
      {canUseRemoteWorkspace ? (
        <SSHDialog
          onConnect={onConnectRemote}
          onSelectProject={onSelectRemoteProject}
          onCancelSession={onCancelRemoteProject}
          localWorkspacePath={localWorkspacePathForRemoteConnection}
          isWindowsDesktop={isWindowsDesktop}
          remoteWorkspaceSessions={remoteWorkspaceSessions}
          open={sshDialogOpen}
          onOpenChange={setSshDialogOpen}
          hideTriggerWhenClosed
        />
      ) : null}
    </DropdownMenu>
  );
}
