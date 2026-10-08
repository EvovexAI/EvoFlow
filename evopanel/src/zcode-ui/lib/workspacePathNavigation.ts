import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";

const WORKSPACE_PATH_OPEN_REQUEST_EVENT = "zcode:workspace-path-open-request";

export interface WorkspacePathOpenRequest extends MessageFileLinkTarget {
  serviceScope?: "workspace" | "base-local";
}

export function selectWorkspacePathFileService<T>(
  target: WorkspacePathOpenRequest,
  workspaceFileService: T,
  baseFileService: T,
): T {
  return target.serviceScope === "base-local" ? baseFileService : workspaceFileService;
}

export function shouldFallbackWorkspacePathToCodeViewer(target: WorkspacePathOpenRequest): boolean {
  return target.serviceScope !== "base-local";
}

export function addWorkspacePathOpenRequestListener(
  listener: (target: WorkspacePathOpenRequest) => void,
): () => void {
  const handleRequest = (event: Event) => {
    const target = (event as CustomEvent<WorkspacePathOpenRequest>).detail;
    if (!target || typeof target.path !== "string") return;
    listener(target);
  };
  window.addEventListener(WORKSPACE_PATH_OPEN_REQUEST_EVENT, handleRequest);
  return () => window.removeEventListener(WORKSPACE_PATH_OPEN_REQUEST_EVENT, handleRequest);
}
