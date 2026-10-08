import { readCuaErrorDetails } from "@/ToolCallBlocks/renderers/cuaErrorDetails.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  const direct = asRecord(value);
  if (direct) return direct;
  if (typeof value !== "string") return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function readText(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseCuaTextAppState(value: string): Record<string, unknown> | null {
  const match = /^app:\s+([A-Za-z0-9.-]+)\s+pid=\d+\s+"([^"\r\n]+)"\s*$/mu.exec(value);
  if (!match) return null;
  const [, bundleId, name] = match;
  return { app: { bundle_id: bundleId, name } };
}

function parseCuaResultState(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  const structuredMarker = "Structured content:";
  const structuredStart = value.lastIndexOf(structuredMarker);
  const jsonStart = value.lastIndexOf("\n\n{");
  // 部分 MCP 结果在有效主 JSON 后只追加空的 `Structured content:` 标记。
  // 无条件解析标记后的空串会让应用身份丢失并降级成 Computer Use。
  // 有真实 structured content 时仍优先使用；为空或无效时再解析标记前的主 JSON。
  const candidates =
    structuredStart >= 0
      ? [
          value.slice(structuredStart + structuredMarker.length).trim(),
          value.slice(0, structuredStart).trim(),
        ]
      : jsonStart >= 0
        ? [value.slice(jsonStart + 2).trim(), value.trim()]
        : [value.trim()];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = asRecord(JSON.parse(candidate));
      if (!parsed) continue;
      const wrappedResult = parsed?.result;
      if (typeof wrappedResult === "string") {
        try {
          // MCP structuredContent 会把 CUA 的 JSON 结果再包装为 result 字符串；
          // 若不继续解包，名称等结构化字段会丢失并错误回退到 bundle_id。
          return asRecord(JSON.parse(wrappedResult)) ?? parsed;
        } catch {
          return parsed;
        }
      }
      return parsed;
    } catch {
      // get_app_state 的成功结果可能是面向模型的文本状态而非 JSON；
      // 其稳定 app 头部已包含唯一目标应用，忽略它会让摘要错误降级为 Computer Use。
      const textState = parseCuaTextAppState(candidate);
      if (textState) return textState;
    }
  }
  return null;
}

export function readCuaResultBundleId(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): string | null {
  const errorBundleId = readCuaErrorDetails(toolCall)?.targetBundleId;
  if (errorBundleId) return errorBundleId;
  const rawOutput = readText(asRecord(toolCall.raw), "rawOutput");
  const result = parseCuaResultState(toolCall.output) ?? parseCuaResultState(rawOutput);
  const resultApp = asRecord(result?.app) ?? asRecord(result?.owner) ?? result;
  return readText(resultApp, "bundle_id") ?? readText(resultApp, "bundleId");
}

function readCuaInputApp(input: unknown): Record<string, unknown> | null {
  const inputRecord = asRecord(input);
  return parseRecord(inputRecord?.app) ?? parseRecord(inputRecord?.app_ref);
}

function parseCuaResultArrayLength(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const markerStart = value.lastIndexOf("\n\nStructured content:");
  const candidate = (markerStart >= 0 ? value.slice(0, markerStart) : value).trim();
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    return Array.isArray(parsed) ? parsed.length : null;
  } catch {
    return null;
  }
}

export function readCuaResultListCount(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): number | null {
  const display = readToolResultDisplay(toolCall.raw);
  if (display?.kind === "cua") {
    const displayCount = parseCuaResultArrayLength(display.text);
    if (displayCount !== null) return displayCount;
  }
  const rawOutput = readText(asRecord(toolCall.raw), "rawOutput");
  return parseCuaResultArrayLength(toolCall.output) ?? parseCuaResultArrayLength(rawOutput);
}

function readCuaOutputText(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): string | null {
  const display = readToolResultDisplay(toolCall.raw);
  if (display?.kind === "cua" && display.text) return display.text;
  if (typeof toolCall.output === "string" && toolCall.output.trim()) return toolCall.output;
  return readText(asRecord(toolCall.raw), "rawOutput");
}

function stripElementRole(value: string): string {
  return value.replace(/^\S+\s+/u, "").trim();
}

function readElementName(elementLine: string): string | null {
  const content = elementLine.replace(/\s+\([^)]*\)\s*$/u, "").trim();
  const separator = content.lastIndexOf(" = ");
  if (separator < 0) return stripElementRole(content) || null;

  const left = content.slice(0, separator).trim();
  const right = content.slice(separator + 3).trim();
  // textarea 的等号右侧是可能跨行的正文预览，不是可访问名称；
  // 将正文当目标会让右键摘要泄露大段文档内容，因此应取角色后的控件名称。
  if (/^textarea\s+/iu.test(left)) return stripElementRole(left) || null;
  // 值型控件的右侧是 0/1 等状态，不是目标名称；文本节点等描述型元素则以右侧为可读名称。
  return /^(?:-?\d+(?:\.\d+)?|true|false|null)$/iu.test(right)
    ? stripElementRole(left) || null
    : right || null;
}

export function readCuaActionTargetName(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): string | null {
  const target = parseRecord(asRecord(toolCall.input)?.target);
  if (
    target?.type !== "element" ||
    typeof target.index !== "number" ||
    !Number.isInteger(target.index)
  ) {
    return null;
  }
  const output = readCuaOutputText(toolCall);
  if (!output) return null;

  const lines = output.split(/\r?\n/u);
  const elementPattern = new RegExp(`^\\s*\\[${target.index}\\]\\s+(.+)$`, "u");
  const targetLineIndex = lines.findIndex((line) => elementPattern.test(line));
  if (targetLineIndex < 0) return null;

  const targetLine = lines[targetLineIndex];
  if (!targetLine) return null;
  const elementLine = elementPattern.exec(targetLine)?.[1];
  if (!elementLine) return null;
  const directName = readElementName(elementLine);
  if (directName !== String(target.index)) return directName;

  const childNames: string[] = [];
  const anyElementPattern = /^\s*\[\d+\]\s+(.+)$/u;
  for (const line of lines.slice(targetLineIndex + 1)) {
    const childLine = anyElementPattern.exec(line)?.[1];
    if (!childLine || !/^text\s+/iu.test(childLine)) break;
    const childName = readElementName(childLine);
    if (!childName) break;
    childNames.push(childName);
  }

  // CUA 会把按钮名称拆成紧随其后的扁平文本节点，按钮自身只留下数字索引。
  // 只读取连续文本节点并在下一个可操作元素前停止，避免把相邻控件名称拼进当前摘要。
  return childNames.length > 0 ? childNames.join("") : directName;
}

export function readCuaResultState(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
): Record<string, unknown> | null {
  const display = readToolResultDisplay(toolCall.raw);
  if (display?.kind === "cua" && display.structuredContent) {
    // 新 session 的 display 仍保留 MCP `{ result: "...json..." }` 包装；
    // 必须复用 legacy 解包逻辑，否则 display 优先路径反而读不到 App 名称与状态。
    const structured = parseCuaResultState(display.structuredContent);
    if (structured) return structured;
  }
  const rawOutput = readText(asRecord(toolCall.raw), "rawOutput");
  return parseCuaResultState(toolCall.output) ?? parseCuaResultState(rawOutput);
}

export function readCuaAppName(
  input: unknown,
  result: Record<string, unknown> | null,
): string | null {
  const inputRecord = asRecord(input);
  const inputApp = readCuaInputApp(inputRecord);
  const resultApp = asRecord(result?.app) ?? asRecord(result?.owner) ?? result;
  const name =
    readText(resultApp, "name") ??
    readText(resultApp, "display_name") ??
    readText(inputApp, "name");
  if (name) return name;
  const bundleId = readText(resultApp, "bundle_id") ?? readText(inputApp, "bundle_id");
  // Finder 的 list_windows 等结果只返回稳定的系统 bundle ID，不返回 app.name；
  // 这里使用 macOS 标准名称，避免摘要和详情暴露 com.apple.finder。
  return bundleId === "com.apple.finder" ? "Finder" : bundleId;
}
