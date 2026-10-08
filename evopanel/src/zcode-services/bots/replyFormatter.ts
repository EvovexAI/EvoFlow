/* eslint-disable max-lines -- Bot bot reply formatter 集中维护第三方消息的文本颗粒度、工具摘要和权限摘要，避免 provider 间文案分叉。 */
import type {
  ZCodePermissionRequest,
  ZCodeStreamEvent,
  ZCodeTaskChangeSummary,
  Locale,
} from "@zcode/shared";
import {
  getCompactToolCallSummary,
  getPermissionRequestPreview,
} from "@zcode/shared";
import { normalizeBotMessageLocale } from "./messages.js";

export interface BotReplyToolCallState {
  toolId: string;
  parentToolUseId?: string | null;
  title?: string;
  kind?: string;
  input?: unknown;
  output?: unknown;
  status?: "pending" | "in_progress" | "completed" | "failed" | "denied" | "stopped";
  error?: string;
  raw?: unknown;
}

interface BotReplyFormatOptions {
  workspacePath?: string;
  locale?: Locale;
}

export type BotAssistantReplyBlock =
  | {
      type: "content";
      content: string;
    }
  | {
      type: "tool-call";
      toolCall: BotReplyToolCallState;
    }
  | {
      type: "change-summary";
      changeSummary: ZCodeTaskChangeSummary;
    };

const MAX_TOOL_SUMMARY_ITEMS = 10;
const MAX_FIELD_LENGTH = 160;
const MAX_COMMAND_FIELD_LENGTH = 96;
const MAX_REPLY_MESSAGE_LENGTH = 3500;
const DIFF_ADDED_MARKER = "🟢";
const DIFF_REMOVED_MARKER = "🔴";

const formatterMessages = {
  "zh-CN": {
    toolCalls: "工具调用：",
    completed: "完成",
    failed: "失败",
    denied: "已拒绝",
    inProgress: "⏳ 运行中",
    pending: "等待中",
    permissionRequired: "需要权限：",
    editWriting: "写入中",
    editUpdating: "更新中",
    editDeleting: "删除中",
    editEditing: "编辑中",
    changeSummary: "变更摘要",
    moreToolCalls: "还有 {count} 个工具调用",
    moreFiles: "还有 {count} 个文件",
  },
  "en-US": {
    toolCalls: "Tool calls:",
    completed: "Completed",
    failed: "Failed",
    denied: "Denied",
    inProgress: "Running",
    pending: "Pending",
    permissionRequired: "Permission required:",
    editWriting: "Writing",
    editUpdating: "Updating",
    editDeleting: "Deleting",
    editEditing: "Editing",
    changeSummary: "Change summary",
    moreToolCalls: "{count} more tool calls",
    moreFiles: "{count} more files",
  },
} as const;

function t(locale: Locale | undefined, key: keyof (typeof formatterMessages)["zh-CN"]): string {
  return formatterMessages[normalizeBotMessageLocale(locale)][key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeInlineText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function truncateText(value: string, maxLength = MAX_FIELD_LENGTH): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function truncateMiddleText(value: string, maxLength = MAX_COMMAND_FIELD_LENGTH): string {
  if (value.length <= maxLength) {
    return value;
  }
  const headLength = Math.ceil((maxLength - 5) * 0.65);
  const tailLength = Math.max(0, maxLength - 5 - headLength);
  return `${value.slice(0, headLength)} ... ${value.slice(value.length - tailLength)}`;
}

function formatMarkdownInlineCode(value: string): string {
  // Telegram Markdown 的 inline code 需要转义反斜杠和反引号，否则路径/命令里的特殊字符会导致文本退回裸显示。
  return `\`${value.replace(/\\/gu, "\\\\").replace(/`/gu, "\\`")}\``;
}

function normalizePathSeparators(value: string): string {
  return value.replace(/\\/gu, "/");
}

function stripTrailingSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/u, "") : value;
}

function toWorkspaceRelativePath(pathValue: string, workspacePath?: string): string {
  const normalizedPath = stripTrailingSlash(normalizePathSeparators(pathValue.trim()));
  if (!workspacePath?.trim()) {
    return normalizedPath;
  }
  const normalizedWorkspace = stripTrailingSlash(normalizePathSeparators(workspacePath.trim()));
  const comparablePath = normalizedPath.toLowerCase();
  const comparableWorkspace = normalizedWorkspace.toLowerCase();
  if (comparablePath === comparableWorkspace) {
    return ".";
  }
  if (comparablePath.startsWith(`${comparableWorkspace}/`)) {
    return normalizedPath.slice(normalizedWorkspace.length + 1);
  }
  return normalizedPath;
}

function normalizeToolCallSummaryInput(
  toolCall: BotReplyToolCallState,
  options?: BotReplyFormatOptions,
): unknown {
  if (!isRecord(toolCall.input) || toolCall.kind !== "edit") {
    return toolCall.input;
  }

  const nextInput = { ...toolCall.input };
  for (const key of ["path", "file_path", "filePath"] as const) {
    const value = nextInput[key];
    if (typeof value === "string") {
      nextInput[key] = toWorkspaceRelativePath(value, options?.workspacePath);
    }
  }
  return nextInput;
}

function formatCompactSummaryDetail(
  summary: ReturnType<typeof getCompactToolCallSummary>,
): string | undefined {
  const parts: string[] = [];
  if (summary.secondaryText) {
    parts.push(formatMarkdownInlineCode(truncateMiddleText(normalizeInlineText(summary.secondaryText))));
  }
  if (summary.changeStat) {
    const stat = formatBotDiffCount(summary.changeStat);
    if (stat) {
      parts.push(stat);
    }
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function formatBotDiffCount(changeStat: { added: number; removed: number }): string {
  const parts: string[] = [];
  if (changeStat.added > 0) {
    parts.push(`${DIFF_ADDED_MARKER} ${formatMarkdownInlineCode(`+${changeStat.added}`)}`);
  }
  if (changeStat.removed > 0) {
    parts.push(`${DIFF_REMOVED_MARKER} ${formatMarkdownInlineCode(`-${changeStat.removed}`)}`);
  }
  return parts.join(" ");
}

function formatPermissionRequestHeader(
  request: Pick<ZCodePermissionRequest, "title" | "description" | "kind" | "raw">,
  options?: BotReplyFormatOptions,
): string {
  const preview = getPermissionRequestPreview(request);
  return `${t(options?.locale, "permissionRequired")}\n${formatPermissionRequestTitle(request, preview, options)}`;
}

function formatPermissionRequestTitle(
  request: Pick<ZCodePermissionRequest, "title" | "description" | "kind" | "raw">,
  preview: ReturnType<typeof getPermissionRequestPreview>,
  options?: BotReplyFormatOptions,
): string {
  if (request.kind !== "edit" || (preview.scope !== "file" && preview.fileChanges.length === 0)) {
    return preview.title;
  }
  const label = formatEditPermissionKindLabel(request, preview, options?.locale);
  const titleWithoutEdit = preview.title.replace(/^edit\b[:：]?\s*/iu, "").trim();
  const targetText =
    titleWithoutEdit && titleWithoutEdit !== preview.title
      ? titleWithoutEdit
      : preview.filePaths.length === 1 || preview.fileChanges.length === 1
        ? toWorkspaceRelativePath((preview.filePaths[0] ?? preview.fileChanges[0]?.path)!, options?.workspacePath)
        : "";
  return targetText ? `${label} ${targetText}` : label;
}

function formatEditPermissionKindLabel(
  request: Pick<ZCodePermissionRequest, "title" | "description" | "kind" | "raw">,
  preview: ReturnType<typeof getPermissionRequestPreview>,
  locale?: Locale,
): string {
  const rawText = [
    request.title,
    request.description,
    isRecord(request.raw) && typeof request.raw.kind === "string" ? request.raw.kind : undefined,
    isRecord(request.raw) && typeof request.raw.title === "string" ? request.raw.title : undefined,
  ].filter((value): value is string => typeof value === "string").join(" ");
  const normalizedText = rawText.trim().toLowerCase();
  const fileChangeType = preview.fileChange?.type;

  if (/\b(delete|deleted|remove|removed|erase|erased|unlink|rm)\b/u.test(normalizedText)) {
    return t(locale, "editDeleting");
  }
  if (fileChangeType === "add" || /\b(write|wrote|create|created|add|added|save|saved|new)\b/u.test(normalizedText)) {
    return t(locale, "editWriting");
  }
  if (/\b(update|updating|updated)\b/u.test(normalizedText)) {
    return t(locale, "editUpdating");
  }
  // Bugfix: edit 权限标题直接透传 ZCode Agent 的 "Edit <path>" 时，第三方消息无法像 UI kindLabel 一样区分写入/更新/删除。
  // 这里至少把泛化的 Edit 换成 edit kind label，具体操作能从 raw/fileChange 推断时再细分。
  return t(locale, "editEditing");
}

export function formatBotToolCallSummaryLine(
  toolCall: BotReplyToolCallState,
  options?: BotReplyFormatOptions,
): string {
  const summary = getCompactToolCallSummary({
    title: toolCall.title,
    kind: toolCall.kind ?? "tool",
    input: normalizeToolCallSummaryInput(toolCall, options),
    output: toolCall.output,
    raw: toolCall.raw,
  });
  const status = formatToolStatus(toolCall.status, toolCall.error, options?.locale);
  const detail = formatCompactSummaryDetail(summary);
  return `- ${status} · ${summary.primaryText}${detail ? ` · ${detail}` : ""}`;
}

function formatToolStatus(
  status?: BotReplyToolCallState["status"],
  error?: string,
  locale?: Locale,
): string {
  if (status === "completed") return t(locale, "completed");
  if (status === "failed") return `${t(locale, "failed")}${error ? `: ${truncateText(normalizeInlineText(error))}` : ""}`;
  if (status === "denied") return t(locale, "denied");
  if (status === "in_progress") return t(locale, "inProgress");
  return t(locale, "pending");
}

function splitLongReplyText(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > MAX_REPLY_MESSAGE_LENGTH) {
    const breakpoint = Math.max(
      remaining.lastIndexOf("\n", MAX_REPLY_MESSAGE_LENGTH),
      remaining.lastIndexOf(" ", MAX_REPLY_MESSAGE_LENGTH),
    );
    const end = breakpoint > 0 ? breakpoint : MAX_REPLY_MESSAGE_LENGTH;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

export function extractBotAssistantResponseMessages(
  buffer: string,
  force = false,
): { messages: string[]; rest: string } {
  const normalizedBuffer = buffer.replace(/\r\n/g, "\n");
  if (!force) {
    return { messages: [], rest: normalizedBuffer };
  }

  // Bugfix: Bot channel 的 provider chunk 常按词或子词到达，非终态时必须继续留在
  // assistantReplyBuffer 里合并；真正的发送边界由 tool_call / task_complete 等 force flush 决定。
  return {
    messages: splitLongReplyText(normalizedBuffer),
    rest: "",
  };
}

export function formatBotToolCallReply(
  toolCall: BotReplyToolCallState,
  options?: BotReplyFormatOptions,
): string {
  return `${t(options?.locale, "toolCalls")}\n${formatBotToolCallSummaryLine(toolCall, options)}`;
}

export function formatBotPermissionRequestSummary(
  request: Pick<ZCodePermissionRequest, "title" | "description" | "kind" | "raw">,
  options?: BotReplyFormatOptions,
): string {
  const preview = getPermissionRequestPreview(request);
  const header = formatPermissionRequestHeader(request, options);
  if (preview.command) {
    return `${header}\n${formatMarkdownInlineCode(truncateMiddleText(preview.command))}`;
  }
  const previewFilePaths = preview.filePaths.length > 0
    ? preview.filePaths
    : preview.fileChanges.map((change) => change.path);
  if (previewFilePaths.length > 0) {
    const paths = previewFilePaths
      .slice(0, 3)
      .map((path) => toWorkspaceRelativePath(path, options?.workspacePath))
      .map((path) => formatMarkdownInlineCode(path))
      .join(", ");
    return `${header}\n${truncateText(paths)}`;
  }
  return header;
}

export function isBotToolCallReplyTerminal(
  status?: BotReplyToolCallState["status"],
): boolean {
  return status === "completed" ||
    status === "failed" ||
    status === "denied" ||
    status === "stopped";
}

function formatBotChangeSummary(
  changeSummary?: ZCodeTaskChangeSummary | null,
  options?: Pick<BotReplyFormatOptions, "locale">,
): string {
  if (!changeSummary || changeSummary.fileCount <= 0 || changeSummary.files.length === 0) {
    return "";
  }
  const lines = [
    options?.locale === "en-US"
      ? `${t(options.locale, "changeSummary")}: ${changeSummary.fileCount} files, ${formatBotDiffCount(changeSummary)}`
      : `${t(options?.locale, "changeSummary")}：${changeSummary.fileCount} 个文件，${formatBotDiffCount(changeSummary)}`,
  ];
  for (const file of changeSummary.files.slice(0, MAX_TOOL_SUMMARY_ITEMS)) {
    lines.push(`- ${formatMarkdownInlineCode(file.path)} (${formatBotDiffCount(file)})`);
  }
  if (changeSummary.files.length > MAX_TOOL_SUMMARY_ITEMS) {
    lines.push(`- ${t(options?.locale, "moreFiles").replace("{count}", String(changeSummary.files.length - MAX_TOOL_SUMMARY_ITEMS))}`);
  }
  return lines.join("\n");
}

export function updateBotReplyToolCalls(
  toolCalls: Map<string, BotReplyToolCallState>,
  event: ZCodeStreamEvent,
): void {
  if (event.type === "tool_call") {
    toolCalls.set(event.toolId, {
      toolId: event.toolId,
      parentToolUseId: event.parentToolUseId ?? null,
      title: event.title,
      kind: event.kind,
      input: event.input,
      raw: event.raw,
      status: "pending",
    });
    return;
  }
  if (event.type !== "tool_call_update") {
    return;
  }
  const existing = toolCalls.get(event.toolId) ?? { toolId: event.toolId };
  toolCalls.set(event.toolId, {
    ...existing,
    parentToolUseId: event.parentToolUseId ?? existing.parentToolUseId ?? null,
    title: event.title ?? existing.title,
    kind: event.kind ?? existing.kind,
    input: event.input ?? existing.input,
    output: event.content ?? existing.output,
    status: event.status,
    error: event.error ?? existing.error,
    raw: event.raw ?? existing.raw,
  });
}

export function formatBotAssistantReplyBlocks(
  blocks: readonly BotAssistantReplyBlock[],
  options?: BotReplyFormatOptions,
): string[] {
  const messages: string[] = [];
  for (const block of blocks) {
    if (block.type === "content") {
      messages.push(...splitLongReplyText(block.content.replace(/\r\n/g, "\n")));
      continue;
    }
    if (block.type === "tool-call") {
      const text = formatBotToolCallReply(block.toolCall, options);
      messages.push(...splitLongReplyText(text));
      continue;
    }
    const text = formatBotChangeSummary(block.changeSummary, {
      locale: options?.locale,
    });
    if (text) {
      messages.push(...splitLongReplyText(text));
    }
  }
  return messages;
}
