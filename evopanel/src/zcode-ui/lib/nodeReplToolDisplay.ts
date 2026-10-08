import type { TaskChatToolCall as ChatToolCall } from "@/lib/taskChatMessageTypes.js";

export type NodeReplOperation = "run" | "reset" | "add-module-dir";

export interface NodeReplDisplayImage {
  base64: string;
  mimeType: string;
}

export interface NodeReplDisplayError {
  summary: string;
  stack?: string;
}

export interface NodeReplPersistedResult {
  artifactPath: string;
  sizeLabel: string;
}

/** 本次 cell 操作的目标应用（Computer Use）；由 CLI 的 node_repl display 携带。 */
export interface NodeReplCuaApp {
  appKey: string;
  displayName?: string;
}

export interface NodeReplDisplayModel {
  operation: NodeReplOperation;
  userTitle?: string;
  code?: string;
  moduleDirectory?: string;
  resultText?: string;
  error?: NodeReplDisplayError;
  images: NodeReplDisplayImage[];
  persistedResult?: NodeReplPersistedResult;
  displaySource?: "browser_turn_end";
  app?: NodeReplCuaApp;
}

const IMPLEMENTATION_TITLE_PATTERN = /(?:\bjs\b|\bjavascript\b|node[\s_-]*repl)/i;
const LEADING_BLANK_LINES_PATTERN = /^(?:[ \t]*\r?\n)+/;
const PROJECTED_COMPLETION_MARKER_PATTERN = /(^|\n)=> /g;
const PROJECTED_IMAGE_PLACEHOLDER_PATTERN = /^\[Attached image\/[^\]]+\]$/u;
const IMAGE_MIME_TYPE_PATTERN = /^image\/[a-z0-9.+-]+$/iu;
const PERSISTED_OUTPUT_PATTERN =
  /^<persisted-output>\s*\nOutput too large \(([^)]+)\)\. Full output saved to: ([^\n]+)\n\nPreview \([^)]+\):\n([\s\S]*?)\n<\/persisted-output>\s*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? value : undefined;
}

function readFirstStringField(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = readNonEmptyString(value[key]);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

function readRawInput(raw: unknown): unknown {
  if (!isRecord(raw)) {
    return undefined;
  }

  return raw.rawInput ?? raw.input;
}

function readRawOutput(raw: unknown): unknown {
  if (!isRecord(raw)) {
    return undefined;
  }

  return raw.rawOutput ?? raw.output ?? raw.result;
}

function resolveOperation(toolCall: ChatToolCall): NodeReplOperation {
  const toolName = (toolCall.toolName?.trim() || toolCall.kind).toLowerCase();
  // 真实 MCP 工具会带 mcp__node_repl__ 前缀；仅匹配旧 built-in 名称
  // 会把 reset/configure 错误展示成执行 JavaScript。
  if (toolName === "js_reset" || toolName === "mcp__node_repl__js_reset") {
    return "reset";
  }
  if (
    toolName === "js_add_node_module_dir" ||
    toolName === "mcp__node_repl__js_add_node_module_dir"
  ) {
    return "add-module-dir";
  }
  return "run";
}

function parseInputRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readInputRecords(toolCall: ChatToolCall): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const candidate of [toolCall.input, readRawInput(toolCall.raw)]) {
    const record = parseInputRecord(candidate);
    if (record && !records.includes(record)) {
      records.push(record);
    }
  }

  return records;
}

function readUserTitle(
  toolCall: ChatToolCall,
  inputs: readonly Record<string, unknown>[],
): string | undefined {
  // 完成态快照可能只在 raw input 或顶层 title 保留用户标题，不能因主 input 只有 code 就丢失。
  for (const candidate of [...inputs.map((input) => input.title), toolCall.title]) {
    const title = readNonEmptyString(candidate)?.trim();
    if (title && !IMPLEMENTATION_TITLE_PATTERN.test(title)) {
      return title;
    }
  }

  return undefined;
}

function readInputString(
  inputs: readonly Record<string, unknown>[],
  keys: readonly string[],
): string | undefined {
  for (const input of inputs) {
    const value = readFirstStringField(input, keys);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function extractText(value: unknown, depth = 0): string | undefined {
  if (depth > 4) {
    return undefined;
  }

  const directString = readNonEmptyString(value);
  if (directString) {
    return directString;
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractText(item, depth + 1))
      .filter((item): item is string => item !== undefined);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  if (value.type === "text") {
    const textValue = readFirstStringField(value, ["value", "text", "content"]);
    if (textValue) {
      return textValue;
    }
  }

  const logs = readNonEmptyString(value.logs);
  const result = extractText(value.result, depth + 1);
  if (logs || result) {
    return [logs, result].filter((item): item is string => item !== undefined).join("\n");
  }

  for (const key of ["value", "output", "text", "content", "stdout", "message"] as const) {
    const text = extractText(value[key], depth + 1);
    if (text) {
      return text;
    }
  }

  return undefined;
}

function removeProjectedCompletionMarkers(text: string | undefined): string | undefined {
  if (!text) {
    return text;
  }

  // 结果投影会用“=> ”区分完成值与日志，但这是内部协议标记，不应展示给用户。
  return text.replace(PROJECTED_COMPLETION_MARKER_PATTERN, "$1");
}

function removeProjectedImagePlaceholders(
  text: string | undefined,
  hasImages: boolean,
): string | undefined {
  if (!text || !hasImages) return text;

  // Agent/Provider 需要图片的文本占位，但工具卡片已持有真实 display 图片；
  // 若继续渲染投影文本，用户会同时看到图片和“Attached MCP image”内部协议描述。
  const visibleLines = text
    .split("\n")
    .filter((line) => !PROJECTED_IMAGE_PLACEHOLDER_PATTERN.test(line.trim()));
  const withoutPlaceholder = visibleLines.join("\n").trim();
  return withoutPlaceholder === "(no output)" || withoutPlaceholder.length === 0
    ? undefined
    : withoutPlaceholder;
}

function removeLeadingBlankLines(code: string | undefined): string | undefined {
  if (!code) {
    return code;
  }

  // 模型生成的执行内容经常在首个有效行前带换行；只移除空白行，避免破坏代码缩进。
  return code.replace(LEADING_BLANK_LINES_PATTERN, "");
}

function extractError(value: unknown, depth = 0): NodeReplDisplayError | undefined {
  if (depth > 4) {
    return undefined;
  }

  if (typeof value === "string") {
    const summary = value.trim();
    return summary.length > 0 ? { summary } : undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  if ("error" in value) {
    const nested = extractError(value.error, depth + 1);
    if (nested) {
      return nested;
    }
  }

  const message = readFirstStringField(value, ["message", "errorText"]);
  const name = readNonEmptyString(value.name)?.trim();
  const stack = readNonEmptyString(value.stack);
  if (message) {
    const normalizedMessage = message.trim();
    return {
      summary:
        name && !normalizedMessage.startsWith(`${name}:`)
          ? `${name}: ${normalizedMessage}`
          : normalizedMessage,
      ...(stack ? { stack } : {}),
    };
  }

  return undefined;
}

function extractImages(values: unknown[]): NodeReplDisplayImage[] {
  const images: NodeReplDisplayImage[] = [];
  const seen = new Set<string>();
  const visited = new Set<object>();
  const addImage = (value: Record<string, unknown>) => {
    // 旧 built-in result 使用 {images:[{base64,mimeType}]}，真实 MCP
    // 使用 content 里的 {type:"image",data,mimeType}。专用 renderer 必须兼容两种历史形态。
    const base64 = readNonEmptyString(value.base64) ?? readNonEmptyString(value.data);
    const mimeType = readNonEmptyString(value.mimeType)?.trim();
    if (!base64 || !mimeType || !IMAGE_MIME_TYPE_PATTERN.test(mimeType)) {
      return;
    }
    const key = `${mimeType}:${base64.length}:${base64.slice(0, 24)}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    images.push({ base64, mimeType });
  };
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    if (value.type === "image" || "base64" in value) addImage(value);
    for (const child of Object.values(value)) visit(child);
  };

  for (const value of values) {
    visit(value);
  }

  return images;
}

/**
 * 从 raw 里找 node_repl display 携带的 App 身份。
 *
 * 与 `extractImages` / `hasBrowserTurnEndDisplay` 同款递归：实时 tool.updated 把 display 放在
 * raw.result 内，终态 snapshot 则把 completed part 的 metadata 直接当作 raw，只扫一个固定位置
 * 会让对话结束后图标消失。
 */
function findCuaApp(value: unknown, visited = new Set<object>()): NodeReplCuaApp | undefined {
  if (!value || typeof value !== "object" || visited.has(value)) return undefined;
  visited.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCuaApp(item, visited);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (value.kind === "node_repl_images" && isRecord(value.app)) {
    const appKey = readNonEmptyString(value.app.appKey)?.trim();
    if (appKey) {
      const displayName = readNonEmptyString(value.app.displayName)?.trim();
      return { appKey, ...(displayName ? { displayName } : {}) };
    }
  }
  for (const item of Object.values(value)) {
    const found = findCuaApp(item, visited);
    if (found) return found;
  }
  return undefined;
}

function hasBrowserTurnEndDisplay(value: unknown, visited = new Set<object>()): boolean {
  if (!value || typeof value !== "object" || visited.has(value)) return false;
  visited.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => hasBrowserTurnEndDisplay(item, visited));
  }
  if (!isRecord(value)) return false;
  if (value.kind === "node_repl_images" && value.source === "browser_turn_end") return true;
  return Object.values(value).some((item) => hasBrowserTurnEndDisplay(item, visited));
}

function parsePersistedResult(text: string | undefined): {
  resultText?: string;
  persistedResult?: NodeReplPersistedResult;
} {
  if (!text) {
    return {};
  }

  const match = PERSISTED_OUTPUT_PATTERN.exec(text);
  if (!match) {
    return { resultText: text };
  }

  const [, sizeLabel, artifactPath, preview] = match;
  if (!sizeLabel || !artifactPath) {
    return { resultText: text };
  }

  return {
    ...(preview?.trim() ? { resultText: preview } : {}),
    persistedResult: {
      artifactPath: artifactPath.trim(),
      sizeLabel: sizeLabel.trim(),
    },
  };
}

export function buildNodeReplDisplayModel(toolCall: ChatToolCall): NodeReplDisplayModel {
  const inputs = readInputRecords(toolCall);
  const outputCandidates = [toolCall.output, readRawOutput(toolCall.raw)].filter(
    (value) => value !== undefined,
  );
  const projectedText = outputCandidates
    .map((candidate) => extractText(candidate))
    .find((candidate) => candidate !== undefined);
  // 实时 tool.updated 把 display 放在 raw.result 内，终态 snapshot 则把
  // completed part 的 metadata 直接作为 raw。只扫描 raw.result 会让对话结束后的图片消失。
  const images = extractImages([...outputCandidates, toolCall.raw]);
  const app = findCuaApp(toolCall.raw);
  const persisted = parsePersistedResult(
    removeProjectedImagePlaceholders(
      removeProjectedCompletionMarkers(projectedText),
      images.length > 0,
    ),
  );

  return {
    operation: resolveOperation(toolCall),
    userTitle: readUserTitle(toolCall, inputs),
    code: removeLeadingBlankLines(readInputString(inputs, ["code"])),
    moduleDirectory: readInputString(inputs, ["dir", "path"])?.trim(),
    ...persisted,
    ...(hasBrowserTurnEndDisplay(toolCall.raw)
      ? { displaySource: "browser_turn_end" as const }
      : {}),
    ...(app ? { app } : {}),
    error:
      extractError(toolCall.error) ??
      (toolCall.status === "failed"
        ? outputCandidates.map((candidate) => extractError(candidate)).find(Boolean)
        : undefined),
    images,
  };
}
