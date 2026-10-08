import { Check, LoaderCircle } from "lucide-react";
import type { BotConfig, BotWorkspaceRef } from "@zcode/shared";
import { ALL_BOT_WORKSPACES } from "@zcode/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";
import { cn } from "@/components/lib/utils.js";
import { isAllWorkspacesAllowed } from "./shared.js";

export function WorkspaceAccessCard({
  bot,
  workspaceRefs,
  currentWorkspace,
  loading,
  onPatchAllowedWorkspaces,
  onToggleWorkspaceAccess,
}: {
  bot: BotConfig;
  workspaceRefs: BotWorkspaceRef[];
  currentWorkspace: BotWorkspaceRef;
  loading: boolean;
  onPatchAllowedWorkspaces: (allowedWorkspaces: string[]) => Promise<void>;
  onToggleWorkspaceAccess: (
    workspaceId: string,
    checked: boolean,
  ) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const allAllowed = isAllWorkspacesAllowed(bot.allowedWorkspaces);
  const allowedCount = allAllowed
    ? workspaceRefs.length
    : bot.allowedWorkspaces.filter((workspaceId) =>
        workspaceRefs.some((workspace) => workspace.id === workspaceId),
      ).length;

  return (
    <SettingsRow
      label={intl.formatMessage({ id: "bots.allowedWorkspaces" })}
      description={intl.formatMessage(
        {
          id: allAllowed
            ? "bots.allowedWorkspaces.allDescription"
            : "bots.allowedWorkspaces.selectedDescription",
        },
        { count: String(allowedCount) },
      )}
      control={
        <div className="flex items-center justify-end gap-2">
          {loading ? (
            <LoaderCircle className="size-4 animate-spin text-foreground-subtle" />
          ) : null}
          <Select
            value={allAllowed ? "all" : "selected"}
            onValueChange={(value) => {
              void onPatchAllowedWorkspaces(
                value === "all" ? [ALL_BOT_WORKSPACES] : [currentWorkspace.id],
              );
            }}
            disabled={loading}
          >
            <SelectTrigger size="lg" className="w-48 justify-between">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {intl.formatMessage({
                  id: "bots.allowedWorkspaces.mode.all",
                })}
              </SelectItem>
              <SelectItem value="selected">
                {intl.formatMessage({
                  id: "bots.allowedWorkspaces.mode.selected",
                })}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      }
      detail={
        allAllowed ? null : (
          <div className="rounded-lg bg-background p-1">
            <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              {workspaceRefs.map((workspace) => {
                const checked = bot.allowedWorkspaces.includes(workspace.id);
                return (
                  <button
                    key={workspace.id}
                    type="button"
                    className="flex min-w-0 items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() =>
                      void onToggleWorkspaceAccess(workspace.id, !checked)
                    }
                    disabled={loading}
                    title={workspace.label}
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center">
                      <div
                        className={cn(
                          "flex size-4 items-center justify-center rounded-sm border",
                          checked
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-input-border bg-input text-transparent",
                        )}
                      >
                        <Check className="size-3.5" />
                      </div>
                    </span>
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="truncate text-ui-base font-medium text-foreground">
                        {workspace.label}
                      </div>
                      <div className="truncate font-mono text-ui-base text-foreground-subtlest">
                        {workspace.workspacePath}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )
      }
    />
  );
}
