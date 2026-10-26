/**
 * 小V 语音全屏特例：Read 类工具成功后自动在右栏打开文件。
 *
 * 闸门：必须 `isXwVoiceMode()`（html[data-xw-voice=1]）。
 * 由 ConversationTurnGroup 在尾轮调用。
 */
import { getState } from "../../components/global-assistant/assistant-store.js";
import { isReadToolName } from "../../lib/chat-normalize.js";
import {
  openRightStageForCodeViewerSource,
  showRightStageFilePreview,
} from "../../lib/right-stage/open-right-stage-file.js";
import { logRightStage } from "../../lib/right-stage/panel-set-debug-log.js";
import { rightStageStore } from "../../lib/right-stage/right-stage-store.js";
import { allowXwVoiceSummary, isXwVoiceMode } from "../../lib/xw-voice-mode.js";
import { getToolCallCodePreview } from "@/lib/codeViewer.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import type { AssistantWorkRow } from "@/v4/conversationTurnRenderUnits.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";

const openedToolCallIds = new Set<string>();

function rememberOpened(toolCallId: string): void {
  openedToolCallIds.add(toolCallId);
  if (openedToolCallIds.size > 256) {
    const oldest = openedToolCallIds.values().next().value;
    if (oldest !== undefined) openedToolCallIds.delete(oldest);
  }
}

function readXiaomiSessionKey(): string {
  try {
    return String(getState()?.sessionKey || "").trim();
  } catch {
    return "";
  }
}

function extractReadPathFromInput(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    if (typeof input === "string") {
      try {
        return extractReadPathFromInput(JSON.parse(input) as unknown);
      } catch {
        return "";
      }
    }
    return "";
  }
  const rec = input as Record<string, unknown>;
  for (const key of ["file_path", "filePath", "path", "target_file", "targetFile"]) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function isFileReadRow(row: Extract<AssistantWorkRow, { kind: "toolCall" }>): boolean {
  if (isReadToolName(row.toolName)) return true;
  try {
    const node = toolCallRowToLegacyNode(row);
    return resolveToolCallIdentity(node.toolCall).family === "file-read";
  } catch {
    return false;
  }
}

function ensureVoiceRightStageExpanded(): void {
  allowXwVoiceSummary();
  try {
    if (rightStageStore.getSnapshot().collapsed) {
      rightStageStore.expand();
    }
  } catch {
    /* ignore */
  }
}

export type XiaomiVoiceReadAutoOpenOpts = {
  workspacePath?: string | null;
  /** 兜底会话 key；优先用小V store.sessionKey */
  sessionKey?: string | null;
};

/**
 * 语音全屏下：尾轮 Read 工具成功 → 右栏文件预览。
 * 每个 toolCallId 只开一次。
 */
export function applyXiaomiVoiceReadAutoOpen(
  rows: readonly AssistantWorkRow[],
  opts?: XiaomiVoiceReadAutoOpenOpts,
): void {
  if (!isXwVoiceMode()) return;
  if (!rows.length) return;

  const sessionKey = readXiaomiSessionKey() || String(opts?.sessionKey || "").trim() || undefined;
  const workspacePath = String(opts?.workspacePath || "").trim();

  for (const row of rows) {
    if (row.kind !== "toolCall") continue;
    if (row.status !== "success") continue;
    const toolCallId = String(row.toolCallId || row.rowId || "").trim();
    if (!toolCallId || openedToolCallIds.has(toolCallId)) continue;
    if (!isFileReadRow(row)) continue;

    const node = toolCallRowToLegacyNode(row);
    const pathFromInput =
      extractReadPathFromInput(node.toolCall.input) || extractReadPathFromInput(row.inputText);
    let openedKey = "";

    if (pathFromInput) {
      openedKey = showRightStageFilePreview(pathFromInput, {
        sessionKey,
        workspaceRoot: workspacePath || undefined,
        layout: "half",
      });
    } else {
      const preview = getToolCallCodePreview(node.toolCall, workspacePath);
      if (preview) {
        openedKey = openRightStageForCodeViewerSource(preview, {
          sessionKey,
          layout: "half",
        });
      }
    }

    logRightStage("V4 autoOpen:xiaomi voice read", {
      toolCallId,
      toolName: row.toolName,
      opened: Boolean(openedKey),
      path: (pathFromInput || "").slice(0, 120),
      voice: true,
    });

    if (!openedKey) continue;
    rememberOpened(toolCallId);
    ensureVoiceRightStageExpanded();
  }
}

/** 退出语音时清去重，下次进语音可再开同文件。 */
export function resetXiaomiVoiceReadAutoOpen(): void {
  openedToolCallIds.clear();
}
