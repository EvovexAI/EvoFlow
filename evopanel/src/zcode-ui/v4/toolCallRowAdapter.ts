// v4 ToolCallRow → 旧 ToolCallBlocks 输入形态（TaskChatToolCallTreeNode）适配。
// 纯函数：ToolCallBlock 及其 renderers（execute/read/edit/...）吃的是旧 ZCode Agent 的
// TaskChatToolCall 形态；v4 row 自包含，字段一一映射即可，不需要看别的行。
import { buildZCodeStreamingToolInputPreview } from "@zcode/shared";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import { normalizeWrappedErrorText } from "@/lib/toolError.js";

// v4 status → 旧 ChatToolCall.status（mapToolStatus 的输入词表：
// pending/in_progress/completed/failed/stopped）。
// pendingApproval 视为 pending：审批中输入已定，展示为待执行。
const STATUS_MAP: Record<ToolCallRow["status"], string> = {
  inputStreaming: "pending",
  pendingApproval: "pending",
  running: "in_progress",
  success: "completed",
  error: "failed",
  cancelled: "stopped",
};

interface ResolvedToolInputPreview {
  input: unknown;
  inputPreviewComplete?: boolean;
  streamingRawInputLength?: number;
}

function isEmptyPlainRecord(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

/** input 缺席时，用 v4 inputText 还原完整或流式半截工具参数预览。 */
function resolveToolInputPreview(row: ToolCallRow): ResolvedToolInputPreview {
  if (row.input !== undefined) {
    return {
      input: row.input,
      inputPreviewComplete: true,
      ...(row.inputText.length > 0 ? { streamingRawInputLength: row.inputText.length } : {}),
    };
  }
  if (!row.inputText) {
    return { input: undefined };
  }
  const preview = buildZCodeStreamingToolInputPreview(row.inputText);
  return {
    input: isEmptyPlainRecord(preview.input) ? undefined : preview.input,
    inputPreviewComplete: preview.complete,
    streamingRawInputLength: row.inputText.length,
  };
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveV4ToolErrorText(row: ToolCallRow): string | undefined {
  if (row.status !== "error") {
    return undefined;
  }

  const directMessage = readNonEmptyString(row.error?.message);
  if (directMessage) {
    return directMessage;
  }

  const outputText = readNonEmptyString(row.output?.text);
  if (outputText) {
    return normalizeWrappedErrorText(outputText);
  }

  return readNonEmptyString(row.error?.code);
}

export function toolCallRowToLegacyNode(row: ToolCallRow): TaskChatToolCallTreeNode {
  const legacyStatus = STATUS_MAP[row.status];
  const errorText = resolveV4ToolErrorText(row);
  const inputPreview = resolveToolInputPreview(row);
  // CUA 等结构化展示事实位于 output.display；顶层 display 仅是旧 Node REPL 图片通道。
  // 优先读取 canonical output，同时保留旧快照和 Browser 轮尾截图的兼容路径。
  const display = row.output?.display ?? row.display;
  // CUA v1 历史 display 会重复保存 input；工具调用行已经持有唯一输入，桥接时丢弃旧副本。
  const legacyDisplay =
    display?.kind === "cua" ? (({ input: _legacyInput, ...rest }) => rest)(display) : display;
  return {
    toolCall: {
      toolId: row.toolCallId,
      toolName: row.toolName,
      // kind 兼容旧聚合分类：v4 下没有旧 ZCode Agent 快照形态，直接用固定工具名。
      kind: row.toolName,
      input: inputPreview.input,
      status: legacyStatus,
      output: row.output?.text,
      // V4 ToolCallRow 没有 legacy taskNotification raw；background Agent
      // 的终态摘要只落在 output。Agent renderer 读取 content 展示活动结果，因此在
      // Agent/Task 行显式桥接，避免失败详情虽已投影却仍只显示一张空卡。
      ...((row.toolName === "Agent" || row.toolName === "Task") && row.output?.text
        ? { content: row.output.text }
        : {}),
      // v4 row 是自包含投影，部分 provider 只把工具失败正文塞进 output，
      // 不补回 legacy error 会让 ToolOutput 看不到失败原因，只剩一张空的 failed 摘要。
      error: errorText,
      raw: {
        error: row.error,
        rawOutput: row.output?.text,
        outputPreview: row.outputPreview,
        outputTruncated: row.output?.truncated,
        status: legacyStatus,
        toolCallId: row.toolCallId,
        toolName: row.toolName,
        v4Status: row.status,
        ...(row.cuaApp ? { cuaApp: row.cuaApp } : {}),
        ...(legacyDisplay ? { display: legacyDisplay } : {}),
        inputPreviewComplete: inputPreview.inputPreviewComplete,
        streamingRawInputLength: inputPreview.streamingRawInputLength,
      },
      startedAt: typeof row.startedAt === "number" ? row.startedAt : undefined,
    },
    // subagent 不内嵌 child rows；v4 工具行没有子树，嵌套工具在旧形态里也
    // 由独立 row（subagent/toolCall）表达。
    childToolCalls: [],
  };
}
