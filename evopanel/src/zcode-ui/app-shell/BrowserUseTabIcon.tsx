import { MousePointer2Icon } from "lucide-react";
import { BrowserTabFavicon } from "@/app-shell/BrowserTabFavicon.js";
import { useBrowserUseOperationActive } from "@/browser-use/useBrowserUseOperationActive.js";
import type { BrowserUseSidePaneTab } from "@/lib/workspaceSidePane.js";

export function BrowserUseTabIcon({ tab }: { tab: BrowserUseSidePaneTab }) {
  const isAgentOperating = useBrowserUseOperationActive(tab.browserUseOperationUntil);

  if (isAgentOperating) {
    return (
      <span
        aria-hidden="true"
        data-browser-use-operation-indicator="active"
        className="browser-use-operation-breathe inline-flex size-3.5 shrink-0 items-center justify-center"
      >
        <MousePointer2Icon className="size-3.5" />
      </span>
    );
  }

  return <BrowserTabFavicon faviconUrl={tab.faviconUrl} />;
}
