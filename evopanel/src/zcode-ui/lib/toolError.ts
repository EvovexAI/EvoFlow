import type { TaskChatToolCall as ChatToolCall } from "@/lib/taskChatMessageTypes.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readFirstStringField(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = readNonEmptyString(record[key]);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function stripMarkdownCodeFence(text: string): string {
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/^```[\w-]*\n?([\s\S]*?)\n?```$/);
  return fencedMatch?.[1]?.trim() ?? trimmed;
}

export function normalizeWrappedErrorText(text: string): string {
  const unwrappedFenceText = stripMarkdownCodeFence(text);
  const wrappedErrorMatch = unwrappedFenceText.match(
    /^<tool_use_error>([\s\S]*?)<\/tool_use_error>$/i,
  );

  return wrappedErrorMatch?.[1]?.trim() || unwrappedFenceText;
}

function readTaggedToolErrorText(value: unknown): string | undefined {
  const text = readNonEmptyString(value);
  if (!text || !/<tool_use_error>[\s\S]*<\/tool_use_error>/i.test(text)) {
    return undefined;
  }

  return normalizeWrappedErrorText(text);
}

export function getToolCallErrorText(
  toolCall: Pick<ChatToolCall, "error" | "output" | "raw" | "status">,
): string | undefined {
  const directError = readNonEmptyString(toolCall.error);
  if (directError) {
    return directError;
  }

  if (isRecord(toolCall.output)) {
    const outputError = readFirstStringField(toolCall.output, ["error", "message"]);
    if (outputError) {
      return outputError;
    }
  }

  const taggedOutputError = readTaggedToolErrorText(toolCall.output);
  if (taggedOutputError) {
    return taggedOutputError;
  }

  if (!isRecord(toolCall.raw)) {
    return undefined;
  }

  const rawOutput = isRecord(toolCall.raw.rawOutput) ? toolCall.raw.rawOutput : null;
  const rawOutputError = rawOutput
    ? readFirstStringField(rawOutput, ["error", "message"])
    : undefined;
  if (rawOutputError) {
    return rawOutputError;
  }

  const rawStatus = readNonEmptyString(toolCall.raw.status);
  const taggedRawOutputError = readTaggedToolErrorText(toolCall.raw.rawOutput);
  if (taggedRawOutputError) {
    return taggedRawOutputError;
  }

  if (toolCall.status === "failed" || rawStatus === "failed") {
    const contentBlocks = Array.isArray(toolCall.raw.content) ? toolCall.raw.content : [];
    for (const block of contentBlocks) {
      if (!isRecord(block)) {
        continue;
      }

      const nestedContent = isRecord(block.content) ? block.content : null;
      const blockError = nestedContent
        ? readFirstStringField(nestedContent, ["error", "message", "text"])
        : readFirstStringField(block, ["error", "message", "text"]);
      if (blockError) {
        return normalizeWrappedErrorText(blockError);
      }
    }
  }

  return undefined;
}
