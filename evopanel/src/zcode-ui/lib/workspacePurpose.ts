import type { WorkspacePurpose } from "@zcode/shared";
import type { WorkspaceTabState } from "@/store/tabStore.js";

function getWorkspacePurpose(target: { workspacePurpose?: WorkspacePurpose }): WorkspacePurpose {
  return target.workspacePurpose === "conversation" ? "conversation" : "project";
}

export function partitionWorkspaceTabsByPurpose(workspaceTabs: WorkspaceTabState[]): {
  allTaskWorkspaceTabs: WorkspaceTabState[];
  conversationWorkspaceTabs: WorkspaceTabState[];
  projectWorkspaceTabs: WorkspaceTabState[];
} {
  const conversationWorkspaceTabs: WorkspaceTabState[] = [];
  const projectWorkspaceTabs: WorkspaceTabState[] = [];
  for (const tab of workspaceTabs) {
    if (getWorkspacePurpose(tab) === "conversation") {
      conversationWorkspaceTabs.push(tab);
    } else {
      projectWorkspaceTabs.push(tab);
    }
  }
  return {
    allTaskWorkspaceTabs: workspaceTabs,
    conversationWorkspaceTabs,
    projectWorkspaceTabs,
  };
}
