import { createUuid } from "@zcode/shared";

export type WhiteboardTool = "pen" | "eraser";

export interface WhiteboardPoint {
  x: number;
  y: number;
}

export interface WhiteboardStroke {
  id: string;
  tool: WhiteboardTool;
  color: string;
  width: number;
  points: WhiteboardPoint[];
}

export interface WhiteboardDocument {
  id: string;
  name: string;
  width: number;
  height: number;
  strokes: WhiteboardStroke[];
  undoneStrokes: WhiteboardStroke[];
  createdAt: number;
  updatedAt: number;
}

interface WhiteboardAddToChatPayload {
  workspacePath: string;
  workspaceIdentity?: string;
  boardId: string;
}

const WHITEBOARD_CANVAS_WIDTH = 1280;
const WHITEBOARD_CANVAS_HEIGHT = 800;
export const WHITEBOARD_DEFAULT_COLOR = "#111827";
export const WHITEBOARD_ADD_TO_CHAT_EVENT = "zcode:add-whiteboard-to-chat";
const WHITEBOARD_BACKGROUND_COLOR = "#ffffff";

export function buildWhiteboardWorkspaceKey({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  return workspaceIdentity?.trim() || workspacePath;
}

export function createWhiteboardDocument(params: {
  existingNames: readonly string[];
  defaultNamePrefix: string;
}): WhiteboardDocument {
  const now = Date.now();
  return {
    id: `whiteboard:${createUuid()}`,
    name: createUniqueWhiteboardName(params.existingNames, params.defaultNamePrefix),
    width: WHITEBOARD_CANVAS_WIDTH,
    height: WHITEBOARD_CANVAS_HEIGHT,
    strokes: [],
    undoneStrokes: [],
    createdAt: now,
    updatedAt: now,
  };
}

function createUniqueWhiteboardName(
  existingNames: readonly string[],
  defaultNamePrefix: string,
): string {
  const normalizedPrefix = defaultNamePrefix.trim() || "Whiteboard";
  const usedNames = new Set(existingNames.map((name) => name.trim()));
  let index = 1;
  while (usedNames.has(`${normalizedPrefix} ${index}`)) {
    index += 1;
  }
  return `${normalizedPrefix} ${index}`;
}

export function createWhiteboardStroke(params: {
  tool: WhiteboardTool;
  color: string;
  width: number;
  points: WhiteboardPoint[];
}): WhiteboardStroke {
  return {
    id: `stroke:${createUuid()}`,
    tool: params.tool,
    color: params.color,
    width: params.width,
    points: params.points,
  };
}

export function drawWhiteboardDocument(
  context: CanvasRenderingContext2D,
  board: Pick<WhiteboardDocument, "height" | "strokes" | "width">,
  options: {
    backgroundColor?: string;
    draftStroke?: WhiteboardStroke | null;
    scale?: number;
  } = {},
) {
  const scale = options.scale ?? 1;
  const backgroundColor = options.backgroundColor ?? WHITEBOARD_BACKGROUND_COLOR;
  context.save();
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, board.width, board.height);
  context.fillStyle = backgroundColor;
  context.fillRect(0, 0, board.width, board.height);
  for (const stroke of [...board.strokes, ...(options.draftStroke ? [options.draftStroke] : [])]) {
    drawWhiteboardStroke(context, stroke, backgroundColor);
  }
  context.restore();
}

function drawWhiteboardStroke(
  context: CanvasRenderingContext2D,
  stroke: WhiteboardStroke,
  backgroundColor: string,
) {
  const firstPoint = stroke.points[0];
  if (!firstPoint) {
    return;
  }

  context.save();
  context.globalCompositeOperation = "source-over";
  context.strokeStyle = stroke.tool === "eraser" ? backgroundColor : stroke.color;
  context.fillStyle = stroke.tool === "eraser" ? backgroundColor : stroke.color;
  context.lineWidth = stroke.width;
  context.lineCap = "round";
  context.lineJoin = "round";

  if (stroke.points.length === 1) {
    context.beginPath();
    context.arc(firstPoint.x, firstPoint.y, stroke.width / 2, 0, Math.PI * 2);
    context.fill();
    context.restore();
    return;
  }

  context.beginPath();
  context.moveTo(firstPoint.x, firstPoint.y);
  for (const point of stroke.points.slice(1)) {
    context.lineTo(point.x, point.y);
  }
  context.stroke();
  context.restore();
}

function exportWhiteboardDataUrl(board: WhiteboardDocument): string {
  const canvas = document.createElement("canvas");
  canvas.width = board.width;
  canvas.height = board.height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas context is unavailable.");
  }
  drawWhiteboardDocument(context, board);
  return canvas.toDataURL("image/png");
}

export function createWhiteboardPngFile(board: WhiteboardDocument): File {
  const dataUrl = exportWhiteboardDataUrl(board);
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) {
    throw new Error("Whiteboard image data is invalid.");
  }

  const binary = atob(dataUrl.slice(commaIndex + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new File([bytes], `${sanitizeWhiteboardFilename(board.name)}.png`, {
    type: "image/png",
  });
}

export function isWhiteboardAddToChatEvent(
  event: Event,
): event is CustomEvent<WhiteboardAddToChatPayload> {
  return (
    event.type === WHITEBOARD_ADD_TO_CHAT_EVENT &&
    typeof CustomEvent !== "undefined" &&
    event instanceof CustomEvent &&
    isWhiteboardAddToChatPayload(event.detail)
  );
}

export function dispatchWhiteboardAddToChat(payload: WhiteboardAddToChatPayload): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const event = new CustomEvent(WHITEBOARD_ADD_TO_CHAT_EVENT, {
    cancelable: true,
    detail: payload,
  });
  return !window.dispatchEvent(event);
}

function sanitizeWhiteboardFilename(name: string): string {
  const normalizedName = Array.from(name.trim().replace(/[<>:"/\\|?*]+/gu, "-"))
    .filter((character) => character.charCodeAt(0) >= 32)
    .join("");
  return normalizedName.replace(/^\.+|\.+$/gu, "") || "whiteboard";
}

function isWhiteboardAddToChatPayload(value: unknown): value is WhiteboardAddToChatPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const payload = value as Partial<WhiteboardAddToChatPayload>;
  return (
    typeof payload.workspacePath === "string" &&
    payload.workspacePath.length > 0 &&
    typeof payload.boardId === "string" &&
    payload.boardId.length > 0 &&
    (payload.workspaceIdentity === undefined || typeof payload.workspaceIdentity === "string")
  );
}
