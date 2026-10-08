import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { CodeViewerWorkspaceScope } from "@/lib/codeViewerWorkspaceScope.js";

export function buildChangeSummaryFilePreviewSource(
  input: {
    path: string;
    relativePath: string;
    workspacePath: string;
  } & CodeViewerWorkspaceScope,
): CodeViewerSource {
  const { path, relativePath, workspacePath, workspaceIdentity, workspaceRemoteSessionId } = input;
  return {
    type: "file",
    title: relativePath,
    path,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {}),
  };
}
