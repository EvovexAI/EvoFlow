import { PanelLeftOpen } from "lucide-react";
import appLogoUrl from "@/assets/provider-icons/logo-zai.svg";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function WorkspaceSidebarCollapsedRail({
  onToggleSidebar,
  toggleSidebarShortcutLabel,
}: {
  onToggleSidebar: () => void;
  toggleSidebarShortcutLabel?: string;
}) {
  const { intl } = useZCodeIntl();

  return (
    <aside className="flex h-full flex-col overflow-hidden border-r border-border bg-background-alt">
      <div className="flex h-9 shrink-0 items-center justify-center border-b border-border bg-background-alt px-1.5 [app-region:drag]">
        <div className="[app-region:no-drag]">
          <ControlHintTooltip
            title={intl.formatMessage({ id: "workspaceSidebar.toggleSidebar" })}
            shortcut={toggleSidebarShortcutLabel}
            side="bottom"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              className="group relative overflow-hidden rounded-lg"
              onClick={onToggleSidebar}
              aria-label={intl.formatMessage({
                id: "workspaceSidebar.toggleSidebar",
              })}
            >
              <img
                src={appLogoUrl}
                alt="ZCode"
                className="size-5 transition-opacity group-hover:opacity-0"
                draggable={false}
              />
              <PanelLeftOpen className="absolute size-4 opacity-0 transition-opacity group-hover:opacity-100" />
            </Button>
          </ControlHintTooltip>
        </div>
      </div>
    </aside>
  );
}
