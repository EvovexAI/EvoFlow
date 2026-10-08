import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

export interface CuaScreenshotDetails {
  dataUrl: string | null;
  width: number | null;
  height: number | null;
  mimeType: string | null;
  fullScreen: boolean;
  zoom: boolean;
  region: string | null;
  clamped: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function findImageDataUrl(value: unknown, depth = 0): string | null {
  if (depth > 5) return null;
  if (typeof value === "string") {
    return /^data:image\/[a-z0-9.+-]+;base64,/iu.test(value) ? value : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImageDataUrl(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = asRecord(value);
  if (!record) return null;
  const mimeType =
    typeof record.mimeType === "string"
      ? record.mimeType
      : typeof record.mime_type === "string"
        ? record.mime_type
        : null;
  const data = typeof record.data === "string" ? record.data : null;
  if (mimeType?.startsWith("image/") && data && !data.startsWith("data:")) {
    return `data:${mimeType};base64,${data}`;
  }
  for (const child of Object.values(record)) {
    const found = findImageDataUrl(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function collectText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

export function buildCuaScreenshotDetails(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): CuaScreenshotDetails {
  const rawOutput = asRecord(toolCall.raw)?.rawOutput;
  const text = `${collectText(toolCall.output)}\n${collectText(rawOutput)}`;
  const dimensions = /(?:(?:Full-screen\s+)?screenshot|Zoom image)\s+(\d+)x(\d+)px/iu.exec(text);
  const attachedMime = /\[Attached\s+(image\/[a-z0-9.+-]+):/iu.exec(text)?.[1] ?? null;
  const dataUrl = findImageDataUrl(toolCall.output) ?? findImageDataUrl(toolCall.raw);
  const dataMime = /^data:(image\/[a-z0-9.+-]+);base64,/iu.exec(dataUrl ?? "")?.[1] ?? null;

  const input = asRecord(toolCall.input);
  const region =
    Array.isArray(input?.region) &&
    input.region.length === 4 &&
    input.region.every((value) => typeof value === "number")
      ? input.region.join(", ")
      : null;
  return {
    dataUrl,
    width: dimensions ? Number(dimensions[1]) : null,
    height: dimensions ? Number(dimensions[2]) : null,
    mimeType: dataMime ?? attachedMime,
    fullScreen: /Full-screen screenshot\s+\d+x\d+px/iu.test(text),
    zoom: /Zoom image/iu.test(text),
    region,
    clamped: /Region clamped/iu.test(text),
  };
}
