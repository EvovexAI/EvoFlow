import type { WorkspaceSidePaneState, WorkspaceSidePaneTab } from "@/lib/workspaceSidePane.js";
import { getActiveSidePaneTab } from "@/lib/workspaceSidePane.js";

export const CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT = "zcode:close-active-context-request";

export function getCloseActiveContextSidePaneTab(options: {
  isWorkspaceVisible: boolean;
  isSidePaneCollapsed: boolean;
  sidePaneState: WorkspaceSidePaneState | null;
}): WorkspaceSidePaneTab | null {
  if (!options.isWorkspaceVisible || options.isSidePaneCollapsed) {
    return null;
  }

  return getActiveSidePaneTab(options.sidePaneState);
}
