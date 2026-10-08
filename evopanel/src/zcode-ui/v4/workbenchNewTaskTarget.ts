import {
  effectiveFocusedPaneId,
  V4_PRIMARY_PANE_ID,
  type PaneLayoutSnapshot,
  type PaneWorkspaceScope,
} from "@/v4/paneLayoutStore.js";
import { selectWorkbenchGroupPaneBinding, type WorkbenchGroup } from "@/v4/workbenchGroupStore.js";

export interface WorkbenchNewTaskTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

function targetFromScope(scope: PaneWorkspaceScope): WorkbenchNewTaskTarget {
  return {
    workspacePath: scope.workspacePath,
    ...(scope.workspaceIdentity?.trim() ? { workspaceIdentity: scope.workspaceIdentity } : {}),
  };
}

export function resolveWorkbenchNewTaskTarget({
  activeWorkspacePath,
  activeWorkspaceIdentity,
  activeGroup,
  paneLayout,
}: {
  activeWorkspacePath: string | null;
  activeWorkspaceIdentity?: string | null;
  activeGroup: WorkbenchGroup | null;
  paneLayout: PaneLayoutSnapshot;
}): WorkbenchNewTaskTarget | null {
  if (activeGroup) {
    const binding = selectWorkbenchGroupPaneBinding(activeGroup, activeGroup.focusedPaneId);
    if (binding) {
      return targetFromScope(binding.workspaceScope);
    }
  }

  const focusedPaneId = effectiveFocusedPaneId(paneLayout);
  if (focusedPaneId !== V4_PRIMARY_PANE_ID) {
    const binding = paneLayout.panes[focusedPaneId];
    if (binding) {
      return targetFromScope(binding.workspaceScope);
    }
  }

  return activeWorkspacePath
    ? {
        workspacePath: activeWorkspacePath,
        ...(activeWorkspaceIdentity?.trim() ? { workspaceIdentity: activeWorkspaceIdentity } : {}),
      }
    : null;
}
