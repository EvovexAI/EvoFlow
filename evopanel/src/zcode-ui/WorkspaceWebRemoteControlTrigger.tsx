import { useState } from "react";
import { Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { WebRemoteControlDialog } from "@/WebRemoteControlDialog.js";

export function WorkspaceWebRemoteControlTrigger({
  workspacePath,
  workspaceIdentity,
  compact = false,
  className,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  compact?: boolean;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const [webRemoteControlOpen, setWebRemoteControlOpen] = useState(false);
  return (
    <>
      <ControlHintTooltip
        title={intl.formatMessage({ id: "webRemoteControl.trigger" })}
        side="top"
        align="center"
        triggerClassName={compact ? undefined : "w-full"}
      >
        <Button
          variant="ghost"
          onClick={() => {
            logger.info("[WorkspaceWebRemoteControlTrigger] 打开远程控制弹层", {
              workspacePath,
              workspaceIdentity: workspaceIdentity ?? "none",
            });
            setWebRemoteControlOpen(true);
          }}
          size={compact ? "icon-lg" : "lg"}
          aria-label={intl.formatMessage({ id: "webRemoteControl.trigger" })}
          className={cn(
            compact
              ? "text-foreground hover:bg-surface-hover hover:text-foreground"
              : "w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground",
            className,
          )}
        >
          {/* 入口统一使用远程控制图标，具体 Bot 渠道在弹层内区分。 */}
          <Smartphone className="size-4 text-foreground-subtle" />
          {compact ? (
            <span className="sr-only">
              {intl.formatMessage({ id: "webRemoteControl.trigger" })}
            </span>
          ) : (
            intl.formatMessage({ id: "webRemoteControl.trigger" })
          )}
        </Button>
      </ControlHintTooltip>
      <WebRemoteControlDialog
        open={webRemoteControlOpen}
        onOpenChange={setWebRemoteControlOpen}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
      />
    </>
  );
}
