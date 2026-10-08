import { PanelLeftOpen } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

interface ConversationShareSelectionReopenTabProps {
  onOpen: () => void;
}

export function ConversationShareSelectionReopenTab({
  onOpen,
}: ConversationShareSelectionReopenTabProps) {
  const { intl } = useZCodeIntl();

  return (
    <Button
      type="button"
      variant="outline"
      size="icon-md"
      data-testid="conversation-share-selection-reopen"
      data-conversation-share-left-navigation="true"
      aria-label={intl.formatMessage({ id: "conversationShare.selection.reopen" })}
      onClick={onOpen}
      className="pointer-events-auto absolute left-0 top-1/2 z-30 -translate-y-1/2 rounded-l-none rounded-r-lg border-l-0 bg-popover text-popover-foreground shadow-sm hover:bg-menu-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-input-border-focused"
    >
      <PanelLeftOpen className="size-4" aria-hidden="true" />
    </Button>
  );
}
