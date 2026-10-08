export type CompactToolCallState =
  | "input-available"
  | "input-streaming"
  | "output-available"
  | "output-denied"
  | "output-error";

export interface ToolCallSummarySource {
  title?: string;
  kind: string;
  input: unknown;
  output?: unknown;
  raw?: unknown;
}

export interface ToolCallChangeStat {
  added: number;
  removed: number;
}

export interface ToolCallSummary {
  primaryText: string;
  secondaryText?: string;
  changeStat?: ToolCallChangeStat;
}

const TOOL_CALL_RUNNING_STATES = new Set<CompactToolCallState>([
  "input-streaming",
  "input-available",
]);

const TOOL_CALL_FINISHED_STATES = new Set<CompactToolCallState>([
  "output-available",
  "output-error",
  "output-denied",
]);

const TOOL_CALL_STATUS_MESSAGE_IDS: Record<CompactToolCallState, string> = {
  "input-streaming": "chat.toolCall.status.pending",
  "input-available": "chat.toolCall.status.running",
  "output-available": "chat.toolCall.status.completed",
  "output-error": "chat.toolCall.status.failed",
  "output-denied": "chat.toolCall.status.denied",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDisplayText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function countLines(value: string): number {
  if (value.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) === 10) count++;
  }
  if (value.charCodeAt(value.length - 1) === 10) count--;
  return count;
}

function readFirstStringField(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return undefined;
}

function extractBeforeAfterText(source: unknown): { before: string; after: string } | null {
  if (!isRecord(source)) {
    return null;
  }

  const before = readFirstStringField(source, ["old_string", "oldString", "oldText", "before"]);
  const after = readFirstStringField(source, [
    "new_string",
    "newString",
    "newText",
    "after",
    "content",
  ]);
  if (before !== undefined && after !== undefined) {
    return { before, after };
  }

  const metadata = source["metadata"];
  if (isRecord(metadata)) {
    const fileDiff = metadata["filediff"];
    if (isRecord(fileDiff)) {
      const nestedBefore = readFirstStringField(fileDiff, [
        "old_string",
        "oldString",
        "oldText",
        "before",
      ]);
      const nestedAfter = readFirstStringField(fileDiff, [
        "new_string",
        "newString",
        "newText",
        "after",
        "content",
      ]);
      if (nestedBefore !== undefined && nestedAfter !== undefined) {
        return { before: nestedBefore, after: nestedAfter };
      }
    }
  }

  const contentBlocks = source["content"];
  if (Array.isArray(contentBlocks)) {
    for (const block of contentBlocks) {
      if (!isRecord(block)) {
        continue;
      }
      const blockBefore = readFirstStringField(block, [
        "old_string",
        "oldString",
        "oldText",
        "before",
      ]);
      const blockAfter = readFirstStringField(block, [
        "new_string",
        "newString",
        "newText",
        "after",
        "content",
      ]);
      if (blockBefore !== undefined && blockAfter !== undefined) {
        return { before: blockBefore, after: blockAfter };
      }
    }
  }

  return null;
}

function getChangeStat(
  kind: string,
  input: unknown,
  output?: unknown,
  raw?: unknown,
): ToolCallChangeStat | undefined {
  if (!/(edit|patch|replace|multi.?edit)/i.test(kind)) return undefined;

  const changeSource =
    extractBeforeAfterText(input) ?? extractBeforeAfterText(output) ?? extractBeforeAfterText(raw);
  if (!changeSource) return undefined;

  const removed = countLines(changeSource.before);
  const added = countLines(changeSource.after);
  if (added === 0 && removed === 0) return undefined;

  return { added, removed };
}

function getInputSummary(input: unknown): string | undefined {
  if (typeof input === "string") {
    const summary = normalizeDisplayText(input);
    return summary.length > 0 ? summary : undefined;
  }

  if (!isRecord(input)) {
    return undefined;
  }

  for (const key of ["command", "path", "file_path", "filePath", "prompt"] as const) {
    const candidate = input[key];
    if (typeof candidate !== "string") {
      continue;
    }

    const summary = normalizeDisplayText(candidate);
    if (summary.length > 0) {
      return summary;
    }
  }

  return undefined;
}

export function isCompactToolCallRunningState(state: string): state is CompactToolCallState {
  return TOOL_CALL_RUNNING_STATES.has(state as CompactToolCallState);
}

export function isCompactToolCallFinishedState(state: string): state is CompactToolCallState {
  return TOOL_CALL_FINISHED_STATES.has(state as CompactToolCallState);
}

export function getCompactToolCallStatusMessageId(state: string, rawStatus?: string): string {
  if (rawStatus === "stopped") {
    return "chat.toolCall.status.stopped";
  }

  return (
    TOOL_CALL_STATUS_MESSAGE_IDS[state as CompactToolCallState] ?? "chat.toolCall.status.pending"
  );
}

export function getCompactToolCallSummary({
  title,
  kind,
  input,
  output,
  raw,
}: ToolCallSummarySource): ToolCallSummary {
  const changeStat = getChangeStat(kind, input, output, raw);
  const primaryText = (title && normalizeDisplayText(title)) || "tool";
  const secondaryText = getInputSummary(input);
  return {
    primaryText,
    secondaryText,
    changeStat,
  };
}
