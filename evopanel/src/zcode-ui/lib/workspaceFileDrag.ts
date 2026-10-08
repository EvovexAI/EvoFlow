import { buildFileMentionMarkdown } from "@/mentions/mentionMarkdown.js";

export const WORKSPACE_FILE_DRAG_MIME = "application/x-zcode-workspace-file";
export const WORKSPACE_FILE_ADD_TO_CHAT_EVENT = "zcode:add-workspace-file-to-chat";
export const WORKSPACE_FILE_DRAG_STATE_EVENT = "zcode:workspace-file-drag-state";

export interface WorkspaceFileDragPayload {
  type: "file" | "directory";
  workspacePath: string;
  workspaceIdentity?: string;
  path: string;
  relativePath: string;
  name: string;
}

interface WorkspaceFileComposerMention {
  markdown: string;
  value: string;
  data: {
    kind: WorkspaceFileDragPayload["type"];
    path: string;
    relativePath: string;
  };
}

interface WorkspaceFileDragStateDetail {
  dragging: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function serializeWorkspaceFileDragPayload(payload: WorkspaceFileDragPayload): string {
  return JSON.stringify(payload);
}

function parseWorkspaceFileDragPayload(
  rawPayload: string | null | undefined,
): WorkspaceFileDragPayload | null {
  if (!rawPayload) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(rawPayload);
    if (!isRecord(parsed)) {
      return null;
    }

    const type = parsed.type;
    const workspacePath = parsed.workspacePath;
    const path = parsed.path;
    const relativePath = parsed.relativePath;
    const name = parsed.name;
    const workspaceIdentity = parsed.workspaceIdentity;

    if (
      (type !== "file" && type !== "directory") ||
      typeof workspacePath !== "string" ||
      typeof path !== "string" ||
      typeof relativePath !== "string" ||
      typeof name !== "string"
    ) {
      return null;
    }

    return {
      type,
      workspacePath,
      path,
      relativePath,
      name,
      ...(typeof workspaceIdentity === "string" && workspaceIdentity.trim()
        ? { workspaceIdentity }
        : {}),
    };
  } catch {
    return null;
  }
}

export function readWorkspaceFileDragPayload(
  dataTransfer: DataTransfer,
): WorkspaceFileDragPayload | null {
  if (!hasWorkspaceFileDragPayload(dataTransfer)) {
    return null;
  }

  return parseWorkspaceFileDragPayload(dataTransfer.getData(WORKSPACE_FILE_DRAG_MIME));
}

export function hasWorkspaceFileDragPayload(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(WORKSPACE_FILE_DRAG_MIME);
}

export function isWorkspaceFileDragStateEvent(
  event: Event,
): event is CustomEvent<WorkspaceFileDragStateDetail> {
  return event.type === WORKSPACE_FILE_DRAG_STATE_EVENT;
}

export function dispatchWorkspaceFileDragState(dragging: boolean): void {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<WorkspaceFileDragStateDetail>(WORKSPACE_FILE_DRAG_STATE_EVENT, {
      detail: { dragging },
    }),
  );
}

export function isWorkspaceFileAddToChatEvent(
  event: Event,
): event is CustomEvent<WorkspaceFileDragPayload> {
  return event.type === WORKSPACE_FILE_ADD_TO_CHAT_EVENT;
}

export function dispatchWorkspaceFileAddToChat(payload: WorkspaceFileDragPayload): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const event = new CustomEvent(WORKSPACE_FILE_ADD_TO_CHAT_EVENT, {
    cancelable: true,
    detail: payload,
  });
  return !window.dispatchEvent(event);
}

function isWorkspaceFilePayloadForWorkspace(
  payload: Pick<WorkspaceFileDragPayload, "workspacePath" | "workspaceIdentity">,
  workspacePath: string,
  workspaceIdentity?: string,
): boolean {
  return (
    payload.workspacePath === workspacePath &&
    (payload.workspaceIdentity ?? "") === (workspaceIdentity ?? "")
  );
}

export function createWorkspaceFileComposerMention(
  payload: WorkspaceFileDragPayload,
  workspacePath: string,
  workspaceIdentity?: string,
): WorkspaceFileComposerMention {
  const sameWorkspace = isWorkspaceFilePayloadForWorkspace(
    payload,
    workspacePath,
    workspaceIdentity,
  );
  const mentionTarget = sameWorkspace ? payload.relativePath : payload.path;

  return {
    markdown: buildFileMentionMarkdown(mentionTarget, payload.name, payload.type),
    value: mentionTarget,
    data: {
      kind: payload.type,
      path: payload.path,
      relativePath: mentionTarget,
    },
  };
}
