import { useState } from "react";
import { AlertCircleIcon } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function RemoteSkillSyncTitle() {
  const { intl } = useZCodeIntl();
  const [warningTooltipOpen, setWarningTooltipOpen] = useState(false);
  const warningTitle = intl.formatMessage({
    id: "settings.skills.remoteSync.warningTitle",
  });

  return (
    <DialogTitle className="flex min-w-0 items-center gap-2 pr-8">
      <span className="min-w-0 truncate">
        {intl.formatMessage({ id: "settings.skills.remoteSync.title" })}
      </span>
      <ControlHintTooltip
        open={warningTooltipOpen}
        title={warningTitle}
        description={intl.formatMessage({
          id: "settings.skills.remoteSync.warningDescription",
        })}
        side="right"
        align="center"
      >
        <span
          aria-label={warningTitle}
          className="inline-flex size-5 items-center justify-center rounded-full text-warning transition-colors hover:bg-hover hover:text-warning focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
          onMouseEnter={() => setWarningTooltipOpen(true)}
          onMouseLeave={() => setWarningTooltipOpen(false)}
          role="img"
        >
          <AlertCircleIcon className="size-3.5" aria-hidden="true" />
        </span>
      </ControlHintTooltip>
    </DialogTitle>
  );
}
