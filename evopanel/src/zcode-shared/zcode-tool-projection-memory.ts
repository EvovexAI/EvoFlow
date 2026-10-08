import type { ZCodeStreamingToolInputState } from "./streaming-tool-input-preview.js";

export interface ZCodeToolProjectionMemory {
  completeToolInputById?: Map<string, unknown>;
  streamingToolInputById?: Map<string, ZCodeStreamingToolInputState>;
  toolNameById?: Map<string, string>;
}

export interface ZCodeToolProjectionMetadata {
  hasInput: boolean;
  input?: unknown;
  toolName?: string;
}

export function createZCodeToolProjectionMemory(): ZCodeToolProjectionMemory {
  return {
    completeToolInputById: new Map<string, unknown>(),
    streamingToolInputById: new Map<string, ZCodeStreamingToolInputState>(),
    toolNameById: new Map<string, string>(),
  };
}

export function ensureZCodeToolProjectionMemory(
  memory: ZCodeToolProjectionMemory,
): ZCodeToolProjectionMemory {
  memory.completeToolInputById ??= new Map<string, unknown>();
  memory.streamingToolInputById ??= new Map<string, ZCodeStreamingToolInputState>();
  memory.toolNameById ??= new Map<string, string>();
  return memory;
}

export function resolveZCodeToolProjectionMetadata(
  payload: Record<string, unknown>,
  toolId: string,
  memory: ZCodeToolProjectionMemory,
): ZCodeToolProjectionMetadata {
  const toolName = readNonEmptyString(payload.toolName) ?? memory.toolNameById?.get(toolId);
  if (toolName) {
    memory.toolNameById?.set(toolId, toolName);
  }

  if ("input" in payload) {
    return {
      hasInput: payload.input !== undefined,
      input: payload.input,
      toolName,
    };
  }

  if (memory.completeToolInputById?.has(toolId)) {
    return {
      hasInput: true,
      input: memory.completeToolInputById.get(toolId),
      toolName,
    };
  }

  return {
    hasInput: false,
    toolName,
  };
}

export function finalizeZCodeToolProjectionInput(
  toolId: string,
  input: unknown,
  memory: ZCodeToolProjectionMemory,
): void {
  memory.completeToolInputById ??= new Map<string, unknown>();
  memory.completeToolInputById.set(toolId, input);
  const streamingState = memory.streamingToolInputById?.get(toolId);
  if (streamingState) {
    streamingState.lastPreviewRawInputLength = streamingState.rawInput.length;
    streamingState.rawInput = "";
  }
}

export function forgetZCodeToolProjectionMetadata(
  toolId: string,
  memory: ZCodeToolProjectionMemory,
): void {
  memory.completeToolInputById?.delete(toolId);
  memory.streamingToolInputById?.delete(toolId);
  memory.toolNameById?.delete(toolId);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
