import { TID_TERMINAL_TOGGLE } from "@zcode/shared";
import { SquareTerminalIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { WINDOWS_CAPTION_CONTROL_CLASS } from "@/windowCaptionControls.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";

export function WorkspaceTerminalToggleButton({
  isTerminalOpen,
  onToggleTerminal,
  disabledReason,
  useWindowsCaptionSpacing = false,
}: {
  isTerminalOpen: boolean;
  onToggleTerminal: () => void;
  disabledReason?: string;
  useWindowsCaptionSpacing?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const label = intl.formatMessage({ id: "terminal.toggle" });
  // 展示 label 从快捷键生效表取，用户改键后 tooltip 跟随更新
  const toggleTerminalShortcutLabel = useShortcutCommandLabel("toggleTerminal");

  if (isOfficeMode) return null;

  return (
    <ControlHintTooltip
      title={disabledReason ?? label}
      side="bottom"
      shortcut={toggleTerminalShortcutLabel}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        data-testid={TID_TERMINAL_TOGGLE}
        className={cn(
          "text-foreground hover:bg-hover hover:text-foreground [app-region:no-drag]",
          useWindowsCaptionSpacing && WINDOWS_CAPTION_CONTROL_CLASS,
          isTerminalOpen && "!bg-selected text-foreground",
        )}
        aria-label={label}
        disabled={Boolean(disabledReason)}
        onClick={() =>
          runUserAction({
            input: {
              featureId: "workbench.terminal",
              action: isTerminalOpen ? "close" : "open",
              trigger: "button",
            },
            operation: onToggleTerminal,
            completed: { resultSource: "local_commit" },
            failureStage: "terminal_toggle",
          })
        }
      >
        <SquareTerminalIcon className="size-4" />
      </Button>
    </ControlHintTooltip>
  );
}
