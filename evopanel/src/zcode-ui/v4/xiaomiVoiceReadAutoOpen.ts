/**
 * 小V 语音全屏特例：Read 类工具成功后按策略在右栏打开文件。
 *
 * 闸门：必须 `isXwVoiceMode()`（html[data-xw-voice=1]）+ file-auto-open-policy 分类
 * （用户点名 / 产物 / 媒体才开；记忆·技艺·画像、skill、配置、源码自读一律不开，
 * 兜底不开——想主动展示走 panel_set 显式通道）。
 * 由 ConversationTurnGroup 在尾轮调用。
 */
import { getState } from "../../components/global-assistant/assistant-store.js";
import { isReadToolName } from "../../lib/chat-normalize.js";
import { classifyVoiceFileAutoOpen } from "../../lib/right-stage/file-auto-open-policy.js";
import { hostFileExists } from "../../lib/right-stage/heal-workspace-open-path.js";
import { showRightStageFromFileLink } from "../../lib/right-stage/open-right-stage-file.js";
import { logRightStage } from "../../lib/right-stage/panel-set-debug-log.js";
import { rightStageStore } from "../../lib/right-stage/right-stage-store.js";
import { allowXwVoiceSummary, isXwVoiceMode } from "../../lib/xw-voice-mode.js";
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
    // 用户点过收起则尊重；避免读文件自动开栏把收起钮打成「没反应」。
    rightStageStore.expandUnlessUserCollapsed();
  } catch {
    /* ignore */
  }
}

export type XiaomiVoiceReadAutoOpenOpts = {
  workspacePath?: string | null;
  /** 兜底会话 key；优先用小V store.sessionKey */
  sessionKey?: string | null;
  /** 本轮真实用户消息文本（origin=realUser），供策略「点名」判定；可缺省。 */
  userTexts?: readonly string[] | null;
};

/**
 * 语音全屏下：尾轮 Read 工具成功 → 过 file-auto-open-policy 闸门后右栏打开。
 * 每个 toolCallId 只评估一次（评估即标记，防存在性校验异步窗口里连开）。
 */
export async function applyXiaomiVoiceReadAutoOpen(
  rows: readonly AssistantWorkRow[],
  opts?: XiaomiVoiceReadAutoOpenOpts,
): Promise<void> {
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

    // 评估过即标记：策略拦截 / 不存在 / 打开，都不回头重评。
    rememberOpened(toolCallId);

    const decision = classifyVoiceFileAutoOpen({
      path: pathFromInput,
      userTexts: opts?.userTexts,
    });
    if (!pathFromInput || decision.action !== "open") {
      logRightStage("V4 autoOpen:xiaomi voice read → 策略不开", {
        toolCallId,
        toolName: row.toolName,
        reason: pathFromInput ? decision.reason : "no-path",
        path: pathFromInput.slice(0, 120),
      });
      continue;
    }

    // asset 路由交给资产 API 自理；file 路由先验存在，后端明确说不存在就不落死标签。
    if (decision.route !== "asset") {
      const exists = await hostFileExists(pathFromInput, {
        workspaceRoot: workspacePath || undefined,
      });
      if (!exists) {
        logRightStage("V4 autoOpen:xiaomi voice read → 路径不存在跳过", {
          toolCallId,
          toolName: row.toolName,
          path: pathFromInput.slice(0, 120),
        });
        continue;
      }
    }

    // 统一走 showRightStageFromFileLink：vault 资产自动剥成 asset 通道，
    // 媒体走 codeViewer 流式播放，普通文件带 heal 纠路径重试。
    const openedKey = showRightStageFromFileLink(
      { path: pathFromInput, workspacePath: workspacePath || undefined },
      { sessionKey, layout: "half" },
    );

    logRightStage("V4 autoOpen:xiaomi voice read", {
      toolCallId,
      toolName: row.toolName,
      opened: Boolean(openedKey),
      route: decision.route,
      reason: decision.reason,
      path: pathFromInput.slice(0, 120),
      voice: true,
    });

    if (!openedKey) continue;
    ensureVoiceRightStageExpanded();
  }
}

/** 退出语音时清去重，下次进语音可再开同文件。 */
export function resetXiaomiVoiceReadAutoOpen(): void {
  openedToolCallIds.clear();
}
