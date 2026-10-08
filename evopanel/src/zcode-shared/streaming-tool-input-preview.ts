export interface ZCodeStreamingToolInputState {
  deltaCount?: number;
  lastPreviewAt?: number;
  lastPreviewRawInputLength?: number;
  rawInput: string;
}

export interface ZCodeStreamingToolInputPreview {
  complete: boolean;
  input: unknown;
  rawInput: string;
}

export type ZCodeStreamingToolInputPreviewMode = "active-live" | "background-summary";

export const ZCODE_ACTIVE_STREAMING_TOOL_INPUT_EAGER_DELTA_COUNT = 1;
export const ZCODE_ACTIVE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS = 750;
export const ZCODE_ACTIVE_STREAMING_TOOL_INPUT_PREVIEW_MIN_RAW_GROWTH = 8 * 1024;
export const ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS = 1_000;
export const ZCODE_ACTIVE_STREAMING_TOOL_INPUT_TIME_BUDGET_MAX_RAW_INPUT =
  ZCODE_ACTIVE_STREAMING_TOOL_INPUT_PREVIEW_MIN_RAW_GROWTH;

const PARTIAL_JSON_STRING_FIELD_KEYS = [
  "file_path",
  "filePath",
  "path",
  "target_path",
  "targetPath",
  "filename",
  "file",
  "content",
  "new_string",
  "newString",
  "new_text",
  "newText",
  "old_string",
  "oldString",
  "old_text",
  "oldText",
  "command",
  "description",
  "title",
  "pattern",
  "replacement",
  // ExitPlanMode 的正文位于 plan 字段。把它纳入半截 JSON 预览后，计划卡片与
  // 侧边详情才能从首个流式 chunk 开始更新，而不是等 input_end 才突然出现。
  "plan",
  // CreateWorkflow 的脚本与名字：流式草稿
  // 要在模型还在写脚本时就把站扫出来，半截 script 必须从首个 chunk 起就进预览。
  "name",
  "script",
] as const;

export function appendZCodeStreamingToolInputDelta(
  state: ZCodeStreamingToolInputState | undefined,
  delta: string,
): ZCodeStreamingToolInputState {
  return {
    ...state,
    deltaCount: (state?.deltaCount ?? 0) + 1,
    rawInput: `${state?.rawInput ?? ""}${delta}`,
  };
}

export function buildZCodeStreamingToolInputPreview(
  rawInput: string,
  completeInput?: unknown,
): ZCodeStreamingToolInputPreview {
  if (completeInput !== undefined) {
    return {
      complete: true,
      input: completeInput,
      rawInput,
    };
  }

  const parsed = parseCompleteJson(rawInput);
  if (parsed.ok) {
    return {
      complete: true,
      input: parsed.value,
      rawInput,
    };
  }

  return {
    complete: false,
    input: readPartialJsonObjectPreview(rawInput) ?? {},
    rawInput,
  };
}

export function shouldMaterializeZCodeStreamingToolInputPreview(
  state: ZCodeStreamingToolInputState,
  options: {
    mode?: ZCodeStreamingToolInputPreviewMode;
    now?: number;
    toolName?: string;
  } = {},
): boolean {
  if (options.mode === "background-summary") {
    return false;
  }
  const deltaCount = state.deltaCount ?? 0;
  if (deltaCount <= ZCODE_ACTIVE_STREAMING_TOOL_INPUT_EAGER_DELTA_COUNT) {
    return true;
  }
  const lastPreviewAt = state.lastPreviewAt ?? 0;
  if (isZCodeFileStreamingToolInputPreviewTool(options.toolName)) {
    // 性能修复：Write/Edit 的半截 JSON 会触发全量内容恢复和行级 diff。
    // 大字节 chunk 不能绕过一秒窗口，否则模型输出越快，UI 反而更新越频繁。
    return (
      (options.now ?? Date.now()) - lastPreviewAt >=
      ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS
    );
  }
  const lastPreviewRawInputLength = state.lastPreviewRawInputLength ?? 0;
  const rawGrowth = state.rawInput.length - lastPreviewRawInputLength;
  if (rawGrowth >= ZCODE_ACTIVE_STREAMING_TOOL_INPUT_PREVIEW_MIN_RAW_GROWTH) {
    return true;
  }
  const intervalElapsed =
    (options.now ?? Date.now()) - lastPreviewAt >=
    ZCODE_ACTIVE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS;
  if (!intervalElapsed) {
    return false;
  }
  // 性能修复：大 Write/Edit 参数通常会被 provider 以 4KB 左右的慢速 chunk 推送。
  // 若只按时间预算，active 任务仍会每个 chunk 解析累计 JSON；超过小输入范围后改由 raw growth 控制。
  return state.rawInput.length <= ZCODE_ACTIVE_STREAMING_TOOL_INPUT_TIME_BUDGET_MAX_RAW_INPUT;
}

export function isZCodeFileStreamingToolInputPreviewTool(toolName?: string): boolean {
  const normalized = toolName?.trim().toLowerCase();
  return normalized === "write" || normalized === "edit";
}

export function markZCodeStreamingToolInputPreviewMaterialized(
  state: ZCodeStreamingToolInputState,
  now = Date.now(),
): void {
  state.lastPreviewAt = now;
  state.lastPreviewRawInputLength = state.rawInput.length;
}

function parseCompleteJson(value: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false };
  }
}

function readPartialJsonObjectPreview(rawInput: string): Record<string, string> | null {
  const preview: Record<string, string> = {};
  for (const key of PARTIAL_JSON_STRING_FIELD_KEYS) {
    const value = readPartialJsonStringField(rawInput, key);
    if (value !== undefined) {
      preview[key] = value;
    }
  }
  return Object.keys(preview).length > 0 ? preview : null;
}

function readPartialJsonStringField(rawInput: string, key: string): string | undefined {
  const match = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"`).exec(rawInput);
  if (!match) {
    return undefined;
  }

  let encoded = "";
  let escaped = false;
  let closed = false;
  for (let index = match.index + match[0].length; index < rawInput.length; index += 1) {
    const char = rawInput[index] ?? "";
    if (escaped) {
      encoded += `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      closed = true;
      break;
    }
    encoded += char;
  }
  if (escaped) {
    encoded += "\\";
  }

  return decodeJsonStringSegment(encoded, closed);
}

function decodeJsonStringSegment(encoded: string, closed: boolean): string {
  const normalized = closed ? encoded : trimDanglingJsonEscape(encoded);
  try {
    return JSON.parse(`"${normalized}"`) as string;
  } catch {
    return decodeJsonStringSegmentBestEffort(normalized);
  }
}

function trimDanglingJsonEscape(value: string): string {
  return value.replace(/\\u[0-9a-fA-F]{0,3}$/, "").replace(/\\$/, "");
}

function decodeJsonStringSegmentBestEffort(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
