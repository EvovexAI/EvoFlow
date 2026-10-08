export function applyWorkspaceTriggerSelection({
  tabId,
  workspacePath,
  isExpanded,
  activateTab,
  toggleWorkspaceExpanded,
}: {
  tabId: string;
  workspacePath: string;
  isExpanded: boolean;
  activateTab: (tabId: string) => void;
  toggleWorkspaceExpanded: (workspacePath: string) => void;
}) {
  activateTab(tabId);

  if (isExpanded) {
    toggleWorkspaceExpanded(workspacePath);
  }
}
