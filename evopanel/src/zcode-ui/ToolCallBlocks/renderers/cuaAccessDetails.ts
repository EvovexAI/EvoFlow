import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

interface CuaAccessRow {
  labelId: string;
  value: string;
  status?: boolean;
}

interface CuaAccessDetails {
  ready: boolean;
  permissionRows: CuaAccessRow[];
  environmentRows: CuaAccessRow[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readText(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parsePrimaryObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return asRecord(value);
  const candidate = value.split("\n\nStructured content:", 1)[0]?.trim();
  if (!candidate?.startsWith("{")) return null;
  try {
    return asRecord(JSON.parse(candidate));
  } catch {
    return null;
  }
}

function statusAfterToBoolean(status: string | null): boolean | undefined {
  if (status === "granted" || status === "not_required") return true;
  if (status === "denied" || status === "not_granted" || status === "blocked") return false;
  return undefined;
}

function readPermissionStatus(value: unknown, fallback: unknown): boolean | undefined {
  if (value === true || value === "granted") return true;
  if (value === false || value === "denied") return false;
  // The runtime request_access response puts each permission's status object
  // ({ status_after, ... }) at the TOP LEVEL (e.g. result.accessibility), while
  // the legacy shape nests it under `permission_request` (passed as `fallback`).
  // Read status_after from either. "not_required" is a satisfied (non-blocking)
  // state and maps to granted.
  const fromValue = statusAfterToBoolean(readText(asRecord(value), "status_after"));
  if (fromValue !== undefined) return fromValue;
  return statusAfterToBoolean(readText(asRecord(fallback), "status_after"));
}

export function buildCuaAccessDetails(
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"],
  formatValue: (id: string) => string,
): CuaAccessDetails {
  const rawOutput = readText(asRecord(toolCall.raw), "rawOutput");
  const result = parsePrimaryObject(toolCall.output) ?? parsePrimaryObject(rawOutput) ?? {};
  const permissionRequest = asRecord(result.permission_request);
  const accessibility = readPermissionStatus(
    result.accessibility,
    permissionRequest?.accessibility,
  );
  const screenRecording = readPermissionStatus(
    result.screen_recording,
    permissionRequest?.screen_recording,
  );
  // permission_guide lives at the top level in the runtime response and nested
  // under permission_request in the legacy shape — honor either.
  const permissionGuide =
    asRecord(permissionRequest?.permission_guide) ?? asRecord(result.permission_guide);
  const ready =
    typeof permissionGuide?.all_required_granted === "boolean"
      ? permissionGuide.all_required_granted
      : accessibility === true && screenRecording === true;
  const statusValue = (status: boolean | undefined) =>
    formatValue(
      status === true
        ? "chat.toolCall.cua.details.granted"
        : status === false
          ? "chat.toolCall.cua.details.denied"
          : "chat.toolCall.cua.details.unknown",
    );
  // 旧展示把 runtime 的兼容字段也当成产品所需权限，额外显示了「自动化」和
  // 「输入控制」。Computer Use 的权限契约只有辅助功能与屏幕录制，原始兼容字段仍保留在
  // 折叠数据中供排障，但不能进入面向用户的权限列表。
  const permissionRows = [
    {
      labelId: "chat.toolCall.cua.details.accessibility",
      value: statusValue(accessibility),
      status: accessibility,
    },
    {
      labelId: "chat.toolCall.cua.details.screenRecording",
      value: statusValue(screenRecording),
      status: screenRecording,
    },
  ];
  const subject = asRecord(result.authorization_subject);
  const platform = readText(result, "platform");
  const backend = readText(result, "backend");
  const environmentRows: CuaAccessRow[] = [];
  if (platform) {
    environmentRows.push({
      labelId: "chat.toolCall.cua.details.platform",
      value: platform === "macos" ? "macOS" : platform,
    });
  }
  if (backend) {
    environmentRows.push({ labelId: "chat.toolCall.cua.details.backend", value: backend });
  }
  const helper = readText(subject, "display_name");
  if (helper) {
    environmentRows.push({ labelId: "chat.toolCall.cua.details.permissionOwner", value: helper });
  }
  return { ready, permissionRows, environmentRows };
}
