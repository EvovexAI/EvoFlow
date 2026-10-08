import { Terminal } from "lucide-react";
import type { UserCommand, ZCodeCommand } from "@zcode/shared";
import { isPluginCommand, isUserCommand } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Switch } from "@/components/ui/switch.js";
import { settingsResourceRowInteraction } from "@/settings/settingsResourceRowInteraction.js";
import { PluginStoreAvatar } from "@/settings/PluginStoreAvatar.js";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";

export function isEditableUserCommand(command: ZCodeCommand): command is UserCommand {
  return isUserCommand(command) && command.location.source === "zcode";
}

interface CommandCardProps {
  command: ZCodeCommand;
  onEdit?: (command: ZCodeCommand) => void;
  onToggle?: (command: ZCodeCommand, enabled: boolean) => void;
  isOperating?: boolean;
  pluginIconItem?: Pick<StorePluginItem, "name" | "listing">;
}

export function CommandCard({
  command,
  onEdit,
  onToggle,
  isOperating,
  pluginIconItem,
}: CommandCardProps) {
  const { intl } = useZCodeIntl();
  const canEdit = isEditableUserCommand(command);
  const editable = canEdit && Boolean(onEdit) && !isOperating;

  return (
    <div
      className={`grid cursor-default grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors ${editable ? "hover:bg-hover" : ""}`}
      {...settingsResourceRowInteraction(editable ? () => onEdit?.(command) : undefined)}
    >
      {isPluginCommand(command) && pluginIconItem ? (
        <PluginStoreAvatar
          item={pluginIconItem}
          className="size-9 bg-background"
          fallbackIcon={<Terminal className="size-4" />}
        />
      ) : (
        <div
          className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-background text-foreground-subtle"
          aria-hidden="true"
        >
          <Terminal className="size-4" />
        </div>
      )}

      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-ui-base font-medium text-foreground">{command.name}</span>
          {command.argumentHint ? (
            <span className="text-ui-base text-foreground-subtlest">{command.argumentHint}</span>
          ) : null}
        </div>
        <p className="mt-0.5 line-clamp-2 text-ui-sm text-foreground-subtle">
          {command.description || intl.formatMessage({ id: "settings.commands.noDescription" })}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {isUserCommand(command) && onToggle ? (
          <Switch
            checked={command.enabled}
            onCheckedChange={(enabled) => onToggle(command, enabled)}
            disabled={isOperating}
          />
        ) : null}
      </div>
    </div>
  );
}
