import type { PaneSplitSide } from "@/v4/paneLayoutTree.js";

export const WORKBENCH_SESSION_DRAG_MIME = "application/x-zcode-session";

export interface WorkbenchSessionDragPayload {
  readonly kind: "zcode/session";
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly remoteSessionId?: string;
  readonly sessionId: string;
}

let activeWorkbenchSessionDragPayload: WorkbenchSessionDragPayload | null = null;

interface DataTransferLike {
  readonly types?: Iterable<string> | ArrayLike<string>;
  getData(type: string): string;
}

interface RectLike {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function serializeWorkbenchSessionDragPayload(payload: WorkbenchSessionDragPayload): string {
  return JSON.stringify(payload);
}

export function setActiveWorkbenchSessionDragPayload(payload: WorkbenchSessionDragPayload): void {
  activeWorkbenchSessionDragPayload = payload;
}

export function clearActiveWorkbenchSessionDragPayload(): void {
  activeWorkbenchSessionDragPayload = null;
}

function dataTransferHasType(dataTransfer: DataTransferLike): boolean {
  return Array.from(dataTransfer.types ?? []).includes(WORKBENCH_SESSION_DRAG_MIME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseWorkbenchSessionDragPayload(
  dataTransfer: DataTransferLike,
): WorkbenchSessionDragPayload | null {
  if (!dataTransferHasType(dataTransfer)) {
    return null;
  }
  try {
    const raw = dataTransfer.getData(WORKBENCH_SESSION_DRAG_MIME);
    if (!raw) {
      return activeWorkbenchSessionDragPayload;
    }
    const parsed = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      parsed.kind !== "zcode/session" ||
      typeof parsed.workspacePath !== "string" ||
      typeof parsed.sessionId !== "string"
    ) {
      return null;
    }
    return {
      kind: "zcode/session",
      workspacePath: parsed.workspacePath,
      workspaceIdentity:
        typeof parsed.workspaceIdentity === "string" ? parsed.workspaceIdentity : undefined,
      remoteSessionId:
        typeof parsed.remoteSessionId === "string" ? parsed.remoteSessionId : undefined,
      sessionId: parsed.sessionId,
    };
  } catch {
    return null;
  }
}

export function resolveWorkbenchDropSide(
  rect: RectLike,
  clientX: number,
  clientY: number,
): PaneSplitSide | null {
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }

  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) {
    return null;
  }

  const distances: Array<readonly [PaneSplitSide, number]> = [
    ["left", x],
    ["right", 1 - x],
    ["up", y],
    ["down", 1 - y],
  ];
  const [side, distance] = distances.reduce((best, candidate) =>
    candidate[1] < best[1] ? candidate : best,
  );

  return distance <= 0.32 ? side : null;
}
