export type SidebarTaskGroupToggleMessageId =
  | "workspaceSidebar.collapseAllGroups"
  | "workspaceSidebar.expandAllGroups";

export interface SidebarTaskGroupTogglePresentation {
  canToggle: boolean;
  areAllExpanded: boolean;
  messageId: SidebarTaskGroupToggleMessageId;
}

interface SidebarTaskGroupToggleRawState {
  visible: boolean;
  canToggle: boolean;
  areAllExpanded: boolean;
  transitionPending: boolean;
}

function resolveSidebarTaskGroupToggleMessageId(
  areAllExpanded: boolean,
): SidebarTaskGroupToggleMessageId {
  return areAllExpanded ? "workspaceSidebar.collapseAllGroups" : "workspaceSidebar.expandAllGroups";
}

export function resolveSidebarTaskGroupTogglePresentation(params: {
  current: SidebarTaskGroupToggleRawState;
  previous: SidebarTaskGroupTogglePresentation | null;
}): SidebarTaskGroupTogglePresentation | null {
  if (!params.current.visible) {
    return null;
  }

  if (params.current.transitionPending && params.previous) {
    return params.previous;
  }

  return {
    canToggle: params.current.canToggle,
    areAllExpanded: params.current.areAllExpanded,
    messageId: resolveSidebarTaskGroupToggleMessageId(params.current.areAllExpanded),
  };
}
