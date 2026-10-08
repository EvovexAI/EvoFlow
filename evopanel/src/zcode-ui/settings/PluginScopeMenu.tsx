import { ChevronDown, Cloud, Folder, Monitor } from "lucide-react";
import { testId } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getWorkspaceKey } from "@/lib/workspaceKey.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

export function getPluginWorkspaceKey(tab: WorkspaceTabState): string {
  return getWorkspaceKey(tab.workspacePath, tab.workspaceIdentity);
}

export function isPluginScopeWorkspaceConnected(tab: WorkspaceTabState): boolean {
  // 持久化 tab 会保留已经断开的远端项目和已失效的本地目录；Scope 若继续展示，
  // 用户会选中一个没有可用 service target 的项目。远端必须有当前 session，本地必须仍可用。
  if (tab.availability === "unavailable-local-directory") {
    return false;
  }
  const isRemote = Boolean(
    tab.workspaceIdentity?.trim() || tab.remoteTarget || tab.remoteSessionId,
  );
  if (!isRemote) {
    return true;
  }
  return Boolean(tab.remoteSessionId);
}

export function PluginScopeMenu({
  align = "start",
  disabled = false,
  includeUser = true,
  selectedScopeKey,
  triggerIconTestId,
  triggerTestId,
  userOptionTestId,
  workspaceOptionTestIdPrefix,
  workspaceOptions,
  workspaceTabs = [],
  onScopeKeyChange,
}: {
  align?: "start" | "center" | "end";
  disabled?: boolean;
  includeUser?: boolean;
  selectedScopeKey: string;
  triggerIconTestId?: string;
  triggerTestId?: string;
  userOptionTestId?: string;
  workspaceOptionTestIdPrefix?: string;
  workspaceOptions?: Array<{ key: string; label: string; remote?: boolean }>;
  workspaceTabs?: WorkspaceTabState[];
  onScopeKeyChange: (scopeKey: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const scopeWorkspaces =
    workspaceOptions ??
    workspaceTabs.filter(isPluginScopeWorkspaceConnected).map((tab) => ({
      key: getPluginWorkspaceKey(tab),
      label: tab.label,
      remote: Boolean(tab.remoteTarget || tab.remoteSessionId),
    }));
  const selectedWorkspace = scopeWorkspaces.find((workspace) => workspace.key === selectedScopeKey);
  const SelectedWorkspaceIcon = selectedWorkspace?.remote ? Cloud : Folder;
  // 用户作用域是本机配置范围，不能使用登录账号或设备用户名代替其语义。
  const userLabel = intl.formatMessage({ id: "settings.plugin.scope.user" });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          type="button"
          variant="outline"
          size="default"
          data-testid={triggerTestId}
          data-plugin-scope-trigger="true"
          data-plugin-scope-key={selectedScopeKey}
          className="rounded-full"
        >
          {selectedWorkspace || !includeUser ? (
            <SelectedWorkspaceIcon
              className="size-4"
              aria-hidden="true"
              data-testid={triggerIconTestId}
            />
          ) : (
            <Monitor className="size-4" aria-hidden="true" data-testid={triggerIconTestId} />
          )}
          <span className="max-w-48 truncate">{selectedWorkspace?.label ?? userLabel}</span>
          <ChevronDown className="size-4 text-foreground-subtlest" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-64 max-w-[calc(100vw-2rem)]">
        <DropdownMenuRadioGroup value={selectedScopeKey} onValueChange={onScopeKeyChange}>
          {includeUser ? (
            <DropdownMenuRadioItem value="user" data-testid={userOptionTestId}>
              <Monitor className="size-4" aria-hidden="true" />
              <span className="truncate text-ui-base font-medium text-foreground">{userLabel}</span>
            </DropdownMenuRadioItem>
          ) : null}
          {scopeWorkspaces.length > 0 ? (
            <>
              {includeUser ? <DropdownMenuSeparator /> : null}
              <DropdownMenuLabel>
                {intl.formatMessage({
                  id: "settings.plugin.scope.workspaces",
                })}
              </DropdownMenuLabel>
              {scopeWorkspaces.map((workspace) => {
                const WorkspaceIcon = workspace.remote ? Cloud : Folder;
                return (
                  <DropdownMenuRadioItem
                    key={workspace.key}
                    value={workspace.key}
                    data-testid={
                      workspaceOptionTestIdPrefix
                        ? testId(workspaceOptionTestIdPrefix, workspace.key)
                        : undefined
                    }
                    className="items-start py-2"
                  >
                    <WorkspaceIcon className="mt-0.5 size-4" aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="block truncate text-ui-base font-medium text-foreground">
                        {workspace.label}
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                );
              })}
            </>
          ) : null}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
